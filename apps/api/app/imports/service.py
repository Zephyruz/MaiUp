from __future__ import annotations

import json
import uuid
from datetime import UTC, datetime, timedelta

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.api.schemas import ImportEntryUpdate
from app.catalog.queries import latest_published_snapshot
from app.catalog.versioning import VersionPolicy
from app.db.models import (
    CatalogSnapshot,
    Chart,
    ChartConstant,
    ChartRevision,
    GameVersion,
    ImportEntry,
    PlayerImport,
    Song,
)
from app.imports.image_inspection import InspectedImage
from app.rating.calculator import calculate_chart_rating


class PlayerImportError(ValueError):
    pass


def _version_policy(session: Session, current_version: str) -> VersionPolicy:
    versions = tuple(session.scalars(select(GameVersion.name).order_by(GameVersion.ordinal)).all())
    return VersionPolicy(versions, current_version, b15_version_count=2)


def create_or_reuse_import(
    session: Session, image: InspectedImage, owner_id: str = "test-owner"
) -> PlayerImport | None:
    snapshot = latest_published_snapshot(session)
    if snapshot is None:
        return None
    existing = session.scalar(
        select(PlayerImport)
        .where(
            PlayerImport.image_fingerprint == image.fingerprint,
            PlayerImport.owner_id == owner_id,
            PlayerImport.catalog_snapshot_id == snapshot.id,
            PlayerImport.status != "confirmed",
            PlayerImport.expires_at > datetime.now(UTC),
        )
        .order_by(PlayerImport.created_at.desc())
        .limit(1)
    )
    if existing is not None:
        return existing

    import_id = str(uuid.uuid4())
    now = datetime.now(UTC)
    player_import = PlayerImport(
        id=import_id,
        owner_id=owner_id,
        source_type="b50_image",
        status="needs_review",
        coverage="best50_only",
        catalog_snapshot_id=snapshot.id,
        image_fingerprint=image.fingerprint,
        image_format=image.format,
        image_width=image.width,
        image_height=image.height,
        source_image_stored=False,
        created_at=now,
        expires_at=now + timedelta(hours=24),
    )
    session.add(player_import)
    session.add_all(
        [
            ImportEntry(
                import_id=import_id,
                slot=slot,
                bucket="b35" if slot <= 35 else "b15",
                needs_review=True,
                issue_code="manual_entry_required",
            )
            for slot in range(1, 51)
        ]
    )
    session.commit()
    return player_import


def get_import(
    session: Session, import_id: str, owner_id: str = "test-owner"
) -> dict[str, object] | None:
    player_import = session.get(PlayerImport, import_id)
    if player_import is None or player_import.owner_id != owner_id:
        return None
    entries = list(
        session.scalars(
            select(ImportEntry).where(ImportEntry.import_id == import_id).order_by(ImportEntry.slot)
        ).all()
    )
    completed = sum(not entry.needs_review for entry in entries)
    ratings = [entry.calculated_rating for entry in entries if entry.calculated_rating is not None]
    return {
        "id": player_import.id,
        "status": player_import.status,
        "coverage": player_import.coverage,
        "catalogSnapshotId": player_import.catalog_snapshot_id,
        "sourceImageStored": player_import.source_image_stored,
        "imageWidth": player_import.image_width,
        "imageHeight": player_import.image_height,
        "completedCount": completed,
        "totalCount": len(entries),
        "totalRating": sum(ratings) if ratings else None,
        "entries": entries,
    }


