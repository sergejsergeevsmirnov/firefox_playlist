export function vimeoIdentity(value: string): string | undefined {
  try {
    const u = new URL(value);
    if (!/^(?:www\.|player\.)?vimeo\.com$/.test(u.hostname)) return;
    const id = /^\/(?:video\/)?(\d+)(?:\/|$)/.exec(u.pathname)?.[1];
    return id ? `vimeo:${id}` : undefined;
  } catch { return; }
}
export function captureOrigins(value: string): string[] {
  if (vkIdentity(value)) return ['https://*.vkvideo.ru/*', 'https://*.vk.com/*', 'https://*.okcdn.ru/*', 'https://*.vkuser.net/*', 'https://*.vkuservideo.net/*'];
  if (youtubeIdentity(value)) return ['https://*.youtube.com/*', 'https://*.googlevideo.com/*'];
  return vimeoIdentity(value) ? ['https://*.vimeo.com/*', 'https://*.vimeocdn.com/*'] : [];
}
export function vkIdentity(value: string): string | undefined {
  try {
    const u = new URL(value);
    if (!/(^|\.)(vkvideo\.ru|vk\.com)$/.test(u.hostname)) return;
    const id = /^\/(?:video|clip)(-?\d+_\d+)(?:\/|$)/.exec(u.pathname)?.[1];
    return id ? `vk:${id}` : undefined;
  } catch { return; }
}
export function sourceIdentity(value: string): string | undefined {
  return vimeoIdentity(value) ?? vkIdentity(value) ?? youtubeIdentity(value);
}
export function youtubeIdentity(value: string): string | undefined {
  try {
    const u = new URL(value);
    const host = u.hostname.toLowerCase();
    if (host !== 'youtu.be' && host !== 'youtube.com' && !host.endsWith('.youtube.com')
      && host !== 'youtube-nocookie.com' && !host.endsWith('.youtube-nocookie.com')) return;
    const id = u.searchParams.get('v')
      || /^\/(?:shorts|embed|live|v)\/([A-Za-z0-9_-]{11})(?:[/?#]|$)/.exec(u.pathname)?.[1]
      || (host === 'youtu.be' ? /^\/([A-Za-z0-9_-]{11})(?:[/?#]|$)/.exec(u.pathname)?.[1] : undefined);
    return id && /^[A-Za-z0-9_-]{11}$/.test(id) ? `youtube:${id}` : undefined;
  } catch { return; }
}
export function youtubePageUrl(value: string): string | undefined {
  const id = youtubeIdentity(value)?.slice(8);
  return id ? `https://www.youtube.com/watch?v=${id}` : undefined;
}
export function vkResourceCandidates(page: string, resources: string[]): string[] {
  if (!vkIdentity(page)) return [];
  return [...new Set(resources.filter(value => {
    try {
      const u = new URL(value);
      return u.protocol === 'https:' && /(^|\.)okcdn\.ru$/.test(u.hostname)
        && !['bytes','range','bytestart','byteend'].some(key => u.searchParams.has(key));
    } catch { return false; }
  }))].slice(-128);
}
export function vimeoFetchUrl(value: string): string {
  if (!vimeoIdentity(value)) return value;
  const url = new URL(value.replace(/&amp;/g, '&'));
  url.protocol = 'https:';
  return url.href;
}
export function vimeoResourceManifests(page: string, resources: string[]): string[] {
  if (!vimeoIdentity(page)) return [];
  return [...new Set(resources.filter(value => {
    try {
      const u = new URL(value);
      return u.protocol === 'https:' && /(^|\.)vimeocdn\.com$/.test(u.hostname)
        && /\/(?:playlist|master)\.m3u8$|\.mpd$/i.test(u.pathname);
    } catch { return false; }
  }))].slice(-12);
}
export function isVimeoChildManifest(value: string): boolean {
  const u = new URL(value);
  return /(^|\.)vimeocdn\.com$/.test(u.hostname) && /\/media\.m3u8$/.test(u.pathname);
}
