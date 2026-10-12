/**
 * v0.10.0 gRPC helpers (CONTRACTS §16): status codes, list row texts, the Messages tab's decode bookkeeping, the
 * `grpc:` filter values, which rule actions apply to gRPC calls, and the status line item. Pure: no DOM.
 */
import type { Exchange, Frame, GrpcDecoded, GrpcDecodedMessage, RuleAction, Status } from './protocol';
import type { SequenceStep } from '@flutter-intercept/proxy/types';
import { frameSizeText, splitUrl } from './util';

// ---------------------------------------------------------------- status codes

/** The 17 canonical gRPC status codes, by number. */
export const GRPC_CODES = [
  'OK', 'CANCELLED', 'UNKNOWN', 'INVALID_ARGUMENT', 'DEADLINE_EXCEEDED', 'NOT_FOUND', 'ALREADY_EXISTS',
  'PERMISSION_DENIED', 'RESOURCE_EXHAUSTED', 'FAILED_PRECONDITION', 'ABORTED', 'OUT_OF_RANGE', 'UNIMPLEMENTED',
  'INTERNAL', 'UNAVAILABLE', 'DATA_LOSS', 'UNAUTHENTICATED',
] as const;
export const MAX_GRPC_CODE = GRPC_CODES.length - 1;

/** "UNAVAILABLE"; codes outside 0–16 as "CODE 42". */
export function grpcCodeName(code: number): string {
  return Number.isInteger(code) && code >= 0 && code <= MAX_GRPC_CODE ? GRPC_CODES[code] : `CODE ${code}`;
}

/** "14 UNAVAILABLE". */
export function grpcCodeLabel(code: number): string {
  return `${code} ${grpcCodeName(code)}`;
}

/** Codes whose name starts with `v` (case-insensitive, `_` / `-` optional), or the number itself. */
export function grpcCodesMatching(v: string): number[] {
  const s = v.trim().toLowerCase();
  if (!s) return [];
  if (/^\d+$/.test(s)) return [Number(s)];
  const norm = s.replace(/[-_\s]/g, '');
  const out: number[] = [];
  GRPC_CODES.forEach((name, code) => { if (name.toLowerCase().replace(/_/g, '').startsWith(norm)) out.push(code); });
  return out;
}

// ---------------------------------------------------------------- exchanges

export const GRPC_DECRYPT_SETTING = 'flutterIntercept.grpc.decryptHosts';

export function isGrpc(ex: Pick<Exchange, 'kind'>): boolean {
  return ex.kind === 'grpc';
}

/** CONTRACTS §19.1: a gRPC-Web call (Flutter Web through the browser) — an HTTP/1.1 request shown as gRPC. */
export function isGrpcWeb(ex: Pick<Exchange, 'kind'> & Partial<Pick<Exchange, 'grpc'>>): boolean {
  return ex.kind === 'grpc' && !!ex.grpc?.web;
}

/** A gRPC call over HTTP/2 (not gRPC-Web): the message-level tools apply. */
export function isNativeGrpc(ex: Pick<Exchange, 'kind'> & Partial<Pick<Exchange, 'grpc'>>): boolean {
  return ex.kind === 'grpc' && !ex.grpc?.web;
}

/** The browser's CORS preflight (OPTIONS) for a gRPC-Web call: the latest one for its URL, started no later. */
export function findPreflight(all: readonly Exchange[], ex: Pick<Exchange, 'url' | 'startedAt' | 'id'>): Exchange | undefined {
  for (let i = all.length - 1; i >= 0; i--) {
    const e = all[i];
    if (e.id !== ex.id && e.method === 'OPTIONS' && e.cors?.preflight && e.url === ex.url && e.startedAt <= ex.startedAt) return e;
  }
  return undefined;
}

/** Shown on gRPC-Web calls: what works there today. */
export const GRPC_WEB_NOTE =
  'gRPC-Web (through the browser): HTTP rules, CORS and HTTP-level breakpoints apply; message-level tools for gRPC-Web ' +
  '(message breakpoints, Mutate JSON, scripts, resend) come later.';
