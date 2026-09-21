from __future__ import annotations

import json
import uuid
from datetime import UTC, datetime, timedelta
from decimal import Decimal

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.api.schemas import CompleteScoreImportRequest, OfficialBest50Entry
from app.catalog.covers import cover_urls_for_snapshot
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
    PlayerScore,
    PlayerScoreSnapshot,
    Song,
    SongAlias,
)
from app.rating.best50 import ScoreRecord, build_best50


class CompleteScoreImportError(ValueError):
    pass


def _normalized(value: str) -> str:
    return " ".join(value.casefold().split())


def _chart_indexes(
    session: Session, snapshot_id: str
) -> tuple[
    dict[tuple[str, str, str], set[str]],
    dict[tuple[str, str], set[str]],
    dict[str, str],
    dict[str, str],
    dict[str, Decimal],
    dict[str, int],
]:
    rows = session.execute(
        select(
            Chart.id,
            Song.title,
            Chart.chart_type,
            Chart.difficulty,
            Chart.song_id,
            ChartRevision.level,
            ChartRevision.total,
        )
        .join(Song, Song.id == Chart.song_id)
        .join(
            ChartRevision,
            (ChartRevision.chart_id == Chart.id) & (ChartRevision.snapshot_id == snapshot_id),
        )
        .where(ChartRevision.is_special.is_(False))
    ).all()
    aliases = session.execute(
        select(
            Chart.id,
            SongAlias.name,
            Chart.chart_type,
            Chart.difficulty,
            Chart.song_id,
            ChartRevision.level,
            ChartRevision.total,
        )
        .join(SongAlias, SongAlias.song_id == Chart.song_id)
        .join(
            ChartRevision,
            (ChartRevision.chart_id == Chart.id) & (ChartRevision.snapshot_id == snapshot_id),
        )
        .where(ChartRevision.is_special.is_(False))
    ).all()
    exact_index: dict[tuple[str, str, str], set[str]] = {}
    title_difficulty_index: dict[tuple[str, str], set[str]] = {}
    chart_types: dict[str, str] = {}
    chart_song_ids: dict[str, str] = {}
    chart_levels: dict[str, Decimal] = {}
    chart_dx_score_max: dict[str, int] = {}
    for chart_id, title, chart_type, difficulty, song_id, level, note_total in [
        *rows,
        *aliases,
    ]:
        normalized_title = _normalized(title)
        normalized_type = chart_type.casefold()
        normalized_difficulty = difficulty.casefold()
        exact_index.setdefault(
            (normalized_title, normalized_type, normalized_difficulty), set()
        ).add(chart_id)
        title_difficulty_index.setdefault((normalized_title, normalized_difficulty), set()).add(
            chart_id
        )
        chart_types[chart_id] = normalized_type
        chart_song_ids[chart_id] = song_id
        chart_levels[chart_id] = _displayed_level_value(level)
        chart_dx_score_max[chart_id] = note_total * 3
    return (
        exact_index,
        title_difficulty_index,
        chart_types,
        chart_song_ids,
        chart_levels,
        chart_dx_score_max,
    )


def _displayed_level_value(level: str) -> Decimal:
    normalized = level.strip()
    if normalized.endswith("+"):
        return Decimal(normalized[:-1]) + Decimal("0.7")
    return Decimal(normalized)


def _source_song_candidates(
    entries: list[OfficialBest50Entry] | list,
    exact_index: dict[tuple[str, str, str], set[str]],
    title_difficulty_index: dict[tuple[str, str], set[str]],
    chart_song_ids: dict[str, str],
    chart_levels: dict[str, Decimal],
) -> dict[str, set[str]]:
    grouped: dict[str, set[str]] = {}
    for item in entries:
        if not item.source_song_key:
            continue
        candidates = exact_index.get(
            (_normalized(item.title), item.chart_type, item.difficulty), set()
        )
        if not candidates:
            candidates = title_difficulty_index.get(
                (_normalized(item.title), item.difficulty), set()
            )
        if item.displayed_level is not None:
            level_matches = {
                chart_id
                for chart_id in candidates
                if chart_levels.get(chart_id) == item.displayed_level
            }
            if level_matches:
                candidates = level_matches
        song_ids = {chart_song_ids[chart_id] for chart_id in candidates}
        if not song_ids:
            continue
        if item.source_song_key in grouped:
            grouped[item.source_song_key] &= song_ids
        else:
            grouped[item.source_song_key] = song_ids
    return grouped


