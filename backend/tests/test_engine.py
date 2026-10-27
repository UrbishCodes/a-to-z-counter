from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app import engine  # noqa: E402

ITEMS = [
    {"id": 1, "name": "Usb Cable", "unit": "pcs", "buy_rate": 37.0, "sell_rate": 40.0, "stock": 87.0, "active": True},
    {"id": 2, "name": "Mobile Cover", "unit": "pcs", "buy_rate": 53.0, "sell_rate": 57.0, "stock": 10.0, "active": True},
    {"id": 3, "name": "Camara Lens", "unit": "doz", "buy_rate": 140.0, "sell_rate": 150.0, "stock": 10.0, "active": True},
    {"id": 4, "name": "Steel Ring", "unit": "kg", "buy_rate": 600.0, "sell_rate": 642.0, "stock": 5.0, "active": True},
    {"id": 5, "name": "P B C Sticket", "unit": "kg", "buy_rate": None, "sell_rate": 717.0, "stock": 4.0, "active": True},
]


def test_taxable_base_benchmark():
    tax = engine.taxable_base(7500, 13)
    assert tax == {"base": 6637.17, "vat": 862.83}


def test_taxable_base_zero_vat():
    assert engine.taxable_base(1000, 0) == {"base": 1000.0, "vat": 0.0}


def test_rate_conversion_pcs_dozen():
    assert engine.convert_rate(57, "pcs", "doz") == 684.0
    assert engine.convert_rate(684, "doz", "pcs") == 57.0
    assert engine.convert_rate(40, "pcs", "pcs") == 40.0


def test_kg_is_isolated():
    assert engine.convert_rate(642, "kg", "pcs") is None
    assert engine.convert_qty(1, "pcs", "doz") == 1 / 12
    assert engine.convert_qty(2, "doz", "pcs") == 24


def test_valid_count_rules():
    assert engine.valid_count("pcs", 10) is True
    assert engine.valid_count("pcs", 1.5) is False
    assert engine.valid_count("doz", 22.5) is True
    assert engine.valid_count("doz", 22.3) is False
    assert engine.valid_count("kg", 0.333) is True
    assert engine.valid_count("kg", 0) is False


def test_rate_for_count():
    assert engine.rate_for_count(557.52, 10) == 55.75
    assert engine.rate_for_count(600, 15) == 40.0


def test_qty_for_rate():
    assert engine.qty_for_rate(3210, 642) == 5.0
    assert engine.qty_for_rate(2654.87, 642) == 4.135


def test_band_statuses():
    assert engine.band_status(39, 37)["status"] == "OK"
    assert engine.band_status(40, 37)["status"] == "OVER_TAX"
    assert engine.band_status(38, 37)["status"] == "LOSS"
    assert engine.band_status(40, None)["status"] == "UNKNOWN_COST"


def test_band_boundaries():
    low = engine.band_status(37 * 1.05, 37)
    high = engine.band_status(37 * 1.07, 37)
    assert low["status"] == "OK"
    assert high["status"] == "OK"
    assert engine.band_status(37 * 1.071, 37)["status"] == "OVER_TAX"


def test_match_usb_confident():
    match = engine.match_items("usb cable", 40, "pcs", ITEMS)
    assert match["confident"] is True
    assert match["item"]["name"] == "Usb Cable"
    assert match["suggestions"][0]["rate_gap_pct"] == 0.0


def test_match_rate_only_goes_to_review():
    match = engine.match_items("random gadget", 12.34, "pcs", ITEMS)
    assert match["confident"] is False
    assert match["method"] == "rate_only"
    assert len(match["suggestions"]) == 3
    assert match["suggestions"][0]["name"] == "Camara Lens"


def test_match_synonym_and_dozen_conversion():
    match = engine.match_items("camara lens", 150, "doz", ITEMS)
    assert match["confident"] is True
    assert match["item"]["name"] == "Camara Lens"


def test_match_kg_isolated():
    match = engine.match_items("usb cable", 40, "kg", ITEMS)
    assert match["confident"] is False
    assert match["suggestions"]
    assert all(s["unit"] == "kg" for s in match["suggestions"])
    assert all(s["name"] != "Usb Cable" for s in match["suggestions"])


def test_match_unknown_cost_suggestion():
    match = engine.match_items("p b c sticket", 717, "kg", ITEMS)
    assert match["confident"] is True
    assert match["item"]["name"] == "P B C Sticket"


def test_bill_totals_paisa_variance():
    totals = engine.bill_totals([{"subtotal": 358.40}], 405, 13)
    assert totals["taxable_base"] == 358.41
    assert totals["lines_total"] == 358.40
    assert totals["variance"] == -0.01
