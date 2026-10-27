import os
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
os.environ.pop("API_KEY", None)

from app import db  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402


@pytest.fixture()
def client(tmp_path):
    db.configure(tmp_path / "test.db")
    db.reset_db()
    from app.main import app  # noqa: E402

    with TestClient(app) as c:
        yield c


@pytest.fixture()
def usb(client):
    rows = client.get("/api/items", params={"q": "usb cable"}).json()
    assert rows
    return rows[0]
