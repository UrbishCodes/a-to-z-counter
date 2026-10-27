from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))


def line(usb, qty=15, rate=40, description="Usb Cable"):
    return {"description": description, "item_id": usb["id"], "sale_unit": "pcs",
            "qty": qty, "unit_rate": rate}


def bill(gross, lines, vat=13):
    return {"gross_total": gross, "vat_pct": vat, "created_by": "test", "lines": lines}


def test_health_and_settings(client):
    health = client.get("/api/health").json()
    assert health["items"] == 99
    settings = client.get("/api/settings").json()
    assert settings["vat_pct"] == 13.0
    assert settings["band_low_pct"] == 5.0
    assert settings["band_high_pct"] == 7.0
    assert settings["cover_baseline"] == 95000


def test_search_usb(client, usb):
    assert usb["name"] == "Usb Cable"
    assert usb["buy_rate"] == 37.0
    assert usb["sell_rate"] == 40.0
    assert usb["stock"] == 87.0
    assert client.get("/api/items?q=screen%20protector").json()


def test_item_404(client):
    assert client.get("/api/items/999999").status_code == 404


def test_match_endpoint(client):
    result = client.post("/api/match", json={"description": "usb cable", "rate": 40, "sale_unit": "pcs"}).json()
    assert result["confident"] is True
    assert result["item"]["name"] == "Usb Cable"
    assert result["method"] == "name_rate"


def test_b3_save_at_list_over_tax(client, usb):
    response = client.post("/api/bills", json=bill(678, [line(usb)]))
    assert response.status_code == 201
    data = response.json()
    assert data["bill_no"] == "BL-000001"
    assert data["status"] == "complete"
    assert data["taxable_base"] == 600.0
    assert data["vat_amount"] == 78.0
    assert data["lines_total"] == 600.0
    assert data["variance"] == 0.0
    assert data["lines"][0]["margin_status"] == "OVER_TAX"
    assert data["lines"][0]["margin_pct"] == 8.11
    assert client.get(f"/api/items/{usb['id']}").json()["stock"] == 72.0


def test_b4_discount_loss(client, usb):
    # The sheet runs B3 first: 87 -> 72, then B4: 72 -> 57.
    first = client.post("/api/bills", json=bill(678, [line(usb)]))
    assert first.status_code == 201
    assert client.get(f"/api/items/{usb['id']}").json()["stock"] == 72.0
    response = client.post("/api/bills", json=bill(600, [line(usb, rate=35.40)]))
    data = response.json()
    assert data["status"] == "complete"
    assert data["taxable_base"] == 530.97
    assert data["vat_amount"] == 69.03
    assert data["variance"] == 0.03
    assert data["lines"][0]["margin_status"] == "LOSS"
    assert data["lines"][0]["margin_pct"] == -4.32
    assert client.get(f"/api/items/{usb['id']}").json()["stock"] == 57.0


def test_b5_free_text_review_then_confirm(client):
    free = {"description": "random gadget", "sale_unit": "pcs", "qty": 1, "unit_rate": 12.34}
    response = client.post("/api/bills", json=bill(13.94, [free]))
    data = response.json()
    assert data["status"] == "needs_review"
    assert data["variance"] == 0.0
    suggestions = data["lines"][0]["suggestions"]
    assert len(suggestions) == 3
    assert suggestions[0]["name"] == "Camara Lens"
    item_id = suggestions[0]["item_id"]
    before = client.get(f"/api/items/{item_id}").json()["stock"]
    confirmed = client.post(f"/api/bills/{data['id']}/lines/1/confirm", json={"item_id": item_id}).json()
    after = client.get(f"/api/items/{item_id}").json()["stock"]
    assert confirmed["status"] == "complete"
    assert confirmed["lines"][0]["confirmed"] is True
    assert confirmed["lines"][0]["match_method"] == "manual"
    assert abs(confirmed["lines"][0]["stock_delta"] + 1 / 12) < 1e-9
    assert abs((before - after) - 1 / 12) < 1e-9


def test_alerts_and_ack(client):
    alerts = client.get("/api/alerts").json()
    assert len(alerts) == 1
    alert = alerts[0]
    assert alert["code"] == "COVER_BASELINE"
    assert "Covers total 38,526 pcs is below the baseline of 95,000" in alert["message"]
    acked = client.post(f"/api/alerts/{alert['id']}/ack").json()
    assert acked["acknowledged_at"]
    again = client.get("/api/alerts").json()
    assert again[0]["acknowledged_at"]


def test_inventory_summary(client):
    summary = client.get("/api/inventory/summary").json()
    assert summary["covers_total"] == 38526.04
    assert summary["cover_items"] == 54
    assert summary["cover_baseline"] == 95000
    assert summary["restock_qty"] == 5000
    assert summary["lowest"]


def test_count_and_receive(client, usb):
    assert client.post(f"/api/items/{usb['id']}/count", json={"count": 100}).json()["stock"] == 100.0
    received = client.post(f"/api/items/{usb['id']}/receive", json={"qty": 5}).json()
    assert received["stock"] == 105.0


def test_settings_update_and_invalid_band(client):
    updated = client.put("/api/settings", json={"band_low_pct": 4, "band_high_pct": 8, "cover_baseline": 90000})
    assert updated.status_code == 200
    assert updated.json()["band_low_pct"] == 4.0
    assert updated.json()["cover_baseline"] == 90000
    bad = client.put("/api/settings", json={"band_low_pct": 8, "band_high_pct": 4})
    assert bad.status_code == 400


def test_invalid_fractional_pcs_line(client, usb):
    response = client.post("/api/bills", json=bill(100, [line(usb, qty=1.5, rate=40)]))
    assert response.status_code == 400
    assert client.get("/api/bills").json() == []


def test_unknown_item_rejected(client):
    response = client.post("/api/bills", json=bill(100, [{"description": "x", "item_id": 999999,
                                                           "sale_unit": "pcs", "qty": 1, "unit_rate": 40}]))
    assert response.status_code == 400


def test_bill_list_get_and_404(client, usb):
    saved = client.post("/api/bills", json=bill(678, [line(usb)])).json()
    rows = client.get("/api/bills").json()
    assert rows and rows[0]["id"] == saved["id"]
    assert client.get(f"/api/bills/{saved['id']}").json()["bill_no"] == "BL-000001"
    assert client.get("/api/bills/999999").status_code == 404


def test_bill_number_sequence(client, usb):
    first = client.post("/api/bills", json=bill(45.2, [line(usb, qty=1)])).json()
    second = client.post("/api/bills", json=bill(45.2, [line(usb, qty=1)])).json()
    assert first["bill_no"] == "BL-000001"
    assert second["bill_no"] == "BL-000002"
    assert [row["bill_no"] for row in client.get("/api/bills").json()][:2] == ["BL-000002", "BL-000001"]


def test_create_and_patch_item(client):
    created = client.post("/api/items", json={"name": "Test Item", "unit": "pcs", "buy_rate": 8,
                                               "sell_rate": 10, "stock": 5})
    assert created.status_code == 201
    item = created.json()
    patched = client.patch(f"/api/items/{item['id']}", json={"sell_rate": 12}).json()
    assert patched["sell_rate"] == 12.0
    assert client.get(f"/api/items/{item['id']}").json()["name"] == "Test Item"
