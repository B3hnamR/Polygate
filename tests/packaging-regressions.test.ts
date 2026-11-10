import { expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

// Source contracts only: do not invoke builds, installers, services or downloaded runtimes.
const root = path.resolve(import.meta.dir, '..');
const read = (file: string) => readFileSync(path.join(root, file), 'utf8').replace(/\r\n/g, '\n');
const workflow = read('.github/workflows/release.yml');
const builder = read('scripts/build-desktop.ts');
const installer = read('install.sh');

test('Windows release uploads only the verified invocation, preserving the portable binary name', () => {
  const pkg = JSON.parse(read('package.json'));
  expect(pkg.build.win.artifactName).toBe('Polygate-${version}-Windows-x64.exe');
  expect(builder).toContain("path.join(root, 'release', `Polygate-${version}-${stamp}`)");
  expect(builder).toContain('if (existsSync(output)) throw new Error');
  expect(builder).toContain('`Polygate-${version}-Windows-x64.exe`');
  expect(builder).toContain("writeFileSync(exe + '.sha256'");
  expect(builder).toContain("path.relative(root, exe).split(path.sep).join('/')");
  expect(builder).toContain('appendFileSync(process.env.GITHUB_OUTPUT, `executable=${artifact}\\nchecksum=${artifact}.sha256\\n`)');
  expect(builder.indexOf('appendFileSync(process.env.GITHUB_OUTPUT')).toBeGreaterThan(builder.indexOf("writeFileSync(exe + '.sha256'"));
  const windows = workflow.slice(workflow.indexOf('\n  windows:'), workflow.indexOf('\n  draft-release:'));
  expect(windows).toMatch(/id: desktop\s+run: bun run dist/);
  expect(windows).toContain('${{ steps.desktop.outputs.executable }}');
  expect(windows).toContain('${{ steps.desktop.outputs.checksum }}');
  expect(windows).toContain('if-no-files-found: error');
  expect(windows).not.toMatch(/release\/[^\n]*\*|Get-ChildItem/);
});

test('Docker copies the favicon public directory before building the UI', () => {
  const ui = read('Dockerfile').split('\nFROM oven/bun:')[0];
  expect(read('index.html')).toContain('href="/favicon.svg"');
  expect(existsSync(path.join(root, 'public/favicon.svg'))).toBe(true);
  expect(ui).toContain('COPY public ./public');
  expect(ui.indexOf('COPY public ./public')).toBeLessThan(ui.indexOf('RUN npm run build:ui'));
});

test('fresh non-TLS choices reconcile retained HTTPS before any service startup, never on update', () => {
  const main = installer.slice(installer.indexOf('\nmain() {'));
  expect(main).toContain("grep -Fq 'https-disable-offline'");
  expect(main.indexOf("grep -Fq 'https-disable-offline'")).toBeLessThan(main.indexOf('install_release'));
  expect(main).toContain('if [ "$UPDATE" = 0 ]; then\n    case "$MODE" in local|proxy|http) https_disable ;; esac\n  fi\n  start_service');
  expect(main.indexOf('configure_service')).toBeLessThan(main.indexOf('https_disable'));
  expect(main.indexOf('https_disable')).toBeLessThan(main.indexOf('start_service'));
  const disable = installer.slice(installer.indexOf('\nhttps_disable() {'), installer.indexOf('\nhttps_setup() {'));
  expect(disable).toContain('systemctl daemon-reload && systemctl stop polygate || die');
  expect(disable).toContain('systemctl is-active --quiet polygate');
  expect(disable).toContain('runuser -u polygate --preserve-environment -- "$release/bin/bun" "$release/build/manage.js" https-disable-offline --service-stopped');
  expect(disable.indexOf('systemctl stop polygate')).toBeLessThan(disable.indexOf('https-disable-offline'));
  expect(disable).toContain('|| die');
  expect(disable).not.toMatch(/\brm\b|\bchown\b/);
  // Updates continue to preserve operator-managed host/proxy/cookie/HTTPS settings.
  expect(installer).toContain('if [ "$UPDATE" = 1 ] && [ -f /etc/polygate/polygate.env ]; then src=/etc/polygate/polygate.env; fi');
  expect(installer).toContain('MODE=; FW_PORTS=');
});

test('offline HTTPS reconciliation changes only the HTTPS mode and preserves stored certificates', () => {
  const manager = read('backend/manage.ts');
  const start = manager.indexOf("if(command==='https-disable-offline')");
  expect(start).toBeGreaterThan(0);
  const end = manager.indexOf('\n  if(', start + 1);
  const disable = manager.slice(start, end === -1 ? undefined : end);
  expect(disable).toContain("mode:'off'");
  expect(disable).toContain('persist()');
  expect(disable).toContain('settings.https');
  expect(disable).toContain('--service-stopped');
  expect(disable).not.toMatch(/unlink|rmSync|settings\s*=\s*initialSettings/);
});

test('active packaging docs use current environment, command, service and repository names', () => {
  for (const file of ['docs/LINUX.md', 'docs/BUILD.md', 'docs/VERIFICATION.md', 'docs/README.md']) {
    expect({ file, obsolete: /OCGATE_|\bocgate\b/i.test(read(file)) }).toEqual({ file, obsolete: false });
  }
  const linux = read('docs/LINUX.md');
  expect(linux).toContain('B3hnamR/Polygate');
  expect(linux).toContain('/etc/polygate/polygate.env');
  expect(linux).toContain('sudo polygate https disable');
  expect(linux).toContain('docker compose logs polygate');
});

test('verification distinguishes dated evidence from current instructions and isolates desktop smoke data', () => {
  const verification = read('docs/VERIFICATION.md');
  expect(verification).toContain('2026-10-25');
  expect(verification).toContain('2026-10-26');
  expect(verification).toContain('102 passed, 0 skipped, 0 failed, 715 assertions');
  expect(verification).toContain('source-reviewed only');
  expect(verification).toContain("$env:POLYGATE_DESKTOP_SMOKE = '1'");
  expect(verification).toContain('$env:POLYGATE_USER_DATA = Join-Path');
  expect(verification).toContain('[guid]::NewGuid()');
  expect(verification).toContain('not `POLYGATE_STATE` alone');
  expect(verification).toContain('not a network sandbox');
});
