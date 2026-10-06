# PROJECT MAP — Видеоочередь

## Обзор

Firefox MV3-расширение. Собирает видео со страниц в локальный плейлист с воспроизведением через встроенный плеер или экспортом в VLC.

**Версия:** 0.11.0  
**Целевой Firefox:** 140+  

---

## Граф зависимостей модулей

```
model.ts          ← чистые типы, никаких зависимостей
  ↑
core.ts           ← model.ts, media-policy.ts
  ↑
capture-policy.ts ← (независимый)
media-policy.ts   ← (независимый)
task-pool.ts      ← (независимый)
ui.ts             ← model.ts
quick-filters.ts  ← model.ts

manifests.ts      ← core.ts
discovery.ts      ← core.ts, model.ts, media-policy.ts

rutube.ts         ← core.ts, model.ts
ok.ts             ← core.ts, model.ts
dzen.ts           ← core.ts, model.ts
vk.ts             ← core.ts, model.ts, capture-policy.ts
vimeo.ts          ← core.ts, model.ts, capture-policy.ts
native.ts         ← (независимый — HTTP-клиент)
youtube.ts        ← core.ts, model.ts, capture-policy.ts

resolver.ts       ← core.ts, model.ts, media-policy.ts, manifests.ts, discovery.ts,
                     rutube.ts, ok.ts, dzen.ts, vk.ts, vimeo.ts, youtube.ts, native.ts, capture-policy.ts

background.ts     ← core.ts, model.ts, resolver.ts, task-pool.ts, media-policy.ts,
                     discovery.ts, quick-filters.ts, dzen.ts, ok.ts, capture-policy.ts, native.ts

content.ts        ← discovery.ts, core.ts, capture-policy.ts, model.ts

sidebar.ts        ← core.ts, model.ts, ui.ts, quick-filters.ts, dzen.ts, capture-policy.ts
                     style.css, compact.css

player.ts         ← core.ts, model.ts, ui.ts
                     hls.js, dashjs
                     style.css
```

---

## Реализация по провайдерам

### Rutube (`src/rutube.ts`)
- Определение: `rutubeOptionsUrl()` — проверяет hostname `rutube.ru`, извлекает 32-символьный ID
- Запрос: `GET https://rutube.ru/api/play/options/{id}/?format=json`
- Парсинг: `rutubeStreams()` — берёт `video_balancer` из JSON
- Разрешения: `https://*.rutube.ru/*`, `https://*.rtbcdn.ru/*`
- Статус: **работает без вкладок**

### OK.ru (`src/ok.ts`)
- Определение: `okPageUrl()` — hostname `ok.ru`, путь `/video/{id}`
- Запрос: `GET https://ok.ru/video/{id}` (HTML страница)
- Парсинг: `okStreams()` — `[data-options]` → `flashvars.metadata` → JSON → `hlsManifestUrl` / `videos[]`
- Разрешения: `https://ok.ru/*`, `https://*.okcdn.ru/*`
- Статус: **работает без вкладок**

### Яндекс.Дзен (`src/dzen.ts`)
- Определение: `dzenPageUrl()` — hostname `dzen.ru`, путь `/video/watch/{24-символьный hex}`
- Парсинг: `dzenStreams()` — JSON-блок `_params` из HTML, поле `ssrData.videoMetaResponse.video.oneVideoStreams`
- Путь 1 (без вкладки): `fetchText(dzenPageUrl)` → `dzenStreams()`
- Путь 2 (фоновая вкладка, fallback): `readDzenPlayer()` → `inspectDzenPlayer()` — открывает вкладку `active: false`, ждёт загрузки, читает `<script>` с `videoMetaResponse`
- Разрешения: `https://dzen.ru/*`, `https://*.okcdn.ru/*`
- **Задача**: путь 1 иногда не работает (JS-рендер); путь 2 открывает вкладку — нужно реализовать без физического открытия вкладки

### VK / VKVideo (`src/vk.ts`)
- Определение: `vkIdentity()` — hostname `vkvideo.ru` / `vk.com`, путь `/video-{id}` или `/clip{id}`
- **Путь 1 (API, без вкладки)**: `readVkStreams()` — POST `https://vk.com/al_video.php` с `act=show`
  - Парсинг `vkStreams()`: обходит JSON `payload[1]` — ищет URL в строках
- **Путь 2 (фоновая вкладка)**: `readVkPlayer()` — открывает вкладку `active: false`, слушает `webRequest.onHeadersReceived` на `*.okcdn.ru`, триггерит `video.play()`, читает `performance.getEntriesByType`
- Флаг `vkForeground`: вкладка становится активной (для случаев с авторизацией)
- Разрешения: `https://*.vkvideo.ru/*`, `https://*.vk.com/*`, `https://*.okcdn.ru/*`, `https://*.vkuser.net/*`

