// Regenerate migrations/0002_seed.sql from the canonical 99-item CSV.
// Run: node scripts/generate-seed.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const csvPath = path.join(__dirname, '..', '..', 'backend', 'data', 'items_seed.csv');
const outPath = path.join(__dirname, '..', 'migrations', '0002_seed.sql');

const text = fs.readFileSync(csvPath, 'utf8');
const lines = text.split(/\r?\n/).filter((line) => line.trim().length > 0);
const [header, ...rows] = lines;
const cols = header.split(',');
const items = rows.map((line) => {
  const values = line.split(',');
  const row = {};
  cols.forEach((col, i) => { row[col] = values[i] ?? ''; });
  return row;
});

if (items.length !== 99) {
  throw new Error(`expected 99 seed items, found ${items.length}`);
}

const coversTotal = items
  .filter((r) => r.name.toLowerCase().includes('cover') && (r.unit === 'pcs' || r.unit === 'doz'))
  .reduce((sum, r) => sum + Number(r.stock) * (r.unit === 'doz' ? 12 : 1), 0);
if (Math.abs(coversTotal - 38526.04) > 0.001) {
  throw new Error(`covers total drift: ${coversTotal}`);
}

const sql = (value) => `'${String(value).replaceAll("'", "''")}'`;
const num = (value) => (value === '' || value === undefined || value === null ? 'NULL' : Number(value));

const out = [];
out.push('-- Seed: 99 items from backend/data/items_seed.csv (source: "new a to z .pdf" stock summary).');
out.push('-- Regenerate with: node scripts/generate-seed.mjs');
items.forEach((row, i) => {
  const id = i + 1;
  out.push(
    `INSERT OR IGNORE INTO items(id, hs_code, name, unit, buy_rate, sell_rate, stock, last_count, reorder_point, active, source_particulars, source_qty) VALUES (${id}, ${sql(row.hs_code)}, ${sql(row.name)}, ${sql(row.unit)}, ${num(row.buy_rate)}, ${num(row.sell_rate)}, ${num(row.stock)}, ${num(row.last_count)}, ${num(row.reorder_point)}, ${Number(row.active)}, ${sql(row.source_particulars)}, ${num(row.source_qty)});`,
  );
});
out.push('');
out.push("INSERT OR IGNORE INTO settings(key, value) VALUES ('vat_pct', '13'), ('band_low_pct', '5'), ('band_high_pct', '7'), ('cover_baseline', '95000'), ('restock_qty', '5000');");
out.push('');
fs.writeFileSync(outPath, out.join('\n'), 'utf8');
console.log(`wrote ${outPath} with ${items.length} items (covers ${coversTotal} pcs)`);
