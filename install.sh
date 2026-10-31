#!/usr/bin/env bash
# Polygate Linux installer.
#
# It checks the machine first, shows what it will do, and asks before it does it. It verifies every download with SHA-256 and never runs
# downloaded code to install a dependency. It never stops, restarts or edits another service. The only things it creates are:
#   /opt/polygate (program files), /etc/polygate (settings), /var/lib/polygate (data), the system user "polygate",
#   /etc/systemd/system/polygate.service and /usr/local/bin/polygate. It never changes firewall rules: if a firewall is active it only
#   shows the commands you would run yourself.
set -Eeuo pipefail
umask 077

REPO=${POLYGATE_REPO:-B3hnamR/Polygate}
VERSION=${POLYGATE_VERSION:-latest}
UPDATE=0; CHECK=0; YES=0
SSL_MODE=${POLYGATE_SSL_MODE:-}
# The dashboard is served at https://server/polygate/ (set POLYGATE_DASHBOARD_PATH to another path, or to an empty value for the root).
DASHBOARD_PATH=${POLYGATE_DASHBOARD_PATH-/polygate}; DASHBOARD_PATH=${DASHBOARD_PATH%/}

usage() {
  cat <<'HELP'
Polygate Linux installer (systemd; x86_64 or arm64; glibc).

  sudo bash install.sh                 guided install
  sudo bash install.sh --check         look at this machine and report; changes nothing
  sudo bash install.sh --update        update to the newest release, keeping data, settings and certificates
  sudo bash install.sh --yes ...       no questions: use the options below (anything not given takes the safe default)

How people reach the dashboard (--https MODE, or POLYGATE_SSL_MODE):
  domain   automatic HTTPS for a domain name (needs --domain; ports 80 and 443 free; the name must point here)
  ip       automatic HTTPS for this server's public IP address (ports 80 and 443 free)
  proxy    behind a web server you already run (nginx, Caddy, Apache...): Polygate listens on 127.0.0.1 only
  custom   your own certificate files (--cert and --key); HTTPS on port 443, or another port with --https-port
  local    no HTTPS: listens on 127.0.0.1 only; reach it with an SSH tunnel (the safe default when --yes is used)
  http     plain HTTP on every interface (not recommended: the dashboard password would travel unencrypted)

Options: --domain NAME  --ip ADDRESS  --email ADDRESS  --cert FILE  --key FILE  --https-port N  --port N (dashboard port)
         --release vX.Y.Z  --no-color  -h|--help
Environment (same meaning): POLYGATE_REPO, POLYGATE_VERSION, POLYGATE_SSL_MODE, POLYGATE_DOMAIN, POLYGATE_IP, POLYGATE_EMAIL,
POLYGATE_CERT_FILE, POLYGATE_KEY_FILE, POLYGATE_HTTPS_PORT, POLYGATE_PORT, POLYGATE_ADMIN_PASSWORD (12+ characters),
POLYGATE_DASHBOARD_PATH (default /polygate; empty for the root), POLYGATE_SKIP_DEPS=1, POLYGATE_ARCHIVE=/path/release.tar.gz with POLYGATE_CHECKSUM=/path/release.tar.gz.sha256
(offline install).
HELP
}

while [ $# -gt 0 ]; do
  case "$1" in
    -h|--help) usage; exit 0 ;;
    --update) UPDATE=1 ;;
    --check|--dry-run) CHECK=1 ;;
    -y|--yes) YES=1 ;;
    --no-color) NO_COLOR=1 ;;
    --https) SSL_MODE=${2:?--https needs a mode}; shift ;;
    --domain) POLYGATE_DOMAIN=${2:?--domain needs a name}; shift ;;
    --ip) POLYGATE_IP=${2:?--ip needs an address}; shift ;;
    --email) POLYGATE_EMAIL=${2:?--email needs an address}; shift ;;
    --cert) POLYGATE_CERT_FILE=${2:?--cert needs a file}; shift ;;
    --key) POLYGATE_KEY_FILE=${2:?--key needs a file}; shift ;;
    --https-port) POLYGATE_HTTPS_PORT=${2:?--https-port needs a number}; shift ;;
    --port) POLYGATE_PORT=${2:?--port needs a number}; shift ;;
    --release) VERSION=${2:?--release needs a version such as v0.4.0}; shift ;;
    *) printf 'Unknown option: %s (see --help)\n' "$1" >&2; exit 2 ;;
  esac
  shift
done

# ---------------------------------------------------------------------------------------------------------------- output helpers
# ---- ui:begin (the same block is in install.sh and install/polygate; tests/installer.test.ts checks that they match)
if [ -t 1 ] && [ -z "${NO_COLOR:-}" ] && [ "${TERM:-dumb}" != dumb ]; then
  R=$'\033[0m'; B=$'\033[1m'; D=$'\033[2m'; RED=$'\033[31m'; GRN=$'\033[32m'; YEL=$'\033[33m'; CYN=$'\033[36m'; GBG=$'\033[42;30m'
else R=; B=; D=; RED=; GRN=; YEL=; CYN=; GBG=; fi
case "${LC_ALL:-${LC_CTYPE:-${LANG:-}}}" in
  *[Uu][Tt][Ff]-8*|*[Uu][Tt][Ff]8*) UTF=1; S_OK='✓'; S_BAD='✗'; S_WARN='!'; S_ON='●'; S_OFF='○'; S_GO='▸' ;;
  *) UTF=0; S_OK='+'; S_BAD='x'; S_WARN='!'; S_ON='*'; S_OFF='o'; S_GO='>' ;;
esac
# banner VERSION INFO: the big name with a gradient, then a line with the version, the tagline and a short status.
banner() {
  local ver=${1:-} info=${2:-} cols row i n ch line tc=0 step
  local -a art=(
    '██████╗  ██████╗ ██╗     ██╗   ██╗ ██████╗  █████╗ ████████╗███████╗'
    '██╔══██╗██╔═══██╗██║     ╚██╗ ██╔╝██╔════╝ ██╔══██╗╚══██╔══╝██╔════╝'
    '██████╔╝██║   ██║██║      ╚████╔╝ ██║  ███╗███████║   ██║   █████╗  '
    '██╔═══╝ ██║   ██║██║       ╚██╔╝  ██║   ██║██╔══██║   ██║   ██╔══╝  '
    '██║     ╚██████╔╝███████╗   ██║   ╚██████╔╝██║  ██║   ██║   ███████╗'
    '╚═╝      ╚═════╝ ╚══════╝   ╚═╝    ╚═════╝ ╚═╝  ╚═╝   ╚═╝   ╚══════╝'
  )
  local -a ramp=(86 80 81 75 75 111 105 141)
  cols=${COLUMNS:-$(tput cols 2>/dev/null || echo 80)}
  case "${COLORTERM:-}" in truecolor|24bit) tc=1 ;; esac
  printf '\n'
  if [ "$UTF" = 1 ] && [ -n "$R" ] && [ "$cols" -ge 72 ]; then
    for row in "${art[@]}"; do
      line=; n=${#row}
      for ((i = 0; i < n; i++)); do
        ch=${row:i:1}
        if [ "$ch" = ' ' ]; then line+=' '
        elif [ "$tc" = 1 ]; then line+=$'\033[38;2;'"$((94 + 30 * i / n));$((234 - 78 * i / n));$((212 + 43 * i / n))m$ch"
        else step=$((i * 8 / n)); line+=$'\033[38;5;'"${ramp[$step]}m$ch"; fi
      done
      printf '  %s%s\n' "$line" "$R"
    done
  else printf '  %s%sP O L Y G A T E%s\n' "$B" "$CYN" "$R"; fi
  printf '  %s%s%s%s  Free model gateway, made simple%s%s\n' "$GBG" "${ver:+ v$ver }" "$R" "$B" "$R" "${info:+   $D$info$R}"
  printf '  %smade by B3hnamR · github.com/B3hnamR/Polygate%s\n\n' "$D" "$R"
}
# kv LABEL VALUE [NOTE]: one aligned line of a summary
kv() { printf '    %s%-11s%s %s%s%s%s\n' "$D" "$1" "$R" "$B" "$2" "$R" "${3:+   $D$3$R}"; }
# ---- ui:end

