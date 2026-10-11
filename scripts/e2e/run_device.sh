#!/usr/bin/env bash
# Non-interactive device check for Flutter Intercept's generated entry point.
#
#   scripts/e2e/run_device.sh <deviceId> [options]
#
#   --target <lib/...dart>   app target to wrap (default lib/main.dart)
#   --port <n>               proxy port (default 8899)
#   --profile                flutter run --profile (skips hot-restart steps)
#   --emulator-host          Android emulator: use PROXY 10.0.2.2 instead of adb reverse
#   --no-restart             skip the hot-restart check
#   --no-fallback            skip the proxy-down / DIRECT fallback check
#   --dart-define K=V        extra dart-define for the app (repeatable)
#   --app <dir>              Flutter project (default samples/demo_app)
#   --entry-dir <dir>        where to generate the entry (default .dart_tool/flutter_intercept;
#                            use distinct dirs when running two devices in parallel)
#   --template v1..v6        entry template from scripts/e2e/templates (default v6 = v5 + the gRPC
#                            Socket.connect hook; v5 = v4 + the background-isolate install hook; v4: +
#                            request -> source traces, checked against the demo's call sites; v3 = no traces)
#   --grpc                   CONTRACTS §16.1 (template v6): start scripts/e2e/grpc_server (h2c on
#                            --grpc-port, default 50051, TLS on the next port) and pass GRPC_PORT /
#                            GRPC_TLS_PORT: the demo's gRPC batch (DEMO_GRPC) must go through silent
#                            tunnels of the proxy (the server's `servedTo` port = the proxy's upstream port)
#                            while the proxy is up, and direct once it is down
#   --grpc-off               with --grpc: --dart-define=FLUTTER_INTERCEPT_GRPC=0, every gRPC call must go direct
#   --isolates               flutter run --start-paused + scripts/e2e/isolate_installer.mjs (the extension's
#                            background-isolate install, CONTRACTS §13.3): grpc_isolate must be tunnelled too
#   --attack                 REVIEW-1 #1: run scripts/e2e/evil_server.dart (self-signed CN=evil.example)
#                            on :8443 and make the app GET it (EVIL_URL); it must never be accepted —
#                            proxy up (proxy refuses upstream) or down (DIRECT must fail verification)
#   --lan <ipv4>             physical iOS (CONTRACTS §7): the proxy binds this LAN address with a random
#                            token (407 without it); the app gets
#                            FLUTTER_INTERCEPT_PROXY=flutter-intercept:<token>@<ipv4>:<port>. Adds a
#                            wrong-token stage (proxy restarted with another token, hot restart).
#   --evil-port <n>          port of the attack server (default 8443; distinct per parallel device)
#   --app-mode <m>           demo-app mode, sets the matching dart-define and expectations:
#                            charles | env (APP_FINDPROXY), callback | context | dio_validate (APP_PINNING)
#
# Steps: start scripts/e2e/mitm_proxy.dart --ca (CA-signed per-host leaves; edits JSON,
# mocks users/2, blocks comments/1) -> adb reverse (Android) -> generate the v3 entry
# (embeds/trusts that CA) -> flutter run -t <entry> --dart-define=FLUTTER_INTERCEPT_ENTRY_SHA=<sha>
# --dart-define=FLUTTER_INTERCEPT_PROXY=<host:port> -> assert intercepted results -> 'R' hot
# restart -> assert again -> stop proxy (Android: first with adb reverse kept, then removed)
# -> 'R' -> assert the app reaches servers DIRECT and (--attack) rejects the self-signed server.
# Exit code 0 = all checks passed. All processes are cleaned up on exit.
set -uo pipefail

HERE=$(cd "$(dirname "$0")" && pwd)
REPO=$(cd "$HERE/../.." && pwd)
export PATH="$HOME/Documents/flutter/bin:/opt/homebrew/bin:$PATH"

