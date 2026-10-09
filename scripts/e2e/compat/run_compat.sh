#!/usr/bin/env bash
# Compiles and runs the generated entry (dart:io harness lib/app.dart) on several
# Dart SDKs and language versions, through scripts/e2e/mitm_proxy.dart.
#   run_compat.sh <dart-sdk-dir>...      (each dir contains bin/dart)
# env: FI_TEMPLATE=v1|v2|v3 (default v3), PORT (default 8899), LANGS (default "2.12 3.0"),
#      FI_EVIL_URL (attack case: URL of scripts/e2e/evil_server.dart), FI_PROXY_DOWN=1 (no proxy;
#      only the attack case runs)
set -uo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
E2E=$(cd "$HERE/.." && pwd)
PORT=${PORT:-8899}
LANGS=${LANGS:-"2.12 3.0"}
WORK=$(mktemp -d "${TMPDIR:-/tmp}/fi_compat.XXXXXX")
HOST_DART=${HOST_DART:-$(command -v dart || echo "$HOME/Documents/flutter/bin/dart")}

# Pinned roots for the SecurityContext(withTrustedRoots:false) case: the real
# roots of jsonplaceholder.typicode.com and httpbin.org, from the macOS bundle.
python3 - "$WORK/pins.pem" <<'PY'
import re, subprocess, sys
want = ['GTS Root R4', 'GlobalSign Root CA', 'Amazon Root CA 1',
        'Starfield Services Root Certificate Authority - G2']
out, found = [], set()
for b in re.findall(r'-----BEGIN CERTIFICATE-----.*?-----END CERTIFICATE-----',
                    open('/etc/ssl/cert.pem').read(), re.S):
    subj = subprocess.run(['openssl', 'x509', '-noout', '-subject'], input=b,
                          capture_output=True, text=True).stdout.strip()
    for w in want:
        if w not in found and re.search(r'CN ?= ?' + re.escape(w) + r'(\s*$|,)', subj):
            found.add(w); out.append(b)
open(sys.argv[1], 'w').write('\n'.join(out) + '\n')
PY
export FI_PINS="$WORK/pins.pem"

export FI_TEMPLATE=${FI_TEMPLATE:-v3}
CA_ARGS=()
[ "$FI_TEMPLATE" = v3 ] && CA_ARGS=(--ca "$WORK/ca")
if [ "${FI_PROXY_DOWN:-0}" = 1 ]; then
  export FI_ONLY_ATTACK=1
  # The CA still has to exist for the entry; mint it with the proxy, then stop the proxy.
  "$HOST_DART" run "$E2E/mitm_proxy.dart" --port "$PORT" --certs "$WORK/certs" ${CA_ARGS[@]+"${CA_ARGS[@]}"} > "$WORK/proxy.log" 2>&1 &
  PROXY=$!
  for _ in $(seq 1 60); do grep -q PROXY_READY "$WORK/proxy.log" && break; sleep 0.5; done
  kill $PROXY; wait $PROXY 2>/dev/null
  echo "proxy DOWN (port $PORT closed)"
else
  "$HOST_DART" run "$E2E/mitm_proxy.dart" --port "$PORT" --certs "$WORK/certs" ${CA_ARGS[@]+"${CA_ARGS[@]}"} > "$WORK/proxy.log" 2>&1 &
  PROXY=$!
  for _ in $(seq 1 60); do grep -q PROXY_READY "$WORK/proxy.log" && break; sleep 0.5; done
fi
trap 'kill $PROXY 2>/dev/null; pkill -f "mitm_proxy.dart --port $PORT " 2>/dev/null' EXIT
[ "$FI_TEMPLATE" = v3 ] && export FI_CA_CERT="$WORK/ca/ca.pem"

cp "$HERE/pubspec.yaml" "$WORK/pubspec.yaml.orig"
status=0
for sdk in "$@"; do
  for lang in $LANGS; do
    sed "s/sdk: '>=[0-9.]*/sdk: '>=$lang.0/" "$WORK/pubspec.yaml.orig" > "$HERE/pubspec.yaml"
    (cd "$HERE" && rm -rf .dart_tool pubspec.lock && "$sdk/bin/dart" pub get --offline >/dev/null 2>&1) \
      || { echo "pub get failed for $sdk"; status=1; continue; }
    ENTRY=$("$E2E/gen_entry.sh" "$HERE" lib/app.dart localhost "$PORT")
    ver=$("$sdk/bin/dart" --version 2>&1 | sed -E 's/.*version: ([^ ]+).*/\1/')
    log="$WORK/run_${ver}_lang$lang.log"
    (cd "$HERE" && "$sdk/bin/dart" run "$ENTRY") > "$log" 2>&1
    res=$(grep -o 'COMPAT_DONE failures=[0-9]*' "$log" || echo "DID NOT RUN")
    echo "== dart $ver lang $lang template $FI_TEMPLATE: $res"
    grep -E '^COMPAT [a-z_]+ FAIL|^COMPAT attack|Error:|\[flutter_intercept\]' "$log" | cut -c1-220 | sed 's/^/   /'
    [ "$res" = "COMPAT_DONE failures=0" ] || status=1
  done
done
cp "$WORK/pubspec.yaml.orig" "$HERE/pubspec.yaml"
echo "logs: $WORK"
exit $status
