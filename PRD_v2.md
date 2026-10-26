# PRD v2: Counter Sales, Reverse VAT and Stock

Shop: New A to Z Mobile Center (Nepal, VAT 13%)
Version: 2.0 (supersedes the Unified PRD v1)
Status: Calculator and bill recording built and tested. Inventory deduction works through the backend; stock counts and sold-item records are still kept by hand for now. Hosting decision pending.

---

## 1. Purpose

The counter needs one fast tool that:

1. Turns the amount a customer paid (VAT-inclusive) into the taxable base and VAT, and works out the quantity or rate that makes the sale add up.
2. Records every bill with its full context, so bills can be kept and the software improved later.
3. Deducts sold stock from the item list, matches each sale to the closest item by name and rate, and warns when covers are running low.

Staff use it on a laptop at the counter and on an iPhone. The calculator must work even when the backend is off.

---

## 2. Source data (stock summary PDF)

Each row of the stock summary maps to one item:

| PDF column | Meaning | Stored as |
|---|---|---|
| First number | HS code given by the government. Some are wrong. Not used for logic. | `hs_code` (informational) |
| Particulars (text) | Item name / species | `name` |
| `#` value at the end | Our **buy rate** per unit when we purchased | `buy_rate` |
| Rate (max sell) | **Maximum sell rate** per unit. Going above it means more tax. | `sell_rate` |
| Blank column | Closing stock | `stock` (opening balance, 15 Oct 2026) |

Seed: 99 items from `backend/data/items_seed.csv`. One item has no buy rate (`5 P B C Sticket`), so its margin is not checked.

---

## 3. Business rules

### 3.1 Reverse VAT
- Taxable base **X = G ÷ (1 + V%)**, rounded to 2 dp. VAT = G − X.
- Benchmark: G = 7,500, V = 13% → X = 6,637.17, VAT = 862.83.
- All money comparisons are done in paisa (whole numbers) so float drift cannot create a fake variance.

### 3.2 Counting rules
| Unit | Count rule | Which value absorbs the difference |
|---|---|---|
| Pcs | Whole pieces only. Never rounded. | **Rate** (rate = X ÷ count, 2 dp) |
| Dozen | Whole or half dozen. Never rounded. | **Rate** per dozen |
| Kg | Decimal allowed (3 dp, 4 dp if needed to be exact) | **Quantity** by default, with **rate fixed at standard**. Option to flip: quantity fixed, rate adjusts. |

Owner ruling: a half cover cannot be sold, and one cover cannot be counted as two sales. Pcs and dozen counts stay as they are.

### 3.3 Profit band (per item, over buy rate)
- Margin = (sell − buy) ÷ buy × 100.
- **LOSS**: margin below 5%. Staff, rent and other costs are not covered.
- **OK**: margin from 5% to 7%.
- **OVER_TAX**: margin above 7%. Government taxes 13% of the profit, so the extra profit above the band costs more tax.
- **UNKNOWN_COST**: no buy rate on the item. Margin not checked.
- Band limits for an item: allowed sell = buy × 1.05 to buy × 1.07.
- The counter asks for confirmation before saving a LOSS or OVER_TAX line. Nothing is blocked.

### 3.4 Multi-line bills
- The first line on an empty bill absorbs the whole taxable base (exact for a single-item bill).
- Later lines sell at their standard rate.
- **Balance here** on any line sets its rate so that all lines add up to the base.
- The difference between lines and base is always shown before saving and stored on the bill.

### 3.5 Kg specifics
- Kg items sell only against kg items. Pcs and dozen sell only against pcs or dozen items.
- Dozen converts to pieces at 12 per dozen. Rates convert the same way.

---

## 4. Calculator flow (v3)

Four steps, top to bottom, on one screen:

