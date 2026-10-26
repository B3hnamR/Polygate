#!/usr/bin/env bash
# Disposable-container installer harness. systemctl is simulated; the installed gateway really runs as polygate.
set -euo pipefail
cd "$(dirname "$0")/.."
image=${POLYGATE_TEST_IMAGE:-polygate:verification}
work=$(mktemp -d /tmp/polygate-installer.XXXXXXXX);name="polygate-installer-$$"
trap 'docker rm -fv "$name" >/dev/null 2>&1 || true; rm -rf -- "$work"' EXIT
cat > "$work/systemctl" <<'SH'
#!/usr/bin/env bash
set -e
stop_service(){ if [ -f /run/polygate-test.pid ]; then kill -TERM "$(cat /run/polygate-test.pid)" 2>/dev/null || true; sleep 1; rm -f /run/polygate-test.pid;fi; }
case "$1" in
  restart|start)
    stop_service
    set -a;. /etc/polygate/polygate.env;set +a
    POLYGATE_NO_DISCOVERY=1 nohup runuser -u polygate --preserve-environment -- /opt/polygate/current/bin/bun /opt/polygate/current/build/gateway.js >/var/lib/polygate/service-test.log 2>&1 &
    echo $! >/run/polygate-test.pid ;;
  stop|disable) stop_service ;;
  is-active) [ -f /run/polygate-test.pid ] && kill -0 "$(cat /run/polygate-test.pid)" ;;
  daemon-reload|enable|status) exit 0 ;;
  *) echo "Unsupported harness systemctl: $*" >&2;exit 1;;
esac
SH
chmod 0755 "$work/systemctl"
cat > "$work/test.sh" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
mkdir -p /run/systemd/system /fixture-bin
trap 'for f in /tmp/install.log /tmp/update.log /var/lib/polygate/service-test.log; do if [ -f "$f" ]; then echo "== $f =="; tail -n 25 "$f"; fi; done' ERR
cp /fixture/systemctl /fixture-bin/systemctl
export PATH=/fixture-bin:$PATH
export POLYGATE_ARCHIVE=/input/polygate-linux-amd64.tar.gz POLYGATE_CHECKSUM=/input/polygate-linux-amd64.tar.gz.sha256 POLYGATE_SKIP_DEPS=1 POLYGATE_SSL_MODE=skip POLYGATE_IP=198.51.100.10 POLYGATE_PORT=4318 POLYGATE_NO_DISCOVERY=1
cp "$POLYGATE_ARCHIVE" /tmp/bad-release.tar.gz
printf corrupt >> /tmp/bad-release.tar.gz
if POLYGATE_ARCHIVE=/tmp/bad-release.tar.gz bash /input/install.sh >/tmp/rejected.log 2>&1; then echo 'Corrupt archive was accepted' >&2;exit 1;fi
[ ! -e /opt/polygate/current ]
bash /input/install.sh >/tmp/install.log 2>&1
polygate health >/dev/null
[ "$(stat -c %a /etc/polygate/polygate.env)" = 600 ]
[ "$(stat -c %U /var/lib/polygate/settings.vault)" = polygate ]
old_password=$(sha256sum /var/lib/polygate/admin-password.txt)
echo preserved >/var/lib/polygate/keep.txt
old_release=$(readlink /opt/polygate/current)
bash /input/install.sh --update >/tmp/update.log 2>&1
polygate health >/dev/null
[ "$(sha256sum /var/lib/polygate/admin-password.txt)" = "$old_password" ]
[ "$(cat /var/lib/polygate/keep.txt)" = preserved ]
[ "$(readlink /opt/polygate/current)" != "$old_release" ]
polygate password >/tmp/password-result
for _ in $(seq 1 30); do if polygate health >/dev/null 2>&1;then break;fi;sleep 1;done
polygate health >/dev/null
python3 - <<'PY'
import json,urllib.request
p=open('/var/lib/polygate/admin-password.txt').read().strip()
r=urllib.request.urlopen(urllib.request.Request('http://127.0.0.1:4318/admin/login',data=json.dumps({'password':p}).encode(),headers={'Content-Type':'application/json'}))
assert r.status==200 and 'HttpOnly' in r.headers['Set-Cookie']
PY
polygate uninstall --yes >/dev/null
[ -f /var/lib/polygate/keep.txt ] && [ ! -e /opt/polygate ]
echo 'PASS: checksummed install, dedicated user, file permissions, real gateway startup, update preservation, password reset/login, and data-preserving uninstall. systemd commands were simulated.'
SH
docker run --name "$name" --user root --entrypoint bash -v "$PWD/release:/input-assets:ro" -v "$PWD/install.sh:/input/install.sh:ro" -v "$PWD/release/polygate-linux-amd64.tar.gz:/input/polygate-linux-amd64.tar.gz:ro" -v "$PWD/release/polygate-linux-amd64.tar.gz.sha256:/input/polygate-linux-amd64.tar.gz.sha256:ro" -v "$work:/fixture:ro" "$image" /fixture/test.sh
