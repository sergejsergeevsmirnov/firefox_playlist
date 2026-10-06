import { defaultFilters, type Filters } from './model';

export const qualityPresets = [360, 480, 720, 1080, 1440, 2160, 4320];
export const durationPresets = [300, 600, 1200, 1800, 3600];
export function quickFilters(input: Partial<Filters>): Filters {
  const minHeight = input.minHeight === undefined ? undefined : qualityPresets.find(n => n >= Number(input.minHeight)) ?? 4320;
  const maxDuration = input.maxDuration === undefined ? undefined : durationPresets.find(n => n >= Number(input.maxDuration));
  const minDuration = input.minDuration === undefined ? undefined : durationPresets.find(n => n >= Number(input.minDuration));
  return { ...defaultFilters, minHeight, maxDuration, minDuration, durationExclusive: maxDuration !== undefined,
    host: String(input.host ?? '').slice(0, 500), include: String(input.include ?? '').slice(0, 500), exclude: String(input.exclude ?? '').slice(0, 500) };
}
export function encodeFilter(filters: Filters): string {
  const f = quickFilters(filters);
  const durationDir = f.minDuration !== undefined ? 'gt' : 'lt';
  const duration = f.minDuration ?? f.maxDuration ?? null;
  return JSON.stringify({ version: 1, quality: f.minHeight ?? null, duration, durationDir, sites: f.host, words: f.include, exclude: f.exclude }, null, 2);
}
export function decodeFilter(text: string): Filters {
  if (text.length > 16000) throw new Error('Файл фильтра слишком большой');
  let value: Record<string, unknown>;
  try { value = JSON.parse(text); } catch { throw new Error('Не удалось прочитать JSON-фильтр'); }
  if (!value || value.version !== 1 || (value.quality !== null && !qualityPresets.includes(value.quality as number)) ||
      (value.duration !== null && !durationPresets.includes(value.duration as number)) ||
      !['sites', 'words', 'exclude'].every(k => typeof value[k] === 'string' && (value[k] as string).length <= 500)) throw new Error('Неверный формат файла фильтра');
  const isGt = value.durationDir === 'gt';
  return quickFilters({ minHeight: value.quality === null ? undefined : value.quality as number,
    maxDuration: !isGt && value.duration !== null ? value.duration as number : undefined,
    minDuration: isGt && value.duration !== null ? value.duration as number : undefined,
    host: value.sites as string, include: value.words as string, exclude: value.exclude as string });
}