FAILURES=0; WARNINGS=0; QUIET=0; ISSUES=
say()  { printf '%s\n' "$*"; }
ok()   { log_line "ok: $*"; [ "$QUIET" = 1 ] || printf '  %s%s%s %s\n' "$GRN" "$S_OK" "$R" "$*"; }
warn() { WARNINGS=$((WARNINGS + 1)); log_line "warn: $*"; if [ "$QUIET" = 1 ]; then ISSUES+="w|$*"$'\n'; else printf '  %s%s%s %s\n' "$YEL" "$S_WARN" "$R" "$*"; fi; }
bad()  { FAILURES=$((FAILURES + 1)); log_line "problem: $*"; if [ "$QUIET" = 1 ]; then ISSUES+="b|$*"$'\n'; else printf '  %s%s%s %s\n' "$RED" "$S_BAD" "$R" "$*"; fi; }
note() { log_line "note: $*"; [ "$QUIET" = 1 ] || printf '      %s%s%s\n' "$D" "$*" "$R"; }
heads_up() { if [ "$QUIET" = 1 ]; then log_line "note: $*"; else warn "$*"; fi; }   # worth showing in a report (--check), not during an install
title() { [ "$QUIET" = 1 ] || printf '\n%s%s%s\n' "$B" "$*" "$R"; }
die() { spin_stop; printf '\n  %s%s%s %s\n\n' "$RED" "$S_BAD" "$R" "$*" >&2; exit 1; }

# Questions go to the terminal even when the script itself arrives through a pipe (curl ... | sudo bash).
TTY=
if [ "$YES" = 0 ]; then
  if [ -t 0 ]; then TTY=/dev/stdin; elif { : </dev/tty; } 2>/dev/null; then TTY=/dev/tty; fi
fi
INTERACTIVE=0; [ -z "$TTY" ] || INTERACTIVE=1
ask() { # ask "Question" "default"  -> REPLY
  local prompt=$1 def=${2:-} ans=
  if [ "$INTERACTIVE" = 1 ]; then printf '  %s%s%s%s ' "$B" "$prompt" "$R" "${def:+ [$def]}" >&2; IFS= read -r ans <"$TTY" || ans=; fi
  REPLY=${ans:-$def}
}
confirm() { # confirm "Question" y|n  -> true/false. Without a terminal the default answer is taken.
  local def=${2:-y} ans
  [ "$INTERACTIVE" = 1 ] || { [ "$def" = y ]; return; }
  while :; do
    printf '  %s%s%s [%s] ' "$B" "$1" "$R" "$([ "$def" = y ] && echo Y/n || echo y/N)" >&2; IFS= read -r ans <"$TTY" || ans=
    case "${ans:-$def}" in y|Y|yes|YES) return 0 ;; n|N|no|NO) return 1 ;; esac
  done
}

# -------------------------------------------------------------------------------------------------------------- facts about the machine
LOG=/var/log/polygate-install.log
work=
cleanup() { case "$work" in /tmp/polygate-install.*) rm -rf -- "$work" ;; esac; }
trap cleanup EXIT
log_line() { printf '[%s] %s\n' "$(date '+%F %T')" "$*" >>"$LOG" 2>/dev/null || true; }

port_owner() { # prints the program listening on TCP port $1 ("?" if it cannot be named); prints nothing when the port is free
  local p=$1 line hex inode fd pid
  if command -v ss >/dev/null 2>&1; then
    line=$(ss -H -ltnp "sport = :$p" 2>/dev/null | head -n 1 || true)
    [ -n "$line" ] || return 0
    sed -n 's/.*users:(("\([^"]*\)".*/\1/p' <<<"$line" | head -n 1 | grep . || echo '?'
  else
    hex=$(printf '%04X' "$p")
    inode=$(awk -v h=":$hex" '$4 == "0A" && $2 ~ h "$" { print $10; exit }' /proc/net/tcp /proc/net/tcp6 2>/dev/null || true)
    [ -n "$inode" ] || return 0
    fd=$(find /proc/[0-9]*/fd -lname "socket:\[$inode\]" -print -quit 2>/dev/null || true)
    if [ -n "$fd" ]; then pid=${fd#/proc/}; pid=${pid%%/*}; cat "/proc/$pid/comm" 2>/dev/null || echo '?'; else echo '?'; fi
  fi
}
owner_words() { if [ "$1" = '?' ]; then echo 'another program'; elif is_webserver "$1"; then echo "$1 (a web server)"; else echo "$1"; fi; }
is_webserver() { case "$1" in nginx|apache2|httpd|caddy|traefik|haproxy|lighttpd|docker-proxy|envoy|openresty|litespeed|lsws|angie) return 0 ;; esac; return 1; }
detect_ip() {
  local u ip
  for u in https://1.1.1.1/cdn-cgi/trace https://api.ipify.org https://ifconfig.me/ip; do
    ip=$(curl -fsS --max-time 6 "$u" 2>/dev/null | sed -n 's/^ip=//p;/^[0-9.]*$/p' | head -n 1 || true)
    if [[ "$ip" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]]; then printf '%s' "$ip"; return 0; fi
  done
  return 1
}
private_v4() { [[ "$1" =~ ^(10\.|127\.|0\.|169\.254\.|192\.168\.|172\.(1[6-9]|2[0-9]|3[01])\.|100\.(6[4-9]|[7-9][0-9]|1[01][0-9]|12[0-7])\.) ]]; }
valid_domain() { [[ "$1" =~ ^([A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,63}$ ]] && [ "${#1}" -le 253 ]; }
valid_port() { [[ "$1" =~ ^[0-9]+$ ]] && [ "$1" -ge 1 ] && [ "$1" -le 65535 ]; }
pick_port() { # a random free port in 20000-49999
  local p i
  for i in $(seq 1 200); do
    p=$(( (RANDOM * 32768 + RANDOM) % 30000 + 20000 ))
    [ -z "$(port_owner "$p")" ] && { printf '%s' "$p"; return 0; }
  done
  return 1
}
ours_unit() { [ -f /etc/systemd/system/polygate.service ] && grep -q '^Description=Polygate model gateway' /etc/systemd/system/polygate.service; }
ours_cli() { [ -f /usr/local/bin/polygate ] && grep -q 'polygate-cli' /usr/local/bin/polygate; }
dir_busy() { [ -d "$1" ] && [ -n "$(ls -A "$1" 2>/dev/null)" ]; }

OS_NAME=unknown; OS_ID=unknown; ARCH=; PUBLIC_IP=; OWNER80=; OWNER443=; FW=; INSTALLED=0; INSTALLED_VERSION=; MISSING_CMDS=; PKGS=; PM=

run() { # run "message" command...   shows progress, keeps the full output in the log, prints the tail if it fails (RUN_SILENT=1: no line on success)
  local msg=$1; shift; local pid i=0 frames='|/-\'
  log_line "RUN $msg: $*"
  if [ -t 1 ]; then
    "$@" >>"$LOG" 2>&1 & pid=$!
    while kill -0 "$pid" 2>/dev/null; do printf '\r  %s %s ' "${frames:i++%4:1}" "$msg"; sleep 0.15; done
    if wait "$pid"; then printf '\r\033[K'; [ "${RUN_SILENT:-0}" = 1 ] || ok "$msg"; return 0; fi
    printf '\r\033[K'
  else
    if "$@" >>"$LOG" 2>&1; then [ "${RUN_SILENT:-0}" = 1 ] || ok "$msg"; return 0; fi
  fi
  bad "$msg"; tail -n 15 "$LOG" | sed 's/^/        /'; return 1
}
SPIN_PID=
spin_start() { # a spinner for work that runs in this shell (the checks set variables, so they cannot go to the background)
  if [ -t 1 ]; then
    ( i=0; frames='|/-\'; while :; do printf '\r  %s %s ' "${frames:i++%4:1}" "$1"; sleep 0.15; done ) & SPIN_PID=$!
  else printf '  %s %s\n' "$S_GO" "$1"; fi
}
spin_stop() { if [ -n "${SPIN_PID:-}" ]; then kill "$SPIN_PID" 2>/dev/null || true; wait "$SPIN_PID" 2>/dev/null || true; SPIN_PID=; printf '\r\033[K'; fi; }

detect_pm() { PM=; local p; for p in apt-get dnf yum pacman zypper; do if command -v "$p" >/dev/null 2>&1; then PM=$p; return; fi; done; }
pkg_for() {
  case "$1" in
    curl) echo curl ;; tar) echo tar ;; gzip) echo gzip ;; sha256sum) echo coreutils ;; runuser) echo util-linux ;;
    ss) case "$PM" in dnf|yum) echo iproute ;; *) echo iproute2 ;; esac ;;
    ca-certificates) echo ca-certificates ;;
  esac
}

