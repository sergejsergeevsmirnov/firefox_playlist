import { httpUrl } from './core';
import type { Variant } from './model';

export interface ManifestInfo { variants: Variant[]; duration?: number; live?: boolean; protected: boolean; dependencies: string[]; resourceUrls: string[] }
export function hlsAttributes(line: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const match of line.matchAll(/([A-Z0-9-]+)=("[^"]*"|[^,]*)/g)) result[match[1]] = match[2].replace(/^"|"$/g, '');
  return result;
}
export function parseHls(text: string, url: string): ManifestInfo {
  if (!text.trimStart().startsWith('#EXTM3U')) throw new Error('Некорректный HLS-манифест');
  const lines = text.split(/\r?\n/).map(s => s.trim());
  const variants: Variant[] = []; const dependencies: string[] = []; const resourceUrls: string[] = [];
  const protectedStream = lines.some(s => /^#EXT-X-(?:SESSION-)?KEY:/.test(s) && !/METHOD=NONE(?:,|$)/.test(s));
  const audio = lines.filter(s => s.startsWith('#EXT-X-MEDIA:')).map(hlsAttributes);
  let duration = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith('#EXTINF:')) duration += parseFloat(line.slice(8)) || 0;
    if (line.startsWith('#EXT-X-STREAM-INF:')) {
      const attributes = hlsAttributes(line); const resolution = attributes.RESOLUTION?.split('x').map(Number);
      const child = httpUrl(lines.slice(i + 1).find(s => s && !s.startsWith('#')), url); if (child) dependencies.push(child);
      variants.push({ url, format: 'hls', width: resolution?.[0], height: resolution?.[1],
        bitrate: Number(attributes.BANDWIDTH) || undefined, fps: Number(attributes['FRAME-RATE']) || undefined,
        codecs: attributes.CODECS, qualityIndex: variants.length,
        audio: attributes.AUDIO ? true : undefined,
        language: audio.find(a => a['GROUP-ID'] === attributes.AUDIO)?.LANGUAGE,
        subtitles: audio.filter(a => a.TYPE === 'SUBTITLES').map(a => a.LANGUAGE || a.NAME),
      });
    }
  }
  for (const a of audio) { const child = httpUrl(a.URI, url); if (child) dependencies.push(child); }
  if (!variants.length) variants.push({ url, format: 'hls' });
  const master = lines.some(s => s.startsWith('#EXT-X-STREAM-INF:'));
  if (!master) for (const line of lines) {
    const raw = line.startsWith('#EXT-X-MAP:') ? hlsAttributes(line).URI : line && !line.startsWith('#') ? line : undefined;
    const resource = httpUrl(raw, url); if (resource) resourceUrls.push(resource);
  }
  return { variants, protected: protectedStream, dependencies, resourceUrls,
    live: master ? undefined : !lines.includes('#EXT-X-ENDLIST'),
    duration: master || !lines.includes('#EXT-X-ENDLIST') ? undefined : duration };
}
export function parseDash(text: string, url: string): ManifestInfo {
  const doc = new DOMParser().parseFromString(text, 'application/xml');
  if (doc.querySelector('parsererror') || doc.documentElement.localName !== 'MPD') throw new Error('Некорректный DASH-манифест');
  const root = doc.documentElement; const variants: Variant[] = [];
  const audioSets = [...doc.querySelectorAll('AdaptationSet')].filter(a => /audio/.test(a.getAttribute('mimeType') || a.getAttribute('contentType') || ''));
  for (const rep of doc.querySelectorAll('Representation')) {
    const set = rep.parentElement;
    const get = (name: string) => rep.getAttribute(name) || set?.getAttribute(name) || undefined;
    if (!/video/.test(get('mimeType') || get('contentType') || '') && !get('height')) continue;
    const fps = get('frameRate')?.split('/').map(Number);
    variants.push({ url, format: 'dash', height: Number(get('height')) || undefined, width: Number(get('width')) || undefined,
      bitrate: Number(get('bandwidth')) || undefined, codecs: get('codecs'), qualityIndex: variants.length,
      fps: fps ? fps[0] / (fps[1] || 1) : undefined, audio: audioSets.length > 0,
      language: audioSets[0]?.getAttribute('lang') || undefined,
      subtitles: [...doc.querySelectorAll('AdaptationSet')].filter(a => /text|subtitle/.test(a.getAttribute('mimeType') || a.getAttribute('contentType') || '')).map(a => a.getAttribute('lang') || 'und'),
    });
  }
  const d = /^PT(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?$/.exec(root.getAttribute('mediaPresentationDuration') || '');
  const resourceUrls: string[] = [];
  for (const rep of doc.querySelectorAll('Representation')) {
    let base = url;
    const ancestors: Element[] = []; let parent: Element | null = rep;
    while (parent) { ancestors.unshift(parent); parent = parent.parentElement; }
    for (const ancestor of ancestors) {
      const local = [...ancestor.children].find(c => c.localName === 'BaseURL');
      if (local?.textContent) base = httpUrl(local.textContent.trim(), base) || base;
    }
    const template = rep.querySelector('SegmentTemplate') || rep.parentElement?.querySelector(':scope > SegmentTemplate') || doc.querySelector('Period > SegmentTemplate');
    if (template) {
      const timeline = template.querySelector('S');
      const replace = (pattern: string) => pattern.replace(/\$(RepresentationID|Bandwidth|Number|Time)(?:%0(\d+)d)?\$/g, (_match, key: string, pad: string) => {
        const value = key === 'RepresentationID' ? rep.getAttribute('id') || '' : key === 'Bandwidth' ? rep.getAttribute('bandwidth') || '' : key === 'Time' ? timeline?.getAttribute('t') || '0' : template.getAttribute('startNumber') || '1';
        return pad ? value.padStart(Number(pad), '0') : value;
      }).replace(/\$\$/g, '$');
      for (const attr of ['initialization', 'media']) {
        const raw = template.getAttribute(attr); const resource = raw ? httpUrl(replace(raw), base) : undefined; if (resource) resourceUrls.push(resource);
      }
    } else {
      const list = rep.querySelector('SegmentList') || rep.parentElement?.querySelector(':scope > SegmentList');
      if (list) for (const el of list.querySelectorAll('Initialization, SegmentURL')) {
        const resource = httpUrl(el.getAttribute('sourceURL') || el.getAttribute('media'), base); if (resource) resourceUrls.push(resource);
      }
      else if (base !== url) resourceUrls.push(base);
    }
  }
  return { variants: variants.length ? variants : [{ url, format: 'dash' }], protected: Boolean(doc.querySelector('ContentProtection')), resourceUrls,
    live: root.getAttribute('type') === 'dynamic', duration: d ? Number(d[1] || 0) * 3600 + Number(d[2] || 0) * 60 + Number(d[3] || 0) : undefined,
    dependencies: [...doc.querySelectorAll('BaseURL')].map(x => httpUrl(x.textContent?.trim(), url)).filter((x): x is string => !!x) };
}
