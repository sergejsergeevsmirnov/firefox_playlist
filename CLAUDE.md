# CLAUDE.md — Видеоочередь (Firefox Extension)

## Быстрый старт

```
pnpm install
pnpm build          # tsc --noEmit + vite build → dist/
pnpm test           # vitest run
pnpm run package    # zip → artifacts/
```

Сборка: `vite.config.ts` → два entry-point'а `sidebar.html` / `player.html`; background и content компилируются через `scripts/build.mjs`.

## Архитектура

Расширение — Firefox MV3. Три рантайм-контекста:

| Контекст | Точка входа | Роль |
|---|---|---|
| Service worker | `src/background.ts` | Состояние, очередь, resolver, хост-мост |
| Sidebar (UI) | `src/sidebar.ts` | Управление очередью, фильтры, карточки |
| Player (UI) | `src/player.ts` | HLS/DASH/file/youtube воспроизведение |
| Content script | `src/content.ts` | Сканирует DOM, шлёт кандидатов в background |

Все три UI-контекста общаются с background только через `browser.runtime.sendMessage`.

## Поддерживаемые провайдеры

| Сайт | Модуль | Механизм |
|---|---|---|
| Rutube | `src/rutube.ts` | GET `/api/play/options/{id}` |
| OK.ru | `src/ok.ts` | Парсинг `data-options` HTML страницы |
| Дзен | `src/dzen.ts` | Парсинг `_params` JSON из HTML **или** фоновая вкладка (fallback) |
| VK/VKVideo | `src/vk.ts` | POST `al_video.php` (API-first) **или** фоновая вкладка (fallback) |
| YouTube | `src/youtube.ts` + `src/native.ts` | yt-dlp мост (приоритет) → youtubei.js → embed |
| Vimeo | `src/vimeo.ts` + `src/capture-policy.ts` | GET `player.vimeo.com/video/{id}/config` (API-first) **или** перехват манифестов CDN (fallback) |
| Яндекс.Видео | `src/discovery.ts` → `discoverYandex()` | Каталог: парсинг карточек |
| Общий | `src/discovery.ts` → `discoverGeneric()` | video-теги, og:video, JSON-LD |

## Ключевые модули

- **`src/model.ts`** — все TypeScript-типы: `Video`, `Candidate`, `Variant`, `State`, `Session`, `Filters`
- **`src/core.ts`** — чистые функции: `mergeCandidate`, `matches`, `enqueue`, `restoreState`, `exportPlaylist`, `formatTime`
- **`src/resolver.ts`** — `resolveVideo()`: центральный диспетчер проверки; `probeFile()`, `resolveStreams()`
- **`src/manifests.ts`** — `parseHls()` / `parseDash()`: парсинг и проверка манифестов
- **`src/vimeo.ts`** — `vimeoConfigUrl()`, `vimeoStreams()`: API player.vimeo.com/video/{id}/config → варианты HLS/DASH/MP4
- **`src/capture-policy.ts`** — identity-функции (`youtubeIdentity`, `vkIdentity`, `vimeoIdentity`), `captureOrigins()`
- **`src/media-policy.ts`** — `isPreviewUrl()`, `isShortPreview()`
- **`src/discovery.ts`** — `discoverGeneric()`, `discoverYandex()`, `discoverEmbedded()`, `rankSourceCandidates()`
- **`src/task-pool.ts`** — `TaskPool(concurrency)`: очередь async-задач с ограничением параллелизма
- **`src/native.ts`** — HTTP-клиент yt-dlp моста: `nativePing()`, `nativeStatus()`, `nativeDownload()`, `nativeCleanup()`, `nativeGetProxy()`, `nativeSetProxy()`
- **`src/ui.ts`** — DOM-хелперы `$`, `element`, `button`, `send`, `notify`
- **`src/quick-filters.ts`** — пресеты качества/длительности (`qualityPresets`, `durationPresets`), `quickFilters()` (нормализует `minHeight`, `maxDuration`, `minDuration`), encode/decode фильтров в JSON; поддерживает направление `lt`/`gt` через поле `durationDir`
- **`src/style.css`** — общие стили + layout плеера (см. «UI / Скролл-поведение»)
- **`src/compact.css`** — компактные стили боковой панели + sticky-механика вкладок

## Нативный хост (yt-dlp мост)

- **`native-host/video_host.py`** — исходник Python HTTP-сервера `127.0.0.1:8765`
  - `GET /status` → `{ok: true}`
  - `POST /download {url, id}` → скачивает через yt-dlp, возвращает `{ok, url}` (локальный файл)
  - `POST /cleanup {id}` → удаляет кэш
  - `GET /<file>` → раздаёт файл с Range-support и CORS
  - `GET /proxy` → `{ok, proxy}` — читает текущее значение прокси из `config.json`
  - `POST /proxy {proxy}` → сохраняет прокси в `config.json`
