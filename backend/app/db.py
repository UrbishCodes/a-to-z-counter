"""SQLite persistence, seeding and services for the counter app."""
from __future__ import annotations

import csv
import json
import os
import sqlite3
import threading
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable, Optional

from . import engine

BASE_DIR = Path(__file__).resolve().parent.parent
DATA_DIR = BASE_DIR / "data"
DEFAULT_DB_PATH = DATA_DIR / "app.db"
SEED_PATH = DATA_DIR / "items_seed.csv"
WEB_DIR = BASE_DIR.parent / "web"

DEFAULT_SETTINGS = {
    "vat_pct": 13.0,
    "band_low_pct": 5.0,
    "band_high_pct": 7.0,
    "cover_baseline": 95000,
    "restock_qty": 5000,
}

_lock = threading.RLock()
_conn: Optional[sqlite3.Connection] = None
_db_path: Optional[Path] = None

SCHEMA = """
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
"""


def now_iso() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


@contextmanager
def _tx():
    with _lock:
        conn = _require_conn()
        try:
            yield conn
            conn.commit()
        except Exception:
            conn.rollback()
            raise


def _require_conn() -> sqlite3.Connection:
    if _conn is None:
        raise RuntimeError("database is not configured")
    return _conn


def configure(path: str | Path | None = None) -> None:
    """Open (and seed) a database file. Tests call this with a temp path."""
    global _conn, _db_path
    if path is None:
        path = os.environ.get("DB_PATH") or DEFAULT_DB_PATH
    _db_path = Path(path).expanduser().resolve()
    _db_path.parent.mkdir(parents=True, exist_ok=True)
    if _conn is not None:
        _conn.close()
        _conn = None
    _conn = sqlite3.connect(str(_db_path), check_same_thread=False)
    _conn.row_factory = sqlite3.Row
    _conn.execute("PRAGMA foreign_keys=ON")
    _conn.execute("PRAGMA journal_mode=WAL")
    _conn.execute("PRAGMA synchronous=NORMAL")
    init_db()


def ensure_ready() -> None:
    if _conn is None:
        configure()
    else:
        init_db()


def reset_db(path: str | Path | None = None) -> None:
    """Delete and recreate the configured database (tests / clean start)."""
    global _conn
    target = Path(path).expanduser().resolve() if path else _db_path
    if target is None:
        target = Path(os.environ.get("DB_PATH") or DEFAULT_DB_PATH).expanduser().resolve()
    if _conn is not None:
        _conn.close()
        _conn = None
    for suffix in ("", "-wal", "-shm"):
        try:
            Path(str(target) + suffix).unlink()
        except FileNotFoundError:
            pass
    configure(target)


def db_path() -> Optional[Path]:
    return _db_path


def init_db() -> None:
    with _lock:
        conn = _require_conn()
        conn.executescript(SCHEMA)
        if conn.execute("SELECT COUNT(*) AS n FROM items").fetchone()["n"] == 0:
            _seed_items(conn)
        for key, value in DEFAULT_SETTINGS.items():
            conn.execute("INSERT OR IGNORE INTO settings(key, value) VALUES (?, ?)", (key, str(value)))
        conn.commit()


def _seed_items(conn: sqlite3.Connection) -> None:
    if not SEED_PATH.exists():
        raise RuntimeError(f"seed file not found: {SEED_PATH}")
    rows = list(csv.DictReader(SEED_PATH.open(encoding="utf-8")))
    if len(rows) != 99:
        raise RuntimeError(f"expected 99 seed items, found {len(rows)}")
    for row in rows:
        buy = row["buy_rate"].strip()
        conn.execute(
            """INSERT INTO items(hs_code,name,unit,buy_rate,sell_rate,stock,last_count,
                                 reorder_point,active,source_particulars,source_qty)
               VALUES (?,?,?,?,?,?,?,?,?,?,?)""",
            (
                row["hs_code"].strip(),
                row["name"].strip(),
                row["unit"].strip(),
                float(buy) if buy else None,
                float(row["sell_rate"]),
                float(row["stock"]),
                float(row["last_count"]) if row["last_count"].strip() else None,
                float(row["reorder_point"]) if row["reorder_point"].strip() else None,
                1 if row["active"].strip() in ("1", "true", "True") else 0,
                row["source_particulars"].strip(),
                float(row["source_qty"]) if row["source_qty"].strip() else None,
            ),
        )


