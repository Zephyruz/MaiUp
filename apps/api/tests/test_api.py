import asyncio
from io import BytesIO
from threading import Event

from fastapi.testclient import TestClient
from PIL import Image

from app.main import app


def test_health() -> None:
    with TestClient(app) as client:
        assert client.get("/health").json() == {"status": "ok"}


def test_health_is_available_while_catalog_sync_runs(monkeypatch) -> None:
    from app import main
    from app.jobs import sync_catalog as sync_catalog_job

    started = Event()

    async def blocked_sync() -> None:
        started.set()
        await asyncio.Event().wait()

    monkeypatch.setenv("MAIUP_SYNC_CATALOG_ON_START", "true")
    monkeypatch.setattr(main, "catalog_status", lambda _: {"ready": False})
    monkeypatch.setattr(sync_catalog_job, "sync_catalog", blocked_sync)

    with TestClient(app) as client:
        assert started.wait(timeout=1)
        assert client.get("/health").json() == {"status": "ok"}


def test_rating_endpoint_uses_decimal_boundaries() -> None:
    with TestClient(app) as client:
        response = client.post(
            "/v1/rating/calculate",
            json={"chartConstant": "14.0", "achievement": "100.5", "fullCombo": "AP"},
        )
    assert response.status_code == 200
    assert response.json() == {
        "rating": 316,
        "coefficient": "22.4",
        "achievementUsed": "100.5",
    }


def test_b50_inspection_stores_normalized_source_image_locally() -> None:
    stream = BytesIO()
    Image.new("RGB", (1920, 1080), "#123456").save(stream, format="PNG")
    with TestClient(app) as client:
        response = client.post(
            "/v1/imports/b50/inspect",
            files={"image": ("b50.png", stream.getvalue(), "image/png")},
        )
    assert response.status_code == 200
    payload = response.json()
    assert payload["status"] in {"needs_review", "catalog_unavailable"}
    assert payload["sourceImageStored"] is (payload["status"] == "needs_review")
    if payload["importId"]:
        with TestClient(app) as client:
            deleted = client.delete(f"/v1/imports/{payload['importId']}/asset")
        assert deleted.status_code == 204
    assert payload["width"] == 1920
    if payload["status"] == "needs_review":
        assert payload["importId"]
        assert payload["reviewUrl"].startswith("/review/")