1. **Bill total**: total paid and VAT %. Shows taxable base and VAT, and the arithmetic.
2. **Item and unit**: Pcs / Dozen / Kg, item search (when connected), standard rate. The band hint shows the allowed sell range.
3. **Count sold**: quick buttons (−1, +1, +10 for pcs; −1, −½, +½, +1 and ½ / 1 / 1½ / 2 doz for dozen), kg "which one adjusts?" switch, closest counts to the standard rate, the computed rate, **Add line to bill**.
4. **Check and save**: bill lines and difference, margin warning, billing line text, **Copy**, staff name, **Save bill**. Matching review appears below after saving.

Fixes from the review of v2:
- **Reset all** clears the bill, lines and standard rate, and shows a confirmation.
- Pcs flow: one count, the rate follows it, typed rate holds the count, **Let rate follow count again** resets it.
- Kg: explicit switch between "rate fixed, quantity adjusts" (default) and "quantity fixed, rate adjusts". The computed field is shown dashed and read-only.
- Dozen: half-dozen buttons (−½, +½) and quick presets (½, 1, 1½, 2).
- Each step labels what is typed and what is calculated.

---

## 5. Bill recording

- Each saved bill stores: bill number (BL-000001 style), time, staff name, total paid, VAT %, taxable base, VAT, lines total, difference, status, and note.
- Each line stores: description as typed, item matched (if any), sale unit, quantity, unit rate, subtotal, buy rate, margin %, margin status, stock change, match method, and the suggestions that were offered.
- Bill status: **complete** (every line has an item and stock is deducted) or **needs_review** (some lines are not matched; they do not deduct stock until confirmed).
- Bills are never edited in place. Corrections are made by a new bill or by confirming a pending line.

---

## 6. Matching: closest item and closest rate

Used when a line has no chosen item:

1. Keep active items compatible with the sale unit.
2. Name score: word overlap (Jaccard) between the typed text and the item name, after merging known spellings (camara→camera, protertor/protrector/procotor/protection→protector, tempr/tempered→temper, sticket→sticker, covers→cover).
3. If any item shares words with the text, rank those by rate gap. Otherwise rank all compatible items by rate gap (method `rate_only`).
4. Rate gap = |rate − item max sell| ÷ max sell × 100.
5. **Confident** (deducted automatically) only if name score ≥ 0.5 and rate gap ≤ 2%. With no text, rate gap must be ≤ 0.5%.
6. Otherwise the line goes to review with the top 3 suggestions.

Matching is deterministic. Gemma/LLM matching is not used. It can be added later for the unmatched lines if needed.

---

## 7. Inventory and alerts

### 7.1 Stock
- Stock is kept in each item's own unit (pcs, dzn or kg).
- Every change is a movement: opening, sale, purchase, count. Stock after each movement is recorded.
- Sales deduct stock on save (confident match or confirmed line).
- **Count** sets stock to the physical count and records the difference.
- **Receive** adds purchased stock and can update the buy rate.

### 7.2 Covers baseline
- "Covers" = active pcs or dozen items whose name contains "cover". Dozens count as 12 pcs. Kg items are excluded.
- Baseline: **95,000 pcs** total. Restock quantity: **5,000 pcs**.
- Alert **COVER_BASELINE** opens when total is below baseline. It names the item that is lowest relative to its last count (stock ÷ last count), with its stock and last count.
- Current data: covers total **38,526 pcs** (54 cover items), so the alert opens on first run.
- Alerts are re-checked after every change. They close automatically when the condition clears. Staff can mark them as seen.
- Also: ITEM_REORDER (per item reorder point, optional) and NEGATIVE_STOCK.

### 7.3 Manual stock for now
Stock counts and sold-item records are still kept by hand in the owner's register. The backend is the digital record going forward. Deduction is on for every saved bill. Manual counts can be entered through the API or added to the screen in a later version.

---

## 8. Data model (SQLite)

