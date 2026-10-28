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
    const b = defaultCompact({ x: 0, y: 0, width: 800, height: 560 });
    expect(b.height).toBe(560 - 32); expect(b.width).toBe(COMPACT.width); expect(b.x).toBeGreaterThanOrEqual(0);
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
