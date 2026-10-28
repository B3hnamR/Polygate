// Small pure helpers for the compact view, kept apart from the screen so they can be tested without a browser.
export type WarpState = 'disabled' | 'not_installed' | 'not_registered' | 'disconnected' | 'connecting' | 'connected' | 'error' | string;
// How the WARP row names its state in a few words.
export function warpLabel(state: WarpState, busy: boolean): string {
  if (busy || state === 'connecting') return 'Connecting…';
  return state === 'connected' ? 'Connected' : state === 'not_installed' ? 'Helper missing' : 'Off';
}
// The compact window has room for one short sentence of an error; the full text stays in the tooltip and on the Routing page.
export function firstSentence(text: string, max = 110): string {
  const first = text.trim().split(/(?<=[.!?])\s+/)[0] || '';
  return first.length > max ? first.slice(0, max - 1).trimEnd() + '…' : first;
}
// A route in the dropdown, with its health when it is not simply fine ("Cloudflare WARP · Used up today").
export function routeOptionLabel(name: string, info?: { label: string; role?: string }): string {
  const note = info?.label && !/^(healthy|selected|active|ready|not tested)$/i.test(info.label) ? ` · ${info.label}` : '';
  return name + note;
}
// 24-hour clock with seconds: shorter than the 12-hour form, which matters in a narrow window.
export const clock = (ms: number): string => new Date(ms).toLocaleTimeString([], { hour12: false });
