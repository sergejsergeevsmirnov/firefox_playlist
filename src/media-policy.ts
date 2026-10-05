/** Exclude identified thumbnails, never all short or low-resolution videos. */
export function isPreviewUrl(value: string): boolean {
  try {
    const url = new URL(value);
    if (/(^|[.-])video-preview([.-]|$)/i.test(url.hostname)) return true;
    if (/(?:^|\/)(?:previews?|thumb(?:nail)?s?|storyboards?|teasers?)(?:[._/-]|$)/i.test(url.pathname)) return true;
    for (const key of ['type', 'mode', 'format']) if (/^(?:preview|thumbnail|teaser)$/i.test(url.searchParams.get(key) || '')) return true;
    return /^(?:1|true)$/i.test(url.searchParams.get('preview') || '');
  } catch { return false; }
}
export function isShortPreview(duration?: number, expectedDuration?: number): boolean {
  return duration !== undefined && expectedDuration !== undefined && expectedDuration >= 30 && duration <= 15 && duration < expectedDuration * 0.4;
}
