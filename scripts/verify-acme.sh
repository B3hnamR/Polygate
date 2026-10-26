#!/usr/bin/env bash
# Isolated end-to-end issuance against Pebble, never Let's Encrypt production.
set -euo pipefail
cd "$(dirname "$0")/.."
image=${POLYGATE_TEST_IMAGE:-polygate:verification}
suffix="$$-$(date +%s)"; network="polygate-acme-$suffix"; ca="polygate-ca-$suffix"; gateway="polygate-tls-$suffix"
work=$(mktemp -d /tmp/polygate-acme.XXXXXXXX)
cleanup(){ docker rm -fv "$gateway" "$ca" >/dev/null 2>&1 || true;docker network rm "$network" >/dev/null 2>&1 || true;rm -rf -- "$work"; }
trap cleanup EXIT
docker network create --subnet 198.19.87.0/24 "$network" >/dev/null
cat > "$work/pebble.json" <<'JSON'
{"pebble":{"listenAddress":"0.0.0.0:14000","managementListenAddress":"0.0.0.0:15000","certificate":"/test/certs/localhost/cert.pem","privateKey":"/test/certs/localhost/key.pem","httpPort":5002,"tlsPort":5001,"profiles":{"default":{"description":"Test domain","validityPeriod":7776000},"shortlived":{"description":"Test IP","validityPeriod":518400}}}}
JSON
docker run -d --name "$ca" --network "$network" --ip 198.19.87.11 -e PEBBLE_VA_NOSLEEP=1 -e PEBBLE_WFE_NONCEREJECT=0 -v "$work/pebble.json:/test/polygate.json:ro" ghcr.io/letsencrypt/pebble:latest -config /test/polygate.json >/dev/null
docker run -d --name "$gateway" --network "$network" --ip 198.19.87.10 --network-alias gateway.polygate.test -e POLYGATE_ADMIN_TOKEN=acme-local-fixture -e POLYGATE_NO_DISCOVERY=1 -e POLYGATE_PUBLIC_IP=198.19.87.10 -e POLYGATE_ACME_DIRECTORY=https://198.19.87.11:14000/dir -e POLYGATE_ACME_INSECURE=1 "$image" >/dev/null
control(){ docker exec -i "$gateway" bun /app/build/manage.js request "$1"; }
for _ in $(seq 1 30);do if control /healthz </dev/null >/dev/null 2>&1;then break;fi;sleep 1;done
finish(){
  for _ in $(seq 1 60); do
    control /admin/https </dev/null > "$work/result.json"
    state=$(python3 -c 'import json,sys;d=json.load(open(sys.argv[1]));print("wait" if d["job"]["running"] else "error" if d["job"]["error"] else "ok" if d["active"] else "wait")' "$work/result.json")
    if [ "$state" = ok ]; then return;fi
    if [ "$state" = error ];then cat "$work/result.json";docker logs "$ca" | tail -20;return 1;fi
    sleep 1
  done
  echo 'ACME job timed out' >&2;cat "$work/result.json";return 1
}
printf '{"mode":"domain","domain":"gateway.polygate.test","port":8443,"httpPort":5002}' | control /admin/https/apply >/dev/null
finish
docker exec "$gateway" bun -e 'const {X509Certificate}=require("node:crypto");const c=new X509Certificate(require("node:fs").readFileSync("/data/tls/domain-fullchain.pem"));if(!c.subjectAltName.includes("DNS:gateway.polygate.test"))throw Error("DNS SAN missing");console.log("Domain certificate verified against Pebble");'
printf '{}' | control /admin/https/renew >/dev/null;finish
printf '{}' | control /admin/https/disable >/dev/null
printf '{"mode":"ip","ip":"198.19.87.10","port":8443,"httpPort":5002}' | control /admin/https/apply >/dev/null
finish
docker exec "$gateway" bun -e 'const {X509Certificate}=require("node:crypto");const c=new X509Certificate(require("node:fs").readFileSync("/data/tls/ip-fullchain.pem"));if(!c.subjectAltName.includes("IP Address:198.19.87.10"))throw Error("IP SAN missing");if(Date.parse(c.validTo)-Date.parse(c.validFrom)>7*86400000)throw Error("Short-lived profile missing");console.log("IP SAN and six-day certificate profile verified against Pebble");'
echo 'PASS: real http-01 challenges, signed ACME account/orders, DNS issuance, renewal, listener changes, IP issuance and short-lived profile (test CA only).'
