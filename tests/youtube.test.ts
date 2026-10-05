import { it, expect, afterEach, vi } from 'vitest';
import { youtubeEmbedUrl } from '../src/youtube';
import { youtubeIdentity, captureOrigins } from '../src/capture-policy';
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

it('recognizes YouTube watch, short, embed and share URLs', () => {
  expect(youtubeIdentity('https://www.youtube.com/watch?v=dQw4w9WgXcQ')).toBe('youtube:dQw4w9WgXcQ');
  expect(youtubeIdentity('https://youtu.be/dQw4w9WgXcQ?t=10')).toBe('youtube:dQw4w9WgXcQ');
  expect(youtubeIdentity('https://www.youtube.com/shorts/dQw4w9WgXcQ')).toBe('youtube:dQw4w9WgXcQ');
  expect(youtubeIdentity('https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ')).toBe('youtube:dQw4w9WgXcQ');
  expect(youtubeIdentity('https://example.org/watch?v=dQw4w9WgXcQ')).toBeUndefined();
});

it('requests YouTube and googlevideo host access', () => {
  expect(captureOrigins('https://www.youtube.com/watch?v=dQw4w9WgXcQ')).toEqual(['https://*.youtube.com/*', 'https://*.googlevideo.com/*']);
});

it('builds an embed URL for the in-window fallback', () => {
  expect(youtubeEmbedUrl('https://www.youtube.com/watch?v=dQw4w9WgXcQ')).toBe('https://www.youtube.com/embed/dQw4w9WgXcQ');
  expect(youtubeEmbedUrl('https://example.org/watch')).toBeUndefined();
});
