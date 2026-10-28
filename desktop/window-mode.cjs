// Where the app's window goes when it switches between the full dashboard and the compact portrait view. Pure functions, so they can be
// tested without Electron: the caller passes the work areas of the connected displays.
const COMPACT = { width: 380, height: 720, minWidth: 320, minHeight: 440 };
const FULL_MIN = { width: 880, height: 650 };
const MARGIN = 16;
const sane = n => typeof n === 'number' && Number.isFinite(n) && Math.abs(n) < 100000;
// A saved rectangle is only used when every number is sensible and it is not smaller than the window may be.
function cleanBounds(b, minWidth, minHeight) {
  if (!b || typeof b !== 'object') return null;
  const { x, y, width, height } = b;
  if (![x, y, width, height].every(sane) || width < minWidth || height < minHeight) return null;
  return { x: Math.round(x), y: Math.round(y), width: Math.round(width), height: Math.round(height) };
}
// A window counts as reachable when enough of it lies on a connected display to grab it (a display that was unplugged takes it away).
function reachable(b, areas) {
  return areas.some(a => Math.min(b.x + b.width, a.x + a.width) - Math.max(b.x, a.x) >= 120 && Math.min(b.y + b.height, a.y + a.height) - Math.max(b.y, a.y) >= 80);
}
// First time in compact view: down the right edge of the main display, centred vertically, shrunk to fit a small screen.
function defaultCompact(area) {
  const width = Math.min(COMPACT.width, Math.max(COMPACT.minWidth, area.width - 2 * MARGIN));
  const height = Math.min(COMPACT.height, Math.max(COMPACT.minHeight, area.height - 2 * MARGIN));
  return { x: area.x + area.width - width - MARGIN, y: area.y + Math.round((area.height - height) / 2), width, height };
}
const placeCompact = (saved, areas, primary) => { const b = cleanBounds(saved, COMPACT.minWidth, COMPACT.minHeight); return b && reachable(b, areas) ? b : defaultCompact(primary); };
// null means "no usable saved position": the caller keeps the window where it is.
const placeFull = (saved, areas) => { const b = cleanBounds(saved, FULL_MIN.width, FULL_MIN.height); return b && reachable(b, areas) ? b : null; };
module.exports = { COMPACT, FULL_MIN, cleanBounds, reachable, defaultCompact, placeCompact, placeFull };
