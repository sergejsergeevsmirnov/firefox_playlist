// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { parseDash, parseHls } from '../src/manifests';
describe('adaptive manifests', () => {
  it('parses HLS quality and separate audio without replacing the master URL', () => {
    const url = 'https://cdn.test/master.m3u8';
    const result = parseHls('#EXTM3U\n#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a",LANGUAGE="ru",URI="audio.m3u8"\n#EXT-X-STREAM-INF:BANDWIDTH=2400000,RESOLUTION=1280x720,CODECS="avc1.4d401f,mp4a.40.2",FRAME-RATE=30,AUDIO="a"\n720.m3u8', url);
    expect(result.variants[0]).toMatchObject({ url, height: 720, bitrate: 2400000, codecs: 'avc1.4d401f,mp4a.40.2', language: 'ru', fps: 30 });
    expect(result.dependencies).toEqual(['https://cdn.test/720.m3u8', 'https://cdn.test/audio.m3u8']); expect(result.duration).toBeUndefined();
  });
  it('distinguishes live streams, recordings and encrypted HLS', () => {
    expect(parseHls('#EXTM3U\n#EXTINF:4.5,\none.ts\n#EXTINF:5,\ntwo.ts\n#EXT-X-ENDLIST', 'https://x.test/a.m3u8')).toMatchObject({ duration: 9.5, live: false, protected: false });
    expect(parseHls('#EXTM3U\n#EXTINF:5,\none.ts', 'https://x.test/a.m3u8').live).toBe(true);
    expect(parseHls('#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="key"', 'https://x.test/a.m3u8').protected).toBe(true);
  });
  it('parses DASH metadata and detects protection', () => {
    const result = parseDash('<MPD mediaPresentationDuration="PT1M5S"><Period><AdaptationSet mimeType="video/mp4" codecs="avc1"><Representation id="1" height="720" width="1280" bandwidth="1000000" frameRate="30000/1001"/></AdaptationSet><AdaptationSet mimeType="audio/mp4" lang="ru"/></Period></MPD>', 'https://x.test/a.mpd');
    expect(result.duration).toBe(65); expect(result.variants[0].height).toBe(720); expect(result.variants[0].fps).toBeCloseTo(29.97, 2); expect(result.variants[0].audio).toBe(true);
    expect(parseDash('<MPD><Period><ContentProtection/></Period></MPD>', 'https://x.test/a.mpd').protected).toBe(true);
  });
  it('rejects HTML masquerading as an adaptive manifest', () => {
    expect(() => parseHls('<html>login</html>', 'https://x.test/a')).toThrow(); expect(() => parseDash('<html/>', 'https://x.test/a')).toThrow();
  });
});