- `items`: id, hs_code, name, unit (pcs/dzn/kg), buy_rate, sell_rate, stock, last_count, reorder_point, active, source_particulars, source_qty
- `settings`: key, value (VAT %, band low/high, cover baseline, restock quantity)
- `bills`: id, bill_no, created_at, created_by, gross_total, vat_pct, taxable_base, vat_amount, lines_total, variance, status, note
- `bill_lines`: id, bill_id, line_no, description, sale_unit, qty, unit_rate, subtotal, item_id, match_method, confirmed, buy_rate, margin_pct, margin_status, stock_delta, suggestions (JSON)
- `movements`: id, item_id, delta, stock_after, reason, ref, note, created_at
- `alerts`: id, code, key, severity, message, item_id, created_at, acknowledged_at, resolved_at

---

## 9. API (all under `/api`)

| Method | Path | Purpose |
|---|---|---|
| GET | /health | Status and item count |
| GET | /items?q=&unit=&limit= | Search items, with band limits |
| GET | /items/{id} | One item |
| POST | /items | Add an item |
| PATCH | /items/{id} | Change sell rate, buy rate, reorder point, active |
| POST | /items/{id}/count | Set physical count |
| POST | /items/{id}/receive | Add purchased stock |
| POST | /match | Suggest items for a description and rate |
| POST | /bills | Save a bill (201) |
| GET | /bills?limit= | Bill list |
| GET | /bills/{id} | One bill with lines |
| POST | /bills/{id}/lines/{n}/confirm | Match a pending line to an item |
| GET | /alerts | Open alerts |
| POST | /alerts/{id}/ack | Mark alert as seen |
| GET | /inventory/summary | Covers total, baseline, lowest items |
| GET / PUT | /settings | VAT, band, covers baseline and restock quantity |

If the environment variable `API_KEY` is set, every `/api` call needs the header `X-API-Key`.

The backend also serves the web app at `/`, so the phone and laptop use the same address and there are no cross-origin issues.

---

## 10. Architecture

- Backend: Python 3.10+, FastAPI, SQLite (one file: `backend/data/app.db`), one writer at a time.
- Rules are pure functions in `app/engine.py`. Database services in `app/db.py`. HTTP in `app/main.py`.
- Web app: plain HTML, CSS and JavaScript, no framework, no external downloads. Files: `solver.js` (pure rules), `calc.js` (calculator screen), `bill.js` (backend link), `index.html`, `style.css`.
- Layout: one column on phones (16 px gutter, 16 px+ inputs so iOS does not zoom), two columns from 900 px wide.
- Offline: the calculator runs with no backend. Saving is disabled and the screen says bills are not saved.

---

## 11. Setup, run and test (Windows)

**Requirements:** Python 3.10+ and Node.js 18+ (Node is only needed for the optional web tests).

1. Open a terminal in the `backend` folder.
2. Create and activate a virtual environment:
   ```
   py -m venv .venv
   .venv\Scripts\activate
   ```
3. Install packages:
   ```
   pip install -r requirements.txt
   ```
4. Run the backend (first run creates `data\app.db` and loads the 99 items):
   ```
   uvicorn app.main:app --host 0.0.0.0 --port 8000
   ```
5. On the laptop, open **http://localhost:8000**.
6. On the iPhone (same Wi-Fi), open **http://<laptop-IP>:8000**. Find the laptop IP with `ipconfig` (IPv4 address). Windows Firewall may ask to allow Python on private networks; allow it.
7. Optional, for hosted use: set `API_KEY` before starting, and set the same key in the page under **Backend settings**.
8. Optional, to keep the database somewhere else: set `DB_PATH` to a full path before starting.

**Backups:** copy `backend\data\app.db` to a safe folder at the end of each day. The whole system is that one file.

**Tests:**
- Backend (23 tests): `python -m pytest -q` from the `backend` folder.
- Web (optional, needs Node and `npm install jsdom@24.1.0` in `web-tests`):
  - `node --test solver.test.js` (11 rule tests)
  - `node smoke.js` (13 calculator checks, offline)
  - `node online.js` (10 checks against a running backend on port 8000)