preflight() {
  local kv major rest minor mem free path p
  title 'Checking this machine'
  if [ "$(id -u)" -eq 0 ]; then ok 'Running as root'
  elif [ "$CHECK" = 1 ]; then warn 'Not running as root: which program owns a port may be hidden. Use sudo for the full picture.'
  else bad 'Run this with sudo or as root'; fi

  if [ -r /etc/os-release ]; then
    OS_NAME=$(. /etc/os-release; printf '%s' "${PRETTY_NAME:-${NAME:-Linux}}"); OS_ID=$(. /etc/os-release; printf '%s' "${ID:-unknown}")
  fi
  case "$OS_ID" in
    ubuntu|debian|raspbian|linuxmint|fedora|rhel|centos|rocky|almalinux|ol|amzn|arch|manjaro|opensuse*|sles) ok "$OS_NAME" ;;
    *) warn "$OS_NAME is not one of the tested systems (Ubuntu, Debian, Fedora, RHEL family, Arch, openSUSE); it may still work" ;;
  esac
  case "$(uname -m)" in
    x86_64|amd64) ARCH=amd64 ;; aarch64|arm64) ARCH=arm64 ;;
    *) bad "CPU architecture $(uname -m) is not supported (amd64 and arm64 are)" ;;
  esac
  [ -z "$ARCH" ] || ok "CPU: $ARCH"
  if [ "$ARCH" = amd64 ] && [ -r /proc/cpuinfo ] && ! grep -qm1 ' avx2' /proc/cpuinfo; then
    warn 'This CPU does not report AVX2. The bundled runtime may refuse to start; if the install stops at the runtime check, pick a newer VPS CPU type or use Docker.'
  fi
  if ldd --version 2>&1 | grep -qi musl || ls /lib/ld-musl-* >/dev/null 2>&1; then bad 'This system uses musl libc (Alpine). The bundled runtime needs glibc: use the Docker image instead.'
  else ok 'glibc found'; fi
  kv=$(uname -r | sed 's/[^0-9.].*//'); major=${kv%%.*}; rest=${kv#*.}; minor=${rest%%.*}
  if [[ "$major" =~ ^[0-9]+$ ]] && [[ "$minor" =~ ^[0-9]+$ ]] && { [ "$major" -lt 5 ] || { [ "$major" -eq 5 ] && [ "$minor" -lt 6 ]; }; }; then warn "Linux kernel $kv is older than 5.6, which the runtime recommends"; fi
  if command -v systemctl >/dev/null 2>&1 && [ -d /run/systemd/system ]; then ok 'systemd is running'
  else bad 'systemd is not running. Containers and WSL without systemd should use the Docker image.'; fi

  mem=$(awk '/^MemTotal/ { print int($2 / 1024) }' /proc/meminfo 2>/dev/null || echo 0)
  if [ "${mem:-0}" -ge 512 ]; then ok "Memory: ${mem} MB"; else warn "Memory: ${mem:-0} MB. Polygate itself needs about 200 MB."; fi
  for path in /opt /var/lib; do
    free=$(df -Pk "$path" 2>/dev/null | awk 'NR == 2 { print int($4 / 1024) }' || echo 0)
    if [ "${free:-0}" -ge 400 ]; then ok "Disk space on $path: ${free} MB free"; else bad "Only ${free:-0} MB free on $path; about 400 MB are needed"; fi
  done

  detect_pm
  MISSING_CMDS=; PKGS=
  for p in curl tar gzip sha256sum runuser ss; do
    command -v "$p" >/dev/null 2>&1 || { MISSING_CMDS="$MISSING_CMDS $p"; PKGS="$PKGS $(pkg_for "$p")"; }
  done
  if [ ! -d /etc/ssl/certs ] && [ ! -f /etc/pki/tls/certs/ca-bundle.crt ]; then MISSING_CMDS="$MISSING_CMDS ca-certificates"; PKGS="$PKGS ca-certificates"; fi
  PKGS=$(printf '%s\n' $PKGS | sort -u | tr '\n' ' ' | sed 's/ $//'); MISSING_CMDS=${MISSING_CMDS# }
  if [ -z "$MISSING_CMDS" ]; then ok 'Required tools are present (curl, tar, gzip, sha256sum, runuser)'
  elif [ -n "$PM" ]; then heads_up "Missing: $MISSING_CMDS. The installer will add the package(s) $PKGS with $PM."
  else bad "Missing: $MISSING_CMDS, and no known package manager. Install them first."; fi

  if [ -n "${POLYGATE_ARCHIVE:-}" ]; then ok "Offline install from $POLYGATE_ARCHIVE"
  elif command -v curl >/dev/null 2>&1; then
    if curl -fsS --max-time 10 -o /dev/null -I https://github.com 2>/dev/null; then ok 'Can reach github.com (where the release is downloaded from)'
    else bad 'Cannot reach https://github.com. Check DNS and outbound access, or install offline with POLYGATE_ARCHIVE.'; fi
  fi
  if command -v timedatectl >/dev/null 2>&1; then
    case "$(timedatectl show -p NTPSynchronized --value 2>/dev/null || true)" in
      yes) ok 'Clock is synchronised' ;;
      no) warn 'The clock is not synchronised. Certificates are rejected when the time is wrong: enable time sync (timedatectl set-ntp true).' ;;
    esac
  fi
  if command -v curl >/dev/null 2>&1; then
    PUBLIC_IP=$(detect_ip || true)
    if [ -z "$PUBLIC_IP" ]; then heads_up "Could not find this server's public IP address (needed for the \"IP address\" HTTPS option)"
    elif private_v4 "$PUBLIC_IP"; then heads_up "This server's address looks private ($PUBLIC_IP), so it is probably behind NAT: a certificate for it cannot be issued"
    else ok "Public IP address: $PUBLIC_IP"; fi
  fi

  title 'Looking for other services on this machine'
  OWNER80=$(port_owner 80); OWNER443=$(port_owner 443)
  if [ -z "$OWNER80" ] && [ -z "$OWNER443" ]; then ok 'Ports 80 and 443 are free'
  else
    [ -z "$OWNER80" ] || heads_up "Port 80 is used by $(owner_words "$OWNER80")"
    [ -z "$OWNER443" ] || heads_up "Port 443 is used by $(owner_words "$OWNER443")"
    note 'Automatic HTTPS needs both ports. Polygate will not touch what is already there; other choices are offered below.'
  fi
  if ours_unit && [ -L /opt/polygate/current ]; then
    INSTALLED=1; INSTALLED_VERSION=$(sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' /opt/polygate/current/release.json 2>/dev/null | head -n 1 || true)
    ok "Polygate ${INSTALLED_VERSION:+$INSTALLED_VERSION }is already installed here"
  else
    # Names this installer will create must not belong to something else.
    if [ -e /etc/systemd/system/polygate.service ] && ! ours_unit; then bad 'A different service named polygate.service already exists. Nothing was changed.'; fi
    if [ -e /usr/local/bin/polygate ] && ! ours_cli; then bad "/usr/local/bin/polygate already exists and is not Polygate's command. Nothing was changed."; fi
    if dir_busy /opt/polygate && [ ! -d /opt/polygate/releases ]; then bad '/opt/polygate already exists and is not a Polygate installation.'; fi
    if dir_busy /etc/polygate && [ ! -f /etc/polygate/polygate.env ]; then bad '/etc/polygate already exists and is not a Polygate installation.'; fi
    if dir_busy /var/lib/polygate && [ ! -f /var/lib/polygate/settings.vault ]; then bad "/var/lib/polygate already holds data that is not Polygate's."; fi
    if id polygate >/dev/null 2>&1; then
      case "$(getent passwd polygate | cut -d: -f6,7)" in
        /var/lib/polygate:/usr/sbin/nologin|/var/lib/polygate:/sbin/nologin|/var/lib/polygate:/bin/false|/var/lib/polygate:/usr/bin/nologin) ok 'The polygate user exists (created by an earlier install)' ;;
        *) bad 'A user named polygate already exists and was not created by this installer.' ;;
      esac
    fi
    if [ "$FAILURES" -eq 0 ] && [ ! -e /etc/systemd/system/polygate.service ] && [ ! -d /opt/polygate ]; then ok 'No clash with existing files, users or services: a clean install'; fi
  fi
  if command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -q '^Status: active'; then FW=ufw
  elif command -v firewall-cmd >/dev/null 2>&1 && firewall-cmd --state >/dev/null 2>&1; then FW=firewalld; fi
  [ -z "$FW" ] || note "A firewall ($FW) is active. The installer never changes it; it shows the commands you may want to run."
  if command -v getenforce >/dev/null 2>&1 && [ "$(getenforce 2>/dev/null)" = Enforcing ]; then note 'SELinux is enforcing; if the service does not start, check: ausearch -m avc -ts recent'; fi
  log_line "preflight: failures=$FAILURES warnings=$WARNINGS os=$OS_NAME arch=$ARCH ip=$PUBLIC_IP p80=$OWNER80 p443=$OWNER443 installed=$INSTALLED"
}

