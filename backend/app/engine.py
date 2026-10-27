"""Pure business rules for the counter: reverse VAT, units, margins and matching.

No database or HTTP imports here. Money is compared in paisa so float drift
cannot create a fake variance. These rules mirror web/solver.js.
"""
from __future__ import annotations

import math
import re
from decimal import Decimal, ROUND_HALF_UP
from typing import Any, Iterable, Optional

# ---------------------------------------------------------------- money helpers


def _d(value: Any) -> Decimal:
    return Decimal(str(value))


def r2(value: Any) -> float:
    """Round to 2 dp, half up (same as JS Math.round for positive money)."""
    return float(_d(value).quantize(Decimal("0.01"), rounding=ROUND_HALF_UP))


def r3(value: Any) -> float:
    return float(_d(value).quantize(Decimal("0.001"), rounding=ROUND_HALF_UP))


def r4(value: Any) -> float:
    return float(_d(value).quantize(Decimal("0.0001"), rounding=ROUND_HALF_UP))


def paisa(value: Any) -> int:
    return int((_d(value) * 100).quantize(Decimal("1"), rounding=ROUND_HALF_UP))


def taxable_base(gross: Any, vat_pct: Any) -> dict[str, float]:
    """G = base * (1 + V/100); base and VAT rounded to 2 dp."""
    g = _d(gross)
    v = _d(vat_pct)
    base = (g / (Decimal(1) + v / Decimal(100))).quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)
    vat = (g - base).quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)
    return {"base": float(base), "vat": float(vat)}


# ---------------------------------------------------------------- unit rules


def convert_rate(rate: Any, from_unit: str, to_unit: str) -> Optional[float]:
    """pcs <-> dozen at 12. Kg is isolated. None when incompatible."""
    if rate is None:
        return None
    try:
        value = float(rate)
    except (TypeError, ValueError):
        return None
    if not math.isfinite(value):
        return None
    if from_unit == to_unit:
        return value
    if from_unit == "pcs" and to_unit == "doz":
        return value * 12.0
    if from_unit == "doz" and to_unit == "pcs":
        return value / 12.0
    return None


def convert_qty(qty: Any, from_unit: str, to_unit: str) -> Optional[float]:
    """Quantity conversion is the inverse of rate conversion."""
    if qty is None:
        return None
    try:
        value = float(qty)
    except (TypeError, ValueError):
        return None
    if not math.isfinite(value):
        return None
    if from_unit == to_unit:
        return value
    if from_unit == "pcs" and to_unit == "doz":
        return value / 12.0
    if from_unit == "doz" and to_unit == "pcs":
        return value * 12.0
    return None


def compatible(a: str, b: str) -> bool:
    if a == b:
        return True
    return a in ("pcs", "doz") and b in ("pcs", "doz")


def valid_unit(unit: str) -> bool:
    return unit in ("pcs", "doz", "kg")


def valid_count(unit: str, qty: Any) -> bool:
    try:
        value = float(qty)
    except (TypeError, ValueError):
        return False
    if not math.isfinite(value) or value <= 0:
        return False
    if unit == "pcs":
        return float(value).is_integer()
    if unit == "doz":
        return abs(value * 2 - round(value * 2)) < 1e-9
    return unit == "kg"


def rate_for_count(base: Any, count: Any) -> Optional[float]:
    try:
        b, c = float(base), float(count)
    except (TypeError, ValueError):
        return None
    if b <= 0 or c <= 0:
        return None
    return r2(b / c)


def qty_for_rate(base: Any, rate: Any) -> Optional[float]:
    """Kg only: 3 dp, upgraded to 4 dp only when that hits the base exactly."""
    try:
        b, rate_f = float(base), float(rate)
    except (TypeError, ValueError):
        return None
    if b <= 0 or rate_f <= 0:
        return None
    raw = b / rate_f
    q3 = r3(raw)
    if paisa(q3 * rate_f) == paisa(b):
        return q3
    q4 = r4(raw)
    if paisa(q4 * rate_f) == paisa(b):
        return q4
    return q3


# ---------------------------------------------------------------- margins


def band_status(rate: Any, buy_rate: Any, low_pct: Any = 5, high_pct: Any = 7) -> dict[str, Any]:
    try:
        rate_f = float(rate)
    except (TypeError, ValueError):
        return {"status": "UNKNOWN_COST", "pct": None, "low_rate": None, "high_rate": None}
    try:
        buy = float(buy_rate) if buy_rate is not None else 0.0
    except (TypeError, ValueError):
        buy = 0.0
    if buy <= 0:
        return {"status": "UNKNOWN_COST", "pct": None, "low_rate": None, "high_rate": None}
    lo = float(low_pct)
    hi = float(high_pct)
    pct = r2((rate_f - buy) / buy * 100)
    if pct < lo:
        status = "LOSS"
    elif pct > hi:
        status = "OVER_TAX"
    else:
        status = "OK"
    return {
        "status": status,
        "pct": pct,
        "low_rate": buy * (1 + lo / 100),
        "high_rate": buy * (1 + hi / 100),
    }


