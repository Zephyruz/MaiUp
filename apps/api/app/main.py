from __future__ import annotations

import asyncio
import json
import logging
from contextlib import asynccontextmanager, suppress
from decimal import Decimal
from typing import Annotated

from fastapi import Depends, FastAPI, File, HTTPException, Path, Query, Response, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.api.schemas import (
    B50InspectionResponse,
    CompleteScoreImportRequest,
    CompleteScoreImportResponse,
    ImportEntryUpdate,
    PlayerImportResponse,
    RatingRequest,
    RatingResponse,
)
from app.auth import CurrentPrincipal
from app.catalog.queries import catalog_status, chart_constant, search_charts, search_songs
from app.config import get_settings
from app.db.base import Base
from app.db.models import PlayerImport, PlayerScoreSnapshot
from app.db.session import SessionLocal, engine, ensure_local_owner_columns, get_db
from app.imports.asset_store import delete_source_image, source_image_path, store_source_image
from app.imports.complete_scores import (
    CompleteScoreImportError,
    get_complete_score_import,
    import_complete_scores,
)
from app.imports.image_inspection import (
    MAX_IMAGE_BYTES,
    ImageInspectionError,
    inspect_b50_image,
)
from app.imports.service import (
    PlayerImportError,
    confirm_import,
    create_or_reuse_import,
    get_import,
    update_entry,
)
from app.rating.calculator import calculate_chart_rating, coefficient_for
from app.recommendations.service import RecommendationError, build_recommendations

logger = logging.getLogger(__name__)


async def _sync_catalog_in_background() -> None:
    from app.jobs.sync_catalog import sync_catalog

    try:
        await sync_catalog()
    except asyncio.CancelledError:
        raise
    except Exception:
        logger.exception("Background catalog synchronization failed")


@asynccontextmanager
async def lifespan(_: FastAPI):
    Base.metadata.create_all(bind=engine)
    ensure_local_owner_columns()
    settings = get_settings()
    catalog_sync_task: asyncio.Task[None] | None = None
    if settings.sync_catalog_on_start:
        with SessionLocal() as session:
            ready = catalog_status(session).get("ready")
        if not ready:
            catalog_sync_task = asyncio.create_task(
                _sync_catalog_in_background(),
                name="maiup-catalog-sync",
            )
    try:
        yield
    finally:
        if catalog_sync_task is not None and not catalog_sync_task.done():
            catalog_sync_task.cancel()
            with suppress(asyncio.CancelledError):
                await catalog_sync_task


app = FastAPI(
    title="MaiUp International API",
    version="0.1.0",
    lifespan=lifespan,
)
app.add_middleware(
    CORSMiddleware,
    allow_origins=list(get_settings().cors_origins),
    allow_credentials=False,
    allow_methods=["GET", "POST", "PATCH", "DELETE"],
    allow_headers=["Content-Type", "Authorization"],
)

DatabaseSession = Annotated[Session, Depends(get_db)]


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


@app.get("/v1/session")
def session_status(principal: CurrentPrincipal) -> dict[str, object]:
    return {
        "status": "ok",
        "displayName": principal.display_name,
        "imageImportEnabled": get_settings().enable_image_import,
    }


@app.get("/v1/me/imports")
def recent_imports(
    principal: CurrentPrincipal,
    db: DatabaseSession,
) -> list[dict[str, object]]:
    snapshots = db.scalars(
        select(PlayerScoreSnapshot)
        .where(PlayerScoreSnapshot.owner_id == principal.owner_id)
        .order_by(PlayerScoreSnapshot.imported_at.desc())
        .limit(10)
    ).all()
    results: list[dict[str, object]] = []
    for snapshot in snapshots:
        player_import = db.get(PlayerImport, snapshot.id)
        results.append(
            {
                "id": snapshot.id,
                "importedAt": snapshot.imported_at,
                "matchedCount": snapshot.matched_count,
                "b50Generated": player_import is not None,
                "b50Source": player_import.source_type if player_import else None,
            }
        )
    return results


