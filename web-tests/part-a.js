// Full Part A regression for the counter calculator (offline path).
// Run: node part-a.js
//
// Two expected values in the original sheet are corrected here because they
// cannot be produced by 2dp rates without printing a billing line that does not
// multiply out:
//   A8  gross 3,000 / 642: 4.135 x 642 = 2,654.67, base 2,654.87 -> -0.20 (not -0.17)
//   A10 gross 405 / 5 pcs: 5 x 55.68 = 278.40, + 80.00 = 358.40, base 358.41 -> -0.01 (not 0.00)
// The sheet's own "expected quirks" section accepts this paisa variance.
const fs = require('fs');
const assert = require('assert/strict');
const { JSDOM } = require('jsdom');
const path = require('path');

const dir = path.resolve(__dirname, '..', 'web');
const dom = new JSDOM(fs.readFileSync(`${dir}/index.html`, 'utf8'), {
  url: 'http://localhost:8080/',
  runScripts: 'outside-only',
  pretendToBeVisual: true,
});
const w = dom.window;
const d = w.document;
const errors = [];
w.addEventListener('error', (e) => errors.push(e.message));
w.fetch = () => Promise.reject(new TypeError('offline test'));
for (const f of ['solver.js', 'calc.js', 'bill.js']) {
  w.eval(fs.readFileSync(`${dir}/${f}`, 'utf8'));
}

const $ = (id) => d.getElementById(id);
const set = (id, v) => {
  const el = typeof id === 'string' ? $(id) : id;
  el.value = String(v);
  el.dispatchEvent(new w.Event('input'));
};
const clickText = (root, text) => {
  const b = [...root.querySelectorAll('button')].find((x) => x.textContent.trim() === text);
  assert.ok(b, `button not found: ${text}`);
  b.click();
  return b;
};
const reset = () => clickText(d, 'Reset all');
const tick = () => new Promise((r) => setTimeout(r, 40));
const checks = [];
const check = (name, fn) => checks.push({ name, fn });
const near = (actual, expected, eps = 0.0001) => {
  assert.ok(Math.abs(Number(actual) - expected) <= eps, `${actual} != ${expected}`);
};
const verify = (text) => assert.ok($('verifyEq').textContent.includes(text),
  `verifyEq was "${$('verifyEq').textContent}"`);

