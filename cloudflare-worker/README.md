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
| `src/index.js` | Worker entry: routing, CORS, the sign-in gate |
| `src/auth.js` | Shop password hashing, sessions, login throttling |
| `src/engine.js` | The pricing rules (reverse VAT, units, margin band, matching) |
| `src/db.js` | D1 data layer: items, settings, bills, lines, movements, alerts |
| `migrations/0001_schema.sql` | Tables and indexes |
| `migrations/0002_seed.sql` | The 99 items and the 5 settings, from the stock PDF |
| `migrations/0003_auth.sql` | Password, sessions and login attempts |
| `scripts/generate-seed.mjs` | Regenerates `0002_seed.sql` from the seed CSV |
| `scripts/set-password.mjs` | Sets or recovers the shop password |
| `scripts/reset-db.sql` | Puts the live database back to its seeded state |
| `tests/engine.test.mjs` | Pure rule tests (no network) |
| `tests/integration.test.mjs` | API tests against a running Worker |

The rules are a port of `backend/app/engine.py` (the local FastAPI backend).
Both must agree; the same test numbers are used in both suites.

## Deploying

```bash
npx wrangler login
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
SHOP_PASSWORD=... WORKER_URL=http://127.0.0.1:8832 node --test tests/integration.test.mjs
```

Windows reserves TCP ports 8732-8831, so a local `wrangler dev` has to use 8832
or higher, with an inspector port outside 9174-9273.

The UI suites live one folder up; each takes `API_BASE` and `SHOP_PASSWORD`:

```bash
cd ../web-tests
SHOP_PASSWORD=... API_BASE=https://a-to-z-counter.g-urbish11.workers.dev node online-worker.mjs
SHOP_PASSWORD=... API_BASE=https://a-to-z-counter.g-urbish11.workers.dev node sheet.js
SHOP_PASSWORD=... API_BASE=https://a-to-z-counter.g-urbish11.workers.dev node login.js
```

`password-change.js` really changes the password, so it refuses to run against a
deployed backend:

```bash
SHOP_PASSWORD=... API_BASE=http://127.0.0.1:8832 node password-change.js
```

## Operating the live database

The test suites write real bills and deduct real stock. After running them
against production, reset the data:

```bash
npx wrangler d1 execute a-to-z-counter --remote --file scripts/reset-db.sql
```

This drops bills, lines, movements and alerts, and restores every item's stock
to the seeded quantity (`items.source_qty`). It leaves the password and the
sessions alone.

## Signing in

The API sits behind a shop password. `POST /api/login` trades the password for a
30-day session token; every other `/api/*` call needs `Authorization: Bearer
<token>`. Only a PBKDF2 hash of the password and the SHA-256 of each token are
stored, so a copy of the database cannot be turned into a sign-in.

The password lives in D1 (the `auth` table), not in a Worker secret, so it can be
changed without a deploy: **Backend settings → Change shop password** in the app.
That also signs out every other device. A mistyped current password is refused
with 400 rather than signing the person out.

To set or recover it from the command line (the password never lands in a file or
in the shell history):

```bash
printf '%s' "$PASSWORD" | node scripts/set-password.mjs -
npx wrangler d1 execute a-to-z-counter --remote --file .password.sql
```

That writes a hash, never the password, and clears every session, so all devices
must sign in again. `.password.sql` is git-ignored; delete it once applied.

Two limits worth knowing: Cloudflare rejects PBKDF2 above 100,000 iterations, so
the code uses that ceiling; and ten wrong passwords from one address in fifteen
minutes start answering 429. The correct password still gets in while that
window is open, so a run of typos at the counter cannot lock the shop out of its
own till.

The old `X-API-Key` path still works if an `API_KEY` secret is ever set again,
for a script that must bypass the login. No secret is set.
