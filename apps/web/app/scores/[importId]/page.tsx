'use client';

/* oxlint-disable next/no-html-link-for-pages -- Full navigation is more reliable through the mobile preview gateway. */

import { useEffect, useState } from 'react';
import Image from 'next/image';
import { useParams } from 'next/navigation';
import {
  ArrowLeft,
  CheckCircle2,
  Database,
  Download,
  FileCheck2,
  Loader2,
  Music2,
  RefreshCw,
  TriangleAlert,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Progress } from '@/components/ui/progress';
import { apiFetch } from '@/lib/api';

type ScorePreview = {
  title: string;
  chartType: 'std' | 'dx';
  difficulty: string;
  achievement: string;
  fullCombo: string | null;
  matchStatus: string;
};

type ScoreImportReport = {
  id: string;
  status: string;
  suppliedCount: number;
  matchedCount: number;
  unmatchedCount: number;
  duplicateCount: number;
  coverageRatio: string;
  correctedTypeCount: number;
  chartTypeCounts: Record<string, number>;
  difficultyCounts: Record<string, number>;
  sampleScores: ScorePreview[];
  b50Generated: boolean;
  b35Count: number;
  b15Count: number;
  b35Rating: number | null;
  b15Rating: number | null;
  totalRating: number | null;
  recommendationUrl: string | null;
  b50Source: 'official_dxnet' | 'calculated_fallback' | null;
  best50Entries: Array<{
    position: number;
    bucket: 'b35' | 'b15';
    title: string;
    chartType: string;
    difficulty: string;
    version: string | null;
    achievement: string;
    rating: number;
    constant: string;
    fullCombo: string | null;
    coverUrl: string | null;
  }>;
  issues: Array<{
    sourceIndex: number;
    title: string;
    chartType: string;
    difficulty: string;
    issueCode: string;
  }>;
};

const difficultyLabels: Record<string, string> = {
  basic: 'BASIC',
  advanced: 'ADVANCED',
  expert: 'EXPERT',
  master: 'MASTER',
  remaster: 'Re:MASTER',
};

const difficultyColors: Record<string, string> = {
  basic: '#43b96d',
  advanced: '#d8ad30',
  expert: '#d95468',
  master: '#9c55d4',
  remaster: '#c995e8',
};

function clippedText(context: CanvasRenderingContext2D, text: string, maxWidth: number) {
  if (context.measureText(text).width <= maxWidth) return text;
  let result = text;
  while (result.length > 1 && context.measureText(`${result}…`).width > maxWidth) {
    result = result.slice(0, -1);
  }
  return `${result}…`;
}

async function loadCover(url: string | null) {
  if (!url) return null;
  try {
    const response = await fetch(url, { mode: 'cors' });
    if (!response.ok) return null;
    return await createImageBitmap(await response.blob());
  } catch {
    return null;
  }
}