def update_entry(
    session: Session,
    import_id: str,
    slot: int,
    payload: ImportEntryUpdate,
    owner_id: str = "test-owner",
) -> dict[str, object]:
    player_import = session.get(PlayerImport, import_id)
    if player_import is None or player_import.owner_id != owner_id:
        raise PlayerImportError("Import not found")
    if player_import.status == "confirmed":
        raise PlayerImportError("Confirmed imports are immutable")
    entry = session.get(ImportEntry, (import_id, slot))
    if entry is None:
        raise PlayerImportError("Entry slot not found")

    duplicate_slot = session.scalar(
        select(ImportEntry.slot).where(
            ImportEntry.import_id == import_id,
            ImportEntry.chart_id == payload.chart_id,
            ImportEntry.slot != slot,
        )
    )
    if duplicate_slot is not None:
        raise PlayerImportError(f"Chart is already used in slot {duplicate_slot}")

    row = session.execute(
        select(Chart, ChartRevision, ChartConstant, Song)
        .join(
            ChartRevision,
            (ChartRevision.chart_id == Chart.id)
            & (ChartRevision.snapshot_id == player_import.catalog_snapshot_id),
        )
        .join(
            ChartConstant,
            (ChartConstant.chart_id == Chart.id)
            & (ChartConstant.snapshot_id == player_import.catalog_snapshot_id),
        )
        .join(Song, Song.id == Chart.song_id)
        .where(Chart.id == payload.chart_id)
        .order_by(ChartConstant.confidence.desc())
        .limit(1)
    ).first()
    if row is None:
        raise PlayerImportError("Chart is unavailable in this catalog snapshot")
    chart, revision, constant, song = row
    if revision.is_special:
        raise PlayerImportError("Special charts cannot enter Rating")

    # The current version for the snapshot is always the latest configured playable version,
    # not the chart's own version. Resolve it from the published validation report instead.
    snapshot = session.get(CatalogSnapshot, player_import.catalog_snapshot_id)
    if snapshot is None:
        raise PlayerImportError("Catalog snapshot is unavailable")
    current_version = str(json.loads(snapshot.validation_report)["current_version"])
    policy = _version_policy(session, current_version)
    actual_bucket = policy.bucket_for(
        revision.intl_version,
        rating_eligible=not revision.is_special,
    )
    if actual_bucket != entry.bucket:
        raise PlayerImportError(
            f"Chart belongs to {actual_bucket or 'no Rating bucket'}, not {entry.bucket}"
        )

    selected_constant = payload.chart_constant or constant.constant_value
    calculated = calculate_chart_rating(
        selected_constant,
        payload.achievement,
        full_combo=payload.full_combo,
    )
    mismatch = payload.displayed_rating is None or payload.displayed_rating != calculated
    entry.chart_id = chart.id
    entry.title = song.title
    entry.chart_type = chart.chart_type
    entry.difficulty = chart.difficulty
    entry.chart_version = revision.intl_version
    entry.chart_constant = selected_constant
    entry.achievement = payload.achievement
    entry.full_combo = payload.full_combo
    entry.displayed_rating = payload.displayed_rating
    entry.calculated_rating = calculated
    entry.needs_review = mismatch
    entry.issue_code = "rating_mismatch" if mismatch else None
    entry.updated_at = datetime.now(UTC)
    session.commit()
    result = get_import(session, import_id, owner_id)
    if result is None:
        raise PlayerImportError("Import disappeared after update")
    return result


def confirm_import(
    session: Session, import_id: str, owner_id: str = "test-owner"
) -> dict[str, object]:
    player_import = session.get(PlayerImport, import_id)
    if player_import is None or player_import.owner_id != owner_id:
        raise PlayerImportError("Import not found")
    unresolved = session.scalar(
        select(func.count())
        .select_from(ImportEntry)
        .where(ImportEntry.import_id == import_id, ImportEntry.needs_review.is_(True))
    )
    total = session.scalar(
        select(func.count()).select_from(ImportEntry).where(ImportEntry.import_id == import_id)
    )
    if total != 50 or unresolved:
        raise PlayerImportError(f"Import still has {unresolved or 0} unresolved entries")
    player_import.status = "confirmed"
    player_import.confirmed_at = datetime.now(UTC)
    session.commit()
    result = get_import(session, import_id, owner_id)
    if result is None:
        raise PlayerImportError("Import disappeared after confirmation")
    return result