DEVICE=${1:-}
[ -z "$DEVICE" ] && { sed -n '2,20p' "$0"; exit 64; }
shift
TARGET=lib/main.dart PORT=8899 MODE=debug EMU_HOST=0 DO_RESTART=1 DO_FALLBACK=1 APP_MODE="" ENTRY_DIR=.dart_tool/flutter_intercept ATTACK=0 EVIL_PORT=8443 LAN="" TOKEN=""
GRPC=0 GRPC_PORT=50051 GRPC_OFF=0 ISOLATES=0
export FI_TEMPLATE=${FI_TEMPLATE:-v6}
APP="$REPO/samples/demo_app"
DEFINES=()
while [ $# -gt 0 ]; do
  case $1 in
    --target) TARGET=$2; shift ;;
    --port) PORT=$2; shift ;;
    --profile) MODE=profile; DO_RESTART=0 ;;
    --emulator-host) EMU_HOST=1 ;;
    --no-restart) DO_RESTART=0 ;;
    --no-fallback) DO_FALLBACK=0 ;;
    --dart-define) DEFINES+=("--dart-define=$2"); shift ;;
    --app) APP=$(cd "$2" && pwd); shift ;;
    --template) FI_TEMPLATE=$2; shift ;;
    --entry-dir) ENTRY_DIR=$2; shift ;;
    --attack) ATTACK=1 ;;
    --evil-port) EVIL_PORT=$2; shift ;;
    --lan) LAN=$2; shift ;;
    --grpc) GRPC=1 ;;
    --grpc-port) GRPC_PORT=$2; shift ;;
    --grpc-off) GRPC_OFF=1 ;;
    --isolates) ISOLATES=1 ;;
    --app-mode) APP_MODE=$2; shift
      case $APP_MODE in
        charles|env) DEFINES+=("--dart-define=APP_FINDPROXY=$APP_MODE") ;;
        callback|context|dio_validate) DEFINES+=("--dart-define=APP_PINNING=$APP_MODE") ;;
        *) echo "unknown app mode $APP_MODE" >&2; exit 64 ;;
      esac ;;
    *) echo "unknown option $1" >&2; exit 64 ;;
  esac
  shift
done

WORK=$(mktemp -d "${TMPDIR:-/tmp}/fi_e2e.XXXXXX")
LOG="$WORK/flutter.log" PLOG="$WORK/proxy.log" FIFO="$WORK/stdin.fifo"
PROXY_PID="" FLUTTER_PID="" HOLDER_PID="" EVIL_PID="" GRPC_PID="" INSTALLER_PID="" ANDROID=0 FAILS=0
GLOG="$WORK/grpc_server.log" ILOG="$WORK/installer.log"
echo "[e2e] device=$DEVICE target=$TARGET mode=$MODE template=$FI_TEMPLATE app-mode=${APP_MODE:-default} port=$PORT grpc=$GRPC$( [ "$GRPC_OFF" = 1 ] && echo ' (FLUTTER_INTERCEPT_GRPC=0)') isolates=$ISOLATES logs=$WORK"

pass() { echo "[e2e] PASS $*"; }
fail() { echo "[e2e] FAIL $*"; FAILS=$((FAILS + 1)); }

start_proxy() { # [token]
  : > "$PLOG"
  local lan_args=()
  [ -n "$LAN" ] && lan_args=(--bind "$LAN" --token "${1:-$TOKEN}")
  # --ca: per-host leaves signed by a CA (like the extension's per-install CA); the v3 entry trusts it.
  dart run "$HERE/mitm_proxy.dart" --port "$PORT" --certs "$WORK/certs" --ca "$WORK/ca" \
    --mock users/2 --block comments/1 ${lan_args[@]+"${lan_args[@]}"} >> "$PLOG" 2>&1 &
  PROXY_PID=$!
  for _ in $(seq 1 60); do grep -q PROXY_READY "$PLOG" && return 0; sleep 0.5; done
  echo "[e2e] proxy did not start:"; cat "$PLOG"; return 1
}
stop_proxy() {
  [ -n "$PROXY_PID" ] && { kill "$PROXY_PID" 2>/dev/null; wait "$PROXY_PID" 2>/dev/null; }
  pkill -f "mitm_proxy.dart --port $PORT " 2>/dev/null
  PROXY_PID=""
}

