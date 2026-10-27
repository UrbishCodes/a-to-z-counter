-- Reset the live D1 database to its pristine seeded state.
--
-- Use it after a test run against production: it drops the bills, lines and
-- stock movements created by the run, restores every item's stock to the
-- quantity it was seeded with (items.source_qty mirrors the seeded stock), and
-- clears the alerts so the next alert refresh recreates them from scratch.
--
--   npx wrangler d1 execute a-to-z-counter --remote --file scripts/reset-db.sql
--
-- The item list itself is never touched, so ids, rates and names stay stable.

DELETE FROM bill_lines;
DELETE FROM movements;
DELETE FROM bills;
DELETE FROM alerts;

UPDATE items SET stock = source_qty, last_count = source_qty;

-- Let the next bill start at BL-000001 again.
DELETE FROM sqlite_sequence WHERE name IN ('bills', 'bill_lines', 'movements', 'alerts');
