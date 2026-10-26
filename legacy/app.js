/* Sales & Reverse-VAT Tool: vanilla JS (ES6+), zero dependencies

   Rules:
   - Pcs and Dozen: quantity is the real count sold. Never rounded.
     Rate = X / qty, so the rate absorbs the difference.
   - Kg: rate stays at standard. Quantity (decimal) absorbs the difference.
*/
(() => {
  'use strict';

  /* ---------- Config ---------- */
  const UNITS = {
    pcs: {
      short: 'Pcs',
      stdLabel: 'Standard rate (NPR / pc)',
      qtyLabel: 'Quantity (Pcs, whole)',
      stdRate: 27,
    },
    kg: {
      short: 'Kg',
      stdLabel: 'Standard rate (NPR / Kg)',
      qtyLabel: 'Quantity (Kg)',
      stdRate: 150,
    },
    doz: {
      short: 'Doz',
      stdLabel: 'Standard rate (NPR / dozen)',
      qtyLabel: 'Quantity (Dozen, whole or half)',
      stdRate: 300,
    },
  };

  const DEFAULTS = { gross: 7500, vat: 13, unit: 'pcs' };

  /* ---------- DOM ---------- */
  const $ = (id) => document.getElementById(id);

  const dom = {
    gross: $('gross'),
    vat: $('vat'),
    std: $('stdRate'),
    stdLabel: $('stdLabel'),
    qty: $('qty'),
    qtyLabel: $('qtyLabel'),
    qtyHint: $('qtyHint'),
    candidates: $('candidates'),
    rate: $('rate'),
    base: $('baseOut'),
    vatAmt: $('vatOut'),
    formula: $('formula'),
    verify: $('verify'),
    verifyEq: $('verifyEq'),
    verifyStatus: $('verifyStatus'),
    billing: $('billingLine'),
    copy: $('copyBtn'),
    copyMsg: $('copyMsg'),
    reset: $('resetBtn'),
    unitBtns: document.querySelectorAll('[data-unit]'),
  };

  /* ---------- State ---------- */
  const state = {
    unit: DEFAULTS.unit,
    // 'qty'  : quantity is the driver (Pcs/Dozen: typed count; Kg: typed weight)
    // 'rate' : rate is the driver (Pcs/Dozen: typed rate, qty held; Kg: typed rate, qty solved)
    // 'auto' : Kg only, solve from standard rate
    anchor: 'qty',
    rates: {},
  };
  Object.keys(UNITS).forEach((k) => { state.rates[k] = UNITS[k].stdRate; });

  let copyTimer = null;

  /* ---------- Helpers ---------- */
  const round = (n, dp) => {
    const f = 10 ** dp;
    return Math.round((n + Number.EPSILON) * f) / f;
  };

  // Compare money in paisa (integers) to avoid floating-point drift
  const toPaisa = (n) => Math.round(n * 100);

  const readNum = (input) => {
    const v = parseFloat(input.value);
    return Number.isFinite(v) ? v : NaN;
  };

  const setField = (input, value) => {
    input.value = Number.isFinite(value) ? String(value) : '';
  };

  const money = (n) =>
    n.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  const signedMoney = (paisa) =>
    `${paisa > 0 ? '+' : '−'}${money(Math.abs(paisa) / 100)}`;

  // Pcs: whole numbers. Dozen: whole or half. Kg: any positive decimal.
  const isValidCount = (unit, q) => {
    if (!Number.isFinite(q) || q <= 0) return false;
    if (unit === 'pcs') return Number.isInteger(q);
    if (unit === 'doz') return Number.isInteger(q * 2);
    return true;
  };

  // The two whole counts (or half-dozen counts) either side of X / standard rate
  function candidateCounts(base, unit, std) {
    const raw = base / std;
    const lo = unit === 'pcs'
      ? Math.floor(raw)
      : Math.floor(raw * 2) / 2;
    const hi = unit === 'pcs' ? lo + 1 : lo + 0.5;
    return [lo, hi].filter((q) => q > 0);
  }

  // Kg quantity that makes Qty x Rate equal X: 3 dp, or 4 dp when 3 dp leaves a paisa variance
  function solveKgQty(base, rate) {
    const raw = base / rate;
    const q3 = round(raw, 3);
    if (toPaisa(q3 * rate) === toPaisa(base)) return q3;
    const q4 = round(raw, 4);
    return toPaisa(q4 * rate) === toPaisa(base) ? q4 : q3;
  }

  /* ---------- Rendering ---------- */
  function clearOutputs(message) {
    dom.verifyEq.textContent = '—';
    dom.verifyStatus.textContent = message;
    dom.verify.className = 'verify';
    dom.billing.value = '';
  }

  function renderVerify(base, qty, rate) {
    const short = UNITS[state.unit].short;
    const qtyText = String(qty);
    const subPaisa = toPaisa(qty * rate);
    const deltaPaisa = subPaisa - toPaisa(base);
    const subtotal = subPaisa / 100;

    dom.verifyEq.textContent = `${qtyText} ${short} × ${money(rate)} = ${money(subtotal)}`;

    if (deltaPaisa === 0) {
      dom.verify.className = 'verify ok';
      dom.verifyStatus.textContent = '✓ Zero variance: subtotal matches taxable base';
    } else {
      dom.verify.className = 'verify warn';
      dom.verifyStatus.textContent =
        `⚠ Variance ${signedMoney(deltaPaisa)} vs taxable base`;
    }

    // Plain text, no thousands separator, so it pastes cleanly into invoicing software
    dom.billing.value = `${qtyText} ${short} x ${rate.toFixed(2)} = ${subtotal.toFixed(2)}`;
  }

  // Choice buttons for Pcs/Dozen when no valid count is entered. Never auto-filled.
  function renderCandidates(base, show) {
    const unit = state.unit;
    const isKg = unit === 'kg';

    dom.qtyHint.hidden = isKg;
    dom.candidates.hidden = isKg || !show;
    dom.candidates.textContent = '';
    if (isKg) return;

    const std = state.rates[unit];
    const short = UNITS[unit].short;

    dom.qtyHint.textContent =
      `At list NPR ${std}: ${money(round(base / std, 2))} ${short}. ` +
      'Nothing is rounded. Enter the actual count sold.';

    if (!show) return;

    candidateCounts(base, unit, std).forEach((q) => {
      const rate = round(base / q, 2);
      const delta = toPaisa(q * rate) - toPaisa(base);

      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'cand';

      const top = document.createElement('strong');
      top.textContent = `${q} ${short}`;

      const sub = document.createElement('span');
      sub.textContent = `rate ${money(rate)} · ${delta === 0 ? '✓ zero' : `Δ ${signedMoney(delta)}`}`;

      btn.append(top, sub);
      btn.addEventListener('click', () => {
        setField(dom.qty, q);
        state.anchor = 'qty';
        recalc();
      });
      dom.candidates.appendChild(btn);
    });
  }

  /* ---------- Solvers ---------- */

  // Pcs and Dozen: count is never changed by the app
  function solveCount(base) {
    const unit = state.unit;
    const qty = readNum(dom.qty);
    const ok = isValidCount(unit, qty);

    renderCandidates(base, !ok);

    if (!ok) {
      if (state.anchor !== 'rate') setField(dom.rate, NaN);

      if (Number.isFinite(qty)) {
        clearOutputs(unit === 'pcs'
          ? 'Pcs must be whole numbers. Enter the actual count.'
          : 'Dozen must be whole or half. Enter the actual count.');
      } else {
        clearOutputs('Enter the actual count sold, or tap a count above.');
      }
      return;
    }

    let rate;
    if (state.anchor === 'rate') {
      // Typed rate holds. Quantity stays. Variance shows any difference.
      rate = readNum(dom.rate);
      if (!(rate > 0)) {
        clearOutputs('Enter a unit rate above 0.');
        return;
      }
    } else {
      // Rate absorbs the difference: rate = X / qty
      rate = round(base / qty, 2);
      setField(dom.rate, rate);
    }

    renderVerify(base, qty, rate);
  }

  // Kg: rate stays at standard, quantity absorbs the difference
  function solveKg(base) {
    const std = state.rates.kg;
    let qty;
    let rate;

    renderCandidates(base, false); // hides count choices and hint for Kg

    if (state.anchor === 'qty') {
      qty = readNum(dom.qty);
      if (!(qty > 0)) {
        setField(dom.rate, NaN);
        clearOutputs('Enter kg weight above 0.');
        return;
      }
      rate = round(base / qty, 2);
      setField(dom.rate, rate);
    } else {
      rate = state.anchor === 'rate' ? readNum(dom.rate) : std;
      if (!(rate > 0)) {
        setField(dom.qty, NaN);
        clearOutputs('Enter a rate above 0.');
        return;
      }
      qty = solveKgQty(base, rate);
      setField(dom.qty, qty);
      if (state.anchor === 'auto') setField(dom.rate, rate);
    }

    if (!(qty > 0)) {
      clearOutputs('Rate too high for this base.');
      return;
    }

    renderVerify(base, qty, rate);
  }

  /* ---------- Core recalculation ---------- */
  function recalc() {
    const gross = readNum(dom.gross);
    const vat = readNum(dom.vat);

    if (!(gross > 0) || !(vat >= 0)) {
      dom.base.textContent = '—';
      dom.vatAmt.textContent = '—';
      dom.formula.textContent = '';
      dom.candidates.hidden = true;
      dom.qtyHint.hidden = true;
      clearOutputs('Enter a gross total above 0 and a valid VAT %.');
      return;
    }

    const base = round(gross / (1 + vat / 100), 2);   // X = G / (1 + V%)
    const vatAmt = round(gross - base, 2);             // VAT = G - X

    dom.base.textContent = money(base);
    dom.vatAmt.textContent = money(vatAmt);
    dom.formula.textContent =
      `X = ${money(gross)} ÷ ${Number((1 + vat / 100).toFixed(4))} = ${money(base)}`;

    if (state.unit === 'kg') {
      solveKg(base);
    } else {
      solveCount(base);
    }
  }

  /* ---------- Unit and reset ---------- */
  function setUnit(unit) {
    state.unit = unit;
    state.anchor = unit === 'kg' ? 'auto' : 'qty';

    dom.unitBtns.forEach((b) => {
      const on = b.dataset.unit === unit;
      b.classList.toggle('active', on);
      b.setAttribute('aria-checked', String(on));
    });

    dom.stdLabel.textContent = UNITS[unit].stdLabel;
    dom.qtyLabel.textContent = UNITS[unit].qtyLabel;
    setField(dom.std, state.rates[unit]);

    // Switching unit drops the old count and rate; they are re-derived for the new unit
    setField(dom.qty, NaN);
    setField(dom.rate, NaN);

    recalc();
  }

  function onReset() {
    dom.gross.value = DEFAULTS.gross;
    dom.vat.value = DEFAULTS.vat;
    Object.keys(UNITS).forEach((k) => { state.rates[k] = UNITS[k].stdRate; });
    setUnit(DEFAULTS.unit);
  }

  /* ---------- Clipboard ---------- */
  async function copyText(text) {
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(text);
        return true;
      }
    } catch (_) {
      // Fall through to the legacy path below
    }

    // Fallback for older browsers and non-secure contexts
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.top = '0';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    ta.setSelectionRange(0, text.length);

    let ok = false;
    try {
      ok = document.execCommand('copy');
    } catch (_) {
      ok = false;
    }
    ta.remove();
    return ok;
  }

  async function onCopy() {
    const text = dom.billing.value;
    if (!text) {
      dom.copyMsg.textContent = 'Nothing to copy yet.';
      return;
    }

    const ok = await copyText(text);
    dom.copyMsg.textContent = ok
      ? 'Copied ✓ Paste into your invoicing software.'
      : 'Copy blocked. Select the billing line and copy manually.';

    clearTimeout(copyTimer);
    copyTimer = setTimeout(() => { dom.copyMsg.textContent = ''; }, 2500);
  }

  /* ---------- Events ---------- */
  dom.gross.addEventListener('input', recalc);
  dom.vat.addEventListener('input', recalc);

  dom.std.addEventListener('input', () => {
    const v = readNum(dom.std);
    if (v > 0) state.rates[state.unit] = v;
    if (state.unit === 'kg') state.anchor = 'auto';
    recalc();
  });

  dom.qty.addEventListener('input', () => {
    state.anchor = 'qty';
    recalc();
  });

  dom.rate.addEventListener('input', () => {
    state.anchor = 'rate';
    recalc();
  });

  dom.unitBtns.forEach((b) => {
    b.addEventListener('click', () => setUnit(b.dataset.unit));
  });

  dom.copy.addEventListener('click', onCopy);
  dom.reset.addEventListener('click', onReset);

  /* ---------- Init ---------- */
  dom.gross.value = DEFAULTS.gross;
  dom.vat.value = DEFAULTS.vat;
  setUnit(DEFAULTS.unit);
})();
