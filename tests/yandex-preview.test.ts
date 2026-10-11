// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { discoverYandex, yandexEmbedUrls, yandexPreviewUrl } from '../src/discovery';
import { playerjsFiles } from '../src/resolver';
const parse = (html: string) => new DOMParser().parseFromString(html, 'text/html');
const card = (id: string, source: string, title: string) => `
  <div class="VideoSnippet">
    <a href="/video/preview/${id}?from=tabbar&parent-reqid=1791-abc&text=x"><img src="https://avatars.mds.yandex.net/i?id=${id}"></a>
    <a class="VideoHostExtended-Host" href="${source}">host</a>
    <h3 class="VideoSnippet-Title">${title}</h3>
  </div>`;

describe('Yandex preview fallback', () => {
  it('normalizes preview URLs to the short per-video form', () => {
    expect(yandexPreviewUrl('https://yandex.ru/video/preview/15910246161110032134?from=tabbar&parent-reqid=1-2-BAL&text=x'))
      .toBe('https://yandex.ru/video/preview/15910246161110032134');
    expect(yandexPreviewUrl('https://yandex.ru/video/search?text=x')).toBeUndefined();
    expect(yandexPreviewUrl('https://example.com/video/preview/1')).toBeUndefined();
  });
  it('keeps each card bound to its own preview URL', () => {
    const page = 'https://yandex.ru/video/search?text=x';
    const found = discoverYandex(parse(card('111', 'http://a.example/videos/1/', 'A') + card('222', 'http://b.example/videos/2/', 'B')), page);
    expect(found.map(c => [c.sourceUrl, c.variants.map(v => v.url)])).toEqual([
      ['http://a.example/videos/1/', ['https://yandex.ru/video/preview/111']],
      ['http://b.example/videos/2/', ['https://yandex.ru/video/preview/222']],
    ]);
  });
  it('reads the embedded player from the preview page HTML', () => {
    const html = `<script>{"embedUrl":"https://ppembed.com/embed/42568","url":"http://prostoporno.army/videos/42568/"}</script>
      <iframe src="https://yastatic.net/video-player/0x1/pages-common/iframe-default/iframe-default.html#html=%3Ciframe%20src%3D%22https%3A%2F%2Fppembed.com%2Fembed%2F42568%22%20style%3D%22border%3Anone%3B%22%20%2F%3E&event_prefix=sandbox:"></iframe>`;
    expect(yandexEmbedUrls(html)).toEqual(['https://ppembed.com/embed/42568']);
    expect(yandexEmbedUrls('{"embedUrl":"https:\\/\\/player.example\\/e\\/7"}')).toEqual(['https://player.example/e/7']);
    expect(yandexEmbedUrls('<html>nothing</html>')).toEqual([]);
  });
  it('resolves Playerjs "./" sources from the site root', () => {
    const html = `<script>var player = new Playerjs({id:"player", file = "[SD 480p]./common/mp4/video.mp4?q=480&v=34127&sg=3&vurl=x or ./common/mp4/video.mp4?q=480&v=34127&sg=1&vurl=x"});</script>`;
    expect(playerjsFiles(html, 'https://5xxx-embed.weirdcdn.com/34127/').map(v => v.url)).toEqual([
      'https://5xxx-embed.weirdcdn.com/common/mp4/video.mp4?q=480&v=34127&sg=3&vurl=x',
      'https://5xxx-embed.weirdcdn.com/common/mp4/video.mp4?q=480&v=34127&sg=1&vurl=x',
    ]);
    expect(playerjsFiles('file:"#2aGVsbG8="', 'https://a.example/')).toEqual([]);
  });
  it('keeps KVS flashvars URLs whole, access token included', () => {
    const html = `<script>var flashvars = { video_id: '263249',
      video_url: 'https://www.ebalka.video/get_file/19/3492/263000/263249/263249_240p.mp4/?v-acctoken=NDg4fDg0&embed=true', postfix: '_240p.mp4',
      video_alt_url: 'https://www.ebalka.video/get_file/19/0985/263000/263249/263249.mp4/?v-acctoken=MTYw&embed=true',
      preview_url: 'https://www.ebalka.video/contents/videos_screenshots/263000/263249/preview.jpg' };</script>`;
    expect(playerjsFiles(html, 'https://www.ebalka.video/embed/263249').map(v => v.url)).toEqual([
      'https://www.ebalka.video/get_file/19/3492/263000/263249/263249_240p.mp4/?v-acctoken=NDg4fDg0&embed=true',
      'https://www.ebalka.video/get_file/19/0985/263000/263249/263249.mp4/?v-acctoken=MTYw&embed=true',
    ]);
  });
});
