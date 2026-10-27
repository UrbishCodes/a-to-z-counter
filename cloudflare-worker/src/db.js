// D1 data layer for the counter (port of backend/app/db.py).
// All state lives in Cloudflare D1 (SQLite). Writes go through env.DB.batch()
// so a bill save is atomic. Every rule comes from ./engine.js.

import * as engine from './engine.js';

export class ValueError extends Error {}

export function nowIso() {
  return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
}

// ---------------------------------------------------------------- helpers

function prep(env, sql, ...values) {
  const stmt = env.DB.prepare(sql);
  return values.length ? stmt.bind(...values) : stmt;
}

async function all(env, sql, ...values) {
  return (await prep(env, sql, ...values).all()).results;
}

async function first(env, sql, ...values) {
  return (await prep(env, sql, ...values).first()) ?? null;
}

async function run(env, sql, ...values) {
  return prep(env, sql, ...values).run();
}

// ---------------------------------------------------------------- serializers

function itemRow(row) {
  return {
    id: row.id,
    hs_code: row.hs_code ?? '',
    name: row.name,
    unit: row.unit,
    buy_rate: row.buy_rate === null || row.buy_rate === undefined ? null : Number(row.buy_rate),
    sell_rate: Number(row.sell_rate),
    stock: Number(row.stock),
    last_count: row.last_count === null || row.last_count === undefined ? null : Number(row.last_count),
    reorder_point: row.reorder_point === null || row.reorder_point === undefined ? null : Number(row.reorder_point),
    active: Boolean(row.active),
    source_particulars: row.source_particulars ?? '',
    source_qty: row.source_qty === null || row.source_qty === undefined ? null : Number(row.source_qty),
  };
}

function alertRow(row) {
  return {
    id: row.id,
    code: row.code,
    key: row.key,
    severity: row.severity,
    message: row.message,
    item_id: row.item_id ?? null,
    created_at: row.created_at,
    acknowledged_at: row.acknowledged_at ?? null,
    resolved_at: row.resolved_at ?? null,
  };
}

function lineRow(row) {
  let suggestions = [];
  try {
    suggestions = JSON.parse(row.suggestions || '[]');
  } catch (e) {
    suggestions = [];
  }
  return {
    id: row.id,
    line_no: row.line_no,
    description: row.description,
    sale_unit: row.sale_unit,
    qty: Number(row.qty),
    unit_rate: Number(row.unit_rate),
    subtotal: Number(row.subtotal),
    item_id: row.item_id ?? null,
    match_method: row.match_method ?? '',
    confirmed: Boolean(row.confirmed),
    buy_rate: row.buy_rate === null || row.buy_rate === undefined ? null : Number(row.buy_rate),
    margin_pct: row.margin_pct === null || row.margin_pct === undefined ? null : Number(row.margin_pct),
    margin_status: row.margin_status ?? null,
    stock_delta: Number(row.stock_delta),
    suggestions,
  };
}

function billRow(bill, lines) {
  return {
    id: bill.id,
    bill_no: bill.bill_no,
    created_at: bill.created_at,
    created_by: bill.created_by ?? '',
    gross_total: Number(bill.gross_total),
    vat_pct: Number(bill.vat_pct),
    taxable_base: Number(bill.taxable_base),
    vat_amount: Number(bill.vat_amount),
    lines_total: Number(bill.lines_total),
    variance: Number(bill.variance),
    status: bill.status,
    note: bill.note ?? '',
    lines: lines.map(lineRow),
  };
}

// ---------------------------------------------------------------- settings

export async function getSettings(env) {
  const rows = await all(env, 'SELECT key, value FROM settings');
  const values = Object.fromEntries(rows.map((row) => [row.key, row.value]));
  const number = (key, kind) => {
    const raw = values[key] ?? String(engine.DEFAULT_SETTINGS[key]);
    const n = kind(raw);
    return Number.isFinite(n) ? n : engine.DEFAULT_SETTINGS[key];
  };
  return {
    vat_pct: number('vat_pct', Number),
    band_low_pct: number('band_low_pct', Number),
    band_high_pct: number('band_high_pct', Number),
    cover_baseline: number('cover_baseline', (v) => Math.trunc(Number(v))),
    restock_qty: number('restock_qty', (v) => Math.trunc(Number(v))),
  };
}

