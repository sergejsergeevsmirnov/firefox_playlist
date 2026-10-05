import { httpUrl, mediaFormat } from './core';
import type { Variant } from './model';

export function dzenPageUrl(source: string): string | undefined {
  const url = new URL(source);
  if (!/^(?:www\.)?dzen\.ru$/.test(url.hostname)) return;
  const id = /^\/video\/watch\/([a-f0-9]{24})(?:\/|$)/i.exec(url.pathname)?.[1];
  return id ? `https://dzen.ru/video/watch/${id}` : undefined;
}
// Extract just the JSON literal; never evaluate the surrounding website script.
export function dzenStreams(script: string): {variants: Variant[]; duration?: number} {
  const match = /\bvar\s+_params\s*=\s*\(?(\s*\{)/.exec(script);
  if (!match || script.length > 2 * 1024 * 1024) throw new Error('Данные плеера Дзена не найдены.');
  const start = match.index + match[0].lastIndexOf('{');
  let depth = 0, quoted = false, escaped = false, end = start;
  for (; end < script.length; end++) {
    const c = script[end];
    if (quoted) { if (escaped) escaped = false; else if (c === '\\') escaped = true; else if (c === '"') quoted = false; }
    else if (c === '"') quoted = true;
    else if (c === '{') depth++;
    else if (c === '}' && --depth === 0) { end++; break; }
  }
  const video = JSON.parse(script.slice(start, end))?.ssrData?.videoMetaResponse?.video;
  if (!video || video.isPremium === true) throw new Error('Дзен не предоставил открытый ролик.');
  const variants: Variant[] = [];
  for (const item of video.oneVideoStreams ?? []) {
    const url = typeof item.url === 'string' ? httpUrl(item.url) : undefined;
    const format = url ? mediaFormat(url) : undefined;
    if (url && format && !variants.some(v => v.url === url)) variants.push({url,format});
  }
  if (!variants.length) throw new Error('Открытые потоки Дзена не найдены.');
  // Prefer adaptive streams: they expose all qualities with fewer metadata probes.
  const adaptive = variants.filter(v => v.format !== 'file');
  return {variants: adaptive.length ? adaptive : variants, duration: Number.isFinite(video.duration) ? video.duration : undefined};
}

let inspecting = false;
export async function readDzenPlayer(url: string, signal: AbortSignal): Promise<string> {
  if (inspecting) throw new Error('Уже проверяется другой ролик через вкладку. Дождитесь завершения.');
  inspecting = true;
  try { return await inspectDzenPlayer(url, signal); } finally { inspecting = false; }
}
async function inspectDzenPlayer(url: string, signal: AbortSignal): Promise<string> {
  const tab = await browser.tabs.create({url,active:false});
  if (tab.id === undefined) throw new Error('Не удалось открыть временную вкладку Дзена.');
  try {
    await browser.tabs.update(tab.id, {muted:true});
    const deadline = Date.now() + 25000;
    while (Date.now() < deadline) {
      signal.throwIfAborted();
      const current = await browser.tabs.get(tab.id);
      if (current.url && dzenPageUrl(current.url) === url && current.status === 'complete') {
        const result = await browser.scripting.executeScript({target:{tabId:tab.id},func: (() => {
          const script = [...document.scripts].find(s => s.textContent?.includes('"videoMetaResponse"') && s.textContent.includes('"oneVideoStreams"'));
          return script?.textContent && script.textContent.length <= 2 * 1024 * 1024 ? script.textContent : '';
        }) as () => void}); // Older Firefox typings omit serializable function return values.
        if (result[0]?.result) return String(result[0].result);
      }
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    throw new Error('Дзен не открыл данные плеера за 25 секунд. Откройте источник для проверки доступности.');
  } finally { await browser.tabs.remove(tab.id).catch(() => {}); }
}
