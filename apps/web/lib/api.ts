export const API_ORIGIN = process.env.NEXT_PUBLIC_API_ORIGIN ?? '';

const ACCESS_KEY_STORAGE = 'maiup-access-key';
const API_READY_TTL_MS = 60_000;
const API_WAKE_DEADLINE_MS = 90_000;
const API_WAKE_ATTEMPT_MS = 25_000;
const API_WAKE_RETRY_MS = 2_000;
const API_WAKE_NOTICE_MS = 1_200;

type ApiFetchOptions = {
  onWaiting?: () => void;
};

let lastApiReadyAt = 0;
let apiWakePromise: Promise<void> | null = null;

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, milliseconds));
}

function markApiReady(): void {
  lastApiReadyAt = Date.now();
}

async function probeApi(): Promise<boolean> {
  const controller = new AbortController();
  const timer = window.setTimeout(
    () => controller.abort(),
    API_WAKE_ATTEMPT_MS,
  );
  try {
    const response = await fetch(`${API_ORIGIN}/health`, {
      cache: 'no-store',
      signal: controller.signal,
    });
    if (!response.ok) return false;
    markApiReady();
    return true;
  } catch {
    return false;
  } finally {
    window.clearTimeout(timer);
  }
}

async function runWakeLoop(): Promise<void> {
  const deadline = Date.now() + API_WAKE_DEADLINE_MS;
  while (Date.now() < deadline) {
    if (await probeApi()) return;
    await delay(API_WAKE_RETRY_MS);
  }
  throw new Error('服务器唤醒超时，请稍后刷新页面重试。');
}

export async function ensureApiAwake(onWaiting?: () => void): Promise<void> {
  if (Date.now() - lastApiReadyAt < API_READY_TTL_MS) return;

  const noticeTimer = onWaiting
    ? window.setTimeout(onWaiting, API_WAKE_NOTICE_MS)
    : null;
  if (!apiWakePromise) {
    apiWakePromise = runWakeLoop().finally(() => {
      apiWakePromise = null;
    });
  }
  try {
    await apiWakePromise;
  } finally {
    if (noticeTimer !== null) window.clearTimeout(noticeTimer);
  }
}

export function getAccessKey(): string {
  if (typeof window === 'undefined') return '';
  return window.localStorage.getItem(ACCESS_KEY_STORAGE) ?? '';
}

export function setAccessKey(value: string): void {
  window.localStorage.setItem(ACCESS_KEY_STORAGE, value.trim());
}

export function clearAccessKey(): void {
  window.localStorage.removeItem(ACCESS_KEY_STORAGE);
}

export async function apiFetch(
  path: string,
  init: RequestInit = {},
  options: ApiFetchOptions = {},
): Promise<Response> {
  const method = (init.method ?? 'GET').toUpperCase();
  const safeToRetry = method === 'GET' || method === 'HEAD';
  const request = () => {
    const headers = new Headers(init.headers);
    const accessKey = getAccessKey();
    if (accessKey) headers.set('Authorization', `Bearer ${accessKey}`);
    return fetch(`${API_ORIGIN}${path}`, { ...init, headers });
  };

  if (!safeToRetry) await ensureApiAwake(options.onWaiting);

  const noticeTimer =
    safeToRetry && options.onWaiting
      ? window.setTimeout(options.onWaiting, API_WAKE_NOTICE_MS)
      : null;
  try {
    const response = await request();
    if (response.status < 500) markApiReady();
    if (!safeToRetry || ![502, 503, 504].includes(response.status)) {
      return response;
    }
  } catch (error: unknown) {
    if (error instanceof DOMException && error.name === 'AbortError') {
      throw error;
    }
    if (!safeToRetry) throw error;
  } finally {
    if (noticeTimer !== null) window.clearTimeout(noticeTimer);
  }

  lastApiReadyAt = 0;
  await ensureApiAwake(options.onWaiting);
  const response = await request();
  if (response.status < 500) markApiReady();
  return response;
}
