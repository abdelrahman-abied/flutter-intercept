// Google well-known types (google/protobuf/*.proto): built-in definitions, used when the app's generated
// files for them weren't loaded (protoc_plugin ≥ 25 imports them from package:protobuf), and their special
// proto3 JSON forms (Timestamp → RFC 3339, Duration → "1.5s", wrappers → bare values, Struct → object, …).

import type { ProtoEnum, ProtoField, ProtoMessage, ProtoScalar } from './types';

/** Classes per well-known file, keyed by the file's base name. */
export const WKT_FILES: Record<string, string[]> = {
  any: ['Any'],
  duration: ['Duration'],
  empty: ['Empty'],
  field_mask: ['FieldMask'],
  struct: ['Struct', 'Value', 'ListValue', 'NullValue'],
  timestamp: ['Timestamp'],
  wrappers: ['DoubleValue', 'FloatValue', 'Int64Value', 'UInt64Value', 'Int32Value', 'UInt32Value', 'BoolValue', 'StringValue', 'BytesValue'],
};

const P = 'google.protobuf.';

const WRAPPERS: Record<string, ProtoScalar> = {
  DoubleValue: 'double',
  FloatValue: 'float',
  Int64Value: 'int64',
  UInt64Value: 'uint64',
  Int32Value: 'int32',
  UInt32Value: 'uint32',
  BoolValue: 'bool',
  StringValue: 'string',
  BytesValue: 'bytes',
};

const scalar = (number: number, name: string, s: ProtoScalar, extra: Partial<ProtoField> = {}): ProtoField => ({
  number,
  name,
  type: { kind: 'scalar', scalar: s },
  ...extra,
});

/** Built-in definitions for the given well-known files (all when omitted). */
export function builtinWellKnownTypes(files?: Iterable<string>): (ProtoMessage | ProtoEnum)[] {
  const want = new Set(files ?? Object.keys(WKT_FILES));
  const out: (ProtoMessage | ProtoEnum)[] = [];
  const msg = (file: string, cls: string, fields: ProtoField[]): ProtoMessage => ({
    name: P + cls,
    dartClass: cls,
    fields,
    file: `google/protobuf/${file}.proto (built in)`,
  });
  if (want.has('any')) out.push(msg('any', 'Any', [scalar(1, 'typeUrl', 'string'), scalar(2, 'value', 'bytes')]));
  if (want.has('duration')) out.push(msg('duration', 'Duration', [scalar(1, 'seconds', 'int64'), scalar(2, 'nanos', 'int32')]));
  if (want.has('empty')) out.push(msg('empty', 'Empty', []));
  if (want.has('field_mask')) out.push(msg('field_mask', 'FieldMask', [scalar(1, 'paths', 'string', { repeated: true })]));
  if (want.has('timestamp')) out.push(msg('timestamp', 'Timestamp', [scalar(1, 'seconds', 'int64'), scalar(2, 'nanos', 'int32')]));
  if (want.has('struct')) {
    out.push(
      msg('struct', 'Struct', [{ number: 1, name: 'fields', type: { kind: 'map', key: 'string', value: { kind: 'message', type: `${P}Value` } } }]),
      msg('struct', 'Value', [
        { number: 1, name: 'nullValue', type: { kind: 'enum', type: `${P}NullValue` }, oneof: 'kind' },
        scalar(2, 'numberValue', 'double', { oneof: 'kind' }),
        scalar(3, 'stringValue', 'string', { oneof: 'kind' }),
        scalar(4, 'boolValue', 'bool', { oneof: 'kind' }),
        { number: 5, name: 'structValue', type: { kind: 'message', type: `${P}Struct` }, oneof: 'kind' },
        { number: 6, name: 'listValue', type: { kind: 'message', type: `${P}ListValue` }, oneof: 'kind' },
      ]),
      msg('struct', 'ListValue', [{ number: 1, name: 'values', type: { kind: 'message', type: `${P}Value` }, repeated: true }]),
      { name: `${P}NullValue`, dartClass: 'NullValue', values: [{ name: 'NULL_VALUE', number: 0 }], file: 'google/protobuf/struct.proto (built in)' },
    );
  }
  if (want.has('wrappers')) for (const [cls, s] of Object.entries(WRAPPERS)) out.push(msg('wrappers', cls, [scalar(1, 'value', s)]));
  return out;
}

