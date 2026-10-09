#!/usr/bin/env bash
# Writes <project>/.dart_tool/flutter_intercept/entry_<name>.dart from
# scripts/e2e/templates/entry_$FI_TEMPLATE.dart.tmpl (default v4 = v3 + request -> source traces,
# docs/spikes/template-v4.md; v3 = trusted per-install CA,
# docs/spikes/template-v3.md; v2 = accept-any wrapper; v1 = Phase 1).
# v3/v4 need FI_CA_CERT=<ca.pem>; its PROXY_HOST comes from --dart-define=FLUTTER_INTERCEPT_PROXY
# (PROXY_PORT only sets the default used by plain-Dart sessions).
# usage: gen_entry.sh <projectRoot> <targetRelPath e.g. lib/main_dev.dart> <proxyHost> <proxyPort> [outDir]
set -euo pipefail
root=$1 target=$2 host=$3 port=$4 outdir=${5:-.dart_tool/flutter_intercept}
pkg=$(awk '/^name:/{print $2; exit}' "$root/pubspec.yaml")
# v3 naming (CONTRACTS §1): full project-relative path, '/' -> '__' (lib/main.dart -> entry_lib__main.dart).
if [ "${FI_TEMPLATE:-v4}" != v1 ] && [ "${FI_TEMPLATE:-v4}" != v2 ]; then
  base=$(echo "${target%.dart}" | sed -e 's/[^A-Za-z0-9_/]/_/g' -e 's|/|__|g')
else
  base=$(basename "$target" .dart)
fi
mkdir -p "$root/$outdir"
out="$root/$outdir/entry_$base.dart"
case "$target" in
  lib/*) import="package:$pkg/${target#lib/}" ;;
  *) # relative from the entry's directory to the target
     depth=$(echo "$outdir" | awk -F/ '{print NF}'); up=""
     for _ in $(seq 1 "$depth"); do up="../$up"; done
     import="$up$target" ;;
esac
tmpl="$(dirname "$0")/templates/entry_${FI_TEMPLATE:-v4}.dart.tmpl"
[ -f "$tmpl" ] || { echo "no template $tmpl" >&2; exit 2; }
python3 - "$tmpl" "$out" "$import" "$host" "$port" "${FI_CA_CERT:-}" <<'PY'
import sys
tmpl, out, imp, host, port, ca = sys.argv[1:7]
s = open(tmpl).read()
if '{{CA_CERT_PEM}}' in s:
    if not ca:
        sys.exit('template needs FI_CA_CERT=<ca.pem>')
    s = s.replace('{{CA_CERT_PEM}}', open(ca).read().strip() + '\n')
s = s.replace('{{TARGET_IMPORT}}', imp).replace('{{PROXY_HOST}}', host).replace('{{PROXY_PORT}}', port)
open(out, 'w').write(s)
PY
echo "$out"
