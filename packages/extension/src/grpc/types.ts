// CONTRACTS §16.3: the gRPC contract read from the app's protoc-generated Dart (`*.pbgrpc.dart`, `*.pb.dart`,
// `*.pbenum.dart`). Pure: no vscode, no I/O here (the host passes file contents). Lead-owned types.

/** One generated Dart file, as read by the host (path for messages and "open source", text ≤ 2 MB). */
export interface GrpcSourceFile {
  path: string;
  text: string;
}

export type ProtoScalar =
  | 'double' | 'float'
  | 'int32' | 'int64' | 'uint32' | 'uint64' | 'sint32' | 'sint64'
  | 'fixed32' | 'fixed64' | 'sfixed32' | 'sfixed64'
  | 'bool' | 'string' | 'bytes';

export type ProtoFieldType =
  | { kind: 'scalar'; scalar: ProtoScalar }
  | { kind: 'enum'; type: string }       // fully-qualified enum name, e.g. pkg.Color
  | { kind: 'message'; type: string }    // fully-qualified message name, e.g. pkg.Outer.Inner
  | { kind: 'map'; key: ProtoScalar; value: ProtoFieldType };

export interface ProtoField {
  number: number;
  /** JSON name as in the generated builder chain (`_omitFieldNames ? '' : 'userId'`). */
  name: string;
  type: ProtoFieldType;
  repeated?: true;
  /** Packed repeated scalars (`PbFieldType.K*`, or proto3 default). Decoders accept both encodings anyway. */
  packed?: true;
  /** Name of the oneof group, when the field is in one. */
  oneof?: string;
  required?: true;
}

export interface ProtoMessage {
  /** Fully-qualified, e.g. `pkg.Outer.Inner`. */
  name: string;
  /** Dart class, e.g. `Outer_Inner`. */
  dartClass: string;
  fields: ProtoField[];
  file: string;
  line?: number;
}

export interface ProtoEnum {
  name: string;
  dartClass: string;
  values: { name: string; number: number }[];
  file: string;
}

export interface GrpcMethod {
  /** `/pkg.Service/Method`. */
  path: string;
  requestType: string;   // fully-qualified message name
  responseType: string;
  clientStreaming: boolean;
  serverStreaming: boolean;
  file: string;
  line?: number;
}

export interface GrpcSchema {
  method(path: string): GrpcMethod | undefined;
  message(name: string): ProtoMessage | undefined;
  enumType(name: string): ProtoEnum | undefined;
  readonly methods: readonly GrpcMethod[];
  readonly messages: readonly ProtoMessage[];
  /** Plain-words parse problems (file + reason), ≤ 50. */
  readonly problems: readonly string[];
}

export interface DecodeResult {
  /** Proto3 JSON: int64 as strings, bytes base64, enums by name (number when unknown), unknown fields under `"#<n>"`. */
  json?: unknown;
  error?: string;
}

/** `protoc --decode_raw` style tree: field number → values; nested messages / UTF-8 strings guessed. */
export interface RawField {
  number: number;
  wireType: 0 | 1 | 2 | 5;
  /** varint / fixed as decimal string; length-delimited: `string` when valid UTF-8 text, else `message` or `bytes`. */
  value: string | RawField[];
  as?: 'string' | 'message' | 'bytes' | 'varint' | 'fixed64' | 'fixed32';
}

/** Functions implemented in src/grpc/** (owner S). Bounded: ≤ 4 MB input, ≤ 100k fields, depth ≤ 32. */
export interface GrpcCodec {
  loadGrpcSchema(files: GrpcSourceFile[]): GrpcSchema;
  decodeMessage(schema: GrpcSchema, type: string, bytes: Uint8Array): DecodeResult;
  decodeRaw(bytes: Uint8Array): { fields?: RawField[]; error?: string };
  /** Throws an Error whose message names the JSON path ("$.items[2].price: expected a number"). */
  encodeMessage(schema: GrpcSchema, type: string, json: unknown): Uint8Array;
  /** Example JSON with every field set to a typical value (nested one level per message, cycles cut). */
  skeleton(schema: GrpcSchema, type: string): unknown;
}