cleanup() {
  if [ -n "$FLUTTER_PID" ] && kill -0 "$FLUTTER_PID" 2>/dev/null; then
    printf 'q' > "$FIFO" 2>/dev/null
    for _ in $(seq 1 20); do kill -0 "$FLUTTER_PID" 2>/dev/null || break; sleep 0.5; done
    kill "$FLUTTER_PID" 2>/dev/null
  fi
  [ -n "$HOLDER_PID" ] && kill "$HOLDER_PID" 2>/dev/null
  stop_proxy
  [ -n "$EVIL_PID" ] && { kill "$EVIL_PID" 2>/dev/null; pkill -f "evil_server.dart --port $EVIL_PORT --dir" 2>/dev/null; }
  [ -n "$GRPC_PID" ] && { kill "$GRPC_PID" 2>/dev/null; pkill -f "bin/server.dart --port $GRPC_PORT " 2>/dev/null; }
  [ -n "$INSTALLER_PID" ] && kill "$INSTALLER_PID" 2>/dev/null
  [ "$ANDROID" = 1 ] && [ "$ATTACK" = 1 ] && adb -s "$DEVICE" reverse --remove "tcp:$EVIL_PORT" 2>/dev/null
  [ "$ANDROID" = 1 ] && [ "$EMU_HOST" = 0 ] && adb -s "$DEVICE" reverse --remove "tcp:$PORT" 2>/dev/null
  echo "[e2e] logs kept in $WORK"
}
trap cleanup EXIT
trap 'exit 130' INT TERM

new_token() { python3 -c "import secrets,base64;print(base64.urlsafe_b64encode(secrets.token_bytes(32)).rstrip(b'=').decode())"; }
if [ -n "$LAN" ]; then TOKEN=$(new_token); HOST=$LAN; fi
if lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  echo "[e2e] port $PORT is busy"; exit 2
fi

# --- device kind / proxy host
[ -z "$LAN" ] && HOST=localhost
if [ -z "$LAN" ] && adb -s "$DEVICE" get-state >/dev/null 2>&1; then
  ANDROID=1
  if [ "$EMU_HOST" = 1 ]; then
    HOST=10.0.2.2
  else
    adb -s "$DEVICE" reverse "tcp:$PORT" "tcp:$PORT" >/dev/null || { echo "[e2e] adb reverse failed"; exit 2; }
  fi
fi

start_proxy || exit 2
export FI_CA_CERT="$WORK/ca/ca.pem"

if [ "$ATTACK" = 1 ]; then
  dart run "$HERE/evil_server.dart" --port "$EVIL_PORT" --dir "$WORK/evil" > "$WORK/evil.log" 2>&1 &
  EVIL_PID=$!
  for _ in $(seq 1 60); do grep -q EVIL_READY "$WORK/evil.log" && break; sleep 0.5; done
  grep -q EVIL_READY "$WORK/evil.log" || { echo "[e2e] evil server did not start"; cat "$WORK/evil.log"; exit 2; }
  # localhost:8443 on the device reaches the host's evil server (adb reverse on Android);
  # a physical iPhone reaches it on the Mac's LAN address.
  [ "$ANDROID" = 1 ] && adb -s "$DEVICE" reverse "tcp:$EVIL_PORT" "tcp:$EVIL_PORT" >/dev/null
  DEFINES+=("--dart-define=EVIL_URL=https://${LAN:-localhost}:$EVIL_PORT/attack")
fi