export async function updateSettings(env, data) {
  const allowed = new Set(['vat_pct', 'band_low_pct', 'band_high_pct', 'cover_baseline', 'restock_qty']);
  const updates = {};
  for (const [key, value] of Object.entries(data ?? {})) {
    if (allowed.has(key) && value !== null && value !== undefined) updates[key] = value;
  }
  if (Object.keys(updates).length === 0) return getSettings(env);
  const current = await getSettings(env);
  const merged = { ...current, ...updates };
  if (Number(merged.band_low_pct) >= Number(merged.band_high_pct)) {
    throw new ValueError('band_low_pct must be lower than band_high_pct');
  }
  if (Number(merged.vat_pct) < 0) throw new ValueError('vat_pct cannot be negative');
  if (Number(merged.cover_baseline) < 0 || Number(merged.restock_qty) < 0) {
    throw new ValueError('cover baseline and restock quantity cannot be negative');
  }
  for (const [key, value] of Object.entries(updates)) {
    const stored = key === 'cover_baseline' || key === 'restock_qty'
      ? String(Math.trunc(Number(value)))
      : String(Math.round(Number(value) * 100) / 100);
    await run(env,
      'INSERT INTO settings(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
      key, stored);
  }
  await refreshAlerts(env);
  return getSettings(env);
}

// ---------------------------------------------------------------- items

export async function itemCount(env) {
  const row = await first(env, 'SELECT COUNT(*) AS n FROM items WHERE active=1');
  return Number(row.n);
}

export async function allItems(env, activeOnly = true) {
  const rows = await all(env,
    `SELECT * FROM items${activeOnly ? ' WHERE active=1' : ''} ORDER BY name, sell_rate, id`);
  return rows.map(itemRow);
}

export async function listItems(env, q = '', unit = null, limit = 50) {
  let items = await allItems(env, true);
  if (unit) items = items.filter((item) => engine.compatible(unit, item.unit));
  const query = String(q ?? '').trim();
  if (query) items = items.filter((item) => engine.searchMatch(query, item.name, item.source_particulars));
  const safeLimit = Math.max(1, Math.min(Number(limit) || 50, 200));
  return items.slice(0, safeLimit);
}

export async function getItem(env, itemId) {
  const row = await first(env, 'SELECT * FROM items WHERE id=?', itemId);
  return row ? itemRow(row) : null;
}

