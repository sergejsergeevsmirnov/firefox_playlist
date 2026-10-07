import { discoverGeneric, isYandexVideo, rankSourceCandidates } from './discovery';
import { httpUrl, mediaFormat, originPattern } from './core';
import { parseDash, parseHls } from './manifests';
import type { Candidate, Video, Variant } from './model';
import { isPreviewUrl, isShortPreview } from './media-policy';
import { rutubeOptionsUrl, rutubeStreams } from './rutube';
import { dzenPageUrl, dzenStreams, readDzenPlayer } from './dzen';
import { okPageUrl, okStreams } from './ok';
import { captureOrigins, sourceIdentity, vimeoFetchUrl, vimeoIdentity, vkIdentity, youtubeIdentity } from './capture-policy';
import { readVkPlayer, readVkStreams } from './vk';
import { readYoutubePlayer, youtubeEmbedUrl } from './youtube';
import { vimeoConfigUrl, vimeoStreams, readVimeoPlayer } from './vimeo';
import { nativePing } from './native';

export class PermissionNeeded extends Error {
  /** Set when a cross-domain redirect was detected: the canonical URL the source actually lives at. */
  canonicalUrl?: string;
  constructor(public origins: string[]) { super('Нужен доступ к сайту для проверки источника'); }
}
export async function requireAccess(url: string): Promise<void> {
  if (!httpUrl(url)) throw new Error('Неподдерживаемый адрес');
  const origin = originPattern(url);
  if (!await browser.permissions.contains({ origins: [origin] })) throw new PermissionNeeded([origin]);
}
async function fetchText(url: string, budget?: AbortSignal, maxBytes = 2 * 1024 * 1024, referrer?: string, detectRedirects = false): Promise<{ text: string; url: string; mime: string }> {
  // Catalogs can retain HTTP links to HTTPS-only hosts. Obtain both scheme
  // permissions before Firefox follows the redirect, not after fetch fails.
  const origins = [originPattern(url)];
  const address = new URL(url);
  if (address.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(address.hostname)) origins.push(originPattern(url).replace(/^http:/, 'https:'));
  if (detectRedirects) {
    // Quick HEAD pre-flight to discover cross-domain redirects so all required
    // permissions can be bundled into a single user dialog instead of one per step.
    try {
      const pre = await fetch(url, { method: 'HEAD', credentials: 'omit', redirect: 'follow',
        referrerPolicy: 'no-referrer', signal: AbortSignal.timeout(3000) });
      const finalOrigin = originPattern(pre.url);
      if (!origins.includes(finalOrigin)) {
        origins.push(finalOrigin);
        const fa = new URL(pre.url);
        if (fa.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(fa.hostname))
          origins.push(finalOrigin.replace(/^http:/, 'https:'));
      }
    } catch { /* pre-flight failed; proceed with known origins only */ }
  }
  const missing: string[] = [];
  for (const origin of origins) if (!await browser.permissions.contains({ origins: [origin] })) missing.push(origin);
  if (missing.length) throw new PermissionNeeded(missing);
  await requireAccess(url);
  const controller = new AbortController(); const timeout = setTimeout(() => controller.abort(), 12000);
  try {
    const fetchInit: RequestInit = { credentials: 'omit', signal: budget ? AbortSignal.any([controller.signal, budget]) : controller.signal };
    if (referrer) { fetchInit.referrer = referrer; } else { fetchInit.referrerPolicy = 'no-referrer'; }
    const response = await fetch(url, fetchInit);
    if (!response.ok) throw new Error(`Источник ответил HTTP ${response.status}`);
    // Inline permission check for the redirect destination (replaces requireAccess so we can
    // attach canonicalUrl to the error when a cross-domain redirect was discovered).
    if (!await browser.permissions.contains({ origins: [originPattern(response.url)] })) {
      const err = new PermissionNeeded([originPattern(response.url)]);
      if (response.url !== url) err.canonicalUrl = response.url;
      throw err;
    }
    const reader = response.body?.getReader(); const decoder = new TextDecoder(); let text = ''; let size = 0;
    if (!reader) throw new Error('Пустой ответ источника');
    try {
      while (true) {
        const part = await reader.read(); if (part.done) break;
        size += part.value.length; if (size > maxBytes) throw new Error('Ответ источника превышает допустимый размер; откройте плеер сайта');
        text += decoder.decode(part.value, { stream: true });
      }
      text += decoder.decode();
    } finally { await reader.cancel().catch(() => {}); }
    return { text, url: response.url, mime: response.headers.get('content-type') || '' };
  } catch (error) {
    if (controller.signal.aborted && !budget?.aborted) throw new Error('Источник не ответил за 12 секунд. Проверьте доступность сайта и настройки подключения Firefox.');
    throw error;
  } finally { clearTimeout(timeout); }
}
function probeFileMetadata(url: string): Promise<{ width?: number; height?: number; duration?: number; live?: boolean } | undefined> {
  return new Promise(resolve => {
    const video = document.createElement('video'); video.preload = 'metadata';
    const timer = setTimeout(() => finish(undefined), 8000);
    const finish = (meta?: { width?: number; height?: number; duration?: number; live?: boolean }) => {
      clearTimeout(timer);
      video.onloadedmetadata = null; video.onerror = null; video.removeAttribute('src'); video.load();
      resolve(meta);
    };
    video.onloadedmetadata = () => finish({ width: video.videoWidth || undefined, height: video.videoHeight || undefined,
      duration: Number.isFinite(video.duration) ? video.duration : undefined,
      live: video.duration === Infinity ? true : undefined });
    video.onerror = () => finish(undefined);
    video.src = url;
  });
}
export async function probeFile(variant: Variant): Promise<{ variant: Variant; duration?: number; live?: boolean }> {
  const probeHost = new URL(variant.url).hostname;
  if (!['127.0.0.1', 'localhost', '[::1]', '::1'].includes(probeHost)) await requireAccess(variant.url);
  const meta = await probeFileMetadata(variant.url);
  if (meta) {
    return { variant: { ...variant, width: meta.width ?? variant.width, height: meta.height ?? variant.height, portable: true },
      duration: meta.duration, live: meta.live };
  }
  // The hidden background page often cannot play the media element (or the CDN
  // blocks the anonymous element load). Verify accessibility with a range fetch,
  // which needs no video decoding and can send a site referer where required.
  const host = new URL(variant.url).hostname;
  const init: RequestInit = { method: 'GET', credentials: 'omit', headers: { Range: 'bytes=0-1023' } };
  if (/(^|\.)googlevideo\.com$/.test(host)) init.referrer = 'https://www.youtube.com/';
  else init.referrerPolicy = 'no-referrer';
  const response = await fetch(variant.url, init);
  const ok = response.ok || response.status === 206;
  const contentType = response.headers.get('content-type') || '';
  await response.body?.cancel().catch(() => {});
  if (!ok) throw new Error(`Формат, доступ или CORS не позволяют открыть видео (HTTP ${response.status})`);
  // An HTML response means the URL is a web page (e.g. an embed player), not a video file.
  if (/^text\/html/i.test(contentType)) throw new Error('URL ведёт на HTML-страницу плеера, а не на видеофайл; откройте источник в браузере');
  return { variant: { ...variant, portable: true }, duration: undefined, live: undefined };
}
let embedTabBusy = false;
async function readEmbedPlayer(embedUrl: string, budget: AbortSignal): Promise<Variant[]> {
  if (embedTabBusy) return [];
  embedTabBusy = true;
  try {
    const tab = await browser.tabs.create({ url: embedUrl, active: false });
    if (tab.id === undefined) return [];
    try {
      await browser.tabs.update(tab.id, { muted: true });
      const deadline = Date.now() + 20000;
      let complete = false; let finalUrl = embedUrl;
      while (Date.now() < deadline) {
        budget.throwIfAborted();
        // Always read the current tab URL so JS-redirects (that fire after 'complete')
        // are also captured. porno-bomba.net → 11.porno-bomba.net is a JS redirect that
        // happens AFTER the initial page reaches 'complete', so we must keep polling the URL.
        const current = await browser.tabs.get(tab.id);
        if (current.url && current.url !== 'about:blank') finalUrl = current.url;
        if (!complete && current.status === 'complete') complete = true;
        if (complete) {
          // After a redirect (http → https or JS-driven) the tab URL changes —
          // require permission for the destination before injecting scripts.
          if (!await browser.permissions.contains({ origins: [originPattern(finalUrl)] })) {
            throw new PermissionNeeded([originPattern(finalUrl)]);
          }
          let result: browser.scripting.InjectionResult[] | null = null;
          try {
            result = await browser.scripting.executeScript({
              target: { tabId: tab.id, allFrames: true },
              func: (async () => {
                const urls: string[] = [];
                document.querySelectorAll('video').forEach((v: Element) => {
                  const ve = v as HTMLVideoElement;
                  for (const attr of ['src', 'data-src', 'data-video', 'data-url']) {
                    const s = attr === 'src' ? (ve.currentSrc || ve.src) : (ve.getAttribute(attr) ?? '');
                    if (s && /^https?:\/\//.test(s) && !urls.includes(s)) urls.push(s);
                  }
                  ve.querySelectorAll('source').forEach((src: Element) => {
                    for (const attr of ['src', 'data-src']) {
                      const u = (src as HTMLSourceElement).getAttribute(attr) || '';
                      if (u && /^https?:\/\//.test(u) && !urls.includes(u)) urls.push(u);
                    }
                  });
                  // Trigger lazy-loading players: set src from data-src if not loaded, then play (muted).
                  ve.muted = true;
                  if (!ve.src && !ve.currentSrc) {
                    const lazySrc = ve.getAttribute('data-src') || ve.getAttribute('data-video');
                    if (lazySrc) ve.src = lazySrc;
                  }
                  ve.play().catch(() => {});
                });
                // Read player config from JS APIs — available even before the video plays.
                const tryAdd = (u: unknown) => { const s = String(u ?? ''); if (/^https?:\/\//.test(s) && !urls.includes(s)) urls.push(s); };
                try {
                  const jw = (window as any).jwplayer;
                  if (typeof jw === 'function') {
                    const readInst = (inst: any) => {
                      try {
                        const p = inst?.getConfig?.()?.playlist?.[0];
                        [...(p?.sources ?? []), p ?? {}].forEach((s: any) => { tryAdd(s?.file); tryAdd(s?.src); });
                        const item = inst?.getPlaylistItem?.();
                        if (item) { tryAdd(item.file); (item.sources ?? []).forEach((s: any) => { tryAdd(s?.file); tryAdd(s?.src); }); }
                      } catch {}
                    };
                    readInst(jw());
                    document.querySelectorAll('[id]').forEach((el: Element) => { try { readInst(jw(el.id)); } catch {}; });
                  }
                } catch {}
                try {
                  const vjs = (window as any).videojs?.players ?? {};
                  Object.values(vjs).forEach((p: any) => { try { tryAdd((p as any).currentSrc?.()); } catch {}; });
                } catch {}
                // Click common play-button selectors so lazy-loading players start fetching the video.
                if (urls.length === 0) {
                  ['.jw-icon-play', '.fp-play', '[class*="play-btn"]', '[class*="playbtn"]', '[class*="play_btn"]', '[class*="playBtn"]',
                    '[aria-label*="play" i]', '[title*="play" i]', '[class*="player-play"]', '[class*="play-button"]',
                    '[class*="PlayBtn"]', '[class*="play_button"]', '.video-play', '.player-btn-play'].forEach((sel: string) => {
                    try { document.querySelectorAll(sel).forEach((el: Element) => (el as HTMLElement).click()); } catch {}
                  });
                  // Dispatch synthetic events on video elements to nudge players that need interaction
                  document.querySelectorAll('video').forEach((ve: Element) => {
                    try {
                      ['mousedown', 'mouseup', 'click'].forEach((type: string) => {
                        ve.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true }));
                      });
                    } catch {}
                  });
                }
                // Scan all network requests loaded by this frame — captures video URLs fetched
                // via XHR or media element even before <video>.currentSrc is populated.
                performance.getEntriesByType('resource').forEach((e: PerformanceEntry) => {
                  const u = (e as PerformanceResourceTiming).name;
                  if (/\.(mp4|webm|m3u8|mpd|ogg|ts)(\?|$)/i.test(u) && !urls.includes(u)) urls.push(u);
                });
                // Scan live <script> content for media URLs — finds URLs embedded in
                // player setup calls (jwplayer, etc.) even before network requests fire.
                const mediaRe = /https?:\/\/[^\s'"<>{}\[\]\\,|]+\.(?:mp4|webm|m3u8|mpd|flv|mov)(?:\?[^\s'"<>{}\[\]\\,|]*)?/gi;
                document.querySelectorAll('script').forEach((s: Element) => {
                  const text = s.textContent || '';
                  let m: RegExpExecArray | null; mediaRe.lastIndex = 0;
                  while ((m = mediaRe.exec(text)) !== null) {
                    if (!urls.includes(m[0])) urls.push(m[0]);
                  }
                });
                // Re-fetch API/XHR endpoints the player called to extract media URLs from JSON responses.
                // This catches players that load the video URL via a separate API request (not in HTML).
                const seen = new Set<string>(urls);
                const apiRe = /\/(?:api|ajax|player|video|stream|media|embed|get_video|getplayer)\//i;
                const apiCandidates = performance.getEntriesByType('resource')
                  .map((e: PerformanceEntry) => (e as PerformanceResourceTiming).name)
                  .filter((u: string) => {
                    try { return apiRe.test(new URL(u).pathname) && !/\.(js|css|png|jpg|gif|svg|woff2?|ico|wasm)(\?|$)/i.test(u); }
                    catch { return false; }
                  }).slice(0, 8);
                for (const apiUrl of apiCandidates) {
                  try {
                    const r = await fetch(apiUrl, { credentials: 'same-origin', signal: AbortSignal.timeout(2500) });
                    if (!r.ok) continue;
                    const ct = r.headers.get('content-type') || '';
                    if (!/json|text|javascript/i.test(ct)) continue;
                    const text = await r.text();
                    const mRe = /https?:\/\/[^\s'"<>{}\[\]\\,|]{4,400}\.(?:mp4|webm|m3u8|mpd|flv|mov)(?:\?[^\s'"<>{}\[\]\\,|]*)?/gi;
                    let m: RegExpExecArray | null;
                    while ((m = mRe.exec(text)) !== null) {
                      if (!seen.has(m[0])) { seen.add(m[0]); urls.push(m[0]); }
                    }
                  } catch { /* ignore XHR re-fetch errors */ }
                }
                return urls;
              }) as unknown as () => void
            });
          } catch { /* executeScript can fail if a frame became unavailable; continue polling */ }
          // Combine results from all frames (main document + iframes)
          const rawUrls = [...new Set((result ?? []).flatMap((r: browser.scripting.InjectionResult) => (r?.result ?? []) as string[]))];
          const foundVars = rawUrls.flatMap((url: string) => {
            if (isPreviewUrl(url)) return [];
            const format = mediaFormat(url) ?? ('file' as const);
            return [{ url, format, portable: true as const }];
          });
          if (foundVars.length) return foundVars;
        }
        await new Promise(r => setTimeout(r, 600));
      }
      // Polling exhausted — no video found in any frame.
      // Discover embed <iframe> URLs from the main frame (including data-src and
      // dynamically-set srcs) and try fetching their HTML directly.
      try {
        budget.throwIfAborted();
        if (await browser.permissions.contains({ origins: [originPattern(finalUrl)] })) {
          const iframeResult = await browser.scripting.executeScript({
            target: { tabId: tab.id },
            func: (() => {
              const srcs: string[] = [];
              document.querySelectorAll('iframe').forEach(f => {
                // src attribute (may be absolute or protocol-relative), then data-src fallback
                const raw = (f as HTMLIFrameElement).src || f.getAttribute('data-src') || f.getAttribute('data-lazy-src') || '';
                const abs = raw.startsWith('//') ? 'https:' + raw : raw;
                if (/^https?:\/\//.test(abs) && !srcs.includes(abs)) srcs.push(abs);
              });
              return srcs.slice(0, 5);
            }) as () => void
          });
          const iframeSrcs = (iframeResult[0]?.result ?? []) as string[];
          for (const src of iframeSrcs) {
            try {
              budget.throwIfAborted();
              const ep = await fetchText(src, budget);
              const ed = new DOMParser().parseFromString(ep.text, 'text/html');
              const vars = rankSourceCandidates(discoverGeneric(ed, ep.url), undefined)
                .slice(0, 8).flatMap(c => c.variants).filter(v => !isPreviewUrl(v.url));
              if (vars.length) return vars.map(v => ({ ...v, portable: true as const }));
            } catch (e) {
              if (e instanceof PermissionNeeded) throw e;
            }
          }
        }
      } catch (e) { if (e instanceof PermissionNeeded) throw e; }
      return [];
    } finally { await browser.tabs.remove(tab.id).catch(() => {}); }
  } finally { embedTabBusy = false; }
}
// Discovers the final URL after HTTP and JS redirects by opening a background tab.
// tabs.create and tabs.get require NO host permissions, so this runs before any permission
// is granted — used to bundle redirect-destination origins (like 11.porno-bomba.net) into
// the very first "Разрешить проверку" dialog instead of requiring a second click.
//
// Keyed by source origin so that N concurrent checks for the same domain open exactly ONE
// background tab (all share the same Promise). On error the cache entry is removed so the
// next caller retries.
const redirectDiscoveryCache = new Map<string, Promise<string>>();
function discoverTabRedirect(url: string): Promise<string> {
  let origin: string;
  try { origin = new URL(url).origin; } catch { return Promise.resolve(url); }
  const existing = redirectDiscoveryCache.get(origin);
  if (existing) return existing;
  const discovery = (async () => {
    const tab = await browser.tabs.create({ url, active: false });
    if (tab.id === undefined) return url;
    try {
      await browser.tabs.update(tab.id, { muted: true }).catch(() => {});
      let finalUrl = url;
      const deadline = Date.now() + 8000;
      while (Date.now() < deadline) {
        const current = await browser.tabs.get(tab.id);
        if (current.url && current.url !== 'about:blank') finalUrl = current.url;
        if (current.status === 'complete') {
          // Wait for JS-redirects that fire after 'complete' (e.g. porno-bomba.net → 11.porno-bomba.net).
          await new Promise(r => setTimeout(r, 1500));
          const after = await browser.tabs.get(tab.id);
          if (after.url && after.url !== 'about:blank') finalUrl = after.url;
          break;
        }
        await new Promise(r => setTimeout(r, 400));
      }
      return finalUrl;
    } finally {
      await browser.tabs.remove(tab.id).catch(() => {});
    }
  })();
  discovery.catch(() => redirectDiscoveryCache.delete(origin));
  redirectDiscoveryCache.set(origin, discovery);
  return discovery;
}
export async function resolveVideo(input: Video, allowBrowser = false, cancellation?: AbortSignal, vkCaptureFailure?: string, vkForeground = false): Promise<Partial<Video>> {
  const timeout = AbortSignal.timeout(60000);
  const budget = cancellation ? AbortSignal.any([timeout,cancellation]) : timeout;
  const attempts: Partial<Video>[] = [];
  try {
    const existing = input.variants.filter(v => !isPreviewUrl(v.url));
    if (existing.length) {
      const result = await resolveStreams({ ...input, variants: existing }, budget);
      if (result.status === 'ready') return result;
      attempts.push(result);
    }
    const rutube = rutubeOptionsUrl(input.sourceUrl);
    if (rutube) {
      const origins = ['https://*.rutube.ru/*', 'https://*.rtbcdn.ru/*'];
      const missing: string[] = [];
      for (const origin of origins) if (!await browser.permissions.contains({origins:[origin]})) missing.push(origin);
      if (missing.length) throw new PermissionNeeded(missing);
      const response = await fetchText(rutube, budget);
      const streams = rutubeStreams(response.text);
      return await resolveStreams({...input, variants:streams.variants, duration:streams.duration ?? input.duration}, budget);
    }
    const ok = okPageUrl(input.sourceUrl);
    if (ok) {
      const missing: string[] = [];
      for (const origin of ['https://ok.ru/*', 'https://*.okcdn.ru/*']) if (!await browser.permissions.contains({origins:[origin]})) missing.push(origin);
      if (missing.length) throw new PermissionNeeded(missing);
      const page = await fetchText(ok, budget, 6 * 1024 * 1024);
      const data = okStreams(page.text, ok);
      return await resolveStreams({...input, variants:data.variants, duration:data.duration ?? input.duration}, budget);
    }
    const dzen = dzenPageUrl(input.sourceUrl);
    if (dzen) {
      const missing: string[] = [];
      for (const origin of ['https://dzen.ru/*', 'https://*.okcdn.ru/*']) {
        if (!await browser.permissions.contains({origins:[origin]})) missing.push(origin);
      }
      if (missing.length) throw new PermissionNeeded(missing);
      let data;
      if (allowBrowser) data = dzenStreams(await readDzenPlayer(dzen, budget));
      else {
        try { data = dzenStreams((await fetchText(dzen, budget)).text); }
        catch {
          budget.throwIfAborted();
          data = dzenStreams(await readDzenPlayer(dzen, budget));
        }
      }
      return await resolveStreams({...input,variants:data.variants,duration:data.duration ?? input.duration}, budget);
    }
    const direct = mediaFormat(input.sourceUrl);
    if (direct && !isPreviewUrl(input.sourceUrl)) return existing.length ? attempts[0] : resolveStreams({ ...input, variants: [{ url: input.sourceUrl, format: direct }] }, budget);
    if (sourceIdentity(input.sourceUrl)) {
      const missing: string[] = [];
      for (const origin of captureOrigins(input.sourceUrl)) if (!await browser.permissions.contains({origins:[origin]})) missing.push(origin);
      if (missing.length) throw new PermissionNeeded(missing);
    }
    if (vkIdentity(input.sourceUrl)) {
      // Direct player-data request first; no tab, no autoplay. The muted-tab
      // capture below stays only as a fallback for responses the AJAX endpoint
      // no longer exposes.
      try {
        const data = await readVkStreams(input.sourceUrl, budget);
        if (data.variants.length) return await resolveStreams({...input, variants:data.variants, duration:data.duration ?? input.duration, title:data.title ?? input.title}, budget);
      } catch (error) {
        budget.throwIfAborted();
        attempts.push({ reason: error instanceof Error ? error.message : 'VK не предоставил поток через API.' });
      }
      if (vkCaptureFailure) return {status:'site',requiredOrigins:[],reason:'Автопроверка VK приостановлена до нового сеанса сбора, чтобы не открывать остальные вкладки после неудачи. Можно проверить этот ролик кнопкой «Проверить снова». Причина первой неудачи: '+vkCaptureFailure};
      const variants = await readVkPlayer(input.sourceUrl,budget,vkForeground);
      return await resolveStreams({...input,variants},budget);
    }
    if (youtubeIdentity(input.sourceUrl)) {
      // 1) Register the YouTube watch URL; the background downloads it in the
      // background (non-blocking) so queueing stays fast.
      if (await nativePing()) {
        const id = youtubeIdentity(input.sourceUrl)!.slice(8);
        return { status: 'ready', variants: [{ url: `https://www.youtube.com/watch?v=${id}`, format: 'native', portable: false }],
          duration: input.duration ?? input.expectedDuration, title: input.title,
          reason: 'YouTube: скачивается в фоне через yt-dlp.', requiredOrigins: [] };
      }
      // 2) Fallback: the page's own WEB player response (works only when the
      // stream is not SABR-encrypted), then the in-window embed.
      let extractionError = '';
      try {
        const data = await readYoutubePlayer(input.sourceUrl, budget);
        if (data.variants.length) {
          return { status: 'ready', variants: data.variants.map(v => ({ ...v, portable: true })),
            duration: data.duration ?? input.duration ?? input.expectedDuration, title: data.title ?? input.title,
            reason: data.captured ? `URL взят из работающего плеера страницы (${data.note ?? ''})` : data.note ? data.note : undefined, requiredOrigins: [] };
        }
      } catch (error) {
        budget.throwIfAborted();
        extractionError = error instanceof Error ? error.message : 'Не удалось получить поток YouTube.';
        attempts.push({ reason: extractionError });
      }
      // 3) Fall back to the in-window embed (works for embeddable videos).
      const embed = youtubeEmbedUrl(input.sourceUrl);
      if (!embed) return { status: 'site', reason: extractionError || 'Не удалось определить адрес ролика YouTube.', requiredOrigins: [] };
      return { status: 'ready', variants: [{ url: embed, format: 'youtube' }],
        duration: input.duration ?? input.expectedDuration, title: input.title,
        reason: extractionError ? `Извлечение потока не удалось (использую встроенный фрейм): ${extractionError}` : undefined,
        requiredOrigins: [] };
    }
    if (vimeoIdentity(input.sourceUrl)) {
      const configUrl = vimeoConfigUrl(input.sourceUrl);
      if (configUrl) {
        try {
          const response = await fetchText(configUrl, budget, 2 * 1024 * 1024, 'https://vimeo.com/');
          const data = vimeoStreams(response.text);
          if (data.variants.length) {
            return await resolveStreams({ ...input, variants: data.variants,
              duration: data.duration ?? input.duration, title: data.title ?? input.title }, budget);
          }
        } catch (error) {
          budget.throwIfAborted();
          attempts.push({ reason: error instanceof Error ? error.message : 'Vimeo не предоставил поток через API.' });
        }
      }
      // Fallback: open a silent background tab and capture manifests the Vimeo player loads.
      const variants = await readVimeoPlayer(input.sourceUrl, budget);
      return await resolveStreams({ ...input, variants }, budget);
    }
    const fetchUrl = vimeoFetchUrl(input.sourceUrl);
    const page = await fetchText(fetchUrl, budget, undefined, undefined, true);
    const doc = new DOMParser().parseFromString(page.text, 'text/html');
    // When the page redirected to a different domain, record the canonical URL so the
    // stored sourceUrl is updated to the real site after the check completes.
    const canonical = page.url !== fetchUrl ? page.url : undefined;
    const withCanonical = (r: Partial<Video>): Partial<Video> => canonical ? { ...r, sourceUrl: canonical } : r;
    const tryCandidates = async (candidates: Candidate[]) => {
      for (const candidate of rankSourceCandidates(candidates, input.expectedDuration).slice(0, 8)) {
        const result = await resolveStreams({ ...input, variants: candidate.variants,
          duration: input.duration ?? candidate.duration, expectedDuration: input.expectedDuration ?? candidate.expectedDuration }, budget);
        if (result.status === 'ready') return withCanonical(result);
        attempts.push(result);
      }
    };
    const result = await tryCandidates(discoverGeneric(doc, page.url));
    if (result) return result;
    // Follow explicitly embedded player frames and og:video URLs without a media extension
    // (those are embed player pages, e.g. pbembed.me/embed/55864/, not direct video files).
    const ogEmbedSrcs = [...doc.querySelectorAll('meta[property="og:video"],meta[property="og:video:url"]')]
      .map(m => httpUrl(m.getAttribute('content'), page.url))
      .filter((url): url is string => !!url && !mediaFormat(url));
    const embeds = [...new Set([
      ...[...doc.querySelectorAll('iframe[src], meta[name="twitter:player"]')]
        .map(f => httpUrl(f.getAttribute('src') || f.getAttribute('content'), page.url)),
      ...ogEmbedSrcs,
    ])].filter((url): url is string => !!url && /player|embed|video/i.test(new URL(url).pathname) && !isPreviewUrl(url)).slice(0, 2);
    for (const embed of embeds) {
      try {
        const frame = await fetchText(embed, budget);
        const result = await tryCandidates(discoverGeneric(new DOMParser().parseFromString(frame.text, 'text/html'), frame.url));
        if (result) return result;
      } catch (error) {
        if (error instanceof PermissionNeeded) attempts.push({ requiredOrigins: error.origins });
        else attempts.push({reason:error instanceof Error ? error.message : 'Плеер источника недоступен'});
      }
    }
    // Static HTML had nothing — open each embed in a background tab so JavaScript can run
    // and video elements can appear (e.g. pbembed.me players load their src dynamically).
    for (const embed of embeds) {
      try {
        const vars = await readEmbedPlayer(embed, budget);
        if (vars.length) {
          const result = await resolveStreams({ ...input, variants: vars }, budget);
          if (result.status === 'ready') return withCanonical(result);
          attempts.push(result);
        }
      } catch (error) {
        if (error instanceof PermissionNeeded) attempts.push({ requiredOrigins: error.origins });
        else attempts.push({ reason: error instanceof Error ? error.message : 'Встроенный плеер не запустился' });
      }
    }
    // If fetchText succeeded (e.g. Cloudflare challenge page, 200 OK but no video content),
    // no embeds were found, and no permissions are missing — the page was fetched headlessly
    // but wasn't the real player page. Open the source URL in a background tab as last resort:
    // this discovers redirect destinations (e.g. https://11.porno-bomba.net/) and either finds
    // the video or surfaces the required host permission for that subdomain.
    const embedsMissingBefore = [...new Set(attempts.flatMap(result => result.requiredOrigins ?? []))];
    if (!embeds.length && !embedsMissingBefore.length) {
      try {
        const vars = await readEmbedPlayer(fetchUrl, budget);
        if (vars.length) {
          const r = await resolveStreams({ ...input, variants: vars }, budget);
          if (r.status === 'ready') return withCanonical(r);
          attempts.push(r);
        }
      } catch (tabError) {
        if (tabError instanceof PermissionNeeded) {
          return withCanonical({ status: 'site', reason: tabError.message,
            requiredOrigins: [...new Set([...embedsMissingBefore, ...tabError.origins])] });
        }
      }
    }
    const missing = [...new Set(attempts.flatMap(result => result.requiredOrigins ?? []))];
    return withCanonical({ status: 'site', variants: [], duration: input.expectedDuration ?? input.duration, requiredOrigins: missing,
      reason: missing.length ? 'Нужен доступ к сайту полного видео или CDN.' : attempts.find(a => a.reason)?.reason || 'Полный поток не найден в открытых данных. Откройте оригинал и запустите его плеер.' });
  } catch (error) {
    if (error instanceof PermissionNeeded) {
      const extraOrigins: string[] = [];
      // For generic (non-provider) sites, proactively discover JS-redirect destinations by
      // opening a background tab — tabs.create/tabs.get need no host permissions.
      // This bundles the redirect target (e.g. https://11.porno-bomba.net/*) into the FIRST
      // permission dialog so the user only has to click "Разрешить" once.
      const isGenericSite = !rutubeOptionsUrl(input.sourceUrl) && !okPageUrl(input.sourceUrl) &&
        !dzenPageUrl(input.sourceUrl) && !mediaFormat(input.sourceUrl) &&
        !sourceIdentity(input.sourceUrl) && !vkIdentity(input.sourceUrl) &&
        !youtubeIdentity(input.sourceUrl) && !vimeoIdentity(input.sourceUrl);
      if (isGenericSite) {
        try {
          const redirectUrl = await discoverTabRedirect(input.sourceUrl);
          const redirectOrigin = originPattern(redirectUrl);
          if (!error.origins.includes(redirectOrigin) &&
              !await browser.permissions.contains({ origins: [redirectOrigin] })) {
            extraOrigins.push(redirectOrigin);
            const addr = new URL(redirectUrl);
            if (addr.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(addr.hostname))
              extraOrigins.push(redirectOrigin.replace(/^http:/, 'https:'));
          }
        } catch { /* best-effort; AbortError or tab errors must not block the permission dialog */ }
      }
      const r: Partial<Video> = { status: 'site', reason: error.message,
        requiredOrigins: [...new Set([...attempts.flatMap(a => a.requiredOrigins ?? []), ...error.origins, ...extraOrigins])] };
      if (error.canonicalUrl) r.sourceUrl = error.canonicalUrl;
      return r;
    }
    if (cancellation?.aborted) return {status:'site',reason:'Проверка отменена при остановке сбора.',requiredOrigins:[]};
    if (budget.aborted) return {status:'error',reason:'Проверка превысила 60 секунд. Источник или его медиасервер не ответил вовремя.',requiredOrigins:[]};
    const reason = error instanceof Error ? error.message : 'Не удалось проверить источник';
    const vk = /(^|\.)(vkvideo\.ru|vk\.com)$/.test(new URL(input.sourceUrl).hostname);
    if (vk && /NetworkError|Failed to fetch|fetch failed/i.test(reason)) return {status:'site',requiredOrigins:[],reason:'VK Видео не отдал страницу фоновому запросу (возможен цикл перенаправлений или требование сеанса). Откройте источник и включите сбор на его вкладке; автоматический доступ не подтверждён.'};
    // When headless fetch is blocked (anti-scraping), try to resolve via background tabs.
    if (/NetworkError|Failed to fetch|fetch failed/i.test(reason)) {
      const allOrigins = () => [...new Set(attempts.flatMap(a => a.requiredOrigins ?? []))];
      // Embed-page URLs that arrived as initial variants (format=file, no media extension —
      // e.g. pbembed.me/embed/55864/ from og:video). Open those directly in a tab: the
      // <video> element is in the main frame there, so no cross-origin iframe permission needed.
      const variantEmbeds = (input.variants ?? [])
        .filter(v => v.format === 'file' && !mediaFormat(v.url))
        .map(v => v.url);
      // For known embed CDN services, reconstruct the embed page URL from the stored (possibly
      // expired) CDN file URL so we can fetch a fresh video URL without opening the source page.
      //   pbembed.me: /get_file/2/{hash}/{prefix}/{id}/{id}_*.mp4/ → /embed/{id}/
      const derivedEmbeds = (input.variants ?? []).flatMap(v => {
        const pb = /^https?:\/\/pbembed\.me\/get_file\/\d+\/[^/]+\/\d+\/(\d+)\//i.exec(v.url);
        if (pb) return [`https://pbembed.me/embed/${pb[1]}/`];
        return [];
      });
      for (const embedUrl of [...variantEmbeds, ...derivedEmbeds]) {
        // 1) Static HTML first — embed services often allow headless fetch and may carry
        //    the video URL in a <script> variable or JSON-LD.
        try {
          const ep = await fetchText(embedUrl, budget);
          const ed = new DOMParser().parseFromString(ep.text, 'text/html');
          for (const c of rankSourceCandidates(discoverGeneric(ed, ep.url), input.expectedDuration).slice(0, 8)) {
            const r = await resolveStreams({ ...input, variants: c.variants, duration: input.duration ?? c.duration }, budget);
            if (r.status === 'ready') return r;
            attempts.push(r);
          }
        } catch (embedErr) {
          if (embedErr instanceof PermissionNeeded)
            return { status: 'site', reason: embedErr.message, requiredOrigins: [...new Set([...allOrigins(), ...embedErr.origins])] };
        }
        // 2) Background tab — let JavaScript run so the player initialises <video>.
        try {
          const vars = await readEmbedPlayer(embedUrl, budget);
          if (vars.length) {
            const r = await resolveStreams({ ...input, variants: vars }, budget);
            if (r.status === 'ready') return r;
            attempts.push(r);
          }
        } catch (tabErr) {
          if (tabErr instanceof PermissionNeeded)
            return { status: 'site', reason: tabErr.message, requiredOrigins: [...new Set([...allOrigins(), ...tabErr.origins])] };
        }
      }
      // Finally, open the source page itself in a background tab (catches sites that render
      // the player in the main frame without an explicit embed URL in the variants).
      try {
        const vars = await readEmbedPlayer(input.sourceUrl, budget);
        if (vars.length) {
          const result = await resolveStreams({ ...input, variants: vars }, budget);
          if (result.status === 'ready') return result;
          attempts.push(result);
        }
      } catch (tabError) {
        if (tabError instanceof PermissionNeeded) {
          return { status: 'site', reason: tabError.message, requiredOrigins: [...new Set([...allOrigins(), ...tabError.origins])] };
        }
      }
      // If background-tab probing found the video URL but couldn't verify the CDN
      // (missing host permission), surface a permission request instead of a generic error.
      const cdnMissing = allOrigins();
      if (cdnMissing.length) return { status: 'site', reason: 'Нужен доступ к CDN видео для проверки источника.', requiredOrigins: cdnMissing };
      return { status: 'error', reason: 'Firefox не смог загрузить источник. Возможны блокировка запроса, перенаправление на другой сайт или недоступность сервера. Откройте источник и включите сбор на его вкладке. Подробности: ' + reason, requiredOrigins: [] };
    }
    // HTTP 4xx: external source page is gone — try Yandex preview URL stored as a fallback
    // variant. The Yandex player loads a working CDN URL regardless of external site status.
    // Skip static fetch (Yandex is a React SPA) and go straight to background tab.
    if (/HTTP 4\d\d/.test(reason)) {
      const yandexFallbacks = (input.variants ?? [])
        .filter(v => v.format === 'file' && !mediaFormat(v.url) && isYandexVideo(v.url))
        .map(v => v.url);
      if (yandexFallbacks.length) {
        const allOriginsY = () => [...new Set(attempts.flatMap(a => a.requiredOrigins ?? []))];
        for (const fallbackUrl of yandexFallbacks) {
          try {
            const vars = await readEmbedPlayer(fallbackUrl, budget);
            if (vars.length) {
              const r = await resolveStreams({ ...input, variants: vars }, budget);
              if (r.status === 'ready') return r;
              attempts.push(r);
            }
          } catch (tabErr) {
            if (tabErr instanceof PermissionNeeded)
              return { status: 'site', reason: tabErr.message, requiredOrigins: [...new Set([...allOriginsY(), ...tabErr.origins])] };
          }
        }
      }
    }
    return { status: 'error', reason, requiredOrigins: [] };
  }
}
async function resolveStreams(input: Video, budget: AbortSignal): Promise<Partial<Video>> {
  const streams = input.variants.filter(v => !isPreviewUrl(v.url));
  try {
    const variants: Variant[] = []; const missing = new Set<string>(); const errors: string[] = [];
    let duration = input.duration; let live = input.live;
    for (const stream of [...new Map(streams.map(v => [v.url, v])).values()].slice(0, 12)) {
      try {
        budget.throwIfAborted();
        if (stream.format === 'file') {
          const result = await probeFile(stream);
          if (isShortPreview(result.duration, input.expectedDuration)) throw new Error('Короткое превью не соответствует длительности полного видео');
          variants.push(result.variant);
          duration = result.duration ?? duration; live = result.live ?? live;
        } else {
          const response = await fetchText(stream.url, budget);
          const info = stream.format === 'hls' ? parseHls(response.text, response.url) : parseDash(response.text, response.url);
          if (info.protected) throw new Error('Защищённый или зашифрованный поток: используйте плеер сайта');
          duration = info.duration ?? duration; live = info.live ?? live;
          if (stream.format === 'hls' && info.dependencies.length) {
            // Verify every rendition playlist, including separate audio; never export unverified masters.
            for (const child of info.dependencies.slice(0, 32)) {
              const response = await fetchText(child, budget); const childInfo = parseHls(response.text, response.url);
              if (childInfo.protected) throw new Error('Зашифрованный вариант HLS: используйте плеер сайта');
              if (childInfo.dependencies.length) throw new Error('Вложенные мастер-плейлисты HLS пока не поддерживаются');
              info.resourceUrls.push(...childInfo.resourceUrls);
              duration = childInfo.duration ?? duration; live = childInfo.live ?? live;
            }
          }
          if (isShortPreview(duration, input.expectedDuration)) throw new Error('Найден поток превью вместо полного видео');
          const deps = [...new Set([...info.dependencies, ...info.resourceUrls].map(originPattern))];
          for (const origin of deps) if (!await browser.permissions.contains({ origins: [origin] })) missing.add(origin);
          let portable = missing.size === 0 && info.dependencies.length <= 32 && info.resourceUrls.length > 0;
          if (portable) {
            // Check a representative resource per host anonymously; never download entire segments here.
            const probes = stream.format === 'dash' ? [...new Set(info.resourceUrls)].slice(0,32)
              : [...new Map(info.resourceUrls.map(r => [originPattern(r), r])).values()];
            if (stream.format === 'dash' && new Set(info.resourceUrls).size > 32) portable = false;
            for (const resource of probes) {
              const check = await fetch(resource, { credentials: 'omit', headers: { Range: 'bytes=0-1023' }, signal: budget, referrerPolicy: 'no-referrer' });
              portable = portable && check.ok;
              await check.body?.cancel();
              if (!check.ok) throw new Error(`Медиасегмент недоступен: HTTP ${check.status}`);
            }
          }
          variants.push(...info.variants.map(v => ({ ...v, portable })));
        }
      } catch (error) {
        if (error instanceof PermissionNeeded) error.origins.forEach(o => missing.add(o));
        else errors.push(error instanceof Error ? error.message : 'Ошибка проверки');
      }
    }
    if (missing.size) return { status: 'site', reason: 'Разрешите доступ к источнику или CDN для проверки.', requiredOrigins: [...missing], variants: variants.length ? variants : input.variants, duration, live };
    if (!variants.length) return { status: 'site', reason: errors[0] || 'Источник недоступен', requiredOrigins: [] };
    return { status: 'ready', variants, duration, live, reason: errors.length ? errors.join('; ') : undefined, requiredOrigins: [] };
  } catch (error) {
    if (error instanceof PermissionNeeded) return { status: 'site', reason: error.message, requiredOrigins: error.origins };
    return { status: 'error', reason: error instanceof Error ? error.message : 'Не удалось проверить источник', requiredOrigins: [] };
  }
}
