// CONTRACTS §19.4 / QUALITY-1 Q2: the one node-free source of shared rules for the proxy, the host and the webview
// (`@flutter-intercept/proxy/grpc-meta`). No imports at all: the webview bundles this file.

// ---------------------------------------------------------------- gRPC status codes

/** gRPC status code names, index = code (0–16). */
export const GRPC_CODE_NAMES = [
  'OK',
  'CANCELLED',
  'UNKNOWN',
  'INVALID_ARGUMENT',
  'DEADLINE_EXCEEDED',
  'NOT_FOUND',
  'ALREADY_EXISTS',
  'PERMISSION_DENIED',
  'RESOURCE_EXHAUSTED',
  'FAILED_PRECONDITION',
  'ABORTED',
  'OUT_OF_RANGE',
  'UNIMPLEMENTED',
  'INTERNAL',
  'UNAVAILABLE',
  'DATA_LOSS',
  'UNAUTHENTICATED',
] as const;

export type GrpcCodeName = (typeof GRPC_CODE_NAMES)[number];
export const MAX_GRPC_CODE = GRPC_CODE_NAMES.length - 1;

/** "UNAVAILABLE"; codes outside 0–16 as "CODE 42". */
export function grpcCodeName(code: number): string {
  return Number.isInteger(code) && code >= 0 && code <= MAX_GRPC_CODE ? GRPC_CODE_NAMES[code] : `CODE ${code}`;
}

// ---------------------------------------------------------------- header / metadata names

/** Connection-specific headers (HTTP/1.1 hop-by-hop, and what HTTP/2 refuses). */
export const HOP_BY_HOP_HEADERS: ReadonlySet<string> = new Set([
  'connection',
  'keep-alive',
  'proxy-connection',
  'proxy-authorization',
  'transfer-encoding',
  'upgrade',
  'host',
  'http2-settings',
  'trailer',
]);

/** Headers that describe a body's framing, not its content. */
export const FRAMING_HEADERS: ReadonlySet<string> = new Set(['content-length', 'content-encoding', 'transfer-encoding', 'connection', 'keep-alive']);

/**
 * CONTRACTS §18.1: gRPC metadata a rewrite may not set or remove anywhere (status changes use a breakpoint, mutate or a
 * script; framing, deadline and encoding belong to the call). Pseudo headers (`:…`) are refused too.
 */
export const GRPC_REWRITE_RESERVED: ReadonlySet<string> = new Set([
  'grpc-status',
  'grpc-message',
  'grpc-status-details-bin',
  'grpc-timeout',
  'grpc-encoding',
  'grpc-accept-encoding',
]);

/** On a gRPC call, these request / response headers are reserved too (header rewrites skip them). */
export const GRPC_CALL_RESERVED: ReadonlySet<string> = new Set(['content-type', 'te']);

/** Never in `setTrailers` / `removeTrailers`: the rewrite set, the call set, and connection / framing headers. */
export const GRPC_TRAILER_RESERVED: ReadonlySet<string> = new Set([...GRPC_REWRITE_RESERVED, ...GRPC_CALL_RESERVED, ...HOP_BY_HOP_HEADERS, 'content-length']);

/** A grpcMock's `headers` / `trailers` may not set these (the proxy sets them; use code / message for the status). */
export const GRPC_MOCK_RESERVED: ReadonlySet<string> = new Set(['content-type', 'grpc-status', 'grpc-message', 'te', 'content-length', ...HOP_BY_HOP_HEADERS]);

export type GrpcMetadataSide = 'rewrite' | 'call' | 'trailers' | 'mock';

const RESERVED_BY_SIDE: Record<GrpcMetadataSide, ReadonlySet<string>> = {
  rewrite: GRPC_REWRITE_RESERVED,
  call: new Set([...GRPC_REWRITE_RESERVED, ...GRPC_CALL_RESERVED]),
  trailers: GRPC_TRAILER_RESERVED,
  mock: GRPC_MOCK_RESERVED,
};

const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9a-z-]+$/;

/**
 * Why a metadata name can't be used on `side` (one wording for every layer), or undefined. `rewrite`: any rewrite;
 * `call`: a header rewrite of a gRPC call; `trailers`: set / remove trailers; `mock`: a grpcMock's headers / trailers.
 */
