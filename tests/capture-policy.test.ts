import {expect,it} from 'vitest';
import {captureOrigins,vimeoIdentity,isVimeoChildManifest,vimeoFetchUrl,vimeoResourceManifests} from '../src/capture-policy';
it('preserves the embed endpoint and all playback parameters', () => {
  expect(vimeoFetchUrl('http://player.vimeo.com/video/430697407?h=abc&amp;autopause=0')).toBe('https://player.vimeo.com/video/430697407?h=abc&autopause=0');
  expect(vimeoFetchUrl('https://player.vimeo.com/video/430697407?badge=0&autopause=0&player_id=0&app_id=58479')).toBe('https://player.vimeo.com/video/430697407?badge=0&autopause=0&player_id=0&app_id=58479');
});
it('recovers previously loaded masters from resource timing without segments or audio renditions', () => {
  const master = 'https://skyfire.vimeocdn.com/a/playlist.m3u8?signature=test';
  const resources = [master,master,'https://skyfire.vimeocdn.com/a/media.m3u8?st=audio','https://skyfire.vimeocdn.com/a/segment.mp4','https://other.test/master.m3u8'];
  expect(vimeoResourceManifests('https://player.vimeo.com/video/430697407',resources)).toEqual([master]);
  expect(vimeoResourceManifests('https://example.org',resources)).toEqual([]);
});
it('unifies catalog, HTTPS and embedded Vimeo identities without mixing videos', () => {
  expect(vimeoIdentity('http://vimeo.com/430697407')).toBe(vimeoIdentity('https://player.vimeo.com/video/430697407?h=abc'));
  expect(vimeoIdentity('https://vimeo.com/1088206071')).not.toBe(vimeoIdentity('http://vimeo.com/430697407'));
  expect(vimeoIdentity('https://vimeo.com.evil.test/430697407')).toBeUndefined();
});
it('requests both player and CDN permissions before network capture', () => {
  expect(captureOrigins('https://vimeo.com/430697407')).toEqual(['https://*.vimeo.com/*','https://*.vimeocdn.com/*']);
  expect(captureOrigins('https://example.org')).toEqual([]);
});
it('keeps the master with audio instead of queuing separate Vimeo renditions', () => {
  expect(isVimeoChildManifest('https://skyfire.vimeocdn.com/a/media.m3u8?st=audio')).toBe(true);
  expect(isVimeoChildManifest('https://skyfire.vimeocdn.com/a/playlist.m3u8')).toBe(false);
  expect(isVimeoChildManifest('https://example.org/media.m3u8')).toBe(false);
});
