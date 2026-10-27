"""Counter Sales API: reverse VAT, bills, stock and alerts."""
from __future__ import annotations

import os
from contextlib import asynccontextmanager
from typing import Any, Literal, Optional

from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from . import db, engine

API_KEY = os.environ.get("API_KEY")
VERSION = "3.1.0"


@asynccontextmanager
async def lifespan(_: FastAPI):
    db.ensure_ready()
    db.refresh_alerts()
    yield


app = FastAPI(title="Counter Sales API", version=VERSION, lifespan=lifespan)


@app.middleware("http")
async def api_key_guard(request, call_next):
    if API_KEY and request.url.path.startswith("/api"):
        if request.headers.get("x-api-key") != API_KEY:
            return JSONResponse(status_code=401, content={"detail": "Unauthorized"})
    return await call_next(request)


app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.exception_handler(ValueError)
async def value_error_handler(_, exc: ValueError):
    return JSONResponse(status_code=400, content={"detail": str(exc)})


# ---------------------------------------------------------------- request models

Unit = Literal["pcs", "doz", "kg"]


class ItemIn(BaseModel):
    name: str
    unit: Unit
    sell_rate: float = Field(gt=0)
    buy_rate: Optional[float] = Field(default=None, ge=0)
    stock: float = Field(default=0, ge=0)
    last_count: Optional[float] = Field(default=None, ge=0)
    reorder_point: Optional[float] = Field(default=None, ge=0)
    active: bool = True
    hs_code: str = ""
    source_particulars: str = ""
    source_qty: Optional[float] = None


class ItemPatch(BaseModel):
    name: Optional[str] = None
    hs_code: Optional[str] = None
    unit: Optional[str] = None
    sell_rate: Optional[float] = Field(default=None, gt=0)
    buy_rate: Optional[float] = Field(default=None, ge=0)
    stock: Optional[float] = Field(default=None, ge=0)
    last_count: Optional[float] = Field(default=None, ge=0)
    reorder_point: Optional[float] = Field(default=None, ge=0)
    active: Optional[bool] = None


class CountIn(BaseModel):
    count: float = Field(ge=0)


class ReceiveIn(BaseModel):
    qty: float = Field(gt=0)
    buy_rate: Optional[float] = Field(default=None, ge=0)


class MatchIn(BaseModel):
    description: str = ""
    rate: float = Field(gt=0)
    sale_unit: Unit


class BillLineIn(BaseModel):
    description: str = ""
    item_id: Optional[int] = None
    sale_unit: Unit
    qty: float = Field(gt=0)
    unit_rate: float = Field(gt=0)


class BillIn(BaseModel):
    gross_total: float = Field(gt=0)
    vat_pct: float = Field(ge=0)
    note: str = ""
    created_by: str = ""
    lines: list[BillLineIn] = Field(default_factory=list)


class ConfirmIn(BaseModel):
    item_id: int = Field(gt=0)


class SettingsIn(BaseModel):
    vat_pct: Optional[float] = Field(default=None, ge=0)
    band_low_pct: Optional[float] = Field(default=None, ge=0)
    band_high_pct: Optional[float] = Field(default=None, ge=0)
    cover_baseline: Optional[int] = Field(default=None, ge=0)
    restock_qty: Optional[int] = Field(default=None, ge=0)


def payload(model: BaseModel) -> dict[str, Any]:
    return model.model_dump(exclude_none=True) if hasattr(model, "model_dump") else model.dict(exclude_none=True)


def patch_payload(model: BaseModel) -> dict[str, Any]:
    """Only the fields the caller actually sent.

    A PATCH has to tell "leave it alone" apart from "clear it": the data sheet
    sends an explicit null to remove a buy rate, and exclude_none would drop it.
    """
    if hasattr(model, "model_dump"):
        return model.model_dump(exclude_unset=True)
    return model.dict(exclude_unset=True)


# ---------------------------------------------------------------- health and settings


@app.get("/api/health")
def health() -> dict[str, Any]:
    return {"status": "ok", "items": db.item_count(), "version": VERSION}


