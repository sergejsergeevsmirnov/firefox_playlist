import { Player } from 'youtubei.js';
import { httpUrl } from './core';
import type { Variant } from './model';
import { youtubeIdentity } from './capture-policy';

// youtubei.js extracts the obfuscated n/sig decipher from YouTube's player JS
// (base.js). The extracted script is then run inside the page's MAIN world via an
// inline <script> element (YouTube's CSP permits it), which returns the deciphered
// signature. No eval/Function is used in the extension's own code.
let cachedPlayer: Promise<Player> | undefined;
function getPlayer(): Promise<Player> {
  cachedPlayer ??= Player.create(undefined, undefined, undefined, undefined).catch(error => { cachedPlayer = undefined; throw error; });
  return cachedPlayer;
}

interface Format { url?: string; signatureCipher?: string; cipher?: string; mimeType?: string; audioChannels?: number }
interface PageResult { ok: boolean; url?: string; title?: string; duration?: number; error?: string; captured?: boolean; note?: string }

async function readYoutubeStream(videoId: string, signal: AbortSignal): Promise<{ url: string; title?: string; duration?: number; captured?: boolean; note?: string }> {
  const player = await getPlayer();
  const extractedJs = player.data?.output;
  if (!extractedJs) throw new Error('YouTube: не удалось извлечь дешифратор подписи.');
  const tab = await browser.tabs.create({ url: `https://www.youtube.com/watch?v=${videoId}`, active: false });
  if (tab.id === undefined) throw new Error('Не удалось открыть временную вкладку YouTube.');
  const tabId = tab.id;
  try {
    await browser.tabs.update(tabId, { muted: true });
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline) {
      signal.throwIfAborted();
      const current = await browser.tabs.get(tabId);
      if (current.url && /(^|\.)youtube\.com$/.test(new URL(current.url).hostname)) break;
      await new Promise(resolve => setTimeout(resolve, 300));
    }
    const results = await browser.scripting.executeScript({
      target: { tabId },
      world: 'MAIN' as unknown as browser.scripting.ExecutionWorld,
      args: [videoId, extractedJs, browser.runtime.getURL('pot.js')],
      func: (async (videoId: string, extracted: string, potUrl: string) => {
        const w = globalThis as Record<string, unknown>;
        const initial = w.ytInitialPlayerResponse as { streamingData?: { formats?: Format[] }; videoDetails?: { title?: string; lengthSeconds?: string } } | undefined;
        const details = { title: initial?.videoDetails?.title, duration: Number(initial?.videoDetails?.lengthSeconds) || undefined };
        const formats = (initial?.streamingData?.formats ?? []);
        const format = formats.find(f => /mp4a|audio/i.test(f.mimeType || '') || f.audioChannels !== undefined);
        if (!format) return { ok: false, error: 'YouTube не отдал прогрессивный поток.' } as PageResult;
        const processBody = 'const m="https://ytjs.googlevideo.com/videoplayback?expire=1234567890&"+"n="+encodeURIComponent(n);'
          + 'const f=exportedVars.nsigFunction||(()=>{throw new Error("no nsig")});'
          + 'const u=f(m,sp,s);const p=Object.getPrototypeOf(u);'
          + 'for(const k of Object.getOwnPropertyNames(p)){if(["constructor","clone","set","get"].includes(k))continue;if(typeof u[k]==="function")u[k]();}'
          + 'const sg=u.get(sp);const nn=u.get("n");'
          + 'return {sig:sg?decodeURIComponent(sg):undefined,n:nn?decodeURIComponent(nn):undefined};';
        const runNsig = (n: string, sp: string, s: string): { sig?: string; n?: string } | undefined => {
          try {
            const code = extracted + '\n' + `globalThis.__ytD=(function(n,sp,s){${processBody}})("${n}","${sp}","${s}");`;
            const el = document.createElement('script');
            el.textContent = code;
            (document.head || document.documentElement).appendChild(el);
            el.remove();
            const result = w.__ytD as { sig?: string; n?: string } | undefined;
            delete w.__ytD;
            return result;
          } catch { return undefined; }
        };
        // Plain progressive URLs carry an encrypted `n` that googlevideo validates.
        const decipherN = (urlValue: string): string => {
          try {
            const u = new URL(urlValue);
            const nEnc = u.searchParams.get('n');
            if (!nEnc) return urlValue;
            const result = runNsig(nEnc, '', '');
            if (result?.n) { u.searchParams.set('n', result.n); return u.toString(); }
          } catch { /* keep the original */ }
          return urlValue;
        };
        // Mint a content-bound PoToken (the missing piece googlevideo requires).
        const generatePot = async (id: string): Promise<string> => {
          const ytcfg = w.ytcfg as { get?: (k: string) => unknown } | undefined;
          const apiKey = String(ytcfg?.get?.('INNERTUBE_API_KEY') || 'AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8');
          const context = (ytcfg?.get?.('INNERTUBE_CONTEXT') || {}) as unknown;
          const att = await fetch(`https://www.youtube.com/youtubei/v1/att/get?key=${encodeURIComponent(apiKey)}`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ context, engagementType: 'ENGAGEMENT_TYPE_UNBOUND' }),
          });
          if (!att.ok) throw new Error('att/get HTTP ' + att.status);
          const attJson = await att.json() as {
            bgChallenge?: { interpreterUrl?: { privateDoNotAccessOrElseTrustedResourceUrlWrappedValue?: string; privateDoNotAccessOrElseSafeScriptWrappedValue?: string }; interpreterHash?: string; program?: string; globalName?: string };
          };
          const bg = attJson.bgChallenge;
          if (!bg?.program || !bg?.globalName) throw new Error('нет bgChallenge');
          const interpreterUrl = bg.interpreterUrl?.privateDoNotAccessOrElseTrustedResourceUrlWrappedValue || bg.interpreterUrl?.privateDoNotAccessOrElseSafeScriptWrappedValue || '';
          if (interpreterUrl) {
            const interpreterJs = await fetch(interpreterUrl.startsWith('//') ? 'https:' + interpreterUrl : interpreterUrl).then(r => r.text());
            const interpreterEl = document.createElement('script');
            if (bg.interpreterHash) interpreterEl.id = bg.interpreterHash;
            interpreterEl.textContent = interpreterJs;
            (document.head || document.documentElement).appendChild(interpreterEl);
          }
          await new Promise<void>((resolve, reject) => {
            const s = document.createElement('script');
            s.src = potUrl;
            s.onload = () => resolve();
            s.onerror = () => reject(new Error('не удалось загрузить pot.js'));
            (document.head || document.documentElement).appendChild(s);
          });
          const gen = w.__ytGenPot as ((vid: string, ch: { program: string; globalName: string }) => Promise<string>) | undefined;
          if (typeof gen !== 'function') throw new Error('__ytGenPot недоступен');
          return gen(id, { program: bg.program, globalName: bg.globalName });
        };
        let baseUrl = '';
        if (typeof format.url === 'string' && format.url) baseUrl = decipherN(format.url);
        else {
          const cipher = format.signatureCipher || format.cipher;
          if (!cipher) return { ok: false, error: 'Поток YouTube зашифрован без данных подписи.' } as PageResult;
          const params = new URLSearchParams(cipher);
          const url = params.get('url'); const s = params.get('s'); const sp = params.get('sp') || 'signature';
          if (!url || !s) return { ok: false, error: 'Не удалось разобрать подпись YouTube.' } as PageResult;
          // The `n` parameter lives in the cipher's decoded URL and also needs deciphering.
          const n = new URL(url).searchParams.get('n') || '';
          const result = runNsig(n, sp, s);
          if (!result?.sig) return { ok: false, error: 'Не удалось расшифровать подпись YouTube.' } as PageResult;
          const u = new URL(url);
          u.searchParams.set(sp, result.sig);
          if (result.n) u.searchParams.set('n', result.n);
          baseUrl = u.toString();
        }
        if (!baseUrl) return { ok: false, error: 'YouTube не отдал поток.' } as PageResult;
        // Attach the PoToken — googlevideo rejects the URL without it (HTTP 403).
        let potApplied = false;
        let potError = '';
        try {
          const pot = await generatePot(videoId);
          if (pot) {
            const withPot = new URL(baseUrl);
            withPot.searchParams.set('pot', pot);
            baseUrl = withPot.toString();
            potApplied = true;
          } else potError = 'пустой токен';
        } catch (error) { potError = error instanceof Error ? error.message : String(error); }
        // Probe the URL from the page's own context (correct Origin) to see what
        // googlevideo answers when the request looks like the site's own.
        let pageProbe = '';
        try {
          const response = await fetch(baseUrl, { headers: { Range: 'bytes=0-0' }, credentials: 'omit' });
          pageProbe = String(response.status);
          await response.body?.cancel();
        } catch (error) { pageProbe = 'err:' + (error instanceof Error ? error.message : String(error)); }
        if (potApplied) {
          return { ok: true, url: baseUrl, title: details.title, duration: details.duration,
            note: `pot:ok; page-probe ${pageProbe}` } as PageResult;
        }
        // Start the page's player (muted) and capture the exact videoplayback URLs
        // it requests — they carry the PoToken (`pot`) googlevideo requires.
        try {
          for (const v of document.querySelectorAll('video')) { v.muted = true; if (v.paused) void v.play().catch(() => {}); }
          for (const sel of ['.ytp-play-button', '.ytp-large-play-button', 'button[aria-label*="Воспроизвести"]', 'button[aria-label*="Play"]']) {
            for (const btn of document.querySelectorAll(sel)) { try { (btn as HTMLElement).click(); } catch { /* ignore */ } }
          }
          const deadline = Date.now() + 22000;
          while (Date.now() < deadline) {
            for (const v of document.querySelectorAll('video')) {
              const src = v.currentSrc || v.src;
              if (typeof src === 'string' && src.includes('googlevideo.com') && src.includes('videoplayback')) {
                return { ok: true, url: src, title: details.title, duration: details.duration, captured: true, note: `player-src; page-probe ${pageProbe}` } as PageResult;
              }
            }
            const resources = performance.getEntriesByType('resource').map(e => e.name)
              .filter(n => n.includes('googlevideo.com') && n.includes('videoplayback'));
            if (resources.length) {
              const itag18 = resources.find(n => n.includes('itag%3D18') || n.includes('itag=18'));
              if (itag18) {
                return { ok: true, url: itag18, title: details.title, duration: details.duration, captured: true, note: `player-resource; page-probe ${pageProbe}` } as PageResult;
              }
              // Merge any params the player's request has that our URL lacks (e.g. pot).
              try {
                const playerParams = new URL(resources[0]).searchParams;
                const merged = new URL(baseUrl);
                const added: string[] = [];
                playerParams.forEach((value, key) => {
                  if (!merged.searchParams.has(key)) { merged.searchParams.set(key, value); added.push(key); }
                });
                if (added.length) {
                  return { ok: true, url: merged.toString(), title: details.title, duration: details.duration,
                    captured: true, note: `params added from player: ${added.join(',')}; page-probe ${pageProbe}` } as PageResult;
                }
                return { ok: true, url: baseUrl, title: details.title, duration: details.duration,
                  note: `page-probe ${pageProbe}; player-used: ${resources[0].slice(0, 240)}` } as PageResult;
              } catch { /* fall through */ }
            }
            await new Promise(r => setTimeout(r, 500));
          }
        } catch { /* keep the base URL */ }
        return { ok: true, url: baseUrl, title: details.title, duration: details.duration, note: `pot:err(${potError}); page-probe ${pageProbe}` } as PageResult;
      }) as unknown as (videoId: string, extracted: string, potUrl: string) => void,
    });
    const raw = results[0]?.result as PageResult | undefined;
    if (!raw || raw.ok !== true || !raw.url) throw new Error(raw?.error || 'YouTube не отдал поток.');
    return { url: raw.url, title: raw.title, duration: raw.duration, captured: raw.captured === true, note: raw.note };
  } finally {
    await browser.tabs.remove(tabId).catch(() => {});
  }
}

export async function readYoutubePlayer(source: string, signal: AbortSignal): Promise<{ variants: Variant[]; duration?: number; title?: string; captured?: boolean; note?: string }> {
  const identity = youtubeIdentity(source);
  if (!identity) throw new Error('Не распознан адрес ролика YouTube.');
  const result = await readYoutubeStream(identity.slice(8), signal);
  return { variants: [{ url: httpUrl(result.url) || result.url, format: 'file' }], duration: result.duration, title: result.title, captured: result.captured, note: result.note };
}

export function youtubeEmbedUrl(value: string): string | undefined {
  const id = youtubeIdentity(value)?.slice(8);
  return id ? `https://www.youtube.com/embed/${id}` : undefined;
}