if [ "$GRPC" = 1 ]; then
  (cd "$HERE/grpc_server" && dart pub get >/dev/null 2>&1)
  (cd "$HERE/grpc_server" && exec dart run bin/server.dart --port "$GRPC_PORT" --tls-port $((GRPC_PORT + 1))) > "$GLOG" 2>&1 &
  GRPC_PID=$!
  for _ in $(seq 1 60); do grep -q GRPC_SERVER_READY "$GLOG" && break; sleep 0.5; done
  grep -q GRPC_SERVER_READY "$GLOG" || { echo "[e2e] gRPC server did not start"; cat "$GLOG"; exit 2; }
  # The demo reaches the host machine at 10.0.2.2 from the Android emulator, localhost elsewhere.
  DEFINES+=("--dart-define=GRPC_PORT=$GRPC_PORT" "--dart-define=GRPC_TLS_PORT=$((GRPC_PORT + 1))")
  [ "$GRPC_OFF" = 1 ] && DEFINES+=("--dart-define=FLUTTER_INTERCEPT_GRPC=0")
fi

# --- entry (v3: device independent; the proxy address is a dart-define)
ENTRY_ABS=$("$HERE/gen_entry.sh" "$APP" "$TARGET" "$HOST" "$PORT" "$ENTRY_DIR") || exit 2
ENTRY_REL="$ENTRY_DIR/$(basename "$ENTRY_ABS")"
SHA=$(shasum "$APP/$ENTRY_REL" | cut -c1-12)
if [ -n "$LAN" ]; then
  DEFINES+=("--dart-define=FLUTTER_INTERCEPT_PROXY=flutter-intercept:$TOKEN@$HOST:$PORT")
else
  DEFINES+=("--dart-define=FLUTTER_INTERCEPT_PROXY=$HOST:$PORT")
fi
echo "[e2e] entry=$ENTRY_REL proxy=$HOST:$PORT$( [ -n "$LAN" ] && echo ' (LAN, token-gated)') sha=$SHA"

# --- flutter run, stdin from a fifo so we can send r/R/q
mkfifo "$FIFO"
: > "$LOG" # exists before flutter run's redirect (which waits for the fifo) so wait_batch can grep it
sleep 100000 > "$FIFO" &
HOLDER_PID=$!
PAUSED=()
[ "$ISOLATES" = 1 ] && PAUSED=(--start-paused)
(cd "$APP" && exec flutter run -d "$DEVICE" -t "$ENTRY_REL" "--$MODE" ${PAUSED[@]+"${PAUSED[@]}"} \
  "--dart-define=FLUTTER_INTERCEPT_ENTRY_SHA=$SHA" ${DEFINES[@]+"${DEFINES[@]}"}) \
  < "$FIFO" > "$LOG" 2>&1 &
FLUTTER_PID=$!
if [ "$ISOLATES" = 1 ]; then
  # The VM service URI flutter run prints once the app is up (paused at start).
  for _ in $(seq 1 600); do grep -qE 'Dart VM Service on .* is available at: http' "$LOG" && break; kill -0 "$FLUTTER_PID" 2>/dev/null || break; sleep 1; done
  VMS=$(grep -oE 'Dart VM Service on .* is available at: http://[^ ]+' "$LOG" | head -1 | sed 's/.* is available at: //')
  [ -z "$VMS" ] && { echo "[e2e] no VM service URI"; tail -40 "$LOG"; exit 1; }
  node "$HERE/isolate_installer.mjs" "$VMS" > "$ILOG" 2>&1 &
  INSTALLER_PID=$!
fi

