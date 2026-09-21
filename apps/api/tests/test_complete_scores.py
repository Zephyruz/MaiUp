from datetime import UTC, date, datetime
from decimal import Decimal

import pytest
from pydantic import ValidationError
from sqlalchemy import create_engine, event, select
from sqlalchemy.orm import Session

from app.api.schemas import CompleteScoreImportRequest
from app.db.base import Base
from app.db.models import (
    CatalogSnapshot,
    Chart,
    ChartRevision,
    DataSource,
    PlayerScore,
    Song,
)
from app.imports.complete_scores import (
    CompleteScoreImportError,
    get_complete_score_import,
    import_complete_scores,
)


@pytest.fixture
def session() -> Session:
    engine = create_engine("sqlite:///:memory:")

    @event.listens_for(engine, "connect")
    def enable_foreign_keys(dbapi_connection, _connection_record) -> None:
        cursor = dbapi_connection.cursor()
        cursor.execute("PRAGMA foreign_keys=ON")
        cursor.close()

    Base.metadata.create_all(engine)
    with Session(engine, expire_on_commit=False) as db:
        db.add(
            DataSource(
                id="source",
                name="fixture",
                url="https://example.invalid",
                region_scope="intl",
                trust_level="fixture",
                license_note="test fixture",
            )
        )
        db.flush()
        db.add(
            CatalogSnapshot(
                id="snapshot",
                source_id="source",
                schema_version=1,
                source_updated_at="2026-01-01T00:00:00Z",
                content_hash="b" * 64,
                fetched_at=datetime.now(UTC),
                published_at=datetime.now(UTC),
                status="published",
                song_count=1,
                chart_count=1,
                warning_count=0,
                validation_report="{}",
            )
        )
        db.flush()
        db.add(
            Song(
                id="song",
                title="Test Song",
                artist="artist",
                category="category",
                bpm=Decimal("180"),
                source_version="CURRENT",
                is_locked=False,
            )
        )
        db.flush()
        db.add(Chart(id="chart", song_id="song", chart_type="dx", difficulty="master"))
        db.flush()
        db.add(
            ChartRevision(
                snapshot_id="snapshot",
                chart_id="chart",
                level="13+",
                base_internal_level=Decimal("13.8"),
                tap=1,
                hold=1,
                slide=1,
                touch=1,
                break_count=1,
                total=5,
                is_special=False,
                base_version="CURRENT",
                intl_version="CURRENT",
                release_date=date(2026, 1, 1),
            )
        )
        db.commit()
        yield db


def payload(scores: list[dict[str, object]]) -> CompleteScoreImportRequest:
    return CompleteScoreImportRequest.model_validate(
        {
            "schemaVersion": 1,
            "sourceRegion": "international",
            "sourceName": "test",
            "exportedAt": "2026-09-10T00:00:00Z",
            "scores": scores,
        }
    )


def test_import_matches_exact_chart_and_reports_coverage(session: Session) -> None:
    result = import_complete_scores(
        session,
        payload(
            [
                {
                    "title": "  TEST   song ",
                    "chartType": "dx",
                    "difficulty": "master",
                    "achievement": "100.1234",
                    "fullCombo": "FC+",
                },
                {
                    "title": "Unknown",
                    "chartType": "std",
                    "difficulty": "expert",
                    "achievement": "99.0000",
                },
            ]
        ),
    )
    assert result["status"] == "needs_review"
    assert result["matchedCount"] == 1
    assert result["unmatchedCount"] == 1
    assert result["coverageRatio"] == Decimal("0.5000")
    assert result["issues"][0]["issueCode"] == "chart_not_found"
    assert get_complete_score_import(session, result["id"]) == result


def test_complete_import_is_hidden_from_another_owner(session: Session) -> None:
    result = import_complete_scores(
        session,
        payload(
            [
                {
                    "title": "Test Song",
                    "chartType": "dx",
                    "difficulty": "master",
                    "achievement": "100.0000",
                }
            ]
        ),
        owner_id="alice",
    )

    with pytest.raises(CompleteScoreImportError, match="not found"):
        get_complete_score_import(session, result["id"], owner_id="bob")


def test_duplicate_chart_keeps_highest_achievement(session: Session) -> None:
    result = import_complete_scores(
        session,
        payload(
            [
                {
                    "title": "Test Song",
                    "chartType": "dx",
                    "difficulty": "master",
                    "achievement": achievement,
                }
                for achievement in ("99.0000", "100.5000")
            ]
        ),
    )
    assert result["matchedCount"] == 1
    assert result["duplicateCount"] == 1
    scores = session.query(PlayerScore).order_by(PlayerScore.source_index).all()
    assert scores[0].match_status == "duplicate_ignored"
    assert scores[1].match_status == "matched"


