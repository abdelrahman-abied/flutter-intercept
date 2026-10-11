// A stand-in for agent S's protobuf codec (src/grpc/index.ts): host-side tests only need its shape. "Protobuf" bytes
// here are `PB:` + JSON text; decodeRaw reports them as one string field 1; encodeMessage validates fields by name.
import type { Exchange } from '@flutter-intercept/proxy';
import type { GrpcDeps, GrpcSchemaStatus } from '../../src/grpc/service';
import type { GrpcCodec, GrpcMethod, GrpcSchema, GrpcSourceFile, ProtoEnum, ProtoMessage } from '../../src/grpc/types';

export const METHODS: GrpcMethod[] = [
  { path: '/shop.v1.CartService/AddItem', requestType: 'shop.v1.AddItemRequest', responseType: 'shop.v1.Cart', clientStreaming: false, serverStreaming: false, file: '/ws/app/lib/gen/shop.pbgrpc.dart', line: 40 },
  { path: '/shop.v1.CartService/Watch', requestType: 'shop.v1.WatchRequest', responseType: 'shop.v1.Cart', clientStreaming: false, serverStreaming: true, file: '/ws/app/lib/gen/shop.pbgrpc.dart', line: 60 },
];

export const MESSAGES: ProtoMessage[] = [
  {
    name: 'shop.v1.AddItemRequest',
    dartClass: 'AddItemRequest',
    file: '/ws/app/lib/gen/shop.pb.dart',
    fields: [
      { number: 1, name: 'sku', type: { kind: 'scalar', scalar: 'string' } },
      { number: 2, name: 'quantity', type: { kind: 'scalar', scalar: 'int32' } },
      { number: 3, name: 'sessionToken', type: { kind: 'scalar', scalar: 'string' } },
    ],
  },
  {
    name: 'shop.v1.Cart',
    dartClass: 'Cart',
    file: '/ws/app/lib/gen/shop.pb.dart',
    line: 12,
    fields: [
      { number: 1, name: 'items', type: { kind: 'message', type: 'shop.v1.Cart.Line' }, repeated: true },
      { number: 2, name: 'total', type: { kind: 'scalar', scalar: 'int64' } },
      { number: 3, name: 'color', type: { kind: 'enum', type: 'shop.v1.Color' } },
    ],
  },
  { name: 'shop.v1.Cart.Line', dartClass: 'Cart_Line', file: '/ws/app/lib/gen/shop.pb.dart', fields: [{ number: 1, name: 'sku', type: { kind: 'scalar', scalar: 'string' } }] },
  { name: 'shop.v1.WatchRequest', dartClass: 'WatchRequest', file: '/ws/app/lib/gen/shop.pb.dart', fields: [] },
];

export const ENUMS: ProtoEnum[] = [{ name: 'shop.v1.Color', dartClass: 'Color', file: '/ws/app/lib/gen/shop.pbenum.dart', values: [{ name: 'RED', number: 0 }, { name: 'BLUE', number: 1 }] }];

export function fakeSchema(methods = METHODS, messages = MESSAGES, problems: string[] = []): GrpcSchema {
  return {
    method: (p) => methods.find((m) => m.path === p),
    message: (n) => messages.find((m) => m.name === n),
    enumType: (n) => ENUMS.find((e) => e.name === n),
    methods,
    messages,
    problems,
  };
}

const PREFIX = 'PB:';

/** Bytes of a fake "protobuf" message holding `json`. */
export function pb(json: unknown): Uint8Array {
  return new Uint8Array(Buffer.from(PREFIX + JSON.stringify(json), 'utf8'));
}
export const pb64 = (json: unknown): string => Buffer.from(pb(json)).toString('base64');

export function fakeCodec(loaded: { files?: GrpcSourceFile[][] } = {}): GrpcCodec {
  return {
    loadGrpcSchema(files) {
      (loaded.files ??= []).push(files);
      return files.length ? fakeSchema() : fakeSchema([], []);
    },
    decodeMessage(schema, type, bytes) {
      const text = Buffer.from(bytes).toString('utf8');
      if (!text.startsWith(PREFIX)) return { error: 'not a message' };
      if (!schema.message(type)) return { error: `unknown type ${type}` };
      return { json: JSON.parse(text.slice(PREFIX.length)) };
    },
    decodeRaw(bytes) {
      const text = Buffer.from(bytes).toString('utf8');
      if (text === 'garbage') return { error: 'invalid wire type' };
      return { fields: [{ number: 1, wireType: 2, value: text, as: 'string' }] };
    },
    encodeMessage(schema, type, json) {
      const m = schema.message(type);
      if (!m) throw new Error(`unknown type ${type}`);
      if (!json || typeof json !== 'object' || Array.isArray(json)) throw new Error('$: expected an object');
      for (const k of Object.keys(json as object)) if (!m.fields.some((f) => f.name === k)) throw new Error(`$.${k}: no such field in ${type}`);
      return pb(json);
    },
    skeleton(schema, type) {
      const m = schema.message(type);
      if (!m) throw new Error(`unknown type ${type}`);
      return Object.fromEntries(m.fields.map((f) => [f.name, f.type.kind === 'scalar' && f.type.scalar === 'string' ? '' : 0]));
    },
  };
}

export function fakeGrpc(o: { enabled?: boolean; schema?: GrpcSchema | null; status?: GrpcSchemaStatus } = {}): GrpcDeps & { on: boolean; listeners: (() => void)[]; onDidChange(l: () => void): { dispose(): void } } {
  const schema = o.schema === null ? undefined : (o.schema ?? fakeSchema());
  const g = {
    on: o.enabled ?? true,
    listeners: [] as (() => void)[],
    codec: fakeCodec(),
    enabled: () => g.on,
    schema: () => (g.on ? schema : undefined),
    status: () => (g.on ? (o.status ?? { methods: schema?.methods.length ?? 0, messages: schema?.messages.length ?? 0, problems: [], files: 3 }) : undefined),
    onDidChange(l: () => void) {
      g.listeners.push(l);
      return { dispose: () => undefined };
    },
  };
  return g;
}

let seq = 0;
/** A finished unary gRPC call to CartService/AddItem. */
export function grpcCall(over: Partial<Exchange> = {}): Exchange {
  seq++;
  return {
    id: `g${seq}`,
    startedAt: 5000 + seq,
    kind: 'grpc',
    method: 'POST',
    url: 'http://10.0.2.2:50051/shop.v1.CartService/AddItem',
    requestHeaders: { 'content-type': 'application/grpc', authorization: 'Bearer abc.def.ghi', 'x-session-bin': 'AAEC', te: 'trailers' },
    responseHeaders: { 'content-type': 'application/grpc', 'x-request-id': 'r-1' },
    responseTrailers: { 'grpc-status': '0', 'set-cookie': 'sid=1', 'x-trace-bin': 'AQID', 'x-region': 'eu' },
    state: 'completed',
    status: 200,
    durationMs: 12,
    grpc: { service: 'shop.v1.CartService', method: 'AddItem', statusCode: 0, messagesSent: 1, messagesReceived: 1 },
    frames: [
      { dir: 'send', at: 5001, kind: 'message', base64: pb64({ sku: 'A1', quantity: 2, sessionToken: 'tok-123' }), size: 40 },
      { dir: 'receive', at: 5005, kind: 'message', base64: pb64({ items: [{ sku: 'A1' }], total: '1999' }), size: 30 },
    ],
    ...over,
  };
}
