import './style.css';
import './compact.css';
import { exportPlaylist, formatTime, matches, originPattern, httpUrl } from './core';
import { defaultFilters, emptyState, type Filters, type Session, type Video } from './model';
import { $, element, button, link, getState, send, notify, notifyError } from './ui';
import { quickFilters, qualityPresets, durationPresets, encodeFilter, decodeFilter } from './quick-filters';
import { dzenPageUrl } from './dzen';
import { captureOrigins, vkIdentity } from './capture-policy';

$('#app').innerHTML = `
  <header class="compact-toolbar">
    <button id="collect" class="primary wide">Собирать на этой вкладке</button>
    <div class="field-pair"><button id="clear-queue">Очистить очередь</button><button id="export">Сохранить в плейлист</button></div>
    <label class="hint vk-foreground-option" title="Применяется при следующем запуске сбора. Вкладки VK будут становиться активными."><input id="vk-foreground" type="checkbox"> VK: переключать вкладки при сборе</label>
    <button id="stop-foreground" hidden>Остановить сбор с переключением вкладок</button>
    <div class="site-line"><span id="current-site" class="truncate muted"></span><span id="capture-state" class="badge">Пауза</span></div>
    <div id="frame-access"></div>
  </header>
  <main class="compact-main">
    <section class="surface compact-filters">
      <label class="proxy-label">Прокси для yt-dlp<span class="proxy-row"><input id="proxy-input" type="text" placeholder="http://127.0.0.1:2080" autocomplete="off" spellcheck="false"><button id="proxy-save" type="button">✓</button></span></label>
      <form id="filters">
        <div class="field-pair"><label>Качество<select name="minHeight"><option value="">Любое</option></select></label><label>Длительность<div class="duration-filter"><select name="durationDir"><option value="lt">&lt;</option><option value="gt">&gt;</option></select><select name="durationValue"><option value="">любая</option></select></div></label></div>
        <label>Сайты<input name="host" placeholder="example.org, video.example.com"></label>
        <div class="field-pair"><label>Слова в названии<input name="include" placeholder="Все указанные"></label><label>Слова исключения<input name="exclude" placeholder="Любое из указанных"></label></div>
        <div class="preset-actions"><button id="reset" type="button">Сбросить</button><button id="save-filter" type="button">Сохранить фильтр</button><button id="load-filter" type="button">Загрузить фильтр</button></div>
        <input id="filter-file" type="file" accept=".json,application/json" hidden>
      </form>
    </section>
    <section><div class="list-toolbar"><div role="tablist" aria-label="Список видео"><button id="queue-tab" role="tab" aria-selected="true">Очередь <span id="queue-count" class="count">0</span></button><button id="found-tab" role="tab" aria-selected="false">Найдено <span id="found-count" class="count">0</span></button></div><button id="open-player" class="primary">▶ Плеер</button></div>
      <div id="queue" class="cards" role="tabpanel" aria-labelledby="queue-tab"></div><div id="found" class="cards" role="tabpanel" aria-labelledby="found-tab" hidden></div></section>
  </main><footer><p id="notice" role="status" aria-live="polite">Всё хранится в этом браузере. <span class="muted" id="version"></span></p></footer>`;

$('#version').textContent = `v${browser.runtime.getManifest().version} · id:${browser.runtime.id}`;

