export const API_ORIGIN = process.env.NEXT_PUBLIC_API_ORIGIN ?? '';

const ACCESS_KEY_STORAGE = 'maiup-access-key';

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

export function apiFetch(
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  const headers = new Headers(init.headers);
  const accessKey = getAccessKey();
  if (accessKey) headers.set('Authorization', `Bearer ${accessKey}`);
  return fetch(`${API_ORIGIN}${path}`, { ...init, headers });
}
