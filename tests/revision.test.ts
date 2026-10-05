// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { discoverGeneric, discoverYandex, discoverEmbedded, isYandexVideo, rankSourceCandidates } from '../src/discovery';
import { decodeFilter, encodeFilter, quickFilters } from '../src/quick-filters';
import { isShortPreview } from '../src/media-policy';
import { enqueue, matches, restoreState } from '../src/core';
import { emptyState, type Video } from '../src/model';
const parse = (s: string) => new DOMParser().parseFromString(s, 'text/html');
const video = (): Video => ({ id: 'v', sourceUrl: 'https://example.org/watch', title: 'Видео', status: 'ready', duration: 300, variants: [{url:'https://example.org/full.mp4',format:'file',height:1080,portable:true}], requiredOrigins:[],position:0,watched:false,addedAt:1 });
it('uses the catalog adapter on the reported ya.ru page and excludes previews', () => {
  const url = 'https://ya.ru/video/search?text=сварка+лазером&from=tabbar';
  const doc = parse(readFileSync('tests/fixtures/yandex-live-2026-09-29.html', 'utf8'));
  expect(isYandexVideo(url)).toBe(true);
  expect(discoverYandex(doc,url)[0]).toMatchObject({discovery:'catalog',variants:[]});
  expect(discoverGeneric(doc,url)).toEqual([]);
});
it('groups full streams from player JSON and ignores nested previews', () => {
  const doc = parse('<script type="application/json">{"title":"Полное видео","duration":120,"sources":{"720":"https://cdn.test/full720.mp4","1080":"https://cdn.test/full1080.mp4"},"preview":{"url":"https://cdn.test/short.mp4","duration":10}}</script>');
  const found = discoverEmbedded(doc,'https://example.org/watch');
  expect(found).toHaveLength(1); expect(found[0].variants).toHaveLength(2);
  expect(rankSourceCandidates([{...found[0],duration:10},found[0]],120)).toEqual(found);
  expect(isShortPreview(10,10)).toBe(false);
});
it('uses strict duration presets and round-trips saved filters', () => {
  const filters = quickFilters({minHeight:720,maxDuration:300,host:'example.org',include:'Видео'});
  expect(matches(video(),filters)).toBe('reject');
  expect(matches({...video(),duration:299},filters)).toBe('match');
  expect(matches({...video(),duration:undefined},filters)).toBe('pending');
  expect(decodeFilter(encodeFilter(filters))).toEqual(filters);
  expect(() => decodeFilter('{"version":1,"quality":999}')).toThrow();
});
it('remembers cleared entries and removes old preview-only records on restore', () => {
  const state = emptyState(); state.dismissed = ['v']; enqueue(state,video()); expect(state.queue).toEqual([]);
  state.videos.v = {...video(),variants:[{url:'https://video-preview.s3.yandex.net/test.mp4',format:'file'}]}; state.queue=['v'];
  expect(restoreState(state).queue).toEqual([]);
  expect(restoreState(state).dismissed).toEqual(['v']);
});
