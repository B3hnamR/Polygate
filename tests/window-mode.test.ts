import { describe, expect, test } from 'bun:test';
import { COMPACT, cleanBounds, defaultCompact, placeCompact, placeFull, reachable } from '../desktop/window-mode.cjs';

const screen = { x: 0, y: 0, width: 1920, height: 1040 };
const second = { x: 1920, y: 0, width: 1280, height: 1024 };
describe('compact window placement', () => {
  test('the first compact window sits on the right edge of the main display, centred, in portrait', () => {
    const b = defaultCompact(screen);
    expect(b.width).toBe(COMPACT.width); expect(b.height).toBe(COMPACT.height); expect(b.height).toBeGreaterThan(b.width);
    expect(b.x + b.width).toBe(screen.width - 16); expect(b.y).toBe(Math.round((screen.height - b.height) / 2));
  });
  test('on a small display it shrinks to fit but never below the minimum', () => {
    const b = defaultCompact({ x: 0, y: 0, width: 800, height: 700 });
    expect(b.height).toBe(700 - 32); expect(b.width).toBe(COMPACT.width); expect(b.x).toBeGreaterThanOrEqual(0);
    const tiny = defaultCompact({ x: 0, y: 0, width: 300, height: 400 });
    expect(tiny.width).toBe(COMPACT.minWidth); expect(tiny.height).toBe(COMPACT.minHeight);
  });
  test('a saved position is used while it is on a connected display, and replaced when its display is gone', () => {
    const saved = { x: 2400, y: 100, width: 380, height: 700 };
    expect(placeCompact(saved, [screen, second], screen)).toEqual(saved);
    expect(placeCompact(saved, [screen], screen)).toEqual(defaultCompact(screen));
  });
  test('nonsense saved values are ignored', () => {
    for (const bad of [undefined, null, 'x', {}, { x: 1, y: 1, width: NaN, height: 500 }, { x: 1, y: 1, width: 380, height: 10 }, { x: 1e9, y: 0, width: 380, height: 700 }]) expect(placeCompact(bad, [screen], screen)).toEqual(defaultCompact(screen));
    expect(cleanBounds({ x: 10.4, y: 20.6, width: 400.2, height: 500.7 }, 320, 440)).toEqual({ x: 10, y: 21, width: 400, height: 501 });
  });
  test('a window mostly off the screen is unreachable; one with a grabbable corner is not', () => {
    expect(reachable({ x: 1900, y: 1030, width: 380, height: 700 }, [screen])).toBe(false);
    expect(reachable({ x: 1500, y: 300, width: 380, height: 700 }, [screen])).toBe(true);
  });
  test('the full window comes back to its saved place, or stays where it is when nothing usable was saved', () => {
    const saved = { x: 100, y: 50, width: 1430, height: 970 };
    expect(placeFull(saved, [screen])).toEqual(saved);
    expect(placeFull({ x: 100, y: 50, width: 300, height: 300 }, [screen])).toBeNull();
    expect(placeFull(saved, [{ x: 5000, y: 0, width: 1920, height: 1040 }])).toBeNull();
    expect(placeFull(undefined, [screen])).toBeNull();
  });
});

describe('windows that do not fit the screen', () => {
  const laptop = { x: 0, y: 0, width: 1366, height: 728 };
  test('the first full window never exceeds the work area, and is centred in it', async () => {
    const { defaultFull } = await import('../desktop/window-mode.cjs');
    expect(defaultFull(screen)).toEqual({ x: Math.round((1920 - 1430) / 2), y: Math.round((1040 - 970) / 2), width: 1430, height: 970 });
    const small = defaultFull(laptop); expect(small.width).toBe(1366); expect(small.height).toBe(728); expect(small.x).toBe(0); expect(small.y).toBe(0);
  });
  test('a saved window taller than its display is shrunk, and one hanging below it is moved back up', async () => {
    const { fitToArea } = await import('../desktop/window-mode.cjs');
    expect(fitToArea({ x: 0, y: 0, width: 1430, height: 970 }, [laptop])).toEqual({ x: 0, y: 0, width: 1366, height: 728 });
    expect(fitToArea({ x: 100, y: 500, width: 1000, height: 600 }, [laptop])).toEqual({ x: 100, y: 128, width: 1000, height: 600 });
    expect(fitToArea({ x: 100, y: 50, width: 1000, height: 600 }, [laptop])).toEqual({ x: 100, y: 50, width: 1000, height: 600 }); // already inside
    // it is fitted to the display that holds most of it
    expect(fitToArea({ x: 1900, y: 100, width: 1000, height: 600 }, [screen, second]).x).toBeGreaterThanOrEqual(1920);
  });
  test('placeFull and placeCompact apply the fit, so a window saved on a larger screen never hangs off a smaller one', () => {
    const saved = { x: 100, y: 50, width: 1430, height: 970 };
    const b = placeFull(saved, [laptop])!; expect(b.y + b.height).toBeLessThanOrEqual(728); expect(b.x + b.width).toBeLessThanOrEqual(1366);
    const c = placeCompact({ x: 1000, y: 400, width: 380, height: 700 }, [laptop], laptop); expect(c.y + c.height).toBeLessThanOrEqual(728);
  });
});
