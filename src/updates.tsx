import { useCallback, useEffect, useState } from 'react';
import { ArrowDownToLine, Check, Copy, ExternalLink, Loader2, RefreshCw, X } from 'lucide-react';
import { api } from './api';
import { Button } from './ui';
import type { UpdateState } from '../desktop/releases.cjs';

type DesktopUpdates = {
  getState(): Promise<UpdateState>; check(): Promise<UpdateState>; install(): Promise<UpdateState>;
  onState(callback: (state: UpdateState) => void): () => void;
};
declare global { interface Window { polygateUpdates?: DesktopUpdates } }
export function useUpdates(enabled: boolean) {
  const [state, setState] = useState<UpdateState | null>(null);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState('');
  const check = useCallback(async (force = true) => {
    setWorking(true);
    setError('');
    try {
      const next = window.polygateUpdates ? await window.polygateUpdates.check() : await api(force ? '/admin/updates/check' : '/admin/updates', force ? {} : undefined);
      setState(next);
    } catch { setError('Could not check for updates. Check your connection and try again.'); }
    finally { setWorking(false); }
  }, []);
  useEffect(() => {
    if (!enabled) { setState(null); return; }
    let active = true;
    const stop = window.polygateUpdates?.onState(next => { if (active) setState(next); });
    void check(false);
    const timer = setInterval(() => { if (!document.hidden) void check(false); }, 6 * 60 * 60 * 1000);
    return () => { active = false; stop?.(); clearInterval(timer); };
  }, [enabled, check]);
  const install = useCallback(async () => {
    if (!window.polygateUpdates) return;
    setWorking(true);
    try { setState(await window.polygateUpdates.install()); }
    catch { setState(previous => previous ? { ...previous, status: 'error', error: 'Could not start the update. Your current app is still running.' } : null); }
    finally { setWorking(false); }
  }, []);
  return { state, working, error, check, install };
}
export type Updates = ReturnType<typeof useUpdates>;
const busy = (state: UpdateState | null) => state?.status === 'downloading' || state?.status === 'installing';
function InstallButton({ updates }: { updates: Updates }) {
  const state = updates.state!;
  const label = state.status === 'downloading' ? `Downloading ${state.progress || 0}%` : state.status === 'installing' ? 'Restarting…' : 'Update & restart';
  return <Button variant="primary" disabled={updates.working || busy(state)} onClick={() => void updates.install()}>{busy(state) ? <Loader2 size={15} className="spin" /> : <ArrowDownToLine size={15} />}{label}</Button>;
}
export function UpdateBanner({ updates, openSettings }: { updates: Updates; openSettings: () => void }) {
  const state = updates.state;
  const [dismissed, setDismissed] = useState(() => { try { return sessionStorage.getItem('polygate-update-dismissed') || ''; } catch { return ''; } });
  if (!state?.available || (dismissed === state.latestVersion && !busy(state))) return null;
  const dismiss = () => { setDismissed(state.latestVersion); try { sessionStorage.setItem('polygate-update-dismissed', state.latestVersion); } catch { /* Storage can be disabled. */ } };
  return <section className="update-banner" aria-label="Software update">
    <ArrowDownToLine size={19} aria-hidden="true" />
    <div className="update-banner-copy"><strong>Polygate v{state.latestVersion} is available</strong><p>{busy(state) ? 'Keep Polygate open while the update is prepared.' : `You’re running v${state.currentVersion}. ${state.kind === 'windows' && state.canInstall ? 'Updating restarts the app and may interrupt active requests.' : state.kind === 'linux' ? 'Run the updater on your VPS to get the new version.' : 'See how to update this deployment.'}`}</p>{state.error && <p className="update-error" role="alert">{state.error}</p>}</div>
    <div className="update-actions">{state.kind === 'windows' && state.canInstall ? <InstallButton updates={updates} /> : <Button onClick={openSettings}>How to update</Button>}<a className="text-button" href={state.releaseUrl} target="_blank" rel="noreferrer">Release notes <ExternalLink size={13} /></a></div>
    {!busy(state) && <button className="icon-button" aria-label="Dismiss update notice" onClick={dismiss}><X size={16} /></button>}
  </section>;
}
export function UpdatesPanel({ updates }: { updates: Updates }) {
  const { state, working } = updates;
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState('');
  const command = state?.kind === 'docker' ? 'git pull --ff-only\ndocker compose up -d --build' : 'sudo polygate update';
  const copy = async () => { setCopyError(''); try { await navigator.clipboard.writeText(command); setCopied(true); } catch { setCopied(false); setCopyError('Clipboard unavailable. Select and copy the command above.'); } };
  const headline = !state ? updates.error ? 'Update check unavailable' : 'Check the latest published release' : busy(state) ? state.status === 'installing' ? 'Restarting with the new version…' : 'Downloading and verifying the update…' : state.available ? `Version ${state.latestVersion} is available` : state.status === 'current' ? 'No newer stable release' : state.status === 'checking' ? 'Checking GitHub…' : 'Update check unavailable';
  return <section className="section-block form-section updates-panel" aria-labelledby="updates-heading">
    <div className="section-top"><div><h2 id="updates-heading">Updates</h2><p className="muted">Published releases from B3hnamR/Polygate. Checked when you open the app, then every 6 hours while open.</p></div><Button disabled={working || busy(state)} onClick={() => { setCopied(false); void updates.check(); }}><RefreshCw size={15} className={working && !busy(state) ? 'spin' : ''} />{working && !busy(state) ? 'Checking…' : 'Check for updates'}</Button></div>
    <div className="update-summary"><div><strong aria-live="polite">{headline}</strong><p className="subtle">{state ? `Installed v${state.currentVersion}${state.latestVersion ? ` · Latest v${state.latestVersion}` : ''}${state.checkedAt ? ` · Checked ${new Date(state.checkedAt).toLocaleString()}` : ''}` : 'Checking for updates does not change your installation.'}</p></div>{state?.available && state.kind === 'windows' && state.canInstall && <InstallButton updates={updates} />}</div>
    {busy(state) && <><progress className="update-progress" max="100" value={state?.progress || 0} aria-label="Update download progress" /><p className="subtle">The download is verified before Polygate closes. The app then replaces its portable executable and reopens; your settings and keys stay in place.</p></>}
    {(state?.error || updates.error) && <p className="update-error" role="alert">{state?.error || updates.error}</p>}
    {state?.available && state.kind === 'windows' && state.canInstall && !busy(state) && <p className="subtle">Updating restarts the app and its gateway. Finish any active requests first. Your settings and API keys are kept.</p>}
    {state?.available && (state.kind === 'linux' || state.kind === 'docker') && <div className="update-instructions"><h3>{state.kind === 'linux' ? 'Run this on your VPS' : 'Run this in your Docker Compose folder'}</h3><p className="muted">{state.kind === 'linux' ? 'Connect over SSH, then use the manager’s updater. It keeps your data, settings, and certificates. The service restarts during the update.' : 'Rebuild the container from the new source. Keep the same Compose files and volume; use your usual -f options if you enabled HTTPS.'}</p><div className="update-command"><pre><code>{command}</code></pre><Button onClick={() => void copy()}>{copied ? <Check size={14} /> : <Copy size={14} />}{copied ? 'Copied' : 'Copy command'}</Button></div>{copyError && <p className="update-error" role="alert">{copyError}</p>}{state.kind === 'linux' && <p className="subtle">Or run <code>sudo polygate</code> and choose <strong>8 · Update Polygate</strong>. No update is installed from the browser.</p>}</div>}
    {state?.available && state.kind === 'windows' && !state.canInstall && <p className="muted">This development copy cannot replace itself. Download the portable Windows app from the release page.</p>}
    {state?.available && state.kind === 'manual' && <p className="muted">This copy runs from source or a standalone package. Update it using your original setup, then restart the gateway. The Linux service installer includes the <code>polygate update</code> manager command.</p>}
    {state && <a className="text-button" href={state.releaseUrl} target="_blank" rel="noreferrer">{state.available ? 'View release notes and downloads' : 'View releases'} <ExternalLink size={13} /></a>}
  </section>;
}
