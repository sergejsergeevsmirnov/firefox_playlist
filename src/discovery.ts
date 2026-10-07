import { candidateId, httpUrl, mediaFormat } from './core';
import type { Candidate, Variant } from './model';
import { isPreviewUrl, isShortPreview } from './media-policy';

export function parseDuration(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return value;
  if (typeof value !== 'string') return;
  const s = value.trim();
  const iso = /^PT(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?$/i.exec(s);
  if (iso) return Number(iso[1] || 0) * 3600 + Number(iso[2] || 0) * 60 + Number(iso[3] || 0);
  if (/^\d{1,3}:\d{2}(?::\d{2})?$/.test(s)) return s.split(':').reduce((n, part) => n * 60 + Number(part), 0);
  if (/^\d+(?:\.\d+)?$/.test(s)) return Number(s);
}
function variant(url: string, mime?: string): Variant | undefined {
  if (isPreviewUrl(url)) return;
  const format = mediaFormat(url, mime);
  return format ? { url, format } : undefined;
}
function previewElement(video: HTMLVideoElement, pageUrl: string): boolean {
  if (isPreviewUrl(video.currentSrc || httpUrl(video.getAttribute('src'), pageUrl) || '')) return true;
  if (/(?:preview|thumbnail|thumb|teaser)/i.test(`${video.className} ${video.getAttribute('data-role') || ''}`)) return true;
  return isYandexVideo(pageUrl) && (!!video.closest('.VideoSnippet, .VideoThumb3, .serp-item, .VideoCard, [data-video], [data-testid="video-card"]') || (!video.controls && (video.muted || video.hasAttribute('muted'))));
}
export function discoverPreviewUrls(doc: Document, pageUrl: string): string[] {
  return [...doc.querySelectorAll('video')].filter(v => previewElement(v, pageUrl))
    .flatMap(v => [v.currentSrc, v.getAttribute('src'), ...[...v.querySelectorAll('source')].map(s => s.src)])
    .map(value => httpUrl(value, pageUrl)).filter((value): value is string => !!value);
}
/** Read serialized player data, not executable JavaScript, to find full quality variants. */
export function discoverEmbedded(doc: Document, pageUrl: string): Candidate[] {
  const found: Candidate[] = [];
  const previewKey = /preview|thumb|storyboard|teaser|advert|recommend|related/i;
  const streamKey = /^(?:contentUrl|hls(?:Url)?|dash(?:Url)?|manifest(?:Url)?|mp4(?:_?\d+)?|url(?:_?\d+)?|src|file)$/i;
  const parseValue = (key: string, raw: unknown, mime?: string): Variant | undefined => {
    const url = typeof raw === 'string' ? httpUrl(raw, pageUrl) : undefined;
    if (!url || isPreviewUrl(url)) return;
    const format = mediaFormat(url, mime) || (/hls/i.test(key) ? 'hls' : /dash/i.test(key) ? 'dash' : /^mp4/i.test(key) ? 'file' : undefined);
    return format ? { url, format } : undefined;
  };
  const walk = (value: unknown, depth = 0) => {
    if (!value || typeof value !== 'object' || depth > 18 || found.length >= 200) return;
    if (Array.isArray(value)) { value.slice(0, 500).forEach(v => walk(v, depth + 1)); return; }
    const data = value as Record<string, unknown>;
    const variants: Variant[] = [];
    for (const [key, value] of Object.entries(data)) {
      if (streamKey.test(key)) {
        const v = parseValue(key, value, typeof data.type === 'string' ? data.type : undefined); if (v) variants.push(v);
      }
      if (/^(?:sources|files|qualities|streams)$/i.test(key) && value && typeof value === 'object') {
        for (const [sourceKey, source] of Object.entries(value)) {
          if (previewKey.test(sourceKey)) continue;
          if (typeof source === 'string') { const v = parseValue(sourceKey, source); if (v) variants.push(v); }
          else if (source && typeof source === 'object') {
            const item = source as Record<string, unknown>;
            if (previewKey.test(String(item.label || item.role || ''))) continue;
            const v = parseValue(String(item.type || sourceKey), item.src || item.url || item.file, typeof item.type === 'string' ? item.type : undefined); if (v) variants.push(v);
          }
        }
      }
    }
    if (variants.length) found.push({ sourceUrl: pageUrl, title: String(data.title || data.name || doc.title || 'Видео'),
      discovery: 'structured', duration: parseDuration(data.duration), expectedDuration: parseDuration(data.duration),
      variants: [...new Map(variants.map(v => [v.url, v])).values()] });
    for (const [key, child] of Object.entries(data)) if (!previewKey.test(key) && !/^(sources|files|qualities|streams)$/i.test(key)) walk(child, depth + 1);
  };
  for (const script of doc.querySelectorAll('script')) {
    const text = script.textContent?.trim() || '';
    if (text.length > 2 * 1024 * 1024) continue;
    if (/^(?:application\/(?:ld\+)?json)$/i.test(script.type) || /^[\[{]/.test(text)) {
      try { walk(JSON.parse(text)); } catch { /* not JSON */ }
    } else {
      // Some players serialize a JSON object into a simple variable assignment.
      const assignment = /^(?:(?:var|let|const)\s+[\w$]+|window\.[\w$]+)\s*=\s*([\s\S]*?);?\s*$/.exec(text);
      if (assignment) { try { walk(JSON.parse(assignment[1].replace(/;$/, ''))); } catch { /* never evaluate script */ } }
    }
  }
  // Regex fallback: scan script text for media URLs that JSON parsing missed
  // (e.g. jwplayer('x').setup({file:"https://..."}) or plain variable assignments).
  const mediaRe = /https?:\/\/(?!(?:www\.)?(?:youtube\.com|youtu\.be|vimeo\.com))[^\s'"<>{},\[\]\\]{4,400}\.(?:mp4|webm|m3u8|mpd|flv|mov)(?:\?[^\s'"<>{},\[\]\\]*)?/gi;
  for (const script of doc.querySelectorAll('script')) {
    const text = script.textContent || '';
    if (text.length > 1 * 1024 * 1024) continue;
    let m: RegExpExecArray | null;
    mediaRe.lastIndex = 0;
    while ((m = mediaRe.exec(text)) !== null) {
      const url = m[0];
      const v = variant(url);
      if (v && !found.some(c => c.variants.some(x => x.url === url)))
        found.push({ sourceUrl: pageUrl, title: doc.title || 'Видео', variants: [v] });
    }
  }
  return found;
}
export function rankSourceCandidates(candidates: Candidate[], expectedDuration?: number): Candidate[] {
  const score = (c: Candidate) => (c.discovery === 'structured' ? 20 : 0)
    + (c.variants.some(v => v.format !== 'file') ? 5 : 0)
    + (expectedDuration !== undefined && c.duration !== undefined && Math.abs(c.duration - expectedDuration) < Math.max(5, expectedDuration * .1) ? 100 : 0)
    - (isShortPreview(c.duration, expectedDuration) ? 1000 : 0);
  return candidates.filter(c => c.variants.length && !isShortPreview(c.duration, expectedDuration)).sort((a, b) => score(b) - score(a));
}
export function discoverGeneric(doc: Document, pageUrl: string): Candidate[] {
  const found: Candidate[] = [];
  // Strip mobile subdomains (m., mob., mobile.) so panel always shows the desktop URL.
  const srcUrl = stripMobileSubdomain(pageUrl);
  for (const [index, element] of [...doc.querySelectorAll('video')].entries()) {
    const video = element as HTMLVideoElement;
    // Yandex's moving thumbnails are short previews, not the result videos.
    if (previewElement(video, pageUrl)) continue;
    const urls = [video.currentSrc, video.getAttribute('src'), ...[...video.querySelectorAll('source')].map(s => s.getAttribute('src'))];
    const variants: Variant[] = [];
    for (const raw of urls) {
      const url = httpUrl(raw, pageUrl); if (!url || isPreviewUrl(url)) continue;
      const source = [...video.querySelectorAll('source')].find(s => httpUrl(s.getAttribute('src'), pageUrl) === url);
      const v = variant(url, source?.type) ?? { url, format: 'file' as const };
      if (url === httpUrl(video.currentSrc, pageUrl) && video.videoHeight > 0) { v.height = video.videoHeight; v.width = video.videoWidth; }
      if (!variants.some(x => x.url === url)) variants.push(v);
    }
    if (!variants.length) continue;
    found.push({
      sourceUrl: srcUrl, identity: `element:${srcUrl}#${video.id || index}`,
      title: video.title || video.getAttribute('aria-label') || doc.title || 'Видео',
      thumbnail: httpUrl(video.getAttribute('poster'), pageUrl),
      duration: Number.isFinite(video.duration) ? video.duration : undefined,
      live: video.duration === Infinity ? true : Number.isFinite(video.duration) ? false : undefined,
      variants,
    });
  }
  for (const link of doc.querySelectorAll('a[href]')) {
    const url = httpUrl(link.getAttribute('href'), pageUrl); if (!url) continue;
    const v = variant(url); if (!v) continue;
    found.push({ sourceUrl: srcUrl, title: link.textContent?.trim() || doc.title || 'Видео', variants: [v] });
  }
  // Skip og:video on Yandex Video pages: those URLs are embed players from external sites, and
  // discoverYandex() extracts the real sourceUrl. Creating a candidate here would store the
  // Yandex preview URL as sourceUrl and the embed URL as a variant, which both are wrong.
  if (!isYandexVideo(pageUrl)) {
    for (const meta of doc.querySelectorAll('meta[property="og:video"],meta[property="og:video:url"],meta[property="og:video:secure_url"],meta[itemprop="contentUrl"]')) {
      const url = httpUrl(meta.getAttribute('content'), pageUrl); if (!url) continue;
      const v = variant(url, doc.querySelector('meta[property="og:video:type"]')?.getAttribute('content') || undefined);
      if (v) found.push({ sourceUrl: srcUrl, title: doc.querySelector('meta[property="og:title"]')?.getAttribute('content') || doc.title || 'Видео', variants: [v] });
    }
  }
  const walk = (obj: unknown, depth = 0) => {
    if (!obj || typeof obj !== 'object' || depth > 15) return;
    if (Array.isArray(obj)) { obj.slice(0, 500).forEach(x => walk(x, depth + 1)); return; }
    const data = obj as Record<string, unknown>;
    if (data['@type'] === 'VideoObject' || (Array.isArray(data['@type']) && data['@type'].includes('VideoObject'))) {
      const url = typeof data.contentUrl === 'string' ? httpUrl(data.contentUrl, pageUrl) : undefined;
      const v = url ? variant(url) : undefined;
      if (v) found.push({ sourceUrl: srcUrl, title: String(data.name || doc.title || 'Видео'), duration: parseDuration(data.duration), expectedDuration: parseDuration(data.duration), discovery: 'structured', variants: [v] });
    }
    Object.values(data).forEach(x => walk(x, depth + 1));
  };
  for (const script of doc.querySelectorAll('script[type="application/ld+json"]')) {
    try { walk(JSON.parse(script.textContent || '')); } catch { /* malformed structured data */ }
  }
  if (!isYandexVideo(pageUrl)) found.push(...discoverEmbedded(doc, pageUrl));
  return [...new Map(found.map(c => [c.variants.map(v => v.url).sort().join('|'), c])).values()];
}
export function isYandexVideo(url: string): boolean {
  const u = new URL(url);
  return (/(^|\.)yandex\.(ru|com|by|kz|uz|com\.tr)$/.test(u.hostname) || /(^|\.)ya\.ru$/.test(u.hostname)) && /^\/video(?:\/|$)/.test(u.pathname);
}
function stripMobileSubdomain(url: string): string {
  try {
    const p = new URL(url);
    if (/^(?:m|mob|mobile)\./i.test(p.hostname)) { p.hostname = p.hostname.replace(/^(?:m|mob|mobile)\./i, ''); return p.href; }
  } catch { /* invalid URL */ }
  return url;
}
function externalUrl(raw: string | undefined | null, page: string): string | undefined {
  const url = httpUrl(raw, page); if (!url) return;
  const parsed = new URL(url);
  // Yandex redirect URLs carry the destination in a query parameter — extract and normalize it.
  for (const key of ['url', 'video_url']) {
    const target = httpUrl(parsed.searchParams.get(key));
    if (target && !isYandexVideo(target)) return stripMobileSubdomain(target);
  }
  if (isYandexVideo(url) || /(^|\.)yandex\./.test(parsed.hostname) || /(^|\.)ya\.ru$/.test(parsed.hostname)) return;
  return stripMobileSubdomain(url);
}
export function discoverYandex(doc: Document, pageUrl: string): Candidate[] {
  if (!isYandexVideo(pageUrl)) return [];
  const found: Candidate[] = [];
  const cards = doc.querySelectorAll('[data-video], .serp-item, [data-testid="video-card"], .VideoCard, .VideoSnippet');
  for (const card of cards) {
    let data: Record<string, unknown> = {};
    for (const key of ['data-video', 'data-bem']) {
      try {
        const raw = JSON.parse(card.getAttribute(key) || '{}');
        data = { ...data, ...(raw['serp-item'] ?? raw) };
      } catch { /* graceful selector fallback */ }
    }
    const video = data.video && typeof data.video === 'object' ? data.video as Record<string, unknown> : data;
    const source = externalUrl(card.querySelector('.VideoHostExtended-Host')?.getAttribute('href'), pageUrl)
      ?? externalUrl(String(video.url || video.player_url || data.url || ''), pageUrl)
      ?? [...card.querySelectorAll('a[href]')].map(a => externalUrl(a.getAttribute('href'), pageUrl)).find(Boolean);
    if (!source) continue;
    const titleNode = card.querySelector('.serp-item__title, .VideoCard-Title, .VideoSnippet-Title, [data-testid="title"], h2, h3');
    const title = String(video.title || data.title || titleNode?.getAttribute('title') || titleNode?.textContent || card.querySelector('a[title]')?.getAttribute('title') || 'Видео').trim();
    const duration = parseDuration(video.duration ?? data.duration)
      ?? parseDuration(card.querySelector('.serp-item__duration, .VideoCard-Duration, .VideoThumb3Meta-Duration, [data-testid="duration"]')?.textContent);
    const image = card.querySelector('img');
    // Save the Yandex preview URL as a fallback variant so the resolver can open it in a
    // background tab when the external source URL is gone or blocked. Yandex always has a
    // working player URL (its own CDN or an embed service like p0sembed.com).
    const yandexPreviewHref = [...card.querySelectorAll('a[href]')]
      .map(a => httpUrl(a.getAttribute('href'), pageUrl))
      .find(u => !!u && isYandexVideo(u) && /\/video\/preview\//.test(u));
    const variants: Variant[] = yandexPreviewHref ? [{ url: yandexPreviewHref, format: 'file' }] : [];
    found.push({ sourceUrl: source, identity: `page:${source}`, title, duration, expectedDuration: duration, discovery: 'catalog',
      thumbnail: httpUrl(image?.getAttribute('src') || image?.getAttribute('data-src') || card.querySelector('video[poster]')?.getAttribute('poster'), pageUrl), variants });
  }
  return [...new Map(found.map(c => [candidateId(c), c])).values()];
}
