import { expect, it } from 'vitest';
import { dzenPageUrl, dzenStreams } from '../src/dzen';
const wrap = (video: unknown) => `noise(); var _params=(${JSON.stringify({ssrData:{videoMetaResponse:{video}}})}); ignored();`;
it('recognizes only Dzen video pages', () => {
  expect(dzenPageUrl('http://dzen.ru/video/watch/65635213b4cb715fa04a16b3?f=video')).toBe('https://dzen.ru/video/watch/65635213b4cb715fa04a16b3');
  expect(dzenPageUrl('https://dzen.ru.other.test/video/watch/65635213b4cb715fa04a16b3')).toBeUndefined();
});
it('reads only selected video JSON without evaluating script or preview data', () => {
  const text = wrap({duration:1427,title:'escaped " } text',oneVideoStreams:[{url:'https://cdn.okcdn.ru/video.m3u8',type:'hls'},{url:'https://cdn.okcdn.ru/video.mp4',type:'fullhd'}],previews:{url:'https://cdn.okcdn.ru/preview.mp4'}});
  expect(dzenStreams(text)).toEqual({duration:1427,variants:[{url:'https://cdn.okcdn.ru/video.m3u8',format:'hls'}]});
  expect(() => dzenStreams('var _params=stealCookies()')).toThrow();
  expect(() => dzenStreams(wrap({isPremium:true}))).toThrow();
});
