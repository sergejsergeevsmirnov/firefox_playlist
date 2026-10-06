import type { Variant } from './model';
import { vimeoIdentity, vimeoResourceManifests } from './capture-policy';
import { httpUrl, mediaFormat } from './core';

export function vimeoConfigUrl(sourceUrl: string): string | undefined {
  const id = vimeoIdentity(sourceUrl)?.slice(6);
  return id ? `https://player.vimeo.com/video/${id}/config` : undefined;
}

export function vimeoStreams(text: string): { variants: Variant[]; title?: string; duration?: number } {
  const data = JSON.parse(text) as Record<string, unknown>;
  const request = (data.request ?? {}) as Record<string, unknown>;
  const video = (data.video ?? {}) as Record<string, unknown>;
  const files = (request.files ?? {}) as Record<string, unknown>;
  const variants: Variant[] = [];

  const hlsData = (files.hls ?? {}) as Record<string, unknown>;
  const hlsCdns = (hlsData.cdns ?? {}) as Record<string, Record<string, unknown>>;
  const hlsKey = (hlsData.default_cdn as string) || Object.keys(hlsCdns)[0];
  const hlsUrl = hlsKey ? httpUrl(hlsCdns[hlsKey]?.url as string) : undefined;
  if (hlsUrl) variants.push({ url: hlsUrl, format: 'hls' });

  const dashData = (files.dash ?? {}) as Record<string, unknown>;
  const dashCdns = (dashData.cdns ?? {}) as Record<string, Record<string, unknown>>;
  const dashKey = (dashData.default_cdn as string) || Object.keys(dashCdns)[0];
  const dashUrl = dashKey ? httpUrl(dashCdns[dashKey]?.url as string) : undefined;
  if (dashUrl) variants.push({ url: dashUrl, format: 'dash' });

  const progressive = files.progressive as Array<Record<string, unknown>> | undefined;
  if (Array.isArray(progressive)) {
    for (const p of progressive) {
      const url = httpUrl(p.url as string);
      const w = typeof p.width === 'number' ? p.width : undefined;
      const h = typeof p.height === 'number' ? p.height : undefined;
      if (url) variants.push({ url, format: 'file', width: w, height: h });
    }
  }

  const title = typeof video.title === 'string' ? video.title : undefined;
  const duration = typeof video.duration === 'number' && Number.isFinite(video.duration)
    ? video.duration : undefined;
  return { variants, title, duration };
}

// Open a muted background tab and capture HLS/DASH manifests the Vimeo player
// requests from vimeocdn.com. Mirrors the VK approach.
export async function readVimeoPlayer(sourceUrl: string, signal: AbortSignal): Promise<Variant[]> {
  signal.throwIfAborted();
  const id = vimeoIdentity(sourceUrl)?.slice(6);
  if (!id) throw new Error('Не распознан адрес ролика Vimeo.');
  // Use the embed player — it's designed for iframe use and has no bot challenge,
  // unlike vimeo.com which shows Cloudflare verification on headless navigation.
  const embedUrl = `https://player.vimeo.com/video/${id}?autoplay=1&muted=1`;
  const pageUrl = `https://player.vimeo.com/video/${id}`;
  const tab = await browser.tabs.create({ url: 'about:blank', active: false });
  if (tab.id === undefined) throw new Error('Не удалось открыть фоновую вкладку Vimeo.');
  const tabId = tab.id;
  const streams = new Map<string, Variant>();
  const listener = (details: browser.webRequest._OnHeadersReceivedDetails) => {
    if (details.tabId !== tabId || details.statusCode >= 400) return;
    if (!vimeoResourceManifests(pageUrl, [details.url]).length) return;
    const mime = details.responseHeaders?.find(h => h.name.toLowerCase() === 'content-type')?.value || '';
    const format = mediaFormat(details.url, mime);
    if (format === 'hls' || format === 'dash') streams.set(details.url, { url: details.url, format });
  };
  try {
    browser.webRequest.onHeadersReceived.addListener(listener,
      { urls: ['https://*.vimeocdn.com/*'] }, ['responseHeaders']);
    await browser.tabs.update(tabId, { muted: true });
    await browser.tabs.update(tabId, { url: embedUrl });
    const deadline = Date.now() + 25000;
    while (Date.now() < deadline) {
      signal.throwIfAborted();
      if (streams.size) return [...streams.values()];
      await new Promise(resolve => setTimeout(resolve, 400));
    }
    throw new Error('Vimeo не предоставил манифест за 25 секунд в фоновой вкладке. Проверьте доступность сайта.');
  } finally {
    browser.webRequest.onHeadersReceived.removeListener(listener);
    await browser.tabs.remove(tabId).catch(() => {});
  }
}
