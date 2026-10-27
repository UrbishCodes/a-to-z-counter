// Integration: the real page (jsdom) against the Cloudflare Workers backend.
// Start the worker first: npx wrangler dev --port 8787 (after migrations apply --local).
// Run: API_BASE=http://127.0.0.1:8787 node online-worker.mjs
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const require = createRequire(import.meta.url);
const fs = require('fs');
const assert = require('assert/strict');
const { JSDOM } = require('jsdom');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dir = path.resolve(__dirname, '..', 'web');
const API = process.env.API_BASE || 'http://127.0.0.1:8787';
const dom = new JSDOM(fs.readFileSync(`${dir}/index.html`, 'utf8'), {
  url: 'http://localhost/', runScripts: 'outside-only', pretendToBeVisual: true,
});
const w = dom.window;
const d = w.document;
const errors = [];
w.addEventListener('error', (e) => errors.push(e.message));
w.confirm = () => true; // accept the over-tax save prompt
w.localStorage.setItem('cs.apiBase', API); // point the page at the worker
w.fetch = (url, opts = {}) => fetch(url, { ...opts, signal: undefined });

for (const f of ['solver.js', 'calc.js', 'bill.js']) {
  w.eval(fs.readFileSync(`${dir}/${f}`, 'utf8'));
}

const $ = (id) => d.getElementById(id);
const set = (el, v) => { el.value = String(v); el.dispatchEvent(new w.Event('input')); };
const btnByText = (root, text) => [...root.querySelectorAll('button')].find((b) => b.textContent.trim() === text);
// The worker may be a remote deployment, so waits are generous: every step
// crosses the network and the page loads its alerts after it reports "Connected".
const waitFor = async (fn, ms = 20000) => {
  const t0 = Date.now();
  for (;;) {
    try { if (fn()) return; } catch (e) { /* keep waiting */ }
    if (Date.now() - t0 > ms) throw new Error('timed out waiting for the page');
    await new Promise((r) => setTimeout(r, 40));
  }
};
const checks = [];
const check = (name, fn) => checks.push({ name, fn });
let usbBefore = null;
const usbStock = async () => {
  const rows = await (await fetch(`${API}/api/items?q=usb%20cable&limit=5`)).json();
  return rows.find((r) => r.name === 'Usb Cable' && r.buy_rate === 37).stock;
};

(async () => {
  await waitFor(() => /Connected/.test($('connState').textContent));
  await waitFor(() => $('alertsCard').hidden === false && $('alertsList').children.length > 0);

  check('connects to the worker and shows alerts', () => {
    assert.equal($('itemBox').hidden, false);
    assert.equal($('alertsCard').hidden, false);
    assert.match($('alertsList').textContent, /Covers total [\d,]+ pcs is below the baseline of 95,000/);
  });

  check('item search returns real items', async () => {
    set($('itemSearch'), 'usb cable');
    await waitFor(() => $('itemResults').querySelectorAll('button').length > 0);
    const usb = [...$('itemResults').querySelectorAll('button')]
      .find((b) => b.querySelector('strong').textContent === 'Usb Cable' && /max NPR 40\.00/.test(b.textContent));
    assert.ok(usb, 'Usb Cable (buy 37, max 40) not in results');
    usbBefore = await usbStock();
    usb.click();
    assert.equal($('stdRate').value, '40');
    assert.equal($('itemChosen').hidden, false);
  });

  check('a chosen item shows its band and margin on the line', () => {
    assert.match($('bandHint').textContent, /Allowed sell NPR 38\.85 to 39\.59/);
    set($('gross'), 45.2); // base 40.00
    set($('qty'), 1);
    assert.equal($('rate').value, '40');
    assert.match($('verifyStatus').textContent, /Over-tax: margin 8\.11%/);
  });

  check('add the item line, then an unknown free-text line', () => {
    btnByText(d, 'Add line to bill').click();
    set($('itemSearch'), 'mystery gadget');
    set($('stdRate'), 123);
    set($('qty'), 1);
    assert.equal($('rate').value, '123');
    btnByText(d, 'Add line to bill').click();
    assert.equal($('draft').querySelectorAll('.draft-row').length, 2);
  });

  check('save bill: stored, free-text line goes to review', async () => {
    assert.equal($('saveBtn').disabled, false);
    $('saveBtn').click();
    await waitFor(() => /Saved BL-/.test($('saveMsg').textContent));
    assert.match($('saveMsg').textContent, /Some lines are not matched yet/);
    assert.equal($('gross').value, ''); // form cleared after save
    assert.equal($('draft').hidden, true);
    const open = d.querySelectorAll('#confirmBox .review:not(.done)');
    assert.equal(open.length, 1);
    assert.equal(d.querySelectorAll('#confirmBox .review.done').length, 1);
  });

  check('review: tap a suggested item, bill completes', async () => {
    const open = d.querySelector('#confirmBox .review:not(.done)');
    const choice = open.querySelector('.cands-list button');
    assert.ok(choice, 'no suggestions offered');
    choice.click();
    await waitFor(() => /complete/.test($('saveMsg').textContent));
    assert.equal(d.querySelectorAll('#confirmBox .review:not(.done)').length, 0);
  });

  check('stock was deducted by the matched sale (one pc less)', async () => {
    assert.equal(await usbStock(), usbBefore - 1);
  });

  check('bill is in the backend list with its status', async () => {
    const rows = await (await fetch(`${API}/api/bills?limit=5`)).json();
    assert.ok(rows.length >= 1);
    assert.equal(rows[0].status, 'complete');
    assert.match(rows[0].bill_no, /^BL-\d{6}$/);
  });

  check('reset clears the review and the save message', () => {
    btnByText(d, 'Reset all').click();
    assert.equal($('confirmBox').innerHTML, '');
    assert.equal($('saveMsg').textContent, '');
  });

  check('no uncaught errors', () => assert.deepEqual(errors, []));

  let failed = 0;
  for (const c of checks) {
    try {
      await c.fn();
      console.log(`ok   ${c.name}`);
    } catch (e) {
      failed += 1;
      console.log(`FAIL ${c.name}\n     ${e.message.split('\n').slice(0, 4).join('\n     ')}`);
    }
  }
  console.log(`\n${checks.length - failed} passed, ${failed} failed`);
  process.exitCode = failed ? 1 : 0;
})();
