import { describe, expect, test } from 'bun:test';
import { clock, firstSentence, routeOptionLabel, warpLabel } from '../src/mini-logic';

describe('compact view helpers', () => {
  test('WARP states get short plain labels, and a running connect always reads as connecting', () => {
    expect(warpLabel('connected', false)).toBe('Connected');
    expect(warpLabel('disconnected', false)).toBe('Off');
    expect(warpLabel('error', false)).toBe('Off');
    expect(warpLabel('not_installed', false)).toBe('Helper missing');
    expect(warpLabel('connecting', false)).toBe('Connecting…');
    expect(warpLabel('connected', true)).toBe('Connecting…');
  });
  test('an error is cut to its first sentence, and to a length that fits', () => {
    const text = "Could not start a WARP tunnel. Your network reset the connection to Cloudflare's WARP servers, so it is probably blocking them. Tried x.";
    expect(firstSentence(text)).toBe('Could not start a WARP tunnel.');
    expect(firstSentence('No full stop here')).toBe('No full stop here');
    expect(firstSentence('x'.repeat(300), 50).length).toBe(50); expect(firstSentence('x'.repeat(300), 50).endsWith('…')).toBe(true);
    expect(firstSentence('')).toBe('');
  });
  test('the route list names a route only with a health note when something is not fine', () => {
    expect(routeOptionLabel('Direct connection', { label: 'Healthy' })).toBe('Direct connection');
    expect(routeOptionLabel('Direct connection')).toBe('Direct connection');
    expect(routeOptionLabel('Spare proxy', { label: 'Not tested' })).toBe('Spare proxy');
    expect(routeOptionLabel('Cloudflare WARP', { label: 'Used up today' })).toBe('Cloudflare WARP · Used up today');
  });
  test('the clock is 24-hour with seconds', () => {
    expect(clock(Date.UTC(2026, 9, 28, 16, 52, 35))).toMatch(/^\d{2}:\d{2}:\d{2}$/);
    expect(clock(Date.now())).not.toMatch(/AM|PM/i);
  });
});