def _title_type_song_candidates(
    entries: list[OfficialBest50Entry] | list,
    exact_index: dict[tuple[str, str, str], set[str]],
    chart_song_ids: dict[str, str],
    chart_levels: dict[str, Decimal],
) -> dict[tuple[str, str], set[str]]:
    grouped: dict[tuple[str, str], set[str]] = {}
    for item in entries:
        if item.displayed_level is None:
            continue
        group_key = (_normalized(item.title), item.chart_type)
        candidates = exact_index.get((*group_key, item.difficulty), set())
        level_matches = {
            chart_id
            for chart_id in candidates
            if chart_levels.get(chart_id) == item.displayed_level
        }
        song_ids = {chart_song_ids[chart_id] for chart_id in level_matches}
        if len(song_ids) == 1:
            grouped.setdefault(group_key, set()).update(song_ids)
    return grouped


def _narrow_candidates(
    candidates: set[str],
    item,
    chart_song_ids: dict[str, str],
    chart_levels: dict[str, Decimal],
    chart_dx_score_max: dict[str, int],
    source_song_candidates: dict[str, set[str]],
    title_type_song_candidates: dict[tuple[str, str], set[str]],
) -> set[str]:
    narrowed = set(candidates)
    if item.dx_score_max is not None:
        dx_score_matches = {
            chart_id
            for chart_id in narrowed
            if chart_dx_score_max.get(chart_id) == item.dx_score_max
        }
        if dx_score_matches:
            narrowed = dx_score_matches
    if item.displayed_level is not None:
        level_matches = {
            chart_id for chart_id in narrowed if chart_levels.get(chart_id) == item.displayed_level
        }
        if level_matches:
            narrowed = level_matches
    if item.source_song_key:
        song_ids = source_song_candidates.get(item.source_song_key, set())
        if len(song_ids) == 1:
            song_matches = {
                chart_id for chart_id in narrowed if chart_song_ids.get(chart_id) in song_ids
            }
            if song_matches:
                narrowed = song_matches
    inferred_song_ids = title_type_song_candidates.get(
        (_normalized(item.title), item.chart_type), set()
    )
    if len(inferred_song_ids) == 1:
        song_matches = {
            chart_id for chart_id in narrowed if chart_song_ids.get(chart_id) in inferred_song_ids
        }
        if song_matches:
            narrowed = song_matches
    return narrowed


