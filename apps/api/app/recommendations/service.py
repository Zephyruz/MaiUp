from __future__ import annotations

import json
from dataclasses import dataclass
from datetime import UTC, datetime
from decimal import Decimal
from statistics import median

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.catalog.covers import cover_urls_for_snapshot
from app.catalog.versioning import VersionPolicy
from app.db.models import (
    CatalogSnapshot,
    Chart,
    ChartConstant,
    ChartRevision,
    ChartTag,
    GameVersion,
    ImportEntry,
    PlayerImport,
    PlayerScore,
    PlayerScoreSnapshot,
    Song,
    Tag,
)
from app.rating.calculator import calculate_chart_rating

ALGORITHM_VERSION = "full-history-personal-fit-v0.8.1"
TARGET_ACHIEVEMENTS = tuple(
    Decimal(value)
    for value in ("97.0000", "98.0000", "99.0000", "99.5000", "100.0000", "100.5000")
)
MIN_BREAK_DAYS = 45
MIN_REENTRY_ACTIVE_DAYS = 3
MIN_REENTRY_CHARTS = 20
MAX_RECENT_CHARTS = 120
MIN_WEAKNESS_SAMPLES = 5


class RecommendationError(ValueError):
    pass


@dataclass(frozen=True)
class ObservedScore:
    bucket: str
    constant: Decimal
    achievement: Decimal


@dataclass(frozen=True)
class PerformanceSample:
    chart_id: str
    bucket: str
    constant: Decimal
    achievement: Decimal
    played_at: datetime | None = None


@dataclass(frozen=True)
class ActivityWindow:
    status: str
    latest_played_at: datetime | None
    break_threshold_days: int
    dated_sample_count: int
    eligible_chart_ids: frozenset[str]
    active_day_count: int
    post_break_chart_count: int


@dataclass(frozen=True)
class TagFact:
    tag_id: int
    group_id: int
    name_en: str
    name_zh_hans: str


STYLE_TAG_GROUPS = {1, 3}
MIN_STRENGTH_SAMPLES = 3


def _first_beating_target(constant: Decimal, threshold: int) -> tuple[Decimal, int] | None:
    for achievement in TARGET_ACHIEVEMENTS:
        rating = calculate_chart_rating(constant, achievement)
        if rating > threshold:
            return achievement, rating
    return None


def _first_improving_target(
    constant: Decimal,
    threshold: int,
    current_achievement: Decimal | None,
) -> tuple[Decimal, int] | None:
    for achievement in TARGET_ACHIEVEMENTS:
        if current_achievement is not None and achievement <= current_achievement:
            continue
        rating = calculate_chart_rating(constant, achievement)
        if rating > threshold:
            return achievement, rating
    return None


def _target_ladder(
    constant: Decimal,
    threshold: int,
    current_achievement: Decimal | None,
    current_rating: int | None = None,
) -> list[dict[str, object]]:
    baseline = max(threshold, current_rating or 0)
    targets: list[dict[str, object]] = []
    for achievement in TARGET_ACHIEVEMENTS:
        if current_achievement is not None and achievement <= current_achievement:
            continue
        rating = calculate_chart_rating(constant, achievement)
        if rating <= baseline:
            continue
        targets.append(
            {
                "achievement": achievement,
                "rating": rating,
                "gain": rating - baseline,
            }
        )
    return targets


def _utc(value: datetime) -> datetime:
    return value.astimezone(UTC) if value.tzinfo else value.replace(tzinfo=UTC)