# Wait until the n-th "DEMO_BATCH done" appears (n counts across restarts).
wait_batch() {
  local n=$1 timeout=$2 t=0
  while [ "$(grep -c 'DEMO_BATCH done' "$LOG")" -lt "$n" ]; do
    if ! kill -0 "$FLUTTER_PID" 2>/dev/null; then echo "[e2e] flutter run exited"; tail -40 "$LOG"; return 1; fi
    t=$((t + 1)); [ $t -gt "$timeout" ] && { echo "[e2e] timeout waiting for batch $n"; tail -40 "$LOG"; return 1; }
    sleep 1
  done
}
# Result line of <label> from the n-th run (n-th DEMO_START block).
result() {
  awk -v n="$1" -v l="DEMO_RESULT $2 " '/DEMO_START/{k++} k==n && index($0,l){sub(/^.*DEMO_RESULT /,""); print; exit}' "$LOG"
}
expect() { # run label regex description
  local r; r=$(result "$1" "$2")
  if echo "$r" | grep -Eq "$3"; then pass "run$1 $2: $4"; else fail "run$1 $2: $4 — got: ${r:-<none>}"; fi
}
assert_intercepted() {
  local n=$1
  if [ "$APP_MODE" = dio_validate ]; then
    # Known residual limit: Dio's validateCertificate sees the proxy's leaf cert.
    expect "$n" dio_user  '^dio_user ERR .*certificate' "Dio validateCertificate rejects the MITM cert (residual limit)"
    expect "$n" dio_post  '^dio_post ERR .*certificate' "Dio POST rejected by validateCertificate (residual limit)"
    expect "$n" dio_user2 '^dio_user2 ERR .*certificate' "Dio mock rejected by validateCertificate (residual limit)"
  else
    expect "$n" dio_user    '^dio_user 200 .*"_intercepted":true.*"name":"EDITED BY TOOL"' "Dio GET edited by proxy"
    expect "$n" dio_post    '^dio_post 201 .*"_intercepted":true' "Dio POST edited"
    expect "$n" dio_user2   '^dio_user2 200 .*MOCKED BY TOOL' "mocked (no upstream)"
  fi
  expect "$n" http_todo   '^http_todo 200 .*"_intercepted":true' "package:http GET edited"
  expect "$n" http_gzip   '^http_gzip 200 .*"_intercepted":true,"gzipped":true' "gzip body decoded after proxy re-gzip"
  expect "$n" http_plain  '^http_plain 200 .*"_intercepted":true' "plain http:// via proxy"
  expect "$n" http_comment '^http_comment 403 .*"blocked":true' "blocked"
}
# Template v4 (CONTRACTS §9.1): first lib/ frame of the trace the proxy got for the newest request
# matching <method> <url-regex>, as `fn (package:demo_app/file.dart:line:col)`.
trace_frame() {
  python3 - "$PLOG" "$1" "$2" <<'PY'
import json, re, sys
log, method, url = sys.argv[1], sys.argv[2], re.compile(sys.argv[3])
ids, traces = [], {}
for line in open(log, errors='replace'):
    m = re.search(r'PROXY_REQ (\S+) (\S+) .* fi=(\S+)', line)
    if m and m.group(1) == method and url.search(m.group(2)):
        ids.append(m.group(3))
    t = re.search(r'PROXY_TRACE (\S+) (".*")$', line)
    if t:
        traces[t.group(1)] = json.loads(t.group(2))
for i in reversed(ids):
    if i in traces:
        for f in traces[i].split('\n'):
            m = re.match(r'#\d+\s+(.*\(package:demo_app/.*\))$', f)
            if m:
                print(m.group(1)); sys.exit(0)
        print('<no app frame>'); sys.exit(0)
print('<no trace>' if ids else '<no request with x-fi-id>')
PY
}
expect_trace() { # method url-regex frame-regex description
  local f; f=$(trace_frame "$1" "$2")
  if echo "$f" | grep -Eq "$3"; then pass "source of $4: $f"; else fail "source of $4 — got: $f"; fi
}
assert_traces() {
  case $FI_TEMPLATE in v4|v5|v6) ;; *) return 0 ;; esac
  # package:http opens the connection synchronously from the app's call: always found (AOT/profile
  # stacks have no column).
  expect_trace POST 'jsonplaceholder\.typicode\.com/todos$' '^OrdersApi\.createOrder \(package:demo_app/api/orders_api\.dart:1[0-9][:)]' "http POST (OrdersApi.createOrder)"
  expect_trace GET 'jsonplaceholder\.typicode\.com/todos/1$' '^_httpGet \(package:demo_app/demo\.dart:' "http GET (_httpGet)"
  if [ "$MODE" = debug ]; then
    # Dio opens it several async hops later: found through the entry's zone chains (debug only).
    expect_trace GET 'jsonplaceholder\.typicode\.com/albums/1$' '^CatalogApi\.fetchAlbum \(package:demo_app/api/catalog_api\.dart:3[0-9][:)]' "Dio GET with interceptors (CatalogApi.fetchAlbum)"
    expect_trace GET 'jsonplaceholder\.typicode\.com/users/1$' '^dioUser\.<anonymous closure> \(package:demo_app/demo\.dart:' "Dio GET (dioUser)"
    expect_trace POST 'jsonplaceholder\.typicode\.com/posts$' '^dioPost\.<anonymous closure> \(package:demo_app/demo\.dart:' "Dio POST (dioPost)"
  fi
}
expect_note() { # text description
  if grep -q "\[flutter_intercept\] $1" "$LOG"; then pass "console note: $2"; else fail "missing console note '[flutter_intercept] $1'"; fi
}
assert_direct() { # run [https-only]
  local n=$1
  expect "$n" dio_user    '^dio_user 200 .*"name":"Leanne Graham"' "Dio GET direct (proxy down)"
  expect "$n" http_todo   '^http_todo 200 ms=[0-9]+ \{"userId"' "http GET direct"
  expect "$n" dio_post    '^dio_post 201 ms=[0-9]+ \{"title"' "POST direct"
  expect "$n" http_gzip   '^http_gzip 200 ms=[0-9]+ \{"gzipped":true' "gzip direct"
  expect "$n" http_comment '^http_comment 200 ' "previously blocked URL now direct"
  # A stale adb reverse with no proxy breaks plain http (known, CONTRACTS §2); HTTPS still falls back.
  [ "${2:-}" = https-only ] || expect "$n" http_plain '^http_plain 200 ms=[0-9]+ \{"args"' "plain http direct"
}
assert_attack() { # run phase
  [ "$ATTACK" = 1 ] || return 0
  local n=$1 r
  r=$(result "$n" attack)
  if echo "$r" | grep -q '"evil":true'; then
    fail "run$n attack ($2): self-signed CN=evil.example ACCEPTED — got: $r"
  elif [ "$2" = proxy-down ]; then
    expect "$n" attack '^attack ERR .*CERTIFICATE_VERIFY_FAILED' "self-signed server rejected on the DIRECT fallback (CERTIFICATE_VERIFY_FAILED)"
  else
    expect "$n" attack '^attack (4[0-9][0-9]|5[0-9][0-9]|ERR) ' "self-signed server never accepted through the proxy (proxy refuses upstream / local target)"
  fi
}