# ---------------------------------------------------------------- serializers


def _item(row: sqlite3.Row) -> dict[str, Any]:
    return {
        "id": row["id"],
        "hs_code": row["hs_code"] or "",
        "name": row["name"],
        "unit": row["unit"],
        "buy_rate": None if row["buy_rate"] is None else float(row["buy_rate"]),
        "sell_rate": float(row["sell_rate"]),
        "stock": float(row["stock"]),
        "last_count": None if row["last_count"] is None else float(row["last_count"]),
        "reorder_point": None if row["reorder_point"] is None else float(row["reorder_point"]),
        "active": bool(row["active"]),
        "source_particulars": row["source_particulars"] or "",
        "source_qty": None if row["source_qty"] is None else float(row["source_qty"]),
    }


def _alert(row: sqlite3.Row) -> dict[str, Any]:
    return {
        "id": row["id"],
        "code": row["code"],
        "key": row["key"],
        "severity": row["severity"],
        "message": row["message"],
        "item_id": row["item_id"],
        "created_at": row["created_at"],
        "acknowledged_at": row["acknowledged_at"],
        "resolved_at": row["resolved_at"],
    }


def _line(row: sqlite3.Row) -> dict[str, Any]:
    try:
        suggestions = json.loads(row["suggestions"] or "[]")
    except json.JSONDecodeError:
        suggestions = []
    return {
        "id": row["id"],
        "line_no": row["line_no"],
        "description": row["description"],
        "sale_unit": row["sale_unit"],
        "qty": float(row["qty"]),
        "unit_rate": float(row["unit_rate"]),
        "subtotal": float(row["subtotal"]),
        "item_id": row["item_id"],
        "match_method": row["match_method"] or "",
        "confirmed": bool(row["confirmed"]),
        "buy_rate": None if row["buy_rate"] is None else float(row["buy_rate"]),
        "margin_pct": None if row["margin_pct"] is None else float(row["margin_pct"]),
        "margin_status": row["margin_status"],
        "stock_delta": float(row["stock_delta"]),
        "suggestions": suggestions,
    }


def _bill(row: sqlite3.Row, lines: Iterable[sqlite3.Row]) -> dict[str, Any]:
    return {
        "id": row["id"],
        "bill_no": row["bill_no"],
        "created_at": row["created_at"],
        "created_by": row["created_by"] or "",
        "gross_total": float(row["gross_total"]),
        "vat_pct": float(row["vat_pct"]),
        "taxable_base": float(row["taxable_base"]),
        "vat_amount": float(row["vat_amount"]),
        "lines_total": float(row["lines_total"]),
        "variance": float(row["variance"]),
        "status": row["status"],
        "note": row["note"] or "",
        "lines": [_line(line) for line in lines],
    }


# ---------------------------------------------------------------- settings/items


def get_settings() -> dict[str, Any]:
    with _lock:
        rows = _require_conn().execute("SELECT key, value FROM settings").fetchall()
        values = {row["key"]: row["value"] for row in rows}
    def number(key: str, kind: type = float):
        try:
            return kind(float(values.get(key, DEFAULT_SETTINGS[key])))
        except (TypeError, ValueError):
            return DEFAULT_SETTINGS[key]
    return {
        "vat_pct": number("vat_pct", float),
        "band_low_pct": number("band_low_pct", float),
        "band_high_pct": number("band_high_pct", float),
        "cover_baseline": number("cover_baseline", int),
        "restock_qty": number("restock_qty", int),
    }


def update_settings(data: dict[str, Any]) -> dict[str, Any]:
    allowed = {"vat_pct", "band_low_pct", "band_high_pct", "cover_baseline", "restock_qty"}
    updates = {k: v for k, v in data.items() if k in allowed and v is not None}
    if not updates:
        return get_settings()
    current = get_settings()
    merged = {**current, **updates}
    if float(merged["band_low_pct"]) >= float(merged["band_high_pct"]):
        raise ValueError("band_low_pct must be lower than band_high_pct")
    if float(merged["vat_pct"]) < 0:
        raise ValueError("vat_pct cannot be negative")
    if int(merged["cover_baseline"]) < 0 or int(merged["restock_qty"]) < 0:
        raise ValueError("cover baseline and restock quantity cannot be negative")
    with _tx() as conn:
        for key, value in updates.items():
            if key in ("cover_baseline", "restock_qty"):
                value = int(float(value))
            else:
                value = round(float(value), 2)
            conn.execute("INSERT INTO settings(key, value) VALUES (?, ?) "
                         "ON CONFLICT(key) DO UPDATE SET value=excluded.value", (key, str(value)))
    refresh_alerts()
    return get_settings()


