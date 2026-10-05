import { httpUrl, mediaFormat } from './core';
import type { Variant } from './model';

export function rutubeOptionsUrl(source: string): string | undefined {
  const url = new URL(source);
  if (!/(^|\.)rutube\.ru$/.test(url.hostname)) return;
  const id = /^\/(?:video|play\/embed)\/([a-f0-9]{32})(?:\/|$)/i.exec(url.pathname)?.[1];
  return id ? `https://rutube.ru/api/play/options/${id}/?format=json` : undefined;
}
export function rutubeStreams(text: string): { variants: Variant[]; duration?: number } {
  const data = JSON.parse(text);
  if (data.acl_access?.allowed === false || data.drm_token) throw new Error('Rutube ограничивает доступ к ролику: используйте плеер сайта.');
  const variants: Variant[] = [];
  for (const value of Object.values(data.video_balancer ?? {})) {
    const url = typeof value === 'string' ? httpUrl(value) : undefined;
    const format = url ? mediaFormat(url) : undefined;
    if (url && format && !variants.some(v => v.url === url)) variants.push({url,format});
  }
  if (!variants.length) throw new Error('Rutube не предоставил открытый поток для этого ролика.');
  return {variants, duration: typeof data.duration === 'number' && data.duration > 0 ? data.duration / 1000 : undefined};
}