- Кэш: `%TEMP%\video-queue-cache\`
- Прокси: `config.json` рядом с exe → ключ `proxy` (по умолчанию `http://127.0.0.1:2080`); меняется через UI в боковой панели
- Статус в UI: строка `yt-dlp: ✓/✗` внизу боковой панели

### Развёрнутый хост (production)

Планировщик Windows запускает **скомпилированный EXE**, а не Python-скрипт:

| | |
|---|---|
| Путь EXE | `C:\Users\Admin\AppData\Roaming\videoqueue-host\video_host.exe` |
| yt-dlp | `C:\Users\Admin\AppData\Roaming\videoqueue-host\yt-dlp.exe` |
| Конфиг прокси | `C:\Users\Admin\AppData\Roaming\videoqueue-host\config.json` |
| Задача планировщика | «VideoQueue yt-dlp bridge», триггер: вход в Windows |

EXE собран через PyInstaller — не требует Python на машине.

### Ручной запуск (если EXE не стартовал после входа)

```powershell
# Проверить, слушает ли порт
netstat -ano | Select-String ":8765"

# Запустить через Python DSH-рантайма (Python 3.12.14)
Start-Process "C:\Users\Admin\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\python\python.exe" `
  -ArgumentList "C:\Users\Admin\Documents\firefox_videoplaylist\native-host\video_host.py" `
  -WindowStyle Hidden

# Проверить статус
Invoke-WebRequest http://127.0.0.1:8765/status
```

**Важно**: `python.exe` из Microsoft Store — это заглушка, не работает. Настоящий Python: путь выше.

## UI / Скролл-поведение

### Боковая панель (`sidebar.ts` + `compact.css`)

Шапка (`.compact-toolbar`) — `position: sticky; top: 0` — всегда видна.

Блок фильтров (`.compact-filters`) прокручивается вместе со страницей.

Вкладки «Очередь / Найдено / ▶ Плеер» (`.list-toolbar`) прилипают под шапкой:
- CSS: `position: sticky; top: var(--toolbar-height, 0px); z-index: 4`
- JS (`sidebar.ts`): `ResizeObserver` на `.compact-toolbar` обновляет `--toolbar-height` на `:root` при каждом изменении высоты шапки (шапка динамическая: кнопки могут появляться и исчезать).

После прилипания вкладок скроллируются только карточки видео.

### Фильтр длительности (`sidebar.ts` + `quick-filters.ts`)

Поле «Длительность» разбито на два `<select>` внутри `.duration-filter`:
- `durationDir` — направление: `lt` (`<`, строго меньше) или `gt` (`>`, больше или равно).
- `durationValue` — значение из `durationPresets`: 300/600/1200/1800/3600 с или пусто («любая»).

При направлении `lt` → устанавливается `maxDuration` + `durationExclusive: true` (строгое отсечение).  
При направлении `gt` → устанавливается `minDuration`, `maxDuration` не задаётся.

`encodeFilter` сохраняет `durationDir` в JSON; `decodeFilter` читает его с дефолтом `lt` (обратная совместимость со старыми файлами фильтров).

### Страница плеера (`player.ts` + `style.css`)

Шапка `<header>` («Ваш следующий кадр») прокручивается как обычный элемент.

`main.player-layout` — `position: sticky; top: 0; height: 100vh; overflow: hidden` — вся двухколоночная панель прилипает к экрану как единица, как только шапка уходит вверх.

Внутри sticky-контейнера:
- **Левая колонка** `.player-stage` — `overflow-y: auto`; скроллится внутри себя.
  - `.player-current` (заголовок ролика) — `position: sticky; top: 0` внутри `.player-stage`: title прилипает к верху колонки, видео прокручивается под ним.
- **Правая колонка** `.player-aside` — `display: flex; flex-direction: column; overflow: hidden`.
  - `#playlist` — `overflow-y: auto; flex: 1`: список воспроизведения скроллируется независимо.

На мобильном (≤900px) `.player-layout` возвращается в `position: static; height: auto; overflow: visible`, обе колонки — в нормальный поток.

**Важно:** `position: sticky` на grid-элементе не работает, если родительский grid растягивает его до высоты контейнера (`align-items: stretch`). Именно поэтому sticky поставлен на сам `main.player-layout`, а не на его дочерние колонки.

## Принятые решения

