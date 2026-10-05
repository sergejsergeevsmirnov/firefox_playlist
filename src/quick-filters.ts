import { defaultFilters, type Filters } from './model';

export const qualityPresets = [360, 480, 720, 1080, 1440, 2160, 4320];
export const durationPresets = [300, 600, 1200, 1800, 3600];
export function quickFilters(input: Partial<Filters>): Filters {
  const minHeight = input.minHeight === undefined ? undefined : qualityPresets.find(n => n >= Number(input.minHeight)) ?? 4320;
  const maxDuration = input.maxDuration === undefined ? undefined : durationPresets.find(n => n >= Number(input.maxDuration));
  return { ...defaultFilters, minHeight, maxDuration, durationExclusive: maxDuration !== undefined,
    host: String(input.host ?? '').slice(0, 500), include: String(input.include ?? '').slice(0, 500), exclude: String(input.exclude ?? '').slice(0, 500) };
}
export function encodeFilter(filters: Filters): string {
  const f = quickFilters(filters);
  return JSON.stringify({ version: 1, quality: f.minHeight ?? null, duration: f.maxDuration ?? null, sites: f.host, words: f.include, exclude: f.exclude }, null, 2);
}
export function decodeFilter(text: string): Filters {
  if (text.length > 16000) throw new Error('Файл фильтра слишком большой');
  let value: Record<string, unknown>;
  try { value = JSON.parse(text); } catch { throw new Error('Не удалось прочитать JSON-фильтр'); }
  if (!value || value.version !== 1 || (value.quality !== null && !qualityPresets.includes(value.quality as number)) ||
      (value.duration !== null && !durationPresets.includes(value.duration as number)) ||
      !['sites', 'words', 'exclude'].every(k => typeof value[k] === 'string' && (value[k] as string).length <= 500)) throw new Error('Неверный формат файла фильтра');
  return quickFilters({ minHeight: value.quality === null ? undefined : value.quality as number,
    maxDuration: value.duration === null ? undefined : value.duration as number, host: value.sites as string, include: value.words as string, exclude: value.exclude as string });
}
