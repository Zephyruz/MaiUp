'use client';

/* oxlint-disable next/no-html-link-for-pages -- Full navigation preserves the access-key session. */

import { useEffect, useMemo, useState } from 'react';
import { useParams } from 'next/navigation';
import {
  ArrowLeft,
  Check,
  CheckCircle2,
  Database,
  Loader2,
  LockKeyhole,
  Save,
  Search,
  ShieldCheck,
  Sparkles,
  TriangleAlert,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';
import { API_ORIGIN, apiFetch } from '@/lib/api';

type ImportEntry = {
  slot: number;
  bucket: 'b35' | 'b15';
  chartId: string | null;
  title: string | null;
  chartType: string | null;
  difficulty: string | null;
  chartVersion: string | null;
  chartConstant: string | null;
  achievement: string | null;
  fullCombo: string | null;
  displayedRating: number | null;
  calculatedRating: number | null;
  needsReview: boolean;
  issueCode: string | null;
};

type PlayerImport = {
  id: string;
  status: string;
  coverage: string;
  sourceImageStored: boolean;
  imageWidth: number;
  imageHeight: number;
  completedCount: number;
  totalCount: number;
  totalRating: number | null;
  entries: ImportEntry[];
};

type ChartCandidate = {
  chartId: string;
  title: string;
  artist: string;
  chartType: string;
  difficulty: string;
  level: string;
  constant: string;
  constantConfidence: string;
  constantDerivation: string;
  version: string;
  bucket: 'b35' | 'b15';
};

async function readJson<T>(response: Response): Promise<T> {
  const payload = (await response.json()) as T & { detail?: string };
  if (!response.ok) {
    const detail = payload.detail === 'Confirmed imports are immutable'
      ? '这份 B50 已确认并锁定，不能再修改。'
      : payload.detail;
    throw new Error(detail ?? `请求失败 (${response.status})`);
  }
  return payload;
}

export default function ReviewPage() {
  const params = useParams<{ importId: string }>();
  const importId = params.importId;
  const [playerImport, setPlayerImport] = useState<PlayerImport | null>(null);
  const [selectedSlot, setSelectedSlot] = useState(1);
  const [query, setQuery] = useState('');
  const [candidates, setCandidates] = useState<ChartCandidate[]>([]);
  const [selectedChart, setSelectedChart] = useState<ChartCandidate | null>(null);
  const [achievement, setAchievement] = useState('100.0000');
  const [chartConstant, setChartConstant] = useState('');
  const [displayedRating, setDisplayedRating] = useState('');
  const [fullCombo, setFullCombo] = useState('');
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    apiFetch(`/v1/imports/${importId}`)
      .then((response) => readJson<PlayerImport>(response))
      .then(setPlayerImport)
      .catch((error: unknown) => setMessage(error instanceof Error ? error.message : '导入读取失败'));
  }, [importId]);

  const entry = useMemo(
    () => playerImport?.entries.find((item) => item.slot === selectedSlot) ?? null,
    [playerImport, selectedSlot],
  );

  function selectEntry(next: ImportEntry) {
    setSelectedSlot(next.slot);
    setQuery(next.title ?? '');
    setSelectedChart(
      next.chartId && next.title
        ? {
            chartId: next.chartId,
            title: next.title,
            artist: '',
            chartType: next.chartType ?? '',
            difficulty: next.difficulty ?? '',
            level: '',
            constant: next.chartConstant ?? '',
            constantConfidence: '',
            constantDerivation: '',
            version: next.chartVersion ?? '',
            bucket: next.bucket,
          }
        : null,
    );
    setAchievement(next.achievement ?? '100.0000');
    setChartConstant(next.chartConstant ?? '');
    setDisplayedRating(next.displayedRating?.toString() ?? '');
    setFullCombo(next.fullCombo ?? '');
    setCandidates([]);
    setMessage(null);
  }

  async function searchCharts(event: { preventDefault(): void }) {
    event.preventDefault();
    if (!entry || query.trim().length < 1) return;
    setBusy(true);
    setMessage(null);
    try {
      const response = await fetch(
        `${API_ORIGIN}/v1/catalog/charts?q=${encodeURIComponent(query)}&bucket=${entry.bucket}&limit=20`,
      );
      const result = await readJson<ChartCandidate[]>(response);
      setCandidates(result);
      if (result.length === 0) setMessage('没有找到该计分池中的匹配谱面，请换曲名或别名。');
    } catch (error: unknown) {
      setMessage(error instanceof Error ? error.message : '曲目搜索失败');
    } finally {
      setBusy(false);
    }
  }

  async function saveEntry() {
    if (!selectedChart || !entry) {
      setMessage('请先搜索并选择一张谱面。');
      return;
    }
    setBusy(true);
    setMessage(null);
    try {
      const response = await apiFetch(
        `/v1/imports/${importId}/entries/${entry.slot}`,
        {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            chartId: selectedChart.chartId,
            chartConstant: chartConstant || null,
            achievement,
            fullCombo: fullCombo || null,
            displayedRating: displayedRating ? Number(displayedRating) : null,
          }),
        },
      );
      const result = await readJson<PlayerImport>(response);
      setPlayerImport(result);
      const saved = result.entries.find((item) => item.slot === entry.slot);
      if (saved?.needsReview) {
        setMessage(
          saved.issueCode === 'rating_mismatch'
            ? `公式结果为 ${saved.calculatedRating}，与图片 Rating 不一致，请检查定数、达成率或 AP。`
            : '该项仍需检查。',
        );
      } else {
        const next = result.entries.find((item) => item.needsReview);
        if (next) selectEntry(next);
        setMessage(`第 ${entry.slot} 项已确认，公式 Rating = ${saved?.calculatedRating}。`);
      }
    } catch (error: unknown) {
      setMessage(error instanceof Error ? error.message : '保存失败');
    } finally {
      setBusy(false);
    }
  }

  async function confirmAll() {
    setBusy(true);
    setMessage(null);
    try {
      const response = await apiFetch(`/v1/imports/${importId}/confirm`, {
        method: 'POST',
      });
      const result = await readJson<PlayerImport>(response);
      setPlayerImport(result);
      setMessage(`B50 已确认，总 Rating ${result.totalRating}。`);
    } catch (error: unknown) {
      setMessage(error instanceof Error ? error.message : '确认失败');
    } finally {
      setBusy(false);
    }
  }

  async function deleteSourceImage() {
    setBusy(true);
    setMessage(null);
    try {
      const response = await apiFetch(`/v1/imports/${importId}/asset`, {
        method: 'DELETE',
      });
      if (!response.ok) throw new Error(`删除失败 (${response.status})`);
      setPlayerImport((current) => current ? { ...current, sourceImageStored: false } : current);
      setMessage('本机临时原图已删除；识别出的结构化成绩仍保留。');
    } catch (error: unknown) {
      setMessage(error instanceof Error ? error.message : '删除临时原图失败');
    } finally {
      setBusy(false);
    }
  }

  if (!playerImport) {
    return (
      <main className="grid min-h-screen place-items-center bg-background text-foreground">
        <div className="text-center">
          <Loader2 className="mx-auto size-8 animate-spin text-cyan-300" />
          <p className="mt-3 text-sm text-muted-foreground">正在建立 B50 校正表…</p>
          {message && <p className="mt-2 text-sm text-rose-300">{message}</p>}
        </div>
      </main>
    );
  }

  const progress = (playerImport.completedCount / playerImport.totalCount) * 100;
  const recognizedCount = playerImport.entries.filter((item) => item.achievement !== null).length;
  const isConfirmed = playerImport.status === 'confirmed';

  return (
    <main className="min-h-screen bg-background px-4 py-5 text-foreground sm:px-6 lg:px-8">
      <div className="mx-auto max-w-[1500px]">
        <header className="flex flex-col justify-between gap-4 border-b border-white/8 pb-5 sm:flex-row sm:items-center">
          <div>
            <a href="/" className="inline-flex items-center gap-2 text-sm text-cyan-200 hover:text-cyan-100">
              <ArrowLeft className="size-4" /> 返回上传
            </a>
            <h1 className="mt-3 font-display text-3xl font-black tracking-tight">校正你的 B50</h1>
            <p className="mt-1 text-sm text-muted-foreground">
              已自动读取 {recognizedCount}/50 项、完整匹配 {playerImport.completedCount}/50 项；只需处理标黄项目。
            </p>
          </div>
          <div className="min-w-64 rounded-2xl border border-white/8 bg-card/55 p-4">
            <div className="flex items-center justify-between text-sm">
              <span>{playerImport.completedCount}/50 已确认</span>
              <span className="font-bold text-cyan-200">{playerImport.totalRating ?? 0} Rating</span>
            </div>
            <Progress value={progress} className="mt-3 h-1.5 bg-white/8 [&_[data-slot=progress-indicator]]:bg-cyan-300" />
          </div>
        </header>

        {isConfirmed && (
          <div className="mt-5 flex flex-col gap-4 rounded-2xl border border-lime-300/20 bg-lime-300/6 p-4 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex items-start gap-3">
              <LockKeyhole className="mt-0.5 size-5 shrink-0 text-lime-300" />
              <div>
                <p className="font-bold text-lime-100">这份 B50 已确认，现在是只读状态</p>
                <p className="mt-1 text-sm text-muted-foreground">你仍可逐项查看识别结果，但不能再修改；这样可保证后续推荐基于同一份成绩。</p>
              </div>
            </div>
            <a
              href={`/recommendations/${importId}`}
              className="inline-flex min-h-11 shrink-0 items-center justify-center gap-2 rounded-xl bg-lime-300 px-4 text-sm font-bold text-slate-950 hover:bg-lime-200"
            >
              <Sparkles className="size-4" /> 查看实验版推荐
            </a>
          </div>
        )}

        <div className="mt-6 grid gap-6 lg:grid-cols-[minmax(0,1fr)_440px]">
          <section className="rounded-3xl border border-white/8 bg-card/45 p-4 sm:p-6">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <p className="eyebrow">50 ENTRIES</p>
                <h2 className="mt-1 font-display text-xl font-bold">B35 / B15 项目</h2>
              </div>
              <div className="flex gap-2 text-xs">
                <Badge variant="outline" className="border-cyan-300/25 text-cyan-200">B35 · 1–35</Badge>
                <Badge variant="outline" className="border-lime-300/25 text-lime-200">B15 · 36–50</Badge>
              </div>
            </div>

            <div className="mt-5 grid grid-cols-5 gap-2 sm:grid-cols-7 xl:grid-cols-10">
              {playerImport.entries.map((item) => (
                <button
                  key={item.slot}
                  type="button"
                  onClick={() => selectEntry(item)}
                  className={
                    'relative min-h-14 rounded-xl border text-sm font-bold transition ' +
                    (item.slot === selectedSlot
                      ? 'border-cyan-300 bg-cyan-300 text-slate-950'
                      : item.needsReview
                        ? 'border-white/10 bg-white/3 text-muted-foreground hover:border-white/25'
                        : 'border-lime-300/25 bg-lime-300/8 text-lime-200')
                  }
                  aria-label={`第 ${item.slot} 项${item.needsReview ? '待校正' : '已确认'}`}
                >
                  {item.slot}
                  {!item.needsReview && <Check className="absolute right-1 top-1 size-3" />}
                </button>
              ))}
            </div>

            <div className="mt-6 space-y-2">
              {playerImport.entries.filter((item) => !item.needsReview).slice(0, 8).map((item) => (
                <button
                  type="button"
                  key={item.slot}
                  onClick={() => selectEntry(item)}
                  className="flex w-full items-center justify-between rounded-xl bg-white/3 px-4 py-3 text-left text-sm hover:bg-white/6"
                >
                  <span className="truncate"><span className="mr-3 text-muted-foreground">#{item.slot}</span>{item.title}</span>
                  <span className="ml-3 shrink-0 font-bold text-cyan-200">{item.calculatedRating}</span>
                </button>
              ))}
            </div>
          </section>

          <aside className="rounded-3xl border border-cyan-300/15 bg-card/70 p-5 sm:p-6 lg:sticky lg:top-5 lg:self-start">
            <div className="flex items-start justify-between gap-4">
              <div>
                <p className="eyebrow">SELECTED ENTRY</p>
                <h2 className="mt-1 font-display text-2xl font-bold">#{entry?.slot} · {entry?.bucket.toUpperCase()}</h2>
              </div>
              {entry?.needsReview ? (
                <Badge className="bg-amber-300 text-slate-950">待校正</Badge>
              ) : (
                <Badge className="bg-lime-300 text-slate-950">已确认</Badge>
              )}
            </div>

            <form onSubmit={searchCharts} className="mt-5 flex gap-2">
              <label className="sr-only" htmlFor="chart-search">搜索曲名或别名</label>
              <div className="relative flex-1">
                <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                <input
                  id="chart-search"
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  disabled={isConfirmed}
                  placeholder="输入曲名或别名"
                  className="min-h-11 w-full rounded-xl border border-white/10 bg-slate-950/50 pl-10 pr-3 text-sm outline-none focus:border-cyan-300"
                />
              </div>
              <Button type="submit" disabled={busy || isConfirmed || !query.trim()} className="min-h-11 rounded-xl bg-cyan-300 text-slate-950">
                搜索
              </Button>
            </form>

            {candidates.length > 0 && (
              <div className="mt-3 max-h-60 space-y-2 overflow-y-auto rounded-xl border border-white/8 bg-slate-950/55 p-2">
                {candidates.map((candidate) => (
                  <button
                    key={candidate.chartId}
                    type="button"
                    disabled={isConfirmed}
                    onClick={() => {
                      setSelectedChart(candidate);
                      setChartConstant(candidate.constant);
                      setCandidates([]);
                      setQuery(candidate.title);
                    }}
                    className="w-full rounded-lg px-3 py-2 text-left hover:bg-white/8"
                  >
                    <p className="truncate text-sm font-bold">{candidate.title}</p>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {candidate.chartType} · {candidate.difficulty} · {candidate.constant} · {candidate.version}
                    </p>
                  </button>
                ))}
              </div>
            )}

            <div className="mt-4 rounded-2xl border border-white/8 bg-white/3 p-4">
              {selectedChart ? (
                <>
                  <p className="font-bold">{selectedChart.title}</p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {selectedChart.chartType} · {selectedChart.difficulty} · 定数 {selectedChart.constant} · {selectedChart.version}
                  </p>
                  <p className="mt-2 text-[11px] text-amber-200">定数为社区基础值，International 独立定数仍待核对。</p>
                </>
              ) : (
                <p className="text-sm text-muted-foreground">先搜索并选择与图片一致的谱面。</p>
              )}
            </div>

            <div className="mt-5 grid gap-4 sm:grid-cols-2">
              <label className="text-xs font-semibold text-muted-foreground sm:col-span-2">
                Achievement %
                <input
                  value={achievement}
                  onChange={(event) => setAchievement(event.target.value)}
                  disabled={isConfirmed}
                  inputMode="decimal"
                  className="mt-2 min-h-11 w-full rounded-xl border border-white/10 bg-slate-950/50 px-3 font-mono text-lg tabular-nums text-white outline-none focus:border-cyan-300"
                />
              </label>
              <label className="text-xs font-semibold text-muted-foreground">
                图片显示定数
                <input
                  value={chartConstant}
                  onChange={(event) => setChartConstant(event.target.value)}
                  disabled={isConfirmed}
                  inputMode="decimal"
                  className="mt-2 min-h-11 w-full rounded-xl border border-white/10 bg-slate-950/50 px-3 text-base text-white outline-none focus:border-cyan-300"
                />
              </label>
              <label className="text-xs font-semibold text-muted-foreground">
                图片显示 Rating
                <input
                  value={displayedRating}
                  onChange={(event) => setDisplayedRating(event.target.value)}
                  disabled={isConfirmed}
                  inputMode="numeric"
                  className="mt-2 min-h-11 w-full rounded-xl border border-white/10 bg-slate-950/50 px-3 text-base text-white outline-none focus:border-cyan-300"
                />
              </label>
            </div>

            <label className="mt-4 block text-xs font-semibold text-muted-foreground">
              FC 状态
              <select
                value={fullCombo}
                onChange={(event) => setFullCombo(event.target.value)}
                disabled={isConfirmed}
                className="mt-2 min-h-11 w-full rounded-xl border border-white/10 bg-slate-950 px-3 text-sm text-white outline-none focus:border-cyan-300"
              >
                <option value="">无 / 未知</option>
                <option value="FC">FC</option>
                <option value="FC+">FC+</option>
                <option value="AP">AP</option>
                <option value="AP+">AP+</option>
              </select>
            </label>

            {message && (
              <div className="mt-4 flex gap-2 rounded-xl border border-amber-300/15 bg-amber-300/6 p-3 text-xs leading-5 text-amber-100">
                {message.includes('已确认') ? <CheckCircle2 className="mt-0.5 size-4 shrink-0" /> : <TriangleAlert className="mt-0.5 size-4 shrink-0" />}
                <span>{message}</span>
              </div>
            )}

            <Button
              onClick={saveEntry}
              disabled={busy || isConfirmed || !selectedChart || !chartConstant || !displayedRating}
              className="mt-5 min-h-12 w-full gap-2 rounded-xl bg-cyan-300 font-bold text-slate-950 hover:bg-cyan-200"
            >
              {busy ? <Loader2 className="size-4 animate-spin" /> : <Save className="size-4" />}
              {isConfirmed ? '已确认，不能修改' : '保存并核对 Rating'}
            </Button>

            <div className="mt-5 border-t border-white/8 pt-5">
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <ShieldCheck className="size-4 text-lime-300" />
                {playerImport.sourceImageStored ? '原图仅临时保存在本机，用于 OCR' : '临时原图已删除，只保留结构化成绩'}
              </div>
              {playerImport.sourceImageStored && (
                <Button
                  onClick={deleteSourceImage}
                  disabled={busy}
                  variant="ghost"
                  className="mt-2 min-h-9 w-full text-xs text-muted-foreground hover:text-white"
                >
                  立即删除本机临时原图
                </Button>
              )}
              <Button
                onClick={confirmAll}
                disabled={busy || playerImport.completedCount !== 50 || playerImport.status === 'confirmed'}
                variant="outline"
                className="mt-4 min-h-11 w-full gap-2 rounded-xl border-lime-300/25 text-lime-200"
              >
                <Database className="size-4" />
                {playerImport.status === 'confirmed' ? 'B50 已确认' : '确认全部 50 项'}
              </Button>
            </div>
          </aside>
        </div>
      </div>
    </main>
  );
}
