import { useEffect, useState } from 'react';
import { Toggle } from './ui';

type DesktopPrefs = { closeToTray: boolean };
export type DesktopView = { compact: boolean; pinned: boolean };
type DesktopBridge = { getPrefs(): Promise<DesktopPrefs>; setCloseToTray(value: boolean): Promise<DesktopPrefs>; getView?(): Promise<DesktopView>; setCompact?(value: boolean): Promise<DesktopView>; setPinned?(value: boolean): Promise<DesktopView>; onView?(callback: (view: DesktopView) => void): () => void };
declare global { interface Window { polygateDesktop?: DesktopBridge } }
// Only the Windows app has a window and a tray; in a browser this panel is not shown.
export function DesktopPanel() {
  const bridge = window.polygateDesktop;
  const [prefs, setPrefs] = useState<DesktopPrefs | null>(null);
  const [error, setError] = useState('');
  useEffect(() => { bridge?.getPrefs().then(setPrefs).catch(() => setError('Could not read the app preferences.')); }, [bridge]);
  if (!bridge || !prefs) return null;
  const change = async (value: boolean) => {
    setError(''); setPrefs({ ...prefs, closeToTray: value });
    try { setPrefs(await bridge.setCloseToTray(value)); } catch { setPrefs(prefs); setError('Could not save this preference. Try again.'); }
  };
  return <section className="section-block form-section" aria-labelledby="desktop-heading">
    <h2 id="desktop-heading">Desktop app</h2>
    <Toggle checked={prefs.closeToTray} onChange={v => void change(v)} label="Keep running in the tray when the window is closed" detail={prefs.closeToTray ? 'Closing the window hides it; your clients keep working. Right-click the tray icon and choose Exit to stop Polygate.' : 'Closing the window stops Polygate and its API.'} />
    {error && <p className="update-error" role="alert">{error}</p>}
  </section>;
}
// The compact portrait view exists only in the Windows app (it is a window of its own); in a browser `available` is false.
export function useDesktopView() {
  const bridge = window.polygateDesktop;
  const available = !!(bridge?.getView && bridge.setCompact && bridge.setPinned);
  const [view, setView] = useState<DesktopView>({ compact: false, pinned: true });
  useEffect(() => {
    if (!available) return;
    let alive = true; bridge!.getView!().then(v => { if (alive) setView(v); }).catch(() => {});
    const off = bridge!.onView?.(v => { if (alive) setView(v); });
    return () => { alive = false; off?.(); };
  }, [available, bridge]);
  return { available, compact: available && view.compact, pinned: view.pinned,
    setCompact: (value: boolean) => bridge?.setCompact?.(value).then(setView).catch(() => {}),
    setPinned: (value: boolean) => bridge?.setPinned?.(value).then(setView).catch(() => {}) };
}
