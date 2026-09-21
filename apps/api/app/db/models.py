from __future__ import annotations

from datetime import date, datetime
from decimal import Decimal

from sqlalchemy import (
    Boolean,
    Date,
    DateTime,
    ForeignKey,
    ForeignKeyConstraint,
    Index,
    Integer,
    Numeric,
    String,
    Text,
    UniqueConstraint,
)
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base


class DataSource(Base):
    __tablename__ = "data_sources"

    id: Mapped[str] = mapped_column(String(40), primary_key=True)
    name: Mapped[str] = mapped_column(String(120))
    url: Mapped[str] = mapped_column(Text)
    region_scope: Mapped[str] = mapped_column(String(80))
    trust_level: Mapped[str] = mapped_column(String(40))
    license_note: Mapped[str] = mapped_column(Text)


class CatalogSnapshot(Base):
    __tablename__ = "catalog_snapshots"

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    source_id: Mapped[str] = mapped_column(ForeignKey("data_sources.id"))
    schema_version: Mapped[int] = mapped_column(Integer)
    source_updated_at: Mapped[str] = mapped_column(String(80))
    etag: Mapped[str | None] = mapped_column(String(200), nullable=True)
    content_hash: Mapped[str] = mapped_column(String(64), unique=True)
    fetched_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    published_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    status: Mapped[str] = mapped_column(String(20), index=True)
    song_count: Mapped[int] = mapped_column(Integer)
    chart_count: Mapped[int] = mapped_column(Integer)
    warning_count: Mapped[int] = mapped_column(Integer, default=0)
    validation_report: Mapped[str] = mapped_column(Text, default="{}")


class GameVersion(Base):
    __tablename__ = "versions"

    name: Mapped[str] = mapped_column(String(80), primary_key=True)
    abbreviation: Mapped[str] = mapped_column(String(80))
    release_date: Mapped[date] = mapped_column(Date)
    ordinal: Mapped[int] = mapped_column(Integer, unique=True)


class Song(Base):
    __tablename__ = "songs"

    id: Mapped[str] = mapped_column(String(40), primary_key=True)
    title: Mapped[str] = mapped_column(String(300), index=True)
    artist: Mapped[str] = mapped_column(String(300))
    category: Mapped[str] = mapped_column(String(100))
    bpm: Mapped[Decimal | None] = mapped_column(Numeric(7, 2), nullable=True)
    source_version: Mapped[str] = mapped_column(String(80))
    is_locked: Mapped[bool] = mapped_column(Boolean, default=False)