export function reservedGrpcMetadataProblem(name: string, side: GrpcMetadataSide): string | undefined {
  const n = String(name ?? '').trim().toLowerCase();
  const shown = `"${String(name ?? '').slice(0, 60)}"`;
  if (n.startsWith(':')) return `${shown}: pseudo headers can't be set or removed.`;
  if (!n || !HEADER_NAME.test(n)) return `${shown} is not a valid metadata name.`;
  if (!RESERVED_BY_SIDE[side].has(n)) return undefined;
  if (side === 'mock') return `${shown} is set by the proxy (use code / message for the status).`;
  return GRPC_REWRITE_RESERVED.has(n) && n !== 'grpc-timeout' && n !== 'grpc-encoding' && n !== 'grpc-accept-encoding'
    ? `${shown} can't be changed (use a breakpoint, mutate or a script for the gRPC status).`
    : `${shown} can't be changed (it belongs to the call).`;
}

/** Standard or URL-safe base64, optionally padded (binary `-bin` metadata, protobuf messages). */
export function isBase64(v: string): boolean {
  if (typeof v !== 'string' || !/^[A-Za-z0-9+/_-]*={0,2}$/.test(v)) return false;
  return v.replace(/=+$/, '').length % 4 !== 1;
}

/** Why a metadata value can't be used: one line of text, and base64 for a `-bin` name. */
export function metadataValueProblem(name: string, value: unknown): string | undefined {
  const n = String(name ?? '').slice(0, 40);
  if (typeof value !== 'string' || /[\r\n\0]/.test(value)) return `the value of "${n}" must be text on one line.`;
  if (/-bin$/i.test(String(name ?? '').trim()) && !isBase64(value.trim())) return `"${n}" is binary metadata; its value must be base64.`;
  return undefined;
}

// ---------------------------------------------------------------- caps and limits

/** Stored payload per frame (WebSocket / SSE / gRPC message), bytes; `size` is always the full size. */
export const FRAME_PAYLOAD_CAP = 64 * 1024;
/** gRPC messages larger than this (decompressed) are never held or rewritten by a hook. */
export const GRPC_HOOK_CAP_BYTES = 4 * 1024 * 1024;
/** Bytes of gRPC messages collected / queued / held by hooks across all calls. */
export const GRPC_HELD_TOTAL_CAP_BYTES = 64 * 1024 * 1024;
/** A breakpoint edit / script replacement / sent message, at most this many bytes. */
export const GRPC_EDIT_MAX_BYTES = GRPC_HOOK_CAP_BYTES;
/** A status message set by a breakpoint edit or a script, UTF-8 bytes. */
export const GRPC_STATUS_MESSAGE_MAX_BYTES = 1024;
/** Mutate / script `json`: messages up to this size are decoded; per call at most the budget below. */
export const GRPC_MUTATE_MAX_BYTES = 1024 * 1024;
export const GRPC_MUTATE_CALL_BYTES = 50 * 1024 * 1024;
export const GRPC_MUTATE_CALL_MS = 2000;
/** send() for gRPC (CONTRACTS §18.4). */
export const GRPC_SEND_MAX_MESSAGES = 100;
export const GRPC_SEND_MAX_MESSAGE_BYTES = GRPC_HOOK_CAP_BYTES;
export const GRPC_SEND_MAX_BYTES = 16 * 1024 * 1024;
export const GRPC_SEND_DEADLINE_MS = 60_000;
export const GRPC_SEND_MAX_DEADLINE_MS = 3_600_000;
/** Rules. */
export const MAX_SEQUENCE_STEPS = 50;
export const MAX_MUTATE_OPS = 20;
export const MAX_REWRITE_HEADERS = 50;
export const MAX_BODY_REPLACEMENTS = 20;
export const MAX_REWRITE_REPLACEMENTS = MAX_BODY_REPLACEMENTS;
/** Replayed WebSocket / SSE / gRPC gaps are capped at this. */
export const MAX_REPLAY_GAP_MS = 5000;
/** Scripts (CONTRACTS §13.4, §18.2). */
export const MAX_SCRIPT_BYTES = 256 * 1024;
export const SCRIPT_CALL_TIMEOUT_MS = 200;
export const SCRIPT_BODY_MAX_BYTES = 1024 * 1024;
export const SCRIPT_LOG_MAX_LINES = 20;
export const SCRIPT_LOG_MAX_CHARS = 500;
export const GRPC_SCRIPT_MAX_MESSAGES = 1000;
/** Exchange.notes (CONTRACTS §19.4). */
export const MAX_NOTES = 20;
export const MAX_NOTE_CHARS = 300;

// ---------------------------------------------------------------- hosts and Map Remote targets