def _create_best50_import(
    session: Session,
    *,
    import_id: str,
    catalog: CatalogSnapshot,
    matched_by_chart: dict[str, PlayerScore],
    created_at: datetime,
    owner_id: str,
) -> bool:
    chart_ids = set(matched_by_chart)
    if not chart_ids:
        return False
    rows = session.execute(
        select(Chart, Song, ChartRevision, ChartConstant)
        .join(Song, Song.id == Chart.song_id)
        .join(
            ChartRevision,
            (ChartRevision.chart_id == Chart.id) & (ChartRevision.snapshot_id == catalog.id),
        )
        .join(
            ChartConstant,
            (ChartConstant.chart_id == Chart.id) & (ChartConstant.snapshot_id == catalog.id),
        )
        .where(Chart.id.in_(chart_ids))
        .order_by(ChartConstant.confidence.desc())
    ).all()
    metadata: dict[str, tuple[Chart, Song, ChartRevision, ChartConstant]] = {}
    for chart, song, revision, constant in rows:
        metadata.setdefault(chart.id, (chart, song, revision, constant))

    validation = json.loads(catalog.validation_report)
    versions = tuple(session.scalars(select(GameVersion.name).order_by(GameVersion.ordinal)).all())
    current_version = validation.get("current_version")
    if not current_version or current_version not in versions:
        return False
    policy = VersionPolicy(versions, str(current_version), b15_version_count=2)
    records = [
        ScoreRecord(
            chart_id=chart_id,
            chart_version=metadata[chart_id][2].intl_version,
            chart_constant=metadata[chart_id][3].constant_value,
            achievement=score.achievement,
            full_combo=score.full_combo,
            rating_eligible=not metadata[chart_id][2].is_special,
        )
        for chart_id, score in matched_by_chart.items()
        if chart_id in metadata
    ]
    best50 = build_best50(records, policy)
    if len(best50.b35) != 35 or len(best50.b15) != 15:
        return False

    session.add(
        PlayerImport(
            id=import_id,
            owner_id=owner_id,
            source_type="dxnet_calculated_b50",
            status="confirmed",
            coverage="full_scores",
            catalog_snapshot_id=catalog.id,
            image_fingerprint=import_id.replace("-", "")[:16],
            image_format="json",
            image_width=0,
            image_height=0,
            source_image_stored=False,
            created_at=created_at,
            expires_at=created_at + timedelta(days=3650),
            confirmed_at=created_at,
        )
    )
    session.flush()
    entries: list[ImportEntry] = []
    for bucket, ranked_scores, slot_offset in (
        ("b35", best50.b35, 0),
        ("b15", best50.b15, 35),
    ):
        for position, ranked in enumerate(ranked_scores, start=1):
            chart, song, revision, constant = metadata[ranked.score.chart_id]
            player_score = matched_by_chart[chart.id]
            entries.append(
                ImportEntry(
                    import_id=import_id,
                    slot=slot_offset + position,
                    bucket=bucket,
                    chart_id=chart.id,
                    title=song.title,
                    chart_type=chart.chart_type,
                    difficulty=chart.difficulty,
                    chart_version=revision.intl_version,
                    chart_constant=constant.constant_value,
                    achievement=player_score.achievement,
                    full_combo=player_score.full_combo,
                    displayed_rating=ranked.rating,
                    calculated_rating=ranked.rating,
                    needs_review=False,
                    issue_code=None,
                    updated_at=created_at,
                )
            )
    session.add_all(entries)
    return True


