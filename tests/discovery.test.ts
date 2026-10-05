// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import { discoverGeneric, discoverYandex, parseDuration } from '../src/discovery';
const parse = (html: string) => new DOMParser().parseFromString(html, 'text/html');
describe('page discovery', () => {
  it('recognizes the live September 2026 Yandex structure and excludes animated thumbnails', () => {
    const doc = parse(readFileSync('tests/fixtures/yandex-live-2026-09-29.html', 'utf8'));
    const page = 'https://yandex.ru/video/search?text=природа';
    const found = discoverYandex(doc, page);
    expect(found).toHaveLength(1); expect(found[0]).toMatchObject({ sourceUrl: 'http://vk.com/video-11525744_456245702', title: 'Самые красивые места планеты Земля', duration: 8547, variants: [] });
    expect(discoverGeneric(doc, page)).toEqual([]);
  });
  it('extracts Yandex cards, redirects, duration, and deduplicates without trusting HD badges', () => {
    const doc = parse(readFileSync('tests/fixtures/yandex.html', 'utf8'));
    const result = discoverYandex(doc, 'https://yandex.ru/video/search?text=природа');
    expect(result).toHaveLength(3); expect(result[0].duration).toBe(125); expect(result[0].variants).toEqual([]);
    expect(result[1].sourceUrl).toBe('https://example.org/watch/river'); expect(result[1].duration).toBe(3723);
    expect(result[2].duration).toBe(135);
  });
  it('handles dynamically appended cards and scopes the adapter to Yandex Video', () => {
    const doc = parse('<div data-video=\'{"url":"https://a.test/v","title":"One"}\'></div>');
    expect(discoverYandex(doc, 'https://example.org/')).toEqual([]);
    doc.body.insertAdjacentHTML('beforeend', '<div data-video=\'{"url":"https://b.test/v","title":"Two"}\'></div>');
    expect(discoverYandex(doc, 'https://yandex.ru/video/search')).toHaveLength(2);
  });
  it('collects video variants, relative links and JSON-LD but ignores blob URLs and segments', () => {
    const doc = parse(`<title>Sample</title><video id="one" src="/720.mp4"><source src="/1080.mp4"></video><video src="blob:123"></video><a href="/live.m3u8">Live</a><a href="/seg.ts">segment</a><script type="application/ld+json">{"@type":"VideoObject","name":"Meta","contentUrl":"https://cdn.test/meta.webm","duration":"PT2M3S"}</script>`);
    const result = discoverGeneric(doc, 'https://example.org/watch'); expect(result).toHaveLength(3);
    expect(result[0].variants).toHaveLength(2); expect(result[2].duration).toBe(123);
  });
  it('parses supported duration formats without inventing metadata', () => {
    expect(parseDuration('PT1H2M3.5S')).toBe(3723.5); expect(parseDuration('LIVE')).toBeUndefined();
  });
});