/**
 * This machine by name or address: `localhost`, `*.localhost`, 127.0.0.0/8, `::1`, the unspecified addresses
 * (`0.0.0.0`, `::`) and the IPv4-mapped forms of those. (The emulator aliases 10.0.2.2 / 10.0.3.2 are not included:
 * see `isThisMachine`.)
 */
export function isLoopbackHostname(hostIn: string): boolean {
  const h = String(hostIn ?? '').trim().toLowerCase().replace(/^\[|\]$/g, '').replace(/\.+$/, '');
  if (h === 'localhost' || h.endsWith('.localhost')) return true;
  const v4 = parseIPv4(h);
  if (v4) return v4[0] === 127 || v4.every((o) => o === 0);
  const g = parseIPv6(h);
  if (!g) return false;
  if (g.slice(0, 7).every((x) => x === 0) && (g[7] === 0 || g[7] === 1)) return true; // :: and ::1
  // IPv4-mapped (::ffff:a.b.c.d, as the URL parser writes it: ::ffff:7f00:1) and IPv4-compatible (::a.b.c.d) forms.
  const mapped = g.slice(0, 5).every((x) => x === 0) && (g[5] === 0xffff || g[5] === 0);
  if (!mapped) return false;
  const hi = g[6];
  return hi >> 8 === 127 || (hi === 0 && g[7] === 0);
}

/** `a.b.c.d` (decimal, 0–255 each) → its octets. */
function parseIPv4(s: string): number[] | undefined {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(s);
  if (!m) return undefined;
  const o = m.slice(1).map(Number);
  return o.every((x) => x <= 255) ? o : undefined;
}

/** An IPv6 address (compressed or full, optional trailing dotted IPv4, no zone) → its 8 groups. */
function parseIPv6(sIn: string): number[] | undefined {
  let s = sIn.replace(/%.*$/, '');
  if (!s.includes(':')) return undefined;
  const tail = /(\d{1,3}(?:\.\d{1,3}){3})$/.exec(s);
  if (tail) {
    const o = parseIPv4(tail[1]);
    if (!o) return undefined;
    s = `${s.slice(0, -tail[1].length)}${((o[0] << 8) | o[1]).toString(16)}:${((o[2] << 8) | o[3]).toString(16)}`;
  }
  const parts = s.split('::');
  if (parts.length > 2) return undefined;
  const side = (x: string) => (x ? x.split(':') : []);
  const left = side(parts[0]);
  const right = parts.length === 2 ? side(parts[1]) : [];
  const fill = 8 - left.length - right.length;
  if (parts.length === 2 ? fill < 1 : fill !== 0) return undefined;
  const all = [...left, ...Array(parts.length === 2 ? fill : 0).fill('0'), ...right];
  if (all.length !== 8 || !all.every((x) => /^[0-9a-f]{1,4}$/.test(x))) return undefined;
  return all.map((x) => parseInt(x, 16));
}

/** Emulator aliases for the machine running the proxy (Android emulator, Genymotion). */
export const EMULATOR_HOST_ALIASES: ReadonlySet<string> = new Set(['10.0.2.2', '10.0.3.2']);

/** Loopback, unspecified, or an emulator alias. */
export function isThisMachine(host: string): boolean {
  const h = String(host ?? '').trim().toLowerCase().replace(/^\[|\]$/g, '');
  return isLoopbackHostname(h) || EMULATOR_HOST_ALIASES.has(h);
}

/**
 * Why a Map Remote target can't be used, or undefined (one rule set for every layer, the strictest of the earlier
 * ones): an absolute `http(s)://` URL (`ws(s)://` too with `allowWs`, inside the proxy), at most 2048 characters, a host,
 * no user info, no `?query`, no `#fragment`, no whitespace / NUL, no backslash.
 */
