#!/usr/bin/env bash
# Regenerates the Dart code for protos/**/*.proto into lib/src/generated (the app) and
# scripts/e2e/grpc_server/lib/src/generated (the test server). Needs `protoc` (with its bundled
# google/protobuf/*.proto) and protoc-gen-dart: `dart pub global activate protoc_plugin 25.1.0`.
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
APP=$(cd "$HERE/.." && pwd)
SERVER=$(cd "$APP/../../scripts/e2e/grpc_server" && pwd)
PROTOC=${PROTOC:-$(command -v protoc)}
INCLUDE=$(cd "$(dirname "$PROTOC")/../include" 2>/dev/null && pwd || true)
export PATH="$HOME/.pub-cache/bin:$PATH"
protos=$(cd "$HERE" && find . -name '*.proto' | sed 's|^\./||' | sort)
for out in "$APP/lib/src/generated" "$SERVER/lib/src/generated"; do
  rm -rf "$out"
  mkdir -p "$out"
  # shellcheck disable=SC2086
  (cd "$HERE" && "$PROTOC" -I. ${INCLUDE:+-I"$INCLUDE"} --dart_out=grpc:"$out" $protos)
done
echo "generated: $(cd "$APP/lib/src/generated" && find . -name '*.dart' | sort | tr '\n' ' ')"