def _activity_window(
    samples: list[PerformanceSample],
    exported_at: datetime,
) -> ActivityWindow:
    dated = [sample for sample in samples if sample.played_at is not None]
    if not dated:
        return ActivityWindow("unavailable", None, MIN_BREAK_DAYS, 0, frozenset(), 0, 0)

    ordered = sorted(dated, key=lambda sample: _utc(sample.played_at))
    active_dates = sorted({_utc(sample.played_at).date() for sample in ordered})
    gaps = [
        (active_dates[index] - active_dates[index - 1]).days
        for index in range(1, len(active_dates))
    ]
    typical_gap = int(median(gaps)) if gaps else 0
    break_threshold = max(MIN_BREAK_DAYS, typical_gap * 4)
    latest = _utc(ordered[-1].played_at)
    exported = _utc(exported_at)

    if (exported.date() - latest.date()).days > break_threshold:
        return ActivityWindow(
            "inactive",
            latest,
            break_threshold,
            len(dated),
            frozenset(),
            len(active_dates),
            0,
        )

    latest_break_index: int | None = None
    for index, gap in enumerate(gaps, start=1):
        if gap > break_threshold:
            latest_break_index = index

    candidates = ordered
    post_break_count = 0
    if latest_break_index is not None:
        resumed_on = active_dates[latest_break_index]
        candidates = [
            sample for sample in ordered if _utc(sample.played_at).date() >= resumed_on
        ]
        post_break_dates = {_utc(sample.played_at).date() for sample in candidates}
        post_break_count = len(candidates)
        if (
            len(post_break_dates) < MIN_REENTRY_ACTIVE_DAYS
            or post_break_count < MIN_REENTRY_CHARTS
        ):
            return ActivityWindow(
                "reentry",
                latest,
                break_threshold,
                len(dated),
                frozenset(),
                len(post_break_dates),
                post_break_count,
            )

    if len(candidates) < MIN_REENTRY_CHARTS:
        return ActivityWindow(
            "insufficient",
            latest,
            break_threshold,
            len(dated),
            frozenset(),
            len({_utc(sample.played_at).date() for sample in candidates}),
            post_break_count,
        )

    recent = candidates[-MAX_RECENT_CHARTS:]
    return ActivityWindow(
        "ready",
        latest,
        break_threshold,
        len(dated),
        frozenset(sample.chart_id for sample in recent),
        len({_utc(sample.played_at).date() for sample in recent}),
        post_break_count,
    )


def _similar_evidence(
    observations: list[ObservedScore],
    bucket: str,
    constant: Decimal,
    target: Decimal,
) -> dict[str, object]:
    nearby = [
        item
        for item in observations
        if item.bucket == bucket and abs(item.constant - constant) <= Decimal("0.3")
    ]
    hits = sum(item.achievement >= target for item in nearby)
    rate = Decimal(hits) / Decimal(len(nearby)) if nearby else Decimal("0")
    if len(nearby) >= 5 and rate >= Decimal("0.6"):
        strength = "strong"
    elif len(nearby) >= 3 and rate >= Decimal("0.33"):
        strength = "limited"
    else:
        strength = "insufficient"
    return {
        "sampleCount": len(nearby),
        "hitCount": hits,
        "hitRate": rate.quantize(Decimal("0.001")),
        "strength": strength,
        "isSuccessProbability": False,
    }


def _version_policy(session: Session, snapshot: CatalogSnapshot) -> VersionPolicy:
    versions = tuple(session.scalars(select(GameVersion.name).order_by(GameVersion.ordinal)).all())
    current_version = str(json.loads(snapshot.validation_report)["current_version"])
    return VersionPolicy(versions, current_version, b15_version_count=2)


def _profile(samples: list[PerformanceSample], bucket: str) -> dict[str, object]:
    selected = [sample for sample in samples if sample.bucket == bucket]
    constants = [sample.constant for sample in selected]
    achievements = [sample.achievement for sample in selected]
    return {
        "entryCount": len(selected),
        "constantMin": min(constants) if constants else None,
        "constantMax": max(constants) if constants else None,
        "medianAchievement": median(achievements) if achievements else None,
        "atOrAbove100_5": sum(value >= Decimal("100.5") for value in achievements),
    }


def _performance_residuals(samples: list[PerformanceSample]) -> dict[str, Decimal]:
    result: dict[str, Decimal] = {}
    for sample in samples:
        peers = [
            peer.achievement
            for peer in samples
            if peer.bucket == sample.bucket
            and abs(peer.constant - sample.constant) <= Decimal("0.2")
        ]
        if len(peers) < 3:
            continue
        result[sample.chart_id] = sample.achievement - Decimal(str(median(peers)))
    return result