### YouTube (`src/youtube.ts`, `src/native.ts`)
- Определение: `youtubeIdentity()` — youtube.com, youtu.be, youtube-nocookie.com, /shorts/, /embed/, /live/, /v/
- **Путь 1 (приоритет, yt-dlp мост)**: `nativePing()` → `nativeDownload()` — POST `http://127.0.0.1:8765/download`; вариант `{format: 'native'}` заменяется на `{format: 'file', url: 'http://127.0.0.1:8765/{id}.mp4'}` после скачивания
- **Путь 2 (youtubei.js + PoToken)**: `readYoutubePlayer()` → открывает фоновую вкладку, внедряет скрипт в MAIN world, дешифрует `n`/`sig`, генерирует PoToken через `bgutils-js`
- **Путь 3 (fallback)**: YouTube embed `https://www.youtube.com/embed/{id}` — формат `youtube`, воспроизводится как iframe

### Vimeo (`src/vimeo.ts`)
- Определение: `vimeoIdentity()` — vimeo.com, player.vimeo.com
- **Путь 1 (без вкладки)**: `vimeoConfigUrl()` → GET `https://player.vimeo.com/video/{id}/config` с `Referer: https://vimeo.com/`
  - Парсинг `vimeoStreams()`: `request.files.hls.cdns` → HLS, `request.files.dash.cdns` → DASH, `request.files.progressive[]` → MP4
- **Путь 2 (фоновая вкладка, fallback)**: `readVimeoPlayer()` — открывает `player.vimeo.com/video/{id}?autoplay=1&muted=1` (embed-плеер, без Cloudflare), слушает `webRequest.onHeadersReceived` на `*.vimeocdn.com`
- `vimeoResourceManifests()` — фильтр `/playlist.m3u8`, `master.m3u8`, `.mpd` от vimeocdn.com
- `isVimeoChildManifest()` — исключает дочерние манифесты `/media.m3u8`
- Разрешения: `https://*.vimeo.com/*`, `https://*.vimeocdn.com/*`
- Статус: **Путь 1 — без вкладок** (для публичных видео); **Путь 2 — фоновая вкладка** (при 403)

### Яндекс.Видео (`src/discovery.ts` → `discoverYandex()`)
- Определение: `isYandexVideo()` — yandex.ru/video, ya.ru/video и аналоги
- Механизм: парсинг DOM-карточек `[data-video]`, `.serp-item`, `.VideoCard` и т.д.
- Возвращает `Candidate` с `discovery: 'catalog'` и пустым `variants[]` — URL страницы источника, проверяется отдельно

### Общий механизм (`src/discovery.ts`)
- `discoverGeneric()`: `<video>` теги, `<a href>` с медиа-URL, `og:video` meta, JSON-LD `VideoObject`, `discoverEmbedded()`
- `discoverEmbedded()`: парсинг `<script>` JSON без eval — ключи `contentUrl`, `hlsUrl`, `dashUrl`, `sources`, `files`

---

## Поток данных

```
background.ts → tabs.sendMessage('scanNow') → content.ts  (при старте сессии)
  └─ немедленный scan() без ожидания 2-сек. интервала

Страница → content.ts
  ├─ discoverYandex() / discoverGeneric()     DOM-кандидаты
  ├─ inspectVkResources()                     CDN-пробы (HEAD)
  └─ sendMessage('discovered', candidates[])
       ↓
background.ts → onMessage('discovered')
  ├─ cleanCandidate()                         Санитизация
  ├─ addCandidate() → mergeCandidate()        Дедупликация и merge
  ├─ schedule(id, tab, token)                 Постановка в очередь проверки
  └─ TaskPool (2 параллельных, browserCheckPool=1 для вкладочных)
       ↓
resolver.ts → resolveVideo()
  ├─ rutubeStreams / okStreams / dzenStreams    HTTP-парсинг
  ├─ readVkStreams / readVkPlayer              VK API / вкладка
  ├─ vimeoStreams / readVimeoPlayer           Vimeo config API / embed-вкладка
  ├─ readYoutubePlayer / nativeDownload       YouTube / yt-dlp
  └─ resolveStreams() → probeFile() / parseHls() / parseDash()
       ↓
background.ts → mutate() → state.videos[id] обновляется
  └─ enqueue() → state.queue.push(id) если matches() === 'match'
       ↓
sidebar.ts ← getState() (polling при каждом refresh)
player.ts  ← getState() (при старте и после действий)
```

---

## Состояние (State)