# --- gRPC (template v6, CONTRACTS §16.1)
wait_grpc() { # n timeout
  [ "$GRPC" = 1 ] || return 0
  local n=$1 timeout=$2 t=0
  while [ "$(grep -c 'DEMO_GRPC done' "$LOG")" -lt "$n" ]; do
    t=$((t + 1)); [ $t -gt "$timeout" ] && { echo "[e2e] timeout waiting for gRPC batch $n"; return 1; }
    sleep 1
  done
}
# Port of the connection the gRPC server saw for <label> in run n ("servedTo":"<addr>:<port>").
served_port() { result "$1" "$2" | grep -oE '"servedTo":"[^"]*"' | head -1 | sed -E 's/.*:([0-9]+)"$/\1/'; }
# Upstream ports of the proxy's silent tunnels whose first bytes were <kind> (h2c|tls).
tunnel_ports() { grep -oE "PROXY_SILENT [^ ]+ first=$1 via=[0-9]+" "$PLOG" | sed -E 's/.*via=//'; }
expect_route() { # run label kind(h2c|tls) want(tunnel|direct) description
  local p; p=$(served_port "$1" "$2")
  if [ -z "$p" ]; then fail "run$1 $2: no servedTo — got: $(result "$1" "$2")"; return; fi
  if tunnel_ports "$3" | grep -qx "$p"; then
    [ "$4" = tunnel ] && pass "run$1 $2: $5 (silent tunnel, $3, upstream port $p)" || fail "run$1 $2: went through the proxy (port $p), expected direct"
  else
    [ "$4" = direct ] && pass "run$1 $2: $5 (direct, port $p)" || fail "run$1 $2: not through the proxy (port $p not a $3 tunnel)"
  fi
}
assert_grpc() { # run tunnel|direct [isolate-want]
  [ "$GRPC" = 1 ] || return 0
  local n=$1 want=$2 iso=${3:-$2}
  expect "$n" grpc_unary '^grpc_unary 0 .*"status":"ORDER_STATUS_SHIPPED".*"server":"fi-grpc-server"' "gRPC unary"
  expect "$n" grpc_stream '^grpc_stream 0 .*"events":\["1:ORDER_STATUS_PENDING","2:ORDER_STATUS_SHIPPED","3:ORDER_STATUS_DELIVERED"\]' "gRPC server streaming (3 events)"
  expect "$n" grpc_client_stream '^grpc_client_stream 0 .*"count":3,"quantity":6' "gRPC client streaming"
  expect "$n" grpc_bidi '^grpc_bidi 0 .*"replies":\["echo: hello 1","echo: hello 2","echo: hello 3"\]' "gRPC bidi streaming"
  expect "$n" grpc_missing '^grpc_missing ERR .*code: 5' "gRPC error status NOT_FOUND (trailers) passes unchanged"
  expect "$n" grpc_tls '^grpc_tls 0 .*"status":"ORDER_STATUS_SHIPPED"' "gRPC over TLS (app trusts the server's self-signed cert)"
  for l in grpc_unary grpc_stream grpc_client_stream grpc_bidi; do expect_route "$n" $l h2c "$want" "$l"; done
  expect_route "$n" grpc_tls tls "$want" "grpc_tls"
  expect "$n" grpc_isolate '^grpc_isolate 0 ' "gRPC from Isolate.run"
  expect_route "$n" grpc_isolate h2c "$iso" "grpc_isolate"
}

