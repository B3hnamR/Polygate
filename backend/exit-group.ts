import type { Route } from './types';
// An exit group is one route made of several exits that Polygate runs itself: Psiphon's regions (backend/psiphon.ts), Surfshark's
// locations (backend/surfshark.ts) and imported WireGuard configs (backend/wireguard.ts). Each exit is a local SOCKS port with its own
// outbound address. The route machinery (backend/transport.ts)
// treats every group the same way: one exit per request, taking turns or staying on one; a used-up exit skipped for that provider only and
// given a new address that is checked first; a refused request moved on; a route test that checks every exit; the exit named in the log.

// Which limits a request is subject to: OpenCode Free's daily allowance and Kilo's per-address limit belong to different services, so an exit
// used up for one is still good for the other, and for every other provider.
export type ExitScope = 'opencode' | 'kilo' | 'other';
// Tests reach only local addresses, so they say which service a request stands for.
export const __exitTest = { scope: '' as ExitScope | '' };
export const scopeOfUrl = (url: string): ExitScope => {
  if (__exitTest.scope) return __exitTest.scope;
  try { const h = new URL(url).hostname; return h === 'opencode.ai' || h.endsWith('.opencode.ai') ? 'opencode' : h === 'kilo.ai' || h.endsWith('.kilo.ai') ? 'kilo' : 'other'; } catch { return 'other'; }
};
export const scopeOfKind = (kind?: string): ExitScope => kind === 'free' ? 'opencode' : kind === 'kilo' ? 'kilo' : 'other';

export type ExitPick = { region: string; port: number };
// 'unknown' (the check could not be sent or read) lets real requests decide.
export type ExitCheck = { result: 'ok' | 'used-up' | 'unknown'; until?: number; note?: string };
export type ExitChecker = (region: string, scope: ExitScope) => Promise<ExitCheck>;
export type ExitGroup = {
  id: string;        // the route id ("psiphon")
  label: string;     // shown to people ("Psiphon")
  unit: string;      // what one exit is called ("region", "location")
  source: string;    // the Logs source ("psiphon")
  pick(tried: Set<string>, scope: ExitScope): ExitPick | null;
  ready(scope?: ExitScope): number;      // exits that could take a request of this kind now
  live(): number;                        // exits connected
  unavailable(scope?: ExitScope): string;
  virtualRoute(region: string): Route | undefined;
  regionsReady(): { region: string; exitIp: string }[];
  spent(region: string, until: number): void;
  kiloLimited(region: string, until: number): void;
  clean(region: string): void;
  failed(region: string): void;
  ok(region: string): void;
  skips(): boolean;
  setChecker(fn?: ExitChecker): void;
};
const groups = new Map<string, ExitGroup>();
export function registerExitGroup(g: ExitGroup) { groups.set(g.id, g); }
export const exitGroupOf = (routeId: string | undefined) => routeId ? groups.get(routeId) : undefined;
export const exitGroups = () => [...groups.values()];
// "<group>:<exit>" is one exit of a group as a route of its own (a check through exactly the exit that was refused).
export function exitOfVirtual(id: string): { group: ExitGroup; region: string } | undefined {
  const i = id.indexOf(':'); if (i < 1) return;
  const group = groups.get(id.slice(0, i)); return group ? { group, region: id.slice(i + 1) } : undefined;
}