**Results at this version:** backend 23/23, rules 11/11, offline calculator 13/13, online flow 10/10 (search, band warning, save, matching review, stock deduction, reset). Layout checked in headless Chromium at 390 px and 1366 px: no horizontal scroll, no page errors. **Not yet tested on a real iPhone or Safari.**

---

## 12. Hosting (decision pending)

Requirement: the system must not pause when the shop is quiet, including 7 to 8 day festival gaps.

| Option | Pauses when idle? | Cost | Notes |
|---|---|---|---|
| Laptop on shop Wi-Fi (today) | No, while the laptop is on | Free | Only reachable on the shop network. Laptop must stay on. |
| Small always-on VPS (paid) | No | Fixed monthly fee | Simplest move from the current code. Needs HTTPS and a domain. |
| Free tiers that sleep on idle (e.g., many free web-app hosts) | **Yes** | Free | Not suitable for this requirement. |
| Cloudflare Workers + D1 | No sleep; billed per request with free daily limits | Free to low | Needs a rewrite of the backend from Python to JavaScript/TypeScript and D1 instead of SQLite. Best long-term fit. |
| Free VM tiers (e.g., Oracle Always Free) | Can be reclaimed when idle for long periods | Free | Read the current idle-reclaim terms before relying on it. |

Terms and free-tier limits change. Verify the current rules before committing to any option. Next step is to choose between the paid VPS (fastest) and a Cloudflare port (free, more work), then move `app.db` with a backup.

---

## 13. Open questions for the owner

1. **Extra tax formula above the 7% band.** Assumed: 13% of profit above the band. Needs confirmation with the accountant.
2. **"Most low" covers item.** Assumed: lowest stock ÷ last count. Alternative: lowest absolute stock.
3. **Covers scope.** Assumed: all pcs and dozen items with "cover" in the name; kg excluded.
4. **95,000 baseline.** Assumed: one group total. Alternative: per item.
5. **Zero variance on pcs.** At 2 dp rates a whole count rarely gives exact zero against the base. Options: (a) accept a few paisa of difference, (b) rate with more decimals, (c) make the last line of a bill absorb the difference. Current build shows the difference and allows saving.
6. **OVER_TAX share.** 55 of 99 items have a buy rate that puts the max sell above 7%. Please check the buy rates in the stock summary before relying on the band warning.
7. **LOSS items.** Two items are below 5%: Mobile Cover #2750 (sold at 2,409 vs buy 2,750) and Chipku #4 (0%). Confirm these prices.
8. **Duplicate names.** Several items share a name with different buy rates (mobile covers at 53, 60, 64 and 80; screen protectors at 25; temper glass at 36). Matching uses the rate to tell them apart, but the names should be made unique.
9. **Covers already below baseline.** The alert is open from day one (38,526 vs 95,000). Confirm the opening count is right.
10. **Staff login.** Not built. Staff name is free text on each bill.

---

## 14. Not in this version

- Digital inventory counts and receiving from the screen (manual for now; API exists).
- Editing or cancelling a saved bill.
- Printing bills or invoices.
- Reports (daily sales, margin by item, tax summary).
- Staff accounts and roles.
- LLM-based matching.
- Cloud hosting (decision pending, see section 12).

---

## 15. Changelog

- **v3 (this version):** Bill recording with lines, statuses and matching review. Stock deduction on save. Covers baseline alert. Multi-line bills with balance. Calculator rebuilt: Reset works, Pcs flow simplified, kg rate-adjust switch, dozen half buttons. Backend serves the web app. Tests added.
- **v2:** Single-screen calculator with unit switch and candidate counts. Pcs and dozen never rounded; kg absorbs quantity.
- **v1:** Unified PRD: reverse VAT, Pcs/Kg/Dozen modes, responsive layout.