export const GRPC_WEB_LATER = 'Message-level tools for gRPC-Web come later';

/** A gRPC connection over TLS that was passed through undecrypted (CONTRACTS §16.2). */
export function isGrpcTunnel(ex: Pick<Exchange, 'kind' | 'grpcTunnel'>): boolean {
  return ex.kind === 'tunnel' && ex.grpcTunnel === true;
}

/** The hint every undecrypted gRPC tunnel carries (row tooltip, detail note). */
export const GRPC_TUNNEL_HINT =
  `gRPC over TLS, not decrypted — add the host to ${GRPC_DECRYPT_SETTING} if the app trusts the Flutter Intercept CA in debug`;

/** Why every action except Block can't be used on an undecrypted gRPC tunnel. */
export const GRPC_TUNNEL_NO_ACTION =
  'gRPC over TLS, not decrypted: there are no calls or messages to mock, pause, copy or resend. Only Block applies.';

/** `/pkg.Service/Method` (from `grpc`, else the URL path). */
export function grpcPath(ex: Pick<Exchange, 'grpc' | 'url'>): string {
  if (ex.grpc?.service && ex.grpc.method) return `/${ex.grpc.service}/${ex.grpc.method}`;
  return splitUrl(ex.url).path.split('?')[0] || '/';
}

export type GrpcStatusClass = 'ok' | 'err' | 'pending' | 'none';

export interface GrpcStatusView { text: string; cls: GrpcStatusClass; title: string }

/** The status column of a gRPC call: the code name (OK green, others red), "…" while open, "✕" without a status. */
export function grpcStatusView(ex: Pick<Exchange, 'state' | 'grpc' | 'error' | 'status'>): GrpcStatusView {
  const code = ex.grpc?.statusCode;
  if (code !== undefined) {
    const msg = ex.grpc?.statusMessage;
    return {
      text: grpcCodeName(code),
      cls: code === 0 ? 'ok' : 'err',
      title: `gRPC status ${grpcCodeLabel(code)}${msg ? ` — ${msg}` : ''}${ex.grpc?.trailersOnly ? ' (trailers-only response)' : ''}`,
    };
  }
  switch (ex.state) {
    case 'pending': return { text: '…', cls: 'pending', title: 'Open — waiting for the status (trailers)' };
    case 'paused-request':
    case 'paused-response': return { text: '…', cls: 'pending', title: 'Paused at a breakpoint — no gRPC status yet' };
    case 'aborted': return { text: '✕', cls: 'err', title: 'Cancelled (by the app, or aborted at a breakpoint) — no gRPC status' };
    case 'error': return { text: '✕', cls: 'err', title: `No gRPC status: ${ex.error ?? 'the stream was reset'}` };
    case 'blocked': return { text: '✕', cls: 'err', title: 'Blocked by a rule (stream reset) — no gRPC status' };
    default: return { text: '—', cls: 'none', title: 'No gRPC status reported' };
  }
}

/** More than one message in either direction. */
export function isGrpcStreaming(ex: Pick<Exchange, 'grpc'>, decoded?: GrpcDecoded): boolean {
  if (decoded?.method && (decoded.method.clientStreaming || decoded.method.serverStreaming)) return true;
  const g = ex.grpc;
  return !!g && (g.messagesSent > 1 || g.messagesReceived > 1);
}

/** "↑1 ↓3" for the size column. */
export function grpcCountsShort(ex: Pick<Exchange, 'grpc'>): string {
  const g = ex.grpc;
  return g ? `↑${g.messagesSent} ↓${g.messagesReceived}` : '—';
}

/** "1 message sent · 3 received" (tooltip / detail). */
export function grpcCountsText(ex: Pick<Exchange, 'grpc'>): string {
  const g = ex.grpc;
  if (!g) return 'No messages counted';
  return `${g.messagesSent} message${g.messagesSent === 1 ? '' : 's'} sent by the app · ${g.messagesReceived} received from the server`;
}