@app.get("/v1/catalog/status")
def get_catalog_status(db: DatabaseSession) -> dict[str, object]:
    result = catalog_status(db)
    if isinstance(result.get("validation"), str):
        result["validation"] = json.loads(str(result["validation"]))
    return result


@app.get("/v1/catalog/songs")
def get_songs(
    db: DatabaseSession,
    q: Annotated[str, Query(min_length=1, max_length=100)],
    limit: Annotated[int, Query(ge=1, le=50)] = 20,
) -> list[dict[str, object]]:
    return search_songs(db, q, limit=limit)


@app.get("/v1/catalog/charts")
def get_charts(
    db: DatabaseSession,
    q: Annotated[str, Query(min_length=1, max_length=100)],
    bucket: Annotated[str | None, Query(pattern="^(b35|b15)$")] = None,
    limit: Annotated[int, Query(ge=1, le=50)] = 20,
) -> list[dict[str, object]]:
    return search_charts(db, q, bucket=bucket, limit=limit)


@app.get("/v1/catalog/charts/{chart_id}/constant")
def get_chart_constant(chart_id: str, db: DatabaseSession) -> dict[str, object]:
    result = chart_constant(db, chart_id)
    if result is None:
        raise HTTPException(status_code=404, detail="Chart or validated catalog not found")
    return result


@app.post("/v1/rating/calculate", response_model=RatingResponse)
def calculate_rating(payload: RatingRequest) -> RatingResponse:
    used = min(payload.achievement, Decimal("100.5"))
    return RatingResponse(
        rating=calculate_chart_rating(
            payload.chart_constant,
            payload.achievement,
            full_combo=payload.full_combo,
        ),
        coefficient=coefficient_for(payload.achievement),
        achievementUsed=used,
    )


@app.post("/v1/imports/scores", response_model=CompleteScoreImportResponse)
def create_complete_score_import(
    payload: CompleteScoreImportRequest,
    principal: CurrentPrincipal,
    db: DatabaseSession,
) -> dict[str, object]:
    try:
        return import_complete_scores(db, payload, principal.owner_id)
    except CompleteScoreImportError as error:
        raise HTTPException(status_code=409, detail=str(error)) from error


@app.get("/v1/imports/scores/{import_id}", response_model=CompleteScoreImportResponse)
def read_complete_score_import(
    import_id: str, principal: CurrentPrincipal, db: DatabaseSession
) -> dict[str, object]:
    try:
        return get_complete_score_import(db, import_id, principal.owner_id)
    except CompleteScoreImportError as error:
        raise HTTPException(status_code=404, detail=str(error)) from error


@app.post("/v1/imports/b50/inspect", response_model=B50InspectionResponse)
async def inspect_b50(
    principal: CurrentPrincipal,
    db: DatabaseSession,
    image: Annotated[UploadFile, File()],
) -> B50InspectionResponse:
    if not get_settings().enable_image_import:
        raise HTTPException(
            status_code=503,
            detail="云端测试版暂未启用图片 OCR，请使用 DX NET JSON 导入",
        )
    from app.imports.ocr import ocr_result_is_current, recognize_import

    content = await image.read(MAX_IMAGE_BYTES + 1)
    await image.close()
    if len(content) > MAX_IMAGE_BYTES:
        raise HTTPException(status_code=413, detail="Image exceeds the 15 MB limit")
    try:
        inspected = inspect_b50_image(content)
    except ImageInspectionError as error:
        raise HTTPException(status_code=400, detail=str(error)) from error
    player_import = create_or_reuse_import(db, inspected, principal.owner_id)
    counts = {"recognized": 0, "matched": 0}
    if player_import:
        created = source_image_path(player_import.id) is None
        source_path = store_source_image(player_import.id, content)
        player_import.source_image_stored = True
        db.commit()
        state = get_import(db, player_import.id, principal.owner_id)
        entries = state["entries"] if state else []
        draft_is_unedited = all(entry.updated_at is None for entry in entries)
        if created or (draft_is_unedited and not ocr_result_is_current(source_path)):
            counts = recognize_import(db, player_import.id, source_path)
        else:
            if state:
                counts = {
                    "recognized": sum(entry.achievement is not None for entry in entries),
                    "matched": sum(not entry.needs_review for entry in entries),
                }
    return B50InspectionResponse(
        status="needs_review" if player_import else "catalog_unavailable",
        fingerprint=inspected.fingerprint,
        format=inspected.format,
        width=inspected.width,
        height=inspected.height,
        byteSize=inspected.byte_size,
        sourceImageStored=bool(player_import),
        nextStep=(
            f"OCR found {counts['recognized']} scores and auto-matched {counts['matched']} charts"
            if player_import
            else "Sync a validated International catalog before creating an import"
        ),
        importId=player_import.id if player_import else None,
        reviewUrl=f"/review/{player_import.id}" if player_import else None,
        recognizedCount=counts["recognized"],
        autoMatchedCount=counts["matched"],
    )


