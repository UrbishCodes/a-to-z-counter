// Integration tests for the Workers/D1 API (port of backend/tests/test_api.py).
// Expects a local worker running (wrangler dev --port 8832) with migrations applied.
// Run: WORKER_URL=http://127.0.0.1:8832 SHOP_PASSWORD=... node --test tests/integration.test.mjs
// Tests share one database and run in declaration order, mirroring the counter's
// real usage sequence (B3 before B4, etc.). Stock assertions use deltas so the
// suite also works on an already-used database.
import test, { before } from 'node:test';
import assert from 'node:assert/strict';

const BASE = process.env.WORKER_URL ?? 'http://127.0.0.1:8832';
// SHOP_PASSWORD signs in like the app does. API_KEY still works on a worker
// that has the secret set, for scripts and the local dev database.
const PASSWORD = process.env.SHOP_PASSWORD ?? '';
const API_KEY = process.env.API_KEY ?? '';
let TOKEN = '';

async function rawReq(method, path, body, headers = {}) {
  const res = await fetch(BASE + path, {
    method,
    headers: { 'content-type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => null);
  return { status: res.status, data };
}

async function req(method, path, body) {
  const headers = {};
  if (TOKEN) headers.authorization = `Bearer ${TOKEN}`;
  else if (API_KEY) headers['x-api-key'] = API_KEY;
  return rawReq(method, path, body, headers);
}

async function signIn(password = PASSWORD) {
  return rawReq('POST', '/api/login', { password });
}

before(async () => {
  if (!PASSWORD) return; // the local database may run without a password
  const res = await signIn();
  assert.equal(res.status, 200, `sign in failed: ${JSON.stringify(res.data)}`);
  TOKEN = res.data.token;
});
const get = (path) => req('GET', path);
const post = (path, body) => req('POST', path, body);
const put = (path, body) => req('PUT', path, body);
const patch = (path, body) => req('PATCH', path, body);

const usbLine = (usb, qty = 15, rate = 40, description = 'Usb Cable') => ({
  description,
  item_id: usb.id,
  sale_unit: 'pcs',
  qty,
  unit_rate: rate,
});
const bill = (gross, lines, vat = 13) => ({
  gross_total: gross,
  vat_pct: vat,
  created_by: 'test',
  lines,
});

let usb = null;

test('health and settings', async () => {
  const health = await get('/api/health');
  assert.equal(health.status, 200);
  // At least the 99 seeded items. The item-creation test below adds more, so an
  // exact count would only hold on a database that has never been used.
  assert.ok(health.data.items >= 99, `expected the 99 seeded items, got ${health.data.items}`);
  const settings = await get('/api/settings');
  assert.equal(settings.data.vat_pct, 13);
  assert.equal(settings.data.band_low_pct, 5);
  assert.equal(settings.data.band_high_pct, 7);
  assert.equal(settings.data.cover_baseline, 95000);
});

test('search usb cable', async () => {
  const rows = await get('/api/items?q=usb%20cable');
  assert.equal(rows.status, 200);
  usb = rows.data.find((row) => row.name === 'Usb Cable' && row.buy_rate === 37);
  assert.ok(usb, 'Usb Cable not found');
  assert.equal(usb.sell_rate, 40);
  // Check the quantity the seed carried over from the stock PDF, not the live
  // stock: earlier suites in the same run (or a previous run) have sold some.
  assert.equal(usb.source_qty, 87);
  assert.equal((await get('/api/items/999999')).status, 404);
});

test('match endpoint', async () => {
  const res = await post('/api/match', { description: 'usb cable', rate: 40, sale_unit: 'pcs' });
  assert.equal(res.data.confident, true);
  assert.equal(res.data.item.name, 'Usb Cable');
  assert.equal(res.data.method, 'name_rate');
});

test('B3 save at list: over-tax line, stock deducted', async () => {
  const before = await get('/api/items/' + usb.id);
  const res = await post('/api/bills', bill(678, [usbLine(usb)]));
  assert.equal(res.status, 201);
  const data = res.data;
  assert.match(data.bill_no, /^BL-\d{6}$/);
  assert.equal(data.status, 'complete');
  assert.equal(data.taxable_base, 600);
  assert.equal(data.vat_amount, 78);
  assert.equal(data.lines_total, 600);
  assert.equal(data.variance, 0);
  assert.equal(data.lines[0].margin_status, 'OVER_TAX');
  assert.equal(data.lines[0].margin_pct, 8.11);
  const after = await get('/api/items/' + usb.id);
  assert.equal(after.data.stock, before.data.stock - 15);
});

test('B4 discount below buy: LOSS, second bill, stock again', async () => {
  const before = await get('/api/items/' + usb.id);
  const res = await post('/api/bills', bill(600, [usbLine(usb, 15, 35.40)]));
  assert.equal(res.status, 201);
  const data = res.data;
  assert.equal(data.status, 'complete');
  assert.equal(data.taxable_base, 530.97);
  assert.equal(data.vat_amount, 69.03);
  assert.equal(data.variance, 0.03);
  assert.equal(data.lines[0].margin_status, 'LOSS');
  assert.equal(data.lines[0].margin_pct, -4.32);
  const after = await get('/api/items/' + usb.id);
  assert.equal(after.data.stock, before.data.stock - 15);
});

test('B5 free-text line goes to review, then confirms', async () => {
  const free = { description: 'random gadget', sale_unit: 'pcs', qty: 1, unit_rate: 12.34 };
  const res = await post('/api/bills', bill(13.94, [free]));
  assert.equal(res.status, 201);
  const data = res.data;
  assert.equal(data.status, 'needs_review');
  assert.equal(data.variance, 0);
  const suggestions = data.lines[0].suggestions;
  assert.equal(suggestions.length, 3);
  assert.equal(suggestions[0].name, 'Camara Lens');
  const itemId = suggestions[0].item_id;
  const before = await get('/api/items/' + itemId);
  const confirmed = await post(`/api/bills/${data.id}/lines/1/confirm`, { item_id: itemId });
  const after = await get('/api/items/' + itemId);
  assert.equal(confirmed.data.status, 'complete');
  assert.equal(confirmed.data.lines[0].confirmed, true);
  assert.equal(confirmed.data.lines[0].match_method, 'manual');
  assert.ok(Math.abs(confirmed.data.lines[0].stock_delta + 1 / 12) < 1e-9);
  assert.ok(Math.abs((before.data.stock - after.data.stock) - 1 / 12) < 1e-9);
});

test('alerts: covers baseline, acknowledge', async () => {
  const alerts = await get('/api/alerts');
  assert.equal(alerts.status, 200);
  const covers = alerts.data.find((alert) => alert.code === 'COVER_BASELINE');
  assert.ok(covers, 'COVER_BASELINE alert missing');
  assert.match(covers.message, /Covers total [\d,]+ pcs is below the baseline of 95,000/);
  const acked = await post(`/api/alerts/${covers.id}/ack`);
  assert.ok(acked.data.acknowledged_at);
});

test('inventory summary', async () => {
  const summary = await get('/api/inventory/summary');
  assert.equal(summary.data.covers_total, 38526.04);
  assert.equal(summary.data.cover_items, 54);
  assert.equal(summary.data.cover_baseline, 95000);
  assert.equal(summary.data.restock_qty, 5000);
  assert.ok(summary.data.lowest.length > 0);
});

test('create item, count and receive', async () => {
  const created = await post('/api/items', {
    name: 'Test Item', unit: 'pcs', buy_rate: 8, sell_rate: 10, stock: 5,
  });
  assert.equal(created.status, 201);
  const item = created.data;
  const counted = await post(`/api/items/${item.id}/count`, { count: 100 });
  assert.equal(counted.data.stock, 100);
  const received = await post(`/api/items/${item.id}/receive`, { qty: 5 });
  assert.equal(received.data.stock, 105);
});

test('settings update and invalid band', async () => {
  const updated = await put('/api/settings', { band_low_pct: 4, band_high_pct: 8, cover_baseline: 90000 });
  assert.equal(updated.status, 200);
  assert.equal(updated.data.band_low_pct, 4);
  assert.equal(updated.data.cover_baseline, 90000);
  const bad = await put('/api/settings', { band_low_pct: 8, band_high_pct: 4 });
  assert.equal(bad.status, 400);
  await put('/api/settings', { band_low_pct: 5, band_high_pct: 7, cover_baseline: 95000 });
});

test('invalid fractional pcs line is rejected', async () => {
  const res = await post('/api/bills', bill(100, [usbLine(usb, 1.5, 40)]));
  assert.equal(res.status, 400);
});

test('unknown item is rejected', async () => {
  const res = await post('/api/bills', bill(100, [{
    description: 'x', item_id: 999999, sale_unit: 'pcs', qty: 1, unit_rate: 40,
  }]));
  assert.equal(res.status, 400);
});

test('bill list, get and 404', async () => {
  const rows = await get('/api/bills');
  assert.ok(rows.data.length >= 1);
  const saved = rows.data[0];
  const one = await get('/api/bills/' + saved.id);
  assert.equal(one.data.bill_no, saved.bill_no);
  assert.equal((await get('/api/bills/999999')).status, 404);
});

test('bill numbers keep the sequence', async () => {
  const before = await get('/api/bills');
  const first = await post('/api/bills', bill(45.2, [usbLine(usb, 1)]));
  const second = await post('/api/bills', bill(45.2, [usbLine(usb, 1)]));
  const next = (n) => `BL-${String(n).padStart(6, '0')}`;
  assert.equal(first.data.bill_no, next(before.data.length + 1));
  assert.equal(second.data.bill_no, next(before.data.length + 2));
});

test('patch item', async () => {
  const created = await post('/api/items', { name: 'Patch Me', unit: 'pcs', sell_rate: 10, stock: 1 });
  const patched = await patch(`/api/items/${created.data.id}`, { sell_rate: 12 });
  assert.equal(patched.data.sell_rate, 12);
  assert.equal((await get('/api/items/' + created.data.id)).data.name, 'Patch Me');
});

test('data sheet: correct every field, stock change logged', async () => {
  const usb = (await get('/api/items?q=usb%20cable')).data
    .find((row) => row.name === 'Usb Cable' && row.buy_rate === 37);
  const original = {
    hs_code: usb.hs_code, stock: usb.stock, last_count: usb.last_count,
    reorder_point: usb.reorder_point,
  };

  const patched = await patch(`/api/items/${usb.id}`, {
    name: 'Usb Cable', hs_code: '85444290', unit: 'pcs', buy_rate: 37, sell_rate: 40,
    stock: original.stock - 3, last_count: 80, reorder_point: 10, active: true,
  });
  assert.equal(patched.status, 200);
  assert.equal(patched.data.hs_code, '85444290');
  assert.equal(patched.data.stock, original.stock - 3);
  assert.equal(patched.data.last_count, 80);
  assert.equal(patched.data.reorder_point, 10);
  assert.equal(patched.data.name, 'Usb Cable');

  // Deactivated items leave the counter's search but stay visible on the sheet.
  await patch(`/api/items/${usb.id}`, { active: false });
  const hidden = (await get('/api/items?q=usb%20cable')).data.some((row) => row.id === usb.id);
  const onSheet = (await get('/api/items?q=usb%20cable&all=1')).data.some((row) => row.id === usb.id);
  assert.equal(hidden, false);
  assert.equal(onSheet, true);

  const back = await patch(`/api/items/${usb.id}`, {
    active: true, hs_code: original.hs_code, stock: original.stock,
    last_count: original.last_count, reorder_point: original.reorder_point,
  });
  assert.equal(back.data.stock, original.stock);
  assert.equal(back.data.active, true);
});

test('data sheet: nonsense is refused', async () => {
  const usb = (await get('/api/items?q=usb%20cable')).data
    .find((row) => row.name === 'Usb Cable' && row.buy_rate === 37);
  assert.equal((await patch(`/api/items/${usb.id}`, { stock: -1 })).status, 400);
  assert.equal((await patch(`/api/items/${usb.id}`, { unit: 'box' })).status, 400);
  assert.equal((await patch(`/api/items/${usb.id}`, { sell_rate: 0 })).status, 400);
  assert.equal((await patch(`/api/items/${usb.id}`, { name: '   ' })).status, 400);
  assert.equal((await patch(`/api/items/${usb.id}`, { buy_rate: -5 })).status, 400);
});

test('sign in is required for the API', async () => {
  const res = await rawReq('GET', '/api/items');
  assert.equal(res.status, 401);
  assert.equal(res.data.detail, 'Unauthorized');
  assert.equal((await rawReq('GET', '/api/auth/status')).status, 200);
});

test('a wrong password is refused, a right one gets a session', async () => {
  if (!PASSWORD) return;
  const wrong = await signIn('definitely not the password');
  // 401 normally; 429 once this address has used up its attempts, which the
  // suite can do by running several times in a row.
  assert.ok([401, 429].includes(wrong.status), `unexpected ${wrong.status}`);
  if (wrong.status === 401) assert.match(wrong.data.detail, /Wrong password/);

  const good = await signIn();
  assert.equal(good.status, 200);
  assert.ok(good.data.token.length > 20);
  assert.ok(new Date(good.data.expires_at) > new Date());

  const check = await rawReq('GET', '/api/session', undefined, {
    authorization: `Bearer ${good.data.token}`,
  });
  assert.equal(check.status, 200);
  assert.equal(check.data.ok, true);
});

test('signing out ends that session only', async () => {
  if (!PASSWORD) return;
  const extra = await signIn();
  const token = extra.data.token;
  const auth = { authorization: `Bearer ${token}` };

  assert.equal((await rawReq('GET', '/api/health', undefined, auth)).status, 200);
  assert.equal((await rawReq('POST', '/api/logout', undefined, auth)).status, 200);
  assert.equal((await rawReq('GET', '/api/health', undefined, auth)).status, 401);
  // the suite's own session is untouched
  assert.equal((await req('GET', '/api/health')).status, 200);
});