def item_count() -> int:
    with _lock:
        row = _require_conn().execute("SELECT COUNT(*) AS n FROM items WHERE active=1").fetchone()
        return int(row["n"])


def all_items(active_only: bool = True) -> list[dict[str, Any]]:
    with _lock:
        sql = "SELECT * FROM items" + (" WHERE active=1" if active_only else "") + " ORDER BY name, sell_rate, id"
        return [_item(row) for row in _require_conn().execute(sql).fetchall()]


def list_items(q: str = "", unit: str | None = None, limit: int = 50) -> list[dict[str, Any]]:
    items = all_items(active_only=True)
    if unit:
        items = [item for item in items if engine.compatible(unit, item["unit"])]
    if q and q.strip():
        items = [item for item in items
                 if engine.search_match(q, item["name"], item["source_particulars"])]
    safe_limit = max(1, min(int(limit or 50), 200))
    return items[:safe_limit]


def get_item(item_id: int) -> Optional[dict[str, Any]]:
    with _lock:
        row = _require_conn().execute("SELECT * FROM items WHERE id=?", (item_id,)).fetchone()
        return _item(row) if row else None


def create_item(data: dict[str, Any]) -> dict[str, Any]:
    name = str(data.get("name") or "").strip()
    unit = str(data.get("unit") or "")
    if not name:
        raise ValueError("name is required")
    if not engine.valid_unit(unit):
        raise ValueError("unit must be pcs, doz or kg")
    try:
        sell = float(data.get("sell_rate"))
    except (TypeError, ValueError):
        raise ValueError("sell_rate must be a number")
    if sell <= 0:
        raise ValueError("sell_rate must be greater than 0")
    buy = data.get("buy_rate")
    if buy is not None:
        buy = float(buy)
        if buy < 0:
            raise ValueError("buy_rate cannot be negative")
    stock = float(data.get("stock") or 0)
    if stock < 0:
        raise ValueError("stock cannot be negative")
    last = data.get("last_count")
    last = stock if last is None else float(last)
    reorder = data.get("reorder_point")
    reorder = None if reorder is None else float(reorder)
    active = 1 if data.get("active", True) else 0
    with _tx() as conn:
        cur = conn.execute(
            """INSERT INTO items(hs_code,name,unit,buy_rate,sell_rate,stock,last_count,
                                 reorder_point,active,source_particulars,source_qty)
               VALUES (?,?,?,?,?,?,?,?,?,?,?)""",
            (str(data.get("hs_code") or ""), name, unit, buy, sell, stock, last, reorder, active,
             str(data.get("source_particulars") or name), data.get("source_qty")),
        )
        item_id = cur.lastrowid
    refresh_alerts()
    return get_item(item_id)


def update_item(item_id: int, data: dict[str, Any]) -> Optional[dict[str, Any]]:
    """Correct an item; same contract as the Worker's updateItem.

    Used by the counter (rates, reorder point, active) and by the data sheet,
    which can fix anything that came out of the stock PDF. A stock change is
    written as a movement so the correction stays auditable.
    """
    item = get_item(item_id)
    if not item:
        return None
    updates: dict[str, Any] = {}
    if "name" in data:
        name = str(data["name"] or "").strip()
        if not name:
            raise ValueError("name cannot be empty")
        updates["name"] = name
    if "hs_code" in data:
        updates["hs_code"] = str(data["hs_code"] or "").strip()
    if "unit" in data:
        unit = str(data["unit"])
        if unit not in ("pcs", "doz", "kg"):
            raise ValueError("unit must be pcs, doz or kg")
        updates["unit"] = unit
    if "sell_rate" in data:
        sell = float(data["sell_rate"])
        if sell <= 0:
            raise ValueError("sell_rate must be greater than 0")
        updates["sell_rate"] = sell
    if "buy_rate" in data:
        buy = None if data["buy_rate"] is None else float(data["buy_rate"])
        if buy is not None and buy < 0:
            raise ValueError("buy_rate cannot be negative")
        updates["buy_rate"] = buy
    if "stock" in data:
        stock = float(data["stock"])
        if stock < 0:
            raise ValueError("stock cannot be negative")
        updates["stock"] = stock
    if "last_count" in data:
        last = None if data["last_count"] is None else float(data["last_count"])
        if last is not None and last < 0:
            raise ValueError("last_count cannot be negative")
        updates["last_count"] = last
    if "reorder_point" in data:
        point = None if data["reorder_point"] is None else float(data["reorder_point"])
        if point is not None and point < 0:
            raise ValueError("reorder_point cannot be negative")
        updates["reorder_point"] = point
    if "active" in data:
        updates["active"] = 1 if data["active"] else 0
    if not updates:
        return item
    sets = ", ".join(f"{key}=?" for key in updates)
    values = list(updates.values()) + [item_id]
    delta = updates["stock"] - item["stock"] if "stock" in updates else 0.0
    with _tx() as conn:
        conn.execute(f"UPDATE items SET {sets} WHERE id=?", values)
        if delta:
            _movement(conn, item_id, delta, updates["stock"], "correction", "data sheet",
                      "quantity corrected")
    refresh_alerts()
    return get_item(item_id)


