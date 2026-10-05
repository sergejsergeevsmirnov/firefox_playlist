# STRUCTURE — Структура файлов

```
firefox_videoplaylist/
│
├── manifest.json                  MV3 манифест расширения (v0.11.0)
├── sidebar.html                   HTML-оболочка боковой панели
├── player.html                    HTML-оболочка плеера
├── package.json                   npm-зависимости + скрипты сборки
├── pnpm-workspace.yaml            pnpm workspace
├── pnpm-lock.yaml                 lock-файл
├── tsconfig.json                  TypeScript config (target: ES2022)
├── vite.config.ts                 Vite config (entry: sidebar.html, player.html)
├── .gitignore                     node_modules, dist, artifacts, coverage, .test-*
│
├── src/                           Исходный код расширения (TypeScript)
│   ├── model.ts                   Типы: Video, Candidate, Variant, State, Session, Filters
│   ├── core.ts                    Бизнес-логика: mergeCandidate, matches, enqueue, export
│   ├── media-policy.ts            isPreviewUrl(), isShortPreview()
│   ├── capture-policy.ts          identity-функции, captureOrigins, vkResourceCandidates
│   ├── quick-filters.ts           Пресеты фильтров, encode/decode
│   ├── task-pool.ts               TaskPool(concurrency) — async очередь
│   ├── ui.ts                      DOM-хелперы: $, element, button, send, notify
│   │
│   ├── discovery.ts               Поиск видео в DOM и JSON-LD
│   │                               discoverGeneric, discoverYandex, discoverEmbedded
│   ├── manifests.ts               parseHls(), parseDash() — анализ манифестов
│   │
│   ├── rutube.ts                  Rutube: API /play/options/{id}
│   ├── ok.ts                      OK.ru: парсинг HTML data-options
│   ├── dzen.ts                    Дзен: парсинг _params JSON + fallback вкладка
│   ├── vk.ts                      VK: AJAX al_video.php + fallback вкладка
│   ├── youtube.ts                 YouTube: youtubei.js + PoToken (фоновая вкладка)
│   ├── native.ts                  yt-dlp HTTP-мост: ping, download, cleanup
│   │
│   ├── resolver.ts                resolveVideo() — центральный диспетчер
│   │                               Выбирает провайдер → resolveStreams() → probeFile()
│   ├── background.ts              Service worker: state, sessions, TaskPool
│   │                               onMessage, webRequest listener, schedule()
│   ├── content.ts                 Content script: scan(), MutationObserver
│   │                               Инжектируется на все разрешённые страницы
│   │
│   ├── sidebar.ts                 Боковая панель: карточки, фильтры, экспорт
│   ├── player.ts                  Плеер: hls.js, dash.js, <video>, <iframe>
│   │
│   ├── pot.ts                     Вспомогательный скрипт PoToken (web_accessible)
│   ├── style.css                  Основные стили
│   └── compact.css                Компактные стили для sidebar
│
├── native-host/                   Нативный yt-dlp мост
│   ├── video_host.py              Python HTTP-сервер (127.0.0.1:8765)
│   │                               GET /status, POST /download, POST /cleanup, GET /<file>
│   ├── video_host.bat             BAT-обёртка запуска
│   ├── videoqueue_host.json       Native Messaging manifest (для реестра)
│   ├── register.ps1               Регистрация в HKCU реестра Windows
│   ├── build/                     PyInstaller --onefile output
│   └── build-onedir/              PyInstaller --onedir output (используется)
│
├── scripts/                       Инструменты сборки и тестирования
│   ├── build.mjs                  Vite build + post-processing
│   ├── firefox-smoke.mjs          Дымовой тест в реальном Firefox (web-ext)
│   └── fixtures.mjs               Обновление тестовых fixture-файлов
│
├── tests/                         Vitest тесты
│   ├── core.test.ts               Бизнес-логика core.ts
│   ├── discovery.test.ts          DOM-обнаружение
│   ├── resolver.test.ts           resolveVideo (mock)
│   ├── rutube.test.ts             Rutube парсер
│   ├── ok.test.ts                 OK парсер
│   ├── dzen.test.ts               Дзен парсер
│   ├── vk.test.ts                 VK парсер
│   ├── vk-browser.test.ts         VK браузерный тест
│   ├── youtube.test.ts            YouTube identity
│   ├── manifests.test.ts          HLS/DASH парсеры
│   ├── capture-policy.test.ts     Identity-функции
│   ├── revision.test.ts           State migration
│   ├── task-pool.test.ts          TaskPool
│   ├── firefox-runner.js          Запуск тестов в Firefox
│   └── fixtures/                  Тестовые данные
│       ├── vk-segmentbase.mpd     MPD-манифест VK
│       ├── yandex.html            HTML Яндекс
│       └── yandex-live-2026-09-29.html
│
├── dist/                          Скомпилированное расширение (gitignored)
│   ├── background.js
│   ├── content.js
│   ├── pot.js
│   ├── sidebar.html
│   ├── player.html
│   ├── manifest.json
│   └── assets/
│
├── artifacts/                     ZIP-пакеты для публикации (gitignored)
│   └── video-playlist-{version}.zip
│
└── node_modules/                  (gitignored)
    ├── hls.js                     HLS-плеер
    ├── dashjs                     DASH-плеер
    ├── youtubei.js                YouTube API (без официального API)
    └── bgutils-js                 PoToken генератор
```

## Зависимости (production)

| Пакет | Назначение |
|---|---|
| `hls.js` | HLS-воспроизведение в плеере |
| `dashjs` | DASH-воспроизведение в плеере |
| `youtubei.js` | Извлечение YouTube-потоков (дешифровка n/sig) |
| `bgutils-js` | Генерация PoToken для YouTube |

## Зависимости (dev)

| Пакет | Назначение |
|---|---|
| `vite` | Bundler |
| `vitest` | Test runner |
| `typescript` | TypeScript compiler |
| `web-ext` | Lint и упаковка расширения |
| `@types/firefox-webext-browser` | Типы Firefox WebExtension API |
| `jsdom` | DOM для unit-тестов |
| `@types/node` | Node.js типы |