def _create_official_best50_import(
    session: Session,
    *,
    import_id: str,
    catalog: CatalogSnapshot,
    official_best50: list[OfficialBest50Entry],
    exact_index: dict[tuple[str, str, str], set[str]],
    title_difficulty_index: dict[tuple[str, str], set[str]],
    chart_song_ids: dict[str, str],
    chart_levels: dict[str, Decimal],
    chart_dx_score_max: dict[str, int],
    source_song_candidates: dict[str, set[str]],
    title_type_song_candidates: dict[tuple[str, str], set[str]],
    created_at: datetime,
    owner_id: str,
) -> bool:
    grouped = {
        bucket: sorted(
            (item for item in official_best50 if item.bucket == bucket),
            key=lambda item: item.position,
        )
        for bucket in ("b35", "b15")
    }
    if [item.position for item in grouped["b35"]] != list(range(1, 36)):
        return False
    if [item.position for item in grouped["b15"]] != list(range(1, 16)):
        return False

    resolved: list[tuple[OfficialBest50Entry, str]] = []
    for bucket in ("b35", "b15"):
        for item in grouped[bucket]:
            candidates = exact_index.get(
                (_normalized(item.title), item.chart_type, item.difficulty), set()
            )
            candidates = _narrow_candidates(
                candidates,
                item,
                chart_song_ids,
                chart_levels,
                chart_dx_score_max,
                source_song_candidates,
                title_type_song_candidates,
            )
            if not candidates:
                candidates = title_difficulty_index.get(
                    (_normalized(item.title), item.difficulty), set()
                )
                candidates = _narrow_candidates(
                    candidates,
                    item,
                    chart_song_ids,
                    chart_levels,
                    chart_dx_score_max,
                    source_song_candidates,
                    title_type_song_candidates,
                )
            if len(candidates) != 1:
                return False
            resolved.append((item, next(iter(candidates))))
    chart_ids = {chart_id for _, chart_id in resolved}
    if len(chart_ids) != 50:
        return False

    rows = session.execute(
        select(Chart, Song, ChartRevision, ChartConstant)
        .join(Song, Song.id == Chart.song_id)
        .join(
            ChartRevision,
            (ChartRevision.chart_id == Chart.id) & (ChartRevision.snapshot_id == catalog.id),
        )
        .join(
            ChartConstant,
            (ChartConstant.chart_id == Chart.id) & (ChartConstant.snapshot_id == catalog.id),
        )
        .where(Chart.id.in_(chart_ids))
        .order_by(ChartConstant.confidence.desc())
    ).all()
    metadata: dict[str, tuple[Chart, Song, ChartRevision, ChartConstant]] = {}
    for chart, song, revision, constant in rows:
        metadata.setdefault(chart.id, (chart, song, revision, constant))
    if set(metadata) != chart_ids:
        return False

    validation = json.loads(catalog.validation_report)
    versions = tuple(session.scalars(select(GameVersion.name).order_by(GameVersion.ordinal)).all())
    current_version = validation.get("current_version")
    if not current_version or current_version not in versions:
        return False
    policy = VersionPolicy(versions, str(current_version), b15_version_count=2)
    if any(
        policy.bucket_for(metadata[chart_id][2].intl_version) != item.bucket
        for item, chart_id in resolved
    ):
        return False

    session.add(
        PlayerImport(
            id=import_id,
            owner_id=owner_id,
            source_type="dxnet_official_b50",
            status="confirmed",
            coverage="full_scores",
            catalog_snapshot_id=catalog.id,
            image_fingerprint=import_id.replace("-", "")[:16],
            image_format="json",
            image_width=0,
            image_height=0,
            source_image_stored=False,
            created_at=created_at,
            expires_at=created_at + timedelta(days=3650),
            confirmed_at=created_at,
        )
    )
    session.flush()
    entries: list[ImportEntry] = []
    for item, chart_id in resolved:
        chart, song, revision, constant = metadata[chart_id]
        rating = ScoreRecord(
            chart_id=chart_id,
            chart_version=revision.intl_version,
            chart_constant=constant.constant_value,
            achievement=item.achievement,
            full_combo=item.full_combo,
        ).rating
        entries.append(
            ImportEntry(
                import_id=import_id,
                slot=item.position if item.bucket == "b35" else 35 + item.position,
                bucket=item.bucket,
                chart_id=chart.id,
                title=song.title,
                chart_type=chart.chart_type,
                difficulty=chart.difficulty,
                chart_version=revision.intl_version,
                chart_constant=constant.constant_value,
                achievement=item.achievement,
                full_combo=item.full_combo,
                displayed_rating=rating,
                calculated_rating=rating,
                needs_review=False,
                issue_code=None,
                updated_at=created_at,
            )
        )
    session.add_all(entries)
    return True