def margin_for_line(item: Optional[dict[str, Any]], sale_unit: str, rate: Any,
                    low_pct: Any = 5, high_pct: Any = 7) -> dict[str, Any]:
    if not item:
        return {"buy_rate": None, "margin_pct": None, "margin_status": "UNKNOWN_COST"}
    buy = item.get("buy_rate")
    if buy is None or float(buy) <= 0:
        return {"buy_rate": None, "margin_pct": None, "margin_status": "UNKNOWN_COST"}
    item_rate = convert_rate(rate, sale_unit, item["unit"])
    if item_rate is None:
        return {"buy_rate": None, "margin_pct": None, "margin_status": "UNKNOWN_COST"}
    band = band_status(item_rate, buy, low_pct, high_pct)
    return {"buy_rate": float(buy), "margin_pct": band["pct"], "margin_status": band["status"],
            "low_rate": band["low_rate"], "high_rate": band["high_rate"]}


# ---------------------------------------------------------------- names / matching

_SYNONYMS = {
    "camara": "camera",
    "protertor": "protector",
    "protrector": "protector",
    "procotor": "protector",
    "protection": "protector",
    "protector": "protector",
    "protecter": "protector",
    "tempr": "temper",
    "tempered": "temper",
    "sticket": "sticker",
    "covers": "cover",
    "cover": "cover",
}


def normalize_word(word: str) -> str:
    word = word.lower().strip()
    return _SYNONYMS.get(word, word)


def tokens(text: Any) -> list[str]:
    if text is None:
        return []
    words = re.findall(r"[a-z0-9]+", str(text).lower())
    return [w for w in (normalize_word(word) for word in words) if w]


def normalize_text(text: Any) -> str:
    return " ".join(tokens(text))


def name_score(description: Any, name: Any) -> float:
    """Word-overlap (Jaccard) after merging known spellings."""
    a, b = set(tokens(description)), set(tokens(name))
    if not a or not b:
        return 0.0
    return len(a & b) / len(a | b)


def search_match(query: Any, name: Any, source: Any = "") -> bool:
    q = set(tokens(query))
    if not q:
        return True
    hay = set(tokens(name)) | set(tokens(source))
    return q.issubset(hay)


def _suggestion(item: dict[str, Any], score: float, gap: float, margin: dict[str, Any]) -> dict[str, Any]:
    return {
        "item_id": item["id"],
        "id": item["id"],
        "name": item["name"],
        "unit": item["unit"],
        "sell_rate": item["sell_rate"],
        "buy_rate": item["buy_rate"],
        "stock": item["stock"],
        "rate_gap_pct": gap,
        "margin_status": margin["margin_status"],
        "margin_pct": margin["margin_pct"],
        "score": r2(score),
    }


def match_items(description: Any, rate: Any, sale_unit: str,
                items: Iterable[dict[str, Any]], low_pct: Any = 5, high_pct: Any = 7,
                limit: int = 3) -> dict[str, Any]:
    """Closest item by name and rate, per PRD v2 section 6."""
    try:
        rate_f = float(rate)
    except (TypeError, ValueError):
        return {"confident": False, "item": None, "method": "rate_only", "suggestions": []}
    text = (str(description).strip() if description is not None else "")
    scored: list[dict[str, Any]] = []
    for item in items:
        if not item.get("active", True):
            continue
        if not compatible(sale_unit, item["unit"]):
            continue
        sell = convert_rate(item["sell_rate"], item["unit"], sale_unit)
        if sell is None or sell <= 0:
            continue
        gap = r2(abs(rate_f - sell) / sell * 100)
        score = name_score(text, item["name"]) if text else 0.0
        margin = margin_for_line(item, sale_unit, rate_f, low_pct, high_pct)
        scored.append({"item": item, "score": score, "gap": gap, "margin": margin})

    with_words = [row for row in scored if row["score"] > 0]
    pool = with_words if with_words else scored
    method = "name_rate" if with_words else "rate_only"
    pool.sort(key=lambda row: (row["gap"], -row["score"], str(row["item"]["name"]).lower(), row["item"]["sell_rate"]))
    top = pool[:limit]
    suggestions = [_suggestion(row["item"], row["score"], row["gap"], row["margin"]) for row in top]

    if not top:
        return {"confident": False, "item": None, "method": method, "suggestions": []}
    best = top[0]
    if text:
        confident = best["score"] >= 0.5 and best["gap"] <= 2.0
    else:
        confident = best["gap"] <= 0.5
    return {
        "confident": confident,
        "item": best["item"] if confident else None,
        "best": best,
        "method": method,
        "suggestions": suggestions,
    }


# ---------------------------------------------------------------- bill math


def line_subtotal(qty: Any, rate: Any) -> float:
    return r2(float(qty) * float(rate))


def bill_totals(lines: Iterable[dict[str, Any]], gross: Any, vat_pct: Any) -> dict[str, float]:
    tax = taxable_base(gross, vat_pct)
    lines_total_p = sum(paisa(line["subtotal"]) for line in lines)
    variance_p = lines_total_p - paisa(tax["base"])
    return {
        "taxable_base": tax["base"],
        "vat_amount": tax["vat"],
        "lines_total": lines_total_p / 100,
        "variance": variance_p / 100,
    }


def bill_status(lines: Iterable[dict[str, Any]]) -> str:
    lines = list(lines)
    return "complete" if lines and all(line.get("confirmed") for line in lines) else "needs_review"