(async () => {
  await tick(); // let bill.js settle into offline mode

  check('starts offline', () => {
    assert.match($('connState').textContent, /Offline/);
    assert.equal($('itemBox').hidden, true);
    assert.equal($('alertsCard').hidden, true);
    assert.equal($('saveBtn').disabled, true);
  });

  check('sanity envelope: all six pairs exact', () => {
    reset();
    const pairs = [
      [7500, '6,637.17', '862.83'],
      [1130, '1,000.00', '130.00'],
      [2260, '2,000.00', '260.00'],
      [565, '500.00', '65.00'],
      [678, '600.00', '78.00'],
      [452, '400.00', '52.00'],
    ];
    for (const [gross, base, vat] of pairs) {
      set('gross', gross);
      set('vat', 13);
      assert.equal($('baseOut').textContent, base);
      assert.equal($('vatOut').textContent, vat);
    }
  });

  check('A1: PRD benchmark and formula', () => {
    set('gross', 7500);
    set('vat', 13);
    assert.equal($('baseOut').textContent, '6,637.17');
    assert.equal($('vatOut').textContent, '862.83');
    assert.match($('formula').textContent, /7,500\.00 ÷ 1\.13 = 6,637\.17/);
  });

  check('A2: PCS at list, exact zero variance', () => {
    reset();
    set('gross', '644.10');
    set('vat', 13);
    set('stdRate', 57);
    set('qty', 10);
    assert.equal($('baseOut').textContent, '570.00');
    near($('rate').value, 57);
    assert.equal($('verifyEq').textContent,
      'Lines NPR 570.00 · base NPR 570.00 · difference NPR 0.00');
    assert.equal($('billingLine').value,
      'Item — 10 pcs × NPR 57.00 = NPR 570.00\nTotal NPR 644.10');
    assert.equal($('addLine').disabled, false);
  });

  check('A3: PCS discount is absorbed by the rate, count stays 10', () => {
    set('gross', '630.00');
    assert.equal($('baseOut').textContent, '557.52');
    near($('rate').value, 55.75);
    assert.equal($('qty').value, '10');
    verify('difference NPR -0.02');

    set('gross', '620.00');
    assert.equal($('baseOut').textContent, '548.67');
    near($('rate').value, 54.87);
    assert.equal($('qty').value, '10');
    verify('difference NPR 0.03');

    set('gross', '600.00');
    assert.equal($('baseOut').textContent, '530.97');
    near($('rate').value, 53.10);
    assert.equal($('qty').value, '10');
    verify('difference NPR 0.03');
  });

  check('A4: 100-piece sensitivity', () => {
    reset();
    set('gross', '6441.00');
    set('stdRate', 57);
    set('qty', 100);
    const rows = [
      ['6441.00', '5,700.00', 57.00, 'difference NPR 0.00'],
      ['6400.00', '5,663.72', 56.64, 'difference NPR 0.28'],
      ['6300.00', '5,575.22', 55.75, 'difference NPR -0.22'],
      ['6250.00', '5,530.97', 55.31, 'difference NPR 0.03'],
    ];
    for (const [gross, base, rate, diff] of rows) {
      set('gross', gross);
      assert.equal($('baseOut').textContent, base);
      near($('rate').value, rate);
      assert.equal($('qty').value, '100');
      verify(diff);
    }
  });

  check('A5: fractional PCS and Dozen are rejected with the right message', () => {
    reset();
    set('gross', 1000);
    set('stdRate', 57);
    set('qty', 1.5);
    assert.equal($('rate').value, '');
    assert.equal($('addLine').disabled, true);
    assert.match($('verifyStatus').textContent, /^Pcs must be whole numbers/);
    assert.match($('qtyHint').textContent, /^Pcs must be whole numbers/);

    clickText(d, 'Dozen');
    set('gross', 1000);
    set('stdRate', 60);
    set('qty', 22.3);
    assert.equal($('rate').value, '');
    assert.equal($('addLine').disabled, true);
    assert.match($('verifyStatus').textContent, /^Dozen must be whole or half/);
    assert.match($('qtyHint').textContent, /^Dozen must be whole or half/);

    set('qty', 22.5);
    assert.ok(Number($('rate').value) > 0);
    assert.equal($('addLine').disabled, false);

    clickText(d, 'Kg');
    clickText($('kgBox'), 'Quantity fixed, rate adjusts');
    set('gross', '1129.86');
    set('stdRate', 642);
    set('qty', 0.333);
    assert.equal($('qty').readOnly, false);
    assert.equal($('rate').readOnly, true);
    assert.ok(Number($('rate').value) > 0);
    assert.equal($('addLine').disabled, false);
  });

  check('A6: Dozen half-steps and quick presets', () => {
    reset();
    clickText(d, 'Dozen');
    set('gross', '1525.50');
    set('stdRate', 60);
    set('qty', 22.5);
    assert.equal($('baseOut').textContent, '1,350.00');
    near($('rate').value, 60);
    verify('difference NPR 0.00');

    clickText($('stepper'), '+½');
    assert.equal($('qty').value, '23');
    clickText($('stepper'), '−½');
    assert.equal($('qty').value, '22.5');
    clickText($('stepper'), '−1');
    assert.equal($('qty').value, '21.5');
    clickText($('quick'), '2 doz');
    assert.equal($('qty').value, '2');
  });

  check('A7: Dozen discount absorbed by the rate', () => {
    set('gross', '1500.00');
    set('stdRate', 60);
    set('qty', 22.5);
    assert.equal($('baseOut').textContent, '1,327.43');
    near($('rate').value, 59);
    assert.equal($('qty').value, '22.5');
    verify('difference NPR 0.07');
  });

  check('A8: Kg rate fixed, quantity adjusts and is read-only', () => {
    reset();
    clickText(d, 'Kg');
    set('gross', '3627.30');
    set('stdRate', 642);
    assert.equal($('qty').value, '5');
    near($('rate').value, 642);
    assert.equal($('qty').readOnly, true);
    assert.equal($('rate').readOnly, true);
    verify('difference NPR 0.00');

    set('gross', '3000');
    assert.equal($('baseOut').textContent, '2,654.87');
    assert.equal($('qty').value, '4.135');
    near($('rate').value, 642);
    // Corrected from the sheet: 4.135 x 642 = 2,654.67 vs base 2,654.87.
    verify('Lines NPR 2,654.67 · base NPR 2,654.87 · difference NPR -0.20');
  });

  check('A9: Kg quantity fixed, rate adjusts and is read-only', () => {
    clickText($('kgBox'), 'Quantity fixed, rate adjusts');
    set('gross', '3627.30');
    set('qty', 5);
    assert.equal($('qty').readOnly, false);
    assert.equal($('rate').readOnly, true);
    near($('rate').value, 642);
    verify('difference NPR 0.00');

    set('gross', '3500.00');
    near($('rate').value, 619.47);
    verify('difference NPR 0.00');

    set('gross', '3000.00');
    near($('rate').value, 530.97);
    assert.equal($('qty').value, '5');
    verify('difference NPR -0.02');
  });

  check('A10: multi-line and Balance here', () => {
    reset();
    set('gross', 405);
    set('stdRate', 57);
    set('qty', 5);
    assert.equal($('baseOut').textContent, '358.41');
    near($('rate').value, 71.68);
    // Corrected from the sheet: 5 x 71.68 = 358.40, already one paisa under.
    verify('Lines NPR 358.40 · base NPR 358.41 · difference NPR -0.01');
    clickText(d, 'Add line to bill');

    set('stdRate', 40);
    set('qty', 2);
    near($('rate').value, 40);
    verify('Lines NPR 438.40 · base NPR 358.41 · difference NPR 79.99');
    clickText(d, 'Add line to bill');
    assert.equal(d.querySelectorAll('#draft .draft-row').length, 2);
    verify('Lines NPR 438.40 · base NPR 358.41 · difference NPR 79.99');

    clickText(d.querySelectorAll('#draft .draft-row')[0], 'Balance here');
    const row1 = d.querySelectorAll('#draft .draft-row')[0];
    assert.match(row1.textContent, /55\.68/);
    assert.match(row1.textContent, /278\.40/);
    assert.match(d.querySelectorAll('#draft .draft-row')[1].textContent, /40\.00/);
    verify('Lines NPR 358.40 · base NPR 358.41 · difference NPR -0.01');

    set('gross', '400.00');
    clickText(d.querySelectorAll('#draft .draft-row')[0], 'Balance here');
    const row1b = d.querySelectorAll('#draft .draft-row')[0];
    assert.match(row1b.textContent, /54\.80/);
    verify('Lines NPR 354.00 · base NPR 353.98 · difference NPR 0.02');
  });

  check('A11: VAT 0 is valid and does not divide by zero', () => {
    reset();
    set('gross', 1000);
    set('vat', 0);
    set('stdRate', 50);
    set('qty', 20);
    assert.equal($('baseOut').textContent, '1,000.00');
    assert.equal($('vatOut').textContent, '0.00');
    near($('rate').value, 50);
    verify('difference NPR 0.00');
  });

  check('A12: Reset all returns the listed fields to defaults', () => {
    reset();
    set('gross', 405);
    set('stdRate', 57);
    set('qty', 5);
    clickText(d, 'Add line to bill');
    clickText(d, 'Reset all');
    assert.equal($('gross').value, '');
    assert.equal($('vat').value, '13');
    assert.equal($('stdRate').value, '');
    assert.equal($('qty').value, '');
    assert.equal($('rate').value, '');
    assert.equal($('baseOut').textContent, '—');
    assert.equal($('billingLine').value, '');
    assert.equal($('draft').hidden, true);
    assert.equal(d.querySelector('[data-unit="pcs"]').getAttribute('aria-checked'), 'true');
    assert.equal($('toast').textContent, 'Cleared. Ready for the next bill.');
  });

  check('discount walkthrough: 10 covers for 600', () => {
    reset();
    set('gross', 600);
    set('vat', 13);
    set('stdRate', 57);
    set('qty', 10);
    assert.equal($('baseOut').textContent, '530.97');
    near($('rate').value, 53.10);
    verify('Lines NPR 531.00 · base NPR 530.97 · difference NPR 0.03');
    assert.equal($('billingLine').value,
      'Item — 10 pcs × NPR 53.10 = NPR 531.00\nTotal NPR 600.00');
  });

  check('extra: PCS stepper and typed-rate override', () => {
    reset();
    set('gross', '644.10');
    set('stdRate', 57);
    set('qty', 10);
    clickText($('stepper'), '+10');
    assert.equal($('qty').value, '20');
    near($('rate').value, 28.50);
    clickText($('stepper'), '+1');
    assert.equal($('qty').value, '21');
    clickText($('stepper'), '−1');
    assert.equal($('qty').value, '20');

    set('qty', 10);
    set('rate', 60);
    assert.equal($('qty').value, '10');
    assert.equal($('autoRate').hidden, false);
    verify('Lines NPR 600.00 · base NPR 570.00 · difference NPR 30.00');
    clickText(d, 'Let rate follow count again');
    near($('rate').value, 57);
    assert.equal($('autoRate').hidden, true);
  });

  check('no uncaught page errors', () => {
    assert.deepEqual(errors, []);
  });

  let failed = 0;
  for (const c of checks) {
    try {
      c.fn();
      console.log(`ok   ${c.name}`);
    } catch (e) {
      failed += 1;
      console.log(`FAIL ${c.name}\n     ${e.message.split('\n').slice(0, 5).join('\n     ')}`);
    }
  }
  console.log(`\n${checks.length - failed} passed, ${failed} failed`);
  process.exitCode = failed ? 1 : 0;
})();