def import_complete_scores(
    session: Session, payload: CompleteScoreImportRequest, owner_id: str = "test-owner"
) -> dict[str, object]:
    catalog = latest_published_snapshot(session)
    if catalog is None:
        raise CompleteScoreImportError("No validated International catalog is published")

    (
        exact_index,
        title_difficulty_index,
        chart_types,
        chart_song_ids,
        chart_levels,
        chart_dx_score_max,
    ) = _chart_indexes(session, catalog.id)
    source_song_candidates = _source_song_candidates(
        [*payload.scores, *(payload.official_best50 or [])],
        exact_index,
        title_difficulty_index,
        chart_song_ids,
        chart_levels,
    )
    title_type_song_candidates = _title_type_song_candidates(
        [*payload.scores, *(payload.official_best50 or [])],
        exact_index,
        chart_song_ids,
        chart_levels,
    )
    import_id = str(uuid.uuid4())
    matched_by_chart: dict[str, PlayerScore] = {}
    stored: list[PlayerScore] = []
    duplicate_count = 0

    for source_index, item in enumerate(payload.scores):
        key = (_normalized(item.title), item.chart_type, item.difficulty)
        candidates = exact_index.get(key, set())
        candidates = _narrow_candidates(
            candidates,
            item,
            chart_song_ids,
            chart_levels,
            chart_dx_score_max,
            source_song_candidates,
            title_type_song_candidates,
        )
        resolved_chart_type = item.chart_type
        if len(candidates) == 1:
            chart_id = next(iter(candidates))
            match_status = "matched"
            issue_code = None
        elif len(candidates) > 1:
            chart_id = None
            match_status = "needs_review"
            issue_code = "ambiguous_chart"
        else:
            fallback_candidates = title_difficulty_index.get(
                (_normalized(item.title), item.difficulty), set()
            )
            fallback_candidates = _narrow_candidates(
                fallback_candidates,
                item,
                chart_song_ids,
                chart_levels,
                chart_dx_score_max,
                source_song_candidates,
                title_type_song_candidates,
            )
            if len(fallback_candidates) == 1:
                chart_id = next(iter(fallback_candidates))
                resolved_chart_type = chart_types[chart_id]
                match_status = "matched_type_corrected"
                issue_code = None
            elif len(fallback_candidates) > 1:
                chart_id = None
                match_status = "needs_review"
                issue_code = "ambiguous_chart_type"
            else:
                chart_id = None
                match_status = "needs_review"
                issue_code = "chart_not_found"

        score = PlayerScore(
            snapshot_id=import_id,
            source_index=source_index,
            chart_id=chart_id,
            title=item.title,
            chart_type=resolved_chart_type,
            difficulty=item.difficulty,
            achievement=item.achievement,
            full_combo=item.full_combo,
            sync_status=item.sync_status,
            dx_score=item.dx_score,
            played_at=item.played_at,
            match_status=match_status,
            issue_code=issue_code,
        )
        if chart_id is not None and chart_id in matched_by_chart:
            duplicate_count += 1
            previous = matched_by_chart[chart_id]
            if item.achievement > previous.achievement:
                previous.match_status = "duplicate_ignored"
                previous.issue_code = "lower_achievement_duplicate"
                matched_by_chart[chart_id] = score
            else:
                score.match_status = "duplicate_ignored"
                score.issue_code = "lower_achievement_duplicate"
        elif chart_id is not None:
            matched_by_chart[chart_id] = score
        stored.append(score)

    matched_count = len(matched_by_chart)
    unmatched_count = sum(score.chart_id is None for score in stored)
    imported_at = datetime.now(UTC)
    snapshot = PlayerScoreSnapshot(
        id=import_id,
        owner_id=owner_id,
        schema_version=payload.schema_version,
        source_region=payload.source_region,
        source_name=payload.source_name,
        exported_at=payload.exported_at,
        imported_at=imported_at,
        catalog_snapshot_id=catalog.id,
        status="ready" if unmatched_count == 0 else "needs_review",
        supplied_count=len(stored),
        matched_count=matched_count,
        unmatched_count=unmatched_count,
        duplicate_count=duplicate_count,
    )
    session.add(snapshot)
    session.flush()
    session.add_all(stored)
    session.flush()
    official_best50_created = bool(payload.official_best50) and _create_official_best50_import(
        session,
        import_id=import_id,
        catalog=catalog,
        official_best50=payload.official_best50 or [],
        exact_index=exact_index,
        title_difficulty_index=title_difficulty_index,
        chart_song_ids=chart_song_ids,
        chart_levels=chart_levels,
        chart_dx_score_max=chart_dx_score_max,
        source_song_candidates=source_song_candidates,
        title_type_song_candidates=title_type_song_candidates,
        created_at=imported_at,
        owner_id=owner_id,
    )
    if not official_best50_created:
        _create_best50_import(
            session,
            import_id=import_id,
            catalog=catalog,
            matched_by_chart=matched_by_chart,
            created_at=imported_at,
            owner_id=owner_id,
        )
    session.commit()
    return get_complete_score_import(session, import_id, owner_id)


