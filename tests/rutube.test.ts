import { expect, it } from 'vitest';
import { rutubeOptionsUrl, rutubeStreams } from '../src/rutube';
it('recognizes source and embed URLs without accepting lookalike hosts', () => {
  const id = '9152193bdfcc0ebe043af2eedabe41d7';
  expect(rutubeOptionsUrl(`http://rutube.ru/video/${id}/`)).toBe(`https://rutube.ru/api/play/options/${id}/?format=json`);
  expect(rutubeOptionsUrl(`https://rutube.ru/play/embed/${id}`)).toBeDefined();
  expect(rutubeOptionsUrl(`https://rutube.ru.evil.test/video/${id}/`)).toBeUndefined();
});
it('deduplicates public streams and converts milliseconds', () => {
  expect(rutubeStreams(JSON.stringify({duration:71267,video_balancer:{default:'https://bl.rutube.ru/v.m3u8',m3u8:'https://bl.rutube.ru/v.m3u8'}}))).toEqual({duration:71.267,variants:[{url:'https://bl.rutube.ru/v.m3u8',format:'hls'}]});
});
it('does not bypass denied access or protected playback', () => {
  expect(() => rutubeStreams('{"acl_access":{"allowed":false}}')).toThrow();
  expect(() => rutubeStreams('{"drm_token":"protected"}')).toThrow();
  expect(() => rutubeStreams('{"video_balancer":{}}')).toThrow();
});
