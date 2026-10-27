// Pure business rules for the counter (Workers/D1 port of backend/app/engine.py).
// No I/O here. Money is compared in paisa so float drift cannot create a fake variance.
// These rules mirror web/solver.js so the UI and the API agree to the paisa.

export const DEFAULT_SETTINGS = {
  vat_pct: 13,
  band_low_pct: 5,
  band_high_pct: 7,
  cover_baseline: 95000,
  restock_qty: 5000,
};

// ---------------------------------------------------------------- money helpers

export function r2(value) {
  return Math.round(Number(value) * 100) / 100;
}

export function r3(value) {
  return Math.round(Number(value) * 1000) / 1000;
}

export function r4(value) {
  return Math.round(Number(value) * 10000) / 10000;
}

export function paisa(value) {
  return Math.round(Number(value) * 100);
}

export function taxableBase(gross, vatPct) {
  const g = Number(gross);
  const v = Number(vatPct);
  const base = r2(g / (1 + v / 100));
  const vat = r2(g - base);
  return { base, vat };
}

// ---------------------------------------------------------------- unit rules

export function validUnit(unit) {
  return unit === 'pcs' || unit === 'doz' || unit === 'kg';
}

// Rate conversion: pcs <-> dozen at 12. Kg is isolated. null when incompatible.
export function convertRate(rate, fromUnit, toUnit) {
  if (rate === null || rate === undefined) return null;
  const value = Number(rate);
  if (!Number.isFinite(value)) return null;
  if (fromUnit === toUnit) return value;
  if (fromUnit === 'pcs' && toUnit === 'doz') return value * 12;
  if (fromUnit === 'doz' && toUnit === 'pcs') return value / 12;
  return null;
}

// Quantity conversion is the inverse of rate conversion.
export function convertQty(qty, fromUnit, toUnit) {
  if (qty === null || qty === undefined) return null;
  const value = Number(qty);
  if (!Number.isFinite(value)) return null;
  if (fromUnit === toUnit) return value;
  if (fromUnit === 'pcs' && toUnit === 'doz') return value / 12;
  if (fromUnit === 'doz' && toUnit === 'pcs') return value * 12;
  return null;
}

export function compatible(a, b) {
  if (a === b) return true;
  return (a === 'pcs' || a === 'doz') && (b === 'pcs' || b === 'doz');
}

export function validCount(unit, qty) {
  const value = Number(qty);
  if (!Number.isFinite(value) || value <= 0) return false;
  if (unit === 'pcs') return Number.isInteger(value);
  if (unit === 'doz') return Math.abs(value * 2 - Math.round(value * 2)) < 1e-9;
  return unit === 'kg';
}

export function rateForCount(base, count) {
  const b = Number(base);
  const c = Number(count);
  if (!(b > 0) || !(c > 0)) return null;
  return r2(b / c);
}

// Kg only: 3 dp, upgraded to 4 dp only when that hits the base exactly.
export function qtyForRate(base, rate) {
  const b = Number(base);
  const rateF = Number(rate);
  if (!(b > 0) || !(rateF > 0)) return null;
  const raw = b / rateF;
  const q3 = r3(raw);
  if (paisa(q3 * rateF) === paisa(b)) return q3;
  const q4 = r4(raw);
  if (paisa(q4 * rateF) === paisa(b)) return q4;
  return q3;
}

// ---------------------------------------------------------------- margins

export function bandStatus(rate, buyRate, lowPct = 5, highPct = 7) {
  const rateF = Number(rate);
  if (!Number.isFinite(rateF)) return { status: 'UNKNOWN_COST', pct: null, low_rate: null, high_rate: null };
  const buy = buyRate === null || buyRate === undefined ? 0 : Number(buyRate);
  if (!Number.isFinite(buy) || buy <= 0) {
    return { status: 'UNKNOWN_COST', pct: null, low_rate: null, high_rate: null };
  }
  const lo = Number(lowPct);
  const hi = Number(highPct);
  const pct = r2(((rateF - buy) / buy) * 100);
  let status;
  if (pct < lo) status = 'LOSS';
  else if (pct > hi) status = 'OVER_TAX';
  else status = 'OK';
  return {
    status,
    pct,
    low_rate: buy * (1 + lo / 100),
    high_rate: buy * (1 + hi / 100),
  };
}