def get_complete_score_import(
    session: Session, import_id: str, owner_id: str = "test-owner"
) -> dict[str, object]:
    snapshot = session.get(PlayerScoreSnapshot, import_id)
    if snapshot is None or snapshot.owner_id != owner_id:
        raise CompleteScoreImportError("Complete score import not found")
    scores = list(
        session.scalars(
            select(PlayerScore)
            .where(PlayerScore.snapshot_id == import_id)
            .order_by(PlayerScore.source_index)
        ).all()
    )
    issues = [
        score
        for score in scores
        if score.issue_code is not None and score.match_status != "duplicate_ignored"
    ]
    effective_scores = [score for score in scores if score.match_status != "duplicate_ignored"]
    chart_type_counts = {
        chart_type: sum(score.chart_type == chart_type for score in effective_scores)
        for chart_type in ("std", "dx")
    }
    difficulty_counts = {
        difficulty: sum(score.difficulty == difficulty for score in effective_scores)
        for difficulty in ("basic", "advanced", "expert", "master", "remaster")
    }
    sample_scores = sorted(
        effective_scores,
        key=lambda score: (-score.achievement, score.source_index),
    )[:12]
    denominator = max(snapshot.supplied_count - snapshot.duplicate_count, 1)
    best50_import = session.get(PlayerImport, import_id)
    if best50_import is not None and best50_import.owner_id != owner_id:
        best50_import = None
    best50_entries = (
        list(
            session.scalars(
                select(ImportEntry)
                .where(ImportEntry.import_id == import_id)
                .order_by(ImportEntry.slot)
            ).all()
        )
        if best50_import is not None
        else []
    )
    chart_song_ids = dict(
        session.execute(
            select(Chart.id, Chart.song_id).where(
                Chart.id.in_(
                    entry.chart_id for entry in best50_entries if entry.chart_id is not None
                )
            )
        ).all()
    )
    chart_versions = dict(
        session.execute(
            select(ChartRevision.chart_id, ChartRevision.intl_version).where(
                ChartRevision.snapshot_id == snapshot.catalog_snapshot_id,
                ChartRevision.chart_id.in_(
                    entry.chart_id for entry in best50_entries if entry.chart_id is not None
                ),
            )
        ).all()
    )
    cover_urls = cover_urls_for_snapshot(session.get(CatalogSnapshot, snapshot.catalog_snapshot_id))
    has_complete_b50 = len(best50_entries) == 50
    b35_rating = sum(
        entry.calculated_rating or 0 for entry in best50_entries if entry.bucket == "b35"
    )
    b15_rating = sum(
        entry.calculated_rating or 0 for entry in best50_entries if entry.bucket == "b15"
    )
    return {
        "id": snapshot.id,
        "status": snapshot.status,
        "suppliedCount": snapshot.supplied_count,
        "matchedCount": snapshot.matched_count,
        "unmatchedCount": snapshot.unmatched_count,
        "duplicateCount": snapshot.duplicate_count,
        "coverageRatio": (Decimal(snapshot.matched_count) / Decimal(denominator)).quantize(
            Decimal("0.0001")
        ),
        "correctedTypeCount": sum(
            score.match_status == "matched_type_corrected" for score in scores
        ),
        "chartTypeCounts": chart_type_counts,
        "difficultyCounts": difficulty_counts,
        "sampleScores": [
            {
                "title": score.title,
                "chartType": score.chart_type,
                "difficulty": score.difficulty,
                "achievement": score.achievement,
                "fullCombo": score.full_combo,
                "matchStatus": score.match_status,
            }
            for score in sample_scores
        ],
        "b50Generated": has_complete_b50,
        "b35Count": sum(entry.bucket == "b35" for entry in best50_entries),
        "b15Count": sum(entry.bucket == "b15" for entry in best50_entries),
        "b35Rating": b35_rating if has_complete_b50 else None,
        "b15Rating": b15_rating if has_complete_b50 else None,
        "totalRating": b35_rating + b15_rating if has_complete_b50 else None,
        "recommendationUrl": (f"/recommendations/{import_id}" if has_complete_b50 else None),
        "b50Source": (
            "official_dxnet"
            if best50_import and best50_import.source_type == "dxnet_official_b50"
            else "calculated_fallback"
            if best50_import
            else None
        ),
        "best50Entries": [
            {
                "position": entry.slot if entry.bucket == "b35" else entry.slot - 35,
                "bucket": entry.bucket,
                "title": entry.title,
                "chartType": entry.chart_type,
                "difficulty": entry.difficulty,
                "version": chart_versions.get(entry.chart_id),
                "achievement": entry.achievement,
                "rating": entry.calculated_rating,
                "constant": entry.chart_constant,
                "fullCombo": entry.full_combo,
                "coverUrl": cover_urls.get(chart_song_ids.get(entry.chart_id, "")),
            }
            for entry in best50_entries
        ],
        "issues": [
            {
                "sourceIndex": score.source_index,
                "title": score.title,
                "chartType": score.chart_type,
                "difficulty": score.difficulty,
                "issueCode": score.issue_code,
            }
            for score in issues
        ],
    }
