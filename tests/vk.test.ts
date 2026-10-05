// @vitest-environment jsdom
import {readFileSync} from 'node:fs';
import {it,expect} from 'vitest';
import {parseDash} from '../src/manifests';
import {captureOrigins,sourceIdentity,vkResourceCandidates} from '../src/capture-policy';
import {vkStreams} from '../src/vk';
it('inspects extensionless VK resources without accepting byte fragments or foreign hosts', () => {
  const master='https://vkvd423.okcdn.ru/?id=8436518423168&expires=1';
  expect(vkResourceCandidates('https://vkvideo.ru/video-98979942_456280438',[master,master,master+'&bytes=1-100','https://evil.test/?id=1'])).toEqual([master]);
  expect(vkResourceCandidates('https://example.org',[master])).toEqual([]);
  expect(vkResourceCandidates('https://vkvideo.ru/video-98979942_456280438',['https://vkvd423.okcdn.ru/?expires=1&h=1336333768'])).toHaveLength(1);
});
import {mediaFormat} from '../src/core';
it('probes opaque CDN paths without assuming undocumented manifest query keys', () => {
  const page='https://vkvideo.ru/video-98979942_456280438';
  const urls=['https://vkvd423.okcdn.ru/?expires=1&sig=test', 'https://vkvd423.okcdn.ru/opaque/path?token=test'];
  expect(vkResourceCandidates(page,urls)).toEqual(urls);
  expect(vkResourceCandidates(page,[urls[1]+'&range=0-100'])).toEqual([]);
  expect(vkResourceCandidates(page,['https://okcdn.ru.evil.test/opaque'])).toEqual([]);
  // A probe candidate is not a confirmed playable stream.
  expect(mediaFormat(urls[0],'video/mp4')).toBe('file');
  expect(mediaFormat(urls[0],'image/jpeg')).toBeUndefined();
});
it('recognizes an extensionless DASH response and retains its master URL', () => {
  const url='https://vkvd423.okcdn.ru/?id=8436518423168&format=dash';
  expect(mediaFormat(url,'application/dash+xml')).toBe('dash');
  const info=parseDash(readFileSync('tests/fixtures/vk-segmentbase.mpd','utf8'),url);
  expect(info.duration).toBe(65.254); expect(info.protected).toBe(false);
  expect(info.variants.map(v=>v.height)).toEqual([144,240,360,480,720]);
  expect(info.variants[4]).toMatchObject({url,format:'dash',fps:60,audio:true,width:720});
  expect(info.resourceUrls).toHaveLength(10);
  expect(info.resourceUrls.every(v=>new URL(v).hostname==='vkvd423.okcdn.ru')).toBe(true);
  expect(info.resourceUrls.some(v=>new URL(v).searchParams.get('ct')==='11')).toBe(true);
  expect(info.resourceUrls.some(v=>new URL(v).searchParams.get('ct')==='12')).toBe(true);
});
it('requests VK CDN access and identifies clips and videos across source hosts', () => {
  const key=sourceIdentity('https://vkvideo.ru/video-98979942_456280438');
  expect(key).toBe('vk:-98979942_456280438');
  expect(sourceIdentity('http://vk.com/video-98979942_456280438')).toBe(key);
  expect(captureOrigins('https://vkvideo.ru/clip-202202486_456256589')).toContain('https://*.okcdn.ru/*');
  expect(sourceIdentity('https://vkvideo.ru.evil.test/video-98979942_456280438')).toBeUndefined();
});
it('extracts the HLS source embedded in the al_video.php payload with metadata', () => {
  const payload = JSON.stringify({ payload: [0, [
    'Ролик',
    '<video><source src="https://vkvd.okcdn.ru/master.m3u8?cmd=videoPlayerCdn&amp;expires=1&amp;sig=x"></video>',
    '<script>//js</script>',
    '<div class="mv_info"></div>',
    { mvData: { duration: 123, title: 'Ролик', link: 'https://vk.com/video-1_1' } },
  ]]});
  const result = vkStreams(payload);
  expect(result.duration).toBe(123); expect(result.title).toBe('Ролик');
  expect(result.variants).toEqual([{ url: 'https://vkvd.okcdn.ru/master.m3u8?cmd=videoPlayerCdn&expires=1&sig=x', format: 'hls' }]);
});
it('decodes HTML entities and falls back to direct mp4 links', () => {
  const payload = JSON.stringify({ payload: [0, [
    'T',
    '<video><source src="https://vkvd.okcdn.ru/720.mp4?x=1&amp;y=2"></video>',
    {},
  ]]});
  const result = vkStreams(payload);
  expect(result.variants).toEqual([{ url: 'https://vkvd.okcdn.ru/720.mp4?x=1&y=2', format: 'file' }]);
});
it('rejects restricted VK responses with a clear reason', () => {
  expect(() => vkStreams(JSON.stringify({ payload: ['8', ['error']] }))).toThrow(/отклонил/);
});
