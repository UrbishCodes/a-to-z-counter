# A to Z Counter — Cloudflare Workers + D1

The live backend for the Counter sales app. It serves the frontend (the `../web`
folder) and the whole `/api/*` surface, so the whole app runs on one URL.

**Live URL:** https://a-to-z-counter.g-urbish11.workers.dev

**Data sheet:** https://a-to-z-counter.g-urbish11.workers.dev/sheet — every item
with the stock PDF's particulars and quantity beside the stored values, where a
wrong name, HS code, unit, rate or quantity can be corrected. A quantity change
is saved as a `correction` movement, so the stock history stays complete.

## What is where

| Path | What it is |
| --- | --- |
| `src/index.js` | Worker entry: routing, CORS, optional `X-API-Key` check |
| `src/engine.js` | The pricing rules (reverse VAT, units, margin band, matching) |
| `src/db.js` | D1 data layer: items, settings, bills, lines, movements, alerts |
| `migrations/0001_schema.sql` | Tables and indexes |
| `migrations/0002_seed.sql` | The 99 items and the 5 settings, from the stock PDF |
| `scripts/generate-seed.mjs` | Regenerates `0002_seed.sql` from the seed CSV |
| `scripts/reset-db.sql` | Puts the live database back to its seeded state |
| `tests/engine.test.mjs` | Pure rule tests (no network) |
| `tests/integration.test.mjs` | API tests against a running Worker |

The rules are a port of `backend/app/engine.py` (the local FastAPI backend).
Both must agree; the same test numbers are used in both suites.

## Deploying

```bash
npx wrangler login                      # one time, opens the Cloudflare OAuth page
npx wrangler d1 migrations apply a-to-z-counter --remote
npx wrangler deploy
```

The D1 database id lives in `wrangler.jsonc`. The frontend in `../web` is
uploaded as the Worker's static assets, so a deploy publishes the app and the
backend together.

## Running the tests

```bash
node --test tests/engine.test.mjs                        # rules only
npx wrangler dev --port 8832 --inspector-port 9000       # local worker
WORKER_URL=http://127.0.0.1:8832 node --test tests/integration.test.mjs
```

Windows reserves TCP ports 8732-8831, so local `wrangler dev` has to use 8832
or higher (and an inspector port outside 9174-9273).

The UI suite lives one folder up:

```bash
cd ../web-tests
API_BASE=https://a-to-z-counter.g-urbish11.workers.dev node online-worker.mjs
```

## Operating the live database

The test suites write real bills and deduct real stock. After running them
against production, reset the data:

```bash
npx wrangler d1 execute a-to-z-counter --remote --file scripts/reset-db.sql
```

This drops bills, lines, movements and alerts, and restores every item's stock
to the seeded quantity (`items.source_qty`).

## Locking the API

The API is **locked**: `API_KEY` is set as a Worker secret, so every `/api/*`
call without the `X-API-Key` header answers 401. The key itself is kept outside
this repository, next to the user's documents, and each device pastes it once
into the app's "Backend settings" panel (stored in that browser's local storage).

```bash
npx wrangler secret put API_KEY       # rotate the key (paste the new value)
npx wrangler secret delete API_KEY    # remove the lock entirely
```

After rotating, the page reports "Locked: this backend needs its API key" until
the new key is entered on each device.

Run the test suites with the key in the environment so they keep working
against the locked worker:

```bash
API_KEY=... WORKER_URL=https://a-to-z-counter.g-urbish11.workers.dev \
  node --test tests/integration.test.mjs
API_KEY=... API_BASE=https://a-to-z-counter.g-urbish11.workers.dev \
  node ../web-tests/online-worker.mjs
```
