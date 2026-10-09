import { candidateId, enqueue, httpUrl, matches, mediaFormat, mergeCandidate, originPattern, restoreState, bestVariant } from './core';
import { emptyState, variantKey, type Candidate, type Session, type State, type Video, type Filters } from './model';
import { resolveVideo } from './resolver';
import { TaskPool } from './task-pool';
import { isPreviewUrl } from './media-policy';
import { isYandexVideo } from './discovery';
import { quickFilters } from './quick-filters';
import { dzenPageUrl } from './dzen';
import { okPageUrl } from './ok';
import { captureOrigins, sourceIdentity, isVimeoChildManifest, vimeoIdentity, vkIdentity, youtubeIdentity } from './capture-policy';
import { nativeDownload, nativeCleanup, nativePing, nativeStatus, nativeGetProxy, nativeSetProxy } from './native';

let state: State = emptyState();
let sessions: Record<number, Session> = {};
const pool = new TaskPool(2);
const browserCheckPool = new TaskPool(1);
const runningChecks = new Map<string, {tab?:number; controller:AbortController}>();
const scheduled = new Set<string>();
const activeDownloads = new Map<string, Promise<{ url: string }>>();
const requestSessions = new Map<string, { tab: number; token: string }>();
const extensionRoot = browser.runtime.getURL('');
// Auto-retry: 30 s → 2 min → 5 min, then give up.
const autoRetryDelays = [30_000, 120_000, 300_000];
const autoRetryState = new Map<string, { count: number }>();
function scheduleAutoRetry(id: string): void {
  const entry = autoRetryState.get(id) ?? { count: 0 };
  if (entry.count >= 3) {
    autoRetryState.delete(id);
    void mutate(() => { if (state.videos[id]) state.videos[id].reason = (state.videos[id].reason ?? '') + ' (3 авто-проверки не прошли)'; });
    return;
  }
  const delay = autoRetryDelays[entry.count];
  autoRetryState.set(id, { count: entry.count + 1 });
  const attempt = entry.count + 1;
  const label = delay >= 60_000 ? `${Math.round(delay / 60_000)} мин` : `${delay / 1_000} с`;
  void mutate(() => { if (state.videos[id]) state.videos[id].reason = (state.videos[id].reason ?? '') + ` (попытка ${attempt}/3, повтор через ${label})`; });
  setTimeout(() => {
    const v = state.videos[id];
    if (!v || v.status === 'ready' || v.status === 'checking') return;
    void mutate(() => { if (state.videos[id]) { state.videos[id].status = 'checking'; state.videos[id].reason = undefined; } });
    schedule(id);
  }, delay);
}
let writeChain: Promise<unknown> = Promise.resolve();
// Cache broad access flag — set on startup and after permissionsChanged.
let _broadAccess = false;
async function refreshBroadAccess(): Promise<void> {
  _broadAccess = await browser.permissions.contains({ origins: ['http://*/*', 'https://*/*'] });
}
// Returns true when access to any http/https site is granted (either via host_permissions or
// broad optional grant). Avoids false-negative from contains() on a specific origin pattern
// when the extension already holds a superset wildcard.
async function hasAccess(origin: string): Promise<boolean> {
  return _broadAccess || browser.permissions.contains({ origins: [origin] });
}
const ready = Promise.all([browser.storage.local.get('state'), browser.storage.session.get('sessions')]).then(async ([local, transient]) => {
  await refreshBroadAccess();
  state = restoreState(local.state); sessions = transient.sessions ?? {};
  state.filters = quickFilters(state.filters);
  for (const video of Object.values(state.videos)) {
    if (video.status === 'ready') continue;
    const missing: string[] = [];
    for (const origin of captureOrigins(video.sourceUrl)) if (!await hasAccess(origin)) missing.push(origin);
    if (missing.length) {
      video.status = 'site'; video.requiredOrigins = missing;
      video.reason = 'Нужен доступ к сайту и CDN для обнаружения потока. После разрешения включите сбор на странице ролика и перезагрузите её.';
    }
  }
  for (const video of Object.values(state.videos)) {
    const provider = okPageUrl(video.sourceUrl) ? 'OK' : dzenPageUrl(video.sourceUrl) ? 'Дзен' : undefined;
    if (video.status === 'ready' || !provider) continue;
    const missing: string[] = [];
    for (const origin of [provider === 'OK' ? 'https://ok.ru/*' : 'https://dzen.ru/*', 'https://*.okcdn.ru/*']) {
      if (!await hasAccess(origin)) missing.push(origin);
    }
    if (missing.length) {
      video.status = 'site'; video.requiredOrigins = missing;
      video.reason = `Разрешите проверку ${provider} и его CDN.`;
    }
  }
  // Recover saved failures caused by an HTTP -> HTTPS redirect without access.
  for (const video of Object.values(state.videos)) {
    if (video.status !== 'error' || !/NetworkError|Failed to fetch/i.test(video.reason ?? '') || !video.sourceUrl.startsWith('http:')) continue;
    const secureOrigin = originPattern(video.sourceUrl).replace(/^http:/, 'https:');
    if (!await hasAccess(secureOrigin)) {
      video.status = 'site'; video.requiredOrigins = [secureOrigin];
      video.reason = 'Разрешите доступ к HTTPS-версии источника для повторной проверки.';
    }
  }
  const activeIds = new Set(Object.values(sessions).flatMap(session => session.ids ?? []));
  for (const video of Object.values(state.videos)) if (video.status === 'checking' && !activeIds.has(video.id)) {
    video.status = 'site'; video.reason = 'Проверка была прервана. Нажмите «Проверить снова».';
  }
  await browser.storage.local.set({ state });
  for (const [tab, session] of Object.entries(sessions)) {
    for (const id of session.ids ?? []) if (state.videos[id]?.status === 'checking') schedule(id, Number(tab), session.token);
  }
});
function mutate<T>(fn: () => T | Promise<T>): Promise<T> {
  const operation = writeChain.then(async () => { await ready; const result = await fn();
    await browser.storage.local.set({ state }); await browser.storage.session.set({ sessions }); return result; });
  writeChain = operation.catch(console.error); return operation;
}
function current(tab: number, token: string): boolean { return sessions[tab]?.token === token; }
function endSession(tab: number): void {
  for (const check of runningChecks.values()) if (check.tab === tab) check.controller.abort();
  const session = sessions[tab];
  if (session) for (const id of session.ids) {
    const video = state.videos[id];
    if (video?.status === 'checking') { video.status = 'site'; video.reason = 'Сеанс сбора завершён. Можно проверить источник снова.'; }
  }
  delete sessions[tab];
}
function schedule(id: string, tab?: number, token?: string, allowBrowser = false, vkForeground = false): void {
  const key = `${id}|${tab ?? ''}|${token ?? ''}`;
  if (scheduled.has(key)) return;
  scheduled.add(key);
  const needsBrowser = state.videos[id] && (dzenPageUrl(state.videos[id].sourceUrl) || vkIdentity(state.videos[id].sourceUrl) || vimeoIdentity(state.videos[id].sourceUrl));
  const task = async () => {
    let changedDuringCheck = false;
    try {
      await ready;
      if (tab !== undefined && !current(tab, token!)) return;
      const input = state.videos[id]; if (!input) return;
      const controller = new AbortController(); runningChecks.set(key,{tab,controller});
      const snapshot = structuredClone(input);
      const vk = !!vkIdentity(snapshot.sourceUrl);
      const failure = tab === undefined ? undefined : sessions[tab]?.vkCaptureFailure;
      const result = await resolveVideo(snapshot, allowBrowser,controller.signal, vk ? failure : undefined, vkForeground || (tab !== undefined && sessions[tab]?.vkForeground === true));
      await mutate(() => {
        if (tab !== undefined && !current(tab, token!)) return;
        if (!state.videos[id]) return;
        if (vk && tab !== undefined && result.status !== 'ready' && !result.requiredOrigins?.length && !failure) {
          sessions[tab].vkCaptureFailure = result.reason || 'Фоновая проверка VK не дала готового потока.';
        }
        if (state.videos[id].variants.some(v => !snapshot.variants.some(old => old.url === v.url))) {
          changedDuringCheck = true; return;
        }
        Object.assign(state.videos[id], result);
        const blocked = Object.values(sessions).flatMap(s => s.previewUrls ?? []);
        state.videos[id].variants = state.videos[id].variants.filter(v => (!isPreviewUrl(v.url) || isYandexVideo(v.url)) && !blocked.includes(v.url));
        if (state.videos[id].status === 'ready' && !state.videos[id].variants.length) {
          state.videos[id].status = 'site'; state.videos[id].reason = 'Найдено только превью. Нужен полный поток с сайта-источника.';
        }
        const suppressed = Object.values(sessions).flatMap(s => s.suppressed);
        enqueue(state, state.videos[id], suppressed);
      });
      // Auto-retry on transient failures (not permission errors).
      if (result.status === 'ready') {
        autoRetryState.delete(id);
      } else if (!result.requiredOrigins?.length) {
        scheduleAutoRetry(id);
      }
      // Kick off the YouTube download in the background without blocking the
      // next check in the queue.
      const nativeVariant = result.variants?.find(v => v.format === 'native');
      if (nativeVariant && result.status === 'ready') void ensureDownload(nativeVariant.url);
    } finally {
      scheduled.delete(key); runningChecks.delete(key);
      if (changedDuringCheck && (tab === undefined || current(tab,token!))) schedule(id,tab,token,allowBrowser,vkForeground);
    }
  };
  if (needsBrowser) browserCheckPool.add(() => new Promise<void>(resolve => {
    pool.add(async () => { try { await task(); } finally { resolve(); } });
  }));
  else pool.add(task);
}
// Background (deduplicated) download of a YouTube video. The check that adds the
// video to the queue does NOT wait for it; the download finishes in the
// background and swaps the `native` variant for a local `file` URL.
function ensureDownload(youtubeUrl: string): Promise<{ url: string }> {
  const key = youtubeIdentity(youtubeUrl)?.slice(8) || youtubeUrl;
  const existing = activeDownloads.get(key);
  if (existing) return existing;
  const promise = (async () => {
    const result = await nativeDownload(youtubeUrl, key);
    await mutate(() => {
      for (const video of Object.values(state.videos)) {
        if (video.variants.some(v => v.format === 'native' && v.url === youtubeUrl)) {
          video.variants = video.variants.filter(v => v.format !== 'native');
          video.variants.unshift({ url: result.url, format: 'file', portable: false });
          if (video.status === 'ready') video.reason = 'Скачан через yt-dlp (локальное воспроизведение).';
        }
      }
    });
    return result;
  })();
  activeDownloads.set(key, promise);
  promise.catch(() => {}).finally(() => { activeDownloads.delete(key); });
  return promise;
}
function cleanCandidate(raw: Candidate): Candidate | undefined {
  const sourceUrl = httpUrl(raw?.sourceUrl); if (!sourceUrl || typeof raw.title !== 'string' || !Array.isArray(raw.variants)) return;
  const finite = (v: unknown) => typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : undefined;
  return { sourceUrl, identity: typeof raw.identity === 'string' ? raw.identity.slice(0, 4096) : undefined,
    title: raw.title.slice(0, 500), thumbnail: httpUrl(raw.thumbnail), duration: finite(raw.duration), expectedDuration: finite(raw.expectedDuration),
    discovery: raw.discovery === 'catalog' || raw.discovery === 'structured' ? raw.discovery : undefined,
    live: typeof raw.live === 'boolean' ? raw.live : undefined,
    variants: raw.variants.slice(0, 24).filter(v => httpUrl(v.url) && (!isPreviewUrl(v.url) || isYandexVideo(v.url)) && ['file', 'hls', 'dash', 'youtube'].includes(v.format)).map(v => ({
      url: v.url, format: v.format, width: finite(v.width), height: finite(v.height),
    })),
  };
}
function addCandidate(candidate: Candidate, session: Session): string {
  let id = candidateId(candidate);
  // Network observations and DOM observations of the same stream share a record.
  const sourceKey = sourceIdentity(candidate.sourceUrl);
  const related = Object.values(state.videos).find(v => v.id === id || (sourceKey && sourceKey === sourceIdentity(v.sourceUrl)) || (v.discovery === 'catalog' && v.sourceUrl === candidate.sourceUrl) || candidate.variants.some(a => v.variants.some(b => a.url === b.url)));
  if (related) id = related.id;
  const hasNewStream = candidate.variants.some(v => !state.videos[id]?.variants.some(p => p.url === v.url));
  const revisitBrowser = !!(dzenPageUrl(candidate.sourceUrl) || vkIdentity(candidate.sourceUrl)) && !session.ids.includes(id)
    && ['site','error'].includes(state.videos[id]?.status ?? '');
  state.videos[id] = mergeCandidate(state.videos[id], candidate);
  if (hasNewStream && state.videos[id].status !== 'checking') state.videos[id].status = 'checking';
  if (revisitBrowser) state.videos[id].status = 'checking';
  if (!session.ids.includes(id)) session.ids.push(id);
  if (state.videos[id].status === 'ready') enqueue(state, state.videos[id], session.suppressed);
  return id;
}
let scriptSync: Promise<void> = Promise.resolve();
function syncScripts(): Promise<void> {
  scriptSync = scriptSync.catch(() => {}).then(syncScriptsNow);
  return scriptSync;
}
async function syncScriptsNow(): Promise<void> {
  const permissions = await browser.permissions.getAll();
  const matches = (permissions.origins ?? []).filter(p => /^https?:\/\//.test(p) || p === '<all_urls>');
  await browser.scripting.unregisterContentScripts({ ids: ['video-collector'] }).catch(() => {});
  if (matches.length) await browser.scripting.registerContentScripts([{ id: 'video-collector', matches, js: ['content.js'], allFrames: true, persistAcrossSessions: true, runAt: 'document_start' }]);
}
async function inject(tabId: number): Promise<void> {
  const frames = await browser.webNavigation.getAllFrames({ tabId }) ?? [];
  await Promise.allSettled(frames.filter(f => httpUrl(f.url)).map(async f => {
    if (await hasAccess(originPattern(f.url))) {
      await browser.scripting.executeScript({ target: { tabId, frameIds: [f.frameId] }, files: ['content.js'] });
    }
  }));
}
function newSession(url: string): Session { return { token: crypto.randomUUID(), url, suppressed: [], ids: [], frameOrigins: [] }; }
function sanitizeFilters(raw: Filters): Filters {
  const f: Filters = { host: String(raw.host ?? '').slice(0, 500), include: String(raw.include ?? '').slice(0, 500), exclude: String(raw.exclude ?? '').slice(0, 500),
    format: ['', 'file', 'hls', 'dash'].includes(raw.format) ? raw.format : '', live: ['', 'live', 'recording'].includes(raw.live) ? raw.live : '', watched: ['', 'yes', 'no'].includes(raw.watched) ? raw.watched : '', durationExclusive: raw.durationExclusive === true };
  for (const k of ['minHeight', 'maxHeight', 'minDuration', 'maxDuration'] as const) if (typeof raw[k] === 'number' && Number.isFinite(raw[k]) && raw[k]! >= 0) f[k] = raw[k];
  if ((f.minHeight ?? 0) > (f.maxHeight ?? Infinity) || (f.minDuration ?? 0) > (f.maxDuration ?? Infinity)) throw new Error('Минимум не может быть больше максимума');
  return f;
}
browser.runtime.onMessage.addListener((message, sender) => {
  // Page scripts cannot call privileged UI commands through the content-script channel.
  const fromUI = sender.id === browser.runtime.id && !!sender.url?.startsWith(extensionRoot);
  if (message?.type === 'collectorHello' || message?.type === 'discovered') {
    return (async () => {
      await ready;
      const tab = sender.tab?.id; if (tab === undefined || !sessions[tab]) return { ok: false };
      const pageUrl = httpUrl(message.pageUrl); if (!pageUrl || pageUrl !== sender.url) return { ok: false };
      if (!await hasAccess(originPattern(pageUrl))) return { ok: false };
      const liveTab = await browser.tabs.get(tab);
      if (sender.frameId === 0 && pageUrl !== liveTab.url) return { ok: false };
      if (liveTab.url !== sessions[tab].url) {
        await mutate(() => { endSession(tab); sessions[tab] = newSession(liveTab.url || pageUrl); });
      }
      if (message.type === 'collectorHello') return { token: sessions[tab].token };
      if (!current(tab, message.token) || !Array.isArray(message.candidates)) return { ok: false };
      const toResolve: string[] = [];
      await mutate(() => {
        if (!current(tab, message.token)) return;
        const session = sessions[tab];
        if (typeof message.captureDiagnostic === 'string' && message.captureDiagnostic) session.captureDiagnostic = message.captureDiagnostic.slice(0,180);
        const previews = Array.isArray(message.previews) ? message.previews.filter((url: unknown): url is string => typeof url === 'string' && !!httpUrl(url)) : [];
        session.previewUrls = [...new Set([...(session.previewUrls ?? []), ...previews])];
        for (const [id, video] of Object.entries(state.videos)) {
          const hadVariants = video.variants.length > 0;
          video.variants = video.variants.filter(v => !session.previewUrls!.includes(v.url) && !isPreviewUrl(v.url));
          if (hadVariants && !video.variants.length) {
            state.queue = state.queue.filter(x => x !== id);
            if (video.discovery !== 'catalog') delete state.videos[id];
            else { video.status = 'site'; video.reason = 'Превью исключено. Откройте источник для полного видео.'; }
          }
        }
        for (const raw of message.candidates.slice(0, 500)) {
          const candidate = cleanCandidate(raw); if (!candidate) continue;
          candidate.variants = candidate.variants.filter(v => !session.previewUrls!.includes(v.url));
          if (raw.variants?.length && !candidate.variants.length) continue;
          const id = addCandidate(candidate, session);
          if (state.videos[id].status === 'checking') toResolve.push(id);
        }
        for (const frame of (message.frames ?? []).slice(0, 100)) {
          const url = typeof frame === 'string' ? httpUrl(frame, pageUrl) : undefined;
          if (url && !session.frameOrigins.includes(originPattern(url))) session.frameOrigins.push(originPattern(url));
        }
      });
      toResolve.forEach(id => schedule(id, tab, message.token));
      return { ok: true };
    })();
  }
  if (!fromUI) return undefined;
  return handleUI(message).catch(error => ({ error: error instanceof Error ? error.message : String(error) }));
});

async function handleUI(message: { type: string; [key: string]: any }): Promise<unknown> {
  await ready;
  switch (message.type) {
    case 'getState': return { state, sessions };
    case 'start': {
      const tab = await browser.tabs.get(message.tabId);
      if (tab.id === undefined || !httpUrl(tab.url)) throw new Error('Откройте обычную HTTP/HTTPS-страницу');
      if (!await hasAccess(originPattern(tab.url!))) throw new Error('Доступ к странице не предоставлен');
      await mutate(() => { sessions[tab.id!] = {...newSession(tab.url!),vkForeground:message.vkForeground === true}; state.dismissed = []; });
      await syncScripts(); await inject(tab.id);
      // If inject hit a timing gap (executeScript race with old instance), tell any
      // surviving content script to scan immediately with the new session token.
      await browser.tabs.sendMessage(tab.id!, { type: 'scanNow' }).catch(() => {});
      return { ok: true };
    }
    case 'stop': await mutate(() => { endSession(message.tabId); }); return { ok: true };
    case 'filters': await mutate(() => { state.filters = sanitizeFilters(message.filters); }); return { ok: true };
    case 'quickFilters': await mutate(() => {
      state.filters = quickFilters(sanitizeFilters(message.filters));
      state.queue = state.queue.filter(id => matches(state.videos[id], state.filters) === 'match');
      for (const id of state.queue) state.videos[id].selectedVariant = variantKey(bestVariant(state.videos[id], state.filters)!);
      const suppressed = Object.values(sessions).flatMap(s => s.suppressed);
      for (const video of Object.values(state.videos).sort((a, b) => a.addedAt - b.addedAt)) enqueue(state, video, suppressed);
    }); return { ok: true };
    case 'clearQueue': await mutate(() => {
      for (const check of runningChecks.values()) check.controller.abort();
      runningChecks.clear();
      state.videos = {}; state.queue = []; state.dismissed = [];
      for (const tabId of Object.keys(sessions)) endSession(Number(tabId));
    }); activeDownloads.clear(); return { ok: true };
    case 'reapply': await mutate(() => {
      const removed = state.queue.filter(id => matches(state.videos[id], state.filters) !== 'match');
      for (const session of Object.values(sessions)) session.suppressed = [...new Set([...session.suppressed, ...removed])];
      state.queue = state.queue.filter(id => !removed.includes(id));
      for (const id of state.queue) state.videos[id].selectedVariant = variantKey(bestVariant(state.videos[id], state.filters)!);
    }); return { ok: true };
    case 'remove': await mutate(() => {
      state.queue = state.queue.filter(id => id !== message.id);
      state.dismissed = [...new Set([...(state.dismissed ?? []), message.id])];
      for (const session of Object.values(sessions)) if (!session.suppressed.includes(message.id)) session.suppressed.push(message.id);
    }); return { ok: true };
    case 'add': await mutate(() => {
      const video = state.videos[message.id]; if (!video || matches(video, state.filters) !== 'match') throw new Error('Видео ещё не прошло проверку или не подходит по фильтрам');
      state.dismissed = state.dismissed?.filter(id => id !== video.id);
      for (const session of Object.values(sessions)) session.suppressed = session.suppressed.filter(id => id !== video.id);
      enqueue(state, video);
    }); return { ok: true };
    case 'reorder': await mutate(() => {
      const ids = message.ids as string[];
      if (!Array.isArray(ids) || new Set(ids).size !== state.queue.length || ids.length !== state.queue.length || ids.some(id => !state.queue.includes(id))) throw new Error('Очередь изменилась. Повторите действие.');
      state.queue = ids;
    }); return { ok: true };
    case 'retry': {
      const video = state.videos[message.id]; if (!video) return { ok: false };
      autoRetryState.delete(message.id); // Reset auto-retry count on manual retry.
      await mutate(() => { video.status = 'checking'; video.reason = undefined; video.requiredOrigins = [];
        if (message.refresh) video.variants = [];
      });
      schedule(video.id, undefined, undefined, message.allowBrowser === true, message.vkForeground === true); return { ok: true };
    }
    case 'permissionsChanged': {
      await refreshBroadAccess();
      await syncScripts();
      await Promise.allSettled(Object.keys(sessions).map(id => inject(Number(id))));
      const ids = Object.values(state.videos).filter(v => v.requiredOrigins.length).map(v => v.id);
      await mutate(() => { for (const id of ids) state.videos[id].status = 'checking'; });
      ids.forEach(id => {
        const owner=Object.entries(sessions).find(([,session])=>session.ids.includes(id));
        if (owner) schedule(id,Number(owner[0]),owner[1].token);
        else schedule(id);
      }); return { ok: true };
    }
    case 'progress': await mutate(() => {
      const v = state.videos[message.id]; if (!v) return;
      if (Number.isFinite(message.position)) v.position = Math.max(0, message.position);
      if (message.watched === true) v.watched = true;
    }); return { ok: true };
    case 'playbackOptions': await mutate(() => {
      state.repeat = message.repeat === true; state.shuffle = message.shuffle === true;
      if (typeof message.autoplay === 'boolean') state.autoplay = message.autoplay;
    }); return { ok: true };
    case 'setDedupe': await mutate(() => { state.dedupe = !!message.dedupe; }); return { ok: true };
    case 'selectVariant': await mutate(() => {
      const v = state.videos[message.id]; if (v?.variants.some(x => variantKey(x) === message.key)) v.selectedVariant = message.key;
    }); return { ok: true };
    case 'nativeDownload': {
      try { return { ok: true, url: (await ensureDownload(String(message.url || ''))).url }; }
      catch (error) { return { ok: false, error: error instanceof Error ? error.message : String(error) }; }
    }
    case 'nativeCleanup': nativeCleanup(message.id || undefined); activeDownloads.clear(); return { ok: true };
    case 'nativeStatus': try { return { ok: true, ...(await nativeStatus()) }; } catch (error) { return { ok: true, available: false, error: error instanceof Error ? error.message : String(error) }; }
    case 'proxyGet': try { return { ok: true, proxy: await nativeGetProxy() }; } catch (error) { return { ok: true, proxy: '', error: error instanceof Error ? error.message : String(error) }; }
    case 'proxySet': try { await nativeSetProxy(String(message.proxy ?? '')); return { ok: true }; } catch (error) { throw new Error(error instanceof Error ? error.message : String(error)); }
    case 'cdnFetch': {
      const cdnUrl = String(message.url ?? '');
      if (!httpUrl(cdnUrl)) throw new Error('Неверный URL для CDN прокси');
      const cdnResp = await fetch(cdnUrl, { credentials: 'omit', referrer: 'https://www.pornhub.com/' });
      if (!cdnResp.ok && cdnResp.status !== 206) throw new Error(`HTTP ${cdnResp.status}`);
      const cdnCt = cdnResp.headers.get('content-type') ?? '';
      const cdnFinalUrl = cdnResp.url;
      if (cdnCt.includes('mpegurl') || cdnCt.includes('text') || /\.m3u8(\?|$)/i.test(cdnUrl)) {
        return { ok: true, kind: 'text', text: await cdnResp.text(), url: cdnFinalUrl, status: cdnResp.status };
      }
      return { ok: true, kind: 'buffer', buffer: await cdnResp.arrayBuffer(), url: cdnFinalUrl, status: cdnResp.status };
    }
    default: throw new Error('Неизвестная команда');
  }
}

browser.action.onClicked.addListener(() => { void browser.sidebarAction.open(); });
browser.tabs.onRemoved.addListener(tab => { void mutate(() => { endSession(tab); }); });
browser.tabs.onUpdated.addListener((tab, change) => {
  if (!change.url) return;
  void mutate(() => { if (sessions[tab] && sessions[tab].url !== change.url) { endSession(tab); sessions[tab] = newSession(change.url!); } });
});
browser.runtime.onStartup.addListener(() => { void mutate(() => { sessions = {}; }); });
browser.permissions.onAdded.addListener(() => { void syncScripts(); });
browser.permissions.onRemoved.addListener(() => { void syncScripts(); });
browser.webRequest.onBeforeRequest.addListener(details => {
  const session = sessions[details.tabId];
  if (session) requestSessions.set(details.requestId, { tab: details.tabId, token: session.token });
}, { urls: ['http://*/*', 'https://*/*'] });
browser.webRequest.onCompleted.addListener(details => { requestSessions.delete(details.requestId); }, { urls: ['http://*/*', 'https://*/*'] });
browser.webRequest.onErrorOccurred.addListener(details => { requestSessions.delete(details.requestId); }, { urls: ['http://*/*', 'https://*/*'] });
browser.webRequest.onHeadersReceived.addListener(details => {
  const requestSession = requestSessions.get(details.requestId);
  void (async () => {
    await ready;
    const session = sessions[details.tabId]; if (!session || details.statusCode >= 400) return;
    if (!requestSession || requestSession.token !== session.token) return;
    const url = httpUrl(details.url); if (!url) return;
    if (isPreviewUrl(url) || session.previewUrls?.includes(url) || isVimeoChildManifest(url)) return;
    const mime = details.responseHeaders?.find(h => h.name.toLowerCase() === 'content-type')?.value || '';
    const format = mediaFormat(url, mime); if (!format) return;
    // MP4 fetched by JS is often a DASH/HLS fragment, not an independent video.
    if (format === 'file' && details.type !== 'media' && !Object.values(state.videos).some(v => v.variants.some(x => x.url === url))) return;
    // Segmented DASH MP4 initialization/media requests are not standalone videos.
    if (format === 'file' && /(?:[?&](?:range|bytestart|byteend)=|(?:^|\/)(?:segment|chunk|init)[-_\d.])/i.test(url)) return;
    const page = httpUrl(details.documentUrl) || session.url;
    // Search-page media requests are thumbnails unless a source has already verified them.
    if (isYandexVideo(page) && !Object.values(state.videos).some(v => v.variants.some(x => x.url === url))) return;
    let id = '';
    await mutate(() => {
      if (!current(details.tabId, session.token)) return;
      id = addCandidate({ sourceUrl: page, title: 'Видео со страницы', variants: [{ url, format }] }, session);
    });
    if (id && state.videos[id].status === 'checking') schedule(id, details.tabId, session.token);
  })().catch(console.error);
}, { urls: ['http://*/*', 'https://*/*'] }, ['responseHeaders']);

// phncdn.com (PornHub CDN) requires Referer: pornhub.com and drops connections from
// non-pornhub origins (e.g. moz-extension://). We fix both at the webRequest layer:
// onBeforeSendHeaders — strip Origin (prevents CDN from seeing moz-extension:// origin)
//                       and set Referer: pornhub.com.
// onHeadersReceived  — inject Access-Control-Allow-Origin: * so extension-page CORS passes.
browser.webRequest.onBeforeSendHeaders.addListener(
  (details) => {
    const headers = (details.requestHeaders ?? []).filter(h => {
      const n = h.name.toLowerCase(); return n !== 'referer' && n !== 'origin';
    });
    headers.push({ name: 'Referer', value: 'https://www.pornhub.com/' });
    return { requestHeaders: headers };
  },
  { urls: ['https://*.phncdn.com/*', 'http://*.phncdn.com/*'] },
  ['blocking', 'requestHeaders']
);
browser.webRequest.onHeadersReceived.addListener(
  (details) => {
    const headers = (details.responseHeaders ?? []).filter(
      h => h.name.toLowerCase() !== 'access-control-allow-origin'
    );
    headers.push({ name: 'Access-Control-Allow-Origin', value: '*' });
    return { responseHeaders: headers };
  },
  { urls: ['https://*.phncdn.com/*', 'http://*.phncdn.com/*'] },
  ['blocking', 'responseHeaders']
);
