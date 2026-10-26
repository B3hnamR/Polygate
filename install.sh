#!/usr/bin/env bash
# Polygate Linux installer. Downloads only a checksummed release; never executes a downloaded install dependency.
set -euo pipefail
umask 077
REPO=${POLYGATE_REPO:-B3hnamR/Polygate}
VERSION=${POLYGATE_VERSION:-latest}
UPDATE=0
case "${1:-}" in
  --help|-h)
    cat <<'HELP'
Polygate Linux installer (systemd, Python 3.11+, x86_64 or arm64).
  sudo bash install.sh                    interactive install
  sudo bash install.sh --update           keep credentials, settings, certificates and data
Environment: POLYGATE_REPO=owner/repo, POLYGATE_VERSION=latest|v0.1.0,
POLYGATE_SSL_MODE=ip|domain|custom|skip, POLYGATE_DOMAIN, POLYGATE_IP, POLYGATE_EMAIL,
POLYGATE_CERT_FILE, POLYGATE_KEY_FILE, POLYGATE_PORT, POLYGATE_ADMIN_PASSWORD,
Offline verification: POLYGATE_ARCHIVE=/path/release.tar.gz POLYGATE_CHECKSUM=/path/release.tar.gz.sha256
HELP
    exit 0 ;;
  --update) UPDATE=1 ;;
  '') ;;
  *) echo 'Unknown option; use --help.' >&2; exit 2 ;;
esac
[ "$(id -u)" -eq 0 ] || { echo 'Run with sudo or as root.' >&2; exit 1; }
[ "$(uname -s)" = Linux ] || { echo 'This installer targets Linux; use the Windows portable executable on Windows.' >&2; exit 1; }
[[ "$REPO" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] || { echo 'Invalid owner/repository.' >&2; exit 1; }
[[ "$VERSION" =~ ^[A-Za-z0-9_.-]+$ ]] || { echo 'Invalid release version.' >&2; exit 1; }
command -v systemctl >/dev/null && [ -d /run/systemd/system ] || { echo 'A running systemd installation is required. For containers/non-systemd systems use the Docker image.' >&2; exit 1; }
case "$(uname -m)" in x86_64|amd64) ARCH=amd64;; aarch64|arm64) ARCH=arm64;; *) echo 'Supported architectures: amd64, arm64.' >&2; exit 1;; esac
if [ "${POLYGATE_SKIP_DEPS:-0}" != 1 ]; then
  # Packages are installed only when something is missing, so a configured server is not changed (on Arch, pacman -Syu would
  # upgrade the whole system). pip is not needed: python3 is only used for small checks.
  missing=0; for c in curl tar python3 runuser; do command -v "$c" >/dev/null || missing=1; done; [ -d /etc/ssl/certs ] || missing=1
  if [ "$missing" = 0 ]; then :
  elif command -v apt-get >/dev/null; then export DEBIAN_FRONTEND=noninteractive; apt-get update -qq; apt-get install -y curl ca-certificates tar python3 util-linux;
  elif command -v dnf >/dev/null; then dnf install -y curl ca-certificates tar python3 util-linux;
  elif command -v yum >/dev/null; then yum install -y curl ca-certificates tar python3 util-linux;
  elif command -v pacman >/dev/null; then pacman -Syu --noconfirm --needed curl ca-certificates tar python util-linux;
  else echo 'Install curl, ca-certificates, tar, Python 3.11+, and util-linux first; rerun with POLYGATE_SKIP_DEPS=1.' >&2; exit 1; fi
fi
python3 -c 'import sys; assert sys.version_info >= (3,11), "Python 3.11+ is required (Ubuntu 24.04/Debian 12 or newer recommended)"'
command -v runuser >/dev/null || { echo 'runuser from util-linux is required.' >&2; exit 1; }
PASSWORD_SUPPLIED=0
if [ -n "${POLYGATE_ADMIN_PASSWORD:-}" ] && [ ! -f /var/lib/polygate/settings.vault ]; then
  # backend/manage.ts trims the value and rejects fewer than 12 characters. Checking here keeps a short password from failing after the release is switched.
  plen=$(python3 -c 'import os;print(len(os.environ["POLYGATE_ADMIN_PASSWORD"].strip().encode("utf-16-le","replace"))//2)')
  if [ "$plen" -gt 0 ] && [ "$plen" -lt 12 ]; then echo 'POLYGATE_ADMIN_PASSWORD must contain at least 12 characters. Nothing was installed.' >&2; exit 1; fi
  if [ "$plen" -gt 0 ]; then PASSWORD_SUPPLIED=1; fi
fi
work=$(mktemp -d /tmp/polygate-install.XXXXXXXX)
cleanup() { case "$work" in /tmp/polygate-install.*) rm -rf -- "$work";; esac; }
trap cleanup EXIT
asset="polygate-linux-$ARCH.tar.gz"
if [ -n "${POLYGATE_ARCHIVE:-}" ]; then
  cp -- "$POLYGATE_ARCHIVE" "$work/$asset"
  cp -- "${POLYGATE_CHECKSUM:-$POLYGATE_ARCHIVE.sha256}" "$work/$asset.sha256"
