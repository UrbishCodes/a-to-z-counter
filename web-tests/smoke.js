// DOM smoke test of the real page (offline path). Run: node /home/claude/web-tests/smoke.js
const fs = require('fs');
const assert = require('assert/strict');
const { JSDOM } = require('jsdom');

const path = require('path');
const dir = path.resolve(__dirname, '..', 'web');
const html = fs.readFileSync(`${dir}/index.html`, 'utf8');
const dom = new JSDOM(html, { url: `file://${dir}/index.html`, runScripts: 'outside-only', pretendToBeVisual: true });
const w = dom.window;
const d = w.document;
const errors = [];
w.addEventListener('error', (e) => errors.push(e.message));

for (const f of ['session.js', 'solver.js', 'calc.js', 'bill.js']) {
  w.eval(fs.readFileSync(`${dir}/${f}`, 'utf8'));
}

const $ = (id) => d.getElementById(id);
const set = (el, v) => { el.value = String(v); el.dispatchEvent(new w.Event('input')); };
const btnByText = (root, text) => [...root.querySelectorAll('button')].find((b) => b.textContent.trim() === text);
const tick = () => new Promise((r) => setTimeout(r, 30));
const checks = [];
const check = (name, fn) => checks.push({ name, fn });

(async () => {
  await tick(); // let bill.js connect() settle (offline in jsdom: no fetch)

  check('starts offline, calculator only', () => {
    assert.match($('connState').textContent, /Offline/);
    assert.equal($('itemBox').hidden, true);
    assert.equal($('baseOut').textContent, '—');
  });

  check('reverse VAT benchmark on screen', () => {
    set($('gross'), 7500);
    assert.equal($('baseOut').textContent, '6,637.17');
    assert.equal($('vatOut').textContent, '862.83');
    assert.equal($('vat').value, '13');
  });

  check('pcs: count held, rate absorbs (168 pcs at standard 39.59)', () => {
    set($('stdRate'), 39.59);
    set($('qty'), 168);
    assert.equal($('rate').value, '39.51');
    assert.equal($('verifyEq').textContent, 'Lines NPR 6,637.68 · base NPR 6,637.17 · difference NPR 0.00'.replace('0.00', '0.51'));
    assert.equal($('billingLine').value, 'Item — 168 pcs × NPR 39.51 = NPR 6,637.68\nTotal NPR 7,500.00');
  });

  check('pcs: candidate counts shown and whole', () => {
    assert.equal($('candidates').hidden, false);
    const cands = [...$('candidates').querySelectorAll('.cand strong')].map((s) => s.textContent);
    assert.equal(cands.length, 4);
    assert.ok(cands.every((t) => /^\d+ pcs$/.test(t)), cands.join(','));
  });

  check('pcs: typed rate holds the count, Auto puts it back', () => {
    set($('rate'), 40);
    assert.equal($('qty').value, '168');
    assert.equal($('autoRate').hidden, false);
    assert.match($('verifyEq').textContent, /Lines NPR 6,720\.00/); // verify shows the bill's line sum
    assert.equal($('billingLine').value.includes('168 pcs × NPR 40.00 = NPR 6,720.00'), true);
    btnByText($('autoRate').parentElement, 'Let rate follow count again').click();
    assert.equal($('rate').value, '39.51');
    assert.equal($('autoRate').hidden, true);
  });

  check('pcs: whole counts only, invalid count gives no rate', () => {
    set($('qty'), 1.5);
    assert.equal($('rate').value, '');
    assert.equal($('addLine').disabled, true);
    set($('qty'), 168);
  });

  check('add line to bill: draft shows, form clears', () => {
    btnByText(d, 'Add line to bill').click();
    assert.equal($('draft').hidden, false);
    assert.equal($('draft').querySelectorAll('.draft-row').length, 1);
    assert.equal($('qty').value, '');
    assert.match($('verifyEq').textContent, /^Lines NPR 6,637\.68 · base NPR 6,637\.17 · difference NPR 0\.51$/);
  });

  check('kg: rate fixed by default, quantity absorbs (6.637 at 1000)', () => {
    btnByText(d, 'Reset all').click(); // start a clean bill: lines already on it change the rules
    set($('gross'), 7500);
    d.querySelector('[data-unit="kg"]').click();
    set($('stdRate'), 1000);
    assert.equal($('qty').value, '6.637');
    assert.equal($('qty').readOnly, true);
    assert.equal($('rate').value, '1000');
    assert.equal($('rate').readOnly, true);
  });

  check('kg: rate-adjusts option holds the typed quantity', () => {
    btnByText($('kgBox'), 'Quantity fixed, rate adjusts').click();
    assert.equal($('qty').readOnly, false);
    assert.equal($('rate').readOnly, true);
    set($('qty'), 5);
    assert.equal($('rate').value, '1327.43');
    assert.equal($('stdRate').value, '1000'); // standard untouched
  });

  check('dozen: stepper +1/-1/half, quick buttons', () => {
    btnByText(d, 'Dozen').click();
    assert.equal($('quick').hidden, false);
    assert.equal($('stepper').hidden, false);
    btnByText($('stepper'), '+½').click();
    assert.equal($('qty').value, '0.5');
    btnByText($('stepper'), '+1').click();
    assert.equal($('qty').value, '1.5');
    btnByText($('stepper'), '−½').click();
    assert.equal($('qty').value, '1');
    btnByText($('quick'), '2 doz').click();
    assert.equal($('qty').value, '2');
    assert.equal($('rate').value, '3318.59'); // 6637.17 / 2, rate per dozen
  });

  check('pcs unit change clears the count', () => {
    btnByText(d, 'Pcs').click();
    assert.equal($('qty').value, '');
    assert.equal($('stepper').hidden, false);
    assert.equal($('quick').hidden, true);
  });

  check('reset clears the bill, lines and standard rate, shows confirmation', () => {
    btnByText(d, 'Reset all').click();
    assert.equal($('gross').value, '');
    assert.equal($('vat').value, '13');
    assert.equal($('stdRate').value, '');
    assert.equal($('draft').hidden, true);
    assert.equal($('baseOut').textContent, '—');
    assert.equal($('toast').textContent, 'Cleared. Ready for the next bill.');
  });

  check('no uncaught errors', () => {
    assert.deepEqual(errors, []);
  });

  let failed = 0;
  for (const c of checks) {
    try {
      c.fn();
      console.log(`ok   ${c.name}`);
    } catch (e) {
      failed += 1;
      console.log(`FAIL ${c.name}\n     ${e.message.split('\n').slice(0, 4).join('\n     ')}`);
    }
  }
  console.log(`\n${checks.length - failed} passed, ${failed} failed`);
  process.exitCode = failed ? 1 : 0;
})();