export async function createItem(env, data) {
  const name = String(data.name ?? '').trim();
  const unit = String(data.unit ?? '');
  if (!name) throw new ValueError('name is required');
  if (!engine.validUnit(unit)) throw new ValueError('unit must be pcs, doz or kg');
  const sell = Number(data.sell_rate);
  if (!Number.isFinite(sell) || sell <= 0) throw new ValueError('sell_rate must be a number');
  let buy = data.buy_rate === null || data.buy_rate === undefined ? null : Number(data.buy_rate);
  if (buy !== null && (buy < 0 || !Number.isFinite(buy))) throw new ValueError('buy_rate cannot be negative');
  const stock = Number(data.stock ?? 0);
  if (stock < 0) throw new ValueError('stock cannot be negative');
  const last = data.last_count === null || data.last_count === undefined ? stock : Number(data.last_count);
  const reorder = data.reorder_point === null || data.reorder_point === undefined
    ? null : Number(data.reorder_point);
  const active = data.active === undefined ? 1 : (data.active ? 1 : 0);
  const result = await run(env,
    `INSERT INTO items(hs_code, name, unit, buy_rate, sell_rate, stock, last_count,
                       reorder_point, active, source_particulars, source_qty)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    String(data.hs_code ?? ''), name, unit, buy, sell, stock, last, reorder, active,
    String(data.source_particulars ?? name),
    data.source_qty === undefined || data.source_qty === null ? null : Number(data.source_qty));
  const itemId = result.meta?.last_row_id ?? Number((await first(env,
    'SELECT id FROM items WHERE name=? AND sell_rate=? ORDER BY id DESC LIMIT 1', name, sell)).id);
  await refreshAlerts(env);
  return getItem(env, itemId);
}

export async function updateItem(env, itemId, data) {
  const item = await getItem(env, itemId);
  if (!item) return null;
  const allowed = ['sell_rate', 'buy_rate', 'reorder_point', 'active'];
  const updates = {};
  for (const key of allowed) {
    if (Object.prototype.hasOwnProperty.call(data, key) && data[key] !== undefined) {
      updates[key] = data[key];
    }
  }
  if (Object.keys(updates).length === 0) return item;
  if ('sell_rate' in updates && Number(updates.sell_rate) <= 0) {
    throw new ValueError('sell_rate must be greater than 0');
  }
  if ('buy_rate' in updates && updates.buy_rate !== null && Number(updates.buy_rate) < 0) {
    throw new ValueError('buy_rate cannot be negative');
  }
  if ('reorder_point' in updates && updates.reorder_point !== null && Number(updates.reorder_point) < 0) {
    throw new ValueError('reorder_point cannot be negative');
  }
  if ('active' in updates) updates.active = updates.active ? 1 : 0;
  const keys = Object.keys(updates);
  const sets = keys.map((key) => `${key}=?`).join(', ');
  await run(env, `UPDATE items SET ${sets} WHERE id=?`, ...keys.map((key) => updates[key]), itemId);
  await refreshAlerts(env);
  return getItem(env, itemId);
}

export async function setCount(env, itemId, count) {
  const item = await getItem(env, itemId);
  if (!item) return null;
  const countF = Number(count);
  if (countF < 0) throw new ValueError('count cannot be negative');
  const delta = countF - item.stock;
  const created = nowIso();
  await env.DB.batch([
    prep(env, 'UPDATE items SET stock=?, last_count=? WHERE id=?', countF, countF, itemId),
    prep(env, `INSERT INTO movements(item_id, delta, stock_after, reason, ref, note, created_at)
               VALUES (?,?,?,?,?,?,?)`, itemId, delta, countF, 'count', 'manual', 'physical count', created),
  ]);
  await refreshAlerts(env);
  return getItem(env, itemId);
}

export async function receiveItem(env, itemId, qty, buyRate = null) {
  const item = await getItem(env, itemId);
  if (!item) return null;
  const qtyF = Number(qty);
  if (qtyF <= 0) throw new ValueError('qty must be greater than 0');
  const newStock = item.stock + qtyF;
  const created = nowIso();
  if (buyRate === null || buyRate === undefined) {
    await env.DB.batch([
      prep(env, 'UPDATE items SET stock=? WHERE id=?', newStock, itemId),
      prep(env, `INSERT INTO movements(item_id, delta, stock_after, reason, ref, note, created_at)
                 VALUES (?,?,?,?,?,?,?)`, itemId, qtyF, newStock, 'purchase', 'manual', 'stock received', created),
    ]);
  } else {
    await env.DB.batch([
      prep(env, 'UPDATE items SET stock=?, buy_rate=? WHERE id=?', newStock, Number(buyRate), itemId),
      prep(env, `INSERT INTO movements(item_id, delta, stock_after, reason, ref, note, created_at)
                 VALUES (?,?,?,?,?,?,?)`, itemId, qtyF, newStock, 'purchase', 'manual', 'stock received', created),
    ]);
  }
  await refreshAlerts(env);
  return getItem(env, itemId);
}

// ---------------------------------------------------------------- bills

export async function getBill(env, billId) {
  const bill = await first(env, 'SELECT * FROM bills WHERE id=?', billId);
  if (!bill) return null;
  const lines = await all(env, 'SELECT * FROM bill_lines WHERE bill_id=? ORDER BY line_no', billId);
  return billRow(bill, lines);
}

export async function listBills(env, limit = 50) {
  const safeLimit = Math.max(1, Math.min(Number(limit) || 50, 200));
  const ids = await all(env, 'SELECT id FROM bills ORDER BY id DESC LIMIT ?', safeLimit);
  const bills = [];
  for (const row of ids) {
    const bill = await getBill(env, row.id);
    if (bill) bills.push(bill);
  }
  return bills;
}

function buildLines(rawLines, items, lowPct, highPct) {
  const byId = new Map(items.map((item) => [item.id, item]));
  const built = [];
  let index = 0;
  for (const raw of rawLines) {
    index += 1;
    const saleUnit = String(raw.sale_unit ?? '');
    if (!engine.validUnit(saleUnit)) {
      throw new ValueError(`line ${index}: sale_unit must be pcs, doz or kg`);
    }
    const qty = Number(raw.qty);
    const rate = Number(raw.unit_rate);
    if (!Number.isFinite(qty) || !Number.isFinite(rate)) {
      throw new ValueError(`line ${index}: qty and unit_rate must be numbers`);
    }
    if (!engine.validCount(saleUnit, qty)) {
      throw new ValueError(`line ${index}: invalid count for ${saleUnit}`);
    }
    if (rate <= 0) throw new ValueError(`line ${index}: unit_rate must be greater than 0`);
    let item = raw.item_id ? byId.get(Number(raw.item_id)) ?? null : null;
    if (raw.item_id && !item) throw new ValueError(`line ${index}: item not found or inactive`);
    if (item && !engine.compatible(saleUnit, item.unit)) {
      throw new ValueError(`line ${index}: item cannot be sold in ${saleUnit}`);
    }
    let description = String(raw.description ?? '').trim();
    if (item && !description) description = item.name;
    let confirmed;
    let matchMethod;
    let suggestions = [];
    if (item) {
      confirmed = true;
      matchMethod = 'chosen';
    } else {
      const match = engine.matchItems(description, rate, saleUnit, items, lowPct, highPct);
      if (match.confident) {
        item = match.item;
        confirmed = true;
        matchMethod = match.method;
      } else {
        confirmed = false;
        matchMethod = match.method;
        suggestions = match.suggestions;
      }
    }
    const margin = item
      ? engine.marginForLine(item, saleUnit, rate, lowPct, highPct)
      : { buy_rate: null, margin_pct: null, margin_status: 'UNKNOWN_COST' };
    let stockDelta = 0;
    if (item && confirmed) {
      const qtyItem = engine.convertQty(qty, saleUnit, item.unit);
      if (qtyItem === null) {
        throw new ValueError(`line ${index}: cannot convert ${saleUnit} to ${item.unit}`);
      }
      stockDelta = -qtyItem;
    }
    built.push({
      line_no: index,
      description: description || 'Item',
      sale_unit: saleUnit,
      qty,
      unit_rate: rate,
      subtotal: engine.lineSubtotal(qty, rate),
      item,
      item_id: item ? item.id : null,
      match_method: matchMethod,
      confirmed,
      buy_rate: margin.buy_rate ?? null,
      margin_pct: margin.margin_pct ?? null,
      margin_status: margin.margin_status,
      stock_delta: stockDelta,
      suggestions,
    });
  }
  return built;
}

export async function saveBill(env, payload) {
  const gross = Number(payload.gross_total);
  if (!Number.isFinite(gross) || gross <= 0) throw new ValueError('gross_total must be greater than 0');
  if (payload.vat_pct === null || payload.vat_pct === undefined) {
    throw new ValueError('vat_pct must be a number');
  }
  const vat = Number(payload.vat_pct);
  if (!Number.isFinite(vat) || vat < 0) throw new ValueError('vat_pct cannot be negative');
  const rawLines = payload.lines ?? [];
  if (!Array.isArray(rawLines) || rawLines.length === 0) {
    throw new ValueError('at least one line is required');
  }
  const settings = await getSettings(env);
  const items = await allItems(env, true);
  const lines = buildLines(rawLines, items, settings.band_low_pct, settings.band_high_pct);
  const totals = engine.billTotals(lines, gross, vat);
  const status = engine.billStatus(lines);
  const created = nowIso();

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const nextRow = await first(env, 'SELECT COALESCE(MAX(id), 0) + 1 AS next FROM bills');
    const billId = Number(nextRow.next);
    const billNo = `BL-${String(billId).padStart(6, '0')}`;
    const stmts = [];
    stmts.push(prep(env,
      `INSERT INTO bills(id, bill_no, created_at, created_by, gross_total, vat_pct, taxable_base,
                         vat_amount, lines_total, variance, status, note)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      billId, billNo, created, String(payload.created_by ?? ''), gross, vat,
      totals.taxable_base, totals.vat_amount, totals.lines_total, totals.variance, status,
      String(payload.note ?? '')));
    const stocks = new Map(items.map((item) => [item.id, item.stock]));
    for (const line of lines) {
      stmts.push(prep(env,
        `INSERT INTO bill_lines(bill_id, line_no, description, sale_unit, qty, unit_rate,
           subtotal, item_id, match_method, confirmed, buy_rate, margin_pct, margin_status,
           stock_delta, suggestions)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        billId, line.line_no, line.description, line.sale_unit, line.qty, line.unit_rate,
        line.subtotal, line.item_id, line.match_method, line.confirmed ? 1 : 0,
        line.buy_rate, line.margin_pct, line.margin_status, line.stock_delta,
        JSON.stringify(line.suggestions)));
      if (line.confirmed && line.item_id) {
        const after = stocks.get(line.item_id) + line.stock_delta;
        stocks.set(line.item_id, after);
        stmts.push(prep(env, 'UPDATE items SET stock=? WHERE id=?', after, line.item_id));
        stmts.push(prep(env,
          `INSERT INTO movements(item_id, delta, stock_after, reason, ref, note, created_at)
           VALUES (?,?,?,?,?,?,?)`,
          line.item_id, line.stock_delta, after, 'sale', billNo, line.description, created));
      }
    }
    try {
      const results = await env.DB.batch(stmts);
      if (!results.every((result) => result.success)) {
        throw new ValueError('saving the bill failed');
      }
      await refreshAlerts(env);
      return await getBill(env, billId);
    } catch (error) {
      if (attempt < 2 && /UNIQUE/i.test(String(error?.message ?? error))) continue;
      throw error;
    }
  }
  throw new ValueError('could not allocate a bill number');
}

export async function confirmLine(env, billId, lineNo, itemId) {
  const bill = await getBill(env, billId);
  if (!bill) return null;
  const line = bill.lines.find((candidate) => candidate.line_no === lineNo);
  if (!line) throw new ValueError('line not found');
  if (line.confirmed) {
    if (line.item_id === itemId) return bill;
    throw new ValueError('line is already confirmed');
  }
  const item = await getItem(env, itemId);
  if (!item || !item.active) throw new ValueError('item not found or inactive');
  if (!engine.compatible(line.sale_unit, item.unit)) {
    throw new ValueError('item cannot be sold in this unit');
  }
  const qtyItem = engine.convertQty(line.qty, line.sale_unit, item.unit);
  if (qtyItem === null) throw new ValueError('cannot convert the line count to the item unit');
  const settings = await getSettings(env);
  const margin = engine.marginForLine(item, line.sale_unit, line.unit_rate,
    settings.band_low_pct, settings.band_high_pct);
  const stockDelta = -qtyItem;
  const openRow = await first(env,
    'SELECT COUNT(*) AS n FROM bill_lines WHERE bill_id=? AND confirmed=0', billId);
  const newStatus = Number(openRow.n) - 1 === 0 ? 'complete' : 'needs_review';
  const stockRow = await first(env, 'SELECT stock FROM items WHERE id=?', itemId);
  const after = Number(stockRow.stock) + stockDelta;
  const created = nowIso();
  await env.DB.batch([
    prep(env,
      `UPDATE bill_lines SET item_id=?, match_method='manual', confirmed=1, buy_rate=?,
         margin_pct=?, margin_status=?, stock_delta=?, suggestions='[]'
       WHERE bill_id=? AND line_no=?`,
      itemId, margin.buy_rate ?? null, margin.margin_pct ?? null, margin.margin_status,
      stockDelta, billId, lineNo),
    prep(env, 'UPDATE items SET stock=? WHERE id=?', after, itemId),
    prep(env,
      `INSERT INTO movements(item_id, delta, stock_after, reason, ref, note, created_at)
       VALUES (?,?,?,?,?,?,?)`,
      itemId, stockDelta, after, 'sale', bill.bill_no, line.description, created),
    prep(env, 'UPDATE bills SET status=? WHERE id=?', newStatus, billId),
  ]);
  await refreshAlerts(env);
  return getBill(env, billId);
}

// ---------------------------------------------------------------- inventory and alerts

export async function inventorySummary(env) {
  const settings = await getSettings(env);
  const items = await allItems(env, true);
  const covers = items.filter((item) =>
    item.name.toLowerCase().includes('cover') && (item.unit === 'pcs' || item.unit === 'doz'));
  const total = covers.reduce(
    (sum, item) => sum + item.stock * (item.unit === 'doz' ? 12 : 1), 0);
  const ratio = (item) => {
    if (item.last_count && item.last_count > 0) return item.stock / item.last_count;
    return 1;
  };
  const lowest = [...covers]
    .sort((a, b) => ratio(a) - ratio(b) || a.stock - b.stock || a.name.toLowerCase().localeCompare(b.name.toLowerCase()))
    .slice(0, 5);
  return {
    covers_total: Math.round(total * 100) / 100,
    cover_items: covers.length,
    cover_baseline: settings.cover_baseline,
    restock_qty: settings.restock_qty,
    lowest: lowest.map((item) => ({
      item_id: item.id,
      name: item.name,
      source_particulars: item.source_particulars,
      unit: item.unit,
      stock: item.stock,
      last_count: item.last_count,
      ratio: Math.round(ratio(item) * 10000) / 10000,
    })),
  };
}

async function openAlert(env, code, key) {
  return first(env,
    'SELECT * FROM alerts WHERE code=? AND key=? AND resolved_at IS NULL ORDER BY id DESC LIMIT 1',
    code, key);
}

async function upsertAlert(env, code, key, severity, message, itemId = null) {
  const existing = await openAlert(env, code, key);
  if (existing) {
    await run(env, 'UPDATE alerts SET severity=?, message=?, item_id=? WHERE id=?',
      severity, message, itemId, existing.id);
  } else {
    await run(env,
      'INSERT INTO alerts(code, key, severity, message, item_id, created_at) VALUES (?,?,?,?,?,?)',
      code, key, severity, message, itemId, nowIso());
  }
}

async function resolveAlert(env, code, key) {
  await run(env,
    'UPDATE alerts SET resolved_at=? WHERE code=? AND key=? AND resolved_at IS NULL',
    nowIso(), code, key);
}

export async function refreshAlerts(env) {
  const summary = await inventorySummary(env);
  const items = await allItems(env, true);
  const now = nowIso();

  if (summary.covers_total < summary.cover_baseline) {
    const lowest = summary.lowest[0] ?? null;
    let message = `Covers total ${Math.trunc(Math.round(summary.covers_total)).toLocaleString('en-US')} pcs is below `
      + `the baseline of ${summary.cover_baseline.toLocaleString('en-US')}.`;
    if (lowest) {
      const label = lowest.source_particulars || lowest.name;
      const last = lowest.last_count === null || lowest.last_count === undefined
        ? lowest.stock : lowest.last_count;
      message += ` Lowest: ${label} (stock ${lowest.stock} ${lowest.unit}, last count ${last} ${lowest.unit}).`;
    }
    await upsertAlert(env, 'COVER_BASELINE', 'covers', 'high', message, lowest ? lowest.item_id : null);
  } else {
    await resolveAlert(env, 'COVER_BASELINE', 'covers');
  }

  const negative = items.filter((item) => item.stock < 0);
  const negativeKeys = new Set();
  for (const item of negative) {
    const key = `item:${item.id}`;
    negativeKeys.add(key);
    const label = item.source_particulars || item.name;
    await upsertAlert(env, 'NEGATIVE_STOCK', key, 'high',
      `Negative stock: ${label} is ${item.stock} ${item.unit}.`, item.id);
  }
  for (const existing of await all(env,
    "SELECT id, key FROM alerts WHERE code='NEGATIVE_STOCK' AND resolved_at IS NULL")) {
    if (!negativeKeys.has(existing.key)) await resolveAlert(env, 'NEGATIVE_STOCK', existing.key);
  }

  const reorder = items.filter((item) =>
    item.reorder_point !== null && item.reorder_point !== undefined
    && item.stock <= item.reorder_point);
  const reorderKeys = new Set();
  for (const item of reorder) {
    const key = `item:${item.id}`;
    reorderKeys.add(key);
    const label = item.source_particulars || item.name;
    await upsertAlert(env, 'ITEM_REORDER', key, 'medium',
      `Reorder ${label}: ${item.stock} ${item.unit} left (reorder point ${item.reorder_point}).`, item.id);
  }
  for (const existing of await all(env,
    "SELECT id, key FROM alerts WHERE code='ITEM_REORDER' AND resolved_at IS NULL")) {
    if (!reorderKeys.has(existing.key)) await resolveAlert(env, 'ITEM_REORDER', existing.key);
  }
  return now;
}

export async function listAlerts(env) {
  await refreshAlerts(env);
  const rows = await all(env,
    `SELECT * FROM alerts WHERE resolved_at IS NULL
     ORDER BY CASE severity WHEN 'high' THEN 0 ELSE 1 END, id DESC`);
  return rows.map(alertRow);
}

export async function ackAlert(env, alertId) {
  const existing = await first(env, 'SELECT * FROM alerts WHERE id=?', alertId);
  if (!existing) return null;
  if (!existing.acknowledged_at) {
    await run(env, 'UPDATE alerts SET acknowledged_at=? WHERE id=?', nowIso(), alertId);
  }
  const row = await first(env, 'SELECT * FROM alerts WHERE id=?', alertId);
  return alertRow(row);
}
