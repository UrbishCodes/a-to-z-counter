-- Counter app schema for Cloudflare D1 (port of backend/app/db.py SCHEMA).
CREATE TABLE IF NOT EXISTS items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    hs_code TEXT NOT NULL DEFAULT '',
    name TEXT NOT NULL,
    unit TEXT NOT NULL CHECK (unit IN ('pcs','doz','kg')),
    buy_rate REAL,
    sell_rate REAL NOT NULL,
    stock REAL NOT NULL DEFAULT 0,
    last_count REAL,
    reorder_point REAL,
    active INTEGER NOT NULL DEFAULT 1,
    source_particulars TEXT NOT NULL DEFAULT '',
    source_qty REAL
);
CREATE INDEX IF NOT EXISTS idx_items_name ON items(name);

CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS bills (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    bill_no TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    created_by TEXT NOT NULL DEFAULT '',
    gross_total REAL NOT NULL,
    vat_pct REAL NOT NULL,
    taxable_base REAL NOT NULL,
    vat_amount REAL NOT NULL,
    lines_total REAL NOT NULL,
    variance REAL NOT NULL,
    status TEXT NOT NULL,
    note TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS bill_lines (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    bill_id INTEGER NOT NULL REFERENCES bills(id) ON DELETE CASCADE,
    line_no INTEGER NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    sale_unit TEXT NOT NULL CHECK (sale_unit IN ('pcs','doz','kg')),
    qty REAL NOT NULL,
    unit_rate REAL NOT NULL,
    subtotal REAL NOT NULL,
    item_id INTEGER REFERENCES items(id),
    match_method TEXT NOT NULL DEFAULT '',
    confirmed INTEGER NOT NULL DEFAULT 0,
    buy_rate REAL,
    margin_pct REAL,
    margin_status TEXT,
    stock_delta REAL NOT NULL DEFAULT 0,
    suggestions TEXT NOT NULL DEFAULT '[]',
    UNIQUE (bill_id, line_no)
);

CREATE TABLE IF NOT EXISTS movements (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    item_id INTEGER NOT NULL REFERENCES items(id),
    delta REAL NOT NULL,
    stock_after REAL NOT NULL,
    reason TEXT NOT NULL,
    ref TEXT NOT NULL DEFAULT '',
    note TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS alerts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    code TEXT NOT NULL,
    key TEXT NOT NULL,
    severity TEXT NOT NULL DEFAULT 'high',
    message TEXT NOT NULL,
    item_id INTEGER REFERENCES items(id),
    created_at TEXT NOT NULL,
    acknowledged_at TEXT,
    resolved_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_alerts_open ON alerts(code, key, resolved_at);