def _strength_profile(
    residuals: dict[str, Decimal],
    tags_by_chart: dict[str, list[TagFact]],
) -> list[dict[str, object]]:
    grouped: dict[int, tuple[TagFact, list[Decimal]]] = {}
    for chart_id, residual in residuals.items():
        for tag in tags_by_chart.get(chart_id, []):
            if tag.group_id not in STYLE_TAG_GROUPS:
                continue
            _fact, values = grouped.setdefault(tag.tag_id, (tag, []))
            values.append(residual)

    qualified = [
        (tag, values, sum(values, Decimal("0")) / Decimal(len(values)))
        for tag, values in grouped.values()
        if len(values) >= MIN_STRENGTH_SAMPLES
    ]
    baseline = (
        Decimal(str(median(item[2] for item in qualified)))
        if len(qualified) >= 3
        else Decimal("0")
    )
    strengths: list[dict[str, object]] = []
    for tag, values, raw_mean in qualified:
        relative_mean = raw_mean - baseline
        shrunk_score = relative_mean * Decimal(len(values)) / Decimal(len(values) + 5)
        if shrunk_score <= Decimal("0.005"):
            continue
        if len(values) >= 8 and shrunk_score >= Decimal("0.050"):
            confidence = "strong"
        elif len(values) >= 5:
            confidence = "limited"
        else:
            confidence = "exploratory"
        strengths.append(
            {
                "tagId": tag.tag_id,
                "nameEn": tag.name_en,
                "nameZhHans": tag.name_zh_hans,
                "sampleCount": len(values),
                "meanResidual": relative_mean.quantize(Decimal("0.0001")),
                "score": shrunk_score.quantize(Decimal("0.0001")),
                "confidence": confidence,
            }
        )
    strengths.sort(
        key=lambda item: (
            -Decimal(str(item["score"])),
            -int(item["sampleCount"]),
            str(item["nameEn"]),
        )
    )
    return strengths[:5]


def _weakness_profile(
    residuals: dict[str, Decimal],
    tags_by_chart: dict[str, list[TagFact]],
) -> list[dict[str, object]]:
    grouped: dict[int, tuple[TagFact, list[Decimal]]] = {}
    for chart_id, residual in residuals.items():
        for tag in tags_by_chart.get(chart_id, []):
            if tag.group_id not in STYLE_TAG_GROUPS:
                continue
            _fact, values = grouped.setdefault(tag.tag_id, (tag, []))
            values.append(residual)

    qualified = [
        (tag, values, sum(values, Decimal("0")) / Decimal(len(values)))
        for tag, values in grouped.values()
        if len(values) >= MIN_WEAKNESS_SAMPLES
    ]
    baseline = (
        Decimal(str(median(item[2] for item in qualified)))
        if len(qualified) >= 3
        else Decimal("0")
    )
    weaknesses: list[dict[str, object]] = []
    for tag, values, raw_mean in qualified:
        relative_mean = raw_mean - baseline
        shrunk_score = relative_mean * Decimal(len(values)) / Decimal(len(values) + 5)
        if shrunk_score >= Decimal("-0.005"):
            continue
        confidence = (
            "strong"
            if len(values) >= 8 and shrunk_score <= Decimal("-0.050")
            else "limited"
        )
        weaknesses.append(
            {
                "tagId": tag.tag_id,
                "nameEn": tag.name_en,
                "nameZhHans": tag.name_zh_hans,
                "sampleCount": len(values),
                "meanResidual": relative_mean.quantize(Decimal("0.0001")),
                "score": shrunk_score.quantize(Decimal("0.0001")),
                "confidence": confidence,
            }
        )
    weaknesses.sort(
        key=lambda item: (
            Decimal(str(item["score"])),
            -int(item["sampleCount"]),
            str(item["nameEn"]),
        )
    )
    return weaknesses[:5]


def _weakness_risk(
    candidate_tags: list[TagFact],
    weaknesses_by_id: dict[int, dict[str, object]],
) -> tuple[str, list[dict[str, object]]]:
    matches = [
        weaknesses_by_id[tag.tag_id]
        for tag in candidate_tags
        if tag.tag_id in weaknesses_by_id
    ]
    matches.sort(key=lambda item: Decimal(str(item["score"])))
    if any(item["confidence"] == "strong" for item in matches):
        return "avoid", matches
    if matches:
        return "caution", matches
    return "none", []


