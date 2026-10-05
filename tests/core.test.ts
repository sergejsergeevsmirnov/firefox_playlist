import { describe, it, expect } from 'vitest';
import { candidateId, enqueue, exportPlaylist, matches, mergeCandidate, restoreState, bestVariant, mediaFormat, originPattern } from '../src/core';
import { defaultFilters, emptyState, variantKey, type Video } from '../src/model';

export function sample(): Video {
  return { id: 'one', sourceUrl: 'https://example.org/watch/1', title: 'Лес и озеро', duration: 120,
    status: 'ready', requiredOrigins: [], position: 0, watched: false, addedAt: 1, live: false,
    variants: [360, 720, 1080].map(height => ({ url: `https://cdn.example.org/${height}.mp4`, format: 'file', height, portable: true })) };
}
describe('filter semantics', () => {
  it('selects the best confirmed resolution within inclusive bounds', () => {
    const f = { ...defaultFilters, minHeight: 480, maxHeight: 720, minDuration: 120, maxDuration: 120 };
    expect(matches(sample(), f)).toBe('match'); expect(bestVariant(sample(), f)?.height).toBe(720);
  });
  it('keeps missing duration or resolution pending when a corresponding filter is active', () => {
    expect(matches({ ...sample(), duration: undefined }, { ...defaultFilters, minDuration: 1 })).toBe('pending');
    expect(matches({ ...sample(), variants: [{ url: 'https://x.test/v.mp4', format: 'file' }] }, { ...defaultFilters, minHeight: 720 })).toBe('pending');
    expect(matches({ ...sample(), duration: undefined }, defaultFilters)).toBe('match');
  });
  it('does not reject an unresolved alternative when another quality is too low', () => {
    const v = sample(); v.variants = [v.variants[0], { url: 'https://x.test/unknown.mp4', format: 'file' }];
    expect(matches(v, { ...defaultFilters, minHeight: 720 })).toBe('pending');
  });
  it('supports host boundaries, words, live type, format, and watched state', () => {
    expect(matches(sample(), { ...defaultFilters, host: 'example.org', include: 'лес озеро', live: 'recording', format: 'file', watched: 'no' })).toBe('match');
    expect(matches(sample(), { ...defaultFilters, host: 'ample.org' })).toBe('reject');
    expect(matches(sample(), { ...defaultFilters, exclude: 'лес' })).toBe('reject');
    expect(matches(sample(), { ...defaultFilters, live: 'live' })).toBe('reject');
    expect(matches({ ...sample(), live: undefined }, { ...defaultFilters, live: 'recording' })).toBe('pending');
  });
});
describe('identity and queue persistence', () => {
  it('deduplicates quality updates and preserves position and metadata', () => {
    const v = sample(); v.position = 42;
    const merged = mergeCandidate(v, { sourceUrl: v.sourceUrl, title: v.title, variants: [{ ...v.variants[1], height: undefined, portable: undefined }] });
    expect(merged.variants).toHaveLength(3); expect(merged.position).toBe(42);
    expect(merged.variants.find(x => x.url.endsWith('720.mp4'))?.height).toBe(720);
  });
  it('keeps distinct signed URLs distinct, preserving query parameters', () => {
    const c = { sourceUrl: 'https://x.test', title: '', variants: [{ url: 'https://x.test/v.mp4?token=a', format: 'file' as const }] };
    expect(candidateId(c)).not.toBe(candidateId({ ...c, variants: [{ ...c.variants[0], url: 'https://x.test/v.mp4?token=b' }] }));
  });
  it('only enqueues once and honors removal suppression', () => {
    const s = emptyState(); const v = sample(); enqueue(s, v, [v.id]); expect(s.queue).toEqual([]);
    enqueue(s, v); enqueue(s, v); expect(s.queue).toEqual([v.id]); expect(v.selectedVariant).toBe(variantKey(v.variants[2]));
  });
  it('restores order and playback options and discards invalid entries', () => {
    const s = emptyState(); const v = sample(); v.position = 37; s.videos[v.id] = v; s.queue = [v.id, 'missing', v.id]; s.shuffle = true;
    const restored = restoreState(JSON.parse(JSON.stringify(s))); expect(restored.queue).toEqual([v.id]); expect(restored.videos.one.position).toBe(37); expect(restored.shuffle).toBe(true);
    expect(restoreState({ version: 99 })).toEqual(emptyState());
  });
});
describe('export and media identification', () => {
  it('requests valid Firefox host permissions for non-default ports', () => {
    expect(originPattern('http://127.0.0.1:8765/page')).toBe('http://127.0.0.1/*');
  });
  it('exports Unicode titles, cleans line breaks, excludes unverified sources', () => {
    const s = emptyState(); const v = sample(); v.title = 'Лес\n#INJECT'; s.videos.one = v; enqueue(s, v);
    s.videos.two = { ...v, id: 'two', variants: [{ url: 'blob:abc', format: 'file', portable: true }], selectedVariant: undefined }; s.queue.push('two');
    const result = exportPlaylist(s); expect(result.included).toBe(1); expect(result.excluded).toBe(1);
    expect(result.text).toContain('#EXTINF:120,Лес #INJECT\nhttps://cdn.example.org/1080.mp4\n');
    v.variants.forEach(x => { x.portable = false; }); expect(exportPlaylist(s).included).toBe(0);
  });
  it('keeps master manifests for adaptive audio and does not treat segments as videos', () => {
    expect(mediaFormat('https://x.test/seg.ts', 'video/mp2t')).toBeUndefined();
    expect(mediaFormat('https://x.test/1.m4s', 'video/mp4')).toBeUndefined();
    expect(mediaFormat('https://x.test/media?id=1', 'application/vnd.apple.mpegurl')).toBe('hls');
    expect(mediaFormat('https://x.test/a.mpd')).toBe('dash');
  });
});