for (const height of qualityPresets) {
  const option = element('option', `${height}p и выше`); option.value = String(height);
  $('select[name="minHeight"]').append(option);
}
for (const duration of durationPresets) {
  const option = element('option', duration === 3600 ? '1 ч' : `${duration / 60} м`); option.value = String(duration);
  $('select[name="durationValue"]').append(option);
}
let state = emptyState(); let sessions: Record<number, Session> = {}; let activeTab: browser.tabs.Tab | undefined;
let formLoaded = false; let refreshVersion = 0;
let renderedSignature = '';
let filterTimer: ReturnType<typeof setTimeout>;
const form = $<HTMLFormElement>('#filters');
function populate(f: Filters): void {
  const qf = quickFilters(f);
  for (const [key, value] of Object.entries(qf)) {
    const input = form.elements.namedItem(key) as HTMLInputElement | null;
    if (input) input.value = value === undefined ? '' : String(value);
  }
  const dirEl = form.elements.namedItem('durationDir') as HTMLSelectElement | null;
  const valEl = form.elements.namedItem('durationValue') as HTMLSelectElement | null;
  if (dirEl && valEl) {
    if (qf.minDuration !== undefined) {
      dirEl.value = 'gt'; valEl.value = String(qf.minDuration);
    } else {
      dirEl.value = 'lt'; valEl.value = qf.maxDuration !== undefined ? String(qf.maxDuration) : '';
    }
  }
}
function readFilters(): Filters {
  const values = Object.fromEntries(new FormData(form));
  const durationVal = values.durationValue === '' ? undefined : Number(values.durationValue);
  const isLt = values.durationDir !== 'gt';
  return quickFilters({ minHeight: values.minHeight === '' ? undefined : Number(values.minHeight),
    maxDuration: isLt ? durationVal : undefined, minDuration: !isLt ? durationVal : undefined,
    host: String(values.host || ''), include: String(values.include || ''), exclude: String(values.exclude || '') });
}
async function refresh(): Promise<void> {
  const version = ++refreshVersion;
  const [data, tabs] = await Promise.all([getState(), browser.tabs.query({ active: true, currentWindow: true })]);
  if (version !== refreshVersion) return;
  state = data.state; sessions = data.sessions; activeTab = tabs[0];
  if (!formLoaded) { populate(state.filters); formLoaded = true; }
  const signature = JSON.stringify({ queue: state.queue, filters: state.filters, sessions, tab: activeTab?.id, url: activeTab?.url,
    videos: Object.values(state.videos).map(({ position: _position, ...video }) => video) });
  if (signature !== renderedSignature) { renderedSignature = signature; render(); }
}
async function grant(origins: string[]): Promise<void> {
  const granted = await browser.permissions.request({ origins });
  if (!granted) { notify('Доступ не предоставлен. Ссылка на источник сохранена.'); return; }
  await send('permissionsChanged'); notify('Доступ разрешён. Повторная проверка запущена.'); await refresh();
}
function card(video: Video, inQueue: boolean, index = 0): HTMLElement {
  const node = element('article', undefined, 'video-card'); node.dataset.id = video.id;
  const heading = element('div', undefined, 'card-heading');
  if (inQueue) heading.append(element('span', String(index + 1).padStart(2, '0'), 'order'));
  const info = element('div'); info.append(element('h3', video.title));
  const heights = [...new Set(video.variants.map(v => v.height).filter(Boolean))].sort((a, b) => b! - a!);
  info.append(element('p', `${new URL(video.sourceUrl).hostname} · ${formatTime(video.duration)} · ${heights.length ? `${heights[0]}p` : 'Качество —'}`, 'meta'));
  heading.append(info); node.append(heading);
  const labels = { checking: 'Проверяется', ready: 'Готово', site: 'Нужен плеер сайта', error: 'Ошибка' };
  const match = matches(video, state.filters);
  if (!inQueue) node.append(element('span', video.status === 'ready' && match !== 'match' ? match === 'pending' ? 'Ожидает метаданные' : 'Не подходит по фильтру' : labels[video.status], `badge ${video.status === 'ready' ? 'green' : ''}`));
  const details = element('details'); const summary = element('summary', 'Характеристики'); details.append(summary);
  const descriptions = video.variants.map(v => [v.format.toUpperCase(), v.height ? `${v.width || '?'}×${v.height}` : 'Разрешение неизвестно', v.fps ? `${v.fps} FPS` : '', v.bitrate ? `${Math.round(v.bitrate / 1000)} кбит/с` : '', v.codecs, v.language, v.audio === true ? 'Со звуком' : '', v.subtitles?.length ? `Субтитры: ${v.subtitles.join(', ')}` : '', v.portable ? 'Доступен экспорт' : 'Экспорт не подтверждён'].filter(Boolean).join(' · '));
  // A failed check needs an immediately visible explanation, not a hidden technical detail.
  if (video.reason) {
    const explanation = element('p', video.reason, 'hint');
    if (video.status === 'error' || video.status === 'site') node.append(explanation);
    else details.append(explanation);
  }
  details.append(element('p', descriptions.join('\n') || 'Метаданные пока не получены.', 'hint preserve-lines'));
  const actions = element('div', undefined, 'row card-actions'); actions.append(link(video.sourceUrl));
  if (!inQueue && match === 'match') actions.append(button('+ В очередь', async () => { await send('add', { id: video.id }); await refresh(); }, 'primary'));
  if (video.requiredOrigins.length) actions.append(button('Разрешить проверку', () => grant(video.requiredOrigins), 'primary'));
  else if (!inQueue && video.status !== 'checking') actions.append(button(vkIdentity(video.sourceUrl) ? 'Проверить с переходом' : 'Проверить снова', async () => { await send('retry', { id: video.id, vkForeground:!!vkIdentity(video.sourceUrl) }); await refresh(); }));
  if (!inQueue && video.status !== 'checking' && !video.requiredOrigins.length && dzenPageUrl(video.sourceUrl)) actions.append(button('Проверить через вкладку', async () => { await send('retry', {id:video.id,allowBrowser:true}); await refresh(); }));
  if (inQueue) {
    actions.append(button('× Удалить', async () => { await send('remove', { id: video.id }); await refresh(); }));
    const move = async (offset: number) => { const ids = [...state.queue]; const target = index + offset; if (target < 0 || target >= ids.length) return; [ids[index], ids[target]] = [ids[target], ids[index]]; await send('reorder', { ids }); await refresh(); };
    const up = button('↑', () => move(-1)); up.title = 'Переместить выше'; up.disabled = index === 0;
    const down = button('↓', () => move(1)); down.title = 'Переместить ниже'; down.disabled = index === state.queue.length - 1;
    actions.append(up, down); node.draggable = true;
    node.ondragstart = event => event.dataTransfer?.setData('text/plain', video.id);
    node.ondragover = event => { event.preventDefault(); };
    node.ondrop = event => {
      event.preventDefault(); const id = event.dataTransfer?.getData('text/plain'); if (!id || id === video.id || !state.queue.includes(id)) return;
      const ids = state.queue.filter(x => x !== id); ids.splice(ids.indexOf(video.id), 0, id);
      void send('reorder', { ids }).then(refresh).catch(notifyError);
    };
  }
  node.append(actions, details); return node;
}
function render(): void {
  $<HTMLButtonElement>('#stop-foreground').hidden = !Object.values(sessions).some(session=>session.vkForeground);
  const expanded = new Set([...document.querySelectorAll<HTMLElement>('.video-card')].filter(c => c.querySelector('details')?.open).map(c => c.dataset.id));
  const session = activeTab?.id === undefined ? undefined : sessions[activeTab.id];
  $('#capture-state').textContent = session ? 'Сбор включён' : 'Пауза'; $('#capture-state').classList.toggle('green', !!session);
  let diagnostic = document.querySelector('#capture-diagnostic');
  if (!diagnostic) { diagnostic = element('p',undefined,'hint'); diagnostic.id='capture-diagnostic'; $('#frame-access').before(diagnostic); }
  diagnostic.textContent = session?.captureDiagnostic ?? ''; (diagnostic as HTMLElement).hidden = !diagnostic.textContent;
  $('#current-site').textContent = activeTab?.url && httpUrl(activeTab.url) ? new URL(activeTab.url).hostname : 'Откройте сайт с видео';
  $('#collect').textContent = session ? 'Остановить сбор' : 'Собирать на этой вкладке';
  $<HTMLButtonElement>('#collect').disabled = !httpUrl(activeTab?.url);
  const frameAccess = $('#frame-access'); frameAccess.replaceChildren();
  const origins = [...new Set(Object.values(state.videos).flatMap(v => v.requiredOrigins))];
  if (origins.length) frameAccess.append(button(`Разрешить источники (${origins.length})`, () => grant(origins), 'wide'));
  else if (session?.frameOrigins.length) frameAccess.append(button('Разрешить встроенные плееры', () => grant(session.frameOrigins), 'text-button'));
  $('#queue-count').textContent = String(state.queue.length);
  $('#queue').replaceChildren(...state.queue.map((id, i) => card(state.videos[id], true, i)));
  if (!state.queue.length) $('#queue').append(element('p', 'Здесь появятся видео, прошедшие проверку и фильтры.', 'empty'));
  const others = Object.values(state.videos).filter(v => !state.queue.includes(v.id)).sort((a, b) => b.addedAt - a.addedAt);
  $('#found-count').textContent = String(others.length); $('#found').replaceChildren(...others.map(v => card(v, false)));
  if (!others.length) $('#found').append(element('p', 'Включите сбор на странице. Для Яндекс Видео прокручивайте результаты поиска.', 'empty'));
  for (const card of document.querySelectorAll<HTMLElement>('.video-card')) if (expanded.has(card.dataset.id)) card.querySelector('details')!.open = true;
}
$('#collect').onclick = () => {
  if (activeTab?.id === undefined || !activeTab.url) return;
  const tabId = activeTab.id;
  if (sessions[tabId]) { void send('stop', { tabId }).then(refresh).catch(notifyError); return; }
  // Request starts inside the click handler, preserving Firefox's user gesture.
  void browser.permissions.request({ origins: [...new Set([originPattern(activeTab.url), ...captureOrigins(activeTab.url)])] }).then(async granted => {
    if (!granted) { notify('Для сбора нужен доступ к этой странице.'); return; }
    await send('start', { tabId, vkForeground:$<HTMLInputElement>('#vk-foreground').checked }); await refresh(); notify('Сбор включён. Прокручивайте страницу, чтобы находить новые ролики.');
  }).catch(notifyError);
};
$('#stop-foreground').onclick = () => {
  void Promise.all(Object.entries(sessions).filter(([,session])=>session.vkForeground).map(([id])=>send('stop',{tabId:Number(id)}))).then(refresh).catch(notifyError);
};
async function applyFilters(): Promise<void> {
  clearTimeout(filterTimer); await send('quickFilters', { filters: readFilters() }); await refresh(); notify('Фильтр применён.');
}
form.onsubmit = event => { event.preventDefault(); void applyFilters().catch(notifyError); };
form.oninput = event => { if (event.target instanceof HTMLInputElement && event.target.type !== 'file') { clearTimeout(filterTimer); filterTimer = setTimeout(() => void applyFilters().catch(notifyError), 400); } };
form.onchange = event => { if (event.target instanceof HTMLSelectElement) void applyFilters().catch(notifyError); };
$('#reset').onclick = () => { populate(defaultFilters); void applyFilters().catch(notifyError); };
function download(text: string, filename: string, mime: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: mime })); const a = element('a'); a.href = url; a.download = filename; a.click(); setTimeout(() => URL.revokeObjectURL(url), 30000);
}
$('#save-filter').onclick = () => { download(encodeFilter(readFilters()), 'video-filter.json', 'application/json;charset=utf-8'); notify('Фильтр сохранён в JSON-файл.'); };
$('#load-filter').onclick = () => { $<HTMLInputElement>('#filter-file').click(); };
$<HTMLInputElement>('#filter-file').onchange = async () => {
  const input = $<HTMLInputElement>('#filter-file'); const file = input.files?.[0];
  try { if (file) { if (file.size > 16000) throw new Error('Файл фильтра слишком большой'); const f = decodeFilter(await file.text()); populate(f); await applyFilters(); notify('Фильтр загружен и применён.'); } }
  catch (error) { notifyError(error); } finally { input.value = ''; }
};
$('#clear-queue').onclick = () => { void send('clearQueue').then(async () => { await refresh(); notify('Очередь и найденные видео очищены. Сбор остановлен — нажмите «Собирать» для нового запуска.'); }).catch(notifyError); };
function showList(name: 'queue' | 'found'): void {
  for (const id of ['queue', 'found']) { $(`#${id}`).hidden = id !== name; $(`#${id}-tab`).setAttribute('aria-selected', String(id === name)); }
}
$('#queue-tab').onclick = () => showList('queue'); $('#found-tab').onclick = () => showList('found');
$('#open-player').onclick = () => {
  const url = browser.runtime.getURL('player.html');
  void browser.tabs.query({ url }).then(async tabs => {
    if (tabs.length) {
      // Reuse the existing player tab: reloading it picks up the new build,
      // and stale duplicate players do not accumulate.
      if (tabs[0].id !== undefined) await browser.tabs.reload(tabs[0].id);
      if (tabs[0].id !== undefined) await browser.tabs.update(tabs[0].id, { active: true });
    } else {
      await browser.tabs.create({ url });
    }
  }).catch(notifyError);
};
$('#export').onclick = () => {
  const result = exportPlaylist(state);
  if (!result.included) { notify(`Нет подтверждённых ссылок для VLC. Исключено: ${result.excluded}.`); return; }
  download(result.text, 'video-playlist.m3u8', 'application/vnd.apple.mpegurl;charset=utf-8');
  notify(`Экспортировано: ${result.included}. Исключено: ${result.excluded}. Качество адаптивных потоков VLC выбирает самостоятельно; временные ссылки могут истечь.`);
};
browser.storage.onChanged.addListener(() => { void refresh().catch(notifyError); });
browser.tabs.onActivated.addListener(() => { void refresh().catch(notifyError); });
browser.tabs.onUpdated.addListener((_id, change) => { if (change.url) void refresh().catch(notifyError); });
void refresh().catch(notifyError);
void send<{ available?: boolean; error?: string }>('nativeStatus').then(res => {
  $('#version').textContent += res.available ? ' · yt-dlp: ✓' : ` · yt-dlp: ✗ (${res.error || '?'})`;
}).catch(error => { $('#version').textContent += ` · yt-dlp: ✗ (${error instanceof Error ? error.message : String(error)})`; });

const proxyInput = $<HTMLInputElement>('#proxy-input');
void send<{ ok: boolean; proxy?: string }>('proxyGet').then(res => {
  if (res.proxy !== undefined) proxyInput.value = res.proxy;
}).catch(() => {});
async function saveProxy(): Promise<void> {
  const value = proxyInput.value.trim();
  await send('proxySet', { proxy: value });
  notify(value ? `Прокси сохранён: ${value}` : 'Прокси отключён (прямое подключение).');
}
$('#proxy-save').onclick = () => { void saveProxy().catch(notifyError); };
proxyInput.onkeydown = event => { if (event.key === 'Enter') { event.preventDefault(); void saveProxy().catch(notifyError); } };

const toolbarEl = document.querySelector<HTMLElement>('.compact-toolbar')!;
const updateToolbarHeight = () => document.documentElement.style.setProperty('--toolbar-height', `${toolbarEl.offsetHeight}px`);
new ResizeObserver(updateToolbarHeight).observe(toolbarEl);
updateToolbarHeight();