@app.get("/v1/imports/{import_id}/asset")
def read_import_asset(
    import_id: str, principal: CurrentPrincipal, db: DatabaseSession
) -> FileResponse:
    player_import = db.get(PlayerImport, import_id)
    path = source_image_path(import_id)
    if player_import is None or player_import.owner_id != principal.owner_id or path is None:
        raise HTTPException(status_code=404, detail="Temporary source image not found")
    return FileResponse(path, media_type="image/png", headers={"Cache-Control": "no-store"})


@app.delete("/v1/imports/{import_id}/asset", status_code=204)
def remove_import_asset(
    import_id: str, principal: CurrentPrincipal, db: DatabaseSession
) -> Response:
    player_import = db.get(PlayerImport, import_id)
    if player_import is None or player_import.owner_id != principal.owner_id:
        raise HTTPException(status_code=404, detail="Import not found")
    delete_source_image(import_id)
    player_import.source_image_stored = False
    db.commit()
    return Response(status_code=204)


@app.get("/v1/imports/{import_id}", response_model=PlayerImportResponse)
def read_import(
    import_id: str, principal: CurrentPrincipal, db: DatabaseSession
) -> dict[str, object]:
    result = get_import(db, import_id, principal.owner_id)
    if result is None:
        raise HTTPException(status_code=404, detail="Import not found")
    return result


@app.get("/v1/imports/{import_id}/recommendations")
def read_recommendations(
    import_id: str,
    principal: CurrentPrincipal,
    db: DatabaseSession,
    limit_per_bucket: Annotated[int, Query(ge=1, le=12)] = 10,
) -> dict[str, object]:
    try:
        return build_recommendations(
            db,
            import_id,
            limit_per_bucket=limit_per_bucket,
            owner_id=principal.owner_id,
        )
    except RecommendationError as error:
        raise HTTPException(status_code=409, detail=str(error)) from error


@app.patch(
    "/v1/imports/{import_id}/entries/{slot}",
    response_model=PlayerImportResponse,
)
def patch_import_entry(
    import_id: str,
    slot: Annotated[int, Path(ge=1, le=50)],
    payload: ImportEntryUpdate,
    principal: CurrentPrincipal,
    db: DatabaseSession,
) -> dict[str, object]:
    try:
        return update_entry(db, import_id, slot, payload, principal.owner_id)
    except PlayerImportError as error:
        raise HTTPException(status_code=409, detail=str(error)) from error


@app.post("/v1/imports/{import_id}/confirm", response_model=PlayerImportResponse)
def confirm_player_import(
    import_id: str, principal: CurrentPrincipal, db: DatabaseSession
) -> dict[str, object]:
    try:
        return confirm_import(db, import_id, principal.owner_id)
    except PlayerImportError as error:
        raise HTTPException(status_code=409, detail=str(error)) from error
