import { expect, test } from 'bun:test';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
// The agent workspace runs the real OpenCode CLI (2.0.32) on Windows. Its tools must reach OpenCode Free unchanged: the bridge keeps a
// client tool only when it matches the identity profile, and the profile renders OpenCode's `shell` description for Linux ("Commands run
// on Linux using bash."), while the real CLI on Windows says "Commands run on Windows using pwsh." So the genuine tool was renamed to
// `shell_client` and a placeholder `shell` was added, with a note telling the model not to call it.
process.env.AUTO_UPDATE = '0';
process.env.OPENCODE_BRIDGE_STATE_DIR = mkdtempSync(join(tmpdir(), 'polygate-shell-tool-'));
const bridge = require('../vendor/bridge/server.js');

// Captured from OpenCode 2.0.32 (@opencode/cli-windows-x64) on Windows 11, pointed at Polygate: the tool list of its first request.
const real: any[] = JSON.parse(readFileSync(join(import.meta.dir, 'fixtures', 'opencode-2.0.32-windows-tools.json'), 'utf8'));
const MODEL = 'deepseek-v4.1-flash-free';
const names = (tools: any[]) => tools.map(t => t.function?.name ?? t.name);
const shellOf = (tools: any[]) => tools.find(t => (t.function?.name ?? t.name) === 'shell');
const withShellDescription = (description: string) => real.map(t => t.function?.name === 'shell' ? { ...t, function: { ...t.function, description } } : t);

test('The real OpenCode CLI on Windows reaches OpenCode Free with its own tools, nothing renamed or added', () => {
  const out = bridge.prepareToolsWithFingerprint(real, false, null, MODEL);
  expect(names(out.tools)).toEqual(names(real));
  expect(out.appended).toEqual([]);
  expect(out.placeholderNote).toBe('');
  expect([...out.originalToAlias.keys()]).toEqual([]);
  expect(shellOf(out.tools).function.description).toContain('Commands run on Windows using pwsh.');
});

test('Any platform sentence the CLI writes, or none (an unknown shell), is still the genuine shell tool', () => {
  const linux = shellOf(real).function.description.replace('Commands run on Windows using pwsh.', 'Commands run on Linux using bash.');
  const mac = shellOf(real).function.description.replace('Commands run on Windows using pwsh.', 'Commands run on macOS using zsh.');
  const exe = shellOf(real).function.description.replace('using pwsh.', 'using powershell.exe.');
  const none = shellOf(real).function.description.replace('Commands run on Windows using pwsh. ', '');
  for (const description of [linux, mac, exe, none]) {
    const out = bridge.prepareToolsWithFingerprint(withShellDescription(description), false, null, MODEL);
    expect(names(out.tools)).toEqual(names(real));
    expect(out.appended).toEqual([]);
    expect(shellOf(out.tools).function.description).toBe(description);
  }
});

test('A shell tool that differs anywhere else is still not taken for the real one', () => {
  const reworded = withShellDescription(shellOf(real).function.description.replace('Quote file paths', 'Always quote file paths'));
  const extraParam = real.map(t => t.function?.name === 'shell'
    ? { ...t, function: { ...t.function, parameters: { ...t.function.parameters, properties: { ...t.function.parameters.properties, sudo: { type: 'boolean' } } } } } : t);
  for (const tools of [reworded, extraParam]) {
    const out = bridge.prepareToolsWithFingerprint(tools, false, null, MODEL);
    expect(names(out.tools)).toContain('shell_client');
    expect(out.appended).toEqual(['shell']);
  }
});