def _outside_candidate_sort_key(candidate: dict[str, object]) -> tuple[object, ...]:
    evidence = candidate["targetEvidence"]
    assert isinstance(evidence, dict)
    return (
        int(evidence["comfortTier"]),
        -Decimal(str(evidence["hitRate"])),
        -int(evidence.get("sampleCount", 0)),
        {"none": 0, "caution": 1, "avoid": 2}.get(
            str(candidate.get("weaknessRisk", "none")), 1
        ),
        0 if candidate["communityDifficulty"] == "water" else 1,
        0 if candidate["recommendationBasis"] == "personalized" else 1,
        Decimal(str(candidate.get("achievementGap") or "999")),
        -int(candidate["conditionalGain"]),
        -Decimal(str(candidate["personalFitScore"])),
        Decimal(str(candidate["targetAchievement"])),
        Decimal(str(candidate["constant"])),
        str(candidate["title"]),
    )


def _community_difficulty(candidate_tags: list[TagFact]) -> str:
    names = {tag.name_en for tag in candidate_tags}
    if "Underrated" in names:
        return "mine"
    if "Overrated" in names:
        return "water"
    return "neutral"


def _proven_ceiling(
    observations: list[ObservedScore],
    bucket: str,
    target: Decimal,
) -> Decimal | None:
    constants = [
        item.constant
        for item in observations
        if item.bucket == bucket and item.achievement >= target
    ]
    return max(constants) if constants else None


def _target_evidence(
    observations: list[ObservedScore],
    bucket: str,
    constant: Decimal,
    target: Decimal,
    candidate_tags: list[TagFact],
) -> dict[str, object] | None:
    exact = [
        item for item in observations if item.bucket == bucket and item.constant == constant
    ]
    comparable = exact or [
        item
        for item in observations
        if item.bucket == bucket and abs(item.constant - constant) <= Decimal("0.1")
    ]
    hits = sum(item.achievement >= target for item in comparable)
    is_water = _community_difficulty(candidate_tags) == "water"
    if hits:
        comfort_tier = 0
        basis = "player_exact" if exact else "player_nearby"
    elif is_water:
        comfort_tier = 1
        basis = "community_water_exception"
    else:
        return None
    hit_rate = Decimal(hits) / Decimal(len(comparable)) if comparable else Decimal("0")
    return {
        "sampleCount": len(comparable),
        "hitCount": hits,
        "hitRate": hit_rate.quantize(Decimal("0.001")),
        "basis": basis,
        "comfortTier": comfort_tier,
        "isSuccessProbability": False,
    }


def _select_diverse_candidates(
    candidates: list[dict[str, object]],
    limit: int,
) -> list[dict[str, object]]:
    ordered = sorted(candidates, key=_outside_candidate_sort_key)
    selected: list[dict[str, object]] = []
    deferred: list[dict[str, object]] = []
    selected_songs: set[str] = set()
    constant_counts: dict[Decimal, int] = {}

    for candidate in ordered:
        title = str(candidate["title"])
        if title in selected_songs:
            continue
        constant = Decimal(str(candidate["constant"]))
        if constant_counts.get(constant, 0) >= 2:
            deferred.append(candidate)
            continue
        selected.append(candidate)
        selected_songs.add(title)
        constant_counts[constant] = constant_counts.get(constant, 0) + 1
        if len(selected) >= limit:
            return sorted(selected, key=_outside_candidate_sort_key)

    for candidate in deferred:
        title = str(candidate["title"])
        if title in selected_songs:
            continue
        selected.append(candidate)
        selected_songs.add(title)
        if len(selected) >= limit:
            break
    return sorted(selected, key=_outside_candidate_sort_key)


