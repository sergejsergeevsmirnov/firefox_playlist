// Hotlink-protected files (e.g. www.ebalka.video/get_file/…) answer 403 unless the request
// carries the Referer of the player page that embeds them. fetch() and <video> in extension
// pages cannot send a cross-origin Referer, so — like phncdn.com in background.ts — the header
// is set at the webRequest layer: only for the extension's own requests (background checks,
// the player page) to the domain of a variant that recorded its `referer`.
import type { Variant } from './model';

const rules = new Map<string, string>(); // match pattern of the file's domain → Referer
let registered = '';

/** *.example.com pattern for the file host's registrable domain (covers CDN subdomains and
 *  redirects such as get_file → remote_control on a sibling subdomain). */
function domainPatterns(url: string): string[] {
  const host = new URL(url).hostname;
  const domain = host.split('.').slice(-2).join('.');
  return [`https://*.${domain}/*`, `http://*.${domain}/*`, `https://${domain}/*`, `http://${domain}/*`];
}
function ownRequest(details: { tabId: number; originUrl?: string; documentUrl?: string }): boolean {
  const base = browser.runtime.getURL('');
  return details.tabId === -1 || !!details.originUrl?.startsWith(base) || !!details.documentUrl?.startsWith(base);
}
function listener(details: { url: string; tabId: number; originUrl?: string; documentUrl?: string; requestHeaders?: { name: string; value?: string }[] }) {
  if (!ownRequest(details)) return {};
  const referer = domainPatterns(details.url).map(p => rules.get(p)).find(Boolean);
  if (!referer) return {};
  const requestHeaders = (details.requestHeaders ?? []).filter(h => h.name.toLowerCase() !== 'referer');
  requestHeaders.push({ name: 'Referer', value: referer });
  return { requestHeaders };
}
function sync(): void {
  const urls = [...rules.keys()].sort();
  if (urls.join('|') === registered) return;
  if (browser.webRequest.onBeforeSendHeaders.hasListener(listener)) browser.webRequest.onBeforeSendHeaders.removeListener(listener);
  if (urls.length) browser.webRequest.onBeforeSendHeaders.addListener(listener, { urls }, ['blocking', 'requestHeaders']);
  registered = urls.join('|');
}
/** Register the Referer a variant needs; call before probing it. */
export function useReferer(variant: Variant): void {
  if (!variant.referer) return;
  try { for (const pattern of domainPatterns(variant.url)) rules.set(pattern, variant.referer); } catch { return; }
  sync();
}
/** Rebuild the rules from saved variants (after the extension restarts). */
export function restoreReferers(variants: Variant[]): void {
  for (const variant of variants) {
    if (!variant.referer) continue;
    try { for (const pattern of domainPatterns(variant.url)) rules.set(pattern, variant.referer); } catch { /* invalid URL */ }
  }
  sync();
}