install_packages() {
  [ -n "$PKGS" ] || return 0
  [ "${POLYGATE_SKIP_DEPS:-0}" != 1 ] || die "Missing: $MISSING_CMDS. Install them and run again (POLYGATE_SKIP_DEPS=1 was set)."
  case "$PM" in
    apt-get) RUN_SILENT=1 run "Installing dependencies ($PKGS)" bash -c "export DEBIAN_FRONTEND=noninteractive; apt-get update -qq; apt-get install -y --no-install-recommends $PKGS" ;;
    dnf|yum) RUN_SILENT=1 run "Installing dependencies ($PKGS)" "$PM" install -y $PKGS ;;
    pacman)  RUN_SILENT=1 run "Installing dependencies ($PKGS)" pacman -S --noconfirm --needed $PKGS ;;
    zypper)  RUN_SILENT=1 run "Installing dependencies ($PKGS)" zypper --non-interactive install $PKGS ;;
    *) die "Install $MISSING_CMDS first." ;;
  esac
}

# ----------------------------------------------------------------------------------------------------------------- what to set up
MODE=; DOMAIN=${POLYGATE_DOMAIN:-}; IP_ADDR=${POLYGATE_IP:-}; EMAIL=${POLYGATE_EMAIL:-}
CERT=${POLYGATE_CERT_FILE:-}; KEY=${POLYGATE_KEY_FILE:-}; HTTPS_PORT=${POLYGATE_HTTPS_PORT:-}; PORT=${POLYGATE_PORT:-}
FW_PORTS=; PORTS_FREE=0; PASSWORD_SUPPLIED=0

mode_blocker() { # prints why a mode cannot be used on this machine right now; returns 1 if it cannot
  local m=$1 ip
  case "$m" in
    domain|ip)
      if [ -n "$OWNER80" ] || [ -n "$OWNER443" ]; then
        printf 'ports 80 and 443 must both be free (in use:%s%s)' "${OWNER80:+ 80 by $(owner_words "$OWNER80")}" "${OWNER443:+ 443 by $(owner_words "$OWNER443")}"; return 1
      fi
      if [ "$m" = ip ]; then
        ip=${IP_ADDR:-$PUBLIC_IP}
        if [ -z "$ip" ] || private_v4 "$ip"; then printf 'this server has no public IPv4 address to certify'; return 1; fi
      fi ;;
  esac
  return 0
}

dns_check() { # dns_check name  -> 0 when the name points at this server
  local d=$1 ips
  command -v getent >/dev/null 2>&1 || { warn "Cannot look up $d from here"; return 0; }
  ips=$(getent ahostsv4 "$d" 2>/dev/null | awk '{ print $1 }' | sort -u | tr '\n' ' ' | sed 's/ $//')
  if [ -z "$ips" ]; then warn "$d has no IPv4 (A) record yet. Create one that points to ${PUBLIC_IP:-this server}, wait a few minutes, then try again."; return 1
  elif [ -n "$PUBLIC_IP" ] && ! grep -qw -- "$PUBLIC_IP" <<<"$ips"; then warn "$d points to $ips, but this server is $PUBLIC_IP. The certificate request fails unless they are the same machine."; return 1
  fi
  ok "$d points to this server ($ips)"
}


stop_hint() { # the command that would stop whatever holds a port; printed for the operator, never run
  case "$1" in
    nginx|openresty|angie) echo 'sudo systemctl disable --now nginx' ;;
    apache2) echo 'sudo systemctl disable --now apache2' ;;
    httpd) echo 'sudo systemctl disable --now httpd' ;;
    caddy) echo 'sudo systemctl disable --now caddy' ;;
    traefik) echo 'sudo systemctl disable --now traefik   (or stop its container)' ;;
    haproxy) echo 'sudo systemctl disable --now haproxy' ;;
    lighttpd) echo 'sudo systemctl disable --now lighttpd' ;;
    docker-proxy) echo "docker ps --filter publish=$2     # finds the container; then: docker stop NAME" ;;
    *) echo "sudo ss -ltnp 'sport = :$2'     # shows what is listening; stop that service" ;;
  esac
}
ports_help() { # explains the choice when ports 80/443 are taken: free them for good, or keep them and use another way in
  local p o
  say ''
  say "  ${B}Want Polygate to manage HTTPS by itself?${R} It needs ports 80 and 443 permanently, not only while it gets the certificate:"
  say '  port 80 for certificate renewals and the redirect to HTTPS, port 443 for the dashboard. So whatever uses them now must stay off them.'
  say '  If you do not need it there, stop and disable it (these commands are only shown, never run), then run this installer again:'
  if [ -n "$OWNER80" ] && [ "$OWNER80" = "$OWNER443" ] && [ "$OWNER80" != '?' ] && [ "$OWNER80" != docker-proxy ]; then
    printf '    %s%s%s   %s(ports 80 and 443: %s)%s\n' "$CYN" "$(stop_hint "$OWNER80" 80)" "$R" "$D" "$OWNER80" "$R"
  else
    for p in 80 443; do
      o=$([ "$p" = 80 ] && echo "$OWNER80" || echo "$OWNER443")
      [ -z "$o" ] || printf '    %s%s%s   %s(port %s: %s)%s\n' "$CYN" "$(stop_hint "$o" "$p")" "$R" "$D" "$p" "$([ "$o" = '?' ] && echo 'another program' || echo "$o")" "$R"
    done
  fi
  say "  Do ${B}not${R} start it again afterwards: it would fail with \"address already in use\" and could take your other sites down."
  say "  If it has to keep those ports, choose ${B}\"behind the web server I already run\"${R} instead: both then work together and nothing is stopped."
  say ''
}

