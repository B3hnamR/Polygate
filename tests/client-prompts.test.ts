import { expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
// The Free gateway answers a system prompt whose `<env>` block has no `Working directory:` line with 429 FreeUsageLimitError,
// the same text it uses for an exhausted allowance. Coding clients that send their own `<env>` block (Kilo, OpenCode forks) hit it.
process.env.AUTO_UPDATE = '0';
process.env.OPENCODE_BRIDGE_STATE_DIR = mkdtempSync(join(tmpdir(), 'polygate-prompts-'));
const bridge = require('../vendor/bridge/server.js');

const blocks = (text: string) => text.match(/<env>[\s\S]*?<\/env>/g) || [];
const systemText = (messages: any[]) => messages.filter(m => m.role === 'system' || m.role === 'developer').map(m => typeof m.content === 'string' ? m.content : m.content.map((p: any) => p.text || '').join('')).join('\n');
const allHaveWorkingDirectory = (text: string) => blocks(text).length > 0 && blocks(text).every(b => /Working directory:/.test(b));

// Shaped from a real Kilo 7.8.17 capture: its own <env> block (no working directory), and "Working directory:" text elsewhere in the prompt.
const kilo = [
  'You are Kilo, a highly skilled software engineer.',
  'You are powered by the model named opencode/deepseek-v4.1-flash-free.',
  'Here is some useful information about the environment you are running in:',
  '<env>',
  '  Is directory a git repo: no',
  '  Platform: win32',
  "  Today's date: Sun Oct 25 2026",
  '  Default shell: C:\\Program Files\\PowerShell\\7\\pwsh.exe',
  '</env>',
  'Include the Working directory: line from the user message when running commands.',
].join('\n');

test('A client <env> block without a working directory gets the line in place, not a second block', () => {
  const out = bridge.transformChatMessages([{ role: 'system', content: kilo }, { role: 'user', content: 'hi' }]);
  const text = systemText(out);
  expect(blocks(text)).toHaveLength(1);
  expect(allHaveWorkingDirectory(text)).toBe(true);
  expect(text).toContain('Platform: win32');
  expect(text).toContain('Default shell: C:\\Program Files\\PowerShell\\7\\pwsh.exe');
  expect(text.startsWith('You are Kilo')).toBe(true);
});

test('A working directory mentioned outside the block does not stand in for one inside it', () => {
  expect(/<env>[\s\S]*?Working directory:/.test(kilo)).toBe(true);
  expect(allHaveWorkingDirectory(bridge.withHarnessEnvBlock(kilo))).toBe(true);
});

test('Every <env> block in a prompt carries the line, and one that already has it is left alone', () => {
  const own = '<env>\n  Working directory: /work/app\n  Platform: linux\n</env>';
  const prompt = `${own}\nmore rules\n<env>\n  Platform: darwin\n</env>`;
  const fixed = bridge.withHarnessEnvBlock(prompt);
  expect(allHaveWorkingDirectory(fixed)).toBe(true);
  expect(fixed.startsWith(own)).toBe(true);
  expect(fixed).toContain('Platform: darwin');
});

test('A prompt that already carries a working directory is not changed', () => {
  const prompt = 'Rules.\n<env>\n  Working directory: /work/app\n  Is directory a git repo: yes\n</env>';
  expect(bridge.withHarnessEnvBlock(prompt)).toBe(prompt);
});

test('Prompts with no <env> block (Cline, Roo, Aider and similar) get the block appended', () => {
  for (const prompt of ['You are Cline.\n====\nSYSTEM INFORMATION\nOperating System: Windows 11\nCurrent Working Directory: D:/proj', 'You are Aider, an AI pair programmer.', '']) {
    const out = bridge.transformChatMessages([{ role: 'system', content: prompt }, { role: 'user', content: 'hi' }]);
    const text = systemText(out);
    expect(allHaveWorkingDirectory(text)).toBe(true);
    if (prompt) expect(text.startsWith(prompt.trimEnd())).toBe(true);
  }
});

test('A request with no system message gets one', () => {
  const out = bridge.transformChatMessages([{ role: 'user', content: 'hi' }]);
  expect(out[0].role).toBe('system');
  expect(allHaveWorkingDirectory(out[0].content)).toBe(true);
});

test('Array system content and the developer role are patched too', () => {
  const asArray = bridge.transformChatMessages([{ role: 'system', content: [{ type: 'text', text: kilo.slice(0, 80) }, { type: 'text', text: kilo.slice(80) }] }, { role: 'user', content: 'hi' }]);
  expect(allHaveWorkingDirectory(systemText(asArray))).toBe(true);
  expect(blocks(systemText(asArray))).toHaveLength(1);
  const developer = bridge.transformChatMessages([{ role: 'developer', content: kilo }, { role: 'user', content: 'hi' }]);
  expect(allHaveWorkingDirectory(systemText(developer))).toBe(true);
});

test('Applying the patch twice changes nothing more', () => {
  const once = bridge.withHarnessEnvBlock(kilo);
  expect(bridge.withHarnessEnvBlock(once)).toBe(once);
});

test('Responses-style instructions reach the upstream with a working directory', () => {
  expect(allHaveWorkingDirectory(bridge.extractSystemInstructions([], kilo))).toBe(true);
});
