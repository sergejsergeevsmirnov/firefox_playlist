import { discoverGeneric, rankSourceCandidates } from './discovery';
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
  constructor(public origins: string[]) { super('Нужен доступ к сайту для проверки источника'); }
}
export async function requireAccess(url: string): Promise<void> {
  if (!httpUrl(url)) throw new Error('Неподдерживаемый адрес');
  const origin = originPattern(url);
  if (!await browser.permissions.contains({ origins: [origin] })) throw new PermissionNeeded([origin]);
}
async function fetchText(url: string, budget?: AbortSignal, maxBytes = 2 * 1024 * 1024, referrer?: string): Promise<{ text: string; url: string; mime: string }> {
  // Catalogs can retain HTTP links to HTTPS-only hosts. Obtain both scheme
  // permissions before Firefox follows the redirect, not after fetch fails.
  const origins = [originPattern(url)];
  const address = new URL(url);
  if (address.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(address.hostname)) origins.push(originPattern(url).replace(/^http:/, 'https:'));
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
    await requireAccess(response.url);
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
  await response.body?.cancel().catch(() => {});
  if (!ok) throw new Error(`Формат, доступ или CORS не позволяют открыть видео (HTTP ${response.status})`);
  return { variant: { ...variant, portable: true }, duration: undefined, live: undefined };
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
    const page = await fetchText(vimeoFetchUrl(input.sourceUrl), budget);
    const doc = new DOMParser().parseFromString(page.text, 'text/html');
    const tryCandidates = async (candidates: Candidate[]) => {
      for (const candidate of rankSourceCandidates(candidates, input.expectedDuration).slice(0, 8)) {
        const result = await resolveStreams({ ...input, variants: candidate.variants,
          duration: input.duration ?? candidate.duration, expectedDuration: input.expectedDuration ?? candidate.expectedDuration }, budget);
        if (result.status === 'ready') return result;
        attempts.push(result);
      }
    };
    const result = await tryCandidates(discoverGeneric(doc, page.url));
    if (result) return result;
    // Follow only explicitly embedded player frames, one level, never related-page links.
    const embeds = [...doc.querySelectorAll('iframe[src], meta[name="twitter:player"]')].map(f => httpUrl(f.getAttribute('src') || f.getAttribute('content'), page.url))
      .filter((url): url is string => !!url && /player|embed|video/i.test(new URL(url).pathname) && !isPreviewUrl(url)).slice(0, 2);
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
    const missing = [...new Set(attempts.flatMap(result => result.requiredOrigins ?? []))];
    return { status: 'site', variants: [], duration: input.expectedDuration ?? input.duration, requiredOrigins: missing,
      reason: missing.length ? 'Нужен доступ к сайту полного видео или CDN.' : attempts.find(a => a.reason)?.reason || 'Полный поток не найден в открытых данных. Откройте оригинал и запустите его плеер.' };
  } catch (error) {
    if (error instanceof PermissionNeeded) return { status: 'site', reason: error.message, requiredOrigins: [...new Set([...attempts.flatMap(a => a.requiredOrigins ?? []), ...error.origins])] };
    if (cancellation?.aborted) return {status:'site',reason:'Проверка отменена при остановке сбора.',requiredOrigins:[]};
    if (budget.aborted) return {status:'error',reason:'Проверка превысила 60 секунд. Источник или его медиасервер не ответил вовремя.',requiredOrigins:[]};
    const reason = error instanceof Error ? error.message : 'Не удалось проверить источник';
    const vk = /(^|\.)(vkvideo\.ru|vk\.com)$/.test(new URL(input.sourceUrl).hostname);
    if (vk && /NetworkError|Failed to fetch|fetch failed/i.test(reason)) return {status:'site',requiredOrigins:[],reason:'VK Видео не отдал страницу фоновому запросу (возможен цикл перенаправлений или требование сеанса). Откройте источник и включите сбор на его вкладке; автоматический доступ не подтверждён.'};
    return { status: 'error', reason: /NetworkError|Failed to fetch|fetch failed/i.test(reason)
      ? 'Firefox не смог загрузить источник. Возможны блокировка запроса, перенаправление на другой сайт или недоступность сервера. Откройте источник и включите сбор на его вкладке. Подробности: ' + reason
      : reason, requiredOrigins: [] };
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