class SongAlias(Base):
    __tablename__ = "song_aliases"
    __table_args__ = (UniqueConstraint("song_id", "name", name="uq_song_alias"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    song_id: Mapped[str] = mapped_column(ForeignKey("songs.id"), index=True)
    name: Mapped[str] = mapped_column(String(300), index=True)
    source_id: Mapped[str] = mapped_column(ForeignKey("data_sources.id"))


class Chart(Base):
    __tablename__ = "charts"
    __table_args__ = (
        UniqueConstraint(
            "song_id", "chart_type", "difficulty", "internal_id", name="uq_chart_identity"
        ),
    )

    id: Mapped[str] = mapped_column(String(40), primary_key=True)
    song_id: Mapped[str] = mapped_column(ForeignKey("songs.id"), index=True)
    chart_type: Mapped[str] = mapped_column(String(20), index=True)
    difficulty: Mapped[str] = mapped_column(String(30), index=True)
    internal_id: Mapped[int | None] = mapped_column(Integer, nullable=True)


class ChartRevision(Base):
    __tablename__ = "chart_revisions"
    __table_args__ = (
        ForeignKeyConstraint(["chart_id"], ["charts.id"]),
        ForeignKeyConstraint(["snapshot_id"], ["catalog_snapshots.id"]),
        Index("ix_chart_revision_snapshot_version", "snapshot_id", "intl_version"),
    )

    snapshot_id: Mapped[str] = mapped_column(String(36), primary_key=True)
    chart_id: Mapped[str] = mapped_column(String(40), primary_key=True)
    level: Mapped[str] = mapped_column(String(20))
    base_internal_level: Mapped[Decimal] = mapped_column(Numeric(4, 1))
    note_designer: Mapped[str | None] = mapped_column(String(200), nullable=True)
    tap: Mapped[int] = mapped_column(Integer, default=0)
    hold: Mapped[int] = mapped_column(Integer, default=0)
    slide: Mapped[int] = mapped_column(Integer, default=0)
    touch: Mapped[int] = mapped_column(Integer, default=0)
    break_count: Mapped[int] = mapped_column(Integer, default=0)
    total: Mapped[int] = mapped_column(Integer, default=0)
    is_special: Mapped[bool] = mapped_column(Boolean, default=False)
    base_version: Mapped[str] = mapped_column(String(80))
    intl_version: Mapped[str] = mapped_column(String(80), index=True)
    release_date: Mapped[date | None] = mapped_column(Date, nullable=True)


class ChartAvailability(Base):
    __tablename__ = "chart_availability"

    snapshot_id: Mapped[str] = mapped_column(ForeignKey("catalog_snapshots.id"), primary_key=True)
    chart_id: Mapped[str] = mapped_column(ForeignKey("charts.id"), primary_key=True)
    region: Mapped[str] = mapped_column(String(20), primary_key=True)
    game_version: Mapped[str] = mapped_column(String(80))


class ChartConstant(Base):
    __tablename__ = "chart_constants"

    snapshot_id: Mapped[str] = mapped_column(ForeignKey("catalog_snapshots.id"), primary_key=True)
    chart_id: Mapped[str] = mapped_column(ForeignKey("charts.id"), primary_key=True)
    region: Mapped[str] = mapped_column(String(20), primary_key=True)
    source_id: Mapped[str] = mapped_column(ForeignKey("data_sources.id"), primary_key=True)
    game_version: Mapped[str] = mapped_column(String(80))
    constant_value: Mapped[Decimal] = mapped_column(Numeric(4, 1))
    confidence: Mapped[Decimal] = mapped_column(Numeric(4, 3))
    derivation: Mapped[str] = mapped_column(String(80))


class Tag(Base):
    __tablename__ = "tags"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    group_id: Mapped[int] = mapped_column(Integer)
    name_zh_hans: Mapped[str] = mapped_column(String(120))
    name_en: Mapped[str] = mapped_column(String(120))


class ChartTag(Base):
    __tablename__ = "chart_tags"

    snapshot_id: Mapped[str] = mapped_column(ForeignKey("catalog_snapshots.id"), primary_key=True)
    chart_id: Mapped[str] = mapped_column(ForeignKey("charts.id"), primary_key=True)
    tag_id: Mapped[int] = mapped_column(ForeignKey("tags.id"), primary_key=True)
    source_id: Mapped[str] = mapped_column(ForeignKey("data_sources.id"))
    confidence: Mapped[Decimal] = mapped_column(Numeric(4, 3))
    method: Mapped[str] = mapped_column(String(80))


class PopulationStatistic(Base):
    __tablename__ = "population_statistics"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    chart_id: Mapped[str] = mapped_column(ForeignKey("charts.id"), index=True)
    source_region: Mapped[str] = mapped_column(String(20), index=True)
    source_id: Mapped[str] = mapped_column(ForeignKey("data_sources.id"))
    snapshot_id: Mapped[str] = mapped_column(ForeignKey("catalog_snapshots.id"))
    fit_constant: Mapped[Decimal | None] = mapped_column(Numeric(5, 2), nullable=True)
    average_achievement: Mapped[Decimal | None] = mapped_column(Numeric(7, 4), nullable=True)
    standard_deviation: Mapped[Decimal | None] = mapped_column(Numeric(7, 4), nullable=True)
    sample_count: Mapped[int | None] = mapped_column(Integer, nullable=True)


class PlayerImport(Base):
    __tablename__ = "player_imports"
    __table_args__ = (Index("ix_player_import_owner_created", "owner_id", "created_at"),)

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    owner_id: Mapped[str] = mapped_column(String(64), index=True)
    source_type: Mapped[str] = mapped_column(String(30), default="b50_image")
    status: Mapped[str] = mapped_column(String(30), index=True)
    coverage: Mapped[str] = mapped_column(String(30), default="best50_only")
    catalog_snapshot_id: Mapped[str] = mapped_column(ForeignKey("catalog_snapshots.id"))
    image_fingerprint: Mapped[str] = mapped_column(String(16), index=True)
    image_format: Mapped[str] = mapped_column(String(10))
    image_width: Mapped[int] = mapped_column(Integer)
    image_height: Mapped[int] = mapped_column(Integer)
    source_image_stored: Mapped[bool] = mapped_column(Boolean, default=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), index=True)
    confirmed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)


