// @vitest-environment jsdom
import {expect,it} from 'vitest';
import {okPageUrl,okStreams} from '../src/ok';
it('only reads selected OK video and supports string metadata', () => {
  const wrap = (id: string) => `<div data-options='${JSON.stringify({flashvars:{metadata:JSON.stringify({movie:{id,duration:'75'},hlsManifestUrl:`https://cdn.okcdn.ru/${id}.m3u8`})}})}'></div>`;
  expect(okStreams(wrap('123')+wrap('8809471543997'),'https://ok.ru/video/8809471543997')).toEqual({duration:75,variants:[{url:'https://cdn.okcdn.ru/8809471543997.m3u8',format:'hls'}]});
  expect(okPageUrl('http://ok.ru/video/8809471543997')).toBe('https://ok.ru/video/8809471543997');
  expect(okPageUrl('https://ok.ru.evil.test/video/1')).toBeUndefined();
});
