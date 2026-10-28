import { Copy, Maximize2, Pause, Pin, PinOff, Play } from 'lucide-react';
import { Badge, Logo, ms, time, usePoll, type Snapshot } from './ui';

type Metrics = { tokensPerSecond: number };
type WarpInfo = { state: string; egress: null | { ip: string; colo: string } };
const shortModel = (id: string) => id.replace(/^[^/]+\//, '');

// The compact portrait view of the Windows app: just enough to follow the gateway from a small window kept beside other work.
export function MiniView({ data, base, apiKey, busy, copy, onToggle, onFull, pinned, onPin }: { data: Snapshot; base: string; apiKey: string; busy: boolean; copy: (value: string) => void; onToggle: () => void; onFull: () => void; pinned: boolean; onPin: (value: boolean) => void }) {
  const metrics = usePoll<Metrics>('/admin/metrics', 5000).data;
  const hasWarp = data.settings.routes.some(r => r.id === 'warp');
  const warp = usePoll<WarpInfo>('/admin/warp/status', 6000, hasWarp).data;
  const route = data.settings.routes.find(r => r.id === data.settings.routeId);
  const { total, success, latency } = data.stats; const rate = total ? Math.round(100 * success / total) : null;
  const online = data.settings.enabled;
  return <div className="mini">
    <header className="mini-head">
      <Logo size={22} /><strong>Polygate</strong><span className="toolbar-spacer" />
      <button className={`icon-button${pinned ? ' on' : ''}`} aria-pressed={pinned} aria-label="Keep on top of other windows" title={pinned ? 'Kept on top of other windows: click to let it go behind' : 'Keep on top of other windows'} onClick={() => onPin(!pinned)}>{pinned ? <Pin size={15} /> : <PinOff size={15} />}</button>
      <button className="icon-button" aria-label="Open the full window" title="Back to the full window (Ctrl+Shift+M)" onClick={onFull}><Maximize2 size={15} /></button>
    </header>
    <section className="mini-card" aria-label="Gateway status">
      <div className="mini-line"><Badge state={online ? 'running' : 'neutral'}>{online ? 'Gateway online' : 'Paused'}</Badge><span className="toolbar-spacer" />
        <button className="mini-button" disabled={busy} onClick={onToggle}>{online ? <Pause size={13} /> : <Play size={13} />}{online ? 'Pause' : 'Resume'}</button></div>
      <div className="mini-route"><span className="subtle">Route</span><strong title={route?.name}>{route?.name || 'Direct connection'}</strong></div>
      {warp?.state === 'connected' && warp.egress && <div className="mini-route"><span className="subtle">WARP exit</span><strong>{warp.egress.colo} · {warp.egress.ip}</strong></div>}
      {online && !data.ready.ready && <p className="mini-warn">Not ready: no model or route can answer right now.</p>}
    </section>
    <section className="mini-stats" aria-label="Last 24 hours">
      <div className="mini-stat"><span>Requests</span><strong>{total.toLocaleString()}</strong></div>
      <div className="mini-stat"><span>Success rate</span><strong className={rate === null ? '' : rate >= 90 ? 'good' : 'bad'}>{rate === null ? '—' : rate + '%'}</strong></div>
      <div className="mini-stat"><span>Average time</span><strong>{ms(latency)}</strong></div>
      <div className="mini-stat"><span>Speed</span><strong>{metrics?.tokensPerSecond ? metrics.tokensPerSecond + ' tok/s' : '—'}</strong></div>
    </section>
    <section className="mini-recent" aria-label="Recent requests">
      <h2>Recent requests</h2>
      {data.logs.length ? <ul>{data.logs.slice(0, 10).map(r => <li key={r.id} title={r.error || undefined}><span className="mono subtle">{time(r.time)}</span><span className="truncate">{shortModel(r.model)}</span><span className={`mini-result ${r.status < 400 ? 'ok' : 'bad'}`}>{r.status < 400 ? 'OK' : r.status}</span><span className="mono subtle">{ms(r.ms)}</span></li>)}</ul>
        : <p className="subtle">Requests from your tools appear here.</p>}
    </section>
    <footer className="mini-foot">
      <button className="mini-button" onClick={() => copy(base)}><Copy size={13} />Base URL</button>
      <button className="mini-button" disabled={!apiKey} onClick={() => copy(apiKey)}><Copy size={13} />API key</button>
    </footer>
  </div>;
}