@app.get("/api/settings")
def settings() -> dict[str, Any]:
    return db.get_settings()


@app.put("/api/settings")
def put_settings(body: SettingsIn) -> dict[str, Any]:
    return db.update_settings(payload(body))


# ---------------------------------------------------------------- items


@app.get("/api/items")
def items(q: str = "", unit: Optional[str] = None,
          limit: int = Query(default=40, ge=1, le=200)) -> list[dict[str, Any]]:
    if unit and unit not in ("pcs", "doz", "kg"):
        raise HTTPException(status_code=400, detail="unit must be pcs, doz or kg")
    return db.list_items(q=q, unit=unit, limit=limit)


@app.get("/api/items/{item_id}")
def get_item(item_id: int) -> dict[str, Any]:
    item = db.get_item(item_id)
    if not item:
        raise HTTPException(status_code=404, detail="item not found")
    return item


@app.post("/api/items", status_code=201)
def create_item(body: ItemIn) -> dict[str, Any]:
    return db.create_item(payload(body))


@app.patch("/api/items/{item_id}")
def patch_item(item_id: int, body: ItemPatch) -> dict[str, Any]:
    item = db.update_item(item_id, patch_payload(body))
    if not item:
        raise HTTPException(status_code=404, detail="item not found")
    return item


@app.post("/api/items/{item_id}/count")
def count_item(item_id: int, body: CountIn) -> dict[str, Any]:
    item = db.set_count(item_id, body.count)
    if not item:
        raise HTTPException(status_code=404, detail="item not found")
    return item


@app.post("/api/items/{item_id}/receive")
def receive_item(item_id: int, body: ReceiveIn) -> dict[str, Any]:
    item = db.receive_item(item_id, body.qty, body.buy_rate)
    if not item:
        raise HTTPException(status_code=404, detail="item not found")
    return item


@app.post("/api/match")
def match(body: MatchIn) -> dict[str, Any]:
    rules = db.get_settings()
    result = engine.match_items(body.description, body.rate, body.sale_unit, db.all_items(),
                                rules["band_low_pct"], rules["band_high_pct"])
    return {
        "confident": result["confident"],
        "method": result["method"],
        "item": result.get("item"),
        "suggestions": result["suggestions"],
    }


# ---------------------------------------------------------------- bills


@app.post("/api/bills", status_code=201)
def create_bill(body: BillIn) -> dict[str, Any]:
    return db.save_bill(payload(body))


@app.get("/api/bills")
def bills(limit: int = Query(default=50, ge=1, le=200)) -> list[dict[str, Any]]:
    return db.list_bills(limit)


@app.get("/api/bills/{bill_id}")
def get_bill(bill_id: int) -> dict[str, Any]:
    bill = db.get_bill(bill_id)
    if not bill:
        raise HTTPException(status_code=404, detail="bill not found")
    return bill


@app.post("/api/bills/{bill_id}/lines/{line_no}/confirm")
def confirm_line(bill_id: int, line_no: int, body: ConfirmIn) -> dict[str, Any]:
    bill = db.get_bill(bill_id)
    if not bill:
        raise HTTPException(status_code=404, detail="bill not found")
    updated = db.confirm_line(bill_id, line_no, body.item_id)
    if not updated:
        raise HTTPException(status_code=404, detail="bill not found")
    return updated


# ---------------------------------------------------------------- alerts and inventory


@app.get("/api/alerts")
def alerts() -> list[dict[str, Any]]:
    return db.list_alerts()


@app.post("/api/alerts/{alert_id}/ack")
def ack_alert(alert_id: int) -> dict[str, Any]:
    alert = db.ack_alert(alert_id)
    if not alert:
        raise HTTPException(status_code=404, detail="alert not found")
    return alert


@app.get("/api/inventory/summary")
def inventory_summary() -> dict[str, Any]:
    return db.inventory_summary()


# ---------------------------------------------------------------- the web app

if db.WEB_DIR.exists():
    app.mount("/", StaticFiles(directory=str(db.WEB_DIR), html=True), name="web")
