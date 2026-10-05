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
| Vimeo | `src/capture-policy.ts` + `src/discovery.ts` | Manifest CDN обнаружение |
| Яндекс.Видео | `src/discovery.ts` → `discoverYandex()` | Каталог: парсинг карточек |
| Общий | `src/discovery.ts` → `discoverGeneric()` | video-теги, og:video, JSON-LD |

## Ключевые модули

- **`src/model.ts`** — все TypeScript-типы: `Video`, `Candidate`, `Variant`, `State`, `Session`, `Filters`
- **`src/core.ts`** — чистые функции: `mergeCandidate`, `matches`, `enqueue`, `restoreState`, `exportPlaylist`, `formatTime`
- **`src/resolver.ts`** — `resolveVideo()`: центральный диспетчер проверки; `probeFile()`, `resolveStreams()`
- **`src/manifests.ts`** — `parseHls()` / `parseDash()`: парсинг и проверка манифестов
- **`src/capture-policy.ts`** — identity-функции (`youtubeIdentity`, `vkIdentity`, `vimeoIdentity`), `captureOrigins()`
- **`src/media-policy.ts`** — `isPreviewUrl()`, `isShortPreview()`
- **`src/discovery.ts`** — `discoverGeneric()`, `discoverYandex()`, `discoverEmbedded()`, `rankSourceCandidates()`
- **`src/task-pool.ts`** — `TaskPool(concurrency)`: очередь async-задач с ограничением параллелизма
- **`src/native.ts`** — HTTP-клиент yt-dlp моста: `nativePing()`, `nativeStatus()`, `nativeDownload()`, `nativeCleanup()`, `nativeGetProxy()`, `nativeSetProxy()`
- **`src/ui.ts`** — DOM-хелперы `$`, `element`, `button`, `send`, `notify`
- **`src/quick-filters.ts`** — пресеты качества/длительности, encode/decode фильтров

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

## Принятые решения

- **Дзен**: сначала `fetchText` (без вкладок), fallback → `readDzenPlayer` (фоновая вкладка). Задача: убрать открытие вкладки полностью или открывать только в фоне (`active: false`).
- **VK**: сначала `readVkStreams` (AJAX), fallback → `readVkPlayer` (фоновая вкладка). Флаг `vkForeground` для явного переключения на вкладку.
- **YouTube**: если мост жив (`nativePing()`), сразу возвращает `native`-вариант; ensureDownload скачивает в фоне и заменяет вариант на `file`.
- Формат `youtube` используется только для embed-iframe (плеер не умеет его скачивать).
- `portable: true` на варианте = URL доступен для VLC-экспорта.

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
