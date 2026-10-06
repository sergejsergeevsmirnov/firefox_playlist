import { discoverGeneric, discoverYandex, discoverPreviewUrls } from './discovery';
import { candidateId, mediaFormat } from './core';
import { vimeoResourceManifests, vimeoIdentity, vkResourceCandidates, vkIdentity } from './capture-policy';
import type { Candidate } from './model';

// Re-injection must not leave duplicate observers behind.
const context = globalThis as typeof globalThis & { __videoPlaylistStop?: () => void };
context.__videoPlaylistStop?.();
let stopped = false;
let timer: ReturnType<typeof setTimeout>;
let lastFrames = '';
let lastPreviews = '';
const signatures = new Map<string, string>();
let lastToken = '';
let scanning = false;
const inspectedResources = new Set<string>();
const resourceHistory = new Set<string>();
let resourcePage = location.href, resourceCount = 0, cdnCount = 0, fragmentCount = 0;
function rememberResources(entries: PerformanceEntry[]): void {
  if (resourcePage !== location.href) { resourceHistory.clear(); resourceCount=0; cdnCount=0; fragmentCount=0; resourcePage=location.href; }
  for (const entry of entries) {
    resourceCount++;
    try {
      const host = new URL(entry.name).hostname;
      if (!/(^|\.)(okcdn\.ru|vimeocdn\.com)$/.test(host)) continue;
      cdnCount++;
      if (['bytes','range','bytestart','byteend'].some(key => new URL(entry.name).searchParams.has(key))) fragmentCount++;
      // Retain bounded probe candidates; byte-range fragments must not evict manifests.
      if (vkResourceCandidates(location.href,[entry.name]).length || vimeoResourceManifests(location.href,[entry.name]).length) resourceHistory.add(entry.name);
      if (resourceHistory.size > 128) resourceHistory.delete(resourceHistory.values().next().value!);
    } catch { /* Not a network URL. */ }
  }
}
rememberResources(performance.getEntriesByType('resource'));
const resourceObserver = new PerformanceObserver(list => rememberResources(list.getEntries()));
try { resourceObserver.observe({entryTypes:['resource']}); } catch { /* Diagnostic remains available. */ }
let manifestCount = 0, probeErrors = 0, diagnostic = '', lastDiagnostic = '';
async function inspectVkResources(pageUrl: string): Promise<Candidate[]> {
  const urls = vkResourceCandidates(pageUrl, [...resourceHistory])
    .filter(url => !inspectedResources.has(url)).slice(0, 4);
  const results = await Promise.all(urls.map(async url => {
    inspectedResources.add(url);
    try {
      const response = await fetch(url, {method:'HEAD',credentials:'omit',signal:AbortSignal.timeout(4000)});
      const mime = response.headers.get('content-type') || '';
      const format = mediaFormat(url,mime);
      if (response.ok && (format === 'dash' || format === 'hls')) { manifestCount++; return {sourceUrl:pageUrl,title:document.title || 'Видео со страницы',variants:[{url,format}]} as Candidate; }
      if (!response.ok) probeErrors++;
    } catch { probeErrors++; }
  }));
  diagnostic = vkIdentity(pageUrl) ? `VK: ресурсов ${resourceCount}, CDN ${cdnCount}, фрагментов ${fragmentCount}, адресов ${resourceHistory.size}; проверено ${inspectedResources.size}, манифестов ${manifestCount}, отказов ${probeErrors}` : '';
  return results.filter((value): value is Candidate => !!value);
}
async function scan() {
  if (stopped || scanning) return;
  scanning = true;
  try {
    const pageUrl = location.href;
    const session = await browser.runtime.sendMessage({ type: 'collectorHello', pageUrl });
    if (!session?.token) return;
    if (lastToken !== session.token) { signatures.clear(); inspectedResources.clear(); manifestCount=0; probeErrors=0; diagnostic=''; lastDiagnostic=''; lastFrames = ''; lastPreviews = ''; lastToken = session.token; }
    if (resourcePage !== pageUrl) rememberResources([]);
    const resourceUrls = vimeoResourceManifests(pageUrl, [...resourceHistory]);
    const resourceCandidates: Candidate[] = resourceUrls.length ? [{sourceUrl:pageUrl, identity:vimeoIdentity(pageUrl),
      title:document.title || 'Видео со страницы', variants:resourceUrls.map(url => ({url,format:mediaFormat(url)!}))}] : [];
    const candidates = [...discoverYandex(document, pageUrl), ...discoverGeneric(document, pageUrl), ...resourceCandidates, ...await inspectVkResources(pageUrl)]
      .filter(candidate => signatures.get(candidateId(candidate)) !== JSON.stringify(candidate));
    const frames = [...document.querySelectorAll('iframe[src]')].map(f => f.getAttribute('src'));
    const previews = discoverPreviewUrls(document, pageUrl);
    if (!candidates.length && JSON.stringify(frames) === lastFrames && JSON.stringify(previews) === lastPreviews && diagnostic === lastDiagnostic) return;
    for (let offset = 0; offset < Math.max(1, candidates.length); offset += 200) {
      const batch = candidates.slice(offset, offset + 200);
      const reply = await browser.runtime.sendMessage({ type: 'discovered', token: session.token, pageUrl, candidates: batch, frames, previews, captureDiagnostic:diagnostic });
      if (!reply?.ok) break;
      for (const candidate of batch) signatures.set(candidateId(candidate), JSON.stringify(candidate));
      lastFrames = JSON.stringify(frames);
      lastPreviews = JSON.stringify(previews);
      lastDiagnostic = diagnostic;
    }
  } catch { /* inactive tab, revoked permission, or unloaded extension */ }
  finally { scanning = false; }
}
const schedule = () => { clearTimeout(timer); timer = setTimeout(() => void scan(), 350); };
const observer = new MutationObserver(schedule);
observer.observe(document, { childList: true, subtree: true, attributes: true, attributeFilter: ['src', 'href', 'data-video', 'data-bem'] });
document.addEventListener('loadedmetadata', schedule, true);
window.addEventListener('popstate', schedule);
const interval = setInterval(() => void scan(), 2000); // includes SPA pushState without page-world code injection
const messageListener = (msg: unknown) => {
  if ((msg as { type?: string })?.type === 'scanNow') { clearTimeout(timer); timer = setTimeout(() => void scan(), 80); }
};
browser.runtime.onMessage.addListener(messageListener);
context.__videoPlaylistStop = () => {
  stopped = true; observer.disconnect(); resourceObserver.disconnect(); clearTimeout(timer); clearInterval(interval);
  document.removeEventListener('loadedmetadata', schedule, true); window.removeEventListener('popstate', schedule);
  browser.runtime.onMessage.removeListener(messageListener);
};
void scan();