BUILD_TIMEOUT=600
GRPC_WANT=tunnel ISO_WANT=direct
[ "$GRPC_OFF" = 1 ] && GRPC_WANT=direct
[ "$ISOLATES" = 1 ] && ISO_WANT=$GRPC_WANT
wait_batch 1 $BUILD_TIMEOUT || exit 1
if grep -q "Launching $ENTRY_DIR/" "$LOG"; then pass "flutter run accepted the .dart_tool/ target"; fi
assert_intercepted 1
assert_attack 1 proxy-up
wait_grpc 1 120 && assert_grpc 1 "$GRPC_WANT" "$ISO_WANT"
grep -q 'PROXY_EDIT 200 GET https://httpbin.org/gzip gzip=true' "$PLOG" \
  && pass "proxy saw gzip upstream body and re-gzipped it" || fail "proxy gzip edit line missing"
sleep 1 # traces are flushed ~100 ms after the request
assert_traces
if [ "$FI_TEMPLATE" != v1 ]; then
  case $APP_MODE in
    charles|env) expect_note 'ignored app findProxy' "app findProxy ignored" ;;
    callback) [ "$FI_TEMPLATE" = v2 ] && expect_note 'ignored app badCertificateCallback' "app badCertificateCallback ignored" ;;
  esac
  n=$(grep -c '\[flutter_intercept\]' "$LOG")
  [ "$n" -le 2 ] && pass "console notes logged once ($n line(s))" || fail "console notes repeated ($n lines)"
fi

