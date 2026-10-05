import { httpUrl, mediaFormat } from './core';
import { vkIdentity, vkResourceCandidates } from './capture-policy';
import type { Variant } from './model';

// Parse the al_video.php AJAX payload. The response nests a serialized player
// (an HTML fragment with <source>/<video> tags) inside `payload[1]`; stream URLs
// are extracted from that text rather than from a fixed JSON schema, so the
// parser keeps working when VK reshuffles the surrounding fields.
export function vkStreams(text: string): { variants: Variant[]; duration?: number; title?: string } {
  let root: { payload?: unknown };
  try { root = JSON.parse(text) as { payload?: unknown }; } catch { throw new Error('VK не вернул JSON данные плеера.'); }
  const payload = Array.isArray(root.payload) ? root.payload : [];
  const code = payload[0];
  if (code === '3' || code === 3) throw new Error('Ролик VK доступен только после входа в аккаунт.');
  if (code === '8' || code === 8) throw new Error('VK отклонил проверку ролика (доступ ограничен или ролик удалён).');
  const variants: Variant[] = []; const seen = new Set<string>();
  let duration: number | undefined; let title: string | undefined;
  const addUrl = (raw: string): void => {
    const url = httpUrl(raw);
    if (!url || seen.has(url)) return;
    const format = mediaFormat(url);
    if (!format) return;
    seen.add(url); variants.push({ url, format });
  };
  const walk = (value: unknown): void => {
    if (typeof value === 'string') {
      // JSON.parse unescapes \/ but not HTML entities, so decode &amp; first.
      const plain = value.replace(/&amp;/g, '&').replace(/&#0*39;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
      for (const match of plain.matchAll(/(?:https?:)?\/\/[^\s"'<>\\]+/g)) addUrl(match[0].startsWith('//') ? `https:${match[0]}` : match[0]);
      return;
    }
    if (Array.isArray(value)) { value.forEach(walk); return; }
    if (value && typeof value === 'object') {
      const obj = value as Record<string, unknown>;
      if (duration === undefined && typeof obj.duration === 'number' && obj.duration > 0) duration = obj.duration;
      if (title === undefined && typeof obj.title === 'string' && obj.title.trim()) title = obj.title;
      for (const child of Object.values(obj)) walk(child);
    }
  };
  walk(payload);
  if (!variants.length) throw new Error('VK не предоставил открытый поток для этого ролика.');
  return { variants, duration, title };
}
// Query the player AJAX endpoint directly; far more reliable than a background tab.
export async function readVkStreams(source: string, signal: AbortSignal): Promise<{ variants: Variant[]; duration?: number; title?: string }> {
  const identity = vkIdentity(source);
  if (!identity) throw new Error('Не распознан адрес ролика VK.');
  const body = new URLSearchParams({ act: 'show', al: '1', video: identity.slice(3) });
  const response = await fetch('https://vk.com/al_video.php', {
    method: 'POST', credentials: 'omit', referrer: 'https://vk.com/', signal,
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-Requested-With': 'XMLHttpRequest' },
    body: body.toString(),
  });
  if (!response.ok) throw new Error(`VK ответил HTTP ${response.status}`);
  return vkStreams(await response.text());
}

// The caller serializes browser checks and checks host permissions first.
export async function readVkPlayer(source: string, signal: AbortSignal, activate = false): Promise<Variant[]> {
  signal.throwIfAborted();
  const identity = vkIdentity(source);
  if (!identity) throw new Error('Не распознан адрес ролика VK.');
  const sourceAddress = new URL(source);
  sourceAddress.protocol='https:'; sourceAddress.hostname='vkvideo.ru';
  const url = sourceAddress.href;
  const previous = activate ? (await browser.tabs.query({active:true,currentWindow:true}))[0] : undefined;
  const tab = await browser.tabs.create({url:'about:blank',active:false});
  if (tab.id === undefined) throw new Error('Не удалось открыть фоновую вкладку VK.');
  const tabId = tab.id;
  const streams = new Map<string, Variant>();
  const inspected = new Set<string>();
  let diagnostic = 'Страница плеера ещё не проверена.';
  const listener = (details: browser.webRequest._OnHeadersReceivedDetails) => {
    if (details.tabId !== tabId || details.statusCode >= 400 || !vkResourceCandidates(url,[details.url]).length) return;
    const mime = details.responseHeaders?.find(h => h.name.toLowerCase() === 'content-type')?.value || '';
    const format = mediaFormat(details.url,mime);
    if (format === 'dash' || format === 'hls') streams.set(details.url,{url:details.url,format});
  };
  try {
    browser.webRequest.onHeadersReceived.addListener(listener,{urls:['https://*.okcdn.ru/*']},['responseHeaders']);
    await browser.tabs.update(tabId,{muted:true});
    await browser.tabs.update(tabId,activate ? {url,active:true} : {url});
    const deadline = Date.now()+25000;
    while (Date.now()<deadline) {
      signal.throwIfAborted();
      const current = await browser.tabs.get(tabId);
      if (current.url && vkIdentity(current.url) !== identity) diagnostic = 'Переход на другую страницу: '+new URL(current.url).hostname;
      if (current.url && vkIdentity(current.url) === identity) {
        if (streams.size) return [...streams.values()];
        try {
          const results = await browser.scripting.executeScript({target:{tabId,allFrames:true},args:[identity.slice(3)],func:((expected:string) => {
            const address=new URL(location.href);
            const key=/^\/(?:video|clip)(-?\d+_\d+)(?:\/|$)/.exec(address.pathname)?.[1]
              || (address.pathname==='/video_ext.php' ? `${address.searchParams.get('oid')}_${address.searchParams.get('id')}` : '');
            if (!/(^|\.)(vkvideo\.ru|vk\.com)$/.test(address.hostname) || key!==expected) return;
            const context=globalThis as typeof globalThis & {__vkProbePlay?:string};
            const videos=[...document.querySelectorAll('video')];
            for (const video of videos) {
              video.muted=true;
              if (video.paused) void video.play().then(()=>{context.__vkProbePlay='запущен';},error=>{context.__vkProbePlay=String(error?.name || 'ошибка запуска');});
            }
            return {resources:performance.getEntriesByType('resource').map(entry=>entry.name),videos:videos.length,play:context.__vkProbePlay || 'ожидание',title:document.title.slice(0,120),ready:document.readyState,frames:document.querySelectorAll('iframe').length};
          }) as (expected:string) => void});
          const observations=results.flatMap(result=>result.result ? [{frameId:result.frameId, data:result.result as {resources:string[];videos:number;play:string;title?:string;ready?:string;frames?:number}}] : []);
          const resources=observations.flatMap(item=>item.data.resources);
          diagnostic=`Видеоэлементов: ${observations.reduce((n,item)=>n+item.data.videos,0)}; запуск: ${observations.map(item=>item.data.play).join(', ') || 'ожидание'}; фреймов проверено: ${observations.length}; iframe: ${observations.reduce((n,item)=>n+(item.data.frames || 0),0)}; загрузка: ${observations[0]?.data.ready || current.status}; страница: ${observations[0]?.data.title || 'без заголовка'}; адресов CDN: ${vkResourceCandidates(current.url,resources).length}; проверено: ${inspected.size}.`;
          const candidates = observations.flatMap(item=>vkResourceCandidates(current.url!,item.data.resources).map(candidate=>({candidate,frameId:item.frameId})))
            .filter(item=>!inspected.has(item.candidate)).slice(0,4);
          for (const {candidate,frameId} of candidates) {
            inspected.add(candidate);
            const responses = await browser.scripting.executeScript({target:{tabId,frameIds:[frameId]},args:[candidate],func:(async (address:string) => {
              try {
                const response=await fetch(address,{method:'HEAD',credentials:'omit',signal:AbortSignal.timeout(2000)});
                return response.ok ? response.headers.get('content-type') : '';
              } catch { return ''; }
            }) as unknown as (address:string) => void});
            const format = mediaFormat(candidate,String(responses[0]?.result || ''));
            if (format==='dash' || format==='hls') streams.set(candidate,{url:candidate,format});
            signal.throwIfAborted();
          }
          if (streams.size) return [...streams.values()];
        } catch (error) { signal.throwIfAborted(); diagnostic='Не удалось прочитать плеер: '+(error instanceof Error ? error.message : String(error)); }
      }
      await new Promise(resolve=>setTimeout(resolve,500));
    }
    throw new Error('VK не предоставил манифест за 25 секунд в фоновой вкладке. '+diagnostic);
  } finally {
    browser.webRequest.onHeadersReceived.removeListener(listener);
    const wasActive = activate && await browser.tabs.get(tabId).then(current=>!!current.active,()=>false);
    await browser.tabs.remove(tabId).catch(()=>{});
    if (wasActive && previous?.id !== undefined) await browser.tabs.update(previous.id,{active:true}).catch(()=>{});
  }
}
