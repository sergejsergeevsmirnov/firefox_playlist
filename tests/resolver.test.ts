// @vitest-environment jsdom
import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
import { resolveVideo } from '../src/resolver';
import type { Video } from '../src/model';
vi.mock('youtubei.js', () => ({ Player: { create: vi.fn(async () => ({ data: { output: 'var exportedVars={nsigFunction:()=>null};' } })) } }));
const video = (): Video => ({ id: 'one', sourceUrl: 'https://example.org/watch', title: 'Clip', status: 'checking', variants: [], requiredOrigins: [], position: 0, watched: false, addedAt: 0 });
function response(text: string, url: string, status = 200) {
  const r = new Response(text, { status }); Object.defineProperty(r, 'url', { value: url }); return r;
}
beforeEach(() => { vi.stubGlobal('browser', { permissions: { contains: vi.fn(async () => true) }, runtime: { getURL: (path: string) => `moz-extension://test/${path}` } }); });
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });
describe('source resolution', () => {
  it('does not open another VK tab after capture failed in the collection session', async () => {
    const v=video(); v.sourceUrl='https://vkvideo.ru/video-202202486_456252294';
    const create=vi.fn(); Object.assign(browser,{tabs:{create}});
    const request=vi.fn(async (url:string) => response(url.includes('al_video.php') ? '{"payload":["0",{}]}' : '', url));
    vi.stubGlobal('fetch',request);
    expect(await resolveVideo(v,false,undefined,'VK не предоставил манифест')).toMatchObject({status:'site',reason:expect.stringContaining('приостановлена')});
    expect(create).not.toHaveBeenCalled();
    // The direct AJAX request is still allowed; only the muted tab is skipped.
    expect(request).toHaveBeenCalledWith('https://vk.com/al_video.php', expect.objectContaining({method:'POST'}));
  });
  it('resolves VK through the direct player API before opening any tab', async () => {
    const v = video(); v.sourceUrl = 'https://vkvideo.ru/video-202202486_456252294';
    const create = vi.fn(); Object.assign(browser, { tabs: { create } });
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      if (typeof init?.body === 'string' && init.body.includes('al=1')) {
        return response(JSON.stringify({ payload: ['0', '<html></html>', { player: { params: [{ hls: 'https://cdn.okcdn.ru/master.m3u8', duration: 100, md_title: 'Ролик' }] } }] }), 'https://vk.com/al_video.php');
      }
      if (url.endsWith('master.m3u8')) return response('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1000,RESOLUTION=640x360\n360.m3u8', url);
      return response('#EXTM3U\n#EXTINF:100,\nseg.ts\n#EXT-X-ENDLIST', url);
    }));
    expect(await resolveVideo(v)).toMatchObject({ status: 'ready', duration: 100 });
    expect(create).not.toHaveBeenCalled();
  });
  it('resolves a YouTube progressive stream from the page player response', async () => {
    const v = video(); v.sourceUrl = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ'; v.expectedDuration = 212;
    const tabs = { create: vi.fn(async () => ({ id: 9 })), update: vi.fn(async () => {}),
      get: vi.fn(async () => ({ url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' })), remove: vi.fn(async () => {}) };
    Object.assign(browser, { tabs, scripting: { executeScript: vi.fn(async () => [{ result: { ok: true, url: 'https://googlevideo.com/videoplayback?itag=18&sig=x', title: 'Clip', duration: 212 } }]) } });
    expect(await resolveVideo(v)).toMatchObject({ status: 'ready', duration: 212,
      variants: [{ url: 'https://googlevideo.com/videoplayback?itag=18&sig=x', format: 'file', portable: true }] });
    expect(tabs.remove).toHaveBeenCalledWith(9);
  });
  it('falls back to the YouTube embed when no stream can be deciphered', async () => {
    const v = video(); v.sourceUrl = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ'; v.expectedDuration = 212;
    const tabs = { create: vi.fn(async () => ({ id: 9 })), update: vi.fn(async () => {}),
      get: vi.fn(async () => ({ url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' })), remove: vi.fn(async () => {}) };
    Object.assign(browser, { tabs, scripting: { executeScript: vi.fn(async () => [{ result: { ok: false, error: 'no stream' } }]) } });
    expect(await resolveVideo(v)).toMatchObject({ status: 'ready', duration: 212,
      variants: [{ url: 'https://www.youtube.com/embed/dQw4w9WgXcQ', format: 'youtube' }] });
    expect(tabs.remove).toHaveBeenCalledWith(9);
  });
  it('fetches the exact Vimeo embed URL instead of replacing it with a watch page', async () => {
    const v = video(); v.sourceUrl='https://player.vimeo.com/video/430697407?h=abc&app_id=58479';
    const request = vi.fn(async (url:string) => response('<html></html>',url)); vi.stubGlobal('fetch',request);
    await resolveVideo(v);
    expect(request.mock.calls[0][0]).toBe(v.sourceUrl);
  });
  it('automatically falls back to one muted Dzen tab and closes it', async () => {
    const v = video(); v.sourceUrl='https://dzen.ru/video/watch/65635213b4cb715fa04a16b3';
    const create = vi.fn(async () => ({id:9})); const remove = vi.fn(async () => {});
    Object.assign(browser,{tabs:{create,remove,update:vi.fn(async()=>{}),get:vi.fn(async()=>({url:v.sourceUrl,status:'complete'}))},scripting:{executeScript:vi.fn(async()=>[{result:'var _params=({"ssrData":{"videoMetaResponse":{"video":{"duration":1427,"oneVideoStreams":[{"url":"https://cdn.okcdn.ru/full.m3u8"}]}}}});'}])}});
    vi.stubGlobal('fetch',vi.fn().mockRejectedValue(new TypeError('NetworkError')));
    expect(await resolveVideo(v)).toMatchObject({status:'site'});
    expect(create).toHaveBeenCalledWith({url:v.sourceUrl,active:false});
    expect(remove).toHaveBeenCalledWith(9);
  });
  it('resolves Rutube through public player options rather than page HTML', async () => {
    const v = video(); v.sourceUrl = 'http://rutube.ru/video/9152193bdfcc0ebe043af2eedabe41d7/'; v.expectedDuration = 71;
    const request = vi.fn(async (url: string) => response(url.includes('/api/play/options/') ? JSON.stringify({duration:71267,video_balancer:{m3u8:'https://bl.rutube.ru/master.m3u8'}}) : url.endsWith('master.m3u8') ? '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1000,RESOLUTION=608x1080\nhttps://cdn.rtbcdn.ru/full.m3u8' : '#EXTM3U\n#EXTINF:71.267,\nseg.ts\n#EXT-X-ENDLIST', url));
    vi.stubGlobal('fetch', request);
    expect(await resolveVideo(v)).toMatchObject({status:'ready',duration:71.267,variants:[{height:1080,portable:true}]});
    expect(request.mock.calls.some(([url]) => url === v.sourceUrl)).toBe(false);
  });
  it('requests HTTPS redirect permission before fetching an HTTP catalog source', async () => {
    const v = video(); v.sourceUrl = 'http://example.org/watch';
    vi.mocked(browser.permissions.contains).mockImplementation(async ({ origins }) => origins?.[0] === 'http://example.org/*');
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
    expect(await resolveVideo(v)).toMatchObject({status:'site',requiredOrigins:['https://example.org/*']});
    expect(fetch).not.toHaveBeenCalled();
  });
  it('explains network failures without claiming that a full stream was found', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('NetworkError when attempting to fetch resource.')));
    const result = await resolveVideo(video());
    expect(result.status).toBe('error'); expect(result.reason).toContain('включите сбор');
    expect(result.reason).toContain('NetworkError');
  });
  it('requests missing origin access without fetching the page', async () => {
    vi.mocked(browser.permissions.contains).mockResolvedValue(false); const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
    expect(await resolveVideo(video())).toMatchObject({ status: 'site', requiredOrigins: ['https://example.org/*'] }); expect(fetch).not.toHaveBeenCalled();
  });
  it('finds an HLS manifest from a source page and verifies child playlists', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => response(url.endsWith('/watch') ? '<video src="https://example.org/master.m3u8"></video>' : url.endsWith('master.m3u8') ? '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1000,RESOLUTION=1280x720\n720.m3u8' : '#EXTM3U\n#EXTINF:5,\nseg.ts\n#EXT-X-ENDLIST', url)));
    expect(await resolveVideo(video())).toMatchObject({ status: 'ready', duration: 5, live: false, variants: [{ height: 720, portable: true }] });
  });
  it('keeps unsupported sources as site links and reports HTTP errors', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => response('<iframe src="player"></iframe>', url)));
    expect(await resolveVideo(video())).toMatchObject({ status: 'site' });
    vi.stubGlobal('fetch', vi.fn(async (url: string) => response('expired', url, 403)));
    expect(await resolveVideo(video())).toMatchObject({ status: 'error', reason: 'Источник ответил HTTP 403' });
  });
  it('refuses to export protected streams even when the master itself has no key', async () => {
    const v = video(); v.variants = [{ url: 'https://example.org/master.m3u8', format: 'hls' }];
    vi.stubGlobal('fetch', vi.fn(async (url: string) => response(url.endsWith('master.m3u8') ? '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1000\nchild.m3u8' : '#EXTM3U\n#EXT-X-KEY:METHOD=SAMPLE-AES,URI="key"', url)));
    expect(await resolveVideo(v)).toMatchObject({ status: 'site' });
  });
});
