import { useState } from 'react';
import { Copy, Loader2, Maximize2, Pause, Pin, PinOff, Play, Power, PowerOff } from 'lucide-react';
import { api } from './api';
import { Badge, Logo, Select, ms, usePoll, type Snapshot } from './ui';
import { clock, firstSentence, routeOptionLabel, warpLabel } from './mini-logic';

type Metrics = { tokensPerSecond: number };
type WarpInfo = { state: string; busy: boolean; egress: null | { ip: string; colo: string }; progress?: { message: string }; lastError?: string };
const shortModel = (id: string) => id.replace(/^[^/]+\//, '');

// The compact portrait view of the Windows app: just enough to follow the gateway from a small window kept beside other work.
export function MiniView({ data, base, apiKey, busy, copy, notice, onToggle, onRoute, onFull, pinned, onPin }: { data: Snapshot; base: string; apiKey: string; busy: boolean; copy: (value: string) => void; notice: (message: string, kind?: 'ok' | 'error') => void; onToggle: () => void; onRoute: (id: string) => void; onFull: () => void; pinned: boolean; onPin: (value: boolean) => void }) {
  const metrics = usePoll<Metrics>('/admin/metrics', 5000).data;
  const hasWarp = data.settings.routes.some(r => r.id === 'warp');
  const [working, setWorking] = useState(false);
  const warpPoll = usePoll<WarpInfo>('/admin/warp/status', working ? 2000 : 6000);
  const warp = warpPoll.data; const connected = warp?.state === 'connected'; const connecting = working || !!warp?.busy;
  // The route in use stays in the list even when it has been switched off, so it shows its name and not a raw id.
  const routes = data.settings.routes.filter(r => r.enabled || r.id === data.settings.routeId);
  const { total, success, latency } = data.stats; const rate = total ? Math.round(100 * success / total) : null;
  const online = data.settings.enabled;
  // Connecting can take a while (it may register first), so the button shows progress and the row polls faster meanwhile.
  async function toggleWarp() {
    setWorking(true);
    try { await api(connected ? '/admin/warp/disconnect' : '/admin/warp/connect', {}); notice(connected ? 'WARP disconnected' : 'WARP connected'); }
    catch (e: any) { notice(firstSentence(e?.message || 'WARP could not change', 160), 'error'); }
    finally { setWorking(false); warpPoll.reload(); }
  }
  return <div className="mini">
    <header className="mini-head">
      <Logo size={22} /><strong>Polygate</strong><span className="toolbar-spacer" />
      <button className={`icon-button${pinned ? ' on' : ''}`} aria-pressed={pinned} aria-label="Keep on top of other windows" title={pinned ? 'Kept on top of other windows: click to let it go behind' : 'Keep on top of other windows'} onClick={() => onPin(!pinned)}>{pinned ? <Pin size={15} /> : <PinOff size={15} />}</button>
      <button className="icon-button" aria-label="Open the full window" title="Back to the full window (Ctrl+Shift+M)" onClick={onFull}><Maximize2 size={15} /></button>
    </header>
    <section className="mini-card" aria-label="Gateway status">
      <div className="mini-line"><Badge state={online ? 'running' : 'neutral'}>{online ? 'Gateway online' : 'Paused'}</Badge><span className="toolbar-spacer" />
        <button className="mini-button" disabled={busy} onClick={onToggle}>{online ? <Pause size={13} /> : <Play size={13} />}{online ? 'Pause' : 'Resume'}</button></div>
      <div className="mini-field"><span className="subtle">Route</span>
        <Select aria-label="Route for requests" value={data.settings.routeId} onChange={id => { if (id === 'warp' && !connected && hasWarp) notice('WARP is not connected yet: press Connect first.', 'error'); onRoute(id); }}>
          {routes.map(r => <option key={r.id} value={r.id}>{routeOptionLabel(r.name, data.routeInfo?.[r.id])}</option>)}
        </Select></div>
      {warp && warp.state !== 'disabled' && <div className="mini-warp">
        <div className="mini-line"><span className="subtle">WARP</span><strong className={connected ? 'good' : ''}>{warpLabel(warp.state, connecting)}</strong><span className="toolbar-spacer" />
          {warp.state !== 'not_installed' && <button className="mini-button" disabled={connecting} onClick={() => void toggleWarp()}>{connecting ? <Loader2 size={13} className="spin" /> : connected ? <PowerOff size={13} /> : <Power size={13} />}{connecting ? 'Wait…' : connected ? 'Disconnect' : 'Connect'}</button>}</div>
        {connected && warp.egress && <div className="mini-route"><span className="subtle">Exit</span><strong>{warp.egress.colo} · {warp.egress.ip}</strong></div>}
        {connecting && warp.progress?.message && <p className="subtle mini-note">{warp.progress.message}</p>}
        {!connecting && !connected && warp.lastError && <p className="mini-warn" title={warp.lastError}>{firstSentence(warp.lastError)}</p>}
      </div>}
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
      {data.logs.length ? <ul>{data.logs.slice(0, 10).map(r => <li key={r.id} title={`${r.model}${r.error ? ' · ' + r.error : ''}`}><span className="mono subtle">{clock(r.time)}</span><span className="mini-model">{shortModel(r.model)}</span><span className={`mini-result ${r.status < 400 ? 'ok' : 'bad'}`}>{r.status < 400 ? 'OK' : r.status}</span><span className="mono subtle">{ms(r.ms)}</span></li>)}</ul>
        : <p className="subtle">Requests from your tools appear here.</p>}
    </section>
    <footer className="mini-foot">
      <button className="mini-button" onClick={() => copy(base)}><Copy size={13} />Base URL</button>
      <button className="mini-button" disabled={!apiKey} onClick={() => copy(apiKey)}><Copy size={13} />API key</button>
    </footer>
  </div>;
}
