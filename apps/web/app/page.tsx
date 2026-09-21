'use client';

import { useEffect, useRef, useState } from 'react';
import {
  ArrowRight,
  CheckCircle2,
  Database,
  FileJson,
  FileImage,
  Fingerprint,
  Gauge,
  LockKeyhole,
  ShieldCheck,
  Sparkles,
  UploadCloud,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';
import {
  API_ORIGIN,
  apiFetch,
  clearAccessKey,
  setAccessKey,
} from '@/lib/api';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';

const phases = [
  { label: '曲库与定数', state: 'active' },
  { label: 'Rating 验证', state: 'next' },
  { label: 'B50 识别', state: 'next' },
  { label: '个性推荐', state: 'locked' },
] as const;

type DataSource = 'image' | 'account';

type CatalogStatus = {
  ready: boolean;
  songCount?: number;
  chartCount?: number;
  warningCount?: number;
};

type UploadState = 'idle' | 'uploading' | 'needs-calibration' | 'error';

type ScoreImportResult = {
  id: string;
  status: string;
  suppliedCount: number;
  matchedCount: number;
  unmatchedCount: number;
  duplicateCount: number;
  coverageRatio: string;
  issues: Array<{ sourceIndex: number; title: string; issueCode: string }>;
};

type RecentImport = {
  id: string;
  importedAt: string;
  matchedCount: number;
  b50Generated: boolean;
  b50Source: string | null;
};

async function readApiJson<T extends object>(
  response: Response,
  operation: string,
): Promise<T & { detail?: string }> {
  const body = await response.text();
  if (!body.trim()) {
    throw new Error(
      `${operation}失败：本地后端没有返回数据。请确认 8000 端口的后端 CMD 正在运行。`,
    );
  }
  try {
    return JSON.parse(body) as T & { detail?: string };
  } catch {
    throw new Error(
      `${operation}失败：后端返回了无法识别的响应 (${response.status})`,
    );
  }
}

function localApiError(error: unknown, fallback: string): string {
  if (error instanceof TypeError && /fetch|network/i.test(error.message)) {
    return '无法连接本地后端。请确认 8000 端口的后端 CMD 正在运行。';
  }
  return error instanceof Error ? error.message : fallback;
}

function isDataSource(value: unknown): value is DataSource {
  return value === 'image' || value === 'account';
}
export default function Home() {
  const fileInput = useRef<HTMLInputElement>(null);
  const scoreFileInput = useRef<HTMLInputElement>(null);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [dataSource, setDataSource] = useState<DataSource>('image');
  const [catalog, setCatalog] = useState<CatalogStatus | null>(null);
  const [uploadState, setUploadState] = useState<UploadState>('idle');
  const [uploadMessage, setUploadMessage] = useState<string | null>(null);
  const [scoreImportState, setScoreImportState] = useState<UploadState>('idle');
  const [scoreImportMessage, setScoreImportMessage] = useState<string | null>(
    null,
  );
  const [scoreImportResult, setScoreImportResult] =
    useState<ScoreImportResult | null>(null);
  const [bookmarkletMessage, setBookmarkletMessage] = useState<string | null>(
    null,
  );
  const [authState, setAuthState] = useState<'loading' | 'required' | 'ready'>(
    'loading',
  );
  const [accessInput, setAccessInput] = useState('');
  const [sessionName, setSessionName] = useState('');
  const [authMessage, setAuthMessage] = useState<string | null>(null);
  const [recentImports, setRecentImports] = useState<RecentImport[]>([]);
  const [imageImportEnabled, setImageImportEnabled] = useState(true);

  async function authenticate(candidate?: string) {
    if (candidate !== undefined) setAccessKey(candidate);
    await Promise.resolve();
    setAuthMessage(null);
    try {
      const response = await apiFetch('/v1/session');
      const payload = (await response.json()) as {
        displayName?: string;
        imageImportEnabled?: boolean;
        detail?: string;
      };
      if (!response.ok) throw new Error(payload.detail ?? '访问码无效');
      setSessionName(payload.displayName ?? 'MaiUp 玩家');
      const imageEnabled = payload.imageImportEnabled !== false;
      setImageImportEnabled(imageEnabled);
      if (!imageEnabled) setDataSource('account');
      setAuthState('ready');
      const recentResponse = await apiFetch('/v1/me/imports');
      if (recentResponse.ok) {
        setRecentImports((await recentResponse.json()) as RecentImport[]);
      }
    } catch (error: unknown) {
      clearAccessKey();
      setAuthState('required');
      if (candidate !== undefined) {
        setAuthMessage(error instanceof Error ? error.message : '访问码无效');
      }
    }
  }

  async function copyBookmarklet() {
    try {
      const response = await fetch('/maiup-dxnet-export.js', {
        cache: 'no-store',
      });
      if (!response.ok) throw new Error('无法加载导出脚本');
      const source = await response.text();
      const configuredSource = `globalThis.__MAIUP_IMPORT_ORIGIN__=${JSON.stringify(
        window.location.origin,
      )};${source}`;
      const bookmarklet = `javascript:${configuredSource.replace(/\r?\n/g, ' ')}`;
      await navigator.clipboard.writeText(bookmarklet);
      setBookmarkletMessage('已复制自动导入书签。保存后，在已登录的 DX NET 页面点击一次。');
    } catch (error: unknown) {
      setBookmarkletMessage(
        error instanceof Error ? error.message : '复制失败',
      );
    }
  }

  async function importScoreFile(file: File | null) {
    if (!file) return;
    setScoreImportState('uploading');
    setScoreImportMessage('正在校验并匹配谱面…');
    setScoreImportResult(null);
    try {
      if (file.size > 5 * 1024 * 1024)
        throw new Error('JSON 文件不能超过 5 MB');
      const payload: unknown = JSON.parse(await file.text());
      const response = await apiFetch('/v1/imports/scores', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const result = await readApiJson<ScoreImportResult>(response, '成绩导入');
      if (!response.ok)
        throw new Error(result.detail ?? `成绩导入失败 (${response.status})`);
      setScoreImportResult(result);
      setScoreImportState('needs-calibration');
      setScoreImportMessage(
        `已匹配 ${result.matchedCount} 张谱面，${result.unmatchedCount} 项待处理，忽略 ${result.duplicateCount} 条较低重复成绩。`,
      );
      window.location.assign(`/scores/${result.id}`);
    } catch (error: unknown) {
      setScoreImportState('error');
      setScoreImportMessage(localApiError(error, '无法读取成绩 JSON'));
    } finally {
      if (scoreFileInput.current) scoreFileInput.current.value = '';
    }
  }

  function chooseFile(file: File | null) {
    setSelectedFile(file);
    setUploadState('idle');
    setUploadMessage(null);
  }

  async function inspectSelectedImage() {
    if (!selectedFile) return;
    setUploadState('uploading');
    setUploadMessage('正在检查图片完整性…');
    const body = new FormData();
    body.append('image', selectedFile);
    try {
      const response = await apiFetch('/v1/imports/b50/inspect', {
        method: 'POST',
        body,
      });
      const payload = await readApiJson<{
        detail?: string;
        width?: number;
        height?: number;
        sourceImageStored?: boolean;
        recognizedCount?: number;
        autoMatchedCount?: number;
        importId?: string;
        reviewUrl?: string;
      }>(response, '图片检查');
      if (!response.ok)
        throw new Error(payload.detail ?? `图片检查失败 (${response.status})`);
      setUploadState('needs-calibration');
      setUploadMessage(
        `安全检查通过：${payload.width} × ${payload.height}。正在本机识别，已读取 ${payload.recognizedCount ?? 0} 项、自动匹配 ${payload.autoMatchedCount ?? 0} 项…`,
      );
      if (!payload.reviewUrl || !payload.importId) {
        throw new Error('曲库尚未就绪，无法建立 B50 校正表');
      }
      window.location.assign(payload.reviewUrl);
    } catch (error: unknown) {
      setUploadState('error');
      setUploadMessage(localApiError(error, '无法连接本地图片检查服务'));
    }
  }

  useEffect(() => {
    queueMicrotask(() => void authenticate());
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    fetch(`${API_ORIGIN}/v1/catalog/status`, { signal: controller.signal })
      .then((response) => {
        if (!response.ok) throw new Error(`catalog status ${response.status}`);
        return response.json() as Promise<CatalogStatus>;
      })
      .then(setCatalog)
      .catch((error: unknown) => {
        if (error instanceof DOMException && error.name === 'AbortError')
          return;
        setCatalog({ ready: false });
      });
    return () => controller.abort();
  }, []);

  useEffect(() => {
    const context = document.modelContext;
    if (!context?.registerTool) return;
    const lifecycle = new AbortController();

    void Promise.resolve(
      context.registerTool(
        {
          name: 'select_data_source',
          title: '选择成绩数据来源',
          description: '在页面中切换到 B50 图片上传或完整成绩导入入口。',
          inputSchema: {
            type: 'object',
            properties: {
              source: { type: 'string', enum: ['image', 'account'] },
            },
            required: ['source'],
            additionalProperties: false,
          },
          annotations: { readOnlyHint: false, untrustedContentHint: false },
          execute(input: unknown) {
            const source =
              typeof input === 'object' && input !== null && 'source' in input
                ? (input as { source: unknown }).source
                : undefined;
            if (!isDataSource(source))
              throw new Error('source must be image or account');
            setDataSource(source);
            return { selectedSource: source };
          },
        },
        { signal: lifecycle.signal },
      ),
    ).catch(() => undefined);

    return () => lifecycle.abort();
  }, []);

  if (authState !== 'ready') {
    return (
      <main className="grid min-h-screen place-items-center bg-background p-6 text-foreground">
        <form
          className="w-full max-w-md rounded-3xl border border-cyan-200/15 bg-card p-7 shadow-2xl"
          onSubmit={(event) => {
            event.preventDefault();
            void authenticate(accessInput);
          }}
        >
          <LockKeyhole className="size-9 text-cyan-200" />
          <h1 className="mt-4 font-display text-3xl font-bold">进入 MaiUp</h1>
          <p className="mt-2 text-sm leading-6 text-muted-foreground">
            输入分配给你的个人访问码。每个访问码只会看到自己的 B50 和推荐。
          </p>
          <input
            type="password"
            autoComplete="current-password"
            value={accessInput}
            onChange={(event) => setAccessInput(event.target.value)}
            placeholder="个人访问码"
            className="mt-6 min-h-12 w-full rounded-xl border border-white/12 bg-slate-950/50 px-4 outline-none focus:border-cyan-300"
          />
          {authMessage && <p className="mt-3 text-sm text-rose-300">{authMessage}</p>}
          <Button
            type="submit"
            disabled={authState === 'loading' || !accessInput.trim()}
            className="mt-5 min-h-12 w-full rounded-xl bg-cyan-300 text-slate-950 hover:bg-cyan-200"
          >
            {authState === 'loading' ? '正在连接…' : '进入'}
          </Button>
        </form>
      </main>
    );
  }

  return (
    <main className="min-h-screen overflow-hidden bg-background text-foreground">
      <div className="mx-auto min-h-screen max-w-[1500px] px-4 py-4 sm:px-6 lg:px-8">
        <header className="flex h-16 items-center justify-between border-b border-white/8">
          <div className="flex items-center gap-3">
            <div className="mai-disc grid size-10 place-items-center rounded-full">
              <span className="size-3 rounded-full bg-background shadow-[0_0_20px_var(--pulse)]" />
            </div>
            <div>
              <p className="font-display text-lg font-extrabold tracking-tight">
                MaiUp
              </p>
              <p className="text-xs text-muted-foreground">
                International Rating Lab
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => {
                clearAccessKey();
                setAuthState('required');
                setAccessInput('');
              }}
              className="rounded-lg px-2 py-1 text-xs text-muted-foreground hover:text-white"
            >
              {sessionName} · 退出
            </button>
            <Badge
              variant="outline"
              className="hidden border-cyan-300/25 bg-cyan-300/8 text-cyan-100 sm:inline-flex"
            >
              CiRCLE PLUS
            </Badge>
            <Badge className="border-0 bg-lime-300 text-slate-950">
              Phase 1
            </Badge>
          </div>
        </header>

        <div className="grid gap-6 py-6 lg:grid-cols-[230px_minmax(0,1fr)_290px]">
          <aside className="order-2 rounded-3xl border border-white/8 bg-card/45 p-5 backdrop-blur-xl lg:order-1">
            <p className="eyebrow">BUILD STATUS</p>
            <div className="mt-5 space-y-1">
              {phases.map((phase, index) => (
                <div
                  key={phase.label}
                  className={
                    'flex items-center gap-3 rounded-2xl px-3 py-3 ' +
                    (phase.state === 'active'
                      ? 'bg-cyan-300/10 text-cyan-100'
                      : 'text-muted-foreground')
                  }
                >
                  <span
                    className={
                      'grid size-7 shrink-0 place-items-center rounded-full border text-xs font-bold ' +
                      (phase.state === 'active'
                        ? 'border-cyan-300 bg-cyan-300 text-slate-950'
                        : 'border-white/12 bg-white/3')
                    }
                  >
                    {phase.state === 'locked' ? (
                      <LockKeyhole className="size-3.5" />
                    ) : (
                      index + 1
                    )}
                  </span>
                  <span className="text-sm font-medium">{phase.label}</span>
                </div>
              ))}
            </div>

            <div className="mt-8 border-t border-white/8 pt-5">
              <div className="mb-2 flex items-center justify-between text-xs">
                <span className="text-muted-foreground">数据基础</span>
                <span className="font-semibold text-cyan-200">
                  {catalog?.ready
                    ? '已通过校验'
                    : catalog === null
                      ? '正在连接'
                      : '等待 API'}
                </span>
              </div>
              <Progress
                value={catalog?.ready ? 50 : 24}
                className="h-1.5 bg-white/8 [&_[data-slot=progress-indicator]]:bg-cyan-300"
              />
              <p className="mt-3 text-xs leading-5 text-muted-foreground">
                {catalog?.ready
                  ? `${catalog.songCount?.toLocaleString()} 首国际服曲目 · ${catalog.chartCount?.toLocaleString()} 张谱面`
                  : 'Rating 通过真实国际服样本前，推荐功能保持锁定。'}
              </p>
            </div>
          </aside>

          <section className="order-1 min-w-0 lg:order-2">
            <div className="mb-6 flex flex-col justify-between gap-4 sm:flex-row sm:items-end">
              <div>
                <p className="eyebrow text-cyan-200">YOUR DATA, YOUR CLIMB</p>
                <h1 className="mt-2 max-w-3xl font-display text-3xl font-black tracking-[-0.04em] sm:text-5xl">
                  先把成绩读对，
                  <span className="text-gradient">再谈适合你的上分曲。</span>
                </h1>
              </div>
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <ShieldCheck className="size-4 text-lime-300" />
                图片默认短期处理
              </div>
            </div>

            {recentImports.length > 0 && (
              <div className="mb-5 rounded-2xl border border-cyan-200/15 bg-cyan-300/5 p-4">
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <p className="text-sm font-bold text-cyan-100">最近一次 B50</p>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {new Date(recentImports[0].importedAt).toLocaleString()} · 匹配{' '}
                      {recentImports[0].matchedCount} 张谱面
                    </p>
                  </div>
                  {recentImports[0].b50Generated && (
                    <div className="flex flex-wrap justify-end gap-2">
                      <a
                        href={`/scores/${recentImports[0].id}`}
                        className="rounded-xl border border-cyan-200/20 px-3 py-2 text-sm text-cyan-100"
                      >
                        查看 B50
                      </a>
                      <a
                        href={`/recommendations/${recentImports[0].id}`}
                        className="rounded-xl bg-cyan-300 px-3 py-2 text-sm font-bold text-slate-950"
                      >
                        查看推荐
                      </a>
                    </div>
                  )}
                </div>
              </div>
            )}

            <Tabs
              value={dataSource}
              onValueChange={(value) => {
                if (isDataSource(value)) setDataSource(value);
              }}
              className="gap-4"
            >
              <TabsList className="h-auto w-full justify-start rounded-2xl border border-white/8 bg-card/55 p-1.5 sm:w-auto">
                {imageImportEnabled && (
                  <TabsTrigger
                    value="image"
                    className="min-h-11 gap-2 rounded-xl px-4 data-active:bg-white/10 data-active:text-white"
                  >
                    <FileImage className="size-4" /> 仅导入 B50 图片
                  </TabsTrigger>
                )}
                <TabsTrigger
                  value="account"
                  className="min-h-11 gap-2 rounded-xl px-4 data-active:bg-white/10 data-active:text-white"
                >
                  <Database className="size-4" /> 导入全部成绩
                </TabsTrigger>
              </TabsList>

              {imageImportEnabled && (
                <TabsContent value="image">
                <div className="grid-lines relative overflow-hidden rounded-[2rem] border border-cyan-200/15 bg-card/70 p-5 shadow-2xl shadow-cyan-950/20 sm:p-8">
                  <div className="relative z-10">
                    <div className="flex items-start justify-between gap-4">
                      <div>
                        <Badge
                          variant="outline"
                          className="border-lime-300/25 bg-lime-300/8 text-lime-200"
                        >
                          推荐入口
                        </Badge>
                        <h2 className="mt-4 font-display text-2xl font-bold">
                          只用 B50 快速推荐
                        </h2>
                        <p className="mt-2 max-w-xl text-sm leading-6 text-muted-foreground">
                          上传标准 B50 成绩图，识别并校对 B35/B15
                          后开始推荐。速度快，但只能根据榜内 50
                          张谱面推断你的水平和擅长类型。
                        </p>
                      </div>
                      <div className="hidden size-16 place-items-center rounded-2xl border border-cyan-300/15 bg-cyan-300/8 sm:grid">
                        <Fingerprint className="size-7 text-cyan-200" />
                      </div>
                    </div>

                    <button
                      type="button"
                      onClick={() => fileInput.current?.click()}
                      onDragOver={(event) => event.preventDefault()}
                      onDrop={(event) => {
                        event.preventDefault();
                        chooseFile(event.dataTransfer.files.item(0));
                      }}
                      className="group mt-7 flex min-h-64 w-full cursor-pointer flex-col items-center justify-center rounded-3xl border border-dashed border-cyan-200/25 bg-slate-950/35 px-6 text-center transition hover:border-cyan-200/50 hover:bg-cyan-300/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-300"
                    >
                      <span className="grid size-14 place-items-center rounded-2xl bg-cyan-300 text-slate-950 shadow-[0_0_40px_rgb(103_232_249/18%)] transition group-hover:-translate-y-1">
                        {selectedFile ? (
                          <CheckCircle2 className="size-6" />
                        ) : (
                          <UploadCloud className="size-6" />
                        )}
                      </span>
                      <span className="mt-4 text-base font-bold">
                        {selectedFile?.name ?? '选择或拖入 B50 图片'}
                      </span>
                      <span className="mt-1 text-sm text-muted-foreground">
                        {selectedFile
                          ? '图片已选中，可以先做安全检查'
                          : 'PNG / JPEG · 暂不上传玩家账号信息'}
                      </span>
                    </button>
                    <input
                      ref={fileInput}
                      type="file"
                      accept="image/png,image/jpeg"
                      className="sr-only"
                      onChange={(event) =>
                        chooseFile(event.target.files?.item(0) ?? null)
                      }
                    />

                    <div className="mt-5 flex flex-col justify-between gap-3 sm:flex-row sm:items-center">
                      <p
                        className={
                          'max-w-xl text-xs leading-5 ' +
                          (uploadState === 'error'
                            ? 'text-rose-300'
                            : 'text-muted-foreground')
                        }
                      >
                        {uploadMessage ??
                          '下一步：图片会在本机临时保存用于 OCR；不会上传到云端，也不会直接用未核对结果推荐。'}
                      </p>
                      <Button
                        disabled={!selectedFile || uploadState === 'uploading'}
                        onClick={inspectSelectedImage}
                        className="min-h-11 gap-2 rounded-xl bg-cyan-300 text-slate-950 hover:bg-cyan-200 disabled:opacity-45"
                      >
                        {uploadState === 'uploading' ? '检查中…' : '检查图片'}{' '}
                        <ArrowRight className="size-4" />
                      </Button>
                    </div>
                  </div>
                </div>
                </TabsContent>
              )}

              <TabsContent value="account">
                <div className="rounded-[2rem] border border-fuchsia-300/15 bg-card/70 p-6 sm:p-8">
                  <div className="flex flex-col gap-6 sm:flex-row sm:items-center sm:justify-between">
                    <div className="max-w-2xl">
                      <Badge
                        variant="outline"
                        className="border-fuchsia-300/25 bg-fuchsia-300/8 text-fuchsia-200"
                      >
                        授权研究中
                      </Badge>
                      <h2 className="mt-4 font-display text-2xl font-bold">
                        用全部成绩做完整分析
                      </h2>
                      <p className="mt-2 text-sm leading-6 text-muted-foreground">
                        从 DX NET 读取所有已游玩谱面，并优先采用官网 Rating
                        Target 的
                        B35/B15。完整成绩能识别榜外成绩、舒适定数和谱面类型偏好，推荐会比只看
                        B50 更个性化。
                      </p>
                      <div className="mt-5 flex flex-col gap-3 sm:flex-row sm:items-center">
                        <Button
                          type="button"
                          onClick={() => void copyBookmarklet()}
                          className="min-h-11 gap-2 rounded-xl bg-fuchsia-300 text-slate-950 hover:bg-fuchsia-200"
                        >
                          <Sparkles className="size-4" />
                          复制自动导入书签
                        </Button>
                        <Button
                          type="button"
                          variant="outline"
                          disabled={scoreImportState === 'uploading'}
                          onClick={() => scoreFileInput.current?.click()}
                          className="min-h-11 gap-2 rounded-xl border-fuchsia-200/20 bg-fuchsia-300/5 text-fuchsia-100 hover:bg-fuchsia-300/10"
                        >
                          <FileJson className="size-4" />
                          {scoreImportState === 'uploading'
                            ? '导入中…'
                            : 'JSON 兜底导入'}
                        </Button>
                        <input
                          ref={scoreFileInput}
                          type="file"
                          accept="application/json,.json"
                          className="sr-only"
                          onChange={(event) =>
                            void importScoreFile(
                              event.target.files?.item(0) ?? null,
                            )
                          }
                        />
                        <p
                          className={
                            scoreImportState === 'error'
                              ? 'text-sm text-rose-300'
                              : 'text-sm text-muted-foreground'
                          }
                        >
                          {scoreImportMessage ??
                            bookmarkletMessage ??
                            '到已登录的 DX NET 页面运行书签；失败时可上传导出的 JSON。'}
                        </p>
                      </div>
                      <div className="mt-4 rounded-2xl border border-white/8 bg-white/3 p-4">
                        <p className="text-sm font-semibold text-fuchsia-100">
                          从 DX NET 导出
                        </p>
                        <p className="mt-1 text-xs leading-5 text-muted-foreground">
                          将脚本保存成书签。在已登录的 International DX NET
                          页面点击一次，它会先打开 MaiUp，再读取全部 5
                          个难度、官网 B35/B15
                          和相关谱面的最后游玩时间，自动导入并跳转分析。若弹窗、本机服务或通信失败，会自动下载
                          JSON；账号凭据不会离开 DX
                          NET，日期读取可能需要几十秒。
                        </p>
                      </div>
                      {scoreImportResult && (
                        <div className="mt-5 rounded-2xl border border-fuchsia-200/15 bg-slate-950/35 p-4">
                          <div className="flex flex-wrap gap-x-5 gap-y-2 text-sm">
                            <span>
                              抓到 {scoreImportResult.suppliedCount} 条
                            </span>
                            <span className="text-lime-200">
                              匹配 {scoreImportResult.matchedCount}
                            </span>
                            <span
                              className={
                                scoreImportResult.unmatchedCount
                                  ? 'text-amber-200'
                                  : 'text-lime-200'
                              }
                            >
                              待处理 {scoreImportResult.unmatchedCount}
                            </span>
                            <span>
                              曲库匹配率{' '}
                              {(
                                Number(scoreImportResult.coverageRatio) * 100
                              ).toFixed(1)}
                              %
                            </span>
                          </div>
                          {scoreImportResult.issues.length > 0 && (
                            <p className="mt-3 text-xs leading-5 text-muted-foreground">
                              首个待处理项目：
                              {scoreImportResult.issues[0].title}（
                              {scoreImportResult.issues[0].issueCode}）
                            </p>
                          )}
                        </div>
                      )}
                    </div>
                    <div className="grid size-20 shrink-0 place-items-center rounded-full border border-fuchsia-300/20 bg-fuchsia-300/8">
                      <LockKeyhole className="size-8 text-fuchsia-200" />
                    </div>
                  </div>
                </div>
              </TabsContent>
            </Tabs>
          </section>

          <aside className="order-3 space-y-4">
            <div className="rounded-3xl border border-white/8 bg-card/45 p-5">
              <div className="flex items-center gap-2">
                <Gauge className="size-4 text-cyan-200" />
                <h2 className="font-display text-sm font-bold">当前计分池</h2>
              </div>
              <div className="mt-5 grid grid-cols-2 gap-3">
                <div className="rounded-2xl bg-white/4 p-4">
                  <p className="text-2xl font-black text-cyan-200">B35</p>
                  <p className="mt-1 text-xs text-muted-foreground">较早版本</p>
                </div>
                <div className="rounded-2xl bg-white/4 p-4">
                  <p className="text-2xl font-black text-lime-200">B15</p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    最新两个版本
                  </p>
                </div>
              </div>
              <div className="mt-4 rounded-2xl border border-lime-300/12 bg-lime-300/5 p-4">
                <p className="text-xs font-bold text-lime-200">当前实例</p>
                <p className="mt-1 text-sm font-semibold">
                  CiRCLE PLUS + CiRCLE
                </p>
                <p className="mt-1 text-xs leading-5 text-muted-foreground">
                  换代后按版本顺序自动滚动，不写死名称。
                </p>
              </div>
            </div>

            <div className="rounded-3xl border border-white/8 bg-card/45 p-5">
              <div className="flex items-center gap-2">
                <Sparkles className="size-4 text-fuchsia-200" />
                <h2 className="font-display text-sm font-bold">推荐护栏</h2>
              </div>
              <ul className="mt-4 space-y-3 text-sm text-muted-foreground">
                {[
                  '不把榜外曲写成“没玩过”',
                  '不只按理论收益排序',
                  '数据不足就明确说明',
                  '定数按 International 版本取值',
                ].map((item) => (
                  <li key={item} className="flex gap-2.5">
                    <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-fuchsia-200" />
                    <span>{item}</span>
                  </li>
                ))}
              </ul>
            </div>
          </aside>
        </div>
      </div>
    </main>
  );
}