/** List badge tooltip: "gRPC · pkg.Service/Method · streaming · 1 sent · 3 received · open". */
export function grpcTitle(ex: Pick<Exchange, 'grpc' | 'url' | 'state'>): string {
  const parts = [ex.grpc?.web ? `gRPC-Web${ex.grpc.web === 'text' ? ' (text)' : ''}` : 'gRPC', grpcPath(ex).slice(1)];
  if (isGrpcStreaming(ex)) parts.push('streaming');
  parts.push(grpcCountsText(ex));
  if (ex.state === 'pending') parts.push('open');
  return parts.join(' · ');
}

/** "deadline 5 s", "gzip" etc. facts for the detail header. */
export function grpcFacts(ex: Pick<Exchange, 'grpc'>): string[] {
  const g = ex.grpc;
  if (!g) return [];
  const out: string[] = [];
  if (g.deadlineMs !== undefined) out.push(`deadline ${g.deadlineMs < 1000 ? `${g.deadlineMs} ms` : `${Math.round(g.deadlineMs / 100) / 10} s`}`);
  if (g.requestEncoding) out.push(`request ${g.requestEncoding}`);
  if (g.responseEncoding) out.push(`response ${g.responseEncoding}`);
  if (g.trailersOnly) out.push('trailers-only');
  return out;
}

// ---------------------------------------------------------------- decoding (decodeGrpc / grpcDecoded)

/**
 * Bookkeeping for one exchange's decode: what was asked for (`key` = the exchange version), and the last answer. The
 * previous answer is kept while a newer version is being decoded (a live stream re-decodes as messages arrive).
 */
export interface GrpcDecodeEntry {
  /** Version of the exchange the last request was for (see grpcVersion). */
  key: string;
  /** framesDropped when it was requested: decoded.messages[k] is frame number base + k. */
  base: number;
  requestedAt: number;
  decoded?: GrpcDecoded;
  /** Version the answer belongs to ('' for an answer nobody asked for). */
  answeredKey?: string;
  answeredBase?: number;
}

/** Changes whenever the decode could differ: state, status, message frames. */
export function grpcVersion(ex: Pick<Exchange, 'state' | 'grpc' | 'frames' | 'framesDropped'> & Partial<Pick<Exchange, 'grpcPause' | 'pausedAt'>>): string {
  const frames = ex.frames ?? [];
  const last = frames[frames.length - 1];
  // CONTRACTS §17.6: a new (or changed) pause is a new version — the answer then carries the held message (`paused`).
  return [ex.state, ex.grpc?.statusCode ?? '', ex.framesDropped ?? 0, frames.length, last ? `${last.at}:${last.size}` : '', grpcPauseKey(ex)].join('|');
}

// ---------------------------------------------------------------- breakpoints (CONTRACTS §17.2)

/** Identity of what a paused gRPC call holds ('' when not paused): a new pause resets the editor. */
export function grpcPauseKey(ex: Partial<Pick<Exchange, 'grpcPause' | 'pausedAt'>>): string {
  const p = ex.grpcPause;
  if (!p) return '';
  return p.kind === 'message' ? `m:${p.dir}:${p.index}:${p.size}:${ex.pausedAt ?? ''}` : `s:${p.code}:${ex.pausedAt ?? ''}`;
}

/** The held message decoded in full, when the host's answer is for this pause. */
export function pausedDecoded(ex: Pick<Exchange, 'grpcPause'>, decoded: GrpcDecoded | undefined): GrpcDecodedMessage | undefined {
  const p = ex.grpcPause;
  const m = decoded?.paused;
  if (!p || p.kind !== 'message' || !m) return undefined;
  return m.index === p.index && m.dir === p.dir ? m : undefined;
}

/** "Message 3 the server sent" / "the end of the call". */
export function grpcPauseTitle(p: NonNullable<Exchange['grpcPause']>): string {
  if (p.kind === 'status') return 'Paused at the end of the call — before the app gets the status and trailers.';
  return `Paused on message ${p.index + 1} ${p.dir === 'send' ? 'the app sends — before it reaches the server' : 'the server sends — before it reaches the app'}.`;
}

