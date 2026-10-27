// Cloudflare Worker entry: serves the /api routes for the counter app.
// Static files (/ , /calc.js, /style.css, ...) are served by the platform
// assets binding configured in wrangler.jsonc, so this worker only needs /api.
// Port of backend/app/main.py.

import * as db from './db.js';
import * as engine from './engine.js';

const CORS_HEADERS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET,POST,PATCH,PUT,DELETE,OPTIONS',
  'access-control-allow-headers': '*',
  'access-control-max-age': '86400',
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json', ...CORS_HEADERS },
  });
}

async function readBody(request) {
  try {
    return await request.json();
  } catch (e) {
    throw new db.ValueError('invalid JSON body');
  }
}

function idFrom(match, group = 1) {
  return Number(match[group]);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    try {
      if (path.startsWith('/api/')) {
        return await routeApi(request, env, url, path);
      }
      return new Response('Not found', { status: 404 });
    } catch (error) {
      if (error instanceof db.ValueError) {
        return json({ detail: error.message }, 400);
      }
      console.error('unhandled error', error);
      return json({ detail: String(error?.message ?? error) }, 500);
    }
  },
};

async function routeApi(request, env, url, path) {
  const apiKey = env.API_KEY;
  if (apiKey && request.headers.get('x-api-key') !== apiKey) {
    return json({ detail: 'Unauthorized' }, 401);
  }
  const method = request.method;

  // ---- health & settings
  if (method === 'GET' && path === '/api/health') {
    return json({ status: 'ok', items: await db.itemCount(env), version: '4.0.0' });
  }
  if (method === 'GET' && path === '/api/settings') {
    return json(await db.getSettings(env));
  }
  if (method === 'PUT' && path === '/api/settings') {
    return json(await db.updateSettings(env, await readBody(request)));
  }

  // ---- items collection
  if (method === 'GET' && path === '/api/items') {
    const q = url.searchParams.get('q') ?? '';
    const unit = url.searchParams.get('unit');
    if (unit && unit !== 'pcs' && unit !== 'doz' && unit !== 'kg') {
      return json({ detail: 'unit must be pcs, doz or kg' }, 400);
    }
    const limit = Number(url.searchParams.get('limit') ?? 40);
    return json(await db.listItems(env, q, unit, limit));
  }
  if (method === 'POST' && path === '/api/items') {
    return json(await db.createItem(env, await readBody(request)), 201);
  }

  // ---- one item
  let match = path.match(/^\/api\/items\/(\d+)$/);
  if (match) {
    const itemId = idFrom(match);
    if (method === 'GET') {
      const item = await db.getItem(env, itemId);
      return item ? json(item) : json({ detail: 'item not found' }, 404);
    }
    if (method === 'PATCH') {
      const item = await db.updateItem(env, itemId, await readBody(request));
      return item ? json(item) : json({ detail: 'item not found' }, 404);
    }
  }

  // ---- item stock actions
  match = path.match(/^\/api\/items\/(\d+)\/(count|receive)$/);
  if (match && method === 'POST') {
    const itemId = idFrom(match);
    const body = await readBody(request);
    const item = match[2] === 'count'
      ? await db.setCount(env, itemId, Number(body.count))
      : await db.receiveItem(env, itemId, Number(body.qty), body.buy_rate);
    return item ? json(item) : json({ detail: 'item not found' }, 404);
  }

  // ---- matching
  if (method === 'POST' && path === '/api/match') {
    const body = await readBody(request);
    const rules = await db.getSettings(env);
    const items = await db.allItems(env, true);
    const result = engine.matchItems(
      body.description ?? '', Number(body.rate), body.sale_unit, items,
      rules.band_low_pct, rules.band_high_pct);
    return json({
      confident: result.confident,
      method: result.method,
      item: result.item ?? null,
      suggestions: result.suggestions,
    });
  }

  // ---- bills
  if (method === 'GET' && path === '/api/bills') {
    const limit = Number(url.searchParams.get('limit') ?? 50);
    return json(await db.listBills(env, limit));
  }
  if (method === 'POST' && path === '/api/bills') {
    return json(await db.saveBill(env, await readBody(request)), 201);
  }

  match = path.match(/^\/api\/bills\/(\d+)$/);
  if (match && method === 'GET') {
    const bill = await db.getBill(env, idFrom(match));
    return bill ? json(bill) : json({ detail: 'bill not found' }, 404);
  }

  match = path.match(/^\/api\/bills\/(\d+)\/lines\/(\d+)\/confirm$/);
  if (match && method === 'POST') {
    const billId = idFrom(match);
    const lineNo = idFrom(match, 2);
    const body = await readBody(request);
    const bill = await db.getBill(env, billId);
    if (!bill) return json({ detail: 'bill not found' }, 404);
    return json(await db.confirmLine(env, billId, lineNo, Number(body.item_id)));
  }

  // ---- alerts & inventory
  if (method === 'GET' && path === '/api/alerts') {
    return json(await db.listAlerts(env));
  }
  match = path.match(/^\/api\/alerts\/(\d+)\/ack$/);
  if (match && method === 'POST') {
    const alert = await db.ackAlert(env, idFrom(match));
    return alert ? json(alert) : json({ detail: 'alert not found' }, 404);
  }
  if (method === 'GET' && path === '/api/inventory/summary') {
    return json(await db.inventorySummary(env));
  }

  return json({ detail: 'not found' }, 404);
}