async function downloadBest50Image(report: ScoreImportReport) {
  const width = 1600;
  const height = 1880;
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('浏览器无法创建图片画布');

  const covers = await Promise.all(
    report.best50Entries.map((entry) => loadCover(entry.coverUrl)),
  );
  const coverByEntry = new Map(
    report.best50Entries.map((entry, index) => [entry, covers[index]]),
  );
  const background = context.createLinearGradient(0, 0, width, height);
  background.addColorStop(0, '#07131f');
  background.addColorStop(0.55, '#0c1728');
  background.addColorStop(1, '#170d25');
  context.fillStyle = background;
  context.fillRect(0, 0, width, height);

  context.fillStyle = '#67e8f9';
  context.font = '800 30px "Segoe UI", "Yu Gothic UI", sans-serif';
  context.fillText('MaiUp · INTERNATIONAL RATING LAB', 42, 50);
  context.fillStyle = '#f8fafc';
  context.font = '900 74px "Segoe UI", "Yu Gothic UI", sans-serif';
  context.fillText('BEST 50', 40, 130);
  context.textAlign = 'right';
  context.font = '900 42px Consolas, monospace';
  context.fillText(
    `${report.totalRating ?? '—'} = ${report.b35Rating ?? '—'} + ${report.b15Rating ?? '—'}`,
    width - 42,
    108,
  );
  context.fillStyle = '#94a3b8';
  context.font = '600 18px "Segoe UI", sans-serif';
  context.fillText(
    report.b50Source === 'official_dxnet' ? 'DX NET OFFICIAL B35 + B15' : 'CALCULATED FALLBACK',
    width - 42,
    143,
  );
  context.textAlign = 'left';

  const columns = 5;
  const gap = 12;
  const margin = 40;
  const cardWidth = (width - margin * 2 - gap * (columns - 1)) / columns;
  const cardHeight = 140;

  const drawSection = (bucket: 'b35' | 'b15', startY: number) => {
    const entries = report.best50Entries.filter((entry) => entry.bucket === bucket);
    context.fillStyle = bucket === 'b35' ? '#67e8f9' : '#bef264';
    context.font = '900 27px "Segoe UI", sans-serif';
    context.fillText(`${bucket.toUpperCase()} · ${entries.length}`, margin, startY);
    const gridY = startY + 18;
    entries.forEach((entry, index) => {
      const column = index % columns;
      const row = Math.floor(index / columns);
      const x = margin + column * (cardWidth + gap);
      const y = gridY + row * (cardHeight + gap);
      context.fillStyle = '#111d2f';
      context.beginPath();
      context.roundRect(x, y, cardWidth, cardHeight, 14);
      context.fill();
      context.fillStyle = difficultyColors[entry.difficulty] ?? '#64748b';
      context.fillRect(x, y, 7, cardHeight);

      const cover = coverByEntry.get(entry);
      context.save();
      context.beginPath();
      context.roundRect(x + 15, y + 15, 82, 82, 9);
      context.clip();
      if (cover) {
        context.drawImage(cover, x + 15, y + 15, 82, 82);
      } else {
        context.fillStyle = '#263449';
        context.fillRect(x + 15, y + 15, 82, 82);
      }
      context.restore();

      const textX = x + 109;
      const textWidth = cardWidth - 121;
      context.fillStyle = '#f8fafc';
      context.font = '800 17px "Segoe UI", "Yu Gothic UI", sans-serif';
      context.fillText(clippedText(context, entry.title, textWidth), textX, y + 31);
      context.fillStyle = '#bae6fd';
      context.font = '800 17px Consolas, monospace';
      context.fillText(`${Number(entry.achievement).toFixed(4)}%`, textX, y + 58);
      context.fillStyle = '#94a3b8';
      context.font = '600 13px "Segoe UI", sans-serif';
      const versionText = entry.version ? ` · ${entry.version}` : '';
      context.fillText(
        clippedText(
          context,
          `${entry.chartType.toUpperCase()} · ${difficultyLabels[entry.difficulty] ?? entry.difficulty}${versionText}`,
          textWidth,
        ),
        textX,
        y + 80,
      );
      context.fillStyle = '#ffffff';
      context.font = '800 16px "Segoe UI", sans-serif';
      context.fillText(`${entry.constant} → ${entry.rating}`, textX, y + 104);
      context.fillStyle = bucket === 'b35' ? '#67e8f9' : '#bef264';
      context.font = '800 15px Consolas, monospace';
      context.fillText(`#${entry.position}`, x + 16, y + 125);
      if (entry.fullCombo) {
        context.textAlign = 'right';
        context.fillText(entry.fullCombo, x + cardWidth - 14, y + 125);
        context.textAlign = 'left';
      }
    });
    return gridY + Math.ceil(entries.length / columns) * (cardHeight + gap);
  };

  const afterB35 = drawSection('b35', 188);
  drawSection('b15', afterB35 + 24);
  context.fillStyle = '#64748b';
  context.font = '500 17px "Segoe UI", sans-serif';
  context.fillText(
    `Generated locally by MaiUp · ${new Date().toLocaleDateString('en-CA')}`,
    margin,
    height - 28,
  );

  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
  if (!blob) throw new Error('生成 PNG 失败');
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `maiup-b50-${new Date().toISOString().slice(0, 10)}.png`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export default function ScoreImportReportPage() {
  const params = useParams<{ importId: string }>();
  const [report, setReport] = useState<ScoreImportReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [imageState, setImageState] = useState<'idle' | 'generating' | 'error'>('idle');

  useEffect(() => {
    apiFetch(`/v1/imports/scores/${params.importId}`)
      .then(async (response) => {
        const payload = (await response.json()) as ScoreImportReport & { detail?: string };
        if (!response.ok) throw new Error(payload.detail ?? `读取失败 (${response.status})`);
        return payload;
      })
      .then(setReport)
      .catch((reason: unknown) => {
        setError(reason instanceof Error ? reason.message : '无法读取成绩导入报告');
      });
  }, [params.importId]);

  if (error) {
    return (
      <main className="grid min-h-screen place-items-center bg-background p-6 text-foreground">
        <div className="max-w-lg rounded-3xl border border-rose-300/20 bg-card p-8 text-center">
          <TriangleAlert className="mx-auto size-10 text-rose-300" />
          <h1 className="mt-4 text-2xl font-bold">导入报告读取失败</h1>
          <p className="mt-2 text-sm text-muted-foreground">{error}</p>
          <a href="/" className="mt-6 inline-flex items-center gap-2 text-sm text-cyan-200">
            <ArrowLeft className="size-4" /> 返回重新导入
          </a>
        </div>
      </main>
    );
  }

  if (!report) {
    return (
      <main className="grid min-h-screen place-items-center bg-background text-foreground">
        <div className="flex items-center gap-3 text-muted-foreground">
          <Loader2 className="size-5 animate-spin" /> 正在生成导入报告…
        </div>
      </main>
    );
  }

  const matchPercent = Number(report.coverageRatio) * 100;
  const succeeded = report.unmatchedCount === 0;
  const effectiveCount = report.suppliedCount - report.duplicateCount;

  return (
    <main className="min-h-screen bg-background px-5 py-8 text-foreground sm:px-8">
      <div className="mx-auto max-w-6xl">
        <a href="/" className="inline-flex items-center gap-2 text-sm text-muted-foreground hover:text-cyan-200">
          <ArrowLeft className="size-4" /> 返回首页
        </a>

        <section className="mt-6 overflow-hidden rounded-[2rem] border border-white/10 bg-card/75 p-6 sm:p-9">
          <div className="flex flex-col gap-6 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <Badge
                variant="outline"
                className={succeeded ? 'border-lime-300/30 bg-lime-300/8 text-lime-200' : 'border-amber-300/30 bg-amber-300/8 text-amber-200'}
              >
                {succeeded ? 'IMPORT COMPLETE' : 'REVIEW NEEDED'}
              </Badge>
              <h1 className="mt-4 font-display text-3xl font-black sm:text-5xl">
                {succeeded ? '完整成绩读取成功' : '成绩已读取，还有项目待确认'}
              </h1>
              <p className="mt-3 text-sm leading-6 text-muted-foreground">
                抓到 {report.suppliedCount} 条记录，整理为 {effectiveCount} 张有效谱面。
                {report.correctedTypeCount > 0 && ` 已自动纠正 ${report.correctedTypeCount} 条 DX/STD 类型。`}
              </p>
            </div>
            <div className={`grid size-24 shrink-0 place-items-center rounded-full border ${succeeded ? 'border-lime-300/25 bg-lime-300/8' : 'border-amber-300/25 bg-amber-300/8'}`}>
              {succeeded ? <CheckCircle2 className="size-12 text-lime-300" /> : <TriangleAlert className="size-12 text-amber-300" />}
            </div>
          </div>

          <div className="mt-8">
            <div className="flex items-end justify-between gap-4">
              <span className="text-sm font-semibold">曲库匹配率</span>
              <span className="text-4xl font-black text-cyan-200">{matchPercent.toFixed(1)}%</span>
            </div>
            <Progress value={matchPercent} className="mt-3 h-3" />
          </div>

          <div className="mt-8 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <div className="rounded-2xl border border-white/8 bg-white/3 p-5">
              <FileCheck2 className="size-5 text-fuchsia-200" />
              <p className="mt-4 text-3xl font-black">{report.suppliedCount}</p>
              <p className="mt-1 text-xs text-muted-foreground">抓取记录</p>
            </div>
            <div className="rounded-2xl border border-white/8 bg-white/3 p-5">
              <Database className="size-5 text-fuchsia-200" />
              <p className="mt-4 text-3xl font-black">{report.matchedCount}</p>
              <p className="mt-1 text-xs text-muted-foreground">有效谱面</p>
            </div>
            <div className="rounded-2xl border border-white/8 bg-white/3 p-5">
              <RefreshCw className="size-5 text-fuchsia-200" />
              <p className="mt-4 text-3xl font-black">{report.duplicateCount}</p>
              <p className="mt-1 text-xs text-muted-foreground">忽略重复</p>
            </div>
            <div className="rounded-2xl border border-white/8 bg-white/3 p-5">
              <TriangleAlert className="size-5 text-fuchsia-200" />
              <p className="mt-4 text-3xl font-black">{report.unmatchedCount}</p>
              <p className="mt-1 text-xs text-muted-foreground">待处理</p>
            </div>
          </div>
        </section>

        <section className="mt-6 rounded-3xl border border-lime-300/15 bg-lime-300/5 p-6 sm:flex sm:items-center sm:justify-between sm:gap-6">
          <div>
            <p className="text-xs font-bold uppercase tracking-[0.18em] text-lime-200">
              {report.b50Source === 'official_dxnet' ? 'Official DX NET B50' : 'Calculated B50 fallback'}
            </p>
            <h2 className="mt-2 font-display text-2xl font-bold">
              {report.b50Generated
                ? report.b50Source === 'official_dxnet'
                  ? '已采用 DX NET 官网 B35 / B15'
                  : '官网榜单未读取，已临时重算 B35 / B15'
                : '完整成绩不足以生成完整 B50'}
            </h2>
            {report.b50Generated && (
              <p className="mt-3 font-mono text-2xl font-black text-white">
                {report.totalRating}
                <span className="mx-2 text-muted-foreground">=</span>
                <span className="text-cyan-200">{report.b35Rating}</span>
                <span className="mx-2 text-muted-foreground">+</span>
                <span className="text-lime-200">{report.b15Rating}</span>
              </p>
            )}
            <p className="mt-2 text-sm text-muted-foreground">
              {report.b50Generated
                ? `${report.b50Source === 'official_dxnet' ? 'DX NET 官网榜单' : '本地临时重算'} · B35 ${report.b35Count} 张 · B15 ${report.b15Count} 张`
                : '成绩报告仍然保留，但需要补齐足够的有效谱面后才能开始推荐。'}
            </p>
            {report.b50Source === 'calculated_fallback' && (
              <p className="mt-2 text-xs font-semibold text-amber-200">
                官网榜单未成功读取；请先检查这份 B50，之后可手动修改或上传 B50 图片校正。
              </p>
            )}
          </div>
          {report.recommendationUrl && (
            <a
              href={report.recommendationUrl}
              className="mt-5 inline-flex min-h-11 items-center justify-center rounded-xl bg-lime-300 px-5 text-sm font-bold text-slate-950 hover:bg-lime-200 sm:mt-0"
            >
              {report.b50Source === 'official_dxnet' ? '使用官网 B50 继续推荐' : '使用临时计算 B50 继续推荐'}
            </a>
          )}
        </section>

        {report.best50Entries.length === 50 && (
          <section className="mt-6 rounded-3xl border border-white/8 bg-card/55 p-6">
            <div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-end">
              <div>
                <p className="text-xs font-bold uppercase tracking-[0.18em] text-cyan-200">B35 / B15 verification</p>
                <h2 className="mt-2 font-display text-2xl font-bold">检查当前 B50</h2>
              </div>
              <Badge variant="outline" className={report.b50Source === 'official_dxnet' ? 'border-lime-300/30 text-lime-200' : 'border-amber-300/30 text-amber-200'}>
                {report.b50Source === 'official_dxnet' ? 'DX NET 官网' : '本地临时重算'}
              </Badge>
            </div>
            <button
              type="button"
              disabled={imageState === 'generating'}
              onClick={() => {
                setImageState('generating');
                void downloadBest50Image(report)
                  .then(() => setImageState('idle'))
                  .catch(() => setImageState('error'));
              }}
              className="mt-5 inline-flex min-h-11 items-center gap-2 rounded-xl bg-cyan-300 px-5 text-sm font-bold text-slate-950 hover:bg-cyan-200 disabled:opacity-50"
            >
              <Download className="size-4" />
              {imageState === 'generating' ? '正在加载曲绘…' : '下载 B50 PNG'}
            </button>
            {imageState === 'error' && (
              <p className="mt-2 text-xs text-rose-300">图片生成失败，请检查网络后重试。</p>
            )}
            <div className="mt-6 grid gap-6 lg:grid-cols-2">
              {(['b35', 'b15'] as const).map((bucket) => (
                <div key={bucket}>
                  <h3 className={`text-sm font-black ${bucket === 'b35' ? 'text-cyan-200' : 'text-lime-200'}`}>
                    {bucket.toUpperCase()} · {bucket === 'b35' ? 35 : 15} 张
                  </h3>
                  <div className="mt-3 divide-y divide-white/7 overflow-hidden rounded-2xl border border-white/8 bg-slate-950/25">
                    {report.best50Entries.filter((entry) => entry.bucket === bucket).map((entry) => (
                      <div key={`${bucket}-${entry.position}`} className="flex items-center gap-3 px-3 py-2.5 text-sm">
                        <span className="w-7 shrink-0 font-mono text-xs font-bold text-muted-foreground">#{entry.position}</span>
                        <div className="relative size-12 shrink-0 overflow-hidden rounded-lg bg-white/5">
                          {entry.coverUrl ? (
                            <Image
                              src={entry.coverUrl}
                              alt=""
                              fill
                              sizes="48px"
                              unoptimized
                              className="object-cover"
                            />
                          ) : (
                            <Music2 className="absolute inset-0 m-auto size-5 text-white/20" />
                          )}
                        </div>
                        <div className="min-w-0 flex-1">
                          <p className="truncate font-semibold">{entry.title}</p>
                          <p className="mt-0.5 text-[11px] text-muted-foreground">
                            {entry.chartType.toUpperCase()} · {difficultyLabels[entry.difficulty] ?? entry.difficulty}
                          </p>
                        </div>
                        <div className="shrink-0 text-right">
                          <p className="font-mono text-xs font-bold">{Number(entry.achievement).toFixed(4)}%</p>
                          <p className="mt-0.5 text-[11px] text-cyan-200">Ra {entry.rating}</p>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </section>
        )}

        <div className="mt-6 grid gap-6 lg:grid-cols-[0.8fr_1.2fr]">
          <section className="rounded-3xl border border-white/8 bg-card/55 p-6">
            <h2 className="font-display text-xl font-bold">数据分布</h2>
            <div className="mt-5 grid grid-cols-2 gap-3">
              <div className="rounded-2xl bg-cyan-300/7 p-4">
                <p className="text-2xl font-black text-cyan-200">{report.chartTypeCounts.dx ?? 0}</p>
                <p className="text-xs text-muted-foreground">DX 谱面</p>
              </div>
              <div className="rounded-2xl bg-fuchsia-300/7 p-4">
                <p className="text-2xl font-black text-fuchsia-200">{report.chartTypeCounts.std ?? 0}</p>
                <p className="text-xs text-muted-foreground">STD 谱面</p>
              </div>
            </div>
            <div className="mt-5 space-y-3">
              {Object.entries(difficultyLabels).map(([key, label]) => (
                <div key={key} className="flex items-center justify-between rounded-xl border border-white/6 px-4 py-3 text-sm">
                  <span className="text-muted-foreground">{label}</span>
                  <span className="font-bold">{report.difficultyCounts[key] ?? 0}</span>
                </div>
              ))}
            </div>
          </section>

          <section className="rounded-3xl border border-white/8 bg-card/55 p-6">
            <div className="flex items-center justify-between gap-4">
              <div>
                <p className="text-xs font-bold uppercase tracking-[0.18em] text-cyan-200">Score sample</p>
                <h2 className="mt-1 font-display text-xl font-bold">实际读取到的成绩</h2>
              </div>
              <Music2 className="size-6 text-white/25" />
            </div>
            <div className="mt-5 divide-y divide-white/7">
              {report.sampleScores.map((score, index) => (
                <div key={`${score.title}-${score.difficulty}-${index}`} className="flex items-center gap-4 py-3">
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-semibold">{score.title}</p>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {score.chartType.toUpperCase()} · {difficultyLabels[score.difficulty] ?? score.difficulty}
                    </p>
                  </div>
                  {score.fullCombo && <span className="text-xs font-bold text-lime-200">{score.fullCombo}</span>}
                  <span className="font-mono text-sm font-bold text-cyan-100">{Number(score.achievement).toFixed(4)}%</span>
                </div>
              ))}
            </div>
          </section>
        </div>

        {report.issues.length > 0 && (
          <section className="mt-6 rounded-3xl border border-amber-300/20 bg-amber-300/5 p-6">
            <h2 className="font-display text-xl font-bold text-amber-100">待处理项目</h2>
            <p className="mt-1 text-sm text-muted-foreground">先显示前 20 项，共 {report.issues.length} 项。</p>
            <div className="mt-4 grid gap-2 sm:grid-cols-2">
              {report.issues.slice(0, 20).map((issue) => (
                <div key={issue.sourceIndex} className="rounded-xl border border-amber-200/10 bg-black/10 px-4 py-3 text-sm">
                  <p className="font-semibold">{issue.title}</p>
                  <p className="mt-1 text-xs text-amber-100/65">{issue.chartType.toUpperCase()} · {difficultyLabels[issue.difficulty] ?? issue.difficulty} · {issue.issueCode}</p>
                </div>
              ))}
            </div>
          </section>
        )}

        <p className="mt-6 text-center text-xs text-muted-foreground">
          官网 Rating Target 成功读取时直接采用；只有官网榜单不可用时才显示本地临时重算结果。
        </p>
      </div>
    </main>
  );
}
