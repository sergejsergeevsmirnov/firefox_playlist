import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

export function createFixtureServer(onReport = () => {}) {
  let expired = false;
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    res.setHeader('Access-Control-Allow-Origin', '*');
    if (url.pathname === '/checkpoint' && req.method === 'POST') {
      let body = ''; for await (const part of req) body += part;
      console.log(`Firefox checkpoint: ${body}`); res.end('ok'); return;
    }
    if (url.pathname === '/report' && req.method === 'POST') {
      let body = ''; for await (const part of req) body += part;
      res.end('ok'); onReport(JSON.parse(body)); return;
    }
    if (url.pathname === '/invalidate' && req.method === 'POST') { expired = true; res.end('ok'); return; }
    if (url.pathname === '/old.mp4' && expired) { res.writeHead(403); res.end('Expired'); return; }
    if (['/flower.mp4', '/old.mp4', '/slow.mp4'].includes(url.pathname)) {
      res.setHeader('Cache-Control', 'no-store');
      if (url.pathname === '/slow.mp4') await new Promise(resolve => setTimeout(resolve, 3500));
      try {
        const body = await readFile('.test-artifacts/flower.mp4');
        const range = /bytes=(\d+)-(\d*)/.exec(req.headers.range || '');
        res.setHeader('Content-Type', 'video/mp4'); res.setHeader('Accept-Ranges', 'bytes');
        if (range) {
          const start = Number(range[1]); const end = range[2] ? Math.min(Number(range[2]), body.length - 1) : body.length - 1;
          res.writeHead(206, { 'Content-Range': `bytes ${start}-${end}/${body.length}`, 'Content-Length': end - start + 1 }); res.end(body.subarray(start, end + 1));
        } else { res.setHeader('Content-Length', body.length); res.end(body); }
      } catch { res.writeHead(404); res.end('Run test:firefox to download the CC0 media fixture.'); }
      return;
    }
    if (url.pathname === '/expired.mp4') { res.writeHead(403); res.end('Expired'); return; }
    if (url.pathname === '/master.m3u8') { res.setHeader('Content-Type', 'application/vnd.apple.mpegurl'); res.end('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=500000,RESOLUTION=960x540\n/recording.m3u8'); return; }
    if (url.pathname === '/recording.m3u8') { res.setHeader('Content-Type', 'application/vnd.apple.mpegurl'); res.end('#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXTINF:5,\n/flower.mp4\n#EXT-X-ENDLIST'); return; }
    if (url.pathname === '/dash-no-extension') {
      res.setHeader('Content-Type','application/dash+xml');
      res.end('<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" type="static" mediaPresentationDuration="PT65.254S"><Period><AdaptationSet mimeType="video/mp4"><Representation id="v" width="720" height="720" bandwidth="1248560" frameRate="60"><BaseURL>/flower.mp4?ct=11</BaseURL><SegmentBase indexRange="899-1098"><Initialization range="0-898"/></SegmentBase></Representation></AdaptationSet><AdaptationSet mimeType="audio/mp4"><Representation id="a" bandwidth="267182"><BaseURL>/flower.mp4?ct=12</BaseURL><SegmentBase indexRange="837-1024"><Initialization range="0-836"/></SegmentBase></Representation></AdaptationSet></Period></MPD>'); return;
    }
    // Synthetic manifests test discovery/metadata, not actual segmented playback.
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    if (url.pathname === '/frame') { res.end('<title>Видео во фрейме</title><video src="/flower.mp4?frame=1" preload="metadata" title="Во фрейме"></video>'); return; }
    if (url.pathname === '/page') {
      res.end(`<!doctype html><html lang="ru"><title>Тестовая видеостраница</title><h1>Видео для проверки</h1><video src="/flower.mp4" preload="metadata" controls title="Цветы · основной ролик"></video><iframe src="/frame"></iframe><script>setTimeout(()=>{const a=document.createElement('a');a.href='/flower.mp4?dynamic=1';a.textContent='Динамическое видео';document.body.append(a)},2000)</script></html>`); return;
    }
    if (url.pathname === '/new-search') { res.end('<title>Новый поиск</title><h1>Другой запрос</h1>'); return; }
    if (url.pathname === '/slow-page') { res.end('<title>Медленный источник</title><a href="/slow.mp4">Медленное видео</a>'); return; }
    if (url.pathname === '/expiring') { res.end(`<title>Обновление ссылки</title><video src="${expired ? '/flower.mp4?renewed=1' : '/old.mp4'}" title="Истекающая ссылка" preload="none"></video>`); return; }
    if (url.pathname === '/renewable') { res.end('<title>Обновляемый источник</title><video src="/flower.mp4?renewed=1"></video>'); return; }
    if (url.pathname === '/adaptive') { res.end('<title>Адаптивные потоки</title><a href="https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8">Тест HLS</a><a href="https://storage.googleapis.com/shaka-demo-assets/angel-one/dash.mpd">Тест DASH</a>'); return; }
    res.end('<title>Источник без прямого видео</title><h1>Требуется плеер сайта</h1>');
  });
  return server;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  createFixtureServer().listen(8765, '127.0.0.1', () => console.log('Fixtures: http://127.0.0.1:8765/page'));
}
