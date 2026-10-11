# Adds the canonical proto3 JSON (Python protobuf / upb json_format) for each Dart-produced vector.
import base64, json, sys
sys.path.insert(0, sys.argv[1])
import common_pb2, shop_pb2, legacy_pb2, nopkg_pb2  # noqa: F401  (registers the types)
from google.protobuf import json_format, symbol_database, descriptor_pool, message_factory

src, dst = sys.argv[2], sys.argv[3]
vecs = json.load(open(src))
pool = descriptor_pool.Default()
out = []
for v in vecs:
    cls = message_factory.GetMessageClass(pool.FindMessageTypeByName(v['type']))
    m = cls()
    m.ParseFromString(base64.b64decode(v['base64']))
    v2 = {'name': v['name'], 'type': v['type'], 'base64': v['base64']}
    v2['json'] = json.loads(json_format.MessageToJson(m))
    if 'json' in v:
        v2['dartJson'] = v['json']
    out.append(v2)
json.dump(out, open(dst, 'w'), indent=1, ensure_ascii=False)
