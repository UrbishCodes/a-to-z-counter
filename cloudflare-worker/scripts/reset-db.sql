-- Reset the live D1 database to its pristine seeded state.
--
-- Use it after a test run against production: it drops the bills, lines and
-- stock movements created by the run, removes the items the run created, and
-- restores every seeded item's stock to the quantity it was seeded with.
--
--   npx wrangler d1 execute a-to-z-counter --remote --file scripts/reset-db.sql
--
-- Seeded rows always carry items.source_qty (the quantity from the stock PDF),
-- and the API can never set or clear it: POST /api/items leaves it null and
-- PATCH only touches sell_rate, buy_rate, reorder_point and active. So
-- "source_qty IS NULL" identifies the items a test run created, and
-- "source_qty IS NOT NULL" identifies the seeded ones.

DELETE FROM bill_lines;
DELETE FROM movements;
DELETE FROM bills;
DELETE FROM alerts;

-- Items created through the API after the seed was applied.
DELETE FROM items WHERE source_qty IS NULL;

-- Stock back to the seeded quantity.
UPDATE items SET stock = source_qty, last_count = source_qty WHERE source_qty IS NOT NULL;

-- Let the next bill start at BL-000001 and the next item at id 100 again.
DELETE FROM sqlite_sequence WHERE name IN ('bills', 'bill_lines', 'movements', 'alerts', 'items');
