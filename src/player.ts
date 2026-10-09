import './style.css';
import Hls, { type Loader, type LoaderContext, type LoaderStats, type LoaderConfiguration, type LoaderCallbacks } from 'hls.js';
import { MediaPlayer, type MediaPlayerClass } from 'dashjs';
import { dedupeQueue, formatTime } from './core';
import { emptyState, variantKey, type Video, type Variant } from './model';
import { $, element, button, getState, send, notify, notifyError, link } from './ui';

// Proxies phncdn.com (PornHub CDN) requests through the background page.
// Extension pages cannot set cross-origin Referer; background fetch() can.
class PhncdnLoader {
  stats = {
    aborted: false, loaded: 0, retry: 0, total: 0, chunkCount: 0, bwEstimate: 0,
    loading: { start: 0, first: 0, end: 0 }, parsing: { start: 0, end: 0 }, buffering: { start: 0, first: 0, end: 0 },
  } as LoaderStats;
  private aborted = false;
  private tmr: ReturnType<typeof setTimeout> | undefined;

  load(context: LoaderContext, config: LoaderConfiguration, callbacks: LoaderCallbacks<LoaderContext>): void {
    this.stats.loading.start = performance.now();
    if (config.timeout) this.tmr = setTimeout(() => {
      this.aborted = true; callbacks.onTimeout(this.stats, context, null!);
    }, config.timeout);
    void browser.runtime.sendMessage({ type: 'cdnFetch', url: context.url }).then((res: {
      kind: string; text?: string; buffer?: ArrayBuffer; url: string;
    }) => {
      if (this.aborted) return;
      clearTimeout(this.tmr);
      this.stats.loading.first = this.stats.loading.end = performance.now();
      const data: string | ArrayBuffer = res.kind === 'text' ? res.text! : res.buffer!;
      this.stats.loaded = this.stats.total = typeof data === 'string' ? data.length : data.byteLength;
      callbacks.onSuccess({ data, url: res.url }, this.stats, context, null!);
    }).catch((err: Error) => {
      if (this.aborted) return;
      clearTimeout(this.tmr);
      callbacks.onError({ code: 0, text: String(err) }, context, null!, null!);
    });
  }
  abort(): void { this.aborted = true; this.stats.aborted = true; clearTimeout(this.tmr); }
  destroy(): void { this.abort(); }
}

document.body.classList.add('player-page');
$('#app').innerHTML = `
  <header><div class="eyebrow">ВИДЕООЧЕРЕДЬ · PLAYER</div><div class="section-heading"><h1>Ваш следующий кадр<span class="brand-dot"></span></h1><span class="badge">Локальный плейлист</span></div></header>
  <main class="player-layout"><section class="player-stage">
    <div class="player-current"><h1 id="title">Выберите видео из очереди</h1><div id="source" class="muted">Добавьте ролики через боковую панель расширения.</div></div>
    <video id="video" controls playsinline preload="metadata"></video>
    <div id="embed" class="embed" hidden></div>
    <div class="player-toolbar"><button id="previous" title="Предыдущее видео">←</button><button id="play" class="primary">▶ Смотреть</button><button id="next" title="Следующее видео">→</button>
      <label>Качество <select id="quality" aria-label="Качество"></select></label>
      <label>Скорость <select id="speed"><option value="0.5">0.5×</option><option value="0.75">0.75×</option><option value="1" selected>1×</option><option value="1.25">1.25×</option><option value="1.5">1.5×</option><option value="2">2×</option></select></label>
      <label><input id="repeat" type="checkbox"> Повтор</label><label><input id="shuffle" type="checkbox"> Перемешать</label><label><input id="autoplay" type="checkbox" checked> Автопереход</label>
    </div><p id="playback-status" class="player-status" role="status"></p><div id="access"></div>
    <details class="debug" id="debug"><summary>Диагностика / логи</summary><pre id="log" class="log"></pre></details>
    <button id="test-link" class="text-button">Открыть поток в новой вкладке (проверка ссылки)</button>
    <p class="hint">Прямые ссылки могут истекать. При ошибке источник проверяется один раз, затем очередь продолжает воспроизведение. Громкость, перемотка, субтитры и полный экран — в элементах управления видео.</p>
  </section><aside class="player-aside"><div class="section-heading"><h2>Далее в очереди</h2><span id="count" class="count"></span></div><div id="playlist"></div></aside></main>
  <footer><p id="notice" role="status" aria-live="polite"></p></footer>`;

