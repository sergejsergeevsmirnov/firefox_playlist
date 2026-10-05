// Bridge to the local yt-dlp HTTP server (video_host.py on 127.0.0.1:8765).
// The server downloads YouTube streams and serves them for the <video> element.
const BASE = 'http://127.0.0.1:8765';

async function post<T>(path: string, payload: Record<string, unknown>, timeoutMs: number): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${BASE}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    const json = (await response.json().catch(() => ({}))) as T;
    return json;
  } finally {
    clearTimeout(timer);
  }
}

export async function nativePing(): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 4000);
    try {
      const response = await fetch(`${BASE}/status`, { signal: controller.signal });
      return response.ok;
    } finally {
      clearTimeout(timer);
    }
  } catch {
    return false;
  }
}

export async function nativeStatus(): Promise<{ available: boolean; error?: string }> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 4000);
    try {
      const response = await fetch(`${BASE}/status`, { signal: controller.signal });
      return { available: response.ok };
    } finally {
      clearTimeout(timer);
    }
  } catch (error) {
    return { available: false, error: error instanceof Error ? error.message : String(error) };
  }
}

export async function nativeDownload(url: string, id: string): Promise<{ url: string }> {
  const res = await post<{ ok: boolean; url?: string; error?: string }>('/download', { url, id }, 15 * 60 * 1000);
  if (!res.ok || typeof res.url !== 'string') throw new Error(res.error || 'Загрузка через yt-dlp не удалась.');
  return { url: res.url };
}

export function nativeCleanup(id?: string): void {
  void post('/cleanup', { id: id || '' }, 15000).catch(() => {});
}