class ImportEntry(Base):
    __tablename__ = "import_entries"
    __table_args__ = (
        UniqueConstraint("import_id", "chart_id", name="uq_import_chart"),
        Index("ix_import_entry_review", "import_id", "needs_review"),
    )

    import_id: Mapped[str] = mapped_column(ForeignKey("player_imports.id"), primary_key=True)
    slot: Mapped[int] = mapped_column(Integer, primary_key=True)
    bucket: Mapped[str] = mapped_column(String(5), index=True)
    chart_id: Mapped[str | None] = mapped_column(ForeignKey("charts.id"), nullable=True)
    title: Mapped[str | None] = mapped_column(String(300), nullable=True)
    chart_type: Mapped[str | None] = mapped_column(String(20), nullable=True)
    difficulty: Mapped[str | None] = mapped_column(String(30), nullable=True)
    chart_version: Mapped[str | None] = mapped_column(String(80), nullable=True)
    chart_constant: Mapped[Decimal | None] = mapped_column(Numeric(4, 1), nullable=True)
    achievement: Mapped[Decimal | None] = mapped_column(Numeric(7, 4), nullable=True)
    full_combo: Mapped[str | None] = mapped_column(String(12), nullable=True)
    displayed_rating: Mapped[int | None] = mapped_column(Integer, nullable=True)
    calculated_rating: Mapped[int | None] = mapped_column(Integer, nullable=True)
    needs_review: Mapped[bool] = mapped_column(Boolean, default=True, index=True)
    issue_code: Mapped[str | None] = mapped_column(String(50), nullable=True)
    updated_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)


class PlayerScoreSnapshot(Base):
    __tablename__ = "player_score_snapshots"
    __table_args__ = (
        Index("ix_player_score_snapshot_owner_imported", "owner_id", "imported_at"),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    owner_id: Mapped[str] = mapped_column(String(64), index=True)
    schema_version: Mapped[int] = mapped_column(Integer)
    source_region: Mapped[str] = mapped_column(String(20))
    source_name: Mapped[str] = mapped_column(String(80))
    exported_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    imported_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), index=True)
    catalog_snapshot_id: Mapped[str] = mapped_column(ForeignKey("catalog_snapshots.id"))
    status: Mapped[str] = mapped_column(String(30), index=True)
    supplied_count: Mapped[int] = mapped_column(Integer)
    matched_count: Mapped[int] = mapped_column(Integer)
    unmatched_count: Mapped[int] = mapped_column(Integer)
    duplicate_count: Mapped[int] = mapped_column(Integer)


class PlayerScore(Base):
    __tablename__ = "player_scores"
    __table_args__ = (
        Index("ix_player_score_snapshot_chart", "snapshot_id", "chart_id"),
    )

    snapshot_id: Mapped[str] = mapped_column(
        ForeignKey("player_score_snapshots.id"), primary_key=True
    )
    source_index: Mapped[int] = mapped_column(Integer, primary_key=True)
    chart_id: Mapped[str | None] = mapped_column(ForeignKey("charts.id"), nullable=True)
    title: Mapped[str] = mapped_column(String(300))
    chart_type: Mapped[str] = mapped_column(String(20))
    difficulty: Mapped[str] = mapped_column(String(30))
    achievement: Mapped[Decimal] = mapped_column(Numeric(7, 4))
    full_combo: Mapped[str | None] = mapped_column(String(12), nullable=True)
    sync_status: Mapped[str | None] = mapped_column(String(20), nullable=True)
    dx_score: Mapped[int | None] = mapped_column(Integer, nullable=True)
    played_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    match_status: Mapped[str] = mapped_column(String(30), index=True)
    issue_code: Mapped[str | None] = mapped_column(String(50), nullable=True)
