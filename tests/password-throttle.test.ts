import { afterEach, expect, test } from 'bun:test';
import { changePassword, loginGate, verifyPassword } from '../backend/auth';
import { settings } from '../backend/state';
import { preserveTestState } from './setup';

const restore = preserveTestState();
const restoreGate = loginGate.__captureTestState();
afterEach(() => { restore(); restoreGate(); });

test('current-password guesses share the login throttle even with an invalid new password', () => {
  delete process.env.POLYGATE_ADMIN_PASSWORD;
  delete settings.admin;
  loginGate.reset();
  const ip = '192.0.2.48', secret = 'fixture-admin-token';
  for (let i = 0; i < 5; i++) expect(() => changePassword('wrong', 'short', secret, ip)).toThrow('Current password');
  expect(loginGate.retryAfter(ip)).toBeGreaterThan(0);
  expect(() => changePassword(secret, 'short', secret, ip)).toThrow('Too many attempts');
  expect(settings.admin).toBeUndefined();
});

test('an existing login lockout also blocks current-password verification', () => {
  delete process.env.POLYGATE_ADMIN_PASSWORD;
  delete settings.admin;
  loginGate.reset();
  for (let i = 0; i < 5; i++) loginGate.fail('192.0.2.49');
  expect(() => changePassword('fixture-admin-token', 'new valid password', 'fixture-admin-token', '192.0.2.49')).toThrow('Too many attempts');
  expect(settings.admin).toBeUndefined();
});

test('a correct password with an invalid replacement does not reset earlier failed guesses', () => {
  delete process.env.POLYGATE_ADMIN_PASSWORD;
  delete settings.admin;
  loginGate.reset();
  const ip = '192.0.2.50';
  for (let i = 0; i < 4; i++) loginGate.fail(ip);
  expect(() => changePassword('fixture-admin-token', 'short', 'fixture-admin-token', ip)).toThrow('at least 12');
  expect(() => changePassword('wrong', 'short', 'fixture-admin-token', ip)).toThrow('Current password');
  expect(loginGate.retryAfter(ip)).toBeGreaterThan(0);
});

test('successful password changes clear previous failures and replace the password', () => {
  delete process.env.POLYGATE_ADMIN_PASSWORD;
  delete settings.admin;
  loginGate.reset();
  const ip = '192.0.2.51';
  for (let i = 0; i < 4; i++) loginGate.fail(ip);
  changePassword('fixture-admin-token', 'new fixture password', 'fixture-admin-token', ip);
  expect(verifyPassword('new fixture password', 'fixture-admin-token')).toBe(true);
  expect(verifyPassword('fixture-admin-token', 'fixture-admin-token')).toBe(false);
  loginGate.fail(ip);
  expect(loginGate.retryAfter(ip)).toBe(0);
});
