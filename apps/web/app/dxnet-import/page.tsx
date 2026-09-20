'use client';

import { useEffect, useRef, useState } from 'react';
import {
  CheckCircle2,
  LoaderCircle,
  ShieldCheck,
  TriangleAlert,
} from 'lucide-react';
import { API_ORIGIN } from '@/lib/api';
import {
  DXNET_HANDOFF_CHANNEL,
  DXNET_HANDOFF_VERSION,
  DXNET_ORIGIN,
  parseDxnetPayloadMessage,
  readHandoffId,
} from '@/lib/dxnet-handoff';

type ImportState = 'waiting' | 'importing' | 'done' | 'error';

type ScoreImportResult = {
  id: string;
  detail?: string;
};

export default function DxnetImportPage() {
  const [state, setState] = useState<ImportState>('waiting');
  const [message, setMessage] = useState('正在等待 DX NET 发送成绩…');
  const importing = useRef(false);

  useEffect(() => {
    const handoffId = readHandoffId(window.location.hash);
    const opener = window.opener;
    if (!handoffId || !opener) {
      const timer = window.setTimeout(() => {
        setState('error');
        setMessage('自动导入会话无效。请回到本机 MaiUp，重新复制并运行书签。');
      }, 0);
      return () => window.clearTimeout(timer);
    }

    const envelope = (
      type: 'receiver-ready' | 'import-complete' | 'import-error',
      extra: Record<string, unknown> = {},
    ) => ({
      channel: DXNET_HANDOFF_CHANNEL,
      version: DXNET_HANDOFF_VERSION,
      type,
      handoffId,
      ...extra,
    });

    const receivePayload = async (event: MessageEvent) => {
      if (event.origin !== DXNET_ORIGIN || event.source !== opener) return;
      const handoff = parseDxnetPayloadMessage(event.data, handoffId);
      if (!handoff || importing.current) return;
      importing.current = true;
      window.history.replaceState(null, '', '/dxnet-import');
      setState('importing');
      setMessage(
        `已收到 ${handoff.payload.scores.length} 条成绩，正在本机校验并匹配谱面…`,
      );

      try {
        const response = await fetch(`${API_ORIGIN}/v1/imports/scores`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(handoff.payload),
        });
        const body = await response.text();
        const result = body ? (JSON.parse(body) as ScoreImportResult) : null;
        if (!response.ok || !result?.id) {
          throw new Error(
            result?.detail ?? `本地成绩导入失败 (${response.status})`,
          );
        }
        setState('done');
        setMessage('导入完成，正在打开成绩分析…');
        opener.postMessage(
          envelope('import-complete', { importId: result.id }),
          DXNET_ORIGIN,
        );
        window.setTimeout(() => {
          window.location.assign(`/scores/${result.id}`);
        }, 300);
      } catch (error: unknown) {
        const detail =
          error instanceof Error ? error.message : '本地成绩导入失败';
        setState('error');
        setMessage(`${detail} DX NET 页面会下载 JSON 兜底。`);
        opener.postMessage(
          envelope('import-error', { message: detail }),
          DXNET_ORIGIN,
        );
      }
    };

    window.addEventListener('message', receivePayload);
    opener.postMessage(envelope('receiver-ready'), DXNET_ORIGIN);
    return () => window.removeEventListener('message', receivePayload);
  }, []);

  const Icon =
    state === 'error'
      ? TriangleAlert
      : state === 'done'
        ? CheckCircle2
        : state === 'importing'
          ? LoaderCircle
          : ShieldCheck;

  return (
    <main className="grid min-h-screen place-items-center bg-background px-5 py-12 text-foreground">
      <section className="w-full max-w-xl rounded-[2rem] border border-fuchsia-300/15 bg-card/80 p-7 shadow-2xl shadow-fuchsia-950/30 sm:p-10">
        <div
          className={
            'grid size-14 place-items-center rounded-2xl border ' +
            (state === 'error'
              ? 'border-rose-300/25 bg-rose-300/10 text-rose-200'
              : 'border-fuchsia-300/25 bg-fuchsia-300/10 text-fuchsia-200')
          }
        >
          <Icon
            className={
              'size-7 ' + (state === 'importing' ? 'animate-spin' : '')
            }
          />
        </div>
        <p className="mt-6 text-xs font-semibold tracking-[0.22em] text-fuchsia-200 uppercase">
          Local DX NET handoff
        </p>
        <h1 className="mt-2 font-display text-3xl font-bold">自动导入成绩</h1>
        <p
          className={
            'mt-4 text-sm leading-7 ' +
            (state === 'error' ? 'text-rose-200' : 'text-muted-foreground')
          }
        >
          {message}
        </p>
        <div className="mt-7 rounded-2xl border border-white/8 bg-slate-950/35 p-4 text-xs leading-6 text-muted-foreground">
          只接收由当前 International DX NET
          窗口发送的一次性成绩消息；不会读取、保存或传输 SEGA 密码、Cookie
          或会话令牌。
        </div>
      </section>
    </main>
  );
}