- **Дзен**: сначала `fetchText` (без вкладок), fallback → `readDzenPlayer` (фоновая вкладка). Задача: убрать открытие вкладки полностью или открывать только в фоне (`active: false`).
- **VK**: сначала `readVkStreams` (AJAX), fallback → `readVkPlayer` (фоновая вкладка). Флаг `vkForeground` для явного переключения на вкладку.
- **YouTube**: если мост жив (`nativePing()`), сразу возвращает `native`-вариант; ensureDownload скачивает в фоне и заменяет вариант на `file`.
- Формат `youtube` используется только для embed-iframe (плеер не умеет его скачивать).
- `portable: true` на варианте = URL доступен для VLC-экспорта.
- **clearQueue**: вызывает `endSession` для всех сессий — сбор полностью останавливается. После очистки пользователь нажимает «Собирать» вручную. При повторном старте (`start`) фоновый скрипт после `inject` отправляет `scanNow` через `browser.tabs.sendMessage`: если `executeScript` попал в гонку при остановке старого экземпляра, уцелевший контент-скрипт всё равно немедленно начнёт сканирование с новым токеном.
- **Нормализация ссылок с Яндекс Видео** (`discovery.ts` + `resolver.ts`): `externalUrl()` применяет `stripMobileSubdomain()` как к прямым URL, так и к URL, извлечённым из query-параметра `url=` (Яндекс редиректы вида `clck/jsredir?...&url=http%3A%2F%2Fm.site.ru%2F...`). На Яндекс Видео страницах `discoverGeneric()` не обрабатывает `og:video` мета-теги — иначе они создавали бы кандидата с `sourceUrl = yandex.ru/video/preview/...`; внешний URL извлекает `discoverYandex()`. `fetchText()` с флагом `detectRedirects = true` делает HEAD pre-flight для кросс-доменных редиректов и объединяет все разрешения в один диалог. `PermissionNeeded` несёт опциональный `canonicalUrl` для обновления `sourceUrl`. `probeFile()` проверяет `Content-Type` ответа и отклоняет `text/html` — HTML-страницы плееров (например, `pbembed.me/embed/...` с ложным `og:video:type: video/mp4`) больше не принимаются как видеофайлы. `og:video` URL без расширения медиафайла добавляются в список embed-страниц для обхода в `resolveVideo()`.
- **Сайты, блокирующие headless-запросы (`porno-bomba.net` и зеркала)**: если `fetchText` бросает NetworkError, в `resolveVideo()` сначала перебираются embed-URL из `input.variants` (format=`file`, без расширения медиафайла — например `pbembed.me/embed/XXXXX/`): сначала статический `fetchText` + `discoverGeneric`, затем `readEmbedPlayer` с фоновой вкладкой. Embed-URL открывается напрямую (не через страницу-источник), поэтому `<video>` оказывается в главном фрейме без cross-origin iframe. Только если все embed-варианты не дали результата — открывается страница-источник.
- **Embed-плееры с ленивой загрузкой (`pornobomba.in`, pbembed.me)**: `readEmbedPlayer` читает конфигурацию через JWPlayer API (`jwplayer().getConfig().playlist[0].sources` + `jwplayer().getPlaylistItem()`) и VideoJS (`videojs.players`). Async-расширение в `executeScript` переспрашивает API-эндпоинты, вызванные страницей (по `performance.getEntriesByType('resource')`), через `fetch` с `credentials: 'same-origin'` — находит URL видео из JSON-ответов даже когда игрок загружает его отдельным XHR-запросом. `discoverEmbedded()` сканирует `<script>`-теги regex'ом. Дедлайн фоновой вкладки — 20 с (вместо 15). Если `executeScript` находит URL, но `resolveStreams` не может проверить его CDN (`requiredOrigins` непусты), вместо ошибки «Firefox не смог загрузить источник» показывается диалог «Разрешить проверку» с нужными origin'ами.

## Документация и коммиты (обязательно после каждой задачи)

После любых значимых изменений в коде:
1. Обновить затронутые разделы в `CLAUDE.md`, `PROJECT_MAP.md`, `STRUCTURE.md` — если изменилась архитектура, появился новый провайдер, изменились зависимости или структура файлов.
2. Предложить / сделать `git commit` с понятным сообщением на русском языке.
3. Предложить `git push` в GitHub.

Коммит делается только после подтверждения пользователя, если он не попросил явно «закоммить».

---

## Правила при изменениях

- Не трогать типы в `model.ts` без понимания влияния на `restoreState()` и `mergeCandidate()`.
- При добавлении провайдера: добавить `*PageUrl()` или `*Identity()` в соответствующий модуль, зарегистрировать в `resolver.ts` (ветка в `resolveVideo()`), добавить `captureOrigins()` если нужны хост-разрешения.
- `isPreviewUrl()` / `isShortPreview()` — фильтр на нескольких уровнях; не обходить.
- Никогда не `eval()` или `new Function()` в коде расширения (CSP запрещает).
- В content-скрипте нет прямого доступа к сети — только `browser.runtime.sendMessage`.
- Все мутации state идут только через `mutate()` в background.ts (гарантирует запись в storage).

## Сборка / упаковка

```
scripts/build.mjs       — vite build + копирование content.ts, pot.ts, manifest.json
scripts/fixtures.mjs    — обновление test-fixtures
scripts/firefox-smoke.mjs — дымовой тест в реальном Firefox
```

Артефакты: `artifacts/video-playlist-{version}.zip` — через `web-ext build`.