def _movement(conn: sqlite3.Connection, item_id: int, delta: float, stock_after: float,
              reason: str, ref: str = "", note: str = "") -> None:
    conn.execute(
        "INSERT INTO movements(item_id,delta,stock_after,reason,ref,note,created_at) "
        "VALUES (?,?,?,?,?,?,?)",
        (item_id, delta, stock_after, reason, ref, note, now_iso()),
    )


def set_count(item_id: int, count: float) -> Optional[dict[str, Any]]:
    item = get_item(item_id)
    if not item:
        return None
    count = float(count)
    if count < 0:
        raise ValueError("count cannot be negative")
    delta = count - item["stock"]
    with _tx() as conn:
        conn.execute("UPDATE items SET stock=?, last_count=? WHERE id=?", (count, count, item_id))
        _movement(conn, item_id, delta, count, "count", "manual", "physical count")
    refresh_alerts()
    return get_item(item_id)


def receive_item(item_id: int, qty: float, buy_rate: float | None = None) -> Optional[dict[str, Any]]:
    item = get_item(item_id)
    if not item:
        return None
    qty = float(qty)
    if qty <= 0:
        raise ValueError("qty must be greater than 0")
    new_stock = item["stock"] + qty
    with _tx() as conn:
        if buy_rate is None:
            conn.execute("UPDATE items SET stock=? WHERE id=?", (new_stock, item_id))
        else:
            conn.execute("UPDATE items SET stock=?, buy_rate=? WHERE id=?",
                         (new_stock, float(buy_rate), item_id))
        _movement(conn, item_id, qty, new_stock, "purchase", "manual", "stock received")
    refresh_alerts()
    return get_item(item_id)


# ---------------------------------------------------------------- bills


def get_bill(bill_id: int) -> Optional[dict[str, Any]]:
    with _lock:
        conn = _require_conn()
        row = conn.execute("SELECT * FROM bills WHERE id=?", (bill_id,)).fetchone()
        if not row:
            return None
        lines = conn.execute("SELECT * FROM bill_lines WHERE bill_id=? ORDER BY line_no", (bill_id,)).fetchall()
        return _bill(row, lines)


def list_bills(limit: int = 50) -> list[dict[str, Any]]:
    safe_limit = max(1, min(int(limit or 50), 200))
    with _lock:
        rows = _require_conn().execute("SELECT id FROM bills ORDER BY id DESC LIMIT ?", (safe_limit,)).fetchall()
    return [get_bill(row["id"]) for row in rows]


