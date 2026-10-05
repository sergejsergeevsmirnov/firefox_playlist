import type { State, Session } from './model';
export async function send<T = { ok: boolean }>(type: string, payload: Record<string, unknown> = {}): Promise<T> {
  const result = await browser.runtime.sendMessage({ type, ...payload });
  if (result?.error) throw new Error(result.error);
  return result as T;
}
export const getState = () => send<{ state: State; sessions: Record<number, Session> }>('getState');
export const $ = <T extends HTMLElement = HTMLElement>(selector: string): T => document.querySelector<T>(selector)!;
export function element<K extends keyof HTMLElementTagNameMap>(tag: K, text?: string, className?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag); if (text !== undefined) node.textContent = text; if (className) node.className = className; return node;
}
export function button(label: string, action: () => void | Promise<void>, className = ''): HTMLButtonElement {
  const b = element('button', label, className); b.type = 'button'; b.onclick = () => { void Promise.resolve(action()).catch(notifyError); }; return b;
}
export function notify(text: string, error = false): void {
  const node = document.querySelector('#notice'); if (!node) return;
  node.textContent = text; node.classList.toggle('error', error);
}
export const notifyError = (error: unknown) => notify(error instanceof Error ? error.message : String(error), true);
export function link(url: string, label = 'Открыть источник'): HTMLAnchorElement {
  const a = element('a', label); a.href = url; a.target = '_blank'; a.rel = 'noopener noreferrer'; return a;
}
