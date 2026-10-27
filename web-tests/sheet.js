// Integration: the data sheet page (jsdom) against a running Worker.
// Start one first: npx wrangler dev --port 8832 --inspector-port 9000
// Run: API_BASE=http://127.0.0.1:8832 [API_KEY=...] node sheet.js
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const require = createRequire(import.meta.url);
const fs = require('fs');
const assert = require('assert/strict');
const { JSDOM } = require('jsdom');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dir = path.resolve(__dirname, '..', 'web');
const API = process.env.API_BASE || 'http://127.0.0.1:8832';
const KEY = process.env.API_KEY || '';

function openPage({ apiBase = API, apiKey = KEY, offline = false, badKey = false } = {}) {
  const dom = new JSDOM(fs.readFileSync(`${dir}/sheet.html`, 'utf8'), {
    url: 'http://localhost/sheet.html', runScripts: 'outside-only', pretendToBeVisual: true,
  });
  const w = dom.window;
  const errors = [];
  w.addEventListener('error', (e) => errors.push(e.message));
  if (apiBase) w.localStorage.setItem('cs.apiBase', apiBase);
  if (badKey) w.localStorage.setItem('cs.apiKey', 'definitely-wrong');
  else if (apiKey) w.localStorage.setItem('cs.apiKey', apiKey);
  if (offline) w.fetch = () => Promise.reject(new TypeError('offline'));
  else w.fetch = (url, opts = {}) => fetch(url, { ...opts, signal: undefined });
  w.eval(fs.readFileSync(`${dir}/sheet.js`, 'utf8'));
  return { dom, w, d: w.document, errors };
}

const waitFor = async (fn, ms = 20000) => {
  const t0 = Date.now();
  for (;;) {
    try { if (fn()) return; } catch (e) { /* keep waiting */ }
    if (Date.now() - t0 > ms) throw new Error('timed out waiting for the page');
    await new Promise((r) => setTimeout(r, 40));
  }
};
const $ = (page, id) => page.d.getElementById(id);
const rows = (page) => [...$(page, 'sheetBody').querySelectorAll('tr[data-id]')];
const set = (el, v) => { el.value = String(v); el.dispatchEvent(new el.ownerDocument.defaultView.Event('input')); };
const btnByText = (root, text) => [...root.querySelectorAll('button')].find((b) => b.textContent.trim() === text);

const apiFetch = (p, opts = {}) => fetch(`${API}${p}`, {
  ...opts,
  headers: { 'content-type': 'application/json', ...(KEY ? { 'x-api-key': KEY } : {}), ...(opts.headers || {}) },
});

const checks = [];
const check = (name, fn) => checks.push({ name, fn });
let usbId = null;
let originalUsb = null;

