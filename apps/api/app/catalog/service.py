from __future__ import annotations

import hashlib
import json
import unicodedata
import uuid
from datetime import UTC, datetime
from decimal import Decimal
from pathlib import Path
from typing import Any

from sqlalchemy import delete, select
from sqlalchemy.orm import Session

from app.catalog.schemas import CatalogValidation, IngestResult, RawCatalog
from app.catalog.versioning import VersionPolicy
from app.db.models import (
    CatalogSnapshot,
    Chart,
    ChartAvailability,
    ChartConstant,
    ChartRevision,
    ChartTag,
    DataSource,
    GameVersion,
    Song,
    SongAlias,
    Tag,
)

DXRATING_SOURCE_ID = "dxrating-public-catalog"
MAITOOLS_SOURCE_ID = "mai-tools-version-catalog"
LOCAL_OVERRIDE_SOURCE_ID = "maiup-intl-overrides"
DIFFICULTIES = ("basic", "advanced", "expert", "master", "remaster")


class CatalogIngestError(RuntimeError):
    pass


def canonical_json_bytes(payload: Any) -> bytes:
    return json.dumps(
        payload,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8")


def _validate(catalog: RawCatalog, policy: VersionPolicy) -> CatalogValidation:
    intl_songs: set[str] = set()
    intl_charts = 0
    errors: list[str] = []
    warnings: list[str] = []

    for song in catalog.songs:
        for sheet in song.sheets:
            if "intl" not in sheet.server_ids:
                continue
            intl_songs.add(song.id)
            intl_charts += 1
            intl_version = sheet.version_for("intl")
            if intl_version not in policy.ordered_versions:
                errors.append(f"Unknown International version {intl_version!r} on {sheet.id}")
            if sheet.internal_level_value < 1 or sheet.internal_level_value > 15:
                errors.append(
                    f"Out-of-range base constant {sheet.internal_level_value} on {sheet.id}"
                )
            if sheet.note_counts.total < 0:
                errors.append(f"Negative note count on {sheet.id}")

    if catalog.schema_version != 1:
        errors.append(f"Unsupported schemaVersion: {catalog.schema_version}")
    if len(catalog.songs) < 1000:
        errors.append(f"Unexpectedly small source catalog: {len(catalog.songs)} songs")
    if len(intl_songs) < 1000:
        errors.append(f"Unexpectedly small International catalog: {len(intl_songs)} songs")
    if intl_charts < 4000:
        errors.append(f"Unexpectedly small International chart count: {intl_charts}")
    if not any(
        sheet.version_for("intl") == policy.current_version
        for song in catalog.songs
        for sheet in song.sheets
        if "intl" in sheet.server_ids
    ):
        warnings.append(
            f"No chart is marked with current International version {policy.current_version!r}; "
            "the configured version may be ahead of the catalog."
        )

    return CatalogValidation(
        passed=not errors,
        errors=errors,
        warnings=warnings,
        total_songs=len(catalog.songs),
        international_songs=len(intl_songs),
        international_charts=intl_charts,
        current_version=policy.current_version,
        b15_versions=list(policy.b15_versions),
    )


def _load_intl_overrides(path: Path) -> dict[tuple[str, str | None], Decimal]:
    if not path.exists():
        return {}
    payload = json.loads(path.read_text(encoding="utf-8"))
    if payload.get("schemaVersion") != 1:
        raise CatalogIngestError("Unsupported International constant override schema")
    return {
        (str(item["chartId"]), item.get("gameVersion")): Decimal(str(item["constant"]))
        for item in payload.get("overrides", [])
    }


def _normalized_title(value: str) -> str:
    return " ".join(unicodedata.normalize("NFKC", value).casefold().split())


def _build_version_constant_index(
    payload: list[Any],
) -> tuple[
    dict[tuple[str, str, str], Decimal],
    dict[tuple[str, str, str, int], Decimal],
    set[tuple[str, str, str]],
]:
    candidates: dict[tuple[str, str, str], set[Decimal]] = {}
    debut_candidates: dict[tuple[str, str, str, int], set[Decimal]] = {}
    for item in payload:
        if (
            not isinstance(item, dict)
            or not isinstance(item.get("name"), str)
            or not isinstance(item.get("debut"), int)
        ):
            continue
        chart_type = "dx" if item.get("dx") == 1 else "std"
        base_values = item.get("lv")
        if not isinstance(base_values, list):
            continue
        intl_values: list[Any] = []
        intl_override = item.get("regionOverrides", {}).get("intl", {})
        if isinstance(intl_override, dict) and isinstance(intl_override.get("lv"), list):
            intl_values = intl_override["lv"]
        for index, difficulty in enumerate(DIFFICULTIES):
            raw_value = intl_values[index] if index < len(intl_values) else None
            if not isinstance(raw_value, int | float | str) or raw_value == 0:
                raw_value = base_values[index] if index < len(base_values) else None
            if not isinstance(raw_value, int | float | str) or isinstance(raw_value, bool):
                continue
            try:
                constant = Decimal(str(raw_value))
            except ArithmeticError:
                continue
            # mai-tools uses negative numbers for estimates and zero for no regional override.
            if constant <= 0:
                continue
            key = (_normalized_title(item["name"]), chart_type, difficulty)
            candidates.setdefault(key, set()).add(constant)
            debut_candidates.setdefault((*key, item["debut"]), set()).add(constant)

    ambiguous = {key for key, values in candidates.items() if len(values) != 1}
    return (
        {key: next(iter(values)) for key, values in candidates.items() if len(values) == 1},
        {key: next(iter(values)) for key, values in debut_candidates.items() if len(values) == 1},
        ambiguous,
    )


def _version_constant_for(
    title: str,
    chart_type: str,
    difficulty: str,
    debut_ordinal: int,
    constants: dict[tuple[str, str, str], Decimal],
    debut_constants: dict[tuple[str, str, str, int], Decimal],
) -> Decimal | None:
    key = (_normalized_title(title), chart_type, difficulty)
    return constants.get(key, debut_constants.get((*key, debut_ordinal)))


def _catalog_content_hash(
    raw_bytes: bytes,
    intl_overrides: dict[tuple[str, str | None], Decimal],
    version_constants_payload: list[Any],
    version_constants_version: str,
) -> str:
    serialized_overrides = json.dumps(
        [
            {
                "chartId": chart_id,
                "gameVersion": game_version,
                "constant": str(constant),
            }
            for (chart_id, game_version), constant in sorted(
                intl_overrides.items(), key=lambda item: (item[0][0], item[0][1] or "")
            )
        ],
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8")
    version_bytes = canonical_json_bytes(version_constants_payload)
    policy = f"maiup-catalog-policy-v5-selective-debut-match:{version_constants_version}".encode()
    return hashlib.sha256(
        raw_bytes + b"\n" + policy + b"\n" + serialized_overrides + b"\n" + version_bytes
    ).hexdigest()


def _resolve_intl_constant(
    sheet,
    intl_version: str,
    intl_overrides: dict[tuple[str, str | None], Decimal],
    version_constant: Decimal | None,
) -> tuple[Decimal, str, Decimal, str, str]:
    manual_override = intl_overrides.get(
        (sheet.id, intl_version), intl_overrides.get((sheet.id, None))
    )
    if manual_override is not None:
        return (
            manual_override,
            "intl",
            Decimal("1.000"),
            "validated_intl_override",
            LOCAL_OVERRIDE_SOURCE_ID,
        )
    if version_constant is not None:
        return (
            version_constant,
            "intl",
            Decimal("0.950"),
            "maitools_version_snapshot",
            MAITOOLS_SOURCE_ID,
        )
    return (
        sheet.internal_level_value,
        "generic",
        Decimal("0.750"),
        "community_base_fallback",
        DXRATING_SOURCE_ID,
    )


def ingest_catalog(
    session: Session,
    payload: dict[str, Any],
    *,
    source_url: str,
    current_intl_version: str,
    overrides_path: Path,
    raw_catalog_dir: Path,
    etag: str | None = None,
    version_constants_payload: list[Any],
    version_constants_url: str,
    version_constants_version: str,
) -> IngestResult:
    raw_bytes = canonical_json_bytes(payload)
    intl_overrides = _load_intl_overrides(overrides_path)
    content_hash = _catalog_content_hash(
        raw_bytes,
        intl_overrides,
        version_constants_payload,
        version_constants_version,
    )
    existing = session.scalar(
        select(CatalogSnapshot).where(CatalogSnapshot.content_hash == content_hash)
    )
    if existing:
        validation = CatalogValidation.model_validate_json(existing.validation_report)
        return IngestResult(
            snapshot_id=existing.id,
            status=existing.status,
            content_hash=content_hash,
            song_count=existing.song_count,
            chart_count=existing.chart_count,
            validation=validation,
            reused_existing_snapshot=True,
        )

    catalog = RawCatalog.model_validate(payload)
    ordered_versions = tuple(version.version for version in catalog.versions)
    version_ordinals = {version: ordinal for ordinal, version in enumerate(ordered_versions)}
    policy = VersionPolicy(
        ordered_versions=ordered_versions,
        current_version=current_intl_version,
        b15_version_count=2,
    )
    validation = _validate(catalog, policy)
    if version_constants_version != current_intl_version:
        raise CatalogIngestError(
            "International constant snapshot version does not match the active version"
        )
    version_constant_index, debut_constant_index, ambiguous_constant_keys = (
        _build_version_constant_index(version_constants_payload)
    )
    matched_version_constants = sum(
        1
        for song in catalog.songs
        for sheet in song.sheets
        if "intl" in sheet.server_ids
        and _version_constant_for(
            song.title,
            sheet.type,
            sheet.difficulty,
            version_ordinals[song.version],
            version_constant_index,
            debut_constant_index,
        )
        is not None
    )
    if matched_version_constants < 5000:
        raise CatalogIngestError(
            "International version snapshot matched only "
            f"{matched_version_constants} charts; refusing to publish mixed-version constants"
        )
    unresolved_ambiguous_keys = {
        (_normalized_title(song.title), sheet.type, sheet.difficulty)
        for song in catalog.songs
        for sheet in song.sheets
        if "intl" in sheet.server_ids
        and (_normalized_title(song.title), sheet.type, sheet.difficulty) in ambiguous_constant_keys
        and _version_constant_for(
            song.title,
            sheet.type,
            sheet.difficulty,
            version_ordinals[song.version],
            version_constant_index,
            debut_constant_index,
        )
        is None
    }
    if unresolved_ambiguous_keys:
        validation = validation.model_copy(
            update={
                "warnings": [
                    *validation.warnings,
                    f"Skipped {len(unresolved_ambiguous_keys)} ambiguous version-constant keys.",
                ]
            }
        )
    snapshot_id = str(uuid.uuid4())
    now = datetime.now(UTC)

    source = session.get(DataSource, DXRATING_SOURCE_ID)
    if source is None:
        source = DataSource(
            id=DXRATING_SOURCE_ID,
            name="DXRating public catalog",
            url=source_url,
            region_scope="jp,intl,usa,cn",
            trust_level="community-primary",
            license_note=(
                "Repository MIT; third-party game data and artwork retain separate rights."
            ),
        )
        session.add(source)

    version_source = session.get(DataSource, MAITOOLS_SOURCE_ID)
    if version_source is None:
        version_source = DataSource(
            id=MAITOOLS_SOURCE_ID,
            name=f"mai-tools {version_constants_version} version snapshot",
            url=version_constants_url,
            region_scope="intl",
            trust_level="community-versioned",
            license_note=(
                "Versioned community game data; upstream data and artwork rights remain separate."
            ),
        )
        session.add(version_source)

    override_source = session.get(DataSource, LOCAL_OVERRIDE_SOURCE_ID)
    if override_source is None:
        override_source = DataSource(
            id=LOCAL_OVERRIDE_SOURCE_ID,
            name="MaiUp validated International overrides",
            url=overrides_path.as_posix(),
            region_scope="intl",
            trust_level="locally-validated",
            license_note=(
                "Locally maintained corrections cross-checked against International DX NET."
            ),
        )
        session.add(override_source)

    # PostgreSQL enforces the snapshot foreign key immediately when the
    # following read queries trigger an autoflush. Persist the three source
    # rows first so a fresh remote database cannot flush the snapshot ahead of
    # its parent source.
    session.flush()

    snapshot = CatalogSnapshot(
        id=snapshot_id,
        source_id=source.id,
        schema_version=catalog.schema_version,
        source_updated_at=catalog.updated_at,
        etag=etag,
        content_hash=content_hash,
        fetched_at=now,
        published_at=now if validation.passed else None,
        status="published" if validation.passed else "rejected",
        song_count=validation.international_songs,
        chart_count=validation.international_charts,
        warning_count=len(validation.warnings),
        validation_report=validation.model_dump_json(),
    )
    session.add(snapshot)

    versions_by_name = {item.name: item for item in session.scalars(select(GameVersion)).all()}
    songs_by_id = {item.id: item for item in session.scalars(select(Song)).all()}
    charts_by_id = {item.id: item for item in session.scalars(select(Chart)).all()}
    tags_by_id = {item.id: item for item in session.scalars(select(Tag)).all()}
    existing_aliases = {
        (song_id, name.casefold())
        for song_id, name in session.execute(select(SongAlias.song_id, SongAlias.name))
    }

    for ordinal, version in enumerate(catalog.versions):
        stored = versions_by_name.get(version.version)
        if stored is None:
            stored = GameVersion(
                name=version.version,
                abbreviation=version.abbr,
                release_date=version.release_date,
                ordinal=ordinal,
            )
            session.add(stored)
            versions_by_name[stored.name] = stored
        else:
            stored.abbreviation = version.abbr
            stored.release_date = version.release_date
            stored.ordinal = ordinal

    international_song_ids: set[str] = set()
    international_chart_ids: set[str] = set()

    for raw_song in catalog.songs:
        intl_sheets = [sheet for sheet in raw_song.sheets if "intl" in sheet.server_ids]
        if not intl_sheets:
            continue
        international_song_ids.add(raw_song.id)
        song = songs_by_id.get(raw_song.id)
        if song is None:
            song = Song(
                id=raw_song.id,
                title=raw_song.title,
                artist=raw_song.artist,
                category=raw_song.category,
                bpm=raw_song.bpm,
                source_version=raw_song.version,
                is_locked=raw_song.is_locked,
            )
            session.add(song)
            songs_by_id[song.id] = song
        else:
            song.title = raw_song.title
            song.artist = raw_song.artist
            song.category = raw_song.category
            song.bpm = raw_song.bpm
            song.source_version = raw_song.version
            song.is_locked = raw_song.is_locked

        for sheet in intl_sheets:
            international_chart_ids.add(sheet.id)
            chart = charts_by_id.get(sheet.id)
            if chart is None:
                chart = Chart(
                    id=sheet.id,
                    song_id=raw_song.id,
                    chart_type=sheet.type,
                    difficulty=sheet.difficulty,
                    internal_id=sheet.internal_id,
                )
                session.add(chart)
                charts_by_id[chart.id] = chart

            intl_version = sheet.version_for("intl")
            version_constant = _version_constant_for(
                raw_song.title,
                sheet.type,
                sheet.difficulty,
                version_ordinals[raw_song.version],
                version_constant_index,
                debut_constant_index,
            )
            constant, region, confidence, derivation, constant_source_id = _resolve_intl_constant(
                sheet,
                intl_version,
                intl_overrides,
                version_constant,
            )
            counts = sheet.note_counts
            session.add(
                ChartRevision(
                    snapshot_id=snapshot_id,
                    chart_id=sheet.id,
                    level=sheet.level_for("intl"),
                    base_internal_level=constant,
                    note_designer=sheet.note_designer,
                    tap=counts.tap,
                    hold=counts.hold,
                    slide=counts.slide,
                    touch=counts.touch,
                    break_count=counts.break_count,
                    total=counts.total,
                    is_special=sheet.is_special,
                    base_version=sheet.version,
                    intl_version=intl_version,
                    release_date=sheet.release_date,
                )
            )
            session.add(
                ChartAvailability(
                    snapshot_id=snapshot_id,
                    chart_id=sheet.id,
                    region="intl",
                    game_version=intl_version,
                )
            )
            session.add(
                ChartConstant(
                    snapshot_id=snapshot_id,
                    chart_id=sheet.id,
                    region=region,
                    source_id=constant_source_id,
                    game_version=intl_version,
                    constant_value=constant,
                    confidence=confidence,
                    derivation=derivation,
                )
            )

    seen_aliases: set[tuple[str, str]] = set()
    for alias in catalog.aliases:
        if alias.song_id not in international_song_ids:
            continue
        alias_key = (alias.song_id, alias.name.casefold())
        if alias_key in seen_aliases:
            continue
        seen_aliases.add(alias_key)
        if alias_key not in existing_aliases:
            session.add(
                SongAlias(
                    song_id=alias.song_id,
                    name=alias.name,
                    source_id=source.id,
                )
            )
            existing_aliases.add(alias_key)

    for raw_tag in catalog.tags:
        tag = tags_by_id.get(raw_tag.id)
        zh_name = raw_tag.localized_name.get("zh-Hans", "")
        en_name = raw_tag.localized_name.get("en", "")
        if tag is None:
            tag = Tag(
                id=raw_tag.id,
                group_id=raw_tag.group_id,
                name_zh_hans=zh_name,
                name_en=en_name,
            )
            session.add(tag)
            tags_by_id[tag.id] = tag
        else:
            tag.group_id = raw_tag.group_id
            tag.name_zh_hans = zh_name
            tag.name_en = en_name

    for link in catalog.tag_songs:
        if link.sheet_id not in international_chart_ids:
            continue
        session.add(
            ChartTag(
                snapshot_id=snapshot_id,
                chart_id=link.sheet_id,
                tag_id=link.tag_id,
                source_id=source.id,
                confidence=Decimal("0.500"),
                method="community_single-label",
            )
        )

    raw_catalog_dir.mkdir(parents=True, exist_ok=True)
    (raw_catalog_dir / f"{content_hash}.json").write_bytes(raw_bytes)
    session.commit()

    return IngestResult(
        snapshot_id=snapshot_id,
        status=snapshot.status,
        content_hash=content_hash,
        song_count=validation.international_songs,
        chart_count=validation.international_charts,
        validation=validation,
    )


def clear_rejected_snapshot(session: Session, snapshot_id: str) -> None:
    snapshot = session.get(CatalogSnapshot, snapshot_id)
    if snapshot is None or snapshot.status != "rejected":
        raise CatalogIngestError("Only rejected snapshots can be cleared")
    for model in (ChartTag, ChartConstant, ChartAvailability, ChartRevision):
        session.execute(delete(model).where(model.snapshot_id == snapshot_id))
    session.delete(snapshot)
    session.commit()