RUN=1
if [ "$DO_RESTART" = 1 ]; then
  printf 'R' > "$FIFO"
  RUN=$((RUN + 1)); wait_batch $RUN 120 || exit 1
  grep -q 'Restarted application' "$LOG" && pass "hot restart" || fail "no 'Restarted application'"
  assert_intercepted $RUN
  assert_attack $RUN proxy-up
  wait_grpc $RUN 120 && assert_grpc $RUN "$GRPC_WANT" "$ISO_WANT"
  sleep 1
  assert_traces
  if [ "$FI_TEMPLATE" = v4 ] || [ "$FI_TEMPLATE" = v5 ] || [ "$FI_TEMPLATE" = v6 ]; then
    p=$(grep -o 'fi=[0-9a-f]*-' "$PLOG" | sort -u | wc -l | tr -d ' ')
    [ "$p" -ge 2 ] && pass "trace ids get a new prefix after hot restart ($p prefixes)" || fail "trace id prefix not renewed by hot restart ($p)"
  fi
fi

if [ -n "$LAN" ]; then
  grep -q "$TOKEN" "$PLOG" "$LOG" && fail "token leaked into a log" || pass "token never logged (proxy, flutter run)"
  grep -q PROXY_407 "$PLOG" && fail "unexpected 407 with the right token" || pass "no 407 with the right token"
fi

if [ -n "$LAN" ] && [ "$DO_RESTART" = 1 ] && [ "$MODE" = debug ]; then
  # Wrong token: the proxy restarts with a new token while the app still carries the old one.
  stop_proxy
  start_proxy "$(new_token)" || exit 2
  printf 'R' > "$FIFO"
  RUN=$((RUN + 1)); wait_batch $RUN 120 || exit 1
  echo "[e2e] -- wrong token (run$RUN)"
  grep -q PROXY_407 "$PLOG" && pass "proxy answered 407 to the stale token" || fail "no 407 logged"
  expect "$RUN" dio_user   '^dio_user 200 .*"name":"Leanne Graham"' "HTTPS: CONNECT 407 -> Dart falls back to verified DIRECT (not intercepted)"
  expect "$RUN" http_todo  '^http_todo 200 ms=[0-9]+ \{"userId"' "package:http HTTPS direct"
  expect "$RUN" http_plain '^http_plain 407 ' "plain http:// gets the 407 response (no fallback for plain requests)"
  assert_attack $RUN proxy-down
fi

if [ "$DO_FALLBACK" = 1 ] && [ "$MODE" = debug ]; then
  stop_proxy
  if [ "$ANDROID" = 1 ] && [ "$EMU_HOST" = 0 ]; then
    # Proxy down but adb reverse still in place (VS Code closed without cleanup).
    printf 'R' > "$FIFO"
    RUN=$((RUN + 1)); wait_batch $RUN 120 || exit 1
    echo "[e2e] -- proxy down, adb reverse kept (run$RUN)"
    assert_direct $RUN https-only
    assert_attack $RUN proxy-down
    # adb reverse accepts the hop and drops it: grpc-dart sees connected-then-lost (reported, not asserted).
    wait_grpc $RUN 120 && for l in grpc_unary grpc_stream grpc_client_stream grpc_bidi grpc_tls grpc_isolate; do echo "[e2e] INFO run$RUN $(result $RUN $l)"; done
    grep '\[flutter_intercept\] gRPC' "$LOG" | sed 's/^/[e2e] INFO /'
    adb -s "$DEVICE" reverse --remove "tcp:$PORT" >/dev/null
  fi
  printf 'R' > "$FIFO"
  RUN=$((RUN + 1)); wait_batch $RUN 120 || exit 1
  echo "[e2e] -- proxy down$( [ "$ANDROID" = 1 ] && [ "$EMU_HOST" = 0 ] && echo ', adb reverse removed') (run$RUN)"
  assert_direct $RUN
  assert_attack $RUN proxy-down
  # The gRPC breaker may still hold an authority direct from the previous stage: either way, direct.
  wait_grpc $RUN 120 && assert_grpc $RUN direct direct
fi

echo "[e2e] ---- $( [ $FAILS = 0 ] && echo ALL PASSED || echo "$FAILS FAILED" ) ($DEVICE, $TARGET, $MODE)"
[ $FAILS = 0 ]
