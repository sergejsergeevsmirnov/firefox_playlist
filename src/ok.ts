import { httpUrl } from './core';
import type { Variant } from './model';
export function okPageUrl(source: string): string | undefined {
  const u = new URL(source);
  const id = /^\/video\/(\d+)(?:\/|$)/.exec(u.pathname)?.[1];
  return /^(?:www\.)?ok\.ru$/.test(u.hostname) && id ? `https://ok.ru/video/${id}` : undefined;
}
export function okStreams(html: string, source: string): {variants: Variant[]; duration?: number} {
  const id = new URL(source).pathname.split('/')[2];
  const doc = new DOMParser().parseFromString(html, 'text/html');
  for (const node of doc.querySelectorAll('[data-options]')) {
    let data;
    try { const options = JSON.parse(node.getAttribute('data-options') || '{}'); data = options.flashvars?.metadata; if (typeof data === 'string') data = JSON.parse(data); } catch { continue; }
    if (!data || String(data.movie?.id) !== id) continue;
    const hls = httpUrl(data.hlsManifestUrl);
    const variants: Variant[] = hls ? [{url:hls,format:'hls'}] : [];
    if (!hls) for (const item of data.videos ?? []) { const url = httpUrl(item.url); if (url) variants.push({url,format:'file'}); }
    if (variants.length) return {variants,duration:Number(data.movie.duration) || undefined};
  }
  throw new Error('OK не предоставил открытый поток выбранного ролика. Откройте источник для проверки доступа.');
}