choose_mode() {
  local default n reason names
  case "$SSL_MODE" in
    '') ;;
    skip) SSL_MODE=local ;;
    domain|ip|proxy|custom|local|http) ;;
    *) die "Unknown HTTPS mode \"$SSL_MODE\". Use domain, ip, proxy, custom, local or http (see --help)." ;;
  esac
  if [ -n "$SSL_MODE" ]; then MODE=$SSL_MODE
  elif [ "$INTERACTIVE" = 0 ]; then MODE=local; note 'No terminal to ask on: using the safe default (local only, reach it with an SSH tunnel). Pass --https to choose.'
  else
    title 'How do you want to open the dashboard?'
    if [ "$PORTS_FREE" = 1 ]; then default=2; elif is_webserver "$OWNER80" || is_webserver "$OWNER443"; then default=3; else default=5; fi
    names=('' 'A domain name, with automatic HTTPS (Let'"'"'s Encrypt)' 'This server'"'"'s IP address, with automatic HTTPS' 'Behind the web server I already run (nginx, Caddy, Apache...)' 'My own certificate files' 'No HTTPS: local only, reached through an SSH tunnel')
    local modes=('' domain ip proxy custom local)
    for n in 1 2 3 4 5; do
      if reason=$(mode_blocker "${modes[$n]}"); then printf '    %s%d)%s %s%s\n' "$B" "$n" "$R" "${names[$n]}" "$([ "$n" = "$default" ] && printf ' %s(recommended here)%s' "$GRN" "$R")"
      else printf '    %s%d) %s  - not available: %s%s\n' "$D" "$n" "${names[$n]}" "$reason" "$R"; fi
    done
    if [ "$PORTS_FREE" != 1 ]; then ports_help; fi
    while :; do
      ask 'Choose' "$default"; n=$REPLY
      [[ "$n" =~ ^[1-5]$ ]] || { say '    Enter a number from 1 to 5.'; continue; }
      if reason=$(mode_blocker "${modes[$n]}"); then MODE=${modes[$n]}; break; fi
      say "    That choice is not available here: $reason."
    done
  fi
  if reason=$(mode_blocker "$MODE"); then :; else
    if [ "$PORTS_FREE" != 1 ]; then ports_help; fi
    die "The \"$MODE\" mode cannot be used here: $reason. Free those ports for good (see above) or choose proxy, custom or local. Nothing was changed."
  fi
}

collect_details() {
  local d
  case "$MODE" in
    domain|proxy)
      while :; do
        if [ -z "$DOMAIN" ]; then [ "$INTERACTIVE" = 1 ] || die "--domain is required for the \"$MODE\" mode"; ask "Domain name (for example panel.example.com)" ''; DOMAIN=$REPLY; fi
        DOMAIN=$(printf '%s' "$DOMAIN" | tr 'A-Z' 'a-z')
        if valid_domain "$DOMAIN"; then break; fi
        [ "$INTERACTIVE" = 1 ] || die "\"$DOMAIN\" is not a full domain name (wildcards and IP addresses are not accepted)"
        say "    \"$DOMAIN\" is not a full domain name. Enter something like panel.example.com."; DOMAIN=
      done
      if [ "$MODE" = domain ] && [ "${POLYGATE_SKIP_DNS_CHECK:-0}" != 1 ]; then
        if ! dns_check "$DOMAIN"; then
          if [ "$INTERACTIVE" = 1 ]; then confirm 'Continue anyway?' n || die 'Stopped. Fix the DNS record and run the installer again (nothing was changed).'
          else die 'The domain does not point at this server (set POLYGATE_SKIP_DNS_CHECK=1 to try anyway). Nothing was changed.'; fi
        fi
      fi ;;
    ip)
      IP_ADDR=${IP_ADDR:-$PUBLIC_IP}
      if [ "$INTERACTIVE" = 1 ]; then ask 'Public IP address to certify' "$IP_ADDR"; IP_ADDR=$REPLY; fi
      [[ "$IP_ADDR" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]] && ! private_v4 "$IP_ADDR" || die "\"$IP_ADDR\" is not a public IPv4 address" ;;
    custom)
      if [ "$INTERACTIVE" = 1 ]; then
        [ -n "$CERT" ] || { ask 'Certificate file (full chain, PEM)' ''; CERT=$REPLY; }
        [ -n "$KEY" ] || { ask 'Private key file (PEM)' ''; KEY=$REPLY; }
      fi
      [ -r "$CERT" ] && [ -r "$KEY" ] || die 'Give readable --cert and --key files (PEM)'
      if [ -z "$HTTPS_PORT" ]; then
        if [ -z "$OWNER443" ]; then HTTPS_PORT=443
        elif [ "$INTERACTIVE" = 1 ]; then say "    Port 443 is used by $OWNER443, so Polygate needs another HTTPS port."; ask 'HTTPS port' 8443; HTTPS_PORT=$REPLY
        else die "Port 443 is used by $OWNER443. Pass --https-port to choose another."; fi
      fi
      valid_port "$HTTPS_PORT" || die "\"$HTTPS_PORT\" is not a valid port"
      if [ -n "$(port_owner "$HTTPS_PORT")" ]; then die "Port $HTTPS_PORT is already used by $(port_owner "$HTTPS_PORT"). Choose another with --https-port."; fi ;;
  esac
  case "$MODE" in
    domain|ip)
      if [ "$INTERACTIVE" = 1 ] && [ -z "$EMAIL" ]; then ask 'E-mail for certificate expiry notices (optional)' ''; EMAIL=$REPLY; fi ;;
  esac
  if [ -n "$EMAIL" ] && ! [[ "$EMAIL" =~ ^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$ ]]; then die "\"$EMAIL\" is not a valid e-mail address"; fi
  if [ -z "$PORT" ]; then PORT=$(pick_port) || die 'Could not find a free port for the dashboard'; fi
  valid_port "$PORT" && [ "$PORT" -ge 1024 ] || die 'The dashboard port must be between 1024 and 65535'
  if [ -n "$(port_owner "$PORT")" ] && [ "$UPDATE" = 0 ]; then die "Port $PORT is already used by $(port_owner "$PORT"). Choose another with --port."; fi
  if [ "$MODE" = http ]; then
    warn 'Plain HTTP on every interface: the dashboard password and API keys travel unencrypted.'
    if [ "$INTERACTIVE" = 1 ]; then confirm 'Really expose it without HTTPS?' n || die 'Stopped. Choose another access mode.'; fi
  fi
  case "$MODE" in domain|ip) FW_PORTS='80 443' ;; custom) FW_PORTS=$HTTPS_PORT ;; http) FW_PORTS=$PORT ;; *) FW_PORTS= ;; esac
  d=${POLYGATE_ADMIN_PASSWORD:-}; d=$(printf '%s' "$d" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')
  if [ -n "$d" ] && [ ! -f /var/lib/polygate/settings.vault ]; then
    [ "${#d}" -ge 12 ] || die 'POLYGATE_ADMIN_PASSWORD must contain at least 12 characters. Nothing was installed.'
    PASSWORD_SUPPLIED=1
  fi
}

show_plan() {
  local what url host=${DOMAIN:-${IP_ADDR:-${PUBLIC_IP:-SERVER}}} ver=$VERSION
  [ -z "${POLYGATE_ARCHIVE:-}" ] || ver='the local release file'
  if [ "$UPDATE" = 1 ]; then
    title "Ready to update"
    kv 'Update' "${INSTALLED_VERSION:+$INSTALLED_VERSION to }$ver" 'your data, settings and certificates are kept'
  else
    case "$MODE" in
      domain) what="HTTPS for $DOMAIN"; url="https://$DOMAIN$DASHBOARD_PATH/" ;;
      ip) what="HTTPS for the IP address $IP_ADDR"; url="https://$IP_ADDR$DASHBOARD_PATH/" ;;
      proxy) what="behind your web server, on 127.0.0.1:$PORT"; url="https://$DOMAIN$DASHBOARD_PATH/" ;;
      custom) what="HTTPS with your certificate, port $HTTPS_PORT"; url="https://$host:$HTTPS_PORT$DASHBOARD_PATH/" ;;
      local) what="this machine only, through an SSH tunnel"; url="http://127.0.0.1:$PORT$DASHBOARD_PATH/" ;;
      http) what="plain HTTP on every interface, port $PORT"; url="http://$host:$PORT$DASHBOARD_PATH/" ;;
    esac
    title "Ready to install"
    kv 'Polygate' "$ver" "for $ARCH"
    kv 'Dashboard' "$url" "$what"
    kv 'Files' '/opt/polygate · /etc/polygate · /var/lib/polygate' 'service "polygate", user "polygate"'
  fi
  note 'No other service, file or firewall setting is touched.'
  say ''
}