/** True when the panel should (re-)post `decodeGrpc` for this exchange. */
export function needsDecode(ex: Exchange, entry: GrpcDecodeEntry | undefined): boolean {
  return isGrpc(ex) && (!entry || entry.key !== grpcVersion(ex));
}

/** How long to wait for `grpcDecoded` before saying the host didn't answer (older hosts never do). */
export const DECODE_TIMEOUT_MS = 4000;

/**
 * The decoded message of each frame in `frames` (undefined where the answer doesn't cover it). `decoded.messages` has
 * one entry per `message` frame of the window the host decoded, which started at frame number `decoded.framesDropped`
 * (older hosts: `answeredBase`, the value when it was asked for).
 */
export function decodedMessages(entry: GrpcDecodeEntry | undefined, frames: readonly Frame[], dropped: number): (GrpcDecodedMessage | undefined)[] {
  const out: (GrpcDecodedMessage | undefined)[] = new Array(frames.length);
  const d = entry?.decoded;
  if (!d) return out;
  // Frames dropped since the decode shift the window: skip the decoded messages of frames no longer listed. The host
  // says which window it decoded (`framesDropped`); older hosts don't, so fall back to the value at request time.
  const base = typeof d.framesDropped === 'number' ? d.framesDropped : entry!.answeredBase ?? entry!.base;
  let k = dropped - base;
  for (let i = 0; i < frames.length; i++) {
    if (frames[i].kind !== 'message') continue;
    const m = k >= 0 ? d.messages[k] : undefined;
    k++;
    if (m && m.dir === frames[i].dir) out[i] = m;
  }
  return out;
}

const PREVIEW_CHARS = 160;

/** One-line preview of a decoded message: compact JSON, or the size when there is nothing to show. */
export function grpcPreview(f: Pick<Frame, 'size' | 'compressed' | 'sizeUnknown' | 'base64'>, m: GrpcDecodedMessage | undefined): string {
  if (m?.json) {
    const s = m.json.replace(/\s+/g, ' ').trim();
    return s.length > PREVIEW_CHARS ? `${s.slice(0, PREVIEW_CHARS - 1)}…` : s;
  }
  const size = f.sizeUnknown ? `${frameSizeText(f)} (size not measured)` : `${f.size} byte${f.size === 1 ? '' : 's'}`;
  if (m?.error) return `${size} · ${m.error}`;
  return `${size} (protobuf)`;
}

/**
 * The host's hex (any spacing) as a dump: "00000000  0a 05 48 65 …  ..He". At most `max` bytes.
 */
export function hexTextDump(hex: string, max = 4096): { text: string; shown: number } {
  const clean = hex.replace(/[^0-9a-fA-F]/g, '');
  const bytes: number[] = [];
  for (let i = 0; i + 1 < clean.length && bytes.length < max; i += 2) bytes.push(parseInt(clean.slice(i, i + 2), 16));
  const lines: string[] = [];
  for (let off = 0; off < bytes.length; off += 16) {
    const chunk = bytes.slice(off, off + 16);
    const h = chunk.map((b) => b.toString(16).padStart(2, '0')).join(' ');
    const a = chunk.map((b) => (b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : '.')).join('');
    lines.push(`${off.toString(16).padStart(8, '0')}  ${h.padEnd(47)}  ${a}`);
  }
  return { text: lines.join('\n'), shown: bytes.length };
}

/** What the Messages tab says about decoding (absent = nothing to say). */
export function decodeNote(entry: GrpcDecodeEntry | undefined, now: number): { kind: 'loading' | 'none' | 'problem'; text: string } | undefined {
  if (!entry) return undefined;
  if (entry.decoded?.problem) return { kind: 'problem', text: entry.decoded.problem };
  if (entry.decoded) return undefined;
  if (now - entry.requestedAt < DECODE_TIMEOUT_MS) return { kind: 'loading', text: 'Decoding messages…' };
  return {
    kind: 'none',
    text: 'No decoded view from the extension (it may be older than Flutter Intercept 0.10) — showing the raw bytes.',
  };
}