else
  if [ "$VERSION" = latest ]; then base="https://github.com/$REPO/releases/latest/download"; else base="https://github.com/$REPO/releases/download/$VERSION"; fi
  curl -fL --retry 3 --connect-timeout 15 "$base/$asset" -o "$work/$asset"
  curl -fL --retry 3 --connect-timeout 15 "$base/$asset.sha256" -o "$work/$asset.sha256"
fi
# Verify the digest and validate EVERY archive member before extracting. No absolute paths, traversal or links.
python3 - "$work/$asset" "$work/$asset.sha256" "$work" <<'PY'
import hashlib,pathlib,re,sys,tarfile
archive,checksum,dest=map(pathlib.Path,sys.argv[1:])
expected=checksum.read_text().split()[0]
if not re.fullmatch('[a-fA-F0-9]{64}',expected) or hashlib.file_digest(archive.open('rb'),'sha256').hexdigest()!=expected.lower():
    raise SystemExit('Release checksum mismatch; nothing installed')
with tarfile.open(archive) as tf:
    members=tf.getmembers()
    if len(members)>20000 or sum(m.size for m in members)>1500000000: raise SystemExit('Release archive exceeds limits')
    for m in members:
        p=pathlib.PurePosixPath(m.name)
        if p.is_absolute() or '..' in p.parts or not p.parts or p.parts[0]!='polygate' or not(m.isfile() or m.isdir()):
            raise SystemExit('Unsafe archive member: '+m.name)
    tf.extractall(dest,**({'filter':'data'} if hasattr(tarfile,'data_filter') else {}))
PY
for required in bin/bun build/gateway.js build/manage.js dist/index.html install/polygate.service install/polygate; do
  [ -f "$work/polygate/$required" ] || { echo "Release is missing $required" >&2; exit 1; }
done
"$work/polygate/bin/bun" --version >/dev/null
mkdir -p /opt/polygate/releases /etc/polygate
chmod 0755 /opt/polygate /opt/polygate/releases
chmod 0700 /etc/polygate
if ! id polygate >/dev/null 2>&1; then useradd --system --home-dir /var/lib/polygate --shell /usr/sbin/nologin polygate; fi
install -d -m 0700 -o polygate -g polygate /var/lib/polygate
if [ -f /etc/polygate/polygate.env ]; then set -a; . /etc/polygate/polygate.env; set +a; fi
PORT=${POLYGATE_PORT:-$(python3 -c 'import secrets; print(20000+secrets.randbelow(30000))')}
[[ "$PORT" =~ ^[0-9]+$ ]] && [ "$PORT" -ge 1024 ] && [ "$PORT" -le 65535 ] || { echo 'POLYGATE_PORT must be 1024..65535.' >&2; exit 1; }
if [ "$UPDATE" = 0 ] && [ -t 0 ] && [ -z "${POLYGATE_SSL_MODE:-}" ]; then
  printf '\nHTTPS setup: 1) domain  2) public IP (default)  3) custom PEM  4) skip\n'
  read -r -p 'Choose [2]: ' choice
  case "$choice" in 1) POLYGATE_SSL_MODE=domain;read -r -p 'Domain: ' POLYGATE_DOMAIN;; 3) POLYGATE_SSL_MODE=custom;read -r -p 'Certificate file: ' POLYGATE_CERT_FILE;read -r -p 'Private key file: ' POLYGATE_KEY_FILE;; 4) POLYGATE_SSL_MODE=skip;; ''|2) POLYGATE_SSL_MODE=ip;; *) echo 'Invalid HTTPS choice.' >&2; exit 1;; esac