export function mapTargetProblem(to: unknown, o: { allowWs?: boolean } = {}): string | undefined {
  if (typeof to !== 'string' || !to.trim()) return 'Map Remote needs a target: an origin such as https://staging.example.com, or a URL prefix.';
  const v = to.trim();
  if (v.length > 2048) return 'The Map Remote target is longer than 2048 characters.';
  if (/[\s\0]/.test(v)) return 'The Map Remote target must not contain whitespace.';
  if (v.includes('\\')) return 'The Map Remote target must not contain backslashes.';
  let u: URL;
  try {
    u = new URL(v);
  } catch {
    return `The Map Remote target is not a URL: ${JSON.stringify(v.slice(0, 200))}`;
  }
  const schemes = o.allowWs ? ['http:', 'https:', 'ws:', 'wss:'] : ['http:', 'https:'];
  if (!schemes.includes(u.protocol)) return `The Map Remote target must be http(s)://${o.allowWs ? ' (or ws(s)://)' : ''}, got ${u.protocol}`;
  if (!u.hostname) return 'The Map Remote target has no host.';
  if (u.username || u.password || /^[a-z][a-z0-9+.-]*:\/\/[^/?#]*@/i.test(v)) return 'The Map Remote target must not contain credentials (user:password@).';
  if (v.includes('#')) return 'The Map Remote target must not contain a #fragment.';
  if (v.includes('?')) return 'The Map Remote target is an origin or a URL prefix: no ?query.';
  return undefined;
}

/**
 * CONTRACTS §18.6: does a URL point at the proxy itself — this machine (loopback, unspecified, an emulator alias) on
 * one of the proxy's ports? Such a Map Remote rule would relay calls to the proxy without end. Pure (no DNS).
 */
export function targetsProxy(url: string, proxyPorts: readonly number[]): boolean {
  let u: URL;
  try {
    u = new URL(String(url ?? '').trim());
  } catch {
    return false;
  }
  const port = Number(u.port) || (u.protocol === 'https:' || u.protocol === 'wss:' ? 443 : 80);
  return proxyPorts.includes(port) && isThisMachine(u.hostname);
}

// ---------------------------------------------------------------- the script template

/**
 * Starter content of a script rule (CONTRACTS §13.4, §18.2), the same in the editor, a script file and a rule made
 * from an exchange: every hook documented, changing nothing until edited; gRPC hooks commented out (their mere
 * presence would put matching gRPC calls on the slower hook path). `ruleName` names the rule in the first line.
 */
export function scriptTemplate(ruleName?: string): string {
  const name = typeof ruleName === 'string' ? ruleName.replace(/[\r\n\0]/g, ' ').trim().slice(0, 80).replace(/\*\//g, '* /') : '';
  return `// Flutter Intercept script${name ? ` for the rule "${name}"` : ''}.
// Runs in the proxy for every request the rule matches. Every hook is optional and must return synchronously;
// return undefined to leave things as they are. Plain JavaScript only: no require, fetch, timers or Node APIs.
// context.log(...) lines show up in the request's details. A hook that throws answers the app with 502.

/**
 * Before the request goes to the server.
 * request: { method, url, headers, body? } — body is text; absent (bodyOmitted: true) when binary or over 1 MB.
 * Return the edited request, { response: { status, headers, body } } to answer locally, or undefined.
 */
function onRequest(request, context) {
  // request.headers['x-debug'] = 'flutter-intercept';
  // context.log('request', request.method, request.url);
  // return request;
  return undefined;
}

/**
 * With the server's response.
 * response: { status, headers, body? }
 * Return the edited response, or undefined.
 */
function onResponse(response, request, context) {
  // const json = JSON.parse(response.body);
  // json.editedBy = 'flutter-intercept';
  // return { ...response, body: JSON.stringify(json) };
  return undefined;
}

// gRPC calls use these two hooks instead (onRequest / onResponse are not called for them). Uncomment to use.
//
// /**
//  * For every message of a matching gRPC call, both directions.
//  * message: { path, dir ('send' = app → server, 'receive'), index, json?, base64, size } — json is decoded with the
//  * app's protobuf schema (absent without one, or over 1 MB).
//  * Return undefined (unchanged), { json } (encoded with the schema), { base64 } or { drop: true }.
//  */
// function onGrpcMessage(message, context) {
//   if (message.dir === 'receive' && message.json) {
//     context.log('message', message.index, 'of', message.path);
//     return { json: { ...message.json, editedBy: 'flutter-intercept' } };
//   }
//   return undefined;
// }
//
// /**
//  * Before the call's status and trailers go to the app.
//  * status: { path, code (0 = OK, 14 = UNAVAILABLE, …), message?, trailers }
//  * Return undefined, or { code?, message?, trailers? }.
//  */
// function onGrpcStatus(status, context) {
//   if (status.code === 0) return undefined;
//   context.log('call', status.path, 'ended with', status.code, status.message);
//   return { code: 0, message: '' }; // pretend it worked
// }
`;
}

/** The template without a rule name (rules made from an exchange, the editor's placeholder). */
export const SCRIPT_TEMPLATE = scriptTemplate();