/** Well-known types with a special JSON form (Empty and others are plain objects). */
export function hasSpecialJson(name: string): boolean {
  if (!name.startsWith(P)) return false;
  const cls = name.slice(P.length);
  return Object.hasOwn(WRAPPERS, cls) || ['Any', 'Duration', 'FieldMask', 'ListValue', 'Struct', 'Timestamp', 'Value'].includes(cls);
}

export function wrapperScalar(name: string): ProtoScalar | undefined {
  const cls = name.startsWith(P) ? name.slice(P.length) : '';
  return Object.hasOwn(WRAPPERS, cls) ? WRAPPERS[cls] : undefined;
}

// ---------------------------------------------------------------------------------------------
// Timestamp / Duration / FieldMask text forms

const MIN_TS = -62135596800n; // 0001-01-01T00:00:00Z
const MAX_TS = 253402300799n; // 9999-12-31T23:59:59Z
const MAX_DURATION = 315576000000n;

function frac(nanos: number): string {
  if (nanos === 0) return '';
  const s = String(nanos).padStart(9, '0');
  if (s.endsWith('000000')) return `.${s.slice(0, 3)}`;
  if (s.endsWith('000')) return `.${s.slice(0, 6)}`;
  return `.${s}`;
}

export function formatTimestamp(seconds: bigint, nanos: number): string | undefined {
  if (seconds < MIN_TS || seconds > MAX_TS || nanos < 0 || nanos > 999_999_999 || !Number.isInteger(nanos)) return undefined;
  const iso = new Date(Number(seconds) * 1000).toISOString(); // 4-digit years in range
  return `${iso.slice(0, 19)}${frac(nanos)}Z`;
}

export function parseTimestamp(s: string): { seconds: bigint; nanos: number } | undefined {
  const m = /^(\d{4})-(\d{2})-(\d{2})[Tt](\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(?:([Zz])|([+-])(\d{2}):(\d{2}))$/.exec(s);
  if (!m) return undefined;
  const d = new Date(0);
  d.setUTCFullYear(+m[1], +m[2] - 1, +m[3]);
  d.setUTCHours(+m[4], +m[5], +m[6], 0);
  if (d.getUTCMonth() !== +m[2] - 1 || d.getUTCDate() !== +m[3] || +m[4] > 23 || +m[5] > 59 || +m[6] > 59) return undefined;
  let seconds = BigInt(Math.floor(d.getTime() / 1000));
  if (m[9]) seconds -= BigInt((m[9] === '-' ? -1 : 1) * (+m[10] * 3600 + +m[11] * 60));
  const nanos = m[7] ? Number(m[7].padEnd(9, '0')) : 0;
  if (seconds < MIN_TS || seconds > MAX_TS) return undefined;
  return { seconds, nanos };
}

export function formatDuration(seconds: bigint, nanos: number): string | undefined {
  if (seconds > MAX_DURATION || seconds < -MAX_DURATION || Math.abs(nanos) > 999_999_999) return undefined;
  if ((seconds > 0n && nanos < 0) || (seconds < 0n && nanos > 0)) return undefined;
  const neg = seconds < 0n || nanos < 0;
  const abs = seconds < 0n ? -seconds : seconds;
  return `${neg ? '-' : ''}${abs}${frac(Math.abs(nanos))}s`;
}

export function parseDuration(s: string): { seconds: bigint; nanos: number } | undefined {
  const m = /^(-)?(\d+)(?:\.(\d{1,9}))?s$/.exec(s);
  if (!m) return undefined;
  const sign = m[1] ? -1 : 1;
  const seconds = BigInt(m[2]) * BigInt(sign);
  const nanos = (m[3] ? Number(m[3].padEnd(9, '0')) : 0) * sign;
  if (seconds > MAX_DURATION || seconds < -MAX_DURATION) return undefined;
  return { seconds, nanos: nanos === 0 ? 0 : nanos };
}

const snakeToCamel = (s: string) => s.replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase());
const camelToSnake = (s: string) => s.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);

export const fieldMaskToJson = (paths: string[]): string => paths.map((p) => p.split('.').map(snakeToCamel).join('.')).join(',');
export const fieldMaskFromJson = (s: string): string[] =>
  s.trim() === '' ? [] : s.split(',').map((p) => p.trim().split('.').map(camelToSnake).join('.'));
