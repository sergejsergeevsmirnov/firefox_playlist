export type Format = 'file' | 'hls' | 'dash' | 'youtube' | 'native';
export interface Variant {
  url: string;
  format: Format;
  height?: number;
  width?: number;
  fps?: number;
  bitrate?: number;
  codecs?: string;
  language?: string;
  audio?: boolean;
  subtitles?: string[];
  portable?: boolean;
  // Adaptive manifests remain the playback URL: this preserves separate audio tracks.
  qualityIndex?: number;
}
export interface Candidate {
  sourceUrl: string;
  identity?: string;
  title: string;
  thumbnail?: string;
  duration?: number;
  expectedDuration?: number;
  discovery?: 'catalog' | 'structured';
  live?: boolean;
  variants: Variant[];
}
export interface Video extends Candidate {
  id: string;
  status: 'checking' | 'ready' | 'site' | 'error';
  reason?: string;
  requiredOrigins: string[];
  position: number;
  watched: boolean;
  addedAt: number;
  selectedVariant?: string;
}
export interface Filters {
  minHeight?: number; maxHeight?: number;
  minDuration?: number; maxDuration?: number;
  durationExclusive?: boolean;
  host: string; include: string; exclude: string;
  format: '' | Format;
  live: '' | 'live' | 'recording';
  watched: '' | 'yes' | 'no';
}
export interface State {
  version: 1;
  videos: Record<string, Video>;
  queue: string[];
  filters: Filters;
  repeat: boolean;
  shuffle: boolean;
  autoplay: boolean;
  dismissed?: string[];
}
export interface Session {
  vkForeground?: boolean;
  vkCaptureFailure?: string;
  captureDiagnostic?: string;
  token: string;
  url: string;
  suppressed: string[];
  ids: string[];
  frameOrigins: string[];
  previewUrls?: string[];
}
export const defaultFilters: Filters = { host: '', include: '', exclude: '', format: '', live: '', watched: '' };
export const emptyState = (): State => ({ version: 1, videos: {}, queue: [], filters: { ...defaultFilters }, repeat: false, shuffle: false, autoplay: true });
export const variantKey = (v: Variant) => `${v.url}|${v.qualityIndex ?? ''}|${v.height ?? ''}`;