def test_import_safely_corrects_wrong_chart_type(session: Session) -> None:
    result = import_complete_scores(
        session,
        payload(
            [
                {
                    "title": "Test Song",
                    "chartType": "std",
                    "difficulty": "master",
                    "achievement": "100.0000",
                }
            ]
        ),
    )
    score = session.scalar(select(PlayerScore).where(PlayerScore.snapshot_id == result["id"]))
    assert result["matchedCount"] == 1
    assert result["coverageRatio"] == Decimal("1.0000")
    assert score is not None
    assert score.chart_id == "chart"
    assert score.chart_type == "dx"
    assert score.match_status == "matched_type_corrected"


def test_import_disambiguates_same_title_from_distinctive_difficulty_level(
    session: Session,
) -> None:
    for song_id, artist in (("link-a", "Artist A"), ("link-b", "Artist B")):
        session.add(
            Song(
                id=song_id,
                title="Link",
                artist=artist,
                category="category",
                bpm=Decimal("180"),
                source_version="OLD",
                is_locked=False,
            )
        )
    session.flush()
    for song_id, advanced_level in (("link-a", "8+"), ("link-b", "8")):
        for difficulty, level in (("advanced", advanced_level), ("master", "12")):
            chart_id = f"{song_id}-{difficulty}"
            session.add(
                Chart(
                    id=chart_id,
                    song_id=song_id,
                    chart_type="std",
                    difficulty=difficulty,
                )
            )
            session.flush()
            session.add(
                ChartRevision(
                    snapshot_id="snapshot",
                    chart_id=chart_id,
                    level=level,
                    base_internal_level=Decimal("8.9" if level == "8+" else level),
                    tap=1,
                    hold=1,
                    slide=1,
                    touch=0,
                    break_count=1,
                    total=4,
                    is_special=False,
                    base_version="OLD",
                    intl_version="OLD",
                    release_date=date(2020, 1, 1),
                )
            )
    session.commit()

    result = import_complete_scores(
        session,
        payload(
            [
                {
                    "title": "Link",
                    "chartType": "std",
                    "difficulty": "advanced",
                    "achievement": "100.9375",
                    "displayedLevel": "8.7",
                },
                {
                    "title": "Link",
                    "chartType": "std",
                    "difficulty": "master",
                    "achievement": "100.7639",
                    "displayedLevel": "12",
                },
            ]
        ),
    )

    scores = session.scalars(
        select(PlayerScore)
        .where(PlayerScore.snapshot_id == result["id"])
        .order_by(PlayerScore.source_index)
    ).all()
    assert result["unmatchedCount"] == 0
    assert [score.chart_id for score in scores] == [
        "link-a-advanced",
        "link-a-master",
    ]


def test_import_disambiguates_same_title_by_dx_score_max(session: Session) -> None:
    for song_id, note_total in (("same-a", 278), ("same-b", 124)):
        session.add(
            Song(
                id=song_id,
                title="Same Title",
                artist=song_id,
                category="category",
                bpm=Decimal("180"),
                source_version="OLD",
                is_locked=False,
            )
        )
        session.flush()
        chart_id = f"{song_id}-basic"
        session.add(
            Chart(
                id=chart_id,
                song_id=song_id,
                chart_type="std",
                difficulty="basic",
            )
        )
        session.flush()
        session.add(
            ChartRevision(
                snapshot_id="snapshot",
                chart_id=chart_id,
                level="6",
                base_internal_level=Decimal("6.0"),
                tap=note_total,
                hold=0,
                slide=0,
                touch=0,
                break_count=0,
                total=note_total,
                is_special=False,
                base_version="OLD",
                intl_version="OLD",
                release_date=date(2020, 1, 1),
            )
        )
    session.commit()

    result = import_complete_scores(
        session,
        payload(
            [
                {
                    "title": "Same Title",
                    "chartType": "std",
                    "difficulty": "basic",
                    "achievement": "100.0000",
                    "displayedLevel": "6",
                    "dxScore": 800,
                    "dxScoreMax": 834,
                }
            ]
        ),
    )

    score = session.scalar(select(PlayerScore).where(PlayerScore.snapshot_id == result["id"]))
    assert result["unmatchedCount"] == 0
    assert score is not None
    assert score.chart_id == "same-a-basic"


def test_schema_rejects_wrong_region_and_over_precise_achievement() -> None:
    with pytest.raises(ValidationError):
        payload(
            [
                {
                    "title": "Test Song",
                    "chartType": "dx",
                    "difficulty": "master",
                    "achievement": "100.12345",
                }
            ]
        )