```typescript
State {
  version: 1,
  videos: Record<id, Video>,   // все найденные видео (очищается при clearQueue)
  queue: string[],              // упорядоченный список id для воспроизведения
  filters: Filters,             // активные фильтры
  repeat, shuffle, autoplay,
  dismissed: string[]           // исключённые id; очищается при clearQueue (полный сброс)
}

Video {
  id, sourceUrl, title, thumbnail, duration, variants: Variant[],
  status: 'checking'|'ready'|'site'|'error',
  requiredOrigins: string[],    // нужны доп. разрешения
  selectedVariant,              // key активного варианта
  position, watched, addedAt
}
```

Хранение: `browser.storage.local` (State) + `browser.storage.session` (Sessions).

---

## Плеер (`src/player.ts`)

Поддерживает форматы:
- `file` — нативный `<video src>`
- `hls` — hls.js
- `dash` — dash.js (MediaPlayer)
- `youtube` — `<iframe>` embed
- `native` — ожидает замены на `file` после скачивания

Fallback: при ошибке воспроизведения — retry через `resolver.ts`, затем переход к следующему.

### Layout страницы плеера (после скролла за шапку)

```
<header>           ← прокручивается обычно
<main.player-layout>  ← position:sticky; top:0; height:100vh — прилипает
  ┌──────────────────────────┬──────────────────┐
  │  .player-stage           │  .player-aside   │
  │  overflow-y:auto         │  flex-column     │
  │  ┌────────────────────┐  │  overflow:hidden │
  │  │ .player-current    │  │  ┌────────────┐ │
  │  │ sticky top:0       │  │  │.section-   │ │
  │  │ (title прилипает)  │  │  │heading     │ │
  │  ├────────────────────┤  │  ├────────────┤ │
  │  │ <video>            │  │  │ #playlist  │ │
  │  │ .player-toolbar    │  │  │ overflow-y │ │
  │  │ ... (скроллятся)   │  │  │ :auto      │ │
  │  └────────────────────┘  │  └────────────┘ │
  └──────────────────────────┴──────────────────┘
```

---

## Нативный хост

```
native-host/                         Исходники (в репозитории)
├── video_host.py          исходник HTTP-сервера (127.0.0.1:8765)
│                           GET /status, POST /download, POST /cleanup, GET /<file>
│                           GET /proxy, POST /proxy  — чтение/запись прокси в config.json
├── video_host.bat         bat-обёртка запуска через Python
├── videoqueue_host.json   Native Messaging manifest (для реестра; NM не используется)
├── register.ps1           Регистрация пути exe в реестре HKCU
├── build/                 PyInstaller --onefile (gitignored)
└── build-onedir/          PyInstaller --onedir (gitignored)

C:\Users\Admin\AppData\Roaming\videoqueue-host\   Развёрнутый хост (production)
├── video_host.exe         скомпилированный EXE (PyInstaller)
├── yt-dlp.exe             автономный yt-dlp
├── config.json            настройки прокси {"proxy": "..."} — редактируется через UI
└── _internal/             зависимости PyInstaller onedir
```

**Планировщик Windows** «VideoQueue yt-dlp bridge»:
- Триггер: вход в систему
- Действие: `C:\Users\Admin\AppData\Roaming\videoqueue-host\video_host.exe`
- Статус: Ready

**Важно**: мост работает по HTTP (`127.0.0.1:8765`), не через Native Messaging API Firefox.  
`videoqueue_host.json` зарегистрирован в реестре как заглушка (для совместимости), но не используется.

**Python на машине**: `python.exe` из Microsoft Store — заглушка, не работает.  
Рабочий Python 3.12.14: `C:\Users\Admin\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\python\python.exe`  
Используется только для ручного запуска скрипта — EXE в production Python не требует.

---

## Тесты

```
tests/
├── core.test.ts           mergeCandidate, matches, enqueue, exportPlaylist
├── discovery.test.ts      discoverGeneric, discoverYandex
├── resolver.test.ts       resolveVideo (mock fetch)
├── rutube.test.ts         rutubeStreams
├── ok.test.ts             okStreams
├── dzen.test.ts           dzenStreams
├── vk.test.ts             vkStreams
├── vk-browser.test.ts     readVkPlayer (Firefox integration)
├── youtube.test.ts        youtubeIdentity
├── manifests.test.ts      parseHls, parseDash
├── capture-policy.test.ts identity-функции
├── revision.test.ts       restoreState, version migration
├── task-pool.test.ts      TaskPool
└── fixtures/              HTML/MPD для тестов
```

---

## Известные ограничения / Открытые задачи

1. **Дзен без вкладок**: `fetchText` иногда не находит JSON (SSR не отрабатывает). Нужно: либо найти API-эндпоинт Дзена без HTML-рендера, либо открывать вкладку только в фоне (`active: false`) без визуального появления.
2. **YouTube без моста**: `readYoutubePlayer` открывает вкладку — медленно и заметно пользователю.
3. **VK с авторизацией**: без cookies AJAX-запрос может вернуть код `3` (требует входа).
