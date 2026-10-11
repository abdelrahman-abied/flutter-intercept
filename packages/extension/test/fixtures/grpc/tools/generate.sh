#!/bin/bash
# Regenerates the protoc_plugin fixtures (v21..v25) and vectors.json used by test/unit/grpc.
# Needs protoc, dart and a python3 with the `protobuf` package. Usage:
#   WORK=/some/scratch/dir PROTOC=protoc PROTO_INCLUDE=/path/to/include PYTHON=python3 ./generate.sh
set -eu
HERE=$(cd "$(dirname "$0")" && pwd)
F=$(dirname "$HERE")
P=$F/proto
WORK=${WORK:?set WORK to a scratch directory}
PROTOC=${PROTOC:-protoc}
I=${PROTO_INCLUDE:?set PROTO_INCLUDE to the directory holding google/protobuf/*.proto}
PYTHON=${PYTHON:-python3}
mkdir -p "$WORK"

for v in 21.1.2 22.5.0 23.0.0 24.0.0 25.1.0; do
  maj=${v%%.*}
  d=$WORK/plug-$v
  mkdir -p "$d"
  printf 'name: plug_%s\nenvironment:\n  sdk: ">=3.0.0 <4.0.0"\ndependencies:\n  protoc_plugin: %s\n' "${v//./_}" "$v" > "$d/pubspec.yaml"
  (cd "$d" && dart pub get >/dev/null)
  printf '#!/bin/sh\ncd %s && exec dart run protoc_plugin:protoc_plugin "$@"\n' "$d" > "$d/gen.sh"
  chmod +x "$d/gen.sh"
  out=$WORK/out-$v
  rm -rf "$out"; mkdir -p "$out"
  extra=()
  # protoc_plugin < 25 generates the well-known types next to the app's files; 25 imports package:protobuf.
  if [ "$maj" != 25 ]; then
    for n in any duration empty field_mask struct timestamp wrappers; do extra+=("google/protobuf/$n.proto"); done
  fi
  (cd "$P" && "$PROTOC" --plugin=protoc-gen-dart="$d/gen.sh" --dart_out=grpc:"$out" -I . -I "$I" *.proto ${extra[@]+"${extra[@]}"})
  rm -rf "$F/v$maj"; mkdir -p "$F/v$maj"
  (cd "$out" && find . -name '*.dart' ! -name '*.pbjson.dart' ! -name '*.pbserver.dart' | while read -r f; do
    mkdir -p "$F/v$maj/$(dirname "$f")"; cp "$f" "$F/v$maj/$f"; done)
done

# protobuf 6.1.0's own well-known types, laid out like a pub cache entry.
W=${PUB_CACHE:-$HOME/.pub-cache}/hosted/pub.dev/protobuf-6.1.0/lib/well_known_types/google/protobuf
T=$F/v25/protobuf-6.1.0/lib/well_known_types/google/protobuf
mkdir -p "$T"
for n in any duration empty field_mask struct timestamp wrappers; do cp "$W/$n.pb.dart" "$T/"; done
cp "$W/struct.pbenum.dart" "$T/"

# Vectors: bytes + toProto3Json() from the Dart runtime, canonical JSON from python protobuf.
V=$WORK/vec
mkdir -p "$V/bin" "$V/lib/gen"
printf 'name: vec\nenvironment:\n  sdk: ">=3.7.0 <4.0.0"\ndependencies:\n  protobuf: 6.1.0\n  fixnum: any\n' > "$V/pubspec.yaml"
cp "$HERE/vec.dart" "$V/bin/vec.dart"
cp "$WORK"/out-25.1.0/{common,shop,legacy,nopkg}.{pb,pbenum}.dart "$V/lib/gen/"
(cd "$V" && dart pub get >/dev/null && dart run bin/vec.dart "$WORK/dart-vectors.json")
mkdir -p "$WORK/py"
(cd "$P" && "$PROTOC" -I . -I "$I" --python_out="$WORK/py" *.proto)
"$PYTHON" -I "$HERE/canon.py" "$WORK/py" "$WORK/dart-vectors.json" "$F/vectors.json"
