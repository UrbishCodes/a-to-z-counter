/*
 * Counter front end: bill total, unit, item, count, rate and the bill's lines.
 * Works fully offline. Saving and item search are in bill.js.
 */
(function () {
  'use strict';

  const S = window.Solver;
  const $ = (id) => document.getElementById(id);

  const els = {
    gross: $('gross'), vat: $('vat'), baseOut: $('baseOut'), vatOut: $('vatOut'), formula: $('formula'),
    unitBtns: document.querySelectorAll('[data-unit]'),
    absorbBtns: document.querySelectorAll('[data-absorb]'),
    kgBox: $('kgBox'), itemBox: $('itemBox'), itemSearch: $('itemSearch'), itemResults: $('itemResults'),
    itemChosen: $('itemChosen'), chosenText: $('chosenText'), clearItem: $('clearItem'),
    stdLabel: $('stdLabel'), stdRate: $('stdRate'), bandHint: $('bandHint'),
    stepper: $('stepper'), quick: $('quick'), qtyLabel: $('qtyLabel'), qty: $('qty'), qtyHint: $('qtyHint'),
    candidates: $('candidates'), rateLabel: $('rateLabel'), rate: $('rate'), autoRate: $('autoRate'),
    addLine: $('addLine'), draft: $('draft'),
    verify: $('verify'), verifyEq: $('verifyEq'), verifyStatus: $('verifyStatus'),
    billingLine: $('billingLine'), copyBtn: $('copyBtn'), resetBtn: $('resetBtn'), toast: $('toast'),
  };

  const st = {
    unit: 'pcs',
    absorb: 'qty',          // kg only: 'qty' = rate fixed, quantity adjusts; 'rate' = quantity fixed, rate adjusts
    item: null,             // chosen backend item: {id, name, unit, sell_rate, buy_rate, stock}
    rateManual: false,      // pcs/doz: a typed rate holds the count; "Auto" lets the count drive the rate
    online: false,
    busy: false,
    rules: { vat_pct: S.DEFAULTS.vat, band_low_pct: S.DEFAULTS.low, band_high_pct: S.DEFAULTS.high },
    line: null,             // the line currently in the form, when it is complete
    lines: [],              // lines already added to this bill
    countError: '',         // why the typed count cannot be sold in this unit
    searchTimer: null,
  };

  const LABELS = {
    pcs: { std: 'Standard rate (NPR per pc)', rate: 'Rate (NPR per pc)', qty: 'Count sold (whole pieces)' },
    doz: { std: 'Standard rate (NPR per dozen)', rate: 'Rate (NPR per dozen)', qty: 'Count sold (dozens, halves ok)' },
    kg: { std: 'Standard rate (NPR per kg)', rate: 'Rate (NPR per kg)', qty: 'Quantity (kg)' },
  };
  const STEPS = {
    pcs: [[-1, '−1'], [1, '+1'], [10, '+10']],
    doz: [[-1, '−1'], [-0.5, '−½'], [0.5, '+½'], [1, '+1']],
  };
  const QUICK = [[0.5, '½ doz'], [1, '1 doz'], [1.5, '1½ doz'], [2, '2 doz']];

  // ---------- helpers ----------

  const num = (el) => {
    const t = el.value.trim();
    return t === '' ? NaN : Number(t);
  };
  const fmt2 = (n) => n.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const fmtQty = (q, unit) => `${unit === 'kg' ? +q.toFixed(4) : q} ${unit}`;

  function button(label, cls, onClick) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = cls;
    b.textContent = label;
    b.addEventListener('click', onClick);
    return b;
  }

  function toast(text) {
    els.toast.textContent = text;
    els.toast.classList.add('show');
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => els.toast.classList.remove('show'), 2200);
  }

  function baseNow() {
    const g = num(els.gross);
    const v = num(els.vat);
    if (!(g > 0) || !(v >= 0)) return null;
    return { gross: g, vatPct: v, ...S.taxableBase(g, v) };
  }

  function billLines() {
    return st.lines.concat(st.line ? [st.line] : []);
  }

  function billingText(l) {
    return `${l.label} — ${fmtQty(l.qty, l.sale_unit)} × NPR ${fmt2(l.unit_rate)} = NPR ${fmt2(l.total)}`;
  }

  // Band check for one line, against its item's buy rate. Null when no item is chosen.
  function bandOf(line) {
    const it = line.item;
    if (!it) return null;
    const u = line.sale_unit;
    if (!(it.buy_rate > 0)) {
      return { status: 'UNKNOWN_COST', cls: 'warn', text: 'No buy rate on this item: margin not checked.' };
    }
    const band = S.bandStatus(S.convertRate(line.unit_rate, u, it.unit), it.buy_rate,
      st.rules.band_low_pct, st.rules.band_high_pct);
    const toSale = (r) => fmt2(S.r2(S.convertRate(r, it.unit, u)));
    if (band.status === 'LOSS') {
      return { status: 'LOSS', cls: 'bad', pct: band.pct,
        text: `LOSS: margin ${band.pct}%. Rate must be at least NPR ${toSale(band.lowRate)} per ${u}.` };
    }
    if (band.status === 'OVER_TAX') {
      return { status: 'OVER_TAX', cls: 'warn', pct: band.pct,
        text: `Over-tax: margin ${band.pct}%. Keep the rate at or below NPR ${toSale(band.highRate)} per ${u}.` };
    }
    return { status: 'OK', cls: 'ok', pct: band.pct, text: `Margin ${band.pct}%, inside the band.` };
  }

  // ---------- step 1: bill total ----------

  function renderBase(b) {
    els.baseOut.textContent = b ? fmt2(b.base) : '—';
    els.vatOut.textContent = b ? fmt2(b.vat) : '—';
    els.formula.textContent = b
      ? `${fmt2(b.gross)} ÷ ${String(+(1 + b.vatPct / 100).toFixed(6))} = ${fmt2(b.base)}  (VAT ${fmt2(b.vat)})`
      : '';
  }

  // ---------- step 2: unit, item, standard rate ----------

  function setUnit(u) {
    st.unit = u;
    st.rateManual = false;
    els.unitBtns.forEach((b) => {
      const on = b.dataset.unit === u;
      b.classList.toggle('active', on);
      b.setAttribute('aria-checked', String(on));
    });
    els.kgBox.hidden = u !== 'kg';
    els.qtyLabel.textContent = LABELS[u].qty;
    els.rateLabel.textContent = LABELS[u].rate;
    els.stdLabel.textContent = LABELS[u].std;
    els.qty.value = '';
    if (st.item && !S.compatible(u, st.item.unit)) {
      clearItemSelection();
      toast('Item removed: it cannot be sold in this unit');
    } else if (st.item) {
      setStdFromItem();
    }
    renderStepper();
    recalc();
  }

  function setAbsorb(a) {
    st.absorb = a;
    els.absorbBtns.forEach((b) => {
      const on = b.dataset.absorb === a;
      b.classList.toggle('active', on);
      b.setAttribute('aria-checked', String(on));
    });
    recalc();
  }

  function setStdFromItem() {
    if (!st.item) return;
    els.stdRate.value = S.r2(S.convertRate(st.item.sell_rate, st.item.unit, st.unit));
  }

  function chooseItem(it) {
    st.item = it;
    els.itemSearch.value = '';
    els.itemResults.innerHTML = '';
    els.itemResults.hidden = true;
    els.chosenText.textContent = `${it.name} · stock ${it.stock} ${it.unit}`;
    els.itemChosen.hidden = false;
    setStdFromItem();
    renderBandHint();
    recalc();
  }

  function clearItemSelection() {
    st.item = null;
    els.itemChosen.hidden = true;
    renderBandHint();
    recalc();
  }

  function renderBandHint() {
    if (!st.item) {
      els.bandHint.textContent = st.online
        ? 'No item chosen: margin is not checked.'
        : 'Calculator only: margin is checked when connected to the backend.';
      return;
    }
    const it = st.item;
    if (!(it.buy_rate > 0)) {
      els.bandHint.textContent = 'No buy rate on this item: margin not checked.';
      return;
    }
    const u = st.unit;
    const lo = S.r2(S.convertRate(it.buy_rate * (1 + st.rules.band_low_pct / 100), it.unit, u));
    const hi = S.r2(S.convertRate(it.buy_rate * (1 + st.rules.band_high_pct / 100), it.unit, u));
    els.bandHint.textContent =
      `Allowed sell NPR ${fmt2(lo)} to ${fmt2(hi)} per ${u} (${st.rules.band_low_pct}% to ${st.rules.band_high_pct}% margin).`;
  }

  // ---------- step 3: count and rate ----------

  function renderStepper() {
    const u = st.unit;
    els.stepper.innerHTML = '';
    els.quick.innerHTML = '';
    els.stepper.hidden = u === 'kg';
    els.quick.hidden = u !== 'doz';
    if (u === 'kg') return;
    STEPS[u].forEach(([d, label]) => els.stepper.append(button(label, 'step-btn', () => bump(d))));
    if (u === 'doz') {
      QUICK.forEach(([q, label]) => els.quick.append(button(label, 'step-btn', () => setCount(q))));
    }
  }

  function bump(d) {
    const cur = num(els.qty) || 0;
    const next = st.unit === 'doz' ? Math.round((cur + d) * 2) / 2 : Math.round(cur + d);
    setCount(next > 0 ? next : '');
  }

  function setCount(q) {
    els.qty.value = q === '' ? '' : String(q);
    st.rateManual = false;
    recalc();
  }

  function applyEditable() {
    const kg = st.unit === 'kg';
    els.qty.readOnly = kg && st.absorb === 'qty';
    els.rate.readOnly = kg;
    els.qty.classList.toggle('computed', els.qty.readOnly);
    els.rate.classList.toggle('computed', els.rate.readOnly);
    els.autoRate.hidden = kg || !st.rateManual;
  }

  function qtyHintText() {
    if (st.unit === 'pcs') return 'Whole pieces only. The rate follows the count.';
    if (st.unit === 'doz') return 'Whole or half dozens. The rate follows the count.';
    return st.absorb === 'qty'
      ? 'Rate is fixed. The quantity is worked out from the total.'
      : 'Quantity is fixed. The rate is worked out from the total.';
  }

  function renderCandidates(b, std) {
    const u = st.unit;
    const list = b && u !== 'kg' && std > 0 ? S.candidateCounts(b.base, u, std, 4) : [];
    els.candidates.innerHTML = '';
    els.candidates.hidden = list.length === 0;
    els.qtyHint.textContent = list.length
      ? 'Closest counts to the standard rate. Tap one, or type a count.'
      : qtyHintText();
    list.forEach((c) => {
      const b2 = document.createElement('button');
      b2.type = 'button';
      b2.className = 'cand';
      const strong = document.createElement('strong');
      strong.textContent = fmtQty(c.qty, u);
      const sp = document.createElement('span');
      sp.textContent = `rate ${fmt2(c.rate)} · ${c.gapPct.toFixed(2)}% from standard`;
      b2.append(strong, sp);
      b2.addEventListener('click', () => setCount(c.qty));
      els.candidates.append(b2);
    });
  }

  // The one place that works out the current line from the form.
  function recalc() {
    const b = baseNow();
    renderBase(b);
    applyEditable();
    const X = b ? b.base : 0;
    const std = num(els.stdRate);
    const hasDraft = st.lines.length > 0;
    // Money still to be covered by this line: the bill base less the lines already added.
    const remaining = X ? (S.paisa(X) - st.lines.reduce((s, l) => s + S.paisa(l.total), 0)) / 100 : 0;
    let qty;
    let rate;

    if (st.unit === 'kg' && st.absorb === 'qty') {
      rate = std;
      qty = remaining > 0 && rate > 0 ? S.qtyForRate(remaining, rate) : NaN;
      els.qty.value = Number.isFinite(qty) ? String(qty) : '';
      els.rate.value = rate > 0 ? String(rate) : '';
    } else {
      qty = num(els.qty);
      if (st.unit === 'kg') {
        rate = remaining > 0 && qty > 0 ? S.rateForCount(remaining, qty) : NaN;
        els.rate.value = Number.isFinite(rate) ? String(rate) : '';
      } else if (st.rateManual) {
        rate = num(els.rate);
      } else if (hasDraft) {
        // Later lines sell at the standard rate. "Balance here" on a row takes the difference.
        rate = std;
        els.rate.value = std > 0 ? String(std) : '';
      } else {
        rate = X && S.validCount(st.unit, qty) ? S.rateForCount(X, qty) : NaN;
        els.rate.value = Number.isFinite(rate) ? String(rate) : '';
      }
    }

    const qtyOk = st.unit === 'kg' ? qty > 0 : S.validCount(st.unit, qty);
    st.countError = '';
    if (b && st.unit !== 'kg' && Number.isFinite(qty) && qty > 0 && !qtyOk) {
      st.countError = st.unit === 'pcs'
        ? 'Pcs must be whole numbers. Enter the actual count.'
        : 'Dozen must be whole or half. Enter the actual count.';
    }
    const ready = Boolean(b) && qtyOk && rate > 0;
    st.line = ready ? makeLine(qty, rate) : null;

    renderCandidates(hasDraft ? null : b, std);
    if (st.countError) els.qtyHint.textContent = st.countError;
    renderVerify(b);
    renderDraft();
    els.billingLine.value = billLines().map(billingText).join('\n')
      + (b && billLines().length ? `\nTotal NPR ${fmt2(b.gross)}` : '');
    els.addLine.disabled = !st.line;
    document.dispatchEvent(new Event('counter:change'));
  }

  function makeLine(qty, rate) {
    const typed = st.item ? st.item.name : els.itemSearch.value.trim();
    return {
      label: typed || 'Item',
      description: typed,
      item: st.item,
      item_id: st.item ? st.item.id : null,
      sale_unit: st.unit,
      qty,
      unit_rate: rate,
      total: S.r2(qty * rate),
    };
  }

  // ---------- step 4: check ----------

  function renderVerify(b) {
    const box = els.verify;
    box.className = 'verify';
    if (!b) {
      els.verifyEq.textContent = '—';
      els.verifyStatus.textContent = 'Step 1: enter the total paid and the VAT %.';
      return;
    }
    const lines = billLines();
    if (!lines.length) {
      els.verifyEq.textContent = `Taxable base NPR ${fmt2(b.base)}`;
      if (st.countError) {
        els.verifyStatus.textContent = st.countError;
        box.classList.add('bad');
      } else {
        els.verifyStatus.textContent = 'Enter the count and rate, then tap "Add line to bill".';
      }
      return;
    }
    const sumP = lines.reduce((s, l) => s + S.paisa(l.total), 0);
    const diffP = sumP - S.paisa(b.base);
    els.verifyEq.textContent =
      `Lines NPR ${fmt2(sumP / 100)} · base NPR ${fmt2(b.base)} · difference NPR ${fmt2(diffP / 100)}`;
    if (st.countError) {
      els.verifyStatus.textContent = st.countError;
      box.classList.add('bad');
      return;
    }

    const msgs = [];
    let level = 0;
    const raise = (cls) => {
      const rank = { ok: 0, warn: 1, bad: 2 }[cls];
      if (rank > level) level = rank;
    };
    const names = ['ok', 'warn', 'bad'];

    if (st.line) {
      const band = bandOf(st.line);
      msgs.push(`This line: ${fmtQty(st.line.qty, st.unit)} × NPR ${fmt2(st.line.unit_rate)} = NPR ${fmt2(st.line.total)}.`);
      if (band) {
        msgs.push(band.text);
        raise(band.cls);
      } else {
        msgs.push('No item chosen: margin not checked.');
      }
    }
    if (diffP === 0) {
      msgs.push('Bill lines match the taxable base to the paisa.');
    } else {
      msgs.push(`Lines are NPR ${fmt2(Math.abs(diffP) / 100)} ${diffP > 0 ? 'over' : 'under'} the taxable base.`);
      raise('warn');
    }
    box.classList.add(names[level]);
    els.verifyStatus.textContent = msgs.join(' ');
  }

  // ---------- the bill's lines ----------

  function renderDraft() {
    els.draft.innerHTML = '';
    els.draft.hidden = st.lines.length === 0;
    if (!st.lines.length) return;
    const head = document.createElement('p');
    head.className = 'draft-head';
    head.textContent = 'Lines on this bill';
    els.draft.append(head);
    st.lines.forEach((l, i) => {
      const row = document.createElement('div');
      row.className = 'draft-row';
      const txt = document.createElement('span');
      txt.textContent = billingText(l);
      row.append(txt, button('Balance here', 'ghost-dark', () => balanceRow(i)),
        button('Remove', 'ghost-dark', () => {
          st.lines.splice(i, 1);
          recalc();
        }));
      els.draft.append(row);
    });
  }

  // Make this row take whatever the bill still needs, so the lines add up to the base.
  function balanceRow(i) {
    const b = baseNow();
    if (!b) {
      toast('Enter the bill total first');
      return;
    }
    const row = st.lines[i];
    const othersP = st.lines.reduce((s, l, k) => (k === i ? s : s + S.paisa(l.total)), 0);
    const rate = S.r2((S.paisa(b.base) - othersP) / 100 / row.qty);
    if (!(rate > 0)) {
      toast('The other lines already exceed the bill');
      return;
    }
    row.unit_rate = rate;
    row.total = S.r2(row.qty * rate);
    recalc();
    toast('Line balanced to the bill');
  }

  function clearLineFields() {
    els.qty.value = '';
    els.rate.value = '';
    if (st.item) els.stdRate.value = ''; // a typed standard rate survives lines without an item
    st.rateManual = false;
    st.item = null;
    els.itemChosen.hidden = true;
    els.itemSearch.value = '';
    els.itemResults.innerHTML = '';
    els.itemResults.hidden = true;
    renderBandHint();
  }

  function addLine() {
    if (!st.line) {
      toast('Complete the count and rate first');
      return;
    }
    st.lines.push(st.line);
    clearLineFields();
    recalc();
    toast('Line added to the bill');
  }

  // Clears the bill (total and lines). Unit and VAT stay; staff name stays.
  function clearBill() {
    st.lines = [];
    els.gross.value = '';
    els.vat.value = String(st.rules.vat_pct);
    clearLineFields();
    recalc();
  }

  function resetAll() {
    clearBill();
    els.stdRate.value = '';
    setUnit('pcs');
    setAbsorb('qty');
    document.dispatchEvent(new Event('counter:reset'));
    toast('Cleared. Ready for the next bill.');
  }

  async function copyText() {
    const text = els.billingLine.value;
    if (!text) {
      toast('Nothing to copy yet');
      return;
    }
    try {
      await navigator.clipboard.writeText(text);
      toast('Copied');
    } catch (e) {
      els.billingLine.focus();
      els.billingLine.select();
      els.billingLine.setSelectionRange(0, 99999);
      const ok = document.execCommand && document.execCommand('copy');
      toast(ok ? 'Copied' : 'Select the text and copy it');
    }
  }

  // ---------- wiring ----------

  function init() {
    els.vat.value = String(st.rules.vat_pct);
    els.unitBtns.forEach((b) => b.addEventListener('click', () => setUnit(b.dataset.unit)));
    els.absorbBtns.forEach((b) => b.addEventListener('click', () => setAbsorb(b.dataset.absorb)));

    els.gross.addEventListener('input', recalc);
    els.vat.addEventListener('input', () => {
      els.vat.dataset.touched = '1';
      recalc();
    });
    els.stdRate.addEventListener('input', recalc);
    els.qty.addEventListener('input', () => {
      st.rateManual = false;
      recalc();
    });
    els.rate.addEventListener('input', () => {
      if (st.unit === 'kg') return;
      st.rateManual = true;
      recalc();
    });
    els.autoRate.addEventListener('click', () => {
      st.rateManual = false;
      recalc();
    });
    els.itemSearch.addEventListener('input', () => {
      recalc();
      clearTimeout(st.searchTimer);
      st.searchTimer = setTimeout(() => window.Counter.searchItems && window.Counter.searchItems(), 220);
    });
    els.clearItem.addEventListener('click', clearItemSelection);
    els.addLine.addEventListener('click', addLine);
    els.copyBtn.addEventListener('click', copyText);
    els.resetBtn.addEventListener('click', resetAll);

    setUnit('pcs');
    setAbsorb('qty');
  }

  window.Counter = {
    st, els, $, S, toast, fmt2, fmtQty, num,
    baseNow, billLines, bandOf, chooseItem, recalc, clearBill,
    renderBandHint, setStdFromItem, clearItemSelection,
  };

  init();
})();