fi
if [ "$UPDATE" = 1 ]; then SSL_MODE=skip; else SSL_MODE=${POLYGATE_SSL_MODE:-ip}; fi
case "$SSL_MODE" in ip|domain|custom|skip) ;; *) echo 'Unknown POLYGATE_SSL_MODE.' >&2; exit 1;; esac
if [ "$SSL_MODE" = domain ]; then [ -n "${POLYGATE_DOMAIN:-}" ] || { echo 'Set POLYGATE_DOMAIN.' >&2; exit 1; }; fi
if [ "$SSL_MODE" = custom ]; then [ -r "${POLYGATE_CERT_FILE:-}" ] && [ -r "${POLYGATE_KEY_FILE:-}" ] || { echo 'Set readable POLYGATE_CERT_FILE and POLYGATE_KEY_FILE.' >&2; exit 1; }; fi
release="/opt/polygate/releases/$(date +%Y%m%d%H%M%S)-$$"
mv -- "$work/polygate" "$release"
chown -R root:root "$release"
chmod 0755 "$release/bin/bun" "$release/install/polygate"
# The service user must traverse immutable application/runtime files; only its state is private.
chmod -R a+rX "$release"
old=$(readlink /opt/polygate/current || true)
ln -sfnT "$release" /opt/polygate/.current-new; mv -Tf /opt/polygate/.current-new /opt/polygate/current
# The installer owns the paths, the repository and the port of this run. On --update every other line (POLYGATE_TRUST_PROXY, POLYGATE_COOKIE_SECURE,
# POLYGATE_HTTP(S)_PORT, a custom POLYGATE_ALLOWED_HOSTS, ...) is kept as the operator left it.
render_env() {
  local src=$1 kept
  kept=$(grep -Ev '^[[:space:]]*POLYGATE_(REPO|APP_DIR|PORT|STATE|UI_DIST)[[:space:]]*=' "$src" || true)
  printf 'POLYGATE_REPO=%q\nPOLYGATE_APP_DIR=/opt/polygate/current\nPOLYGATE_PORT=%s\n' "$REPO" "$PORT"
  printf 'POLYGATE_STATE=/var/lib/polygate\nPOLYGATE_UI_DIST=/opt/polygate/current/dist\n'
  [ -z "$kept" ] || printf '%s\n' "$kept"
  grep -Eq '^[[:space:]]*POLYGATE_HOST[[:space:]]*=' <<<"$kept" || printf 'POLYGATE_HOST=0.0.0.0\n'
  grep -Eq '^[[:space:]]*POLYGATE_ALLOWED_HOSTS[[:space:]]*=' <<<"$kept" || printf 'POLYGATE_ALLOWED_HOSTS=\\*\n'
}
env_source=/dev/null; if [ "$UPDATE" = 1 ] && [ -f /etc/polygate/polygate.env ]; then env_source=/etc/polygate/polygate.env; fi
render_env "$env_source" > /etc/polygate/polygate.env.new
chmod 0600 /etc/polygate/polygate.env.new
mv -f /etc/polygate/polygate.env.new /etc/polygate/polygate.env
install -m 0644 "$release/install/polygate.service" /etc/systemd/system/polygate.service
install -m 0755 "$release/install/polygate" /usr/local/bin/polygate
export POLYGATE_APP_DIR=/opt/polygate/current POLYGATE_STATE=/var/lib/polygate POLYGATE_PORT="$PORT"
if [ ! -f /var/lib/polygate/settings.vault ]; then
  printf '%s' "${POLYGATE_ADMIN_PASSWORD:-}" | runuser -u polygate --preserve-environment -- "$release/bin/bun" "$release/build/manage.js" password --stdin
  if [ "$PASSWORD_SUPPLIED" = 1 ]; then rm -f /var/lib/polygate/admin-password.txt; fi
fi
systemctl daemon-reload
systemctl enable polygate
systemctl restart polygate
ready=0
for _ in $(seq 1 30); do if /usr/local/bin/polygate health >/dev/null 2>&1; then ready=1; break; fi; sleep 1; done
if [ "$ready" = 0 ]; then
  echo 'Gateway did not become healthy. See: journalctl -u polygate -n 100' >&2
  if [[ "$old" = /opt/polygate/releases/* ]] && [ -d "$old" ]; then ln -sfnT "$old" /opt/polygate/.current-old; mv -Tf /opt/polygate/.current-old /opt/polygate/current; systemctl restart polygate; echo 'Restored the previous release.' >&2; fi
  exit 1
fi
address=${POLYGATE_IP:-$(curl -fsS --max-time 6 https://api.ipify.org || printf 'SERVER-IP')}
dashboard="http://$address:$PORT/"
if [ "$SSL_MODE" != skip ]; then
  echo 'Setting up built-in HTTPS (no Caddy required). Public port 80 must reach this machine.'
  case "$SSL_MODE" in
    ip) polygate https ip "${POLYGATE_IP:-}" "${POLYGATE_EMAIL:-}" > "$work/https.json";;
    domain) polygate https domain "$POLYGATE_DOMAIN" "${POLYGATE_EMAIL:-}" > "$work/https.json";;
    custom) polygate https custom "$POLYGATE_CERT_FILE" "$POLYGATE_KEY_FILE" > "$work/https.json";;
  esac
  success=0
  for _ in $(seq 1 90); do
    polygate https status > "$work/https.json" 2>/dev/null || true
    status=$(python3 - "$work/https.json" <<'PY'
import json,sys
try:
 d=json.load(open(sys.argv[1]));print('wait' if d.get('job',{}).get('running') else 'ok' if d.get('active') else 'error')
except Exception: print('wait')
PY
    )
    if [ "$status" = ok ]; then dashboard=$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["url"])' "$work/https.json");success=1;break;fi
    if [ "$status" = error ]; then break; fi
    sleep 2
  done
  if [ "$success" = 0 ]; then echo 'Polygate is installed, but HTTPS setup failed. Inspect: polygate https status. Check port 80 and DNS, then retry.' >&2; exit 1; fi
fi
printf '\nPolygate is running: %s\nManage: polygate status / logs / password / https / update\n' "$dashboard"
if [ "$PASSWORD_SUPPLIED" = 1 ]; then printf 'Dashboard password: the POLYGATE_ADMIN_PASSWORD you supplied (not stored in a file).\n'
elif [ -f /var/lib/polygate/admin-password.txt ]; then printf 'Dashboard password: ';cat /var/lib/polygate/admin-password.txt;fi
printf 'Configuration: /etc/polygate/polygate.env (0600). User data: /var/lib/polygate\n'