# ------------------------------------------------------------------------------------------------------------------ the install steps
asset=; release=; old=; CLI=/usr/local/bin/polygate; BUNX=; HTTPS_URL=; STARTED=0

download_files() {
  curl -fsSL --retry 3 --connect-timeout 15 "$1/$asset" -o "$work/$asset" && curl -fsSL --retry 3 --connect-timeout 15 "$1/$asset.sha256" -o "$work/$asset.sha256"
}
fetch_release() {
  local base expected actual total r
  work=$(mktemp -d /tmp/polygate-install.XXXXXXXX); chmod 0700 "$work"
  asset="polygate-linux-$ARCH.tar.gz"
  if [ -n "${POLYGATE_ARCHIVE:-}" ]; then
    cp -- "$POLYGATE_ARCHIVE" "$work/$asset"; cp -- "${POLYGATE_CHECKSUM:-$POLYGATE_ARCHIVE.sha256}" "$work/$asset.sha256"; log_line 'using the local release archive'
  else
    if [ "$VERSION" = latest ]; then base="https://github.com/$REPO/releases/latest/download"; else base="https://github.com/$REPO/releases/download/$VERSION"; fi
    RUN_SILENT=1 run 'Downloading Polygate' download_files "$base" || die 'The download failed. Check that the release is published and that the repository is public.'
  fi
  expected=$(awk 'NR == 1 { print tolower($1) }' "$work/$asset.sha256"); actual=$(sha256sum "$work/$asset" | awk '{ print $1 }')
  { [[ "$expected" =~ ^[a-f0-9]{64}$ ]] && [ "$expected" = "$actual" ]; } || die 'The download does not match its published SHA-256 checksum. Nothing was installed.'
  log_line 'checksum verified'
  # Every member is checked before anything is extracted: plain files and folders inside polygate/ only.
  tar -tzf "$work/$asset" >"$work/members" 2>>"$LOG" || die 'The archive cannot be read. Nothing was installed.'
  [ "$(wc -l <"$work/members")" -le 20000 ] || die 'The archive has too many entries. Nothing was installed.'
  if grep -Ev '^polygate(/|$)' "$work/members" | grep -q .; then die 'The archive has entries outside polygate/. Nothing was installed.'; fi
  if grep -Eq '(^|/)\.\.(/|$)|^/' "$work/members"; then die 'The archive has an unsafe path. Nothing was installed.'; fi
  if tar -tvzf "$work/$asset" | cut -c1 | grep -Ev '^[-d]$' | grep -q .; then die 'The archive contains links or special files. Nothing was installed.'; fi
  total=$(tar -tvzf "$work/$asset" | awk '{ s += $3 } END { print int(s) }')
  [ "${total:-0}" -le 1500000000 ] || die 'The archive is larger than expected. Nothing was installed.'
  log_line 'archive contents checked'
  tar -xzf "$work/$asset" -C "$work" --no-same-owner || die 'Could not unpack the archive.'
  for r in bin/bun build/gateway.js build/manage.js dist/index.html install/polygate.service install/polygate; do
    [ -f "$work/polygate/$r" ] || die "The release is missing $r. Nothing was installed."
  done
  chmod 0755 "$work/polygate/bin/bun"
  "$work/polygate/bin/bun" --version >>"$LOG" 2>&1 || die "The bundled runtime does not start on this machine (details: $LOG). Usual causes: a CPU without AVX2, or a very old kernel or C library. Use the Docker image instead. Nothing was installed."
  ok 'Downloaded and verified the release'
}

install_release() {
  local nologin
  nologin=$(command -v nologin || echo /usr/sbin/nologin)
  mkdir -p /opt/polygate/releases /etc/polygate
  chmod 0755 /opt/polygate /opt/polygate/releases; chmod 0700 /etc/polygate
  if ! id polygate >/dev/null 2>&1; then useradd --system --home-dir /var/lib/polygate --shell "$nologin" polygate; fi
  install -d -m 0700 -o polygate -g polygate /var/lib/polygate
  release="/opt/polygate/releases/$(date +%Y%m%d%H%M%S)-$$"
  mv -- "$work/polygate" "$release"
  chown -R root:root "$release"
  # The service user must be able to read the program files; only its data is private.
  chmod -R a+rX "$release"; chmod 0755 "$release/bin/bun" "$release/install/polygate"
  # A package unpacked on a filesystem without execute bits (or built on Windows) would leave the WARP helper unrunnable.
  chmod 0755 "$release"/warp/usque-* 2>/dev/null || true
  old=$(readlink /opt/polygate/current || true)
  ln -sfnT "$release" /opt/polygate/.current-new; mv -Tf /opt/polygate/.current-new /opt/polygate/current
  BUNX="$release/bin/bun"
}

# The installer owns the paths, the repository and the dashboard port of this run. On --update every other line (a custom allowed-hosts list,
# the trusted-proxy count, the HTTPS ports ...) stays exactly as the operator left it.
render_env() {
  local src=$1 kept
  kept=$(grep -Ev '^[[:space:]]*POLYGATE_(REPO|APP_DIR|PORT|STATE|UI_DIST)[[:space:]]*=' "$src" || true)
  printf 'POLYGATE_REPO=%q\nPOLYGATE_APP_DIR=/opt/polygate/current\nPOLYGATE_PORT=%s\n' "$REPO" "$PORT"
  printf 'POLYGATE_STATE=/var/lib/polygate\nPOLYGATE_UI_DIST=/opt/polygate/current/dist\n'
  [ -z "$kept" ] || printf '%s\n' "$kept"
  if [ "$UPDATE" = 0 ]; then
    case "$MODE" in
      http) printf 'POLYGATE_HOST=0.0.0.0\nPOLYGATE_ALLOWED_HOSTS=*\n' ;;
      proxy) printf 'POLYGATE_HOST=127.0.0.1\nPOLYGATE_ALLOWED_HOSTS=%s\nPOLYGATE_TRUST_PROXY=1\nPOLYGATE_COOKIE_SECURE=1\n' "$DOMAIN" ;;
      *) printf 'POLYGATE_HOST=127.0.0.1\n' ;;
    esac
    [ "$MODE" != custom ] || printf 'POLYGATE_HTTPS_PORT=%s\n' "$HTTPS_PORT"
    [ -z "$DASHBOARD_PATH" ] || printf 'POLYGATE_DASHBOARD_PATH=%s\n' "$DASHBOARD_PATH"
  elif ! grep -Eq '^[[:space:]]*POLYGATE_HOST[[:space:]]*=' <<<"$kept"; then printf 'POLYGATE_HOST=127.0.0.1\n'
  fi
}

configure_service() {
  local src=/dev/null
  if [ "$UPDATE" = 1 ] && [ -f /etc/polygate/polygate.env ]; then src=/etc/polygate/polygate.env; fi
  # A fresh install over the settings file a data-preserving uninstall left behind starts from the choices made now; the old file is kept beside it.
  if [ "$UPDATE" = 0 ] && [ -f /etc/polygate/polygate.env ]; then
    local old=/etc/polygate/polygate.env.before-reinstall-$(date +%Y%m%d-%H%M%S)
    cp -p /etc/polygate/polygate.env "$old" && chmod 0600 "$old" && note "The settings file of the earlier installation was kept as $old"
  fi
  render_env "$src" >/etc/polygate/polygate.env.new
  chmod 0600 /etc/polygate/polygate.env.new; mv -f /etc/polygate/polygate.env.new /etc/polygate/polygate.env
  install -m 0644 "$release/install/polygate.service" /etc/systemd/system/polygate.service
  install -m 0755 "$release/install/polygate" /usr/local/bin/polygate
  export POLYGATE_APP_DIR=/opt/polygate/current POLYGATE_STATE=/var/lib/polygate POLYGATE_PORT="$PORT"
  if [ ! -f /var/lib/polygate/settings.vault ]; then
    printf '%s' "${POLYGATE_ADMIN_PASSWORD:-}" | runuser -u polygate --preserve-environment -- "$release/bin/bun" "$release/build/manage.js" password --stdin >>"$LOG" 2>&1
    if [ "$PASSWORD_SUPPLIED" = 1 ]; then rm -f /var/lib/polygate/admin-password.txt; fi
  fi
  ok 'Installed Polygate'
}