/** "pkg.GetUserRequest → pkg.User · server streaming" for the Messages header. */
export function methodTypesText(m: NonNullable<GrpcDecoded['method']>): string {
  const kind = m.clientStreaming && m.serverStreaming ? 'bidirectional streaming'
    : m.clientStreaming ? 'client streaming' : m.serverStreaming ? 'server streaming' : 'unary';
  return `${m.requestType} → ${m.responseType} · ${kind}`;
}

// ---------------------------------------------------------------- rules (CONTRACTS §16.2)

/** Actions the proxy applies to gRPC calls; a rule with any other action never matches one. */
/** CONTRACTS §18: every action except `mock` (HTTP bodies — gRPC has grpcMock) and `cors` (browser-only). */
const GRPC_KINDS = new Set<string>([
  'grpcMock', 'block', 'fault', 'throttle', 'passthrough', 'breakpoint', 'mutate', 'rewrite', 'script', 'mapRemote',
]);

export function appliesToGrpc(a: RuleAction | SequenceStep['action']): boolean {
  if (a.kind === 'sequence') return a.steps.every((s) => appliesToGrpc(s.action));
  return GRPC_KINDS.has(a.kind);
}

/** Note for a rule whose action doesn't apply to gRPC calls (only when its URL looks like a gRPC method). */
export function grpcActionNote(kind: string, stepKinds?: readonly string[]): string | undefined {
  if (kind === 'sequence') {
    const bad = (stepKinds ?? []).find((k) => !GRPC_KINDS.has(k));
    if (!bad) return undefined;
    return `gRPC calls skip this rule: its ${bad === 'cors' ? 'CORS' : '“Mock response”'} step doesn't apply to them${bad === 'mock' ? ' — use a gRPC mock step' : ''}.`;
  }
  if (GRPC_KINDS.has(kind)) return undefined;
  if (kind === 'cors') return 'gRPC calls skip this rule: CORS is for browser requests (Flutter Web) only.';
  return 'gRPC calls skip this rule: “Mock response” answers HTTP requests — use a gRPC mock for gRPC calls.';
}

/** CONTRACTS §18.1: metadata a rewrite may not set or remove on gRPC calls (status changes: breakpoint / mutate / script). */
const RESERVED_GRPC_METADATA = new Set([
  'content-type', 'te', 'grpc-encoding', 'grpc-accept-encoding', 'grpc-status', 'grpc-message', 'grpc-timeout',
  'grpc-status-details-bin', // REVIEW-12 / CONTRACTS §18.6: rich error details belong to the status
]);
export function reservedGrpcMetadata(name: string): boolean {
  const n = name.trim().toLowerCase();
  return n.startsWith(':') || RESERVED_GRPC_METADATA.has(n);
}

/** Why a metadata name / value can't be used in a gRPC rewrite, if it can't (`-bin` values are base64). */
export function grpcMetadataError(name: string, value: string | undefined, what: string): string | undefined {
  const n = name.trim();
  if (!n) return undefined;
  if (reservedGrpcMetadata(n)) {
    return `${what} “${n}” can't be changed on gRPC calls (pseudo headers, content-type, te, grpc-encoding, grpc-accept-encoding, ` +
      'grpc-status, grpc-message, grpc-status-details-bin and grpc-timeout are reserved — change the status with a breakpoint, ' +
      'Mutate JSON or a script)';
  }
  if (value !== undefined && /-bin$/i.test(n) && !isBase64(value.trim())) return `${what} “${n}”: a -bin value must be base64`;
  return undefined;
}