def _build_lines(raw_lines: list[dict[str, Any]], items: list[dict[str, Any]],
                 low_pct: float, high_pct: float) -> list[dict[str, Any]]:
    by_id = {item["id"]: item for item in items}
    built: list[dict[str, Any]] = []
    for index, raw in enumerate(raw_lines, start=1):
        sale_unit = str(raw.get("sale_unit") or "")
        if not engine.valid_unit(sale_unit):
            raise ValueError(f"line {index}: sale_unit must be pcs, doz or kg")
        try:
            qty = float(raw.get("qty"))
            rate = float(raw.get("unit_rate"))
        except (TypeError, ValueError):
            raise ValueError(f"line {index}: qty and unit_rate must be numbers")
        if not engine.valid_count(sale_unit, qty):
            raise ValueError(f"line {index}: invalid count for {sale_unit}")
        if rate <= 0:
            raise ValueError(f"line {index}: unit_rate must be greater than 0")
        item_id = raw.get("item_id")
        item = by_id.get(item_id) if item_id else None
        if item_id and not item:
            raise ValueError(f"line {index}: item not found or inactive")
        if item and not engine.compatible(sale_unit, item["unit"]):
            raise ValueError(f"line {index}: item cannot be sold in {sale_unit}")
        description = str(raw.get("description") or "").strip()
        if item and not description:
            description = item["name"]
        if item:
            confirmed = True
            match_method = "chosen"
            suggestions: list[dict[str, Any]] = []
        else:
            match = engine.match_items(description, rate, sale_unit, items, low_pct, high_pct)
            if match["confident"]:
                item = match["item"]
                confirmed = True
                match_method = match["method"]
                suggestions = []
            else:
                confirmed = False
                match_method = match["method"]
                suggestions = match["suggestions"]
        margin = engine.margin_for_line(item, sale_unit, rate, low_pct, high_pct) if item else {
            "buy_rate": None, "margin_pct": None, "margin_status": "UNKNOWN_COST"}
        stock_delta = 0.0
        if item and confirmed:
            qty_item = engine.convert_qty(qty, sale_unit, item["unit"])
            if qty_item is None:
                raise ValueError(f"line {index}: cannot convert {sale_unit} to {item['unit']}")
            stock_delta = -qty_item
        built.append({
            "line_no": index,
            "description": description or "Item",
            "sale_unit": sale_unit,
            "qty": qty,
            "unit_rate": rate,
            "subtotal": engine.line_subtotal(qty, rate),
            "item": item,
            "item_id": item["id"] if item else None,
            "match_method": match_method,
            "confirmed": confirmed,
            "buy_rate": margin["buy_rate"],
            "margin_pct": margin["margin_pct"],
            "margin_status": margin["margin_status"],
            "stock_delta": stock_delta,
            "suggestions": suggestions,
        })
    return built


