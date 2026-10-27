import { test, expect } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
// The Linux installer cannot be run on every machine that runs the tests, but its promises can be checked: it is valid shell, it needs no Python,
// and it never changes a firewall. (The real behaviour was exercised in clean Linux containers: busy ports, a foreign service, update, uninstall.)
const root = path.resolve(import.meta.dir, '..');
const read = (f: string) => readFileSync(path.join(root, f), 'utf8').replace(/\r\n/g, '\n');
const hasBash = spawnSync('bash', ['--version']).status === 0;
const shellTest = hasBash ? test : test.skip;
const installer = read('install.sh'), command = read('install/polygate');

shellTest('the installer and the polygate command are valid bash', () => {
  for (const file of ['install.sh', 'install/polygate']) {
    const r = spawnSync('bash', ['-n', path.join(root, file).replace(/\\/g, '/')], { encoding: 'utf8' });
    expect({ file, status: r.status, error: r.stderr }).toEqual({ file, status: 0, error: '' });
  }
});
test('neither script needs Python', () => {
  expect(installer).not.toMatch(/python/i); expect(command).not.toMatch(/python/i);
});
test('the installer never changes a firewall: it only prints commands', () => {
  // A command that would run (a line starting with the tool, or passed to run()) would be a change; building the hint text is not.
  expect(installer).not.toMatch(/^\s*(sudo\s+)?(ufw|firewall-cmd|iptables|nft)\s+\S/m);
  expect(installer).not.toMatch(/\brun\s+(['\"])[^'\"\n]*\1\s+(sudo\s+)?(ufw|firewall-cmd|iptables|nft)\b/); // run \"message\" command ...
  expect(installer).not.toMatch(/--open-firewall|installer-changes|POLYGATE_OPEN_FIREWALL/);
  expect(command).not.toMatch(/\b(ufw|firewall-cmd|iptables)\b/);
});
test('packages are only added, never upgraded', () => {
  expect(installer).not.toMatch(/-Syu|full-upgrade|dist-upgrade|\bupgrade\b/);
  expect(installer).toMatch(/pacman -S --noconfirm --needed/);
});
test('the installer verifies the download before anything is unpacked or installed', () => {
  const at = (needle: string) => installer.indexOf(needle);
  expect(at('sha256sum "$work/$asset"')).toBeGreaterThan(0);
  expect(at('sha256sum "$work/$asset"')).toBeLessThan(at('tar -xzf "$work/$asset"'));
  expect(at('tar -xzf "$work/$asset"')).toBeLessThan(at('mkdir -p /opt/polygate/releases'));
  expect(installer).toMatch(/links or special files/); expect(installer).toMatch(/entries outside polygate\//);
});
test('names that belong to something else are refused, not overwritten', () => {
  for (const guard of ['A different service named polygate.service', "/usr/local/bin/polygate already exists", '/opt/polygate already exists', 'was not created by this installer']) expect(installer).toContain(guard);
});
test('help lists every way of opening the dashboard and the main options', () => {
  const help = installer.slice(installer.indexOf("cat <<'HELP'"), installer.indexOf('\nHELP\n'));
  for (const word of ['domain', 'ip ', 'proxy', 'custom', 'local', 'http', '--check', '--update', '--yes', '--https', '--domain', '--cert', '--key', '--https-port']) expect(help).toContain(word);
});
test('automatic HTTPS is refused when ports 80 and 443 are not both free, and the way out is explained', () => {
  expect(installer).toContain('ports 80 and 443 must both be free');
  expect(installer).toContain('address already in use');
  expect(installer).toContain('behind the web server I already run');
});
test('the polygate command reads certificate files as root and hands them over on stdin', () => {
  expect(command).toContain('cat "$2" "$3" | control https-apply custom -');
});

// ---- the look and the manager
const uiBlock = (text: string) => text.slice(text.indexOf('# ---- ui:begin'), text.indexOf('# ---- ui:end') + '# ---- ui:end'.length);
test('the installer and the manager share one identical look (banner, colours, symbols)', () => {
  expect(uiBlock(installer).length).toBeGreaterThan(500);
  expect(uiBlock(installer)).toBe(uiBlock(command));
  expect(uiBlock(installer)).toContain('██████╗  ██████╗ ██╗');   // the big POLYGATE name
});
test('the installer asks before it starts, checks quietly into a log, and only then asks about access', () => {
  const main = installer.slice(installer.indexOf('\nmain() {'));
  const at = (needle: string) => main.indexOf(needle);
  expect(at('Press Enter to start, or q to quit')).toBeGreaterThan(0);
  expect(at('Press Enter to start')).toBeLessThan(at("spin_start 'Checking the system and installing dependencies'"));
  expect(at('QUIET=1')).toBeLessThan(at('preflight\n  spin_stop'));
  expect(at('choose_mode')).toBeGreaterThan(at('install_packages'));
  expect(at("confirm 'Install now?'")).toBeLessThan(at('fetch_release\n'));
  expect(installer).toContain('Nothing changes until you press Enter');
});
test('the manager has Start/Restart, Stop and Uninstall (with a typed confirmation), HTTPS, update and health', () => {
  for (const item of ['Dashboard address and password', 'Health check', 'Live logs', 'Restart', 'Stop', 'HTTPS and certificate', 'Change the dashboard password', 'Update Polygate', 'Uninstall']) expect(command).toContain(item);
  expect(command).toContain('Type  delete  to confirm');
  expect(command).toMatch(/Remove Polygate and keep my data and settings/); expect(command).toMatch(/Remove everything, including my data/);
  expect(command).toMatch(/cmd_stop\(\)/); expect(command).toMatch(/cmd_uninstall\(\)/);
});
test('running polygate with no command opens the manager on a terminal and prints help otherwise; sudo is requested for the user', () => {
  expect(command).toMatch(/menu\) if \[ -t 0 \] && \[ -t 1 \]; then manager; else usage; fi/);
  expect(command).toContain('exec sudo -- "$0" "$@"');
});
test('the dashboard path is set for a new install and shown in every address', () => {
  expect(installer).toMatch(/DASHBOARD_PATH=\$\{POLYGATE_DASHBOARD_PATH-\/polygate\}/);
  expect(installer).toContain("POLYGATE_DASHBOARD_PATH=%s");
  expect(installer).toContain('location $path {');           // the nginx example keeps the other paths of the site free
  expect(command).toContain('${url%/}/v1');
});