export function marginForLine(item, saleUnit, rate, lowPct = 5, highPct = 7) {
  if (!item) return { buy_rate: null, margin_pct: null, margin_status: 'UNKNOWN_COST' };
  const buy = item.buy_rate;
  if (buy === null || buy === undefined || Number(buy) <= 0) {
    return { buy_rate: null, margin_pct: null, margin_status: 'UNKNOWN_COST' };
  }
  const itemRate = convertRate(rate, saleUnit, item.unit);
  if (itemRate === null) return { buy_rate: null, margin_pct: null, margin_status: 'UNKNOWN_COST' };
  const band = bandStatus(itemRate, buy, lowPct, highPct);
  return {
    buy_rate: Number(buy),
    margin_pct: band.pct,
    margin_status: band.status,
    low_rate: band.low_rate,
    high_rate: band.high_rate,
  };
}

// ---------------------------------------------------------------- names / matching

const SYNONYMS = {
  camara: 'camera',
  protertor: 'protector',
  protrector: 'protector',
  procotor: 'protector',
  protection: 'protector',
  protector: 'protector',
  protecter: 'protector',
  tempr: 'temper',
  tempered: 'temper',
  sticket: 'sticker',
  covers: 'cover',
  cover: 'cover',
};

export function normalizeWord(word) {
  const w = String(word).toLowerCase().trim();
  return SYNONYMS[w] ?? w;
}

export function tokens(text) {
  if (text === null || text === undefined) return [];
  const words = String(text).toLowerCase().match(/[a-z0-9]+/g) || [];
  return words.map(normalizeWord).filter((w) => w.length > 0);
}

export function normalizeText(text) {
  return tokens(text).join(' ');
}

// Word-overlap (Jaccard) after merging known spellings.
export function nameScore(description, name) {
  const a = new Set(tokens(description));
  const b = new Set(tokens(name));
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter += 1;
  return inter / (a.size + b.size - inter);
}

export function searchMatch(query, name, source = '') {
  const q = new Set(tokens(query));
  if (q.size === 0) return true;
  const hay = new Set([...tokens(name), ...tokens(source)]);
  for (const t of q) if (!hay.has(t)) return false;
  return true;
}

function suggestion(item, score, gap, margin) {
  return {
    item_id: item.id,
    id: item.id,
    name: item.name,
    unit: item.unit,
    sell_rate: item.sell_rate,
    buy_rate: item.buy_rate ?? null,
    stock: item.stock,
    rate_gap_pct: gap,
    margin_status: margin.margin_status,
    margin_pct: margin.margin_pct ?? null,
    score: r2(score),
  };
}

// Closest item by name and rate, per PRD v2 section 6.
export function matchItems(description, rate, saleUnit, items, lowPct = 5, highPct = 7, limit = 3) {
  const rateF = Number(rate);
  if (!Number.isFinite(rateF)) {
    return { confident: false, item: null, method: 'rate_only', suggestions: [] };
  }
  const text = description === null || description === undefined ? '' : String(description).trim();
  const scored = [];
  for (const item of items) {
    if (!item.active) continue;
    if (!compatible(saleUnit, item.unit)) continue;
    const sell = convertRate(item.sell_rate, item.unit, saleUnit);
    if (sell === null || sell <= 0) continue;
    const gap = r2((Math.abs(rateF - sell) / sell) * 100);
    const score = text ? nameScore(text, item.name) : 0;
    const margin = marginForLine(item, saleUnit, rateF, lowPct, highPct);
    scored.push({ item, score, gap, margin });
  }
  const withWords = scored.filter((row) => row.score > 0);
  const pool = withWords.length ? withWords : scored;
  const method = withWords.length ? 'name_rate' : 'rate_only';
  pool.sort((a, b) =>
    a.gap - b.gap ||
    b.score - a.score ||
    String(a.item.name).toLowerCase().localeCompare(String(b.item.name).toLowerCase()) ||
    a.item.sell_rate - b.item.sell_rate,
  );
  const top = pool.slice(0, limit);
  const suggestions = top.map((row) => suggestion(row.item, row.score, row.gap, row.margin));
  if (top.length === 0) return { confident: false, item: null, method, suggestions: [] };
  const best = top[0];
  const confident = text ? best.score >= 0.5 && best.gap <= 2.0 : best.gap <= 0.5;
  return {
    confident,
    item: confident ? best.item : null,
    best,
    method,
    suggestions,
  };
}

// ---------------------------------------------------------------- bill math

export function lineSubtotal(qty, rate) {
  return r2(Number(qty) * Number(rate));
}

export function billTotals(lines, gross, vatPct) {
  const tax = taxableBase(gross, vatPct);
  let sumP = 0;
  for (const line of lines) sumP += paisa(line.subtotal);
  const varianceP = sumP - paisa(tax.base);
  return {
    taxable_base: tax.base,
    vat_amount: tax.vat,
    lines_total: sumP / 100,
    variance: varianceP / 100,
  };
}

export function billStatus(lines) {
  return lines.length > 0 && lines.every((line) => line.confirmed) ? 'complete' : 'needs_review';
}