def save_bill(data: dict[str, Any]) -> dict[str, Any]:
    try:
        gross = float(data.get("gross_total"))
    except (TypeError, ValueError):
        raise ValueError("gross_total must be a number")
    if gross <= 0:
        raise ValueError("gross_total must be greater than 0")
    try:
        vat = float(data.get("vat_pct"))
    except (TypeError, ValueError):
        raise ValueError("vat_pct must be a number")
    if vat < 0:
        raise ValueError("vat_pct cannot be negative")
    raw_lines = data.get("lines") or []
    if not isinstance(raw_lines, list) or not raw_lines:
        raise ValueError("at least one line is required")
    settings = get_settings()
    items = all_items(active_only=True)
    lines = _build_lines(raw_lines, items, settings["band_low_pct"], settings["band_high_pct"])
    totals = engine.bill_totals(lines, gross, vat)
    status = engine.bill_status(lines)
    created = now_iso()
    with _tx() as conn:
        cur = conn.execute(
            """INSERT INTO bills(bill_no,created_at,created_by,gross_total,vat_pct,taxable_base,
                                 vat_amount,lines_total,variance,status,note)
               VALUES ('',?,?,?,?,?,?,?,?,?,?)""",
            (created, str(data.get("created_by") or ""), gross, vat, totals["taxable_base"],
             totals["vat_amount"], totals["lines_total"], totals["variance"], status,
             str(data.get("note") or "")),
        )
        bill_id = int(cur.lastrowid)
        bill_no = f"BL-{bill_id:06d}"
        conn.execute("UPDATE bills SET bill_no=? WHERE id=?", (bill_no, bill_id))
        for line in lines:
            conn.execute(
                """INSERT INTO bill_lines(bill_id,line_no,description,sale_unit,qty,unit_rate,
                       subtotal,item_id,match_method,confirmed,buy_rate,margin_pct,margin_status,
                       stock_delta,suggestions)
                   VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
                (bill_id, line["line_no"], line["description"], line["sale_unit"], line["qty"],
                 line["unit_rate"], line["subtotal"], line["item_id"], line["match_method"],
                 1 if line["confirmed"] else 0, line["buy_rate"], line["margin_pct"],
                 line["margin_status"], line["stock_delta"],
                 json.dumps(line["suggestions"], ensure_ascii=False)),
            )
            if line["confirmed"] and line["item_id"]:
                row = conn.execute("SELECT stock FROM items WHERE id=?", (line["item_id"],)).fetchone()
                if row is None:
                    raise ValueError("item disappeared during save")
                new_stock = float(row["stock"]) + float(line["stock_delta"])
                conn.execute("UPDATE items SET stock=? WHERE id=?", (new_stock, line["item_id"]))
                _movement(conn, line["item_id"], line["stock_delta"], new_stock, "sale",
                          bill_no, line["description"])
    refresh_alerts()
    return get_bill(bill_id)


def confirm_line(bill_id: int, line_no: int, item_id: int) -> Optional[dict[str, Any]]:
    bill = get_bill(bill_id)
    if not bill:
        return None
    line_row = next((line for line in bill["lines"] if line["line_no"] == line_no), None)
    if not line_row:
        raise ValueError("line not found")
    if line_row["confirmed"]:
        if line_row["item_id"] == item_id:
            return bill
        raise ValueError("line is already confirmed")
    item = get_item(item_id)
    if not item or not item["active"]:
        raise ValueError("item not found or inactive")
    if not engine.compatible(line_row["sale_unit"], item["unit"]):
        raise ValueError("item cannot be sold in this unit")
    qty_item = engine.convert_qty(line_row["qty"], line_row["sale_unit"], item["unit"])
    if qty_item is None:
        raise ValueError("cannot convert the line count to the item unit")
    settings = get_settings()
    margin = engine.margin_for_line(item, line_row["sale_unit"], line_row["unit_rate"],
                                    settings["band_low_pct"], settings["band_high_pct"])
    stock_delta = -qty_item
    with _tx() as conn:
        conn.execute(
            """UPDATE bill_lines SET item_id=?, match_method='manual', confirmed=1,
                   buy_rate=?, margin_pct=?, margin_status=?, stock_delta=?, suggestions='[]'
               WHERE bill_id=? AND line_no=?""",
            (item_id, margin["buy_rate"], margin["margin_pct"], margin["margin_status"],
             stock_delta, bill_id, line_no),
        )
        row = conn.execute("SELECT stock FROM items WHERE id=?", (item_id,)).fetchone()
        new_stock = float(row["stock"]) + stock_delta
        conn.execute("UPDATE items SET stock=? WHERE id=?", (new_stock, item_id))
        _movement(conn, item_id, stock_delta, new_stock, "sale", bill["bill_no"], line_row["description"])
        open_count = conn.execute(
            "SELECT COUNT(*) AS n FROM bill_lines WHERE bill_id=? AND confirmed=0", (bill_id,)
        ).fetchone()["n"]
        new_status = "complete" if open_count == 0 else "needs_review"
        conn.execute("UPDATE bills SET status=? WHERE id=?", (new_status, bill_id))
    refresh_alerts()
    return get_bill(bill_id)


# ---------------------------------------------------------------- inventory and alerts


def inventory_summary() -> dict[str, Any]:
    settings = get_settings()
    items = all_items(active_only=True)
    covers = [item for item in items
              if "cover" in item["name"].lower() and item["unit"] in ("pcs", "doz")]
    total = sum(item["stock"] * (12 if item["unit"] == "doz" else 1) for item in covers)

    def ratio(item: dict[str, Any]) -> float:
        if item["last_count"] and item["last_count"] > 0:
            return item["stock"] / item["last_count"]
        return 1.0

    lowest = sorted(covers, key=lambda item: (ratio(item), item["stock"], item["name"].lower()))[:5]
    return {
        "covers_total": round(total, 2),
        "cover_items": len(covers),
        "cover_baseline": int(settings["cover_baseline"]),
        "restock_qty": int(settings["restock_qty"]),
        "lowest": [
            {
                "item_id": item["id"],
                "name": item["name"],
                "source_particulars": item["source_particulars"],
                "unit": item["unit"],
                "stock": item["stock"],
                "last_count": item["last_count"],
                "ratio": round(ratio(item), 4),
            }
            for item in lowest
        ],
    }


def _open_alert(conn: sqlite3.Connection, code: str, key: str) -> Optional[sqlite3.Row]:
    return conn.execute(
        "SELECT * FROM alerts WHERE code=? AND key=? AND resolved_at IS NULL "
        "ORDER BY id DESC LIMIT 1", (code, key)
    ).fetchone()


def _upsert_alert(conn: sqlite3.Connection, code: str, key: str, severity: str,
                  message: str, item_id: int | None = None) -> None:
    existing = _open_alert(conn, code, key)
    if existing:
        conn.execute("UPDATE alerts SET severity=?, message=?, item_id=? WHERE id=?",
                     (severity, message, item_id, existing["id"]))
    else:
        conn.execute(
            "INSERT INTO alerts(code,key,severity,message,item_id,created_at) VALUES (?,?,?,?,?,?)",
            (code, key, severity, message, item_id, now_iso()),
        )


def _resolve_alert(conn: sqlite3.Connection, code: str, key: str) -> None:
    conn.execute(
        "UPDATE alerts SET resolved_at=? WHERE code=? AND key=? AND resolved_at IS NULL",
        (now_iso(), code, key),
    )


def refresh_alerts() -> None:
    summary = inventory_summary()
    items = all_items(active_only=True)
    with _tx() as conn:
        if summary["covers_total"] < summary["cover_baseline"]:
            lowest = summary["lowest"][0] if summary["lowest"] else None
            message = (f"Covers total {int(round(summary['covers_total'])):,} pcs is below "
                       f"the baseline of {summary['cover_baseline']:,}.")
            if lowest:
                label = lowest["source_particulars"] or lowest["name"]
                last = lowest["last_count"] if lowest["last_count"] is not None else lowest["stock"]
                message += (f" Lowest: {label} (stock {lowest['stock']:g} {lowest['unit']}, "
                            f"last count {last:g} {lowest['unit']}).")
            _upsert_alert(conn, "COVER_BASELINE", "covers", "high", message,
                          lowest["item_id"] if lowest else None)
        else:
            _resolve_alert(conn, "COVER_BASELINE", "covers")

        negative = [item for item in items if item["stock"] < 0]
        negative_keys = set()
        for item in negative:
            key = f"item:{item['id']}"
            negative_keys.add(key)
            label = item["source_particulars"] or item["name"]
            _upsert_alert(conn, "NEGATIVE_STOCK", key, "high",
                          f"Negative stock: {label} is {item['stock']:g} {item['unit']}.", item["id"])
        for existing in conn.execute(
                "SELECT id, key FROM alerts WHERE code='NEGATIVE_STOCK' AND resolved_at IS NULL").fetchall():
            if existing["key"] not in negative_keys:
                _resolve_alert(conn, "NEGATIVE_STOCK", existing["key"])

        reorder = [item for item in items
                   if item["reorder_point"] is not None and item["stock"] <= item["reorder_point"]]
        reorder_keys = set()
        for item in reorder:
            key = f"item:{item['id']}"
            reorder_keys.add(key)
            label = item["source_particulars"] or item["name"]
            _upsert_alert(conn, "ITEM_REORDER", key, "medium",
                          f"Reorder {label}: {item['stock']:g} {item['unit']} left "
                          f"(reorder point {item['reorder_point']:g}).", item["id"])
        for existing in conn.execute(
                "SELECT id, key FROM alerts WHERE code='ITEM_REORDER' AND resolved_at IS NULL").fetchall():
            if existing["key"] not in reorder_keys:
                _resolve_alert(conn, "ITEM_REORDER", existing["key"])


def list_alerts() -> list[dict[str, Any]]:
    refresh_alerts()
    with _lock:
        rows = _require_conn().execute(
            "SELECT * FROM alerts WHERE resolved_at IS NULL ORDER BY "
            "CASE severity WHEN 'high' THEN 0 ELSE 1 END, id DESC"
        ).fetchall()
    return [_alert(row) for row in rows]


def ack_alert(alert_id: int) -> Optional[dict[str, Any]]:
    with _tx() as conn:
        row = conn.execute("SELECT * FROM alerts WHERE id=?", (alert_id,)).fetchone()
        if not row:
            return None
        if not row["acknowledged_at"]:
            conn.execute("UPDATE alerts SET acknowledged_at=? WHERE id=?", (now_iso(), alert_id))
    with _lock:
        row = _require_conn().execute("SELECT * FROM alerts WHERE id=?", (alert_id,)).fetchone()
    return _alert(row) if row else None