document.querySelector<HTMLElement>('.eyebrow')!.textContent = `ВИДЕООЧЕРЕДЬ · PLAYER · v${browser.runtime.getManifest().version}`;

const video = $<HTMLVideoElement>('#video');
let state = emptyState(); let currentId: string | undefined;
let hls: Hls | undefined; let dash: MediaPlayerClass | undefined;
let loadGeneration = 0; let started = false; let handlingError = false;
const retried = new Set<string>(); const failed = new Set<string>();
const history: string[] = []; let shuffledRemaining: string[] = [];
let currentVariant: Variant | undefined; let lastSaved = 0;
let metadataTimeout: ReturnType<typeof setTimeout> | undefined;
let cleaning = false;
function logLine(text: string): void {
  const el = $('#log');
  el.textContent += (el.textContent ? '\n' : '') + text;
  el.scrollTop = el.scrollHeight;
}

function effectiveQueue(): string[] {
  return state.dedupe ? dedupeQueue(state.queue, state.videos) : state.queue;
}
async function refresh(): Promise<void> {
  const data = await getState(); state = data.state;
  $<HTMLInputElement>('#repeat').checked = state.repeat;
  $<HTMLInputElement>('#shuffle').checked = state.shuffle;
  $<HTMLInputElement>('#autoplay').checked = state.autoplay;
  const eq = effectiveQueue();
  $('#count').textContent = String(eq.length);
  const list = $('#playlist'); list.replaceChildren();
  for (const id of eq) {
    const v = state.videos[id];
    const item = button(v.title, () => load(id, true), `playlist-item${id === currentId ? ' active' : ''}`);
    item.append(element('small', `${formatTime(v.duration)} · ${new URL(v.sourceUrl).hostname}${v.watched ? ' · Просмотрено' : ''}`));
    list.append(item);
  }
  if (!eq.length) list.append(element('p', 'Пока пусто. Включите сбор в боковой панели.', 'empty'));
}
function showEmbed(url: string): void {
  const container = $('#embed'); container.replaceChildren();
  const frame = element('iframe');
  // Match YouTube's official "Share → Embed" markup exactly (minus the si token).
  frame.src = url;
  frame.allow = 'accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share';
  frame.allowFullscreen = true;
  frame.referrerPolicy = 'strict-origin-when-cross-origin';
  frame.style.border = '0';
  frame.title = 'YouTube';
  container.append(frame);
  container.hidden = false; video.hidden = true;
}
function hideEmbed(): void {
  const container = $('#embed'); container.hidden = true; container.replaceChildren();
  video.hidden = false;
}
function cleanup(): void {
  cleaning = true; clearTimeout(metadataTimeout);
  video.onloadedmetadata = null; video.onerror = null;
  hls?.destroy(); hls = undefined; dash?.reset(); dash = undefined;
  video.pause(); video.removeAttribute('src'); video.load();
  hideEmbed();
  cleaning = false;
}
async function save(watched = false): Promise<void> {
  if (cleaning) return;
  watched = watched || video.ended;
  if (currentId && Number.isFinite(video.currentTime)) await send('progress', { id: currentId, position: watched ? 0 : video.currentTime, watched });
}
function renderQuality(item: Video): void {
  const select = $<HTMLSelectElement>('#quality'); select.replaceChildren();
  for (const v of item.variants) {
    const option = element('option', `${v.height ? `${v.height}p` : 'Исходное'} · ${v.format.toUpperCase()}${v.bitrate ? ` · ${Math.round(v.bitrate / 1000)} кбит/с` : ''}`);
    option.value = variantKey(v); option.selected = variantKey(v) === variantKey(currentVariant!); select.append(option);
  }
}
async function load(id: string, autoplay: boolean, resume?: number): Promise<void> {
  await save();
  const generation = ++loadGeneration; cleanup(); handlingError = false;
  const item = state.videos[id]; if (!item) return;
  currentId = id; started = autoplay || started;
  currentVariant = item.variants.find(v => variantKey(v) === item.selectedVariant) ?? item.variants[0];
  $('#title').textContent = item.title; $('#source').replaceChildren(link(item.sourceUrl, new URL(item.sourceUrl).hostname));
  $('#access').replaceChildren(); $('#playback-status').textContent = 'Подключаем источник…';
  $('#log').textContent = '';
  logLine(`id: ${item.id}`);
  logLine(`source: ${item.sourceUrl}`);
  logLine(`status: ${item.status}`);
  logLine(`duration: ${formatTime(item.duration)}`);
  logLine(`variants: ${item.variants.map(v => `${v.format}:${v.url}`).join('\n') || '(нет)'}`);
  if (item.reason) logLine(`reason: ${item.reason}`);
  if (item.requiredOrigins?.length) logLine(`requiredOrigins: ${item.requiredOrigins.join(', ')}`);
  if (!currentVariant) { await fail('У ролика нет доступного потока', generation); return; }
  logLine(`chosen: ${currentVariant.format}:${currentVariant.url}`);
  if (currentVariant.format === 'file' && /(^|\.)googlevideo\.com$/.test(new URL(currentVariant.url).hostname)) {
    logLine('probe googlevideo (range fetch)…');
    for (const [label, init] of [
      ['range', { method: 'GET', credentials: 'omit', headers: { Range: 'bytes=0-0' }, referrer: 'https://www.youtube.com/' }],
      ['no-range', { method: 'GET', credentials: 'omit', referrer: 'https://www.youtube.com/' }],
    ] as [string, RequestInit][]) {
      void fetch(currentVariant.url, init).then(async response => {
        const body = await response.text().catch(() => '');
        logLine(`probe ${label}: HTTP ${response.status} (${response.headers.get('content-type') || '?'}) body: ${body.slice(0, 160) || '(empty)'}`);
      }).catch((error: unknown) => logLine(`probe ${label}: error ${error instanceof Error ? error.message : String(error)}`));
    }
  }
  if (currentVariant.format === 'youtube') {
    showEmbed(currentVariant.url);
    logLine('embed: показан iframe YouTube');
    $('#playback-status').textContent = 'YouTube встроен — управление в его собственном плеере.';
    await refresh();
    return;
  }
  if (currentVariant.format === 'native') {
    $('#playback-status').textContent = 'Скачивание YouTube через yt-dlp…';
    logLine(`native: download ${currentVariant.url}`);
    try {
      const result = await send<{ ok: boolean; url?: string }>('nativeDownload', { url: currentVariant.url });
      if (generation !== loadGeneration) return;
      if (!result?.ok || !result.url) throw new Error('пустой ответ хоста');
      currentVariant = { ...currentVariant, url: result.url, format: 'file' };
      logLine(`native: готово -> ${result.url}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logLine(`native: ошибка: ${message}`);
      await fail(`Загрузка YouTube не удалась: ${message}`, generation);
      return;
    }
  }
  renderQuality(item);
  const position = resume ?? (item.watched ? 0 : item.position);
  let loaded = false;
  const readyToPlay = () => {
    if (generation !== loadGeneration || loaded) return; loaded = true;
    clearTimeout(metadataTimeout);
    if (position > 0 && Number.isFinite(video.duration) && position < video.duration - 1) video.currentTime = position;
    video.playbackRate = Number($<HTMLSelectElement>('#speed').value);
    $('#playback-status').textContent = item.live ? 'Прямой эфир' : 'Готово к просмотру';
    if (autoplay) void video.play().catch(error => {
      if (error instanceof DOMException && error.name === 'NotAllowedError') notify('Нажмите ▶ Смотреть: Firefox ожидает действие пользователя.');
      else if (generation === loadGeneration) void fail('Не удалось начать воспроизведение', generation);
    });
  };
  video.onloadedmetadata = readyToPlay;
  metadataTimeout = setTimeout(() => { void fail('Источник не ответил за 25 секунд', generation); }, 25000);
  video.onerror = () => { void fail(`Ошибка загрузки видео (code ${video.error?.code ?? '?'}${video.error?.message ? ': ' + video.error.message : ''})`, generation); };
  if (currentVariant.format === 'hls' && Hls.isSupported()) {
    const usePhncdnProxy = (() => { try { return /(^|\.)phncdn\.com$/.test(new URL(currentVariant.url).hostname); } catch { return false; } })();
    hls = new Hls({
      enableWorker: false, autoStartLoad: true,
      ...(usePhncdnProxy ? { loader: PhncdnLoader as unknown as typeof Hls.DefaultConfig.loader } : {}),
    });
    const instance = hls;
    instance.on(Hls.Events.MANIFEST_PARSED, () => {
      if (generation !== loadGeneration) return;
      if (currentVariant?.height) {
        let level = instance.levels.findIndex(l => l.height === currentVariant?.height && (!currentVariant?.bitrate || l.bitrate === currentVariant.bitrate));
        if (level < 0) level = instance.levels.findIndex(l => l.height === currentVariant?.height);
        if (level >= 0) instance.currentLevel = level;
        else void fail('Выбранное качество HLS больше недоступно', generation);
      }
    });
    instance.on(Hls.Events.ERROR, (_event, data) => { if (data.fatal) void fail(`HLS: ${data.details}`, generation); });
    instance.loadSource(currentVariant.url); instance.attachMedia(video);
  } else if (currentVariant.format === 'dash') {
    dash = MediaPlayer().create(); const instance = dash;
    instance.on(MediaPlayer.events.ERROR, () => { void fail('DASH: поток недоступен или не поддерживается', generation); });
    instance.on(MediaPlayer.events.STREAM_INITIALIZED, () => {
      if (generation !== loadGeneration || !currentVariant?.height) return;
      const representations = instance.getRepresentationsByType('video');
      let actual = representations.findIndex(r => r.height === currentVariant?.height && (!currentVariant?.bitrate || r.bandwidth === currentVariant.bitrate));
      if (actual < 0) actual = representations.findIndex(r => r.height === currentVariant?.height);
      if (actual < 0) { void fail('Выбранное качество DASH больше недоступно', generation); return; }
      instance.updateSettings({ streaming: { abr: { autoSwitchBitrate: { video: false } } } });
      instance.setRepresentationForTypeByIndex('video', actual, true);
    });
    instance.initialize(video, currentVariant.url, false);
  } else video.src = currentVariant.url;
  await refresh();
}
async function fail(reason: string, generation: number): Promise<void> {
  if (generation !== loadGeneration || handlingError || !currentId) return;
  handlingError = true; const id = currentId; const position = video.currentTime;
  if (!retried.has(id)) {
    retried.add(id); $('#playback-status').textContent = `${reason}. Обновляем ссылку…`;
    await send('retry', { id, refresh: true });
    // A bounded wait covers two concurrent metadata probes and a source-page request.
    for (let attempt = 0; attempt < 90; attempt++) {
      await new Promise(resolve => setTimeout(resolve, 1000));
      if (generation !== loadGeneration) return;
      await refresh(); const item = state.videos[id];
      if (item.status === 'checking') continue;
      if (item.status === 'ready' && item.variants.length) { handlingError = false; await load(id, started, position); return; }
      if (item.requiredOrigins.length) {
        $('#access').replaceChildren(button('Разрешить доступ и повторить', async () => {
          const granted = await browser.permissions.request({ origins: item.requiredOrigins });
          if (granted) { retried.delete(id); failed.delete(id); handlingError = false; await fail('Повторная проверка', generation); }
        }, 'primary'));
      }
      reason = item.reason || reason; break;
    }
  }
  failed.add(id); notify(`Пропущено «${state.videos[id]?.title}»: ${reason}`, true);
  logLine(`FAIL: ${reason}`);
  $('#playback-status').textContent = reason; handlingError = false;
  if (state.autoplay) await advance();
  else $('#playback-status').textContent = `${reason}. Автопереход выключен — следующий ролик не запущен.`;
}
async function advance(): Promise<void> {
  const available = effectiveQueue().filter(id => !failed.has(id));
  if (!available.length) { cleanup(); $('#playback-status').textContent = 'Доступных видео больше нет.'; return; }
  if (currentId) history.push(currentId);
  let next: string | undefined;
  if (state.shuffle) {
    shuffledRemaining = shuffledRemaining.filter(id => available.includes(id) && id !== currentId);
    if (!shuffledRemaining.length && (!history.length || state.repeat || history.length === 1)) shuffledRemaining = available.filter(id => id !== currentId || available.length === 1);
    const index = Math.floor(Math.random() * shuffledRemaining.length); next = shuffledRemaining.splice(index, 1)[0];
  } else {
    const eq = effectiveQueue();
    const index = currentId ? eq.indexOf(currentId) : -1;
    next = eq.slice(index + 1).find(id => !failed.has(id));
    if (!next && state.repeat) next = available[0];
  }
  if (next) await load(next, true);
  else { video.pause(); $('#playback-status').textContent = 'Плейлист завершён.'; }
}
$('#test-link').onclick = () => {
  if (currentVariant?.url) { void browser.tabs.create({ url: currentVariant.url }); }
  else notify('Нет активного потока для проверки.');
};
$('#play').onclick = () => {
  started = true;
  if (!currentId) { const eq = effectiveQueue(); if (eq[0]) void load(eq[0], true).catch(notifyError); }
  else if (video.paused) void video.play().catch(notifyError); else video.pause();
};
$('#next').onclick = () => { void advance().catch(notifyError); };
$('#previous').onclick = () => {
  const eq = effectiveQueue();
  const previous = history.pop() ?? eq[Math.max(0, eq.indexOf(currentId || '') - 1)];
  if (previous) void load(previous, true).catch(notifyError);
};
$('#quality').onchange = () => {
  if (!currentId) return;
  const id = currentId; const position = video.currentTime; const playing = !video.paused;
  void send('selectVariant', { id, key: $<HTMLSelectElement>('#quality').value }).then(refresh).then(() => load(id, playing, position)).catch(notifyError);
};
$('#speed').onchange = () => { video.playbackRate = Number($<HTMLSelectElement>('#speed').value); };
for (const name of ['repeat', 'shuffle']) $(`#${name}`).onchange = () => {
  shuffledRemaining = []; history.length = 0;
  void send('playbackOptions', { repeat: $<HTMLInputElement>('#repeat').checked, shuffle: $<HTMLInputElement>('#shuffle').checked }).then(refresh).catch(notifyError);
};
$('#autoplay').onchange = () => {
  void send('playbackOptions', { autoplay: $<HTMLInputElement>('#autoplay').checked }).then(refresh).catch(notifyError);
};
video.addEventListener('ended', () => {
  void save(true).then(() => {
    if (state.autoplay) void advance().catch(notifyError);
    else $('#playback-status').textContent = 'Видео завершено. Автопереход выключен.';
  }).catch(notifyError);
});
video.addEventListener('timeupdate', () => { if (Date.now() - lastSaved > 4000) { lastSaved = Date.now(); void save().catch(notifyError); } });
video.addEventListener('pause', () => { $('#play').textContent = '▶ Смотреть'; void save().catch(notifyError); });
video.addEventListener('play', () => { $('#play').textContent = 'Ⅱ Пауза'; });
window.addEventListener('pagehide', () => { void save(); void send('nativeCleanup', {}).catch(() => {}); });
browser.storage.onChanged.addListener(() => { void refresh().catch(notifyError); });
void refresh().catch(notifyError);