/** CONTRACTS §18.1: what of a rewrite doesn't apply to gRPC calls (body replacements, the status). */
export function grpcRewriteNote(a: { request?: { replaceBody?: unknown[] }; response?: { replaceBody?: unknown[]; status?: number } } | undefined): string | undefined {
  const body = !!(a?.request?.replaceBody?.length || a?.response?.replaceBody?.length);
  const status = a?.response?.status !== undefined;
  if (!body && !status) return undefined;
  const what = body && status ? 'Body replacements and the status change' : body ? 'Body replacements' : 'The status change';
  return `On gRPC calls only the metadata parts apply: ${what} ${status && !body ? 'is' : 'are'} skipped ` +
    '(protobuf bodies — use Mutate JSON or a script; for the status, a breakpoint or a script).';
}

/** `/pkg.Service/Method` (or `/pkg.Service/*`) somewhere in a URL pattern. */
export function looksLikeGrpcUrl(url: string): boolean {
  const path = url.trim().replace(/^[a-z*]+:\/\/[^/]*/i, ''); // the host has dots too
  return /\/[A-Za-z_]\w*(\.[A-Za-z_]\w*)+\/([A-Za-z_]\w*|\*)/.test(path);
}

/** Reserved names a grpcMock's headers / trailers may not set (the proxy's setRules refuses them). */
export function reservedGrpcHeader(name: string): boolean {
  const n = name.trim().toLowerCase();
  return n.startsWith(':') || n === 'content-type' || n === 'grpc-status' || n === 'grpc-message';
}

const B64 = /^[A-Za-z0-9+/]*={0,2}$/;
/** Standard base64 (whitespace ignored), length a multiple of 4. */
export function isBase64(s: string): boolean {
  const t = s.replace(/\s+/g, '');
  return t.length % 4 === 0 && B64.test(t);
}

/** "gRPC UNAVAILABLE after 200 ms · 3 messages". */
export function describeGrpcMock(a: Extract<RuleAction, { kind: 'grpcMock' }>): string {
  const n = a.messagesJson?.length ?? a.messages?.length ?? 0;
  const parts = [`gRPC mock ${grpcCodeName(a.code ?? 0)}`];
  if (n) parts.push(`${n} message${n === 1 ? '' : 's'}`);
  if (a.delayMs) parts.push(`after ${a.delayMs} ms`);
  return parts.join(' · ');
}

// ---------------------------------------------------------------- status (Status.grpc)

/** Status line item for `Status.grpc` (undefined = nothing worth showing). */
export function grpcStatusSummary(g: Status['grpc']): { text: string; title: string; problems: number } | undefined {
  if (!g) return undefined;
  if (!g.enabled) {
    return { text: 'gRPC off', problems: 0, title: 'gRPC interception is off (flutterIntercept.grpc.enabled): gRPC calls go straight to the server.' };
  }
  const schemaProblems = g.schema?.problems.length ?? 0;
  const problems = schemaProblems + (g.problem ? 1 : 0);
  const parts: string[] = [];
  if (g.schema) parts.push(`${g.schema.methods} method${g.schema.methods === 1 ? '' : 's'}`);
  if (g.decryptHosts.length) parts.push(`${g.decryptHosts.length} decrypt host${g.decryptHosts.length === 1 ? '' : 's'}`);
  if (problems) parts.push(`${problems} problem${problems === 1 ? '' : 's'}`);
  if (!parts.length) return undefined;
  const lines: string[] = [];
  if (g.problem) lines.push(`✕ ${g.problem}`);
  lines.push(g.schema
    ? `Schema from the app's generated *.pb*.dart: ${g.schema.methods} methods, ${g.schema.messages} message types.`
    : 'No protobuf schema found (generated *.pbgrpc.dart): messages are shown as raw fields.');
  for (const p of g.schema?.problems ?? []) lines.push(`✕ ${p}`);
  lines.push(g.decryptHosts.length
    ? `TLS gRPC decrypted for (${GRPC_DECRYPT_SETTING}):\n${g.decryptHosts.map((h) => `• ${h}`).join('\n')}`
    : `TLS gRPC is shown as undecrypted tunnels; list hosts in ${GRPC_DECRYPT_SETTING} for apps that trust the Flutter Intercept CA in debug.`);
  return { text: `gRPC: ${parts.join(' · ')}`, title: lines.join('\n'), problems };
}
