'use client';

/* oxlint-disable next/no-html-link-for-pages -- Full navigation is more reliable through the mobile preview gateway. */

import { useEffect, useMemo, useState } from 'react';
import Image from 'next/image';
import { useParams } from 'next/navigation';
import {
  ArrowLeft,
  Database,
  Download,
  Loader2,
  Music2,
  ShieldAlert,
  Target,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { apiFetch } from '@/lib/api';

type Evidence = {
  sampleCount: number;
  hitCount: number;
  hitRate: string;
  strength: 'strong' | 'limited' | 'insufficient';
  isSuccessProbability: false;
};

type StrengthConfidence = 'strong' | 'limited' | 'exploratory';

type FitReason = {
  nameEn: string;
  nameZhHans: string;
  sampleCount: number;
  confidence: StrengthConfidence;
};

type TargetEvidence = {
  sampleCount: number;
  hitCount: number;
  hitRate: string;
  basis: 'player_exact' | 'player_nearby' | 'community_water_exception';
  comfortTier: 0 | 1;
  isSuccessProbability: false;
};

type PersonalStrength = FitReason & {
  tagId: number;
  meanResidual: string;
  score: string;
};

type TargetOption = {
  achievement: string;
  rating: number;
  gain: number;
};

type WeaknessItem = PersonalStrength;

type WeaknessProfile = {
  status: 'unavailable' | 'inactive' | 'reentry' | 'insufficient' | 'ready';
  datedSampleCount: number;
  eligibleSampleCount: number;
  activeDayCount: number;
  postBreakChartCount: number;
  breakThresholdDays: number;
  latestPlayedAt?: string | null;
  weaknesses: WeaknessItem[];
  basis: 'recent_active_window' | 'all_history_preview';
  appliedToRecommendations: boolean;
  isExperimental: true;
  usesBestScoreAsCurrentAbility: true;
};

type Recommendation = {
  kind: 'in_list' | 'outside_b50';
  strategy?: 'steady' | 'sprint';
  slot?: number;
  chartId: string;
  title: string;
  coverUrl?: string | null;
  artist?: string;
  chartType: string;
  difficulty: string;
  bucket: 'b35' | 'b15';
  version?: string;
  constant: string;
  currentAchievement?: string;
  currentRating?: number;
  scoreStatus?: 'played' | 'no_record' | 'unknown';
  targetAchievement: string;
  targetRating: number;
  targetOptions?: TargetOption[];
  replacementThreshold?: number;
  conditionalGain: number;
  achievementGap?: string;
  personalFitScore?: string;
  fitReasons?: FitReason[];
  targetEvidence?: TargetEvidence;
  communityDifficulty?: 'water' | 'mine' | 'neutral';
  recommendationBasis?: 'personalized' | 'comfort_fallback';
  weaknessRisk?: 'none' | 'caution' | 'avoid';
  weaknessReasons?: WeaknessItem[];
  evidence: Evidence;
  constantDerivation?: string;
  fact: string;
};

type RecommendationResult = {
  importId: string;
  status: 'experimental';
  algorithmVersion: string;
  coverage: 'best50_only' | 'full_scores';
  totalRating: number;
  thresholds: { b35: number; b15: number };
  profile: Record<
    'b35' | 'b15',
    {
      entryCount: number;
      constantMin: string;
      constantMax: string;
      medianAchievement: string;
      atOrAbove100_5: number;
    }
  >;
  personalProfile: {
    method: string;
    sampleCount: number;
    strengths: PersonalStrength[];
    isCausal: false;
  };
  weaknessProfile: WeaknessProfile;
  inList: Recommendation[];
  outside: Recommendation[];
  provenance: {
    catalogSnapshotId: string;
    catalogSource: string;
    constantsAreOfficial: false;
  };
  caveats: string[];
};

function tagLabel(item: { nameEn: string; nameZhHans: string }) {
  return item.nameZhHans || item.nameEn;
}

const difficultyLabels: Record<string, string> = {
  basic: 'BASIC',
  advanced: 'ADVANCED',
  expert: 'EXPERT',
  master: 'MASTER',
  remaster: 'Re:MASTER',
};

function compactTags(item: Recommendation) {
  const tags = item.fitReasons?.map(tagLabel) ?? [];
  if (item.communityDifficulty === 'water') tags.unshift('DXRating 水歌');
  if (item.communityDifficulty === 'mine') tags.unshift('DXRating 地雷');
  if (item.weaknessRisk === 'caution') {
    const reasons = item.weaknessReasons?.map(
      (reason) => `弱项：${tagLabel(reason)}`,
    );
    tags.unshift(...(reasons?.length ? reasons : ['弱项样本：谨慎']));
  }
  return [...new Set(tags)].slice(0, 3);
}

function activitySummary(profile: WeaknessProfile) {
  switch (profile.status) {
    case 'ready':
      return `近期弱势避让已启用：${profile.eligibleSampleCount} 张带日期成绩、${profile.activeDayCount} 个活跃日。`;
    case 'inactive':
      return `距最后一次记录已超过动态停玩阈值（${profile.breakThresholdDays} 天），自动避让暂停；下方仍显示全成绩历史倾向。`;
    case 'reentry':
      return `检测到长假或长期停玩后的回坑阶段：目前 ${profile.activeDayCount}/3 个活跃日、${profile.postBreakChartCount}/20 张谱；样本足够前不按旧弱项避让，但保留历史倾向供参考。`;
    case 'insufficient':
      return '近期日期样本不足 20 张，因此不自动避让；下方弱项是全成绩历史倾向。';
    default:
      return '本次导出没有取得最后游玩日期，因此不自动避让；下方弱项仍按全部成绩计算。';
  }
}

function fitCanvasText(
  context: CanvasRenderingContext2D,
  text: string,
  maxWidth: number,
) {
  if (context.measureText(text).width <= maxWidth) return text;
  let shortened = text;
  while (
    shortened.length > 1 &&
    context.measureText(`${shortened}…`).width > maxWidth
  ) {
    shortened = shortened.slice(0, -1);
  }
  return `${shortened}…`;
}

async function loadCover(url?: string | null) {
  if (!url) return null;
  try {
    const response = await fetch(url, { mode: 'cors' });
    if (!response.ok) return null;
    return await createImageBitmap(await response.blob());
  } catch {
    return null;
  }
}

async function downloadRecommendationImage(result: RecommendationResult) {
  const width = 1600;
  const margin = 40;
  const columns = 4;
  const gap = 14;
  const cardHeight = 150;
  const cardWidth = (width - margin * 2 - gap * (columns - 1)) / columns;
  const sectionHeaderHeight = 52;
  const headerHeight = 168;
  const footerHeight = 54;
  const groups = (['b35', 'b15'] as const).map((bucket) => ({
    bucket,
    items: result.outside.filter((item) => item.bucket === bucket),
  }));
  const sectionHeight = (count: number) =>
    sectionHeaderHeight + Math.ceil(count / columns) * (cardHeight + gap);
  const height =
    headerHeight +
    groups.reduce((sum, group) => sum + sectionHeight(group.items.length), 0) +
    footerHeight;
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('浏览器无法创建图片画布');

  const covers = await Promise.all(
    result.outside.map((item) => loadCover(item.coverUrl)),
  );
  const coverMap = new Map(
    result.outside.map((item, index) => [item.chartId, covers[index]]),
  );
  const background = context.createLinearGradient(0, 0, width, height);
  background.addColorStop(0, '#07131f');
  background.addColorStop(0.55, '#0b1728');
  background.addColorStop(1, '#1a0d25');
  context.fillStyle = background;
  context.fillRect(0, 0, width, height);

  context.fillStyle = '#67e8f9';
  context.font = '800 28px "Segoe UI", "PingFang SC", sans-serif';
  context.fillText('MaiUp · SCORE PLAN', margin, 48);
  context.fillStyle = '#f8fafc';
  context.font = '900 66px "Segoe UI", "PingFang SC", sans-serif';
  context.fillText('上分推荐', margin, 119);
  context.textAlign = 'right';
  context.fillStyle = '#f8fafc';
  context.font = '900 42px Consolas, monospace';
  context.fillText(`${result.totalRating}`, width - margin, 83);
  context.fillStyle = '#94a3b8';
  context.font = '700 18px "Segoe UI", "PingFang SC", sans-serif';
  context.fillText(
    `当前 Rating · B35 门槛 ${result.thresholds.b35} · B15 门槛 ${result.thresholds.b15}`,
    width - margin,
    116,
  );
  context.textAlign = 'left';

  let top = headerHeight;
  for (const group of groups) {
    const accent = group.bucket === 'b35' ? '#67e8f9' : '#bef264';
    context.fillStyle = accent;
    context.font = '900 27px "Segoe UI", "PingFang SC", sans-serif';
    context.fillText(
      `${group.bucket.toUpperCase()} · ${group.items.length} 首`,
      margin,
      top + 30,
    );
    const cardsTop = top + sectionHeaderHeight;

    group.items.forEach((item, index) => {
      const column = index % columns;
      const row = Math.floor(index / columns);
      const x = margin + column * (cardWidth + gap);
      const y = cardsTop + row * (cardHeight + gap);
      context.fillStyle = '#111d2f';
      context.beginPath();
      context.roundRect(x, y, cardWidth, cardHeight, 14);
      context.fill();
      context.fillStyle = accent;
      context.fillRect(x, y, 7, cardHeight);

      const cover = coverMap.get(item.chartId);
      context.save();
      context.beginPath();
      context.roundRect(x + 17, y + 18, 82, 82, 10);
      context.clip();
      if (cover) {
        context.drawImage(cover, x + 17, y + 18, 82, 82);
      } else {
        context.fillStyle = '#263449';
        context.fillRect(x + 17, y + 18, 82, 82);
      }
      context.restore();

      const contentX = x + 112;
      const contentWidth = cardWidth - 128;
      context.fillStyle = accent;
      context.font = '800 14px Consolas, monospace';
      context.fillText(
        `${group.bucket.toUpperCase()} #${index + 1}`,
        contentX,
        y + 21,
      );
      context.textAlign = 'right';
      context.font = '900 19px Consolas, monospace';
      context.fillText(
        `+${item.conditionalGain} Ra`,
        x + cardWidth - 14,
        y + 22,
      );
      context.textAlign = 'left';

      context.fillStyle = '#f8fafc';
      context.font =
        '800 18px "Segoe UI", "Yu Gothic UI", "PingFang SC", sans-serif';
      context.fillText(
        fitCanvasText(context, item.title, contentWidth),
        contentX,
        y + 48,
      );
      context.fillStyle = '#94a3b8';
      context.font = '700 13px "Segoe UI", "PingFang SC", sans-serif';
      const versionText = item.version ? ` · ${item.version}` : '';
      context.fillText(
        fitCanvasText(
          context,
          `${item.chartType.toUpperCase()} · ${difficultyLabels[item.difficulty] ?? item.difficulty}${versionText} · 定数 ${item.constant}`,
          contentWidth,
        ),
        contentX,
        y + 72,
      );
      context.fillStyle = '#bae6fd';
      context.font = '800 14px Consolas, monospace';
      const current = item.currentAchievement
        ? `${Number(item.currentAchievement).toFixed(4)}%`
        : '无记录';
      context.fillText(
        `当前 ${current}  →  ${Number(item.targetAchievement).toFixed(4)}%`,
        contentX,
        y + 98,
      );

      const tags = compactTags(item);
      context.fillStyle = tags.includes('DXRating 水歌')
        ? '#d9f99d'
        : '#d8b4fe';
      context.font = '700 13px "Segoe UI", "PingFang SC", sans-serif';
      context.fillText(
        fitCanvasText(
          context,
          tags.join(' · ') || '舒适定数候选',
          cardWidth - 34,
        ),
        x + 17,
        y + 128,
      );
    });

    top += sectionHeight(group.items.length);
  }

  context.fillStyle = '#64748b';
  context.font = '600 16px "Segoe UI", "PingFang SC", sans-serif';
  context.fillText('DXRating 社区曲库与标签 · 实验推荐', margin, height - 25);
  context.textAlign = 'right';
  context.fillText(
    new Date().toLocaleDateString('en-CA'),
    width - margin,
    height - 25,
  );

  const blob = await new Promise<Blob | null>((resolve) =>
    canvas.toBlob(resolve, 'image/png'),
  );
  if (!blob) throw new Error('生成 PNG 失败');
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `maiup-recommendations-${new Date().toISOString().slice(0, 10)}.png`;
  document.body.appendChild(link);
  link.click();
  setTimeout(() => {
    URL.revokeObjectURL(url);
    link.remove();
  }, 1000);
}

function RecommendationCard({ item }: { item: Recommendation }) {
  const bucketPosition = item.slot
    ? item.bucket === 'b15'
      ? item.slot - 35
      : item.slot
    : null;

  return (
    <article className="min-w-0 overflow-hidden rounded-2xl border border-white/8 bg-white/3 p-4">
      <div className="flex min-w-0 items-start gap-3 sm:gap-4">
        <div className="relative size-20 shrink-0 overflow-hidden rounded-xl border border-white/10 bg-slate-950/70 sm:size-28">
          <div className="absolute inset-0 grid place-items-center">
            <Music2 className="size-8 text-white/20" />
          </div>
          {item.coverUrl && (
            <Image
              src={item.coverUrl}
              alt={`${item.title} 曲绘`}
              fill
              sizes="(max-width: 640px) 96px, 112px"
              unoptimized
              className="relative size-full object-cover"
              onError={(event) => {
                event.currentTarget.style.display = 'none';
              }}
            />
          )}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            {bucketPosition ? (
              <Badge
                variant="outline"
                className={
                  item.bucket === 'b35'
                    ? 'border-cyan-300/25 text-cyan-200'
                    : 'border-lime-300/25 text-lime-200'
                }
              >
                {item.bucket.toUpperCase()} #{bucketPosition}
              </Badge>
            ) : (
              <Badge
                variant="outline"
                className={
                  item.bucket === 'b35'
                    ? 'border-cyan-300/25 text-cyan-200'
                    : 'border-lime-300/25 text-lime-200'
                }
              >
                {item.bucket.toUpperCase()}
              </Badge>
            )}
            {item.strategy && (
              <Badge
                variant="outline"
                className="border-white/10 text-muted-foreground"
              >
                {item.strategy === 'steady' ? '稳健目标' : '冲刺目标'}
              </Badge>
            )}
            {item.communityDifficulty === 'water' && (
              <Badge className="bg-lime-300 text-slate-950">
                DXRating 社区水歌
              </Badge>
            )}
            {item.kind === 'outside_b50' && item.scoreStatus === 'played' && (
              <Badge
                variant="outline"
                className="border-cyan-300/25 text-cyan-100"
              >
                已有成绩
              </Badge>
            )}
            {item.kind === 'outside_b50' &&
              item.scoreStatus === 'no_record' && (
                <Badge
                  variant="outline"
                  className="border-white/10 text-muted-foreground"
                >
                  本次导出无记录
                </Badge>
              )}
            {item.weaknessRisk === 'caution' && (
              <Badge
                variant="outline"
                className="border-amber-300/30 text-amber-100"
              >
                弱项样本：谨慎
              </Badge>
            )}
          </div>
          <h3 className="mt-3 line-clamp-2 break-all font-display text-lg font-bold">
            {item.title}
          </h3>
          <p className="mt-1 break-words text-xs text-muted-foreground">
            {item.chartType} · {item.difficulty} · 定数 {item.constant}
            {item.version ? ` · ${item.version}` : ''}
          </p>
          <div className="mt-3 flex flex-wrap items-center gap-3">
            <div className="min-w-0 rounded-xl bg-cyan-300/10 px-3 py-2 text-center">
              <p className="text-[10px] uppercase tracking-wider text-muted-foreground">
                条件增益
              </p>
              <p className="mt-0.5 text-xl font-black text-cyan-200">
                +{item.conditionalGain}
              </p>
            </div>
            {item.currentAchievement && (
              <div className="min-w-0">
                <p className="text-[10px] text-muted-foreground">
                  当前 Achievement
                </p>
                <p className="break-all font-mono text-sm font-bold text-white">
                  {item.currentAchievement}%
                </p>
              </div>
            )}
          </div>
        </div>
      </div>

      <div className="mt-4 grid grid-cols-1 gap-2 text-sm min-[360px]:grid-cols-2">
        <div className="min-w-0 rounded-xl bg-slate-950/45 p-3">
          <p className="text-xs text-muted-foreground">目标 Achievement</p>
          <p className="mt-1 font-mono font-bold text-white">
            {item.targetAchievement}%
          </p>
        </div>
        <div className="min-w-0 rounded-xl bg-slate-950/45 p-3">
          <p className="text-xs text-muted-foreground">目标单谱 Rating</p>
          <p className="mt-1 font-bold text-white">{item.targetRating}</p>
        </div>
      </div>

      {item.targetOptions && item.targetOptions.length > 1 && (
        <div className="mt-3">
          <p className="text-xs text-muted-foreground">渐进目标</p>
          <div className="mt-2 flex flex-wrap gap-2">
            {item.targetOptions.slice(0, 4).map((target) => (
              <span
                key={`${target.achievement}-${target.rating}`}
                className="rounded-lg bg-white/5 px-2.5 py-1 font-mono text-xs text-slate-200"
              >
                {target.achievement}% → {target.rating} Ra
              </span>
            ))}
          </div>
        </div>
      )}

      <div className="mt-3 flex flex-wrap gap-2">
        {compactTags(item).map((tag) => (
          <Badge
            key={tag}
            variant="outline"
            className="border-fuchsia-300/20 text-fuchsia-100"
          >
            {tag}
          </Badge>
        ))}
      </div>
    </article>
  );
}

export default function RecommendationsPage() {
  const params = useParams<{ importId: string }>();
  const [result, setResult] = useState<RecommendationResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [imageState, setImageState] = useState<'idle' | 'generating' | 'error'>(
    'idle',
  );

  useEffect(() => {
    apiFetch(
      `/v1/imports/${params.importId}/recommendations?limit_per_bucket=10`,
    )
      .then(async (response) => {
        const payload = (await response.json()) as RecommendationResult & {
          detail?: string;
        };
        if (!response.ok)
          throw new Error(
            payload.detail ?? `推荐生成失败 (${response.status})`,
          );
        return payload;
      })
      .then(setResult)
      .catch((reason: unknown) =>
        setError(reason instanceof Error ? reason.message : '推荐生成失败'),
      );
  }, [params.importId]);

  const outsideGroups = useMemo(() => {
    if (!result)
      return {
        b35: { played: [], exploration: [] },
        b15: { played: [], exploration: [] },
      };
    const split = (bucket: 'b35' | 'b15') => {
      const items = result.outside.filter((item) => item.bucket === bucket);
      return {
        played: items.filter((item) => item.scoreStatus === 'played'),
        exploration: items.filter((item) => item.scoreStatus !== 'played'),
      };
    };
    return {
      b35: split('b35'),
      b15: split('b15'),
    };
  }, [result]);

  const fullHistory = result?.coverage === 'full_scores';

  if (!result) {
    return (
      <main className="grid min-h-screen place-items-center bg-background px-4 text-foreground">
        <div className="text-center">
          {error ? (
            <ShieldAlert className="mx-auto size-8 text-amber-200" />
          ) : (
            <Loader2 className="mx-auto size-8 animate-spin text-cyan-300" />
          )}
          <p className="mt-3 text-sm text-muted-foreground">
            {error ?? '正在读取成绩并计算个性化候选…'}
          </p>
          {error && (
            <a href="/" className="mt-4 inline-block text-sm text-cyan-200">
              返回首页
            </a>
          )}
        </div>
      </main>
    );
  }

  return (
    <main className="min-h-screen overflow-x-hidden bg-background px-4 py-6 text-foreground sm:px-6 lg:px-8">
      <div className="mx-auto max-w-7xl">
        <header className="border-b border-white/8 pb-6">
          <a
            href={
              fullHistory
                ? `/scores/${params.importId}`
                : `/review/${params.importId}`
            }
            className="inline-flex items-center gap-2 text-sm text-cyan-200 hover:text-cyan-100"
          >
            <ArrowLeft className="size-4" />{' '}
            {fullHistory ? '返回完整成绩报告' : '返回已确认 B50'}
          </a>
          <div className="mt-4 flex flex-col justify-between gap-4 sm:flex-row sm:items-end">
            <div>
              <div className="flex flex-wrap items-center gap-2">
                <p className="eyebrow">EXPERIMENTAL V0.8.1</p>
                <Badge className="bg-amber-300 text-slate-950">实验推荐</Badge>
                <Badge
                  variant="outline"
                  className="border-cyan-300/25 text-cyan-100"
                >
                  {fullHistory
                    ? `完整成绩 ${result.personalProfile.sampleCount} 张`
                    : '仅 B50'}
                </Badge>
              </div>
              <h1 className="mt-2 font-display text-3xl font-black tracking-tight sm:text-4xl">
                你的首版上分候选
              </h1>
              <p className="mt-2 max-w-2xl text-sm leading-6 text-muted-foreground">
                {fullHistory
                  ? '官方 B50 决定替换门槛；推荐先给够得着的分段目标，并把已有成绩补分和新谱探索分开。'
                  : '榜外先确认你在同定数或邻近定数证明过目标成绩，再比较实际加分和擅长元素。'}
              </p>
            </div>
            <div className="flex flex-col gap-3">
              <div className="rounded-2xl border border-cyan-300/15 bg-cyan-300/6 px-5 py-4">
                <p className="text-xs text-muted-foreground">当前总 Rating</p>
                <p className="mt-1 text-3xl font-black text-cyan-200">
                  {result.totalRating}
                </p>
              </div>
              <button
                type="button"
                disabled={imageState === 'generating'}
                onClick={() => {
                  setImageState('generating');
                  void downloadRecommendationImage(result)
                    .then(() => setImageState('idle'))
                    .catch(() => setImageState('error'));
                }}
                className="inline-flex min-h-11 items-center justify-center gap-2 rounded-xl bg-fuchsia-300 px-5 text-sm font-bold text-slate-950 hover:bg-fuchsia-200 disabled:opacity-50"
              >
                <Download className="size-4" />
                {imageState === 'generating' ? '正在生成图片…' : '下载推荐 PNG'}
              </button>
              {imageState === 'error' && (
                <p className="text-xs text-rose-300">
                  图片生成失败，请检查网络后重试。
                </p>
              )}
            </div>
          </div>
        </header>

        <section className="mt-6 grid gap-4 sm:grid-cols-2">
          {(['b35', 'b15'] as const).map((bucket) => (
            <div
              key={bucket}
              className="rounded-2xl border border-white/8 bg-card/55 p-5"
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h2 className="font-display text-xl font-bold">
                  {bucket.toUpperCase()}{' '}
                  {fullHistory ? '成绩范围' : '已证明范围'}
                </h2>
                <span className="shrink-0 font-bold text-cyan-200">
                  门槛 {result.thresholds[bucket]}
                </span>
              </div>
              <p className="mt-3 text-sm text-muted-foreground">
                定数 {result.profile[bucket].constantMin}–
                {result.profile[bucket].constantMax} · Achievement 中位数{' '}
                {result.profile[bucket].medianAchievement}% ·{' '}
                {result.profile[bucket].atOrAbove100_5} 项达到 100.5%
              </p>
            </div>
          ))}
        </section>

        <section className="mt-8 rounded-3xl border border-fuchsia-300/15 bg-fuchsia-300/5 p-5 sm:p-6">
          <div className="flex items-center gap-2">
            <ShieldAlert className="size-5 text-fuchsia-200" />
            <div className="min-w-0">
              <p className="eyebrow">PERSONAL PLAYSTYLE PROFILE</p>
              <h2 className="font-display text-lg font-bold">
                强弱画像与弱势避让
              </h2>
            </div>
          </div>
          <p className="mt-3 text-sm leading-6 text-muted-foreground">
            {activitySummary(result.weaknessProfile)}{' '}
            最后游玩日期只证明“最近碰过这张谱”，不代表当前成绩就是那次打出的。
          </p>
          <div className="mt-5 grid gap-4 md:grid-cols-2">
            <div className="rounded-2xl border border-cyan-300/12 bg-cyan-300/5 p-4">
              <p className="text-sm font-bold text-cyan-100">相对强项</p>
              <div className="mt-3 flex flex-wrap gap-2">
                {result.personalProfile.strengths.length ? (
                  result.personalProfile.strengths.map((item) => (
                    <Badge
                      key={item.tagId}
                      variant="outline"
                      className="border-cyan-300/25 text-cyan-100"
                    >
                      {tagLabel(item)} · {item.sampleCount} 张
                    </Badge>
                  ))
                ) : (
                  <span className="text-sm text-muted-foreground">
                    暂未形成重复出现的相对强项标签。
                  </span>
                )}
              </div>
            </div>
            <div className="rounded-2xl border border-amber-300/12 bg-amber-300/5 p-4">
              <div className="flex flex-wrap items-center gap-2">
                <p className="text-sm font-bold text-amber-100">相对弱项</p>
                <Badge
                  variant="outline"
                  className="border-white/10 text-muted-foreground"
                >
                  {result.weaknessProfile.appliedToRecommendations
                    ? '近期样本 · 已参与避让'
                    : '全成绩历史 · 仅供参考'}
                </Badge>
              </div>
              <div className="mt-3 flex flex-wrap gap-2">
                {result.weaknessProfile.weaknesses.length ? (
                  result.weaknessProfile.weaknesses.map((item) => (
                    <Badge
                      key={item.tagId}
                      variant="outline"
                      className={
                        result.weaknessProfile.appliedToRecommendations &&
                        item.confidence === 'strong'
                          ? 'border-rose-300/30 text-rose-100'
                          : 'border-amber-300/25 text-amber-100'
                      }
                    >
                      {tagLabel(item)} · {item.sampleCount} 张
                      {result.weaknessProfile.appliedToRecommendations
                        ? item.confidence === 'strong'
                          ? ' · 避让'
                          : ' · 谨慎'
                        : ''}
                    </Badge>
                  ))
                ) : (
                  <span className="text-sm text-muted-foreground">
                    暂未形成重复出现的相对弱项标签。
                  </span>
                )}
              </div>
            </div>
          </div>
        </section>

        {result.inList.length > 0 && (
          <section className="mt-10">
            <div className="flex items-center gap-3">
              <Target className="size-5 text-cyan-200" />
              <div>
                <p className="eyebrow">CURRENT B50 QUICK WINS</p>
                <h2 className="font-display text-2xl font-bold">
                  当前 B50 内补分 · 最多 4 首
                </h2>
                <p className="mt-1 text-sm text-muted-foreground">
                  先从较小 Achievement 跨档开始，不强迫直接冲 100% 或 100.5%。
                </p>
              </div>
            </div>
            <div className="mt-4 grid gap-4 md:grid-cols-2 xl:grid-cols-3">
              {result.inList.map((item) => (
                <RecommendationCard
                  key={`${item.chartId}-${item.slot}`}
                  item={item}
                />
              ))}
            </div>
          </section>
        )}

        <section className="mt-10">
          <div className="flex items-center gap-3">
            <Target className="size-5 text-lime-200" />
            <div>
              <p className="eyebrow">CONDITIONAL CANDIDATES</p>
              <h2 className="font-display text-2xl font-bold">
                值得尝试的榜外谱面
              </h2>
              <p className="mt-1 text-sm text-amber-100/80">
                已有成绩适合快速补分；无记录谱面单列为探索，不混成同一种推荐。
              </p>
            </div>
          </div>
          {(['b35', 'b15'] as const).map((bucket) => (
            <div key={bucket} className="mt-6">
              <h3 className="text-sm font-bold text-muted-foreground">
                {bucket.toUpperCase()} 候选 ·{' '}
                {outsideGroups[bucket].played.length +
                  outsideGroups[bucket].exploration.length}{' '}
                首
              </h3>
              {(
                [
                  ['played', '已有成绩 · 快速补分'],
                  ['exploration', '新谱探索'],
                ] as const
              ).map(
                ([group, label]) =>
                  outsideGroups[bucket][group].length > 0 && (
                    <div key={group} className="mt-4">
                      <p className="text-xs font-bold uppercase tracking-wider text-slate-400">
                        {label} · {outsideGroups[bucket][group].length} 首
                      </p>
                      <div className="mt-3 grid gap-4 md:grid-cols-2 xl:grid-cols-3">
                        {outsideGroups[bucket][group].map((item) => (
                          <RecommendationCard key={item.chartId} item={item} />
                        ))}
                      </div>
                    </div>
                  ),
              )}
            </div>
          ))}
        </section>

        <section className="mt-10 rounded-3xl border border-amber-300/15 bg-amber-300/5 p-5 sm:p-6">
          <div className="flex items-center gap-2">
            <ShieldAlert className="size-5 text-amber-200" />
            <h2 className="font-display text-lg font-bold">使用限制</h2>
          </div>
          <ul className="mt-4 space-y-2 text-sm leading-6 text-muted-foreground">
            {result.caveats.map((item) => (
              <li key={item}>• {item}</li>
            ))}
          </ul>
          <div className="mt-5 flex flex-wrap items-center gap-2 border-t border-white/8 pt-4 text-xs text-muted-foreground">
            <Database className="size-4" />
            曲库：DXRating 公开社区目录 · 定数不是 SEGA 官方数据 · 算法{' '}
            {result.algorithmVersion}
          </div>
        </section>
      </div>
    </main>
  );
}
