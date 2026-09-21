from __future__ import annotations

import asyncio
import json

from sqlalchemy import select

from app.catalog.provider import DxRatingCatalogProvider, JsonCatalogProvider
from app.catalog.service import ingest_catalog
from app.config import get_settings
from app.db.base import Base
from app.db.models import CatalogSnapshot
from app.db.session import SessionLocal, engine


async def sync_catalog() -> None:
    settings = get_settings()
    if settings.intl_constants_version != settings.current_intl_version:
        raise RuntimeError(
            "International constant snapshot version does not match currentVersion: "
            f"{settings.intl_constants_version!r} != {settings.current_intl_version!r}"
        )
    constants_fetched = await JsonCatalogProvider(settings.intl_constants_url).fetch()
    if not isinstance(constants_fetched.payload, list):
        raise RuntimeError("International constant provider did not return a JSON list")
    Base.metadata.create_all(bind=engine)
    with SessionLocal() as session:
        previous_snapshot = session.scalar(
            select(CatalogSnapshot)
            .where(CatalogSnapshot.status == "published")
            .order_by(CatalogSnapshot.published_at.desc())
            .limit(1)
        )
        previous_raw_path = (
            settings.raw_catalog_dir / f"{previous_snapshot.content_hash}.json"
            if previous_snapshot
            else None
        )
        previous_etag = (
            previous_snapshot.etag
            if previous_snapshot and previous_raw_path and previous_raw_path.exists()
            else None
        )
        fetched = await DxRatingCatalogProvider(settings.dxrating_url).fetch(previous_etag)
        if fetched.status_code == 304:
            if previous_snapshot is None:
                raise RuntimeError("Catalog returned HTTP 304 without a local snapshot")
            raw_path = settings.raw_catalog_dir / f"{previous_snapshot.content_hash}.json"
            if not raw_path.exists():
                raise RuntimeError("Catalog returned HTTP 304 but the local raw payload is missing")
            payload = json.loads(raw_path.read_text(encoding="utf-8"))
            etag = previous_snapshot.etag
        elif fetched.payload is None:
            raise RuntimeError("Catalog provider returned no payload")
        else:
            payload = fetched.payload
            etag = fetched.etag
        result = ingest_catalog(
            session,
            payload,
            source_url=settings.dxrating_url,
            current_intl_version=settings.current_intl_version,
            overrides_path=settings.intl_overrides_path,
            raw_catalog_dir=settings.raw_catalog_dir,
            etag=etag,
            version_constants_payload=constants_fetched.payload,
            version_constants_url=settings.intl_constants_url,
            version_constants_version=settings.intl_constants_version,
        )
        print(result.model_dump_json(indent=2))


if __name__ == "__main__":
    asyncio.run(sync_catalog())
