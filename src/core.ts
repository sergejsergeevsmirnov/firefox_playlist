import { emptyState, defaultFilters, variantKey, type Candidate, type State, type Video, type Variant, type Filters } from './model';
import { isPreviewUrl, isShortPreview } from './media-policy';
import { isYandexVideo } from './discovery';

export function httpUrl(value: string | null | undefined, base?: string): string | undefined {
  if (!value) return;
  try { const url = new URL(value, base); if (['http:', 'https:'].includes(url.protocol) && !url.username && !url.password) return url.href; } catch { /* malformed page data */ }
}
export function originPattern(url: string): string {
  // WebExtension host match patterns cover every port and must not include :port.
  const parsed = new URL(url); return `${parsed.protocol}//${parsed.hostname}/*`;
}
export function mediaFormat(url: string, mime = ''): Variant['format'] | undefined {
  const path = new URL(url).pathname.toLowerCase();
  if (/\.(?:ts|m4s|cmfv|cmfa|aac|vtt|srt)$/.test(path)) return;
  if (/\.m3u8$/.test(path) || /mpegurl/i.test(mime)) return 'hls';
  if (/\.mpd$/.test(path) || /dash\+xml/i.test(mime)) return 'dash';
  if (/\.(?:mp4|webm|ogv|ogg|mov|m4v)$/.test(path) || /^video\/(?!mp2t)/i.test(mime)) return 'file';
}
export function candidateId(c: Candidate): string {
  return c.identity || (c.variants.length === 1 ? `media:${c.variants[0].url}` : `page:${c.sourceUrl}`);
}
export function mergeCandidate(old: Video | undefined, c: Candidate): Video {
  const variants = new Map((old?.variants ?? []).map(v => [variantKey(v), v]));
  for (const v of c.variants) {
    // A DOM observation enriches a known stream without dropping verified metadata.
    const prior = [...variants.values()].find(p => p.url === v.url && p.qualityIndex === v.qualityIndex);
    if (prior) variants.delete(variantKey(prior));
    const defined = Object.fromEntries(Object.entries(v).filter(([, value]) => value !== undefined));
    const next = { ...prior, ...defined } as Variant;
    variants.set(variantKey(next), next);
  }
  return {
    ...old, ...c, id: old?.id ?? candidateId(c),
    title: old?.title && c.title === 'Видео со страницы' ? old.title : c.title,
    duration: c.duration ?? old?.duration, live: c.live ?? old?.live,
    expectedDuration: c.expectedDuration ?? old?.expectedDuration,
    discovery: c.discovery ?? old?.discovery,
    thumbnail: c.thumbnail ?? old?.thumbnail,
    variants: [...variants.values()], status: old?.status ?? 'checking',
    requiredOrigins: old?.requiredOrigins ?? [], position: old?.position ?? 0,
    watched: old?.watched ?? false, addedAt: old?.addedAt ?? Date.now(),
  };
}
export type Match = 'match' | 'pending' | 'reject';
function range(value: number | undefined, min?: number, max?: number): Match {
  if (min === undefined && max === undefined) return 'match';
  if (value === undefined || !Number.isFinite(value)) return 'pending';
  return (min !== undefined && value < min) || (max !== undefined && value > max) ? 'reject' : 'match';
}
export function qualityMatch(v: Variant, f: Filters): Match {
  if (f.format && v.format !== f.format) return 'reject';
  return range(v.height, f.minHeight, f.maxHeight);
}
export function bestVariant(v: Video, f: Filters): Variant | undefined {
  return v.variants.filter(x => qualityMatch(x, f) === 'match')
    .sort((a, b) => (b.height ?? 0) - (a.height ?? 0) || (b.bitrate ?? 0) - (a.bitrate ?? 0))[0];
}
export function matches(v: Video, f: Filters): Match {
  if (isShortPreview(v.duration, v.expectedDuration) || (v.variants.length > 0 && v.variants.every(x => isPreviewUrl(x.url)))) return 'reject';
  const host = new URL(v.sourceUrl).hostname.toLowerCase();
  const hosts = f.host.toLowerCase().split(/[\s,]+/).filter(Boolean);
  if (hosts.length && !hosts.some(h => host === h || host.endsWith(`.${h}`))) return 'reject';
  const title = v.title.toLocaleLowerCase();
  if (f.include.toLocaleLowerCase().split(/\s+/).filter(Boolean).some(w => !title.includes(w))) return 'reject';
  if (f.exclude.toLocaleLowerCase().split(/\s+/).filter(Boolean).some(w => title.includes(w))) return 'reject';
  if (f.watched && v.watched !== (f.watched === 'yes')) return 'reject';
  const duration = range(v.duration, f.minDuration, f.maxDuration);
  if (f.durationExclusive && f.maxDuration !== undefined && v.duration !== undefined && v.duration >= f.maxDuration) return 'reject';
  if (duration === 'reject') return 'reject';
  if (f.live && v.live !== undefined && v.live !== (f.live === 'live')) return 'reject';
  const qualities = v.variants.map(x => qualityMatch(x, f));
  if (qualities.length && qualities.every(x => x === 'reject')) return 'reject';
  if (v.status !== 'ready' || duration === 'pending' || (f.live && v.live === undefined) || !qualities.includes('match')) return 'pending';
  return 'match';
}
export function dedupeQueue(queue: string[], videos: Record<string, Video>): string[] {
  const byTitle = new Map<string, string[]>();
  for (const id of queue) {
    const v = videos[id]; if (!v) continue;
    const key = v.title.trim().toLowerCase();
    const group = byTitle.get(key) ?? []; group.push(id); byTitle.set(key, group);
  }
  const score = (id: string) => {
    const v = videos[id]; if (!v) return -1;
    return (v.status === 'ready' ? 100000 : 0) + (v.variants.length ? Math.max(...v.variants.map(x => x.height ?? 0)) : 0);
  };
  const keep = new Set<string>();
  for (const ids of byTitle.values()) {
    keep.add(ids.length === 1 ? ids[0] : ids.reduce((a, b) => score(a) >= score(b) ? a : b));
  }
  return queue.filter(id => keep.has(id));
}
export function enqueue(state: State, video: Video, suppressed: string[] = []): void {
  if (state.queue.includes(video.id) || suppressed.includes(video.id) || state.dismissed?.includes(video.id) || matches(video, state.filters) !== 'match') return;
  video.selectedVariant = variantKey(bestVariant(video, state.filters)!);
  state.queue.push(video.id);
}
export function restoreState(raw: unknown): State {
  const state = emptyState();
  if (!raw || typeof raw !== 'object' || (raw as State).version !== 1) return state;
  const saved = raw as State;
  for (const [id, value] of Object.entries(saved.videos ?? {})) {
    if (!value || !httpUrl(value.sourceUrl) || !Array.isArray(value.variants)) continue;
    const variants = value.variants.filter(v => httpUrl(v.url) && ['file', 'hls', 'dash', 'youtube', 'native'].includes(v.format) && (!isPreviewUrl(v.url) || isYandexVideo(v.url)));
    if (value.variants.length && !variants.length) continue;
    if (isShortPreview(value.duration, value.expectedDuration)) continue;
    state.videos[id] = {
      ...value, id, title: String(value.title || 'Видео'),
      variants,
      requiredOrigins: Array.isArray(value.requiredOrigins) ? value.requiredOrigins : [],
      position: Number.isFinite(value.position) ? Math.max(0, value.position) : 0,
    };
  }
  state.queue = [...new Set((saved.queue ?? []).filter(id => Boolean(state.videos[id])))];
  state.filters = { ...defaultFilters, ...saved.filters };
  state.repeat = saved.repeat === true;
  state.shuffle = saved.shuffle === true;
  state.autoplay = saved.autoplay !== false;
  state.dedupe = saved.dedupe === true;
  state.dismissed = Array.isArray(saved.dismissed) ? saved.dismissed.filter(id => typeof id === 'string') : [];
  return state;
}
export function exportPlaylist(state: State): { text: string; included: number; excluded: number } {
  const lines = ['#EXTM3U']; let included = 0;
  for (const id of state.queue) {
    const video = state.videos[id];
    const chosen = video.variants.find(v => variantKey(v) === video.selectedVariant) ?? bestVariant(video, state.filters);
    if (!chosen?.portable || !httpUrl(chosen.url) || /[\r\n]/.test(chosen.url)) continue;
    lines.push(`#EXTINF:${video.duration === undefined ? -1 : Math.round(video.duration)},${video.title.replace(/[\r\n]/g, ' ')}`, chosen.url);
    included++;
  }
  return { text: `${lines.join('\n')}\n`, included, excluded: state.queue.length - included };
}
export function formatTime(seconds?: number): string {
  if (seconds === undefined || !Number.isFinite(seconds)) return '—';
  const s = Math.max(0, Math.floor(seconds));
  return s >= 3600 ? `${Math.floor(s / 3600)}:${String(Math.floor(s / 60) % 60).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}` : `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}