wait_healthy() { local i; for i in $(seq 1 45); do if "$CLI" health >/dev/null 2>&1; then return 0; fi; sleep 1; done; return 1; }

start_polygate() { systemctl daemon-reload && systemctl enable polygate && systemctl restart polygate && wait_healthy; }
start_service() {
  STARTED=1
  if RUN_SILENT=1 run 'Starting Polygate' start_polygate; then ok 'Polygate is running'; return 0; fi
  say ''; say '  The service log says:'; journalctl -u polygate -n 25 --no-pager 2>/dev/null | sed 's/^/        /' || true
  if [[ "$old" = /opt/polygate/releases/* ]] && [ -d "$old" ]; then
    ln -sfnT "$old" /opt/polygate/.current-old; mv -Tf /opt/polygate/.current-old /opt/polygate/current; systemctl restart polygate || true
    die 'The new release did not start, so the previous release was put back.'
  fi
  die 'The gateway did not start. Read the log above or run: journalctl -u polygate -n 100'
}

firewall_hint() { # prints the commands for the ports this setup needs; never runs them
  local p cmds=
  [ -n "$FW_PORTS" ] || return 0
  say ''
  case "$FW" in
    ufw) for p in $FW_PORTS; do cmds="$cmds ufw allow $p/tcp;"; done
         printf '  %sFirewall%s  ufw is active and does not allow %s yet. If you want to allow it, run:\n' "$B" "$R" "$FW_PORTS"; printf '    %s%s%s\n' "$CYN" "${cmds# }" "$R" ;;
    firewalld) for p in $FW_PORTS; do cmds="$cmds firewall-cmd --permanent --add-port=$p/tcp;"; done
         printf '  %sFirewall%s  firewalld is active. If you want to allow port(s) %s, run:\n' "$B" "$R" "$FW_PORTS"; printf '    %s%s firewall-cmd --reload%s\n' "$CYN" "${cmds# }" "$R" ;;
    *) printf '  %sFirewall%s  port(s) %s must be reachable from the internet. No firewall was changed.\n' "$B" "$R" "$FW_PORTS" ;;
  esac
  note 'If your hosting provider has its own firewall (security group), open the same port(s) there.'
}

# Watches the certificate request and prints each step as it happens.
https_wait() {
  local seen=0 out first err state active url total level msg i
  local parse='const d=JSON.parse(await Bun.stdin.text());const skip=Number(process.env.SKIP)||0;const j=d.job||{};const s=j.steps||[];console.log([j.running?"running":"idle",d.active?"active":"inactive",d.url||"-",String(s.length)].join("\t"));console.log(String(j.error||"").replace(/\s+/g," ")||"-");for(const x of s.slice(skip))console.log(x.level+"\t"+String(x.msg).replace(/\s+/g," "));'
  for i in $(seq 1 150); do
    out=$("$CLI" https status 2>/dev/null | SKIP=$seen "$BUNX" -e "$parse" 2>/dev/null) || out=
    if [ -z "$out" ]; then sleep 2; continue; fi
    first=$(sed -n 1p <<<"$out"); err=$(sed -n 2p <<<"$out")
    IFS=$'\t' read -r state active url total <<<"$first"
    while IFS=$'\t' read -r level msg; do
      [ -n "${msg:-}" ] || continue
      case "$level" in ok) ok "$msg" ;; warn) warn "$msg" ;; error) bad "$msg" ;; *) note "$msg" ;; esac
    done < <(sed -n '3,$p' <<<"$out")
    seen=${total:-$seen}
    if [ "$state" != running ]; then
      if [ "$active" = active ]; then HTTPS_URL=$url; return 0; fi
      [ "$err" = - ] || HTTPS_ERROR=$err
      return 1
    fi
    sleep 2
  done
  HTTPS_ERROR='Timed out waiting for the certificate'; return 1
}
HTTPS_ERROR=

https_setup() {
  printf '\n  %s%s%s %sSetting up HTTPS%s\n' "$CYN" "$S_GO" "$R" "$B" "$R"
  local started
  case "$MODE" in
    domain) started=$("$CLI" https domain "$DOMAIN" "$EMAIL" 2>&1) || HTTPS_ERROR=$(printf '%s' "$started" | tail -n 1) ;;
    ip) started=$("$CLI" https ip "$IP_ADDR" "$EMAIL" 2>&1) || HTTPS_ERROR=$(printf '%s' "$started" | tail -n 1) ;;
    custom) started=$("$CLI" https custom "$CERT" "$KEY" 2>&1) || HTTPS_ERROR=$(printf '%s' "$started" | tail -n 1) ;;
  esac
  log_line "https start: $started"
  if [ -z "$HTTPS_ERROR" ] && https_wait; then return 0; fi
  say ''
  bad "HTTPS could not be set up: ${HTTPS_ERROR:-unknown error}"
  note 'Polygate itself is installed and running, only on this machine (127.0.0.1). Nothing else was changed.'
  case "$MODE" in
    domain|ip) note 'Check that ports 80 and 443 reach this server (including your hosting provider'"'"'s firewall)'"$([ "$MODE" = domain ] && echo ", and that $DOMAIN points here")"'.'
               note 'Then try again with:  sudo polygate https '"$MODE"' '"$([ "$MODE" = domain ] && echo "$DOMAIN" || echo "$IP_ADDR")" ;;
    custom) note 'Check the certificate and key, then run:  sudo polygate https custom CERT_FILE KEY_FILE' ;;
  esac
  HTTPS_FAILED=1
  return 1
}
HTTPS_FAILED=0

write_proxy_example() {
  local path=${DASHBOARD_PATH:-/}
  [ "$path" = / ] || path="$path/"
  cat >/etc/polygate/proxy-example.conf <<EXAMPLE
# Examples for a web server you already run. Polygate listens on 127.0.0.1:$PORT and serves the dashboard and the API under ${DASHBOARD_PATH:-/}
# (so other paths on the same site stay yours). Edit your own configuration; Polygate never changes it.

# --- nginx (inside your existing HTTPS server block for $DOMAIN)
location $path {
    proxy_pass http://127.0.0.1:$PORT;
    proxy_http_version 1.1;
    proxy_set_header Host \$host;
    proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto \$scheme;
    proxy_buffering off;          # model answers are streamed
    proxy_read_timeout 3600s;
    proxy_send_timeout 3600s;
    client_max_body_size 20m;
}

# --- Caddy
$DOMAIN {
    handle ${path}* {
        reverse_proxy 127.0.0.1:$PORT {
            flush_interval -1
        }
    }
}
EXAMPLE
  chmod 0644 /etc/polygate/proxy-example.conf
}

prune_releases() {
  local d
  # Keep the running release and the one before it (for rollback); older ones only take disk space.
  ls -1dt /opt/polygate/releases/*/ 2>/dev/null | tail -n +3 | while read -r d; do case "$d" in /opt/polygate/releases/*) rm -rf -- "$d" ;; esac; done
}

finish() {
  local host dashboard pw api
  host=${PUBLIC_IP:-SERVER-IP}
  case "$MODE" in
    domain|ip|custom) dashboard=${HTTPS_URL:-} ;;
    proxy) dashboard="https://$DOMAIN$DASHBOARD_PATH/" ;;
    http) dashboard="http://$host:$PORT$DASHBOARD_PATH/" ;;
    *) dashboard="http://127.0.0.1:$PORT${DASHBOARD_PATH:-}/" ;;
  esac
  if [ "$UPDATE" = 1 ]; then dashboard=$("$CLI" https status 2>/dev/null | "$BUNX" -e 'const d=JSON.parse(await Bun.stdin.text());console.log(d.active?d.url:"")' 2>/dev/null || true); fi
  [ "$HTTPS_FAILED" = 0 ] || dashboard="http://127.0.0.1:$PORT${DASHBOARD_PATH:-}/"
  [ -n "$dashboard" ] || dashboard="http://127.0.0.1:$PORT${DASHBOARD_PATH:-}/"
  api=${dashboard%/}/v1
  printf '\n  %s%s%s %s%s%s\n\n' "$GRN" "$S_OK" "$R" "$B" "$([ "$UPDATE" = 1 ] && echo 'Polygate is updated and running' || echo 'Polygate is installed and running')" "$R"
  kv 'Dashboard' "$dashboard"
  kv 'API base' "$api" 'works with any OpenAI-compatible tool'
  if [ "$UPDATE" = 0 ]; then
    if [ "$PASSWORD_SUPPLIED" = 1 ]; then kv 'Password' 'the one you supplied' 'not stored in a file'
    elif [ -f /var/lib/polygate/admin-password.txt ]; then pw=$(cat /var/lib/polygate/admin-password.txt); kv 'Password' "$pw" 'saved in /var/lib/polygate/admin-password.txt'; fi
    case "$MODE" in
      local) say ''; say '  To open it from your computer, run this there, then browse to the address above:'
             printf '    %sssh -L %s:127.0.0.1:%s root@%s%s\n' "$CYN" "$PORT" "$PORT" "$host" "$R" ;;
      proxy) say ''; say "  Forward ${DASHBOARD_PATH:-/} to 127.0.0.1:$PORT in your web server. A ready-made nginx and Caddy snippet is in:"
             printf '    %s/etc/polygate/proxy-example.conf%s\n' "$CYN" "$R" ;;
      http) say ''; warn 'HTTP only: the password and API keys can be read on the network. Add HTTPS soon: run  polygate  and choose HTTPS.' ;;
    esac
    if [ "$HTTPS_FAILED" = 1 ]; then
      say ''; say "  HTTPS was not set up, so it is reachable on this machine only. Open it from your computer with:"
      printf '    %sssh -L %s:127.0.0.1:%s root@%s%s\n' "$CYN" "$PORT" "$PORT" "$host" "$R"
    fi
    if [ "$MODE" != domain ] && [ "$MODE" != ip ]; then firewall_hint; fi
  fi
  printf '\n  Type %spolygate%s any time to open the manager: status, logs, HTTPS, update, stop and uninstall.\n' "$B" "$R"
  printf '  %sSettings /etc/polygate/polygate.env · data /var/lib/polygate · install log %s%s\n\n' "$D" "$LOG" "$R"
}

on_exit() {
  local s=$?
  spin_stop; cleanup
  if [ "$s" -ne 0 ] && [ "$CHECK" = 0 ] && [ "$STARTED" = 1 ]; then
    printf '\n  The installer stopped early. Details are in %s\n  To remove what was installed:  sudo polygate uninstall --yes\n\n' "$LOG" >&2
  fi
}

show_issues() { # the warnings and problems collected while the checks ran quietly
  local line kind msg
  while IFS= read -r line; do
    [ -n "$line" ] || continue; kind=${line%%|*}; msg=${line#*|}
    if [ "$kind" = b ]; then printf '  %s%s%s %s\n' "$RED" "$S_BAD" "$R" "$msg"; else printf '  %s%s%s %s\n' "$YEL" "$S_WARN" "$R" "$msg"; fi
  done <<<"$ISSUES"
  ISSUES=
  if [ "$FAILURES" -gt 0 ]; then say ''; die "$FAILURES problem(s) above must be fixed first. Nothing was changed."; fi
}

main() {
  trap on_exit EXIT
  if [ "$(id -u)" -eq 0 ]; then
    : >>"$LOG" 2>/dev/null && chmod 0600 "$LOG" 2>/dev/null || LOG=/dev/null
  else LOG=/dev/null; fi
  log_line "installer start: update=$UPDATE check=$CHECK yes=$YES version=$VERSION"
  banner '' "Linux installer · $(hostname)"

  if [ "$CHECK" = 1 ]; then
    preflight
    PORTS_FREE=0; if [ -z "$OWNER80" ] && [ -z "$OWNER443" ]; then PORTS_FREE=1; fi
    title 'Result'
    if [ "$FAILURES" -gt 0 ]; then bad "$FAILURES problem(s) must be fixed before installing."; say ''; exit 1; fi
    ok "This machine can run Polygate${WARNINGS:+ ($WARNINGS note(s) above)}."
    if [ "$PORTS_FREE" = 1 ]; then ok 'Automatic HTTPS (domain or IP address) is possible: ports 80 and 443 are free.'
    else note 'Automatic HTTPS is not possible while those ports are in use. Possible: behind your existing web server (proxy), your own certificate on another port (custom), or local only with an SSH tunnel.'; fi
    note 'Nothing was changed.'; say ''; exit 0
  fi

  if [ "$INTERACTIVE" = 1 ]; then
    say '  This sets up Polygate, a free AI model gateway, on this server. It checks the system,'
    say '  installs what is missing, and asks how you want to open the dashboard.'
    printf '\n  %sNothing changes until you press Enter.%s\n\n' "$D" "$R"
    ask 'Press Enter to start, or q to quit:' ''
    case "$REPLY" in q|Q|quit|exit) say ''; say '  Cancelled. Nothing was changed.'; say ''; exit 0 ;; esac
    say ''
  fi

  # The checks run quietly and everything they find goes to the log; only problems are shown.
  QUIET=1; spin_start 'Checking the system and installing dependencies'
  preflight
  spin_stop; QUIET=0
  PORTS_FREE=0; if [ -z "$OWNER80" ] && [ -z "$OWNER443" ]; then PORTS_FREE=1; fi
  show_issues
  if [ -n "$PKGS" ]; then install_packages; fi
  ok "Checked the system and installed dependencies ${D}(log: $LOG)${R}"

  if [ "$INSTALLED" = 1 ] && [ "$UPDATE" = 0 ]; then
    if [ "$INTERACTIVE" = 1 ] && confirm "Polygate ${INSTALLED_VERSION:-} is already installed. Update it now (your data and settings are kept)?" y; then UPDATE=1
    else die 'Polygate is already installed. Run with --update to update it, or run  polygate  and choose Uninstall to remove it first.'; fi
  fi
  if [ "$UPDATE" = 1 ]; then
    [ "$INSTALLED" = 1 ] || die 'There is no Polygate installation here to update. Run without --update.'
    PORT=$(sed -n 's/^POLYGATE_PORT=//p' /etc/polygate/polygate.env | tail -n 1); PORT=${PORT:-$(pick_port)}
    MODE=; FW_PORTS=
  else
    choose_mode; collect_details
  fi
  show_plan
  if [ "$INTERACTIVE" = 1 ]; then confirm 'Install now?' y || die 'Stopped. Nothing was changed.'; say ''; fi

  fetch_release
  install_release
  configure_service
  start_service
  if [ "$UPDATE" = 0 ]; then
    [ "$MODE" != proxy ] || write_proxy_example
    # Automatic HTTPS needs ports 80 and 443 to be reachable, so a firewall that blocks them is pointed out before the certificate is requested.
    if [ -n "$FW" ] && { [ "$MODE" = domain ] || [ "$MODE" = ip ]; }; then firewall_hint; fi
    case "$MODE" in domain|ip|custom) https_setup || true ;; esac
  fi
  prune_releases
  log_line "installer finished: mode=${MODE:-update} port=$PORT"
  finish
  [ "$HTTPS_FAILED" = 0 ] || exit 1
}

main