def _select_candidate_mix(
    candidates: list[dict[str, object]],
    limit: int,
) -> list[dict[str, object]]:
    if limit <= 0:
        return []
    played = [candidate for candidate in candidates if candidate.get("scoreStatus") == "played"]
    exploration = [
        candidate for candidate in candidates if candidate.get("scoreStatus") != "played"
    ]
    played_limit = min(len(played), max(1, (limit + 1) // 2))
    exploration_limit = min(len(exploration), limit - played_limit)
    remaining = limit - played_limit - exploration_limit
    if remaining:
        played_room = max(0, len(played) - played_limit)
        add_played = min(played_room, remaining)
        played_limit += add_played
        exploration_limit += min(len(exploration) - exploration_limit, remaining - add_played)
    selected = _select_diverse_candidates(played, played_limit)
    selected.extend(_select_diverse_candidates(exploration, exploration_limit))
    return sorted(selected, key=_outside_candidate_sort_key)


def build_recommendations(
    session: Session,
    import_id: str,
    *,
    limit_per_bucket: int = 10,
    owner_id: str = "test-owner",
) -> dict[str, object]:
    player_import = session.get(PlayerImport, import_id)
    if player_import is None or player_import.owner_id != owner_id:
        raise RecommendationError("Import not found")
    if player_import.status != "confirmed":
        raise RecommendationError("Confirm all 50 entries before generating recommendations")
    snapshot = session.get(CatalogSnapshot, player_import.catalog_snapshot_id)
    if snapshot is None:
        raise RecommendationError("Catalog snapshot is unavailable")

    entries = list(
        session.scalars(
            select(ImportEntry)
            .where(ImportEntry.import_id == import_id)
            .order_by(ImportEntry.slot)
        ).all()
    )
    if len(entries) != 50 or any(entry.calculated_rating is None for entry in entries):
        raise RecommendationError("Confirmed import does not contain 50 calculated ratings")

    thresholds = {
        bucket: min(
            entry.calculated_rating
            for entry in entries
            if entry.bucket == bucket and entry.calculated_rating is not None
        )
        for bucket in ("b35", "b15")
    }
    policy = _version_policy(session, snapshot)
    score_snapshot = session.get(PlayerScoreSnapshot, import_id)
    if score_snapshot is not None and score_snapshot.owner_id != owner_id:
        score_snapshot = None
    b50_samples = [
        PerformanceSample(
            chart_id=entry.chart_id,
            bucket=entry.bucket,
            constant=entry.chart_constant,
            achievement=entry.achievement,
        )
        for entry in entries
        if entry.chart_id is not None
        and entry.chart_constant is not None
        and entry.achievement is not None
    ]
    full_scores_by_chart: dict[str, tuple[PlayerScore, Decimal, str]] = {}
    if player_import.coverage == "full_scores":
        full_score_rows = session.execute(
            select(PlayerScore, ChartRevision, ChartConstant)
            .join(
                ChartRevision,
                (ChartRevision.chart_id == PlayerScore.chart_id)
                & (ChartRevision.snapshot_id == snapshot.id),
            )
            .join(
                ChartConstant,
                (ChartConstant.chart_id == PlayerScore.chart_id)
                & (ChartConstant.snapshot_id == snapshot.id),
            )
            .where(
                PlayerScore.snapshot_id == import_id,
                PlayerScore.chart_id.is_not(None),
                PlayerScore.match_status.in_(("matched", "matched_type_corrected")),
                ChartRevision.is_special.is_(False),
            )
            .order_by(ChartConstant.confidence.desc())
        ).all()
        for score, revision, constant in full_score_rows:
            if score.chart_id is None or score.chart_id in full_scores_by_chart:
                continue
            bucket = policy.bucket_for(revision.intl_version)
            if bucket is None:
                continue
            full_scores_by_chart[score.chart_id] = (
                score,
                constant.constant_value,
                bucket,
            )
    performance_samples = (
        [
            PerformanceSample(
                chart_id=chart_id,
                bucket=bucket,
                constant=constant,
                achievement=score.achievement,
                played_at=score.played_at,
            )
            for chart_id, (score, constant, bucket) in full_scores_by_chart.items()
        ]
        or b50_samples
    )
    observations = [
        ObservedScore(sample.bucket, sample.constant, sample.achievement)
        for sample in performance_samples
    ]
    cover_urls = cover_urls_for_snapshot(snapshot)
    current_chart_ids = {entry.chart_id for entry in entries if entry.chart_id}
    chart_song_ids = dict(
        session.execute(
            select(Chart.id, Chart.song_id).where(Chart.id.in_(current_chart_ids))
        ).all()
    )
    tag_rows = session.execute(
        select(
            ChartTag.chart_id,
            Tag.id,
            Tag.group_id,
            Tag.name_en,
            Tag.name_zh_hans,
        )
        .join(Tag, Tag.id == ChartTag.tag_id)
        .where(ChartTag.snapshot_id == snapshot.id)
    ).all()
    tags_by_chart: dict[str, list[TagFact]] = {}
    for chart_id, tag_id, group_id, name_en, name_zh_hans in tag_rows:
        tags_by_chart.setdefault(chart_id, []).append(
            TagFact(tag_id, group_id, name_en, name_zh_hans)
        )
    residuals = _performance_residuals(performance_samples)
    strengths = _strength_profile(residuals, tags_by_chart)
    strengths_by_id = {int(item["tagId"]): item for item in strengths}
    activity = _activity_window(
        performance_samples,
        score_snapshot.exported_at if score_snapshot is not None else datetime.now(UTC),
    )
    recent_samples = [
        sample for sample in performance_samples if sample.chart_id in activity.eligible_chart_ids
    ]
    recent_weaknesses = (
        _weakness_profile(_performance_residuals(recent_samples), tags_by_chart)
        if activity.status == "ready"
        else []
    )
    historical_weaknesses = _weakness_profile(residuals, tags_by_chart)
    displayed_weaknesses = (
        recent_weaknesses if activity.status == "ready" else historical_weaknesses
    )
    weaknesses_by_id = {int(item["tagId"]): item for item in recent_weaknesses}

    in_list: list[dict[str, object]] = []
    for entry in entries:
        if (
            entry.chart_constant is None
            or entry.achievement is None
            or entry.calculated_rating is None
        ):
            continue
        ladder = _target_ladder(
            entry.chart_constant,
            0,
            entry.achievement,
            entry.calculated_rating,
        )
        if not ladder:
            continue
        primary_target = ladder[0]
        target = Decimal(str(primary_target["achievement"]))
        target_rating = int(primary_target["rating"])
        gain = target_rating - entry.calculated_rating
        if gain <= 0:
            continue
        weakness_risk, weakness_reasons = _weakness_risk(
            tags_by_chart.get(entry.chart_id or "", []), weaknesses_by_id
        )
        if weakness_risk == "avoid":
            continue
        evidence = _similar_evidence(observations, entry.bucket, entry.chart_constant, target)
        in_list.append(
            {
                "kind": "in_list",
                "slot": entry.slot,
                "chartId": entry.chart_id,
                "title": entry.title,
                "coverUrl": cover_urls.get(chart_song_ids.get(entry.chart_id, "")),
                "chartType": entry.chart_type,
                "difficulty": entry.difficulty,
                "bucket": entry.bucket,
                "constant": entry.chart_constant,
                "currentAchievement": entry.achievement,
                "currentRating": entry.calculated_rating,
                "targetAchievement": target,
                "targetRating": target_rating,
                "conditionalGain": gain,
                "achievementGap": target - entry.achievement,
                "targetOptions": ladder,
                "weaknessRisk": weakness_risk,
                "weaknessReasons": weakness_reasons[:3],
                "evidence": evidence,
                "fact": (
                    f"达到 {target}% 时，按当前图片定数可从 {entry.calculated_rating} "
                    f"升至 {target_rating} Rating"
                ),
            }
        )
    in_list.sort(
        key=lambda item: (
            1 if item["weaknessRisk"] == "caution" else 0,
            Decimal(str(item["targetAchievement"]))
            - Decimal(str(item["currentAchievement"])),
            -int(item["conditionalGain"]),
            int(item["slot"]),
        )
    )

    catalog_rows = session.execute(
        select(Chart, Song, ChartRevision, ChartConstant)
        .join(Song, Song.id == Chart.song_id)
        .join(
            ChartRevision,
            (ChartRevision.chart_id == Chart.id)
            & (ChartRevision.snapshot_id == snapshot.id),
        )
        .join(
            ChartConstant,
            (ChartConstant.chart_id == Chart.id)
            & (ChartConstant.snapshot_id == snapshot.id),
        )
        .where(ChartRevision.is_special.is_(False))
        .order_by(ChartConstant.confidence.desc())
    ).all()
    seen_charts: set[str] = set()
    outside_by_bucket: dict[str, list[dict[str, object]]] = {"b35": [], "b15": []}
    profile_by_bucket = {
        bucket: _profile(performance_samples, bucket) for bucket in ("b35", "b15")
    }
    for chart, song, revision, constant in catalog_rows:
        if chart.id in seen_charts:
            continue
        seen_charts.add(chart.id)
        if chart.id in current_chart_ids:
            continue
        bucket = policy.bucket_for(revision.intl_version)
        if bucket is None:
            continue
        maximum = profile_by_bucket[bucket]["constantMax"]
        if maximum is None or constant.constant_value > Decimal(str(maximum)):
            continue
        candidate_tags = tags_by_chart.get(chart.id, [])
        community_difficulty = _community_difficulty(candidate_tags)
        if community_difficulty == "mine":
            continue
        fit_reasons = [
            strengths_by_id[tag.tag_id]
            for tag in candidate_tags
            if tag.tag_id in strengths_by_id
        ]
        fit_reasons.sort(key=lambda item: -Decimal(str(item["score"])))
        personal_fit_score = sum(
            (Decimal(str(item["score"])) for item in fit_reasons),
            Decimal("0"),
        )
        weakness_risk, weakness_reasons = _weakness_risk(
            candidate_tags, weaknesses_by_id
        )
        if weakness_risk == "avoid":
            continue
        played = full_scores_by_chart.get(chart.id)
        current_achievement = played[0].achievement if played is not None else None
        current_rating = (
            calculate_chart_rating(constant.constant_value, current_achievement)
            if current_achievement is not None
            else None
        )
        ladder = _target_ladder(
            constant.constant_value,
            thresholds[bucket],
            current_achievement,
            current_rating,
        )
        if not ladder:
            continue
        primary_target = ladder[0]
        target_achievement = Decimal(str(primary_target["achievement"]))
        target_rating = int(primary_target["rating"])
        proven_ceiling = _proven_ceiling(observations, bucket, target_achievement)
        if (
            proven_ceiling is None
            or constant.constant_value > proven_ceiling + Decimal("0.1")
        ):
            continue
        target_evidence = _target_evidence(
            observations,
            bucket,
            constant.constant_value,
            target_achievement,
            candidate_tags,
        )
        if target_evidence is None:
            continue
        evidence = _similar_evidence(
            observations,
            bucket,
            constant.constant_value,
            target_achievement,
        )
        outside_by_bucket[bucket].append(
            {
                "kind": "outside_b50",
                "strategy": (
                    "steady"
                    if target_achievement <= Decimal("100.0000")
                    else "sprint"
                ),
                "chartId": chart.id,
                "title": song.title,
                "coverUrl": cover_urls.get(song.id),
                "artist": song.artist,
                "chartType": chart.chart_type,
                "difficulty": chart.difficulty,
                "bucket": bucket,
                "version": revision.intl_version,
                "constant": constant.constant_value,
                "constantConfidence": constant.confidence,
                "constantDerivation": constant.derivation,
                "currentAchievement": current_achievement,
                "currentRating": current_rating,
                "scoreStatus": (
                    "played"
                    if played is not None
                    else "no_record"
                    if full_scores_by_chart
                    else "unknown"
                ),
                "targetAchievement": target_achievement,
                "targetRating": target_rating,
                "targetOptions": ladder,
                "replacementThreshold": thresholds[bucket],
                "conditionalGain": target_rating - thresholds[bucket],
                "achievementGap": (
                    target_achievement - current_achievement
                    if current_achievement is not None
                    else None
                ),
                "personalFitScore": personal_fit_score.quantize(Decimal("0.0001")),
                "recommendationBasis": (
                    "personalized" if fit_reasons else "comfort_fallback"
                ),
                "communityDifficulty": community_difficulty,
                "weaknessRisk": weakness_risk,
                "weaknessReasons": weakness_reasons[:3],
                "fitReasons": [
                    {
                        "nameEn": item["nameEn"],
                        "nameZhHans": item["nameZhHans"],
                        "sampleCount": item["sampleCount"],
                        "confidence": item["confidence"],
                    }
                    for item in fit_reasons[:3]
                ],
                "targetEvidence": target_evidence,
                "evidence": evidence,
                "fact": (
                    (
                        f"当前成绩 {current_achievement}%；"
                        if current_achievement is not None
                        else "完整成绩中未找到这张谱的成绩；"
                        if full_scores_by_chart
                        else "未进入当前 B50；"
                    )
                    + f"若达到 {target_achievement}% 并替换 "
                    f"{bucket.upper()} 最低项，可条件增加 "
                    f"{target_rating - thresholds[bucket]} Rating"
                ),
            }
        )

    outside: list[dict[str, object]] = []
    for bucket, candidates in outside_by_bucket.items():
        bucket_limit = limit_per_bucket + 4 if bucket == "b15" else limit_per_bucket
        outside.extend(_select_candidate_mix(candidates, bucket_limit))

    return {
        "importId": import_id,
        "status": "experimental",
        "algorithmVersion": ALGORITHM_VERSION,
        "coverage": player_import.coverage,
        "totalRating": sum(entry.calculated_rating or 0 for entry in entries),
        "thresholds": thresholds,
        "profile": profile_by_bucket,
        "personalProfile": {
            "method": (
                "all matched scores: same-bucket nearby-constant residual with sample shrinkage"
                if full_scores_by_chart
                else "B50 only: same-bucket nearby-constant residual with sample shrinkage"
            ),
            "sampleCount": len(performance_samples),
            "strengths": strengths,
            "isCausal": False,
        },
        "weaknessProfile": {
            "status": activity.status,
            "method": "recent active-window same-bucket nearby-constant residual",
            "datedSampleCount": activity.dated_sample_count,
            "eligibleSampleCount": len(activity.eligible_chart_ids),
            "activeDayCount": activity.active_day_count,
            "postBreakChartCount": activity.post_break_chart_count,
            "breakThresholdDays": activity.break_threshold_days,
            "latestPlayedAt": (
                activity.latest_played_at.isoformat()
                if activity.latest_played_at is not None
                else None
            ),
            "weaknesses": displayed_weaknesses,
            "basis": (
                "recent_active_window"
                if activity.status == "ready"
                else "all_history_preview"
            ),
            "appliedToRecommendations": activity.status == "ready",
            "isExperimental": True,
            "usesBestScoreAsCurrentAbility": True,
        },
        "inList": in_list[:4],
        "outside": outside,
        "provenance": {
            "catalogSnapshotId": snapshot.id,
            "catalogSource": "DXRating public community catalog",
            "constantsAreOfficial": False,
            "coverSource": "arcade-songs public cover CDN (remote, not stored locally)",
        },
        "caveats": [
            (
                "相近定数证据来自本次完整成绩，不是真实成功率。"
                if full_scores_by_chart
                else "相近定数证据来自已筛选的 B50，不是真实成功率。"
            ),
            (
                "“无成绩记录”只表示本次 DX NET 导出中未找到，不等同于绝对未游玩。"
                if full_scores_by_chart
                else "未进入当前 B50 不代表未游玩。"
            ),
            "榜外候选定数来自 DXRating 社区目录，需与 International 实机核对。",
            (
                "优势标签来自完整成绩中的同分区、邻近定数相对表现，不代表因果能力。"
                if full_scores_by_chart
                else "优势标签来自被筛选后的 B50，只表示已证明的相对表现，不代表因果能力。"
            ),
            "谱面通常包含多种元素；匹配某个标签不代表它是该谱面的唯一类型。",
            "DXRating 社区“水”标签会作为正向信号；“诈称谱”默认从上分推荐排除。",
            "超出本人已证明目标的谱面默认不推荐；社区标记为“水”时才作为低优先级例外。",
            (
                "弱势项只使用当前活跃窗口内、带最后游玩日期的成绩；长时间停玩或回坑样本不足时自动暂停。"
                if activity.status == "ready"
                else "当前没有足够的近期活跃样本，弱势项过滤已暂停。"
            ),
            "最后游玩日期不等于该次成绩日期；弱势项仍是实验性风险提示，不是能力定论。",
            "榜外增益是假设达到目标成绩并替换当前最低项后的条件增益。",
        ],
    }
