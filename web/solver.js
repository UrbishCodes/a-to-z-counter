/*
 * Pure rules used by calc.js and bill.js. No DOM. Works in browsers and jsdom.
 * Loaded first (before calc.js) in index.html.
 */
(function () {
  'use strict';

  function r2(n) { return Math.round(n * 100) / 100; }
  function r3(n) { return Math.round(n * 1000) / 1000; }
  function r4(n) { return Math.round(n * 10000) / 10000; }
  function paisa(n) { return Math.round(n * 100); }

  function taxableBase(gross, vatPct) {
    const base = r2(gross / (1 + vatPct / 100));
    const vat = r2(gross - base);
    return { base, vat };
  }

  // pcs <-> doz at 12 per dozen. Kg stays isolated.
  function convertRate(rate, from, to) {
    if (!Number.isFinite(rate)) return rate;
    if (from === to) return rate;
    if (from === 'pcs' && to === 'doz') return rate * 12;
    if (from === 'doz' && to === 'pcs') return rate / 12;
    return NaN;
  }

  function compatible(a, b) {
    if (a === b) return true;
    const counts = ['pcs', 'doz'];
    return counts.indexOf(a) !== -1 && counts.indexOf(b) !== -1;
  }

  function validCount(unit, qty) {
    if (!Number.isFinite(qty) || qty <= 0) return false;
    if (unit === 'pcs') return Number.isInteger(qty);
    if (unit === 'doz') return Number.isInteger(qty * 2);
    return true;
  }

  // rate = X / count, 2 dp. Count is fixed by the caller; never rounded here.
  function rateForCount(base, count) {
    if (!(base > 0) || !(count > 0)) return NaN;
    return r2(base / count);
  }

  // Kg only. 3 dp, upgraded to 4 dp when 3 dp leaves a paisa variance.
  function qtyForRate(base, rate) {
    if (!(base > 0) || !(rate > 0)) return NaN;
    const raw = base / rate;
    const q3 = r3(raw);
    if (paisa(q3 * rate) === paisa(base)) return q3;
    const q4 = r4(raw);
    if (paisa(q4 * rate) === paisa(base)) return q4;
    return q3;
  }

  // Margin band against the buy rate. loPct/hiPct default to 5/7 if omitted.
  function bandStatus(rate, buyRate, loPct, hiPct) {
    loPct = (loPct == null) ? 5 : loPct;
    hiPct = (hiPct == null) ? 7 : hiPct;
    if (!(buyRate > 0)) return { status: 'UNKNOWN_COST' };
    const lowRate  = buyRate * (1 + loPct / 100);
    const highRate = buyRate * (1 + hiPct / 100);
    const pct = r2((rate - buyRate) / buyRate * 100);
    let status;
    if (pct < loPct) status = 'LOSS';
    else if (pct > hiPct) status = 'OVER_TAX';
    else status = 'OK';
    return { status, pct, lowRate, highRate };
  }

  // Up to n whole counts (pcs) or half counts (doz) closest to base / std.
  // Returns [] for kg. Each item: { qty, rate, gapPct }.
  function candidateCounts(base, unit, std, n) {
    n = n || 4;
    if (!(base > 0) || !(std > 0) || unit === 'kg') return [];
    const raw = base / std;
    if (!(raw > 0)) return [];
    const step = unit === 'doz' ? 0.5 : 1;
    const center = unit === 'doz' ? Math.floor(raw * 2) / 2 : Math.floor(raw);
    const pool = [];
    for (let k = center - (n + 1) * step; k <= center + (n + 1) * step; k += step) {
      const q = unit === 'doz' ? Math.round(k * 2) / 2 : Math.round(k);
      if (q > 0) pool.push(q);
    }
    const seen = {};
    const uniq = [];
    pool.forEach((q) => {
      const key = String(q);
      if (!seen[key]) { seen[key] = 1; uniq.push(q); }
    });
    uniq.sort((a, b) => Math.abs(a - raw) - Math.abs(b - raw));
    return uniq.slice(0, n).map((q) => ({
      qty: q,
      rate: r2(base / q),
      gapPct: ((base / q) - std) / std * 100,
    }));
  }

  window.Solver = {
    DEFAULTS: { vat: 13, low: 5, high: 7 },
    r2: r2, r3: r3, r4: r4, paisa: paisa,
    taxableBase: taxableBase,
    convertRate: convertRate,
    compatible: compatible,
    validCount: validCount,
    rateForCount: rateForCount,
    qtyForRate: qtyForRate,
    bandStatus: bandStatus,
    candidateCounts: candidateCounts,
  };
})();