(async () => {
  const page = openPage();
  await waitFor(() => /Connected/.test($(page, 'connState').textContent));
  await waitFor(() => rows(page).length > 0);

  check('loads every item, numbered like the sheet', () => {
    assert.ok(rows(page).length >= 99, `only ${rows(page).length} rows`);
    const first = rows(page)[0];
    assert.equal(first.querySelector('.sn').textContent, '1');
    assert.match(first.querySelector('.particulars').textContent, /Mobile Cover #48/);
    assert.equal(first.querySelector('.qty-pdf').textContent, '305'); // PDF qty
    assert.match($(page, 'sheetCount').textContent, /rows\. Press Edit/);
  });

  check('shows the stored figures next to the PDF ones', async () => {
    const usbRow = rows(page).find((tr) => /Usb Cable #37/.test(tr.textContent));
    assert.ok(usbRow, 'Usb Cable row missing');
    usbId = Number(usbRow.dataset.id);
    originalUsb = await (await apiFetch(`/api/items/${usbId}`)).json();
    assert.match(usbRow.textContent, /Usb Cable/);
    // Live stock, not the seeded 87: earlier suites sell some of it.
    assert.match(usbRow.textContent, new RegExp(`${originalUsb.stock} pcs`));
    assert.match(usbRow.textContent, /37\.00/); // buy
    assert.match(usbRow.textContent, /40\.00/); // sell
  });

  check('search narrows the table', () => {
    set($(page, 'sheetSearch'), 'usb cable');
    const shown = rows(page).filter((tr) => !tr.hidden);
    assert.equal(shown.length, 1);
    assert.match($(page, 'sheetCount').textContent, /1 of \d+ rows match/);
    set($(page, 'sheetSearch'), '');
    assert.equal(rows(page).filter((tr) => !tr.hidden).length, rows(page).length);
  });

  check('edit opens the row form with the stored values', () => {
    const usbRow = rows(page).find((tr) => Number(tr.dataset.id) === usbId);
    btnByText(usbRow, 'Edit').click();
    const form = page.d.querySelector('tr.editor form');
    assert.ok(form, 'editor did not open');
    assert.equal(form.elements.name.value, 'Usb Cable');
    assert.equal(form.elements.unit.value, 'pcs');
    assert.equal(form.elements.sell_rate.value, '40');
    assert.equal(form.elements.stock.value, String(originalUsb.stock));
    assert.match(page.d.querySelector('.edit-note').textContent, /Usb Cable #37 · quantity 87 pcs/);
  });

  check('a wrong value is refused without a request', async () => {
    const form = page.d.querySelector('tr.editor form');
    form.elements.sell_rate.value = '0';
    form.dispatchEvent(new page.w.Event('submit'));
    await waitFor(() => /greater than 0/.test(form.querySelector('.msg').textContent));
    assert.equal(form.elements.sell_rate.value, '0'); // still open, still the user's value
    form.elements.sell_rate.value = '40';
  });

  check('saving a correction persists it in the backend', async () => {
    const form = page.d.querySelector('tr.editor form');
    form.elements.sell_rate.value = '41';
    form.elements.name.value = 'Usb Cable ';
    form.dispatchEvent(new page.w.Event('submit'));
    await waitFor(() => !page.d.querySelector('tr.editor'), 15000);
    const saved = await (await apiFetch(`/api/items/${usbId}`)).json();
    assert.equal(saved.sell_rate, 41);
    assert.equal(saved.name, 'Usb Cable'); // trimmed
    const usbRow = rows(page).find((tr) => Number(tr.dataset.id) === usbId);
    assert.match(usbRow.textContent, /41\.00/);
  });

  check('putting the value back restores the backend', async () => {
    const usbRow = rows(page).find((tr) => Number(tr.dataset.id) === usbId);
    btnByText(usbRow, 'Edit').click();
    const form = page.d.querySelector('tr.editor form');
    form.elements.sell_rate.value = '40';
    form.dispatchEvent(new page.w.Event('submit'));
    await waitFor(() => !page.d.querySelector('tr.editor'), 15000);
    const saved = await (await apiFetch(`/api/items/${usbId}`)).json();
    assert.equal(saved.sell_rate, 40);
    originalUsb = saved;
  });

  check('a quantity correction moves stock and says so', async () => {
    const usbRow = rows(page).find((tr) => Number(tr.dataset.id) === usbId);
    btnByText(usbRow, 'Edit').click();
    const form = page.d.querySelector('tr.editor form');
    form.elements.stock.value = String(originalUsb.stock - 2);
    form.dispatchEvent(new page.w.Event('submit'));
    await waitFor(() => !page.d.querySelector('tr.editor'), 15000);
    const saved = await (await apiFetch(`/api/items/${usbId}`)).json();
    assert.equal(saved.stock, originalUsb.stock - 2);
    const usbRow2 = rows(page).find((tr) => Number(tr.dataset.id) === usbId);
    // The row marks how far it has moved from the PDF quantity.
    const diff = saved.stock - saved.source_qty;
    const label = `${diff > 0 ? '+' : '−'}${Math.abs(diff).toLocaleString('en-US', { maximumFractionDigits: 3 })}`;
    assert.ok(usbRow2.textContent.includes(label), `expected ${label} in "${usbRow2.textContent}"`);
    // put it back
    btnByText(usbRow2, 'Edit').click();
    const form2 = page.d.querySelector('tr.editor form');
    form2.elements.stock.value = String(originalUsb.stock);
    form2.dispatchEvent(new page.w.Event('submit'));
    await waitFor(() => !page.d.querySelector('tr.editor'), 15000);
    const back = await (await apiFetch(`/api/items/${usbId}`)).json();
    assert.equal(back.stock, originalUsb.stock);
  });

  check('no uncaught errors on the loaded page', () => assert.deepEqual(page.errors, []));

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

  // Separate pages: a rejected key (only meaningful on a locked backend) and no network at all.
  let extra = 0;
  if (KEY) {
    extra += 1;
    const locked = openPage({ badKey: true });
    try {
      await waitFor(() => /Locked/.test($(locked, 'connState').textContent));
      console.log('ok   a rejected key reports the lock');
    } catch (e) {
      failed += 1;
      console.log('FAIL a rejected key reports the lock');
    }
  } else {
    console.log('skip a rejected key reports the lock (backend is not locked)');
  }

  extra += 1;
  const offline = openPage({ offline: true });
  try {
    await waitFor(() => /Offline/.test($(offline, 'connState').textContent));
    console.log('ok   no network reports offline');
  } catch (e) {
    failed += 1;
    console.log('FAIL no network reports offline');
  }

  const total = checks.length + extra;
  console.log(`\n${total - failed} passed, ${failed} failed`);
  process.exitCode = failed ? 1 : 0;
})();
