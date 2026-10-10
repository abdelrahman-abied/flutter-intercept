#!/usr/bin/env bash
# Device test for the headless CLI (CONTRACTS §13.9). Not part of `npm test`: needs Flutter and devices.
#
#   packages/cli/test/e2e.sh <device-id>...      e.g. packages/cli/test/e2e.sh macos emulator-5554 <simulator-udid>
#
# For each device, runs samples/demo_app/integration_test/app_test.dart through `flutter-intercept test` with the
# fixture rules (one mock applied, one map-remote skipped for approval), writes HAR + JUnit, and checks
#   1. the passing expectations → exit code 0, HAR with entries, JUnit without failures;
#   2. a failing expectation → exit code 1 (flutter's tests still pass).
# Physical iPhones use the LAN listener (the Mac needs a private LAN address; allow Local Network on the device once);
# boot simulators yourself and shut them down after.
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
repo="$(cd "$here/../../.." && pwd)"
demo="${FI_DEMO_DIR:-$repo/samples/demo_app}"  # FI_DEMO_DIR: another copy of the demo app
out="$(mktemp -d "${TMPDIR:-/tmp}/fi-cli-e2e.XXXXXX")"
trap 'rm -rf "$out"' EXIT

if [ "$#" -eq 0 ]; then
  echo "usage: $0 <device-id>..." >&2
  exit 2
fi
if ! grep -Eq '^[[:space:]]+integration_test:' "$demo/pubspec.yaml"; then
  echo "samples/demo_app/pubspec.yaml needs 'integration_test: {sdk: flutter}' in dev_dependencies" >&2
  exit 2
fi

(cd "$repo/packages/cli" && node build.mjs)
# Rules files must be inside the project's repository (or the project): keep a copy in the project's .dart_tool.
mkdir -p "$demo/.dart_tool/flutter_intercept"
cp "$here/fixtures/demo-rules.json" "$demo/.dart_tool/flutter_intercept/e2e-rules.json"
cli="$repo/packages/cli/dist/cli.js"

failures=0
for device in "$@"; do
  echo "=== $device: passing expectations"
  set +e
  node "$cli" test integration_test/app_test.dart --project "$demo" -d "$device" \
    --rules "$demo/.dart_tool/flutter_intercept/e2e-rules.json" --assert "$here/fixtures/demo-expect.json" \
    --har "$out/$device.har" --junit "$out/$device.xml"
  code=$?
  set -e
  if [ "$code" -ne 0 ]; then echo "FAIL $device: exit code $code (expected 0)"; failures=$((failures + 1)); continue; fi
  if ! node -e 'const h = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")); process.exit(h.log.entries.length >= 2 ? 0 : 1)' "$out/$device.har"; then
    echo "FAIL $device: HAR has fewer than 2 entries"; failures=$((failures + 1))
  fi
  if ! grep -q 'failures="0"' "$out/$device.xml"; then echo "FAIL $device: JUnit reports failures"; failures=$((failures + 1)); fi
  if [ -e "$demo/integration_test/.flutter_intercept" ]; then echo "FAIL $device: wrapper directory left behind"; failures=$((failures + 1)); fi

  echo "=== $device: failing expectation"
  set +e
  node "$cli" test integration_test/app_test.dart --project "$demo" -d "$device" --no-rules --assert "$here/fixtures/demo-expect-fail.json"
  code=$?
  set -e
  if [ "$code" -ne 1 ]; then echo "FAIL $device: exit code $code (expected 1)"; failures=$((failures + 1)); fi
done

if [ "$failures" -ne 0 ]; then
  echo "$failures check(s) failed"
  exit 1
fi
echo "all device checks passed: $*"
