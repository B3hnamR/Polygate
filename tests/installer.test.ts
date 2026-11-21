import { test, expect } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync, statSync } from 'node:fs';
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
    // A relative path from the project folder: on Windows the bash on PATH can be WSL's, which cannot open a C:/ path.
    const r = spawnSync('bash', ['-n', file], { encoding: 'utf8', cwd: root });
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

test('a fresh install over the settings file left by a data-preserving uninstall keeps that file beside the new one', () => {
  expect(installer).toContain('/etc/polygate/polygate.env.before-reinstall-');
  expect(installer.indexOf('before-reinstall-')).toBeLessThan(installer.indexOf('render_env "$src" >/etc/polygate/polygate.env.new'));
});
test('polygate password refuses before it stops anything when the password is set by POLYGATE_ADMIN_PASSWORD', () => {
  const fn = command.slice(command.indexOf('cmd_password()')); const guard = fn.indexOf('POLYGATE_ADMIN_PASSWORD');
  expect(guard).toBeGreaterThan(0); expect(guard).toBeLessThan(fn.indexOf('systemctl stop polygate'));
});

// Run only the transaction, in a private Linux scratch tree. No installer entry point,
// package manager, release executable, service manager or network operation is invoked.
for (const stop of ['snapshot', 'before-switch', 'configure', 'health', 'recovery', 'after-health', 'fresh'] as const) {
  test.skipIf(process.platform !== 'linux')(`installer transaction: ${stop}`, () => {
    const scratch = mkdtempSync('/tmp/polygate-txn-');
    try {
      const steps = installer.slice(installer.indexOf('\ninstall_release()'), installer.indexOf('\nfirewall_hint()'))
        + installer.slice(installer.indexOf('\non_exit()'), installer.indexOf('\nshow_issues()'));
      const script = `set -Eeuo pipefail
umask 077
${steps.replace(/\/(opt|etc|usr\/local|var\/lib)\//g, `${scratch}/$1/`)}
UPDATE=1; CHECK=0; STARTED=0; old=; release=; REPO=fixture; PORT=12345; LOG=/dev/null
work=$PWD/work; app=$PWD/opt/polygate; state=$PWD/var/lib/polygate
envfile=$PWD/etc/polygate/polygate.env; unit=$PWD/etc/systemd/system/polygate.service; cli=$PWD/usr/local/bin/polygate
mkdir -p "$app/releases/previous" "$work/polygate"/{bin,install} "$state" "$PWD/etc/polygate" "$PWD/etc/systemd/system" "$PWD/usr/local/bin"
touch "$state/settings.vault" "$work/polygate/bin/bun"
printf new-unit >"$work/polygate/install/polygate.service"; printf new-cli >"$work/polygate/install/polygate"
printf 'POLYGATE_PORT=10\\n' >"$envfile"; chmod 0640 "$envfile"
printf old-unit >"$PWD/etc/systemd/system/custom-unit"; ln -s custom-unit "$unit"
if [ "$STOP" = fresh ]; then UPDATE=0; MODE=local; DASHBOARD_PATH=; else ln -s releases/previous "$app/current"; fi
if [ "$STOP" = snapshot ]; then mkdir "$cli"; fi
id() { return 0; }; chown() { [ "$STOP" != before-switch ] || return 72; }
install() { if [ "$1" != -d ]; then command install "$@"; fi; }
systemctl() { printf '%s:%s\\n' "$*" "$(readlink "$app/current")" >>calls; }
wait_healthy() { [ "$STOP" != recovery ] && { [ "$STOP" != health ] || [ "$(readlink "$app/current")" = releases/previous ]; }; }
run() { shift; "$@"; }; journalctl() { :; }; cleanup() { :; }; spin_stop() { :; }
say() { :; }; note() { :; }; die() { exit 1; }
ok() { if [ "$1" = 'Installed Polygate' ] && { [ "$STOP" = configure ] || [ "$STOP" = fresh ]; }; then return 73; fi; }
trap on_exit EXIT
snapshot_managed
install_release
configure_service
start_service
exit 74`;
      const r = spawnSync('/bin/bash', ['--noprofile', '--norc', '-c', script], {
        cwd: scratch, env: { HOME: scratch, PATH: '/usr/bin:/bin', LC_ALL: 'C', STOP: stop }, encoding: 'utf8', timeout: 5000,
      });
      expect({ error: r.error?.message, status: r.status }).toEqual({ error: undefined,
        status: { snapshot: 1, 'before-switch': 72, configure: 73, health: 1, recovery: 1, 'after-health': 74, fresh: 73 }[stop] });
      const committed = stop === 'after-health' || stop === 'fresh';
      const link = readlinkSync(`${scratch}/opt/polygate/current`);
      if (committed) expect(link).toStartWith(`${scratch}/opt/polygate/releases/`);
      else expect(link).toBe('releases/previous');
      const envfile = `${scratch}/etc/polygate/polygate.env`, unit = `${scratch}/etc/systemd/system/polygate.service`;
      if (committed) {
        expect(readFileSync(envfile, 'utf8')).toContain('POLYGATE_PORT=12345');
        expect(readFileSync(unit, 'utf8')).toBe('new-unit');
        expect(readFileSync(`${scratch}/usr/local/bin/polygate`, 'utf8')).toBe('new-cli');
      } else {
        expect(readFileSync(envfile, 'utf8')).toBe('POLYGATE_PORT=10\n');
        expect(statSync(envfile).mode & 0o777).toBe(0o640);
        expect(readlinkSync(unit)).toBe('custom-unit');
        expect(readFileSync(unit, 'utf8')).toBe('old-unit');
        expect(existsSync(`${scratch}/usr/local/bin/polygate`)).toBe(stop === 'snapshot');
      }
      const snapshots = readdirSync(`${scratch}/etc/polygate`).filter(f => f.startsWith('.before-update-'));
      expect(snapshots.length).toBe(stop === 'recovery' ? 1 : 0);
      if (stop === 'recovery') expect(r.stderr).toContain(snapshots[0]);
      const calls = existsSync(`${scratch}/calls`) ? readFileSync(`${scratch}/calls`, 'utf8') : '';
      if (stop === 'health' || stop === 'recovery') expect(calls).toEndWith('daemon-reload:releases/previous\nrestart polygate:releases/previous\n');
      else if (stop !== 'after-health') expect(calls).toBe('');
    } finally { rmSync(scratch, { recursive: true, force: true }); }
  });
}
