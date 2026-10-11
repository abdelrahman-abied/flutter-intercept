/**
 * gRPC calls in recordings (CONTRACTS §17.4). Pure, no vscode (the CLI uses it too); the protobuf schema comes in as an
 * optional `RecordingGrpc` (the host's schema service).
 *
 * - In memory a gRPC entry is an Exchange (`kind: 'grpc'`, `grpc` = GrpcInfo, `responseTrailers` = custom trailers only,
 *   `frames` = message frames) plus `grpcRequestHash` / `incomplete` (types.ts `RecordedExchange`). In the file it is
 *   `{…, kind: 'grpc', frames, grpc: {code, message?, trailers?, requestHash?}, incomplete?}` (`toFileEntry` /
 *   `grpcFromFile` convert).
 * - `recordGrpc`: what a recording keeps of a live call — message frames as recorded (dropped ones were never delivered
 *   and are left out), the status and custom trailers, sha256 of the first request message, `incomplete` when a
 *   response message was cut / of unknown size or frames were dropped. Redacted: URL, metadata and the status message
 *   like agent views; each message decoded with the schema, redacted (`redactJsonValue`) and re-encoded — or, without a
 *   schema / when that fails, replaced by zero bytes of the recorded length. Raw protobuf never survives redaction.
 * - `grpcReplayEntry`: a `ReplayEntry` of kind `grpc` (the proxy answers it like a grpcMock).
 * - `firstResponseJson`: the first response message decoded with the schema (diff's shape comparison).
 */
import { createHash } from 'crypto';
import type { Exchange, Frame, GrpcInfo, ReplayEntry } from '@flutter-intercept/proxy';
import { redactGrpcMetadata, redactText, redactUrl } from '../agent/redact';
import { redactJsonValue } from '../agent/samples';
import { decodeGrpcMessages, grpcMethodPath, grpcProxyCodec, type GrpcDeps } from '../grpc/service';
import { capFrames, copyFrame } from './frames';
import type { RecordedExchange } from './types';

/** The schema access recordings need (src/grpc/service.ts `GrpcDeps`). */
export type RecordingGrpc = Pick<GrpcDeps, 'codec' | 'schema' | 'enabled'>;

/** gRPC status codes a file may hold (servers may send any; the canonical ones are 0–16). */
export const MAX_RECORDED_GRPC_CODE = 999;
export const MAX_GRPC_STATUS_MESSAGE = 4096;
/** Replay gaps between recorded messages are capped (CONTRACTS §17.4). */
export const MAX_REPLAY_GAP_MS = 5000;

/** Trailer / header names that are the protocol's, not the server's custom metadata. */
const PROTOCOL_METADATA = new Set(['grpc-status', 'grpc-message', 'content-type', 'content-length', 'transfer-encoding', 'connection', 'keep-alive', 'te', 'trailer', 'upgrade', 'host', 'date']);

/** The file form of an entry's gRPC part. */
export interface FileGrpc {
  code: number;
  message?: string;
  trailers?: Record<string, string | string[]>;
  requestHash?: string;
}

/** Custom metadata only (no pseudo headers or protocol fields), as own properties. */
export function customMetadata(h: Record<string, string | string[]> | undefined): Record<string, string | string[]> | undefined {
  const out: Record<string, string | string[]> = {};
  for (const [k, v] of Object.entries(h ?? {})) {
    const n = k.toLowerCase();
    if (n.startsWith(':') || PROTOCOL_METADATA.has(n)) continue;
    Object.defineProperty(out, k, { value: Array.isArray(v) ? [...v] : v, enumerable: true, writable: true, configurable: true });
  }
  return Object.keys(out).length ? out : undefined;
}

/**
 * sha256 (hex) of the first request message's recorded frame bytes (its decoded `base64`: decompressed, ≤ 64 KB) — the
 * same as the proxy's `grpcMessageHash` over the same bytes (unit-tested), without loading the proxy here.
 */
export function firstRequestHash(frames: readonly Frame[] | undefined): string | undefined {
  const f = (frames ?? []).find((x) => x.kind === 'message' && x.dir === 'send' && !x.dropped);
  if (!f || typeof f.base64 !== 'string') return undefined;
  return createHash('sha256').update(Buffer.from(f.base64, 'base64')).digest('hex');
}

/** Message counts of recorded frames (a file's counts are derived, never trusted). */
function counts(frames: readonly Frame[]): { messagesSent: number; messagesReceived: number } {
  let messagesSent = 0;
  let messagesReceived = 0;
  for (const f of frames) if (f.kind === 'message') f.dir === 'send' ? messagesSent++ : messagesReceived++;
  return { messagesSent, messagesReceived };
}

/** `GrpcInfo` for an entry from its URL, status and frames. */
export function grpcInfoFor(url: string, code: number, message: string | undefined, frames: readonly Frame[], prev?: GrpcInfo): GrpcInfo {
  const path = grpcMethodPath(url) ?? '';
  const m = /^\/([^/]+)\/([^/]+)$/.exec(path);
  return {
    service: prev?.service ?? m?.[1] ?? '',
    method: prev?.method ?? m?.[2] ?? '',
    statusCode: code,
    ...(message !== undefined ? { statusMessage: message } : {}),
    ...counts(frames),
  };
}

/**
 * One message frame redacted for a recording: schema decode → `redactJsonValue` → re-encode; otherwise zero bytes of the
 * recorded length (`size` kept). Never returns the original bytes.
 */
export function redactMessageFrame(f: Frame, url: string, grpc: RecordingGrpc | undefined): Frame {
  const out = copyFrame(f);
  if (typeof f.base64 !== 'string') return out;
  const zero = (): Frame => {
    out.base64 = Buffer.alloc(Buffer.from(f.base64!, 'base64').length).toString('base64');
    return out;
  };
  const path = grpcMethodPath(url);
  if (!grpc || !path || f.truncated || f.sizeUnknown) return zero();
  try {
    const d = decodeGrpcMessages({ url, frames: [] }, grpc, { frames: [{ ...f, kind: 'message' }] }).messages[0];
    if (!d || d.via !== 'schema' || d.json === undefined) return zero();
    const bytes = grpcProxyCodec(grpc).encode(path, f.dir, redactJsonValue(d.json));
    out.base64 = Buffer.from(bytes).toString('base64');
    out.size = bytes.length;
    delete out.compressed;
    return out;
  } catch {
    return zero();
  }
}

/**
 * The recording's copy of a gRPC call (live, or an already recorded entry when exporting redacted). `redact` follows
 * the module header; `grpc` = the schema for redaction (optional).
 */
export function recordGrpc(e: RecordedExchange, base: RecordedExchange, redact: boolean, grpc?: RecordingGrpc): RecordedExchange {
  const out: RecordedExchange = { ...base, kind: 'grpc' };
  delete out.requestBody;
  delete out.responseBody;
  const delivered = (e.frames ?? []).filter((f) => f.kind === 'message' && !f.dropped);
  const capped = capFrames(delivered.map(copyFrame), e.framesDropped ?? 0);
  const incomplete =
    e.incomplete === true ||
    capped.dropped > 0 ||
    capped.frames.some((f) => f.dir === 'receive' && (f.truncated || f.sizeUnknown || typeof f.base64 !== 'string'));
  const hash = e.grpcRequestHash ?? firstRequestHash(e.frames);
  const code = e.grpc?.statusCode ?? 0;
  const message = e.grpc?.statusMessage;
  const trailers = customMetadata(e.responseTrailers);
  out.frames = redact ? capped.frames.map((f) => redactMessageFrame(f, e.url, grpc)) : capped.frames;
  if (capped.dropped) out.framesDropped = capped.dropped;
  else delete out.framesDropped;
  out.grpc = grpcInfoFor(e.url, code, message === undefined ? undefined : redact ? redactText(message) : message, out.frames, e.grpc);
  if (trailers) out.responseTrailers = redact ? redactGrpcMetadata(trailers) : trailers;
  else delete out.responseTrailers;
  if (redact) {
    out.url = redactUrl(e.url);
    out.requestHeaders = redactGrpcMetadata(e.requestHeaders) ?? {};
    out.responseHeaders = redactGrpcMetadata(e.responseHeaders) ?? {};
  }
  if (hash) out.grpcRequestHash = hash;
  if (incomplete) out.incomplete = true;
  return out;
}

/** The file form of an in-memory entry (gRPC parts converted; other kinds unchanged). */
export function toFileEntry(e: RecordedExchange): Record<string, unknown> {
  if (e.kind !== 'grpc') return e as unknown as Record<string, unknown>;
  const { grpc, responseTrailers, grpcRequestHash, incomplete, ...rest } = e;
  const file: FileGrpc = {
    code: grpc?.statusCode ?? 0,
    ...(grpc?.statusMessage !== undefined ? { message: grpc.statusMessage } : {}),
    ...(responseTrailers && Object.keys(responseTrailers).length ? { trailers: responseTrailers } : {}),
    ...(grpcRequestHash ? { requestHash: grpcRequestHash } : {}),
  };
  return { ...rest, grpc: file, ...(incomplete ? { incomplete: true } : {}) };
}

/** A gRPC entry can be replayed: it has a status and complete response messages. */
export function isReplayableGrpc(e: RecordedExchange): boolean {
  return e.kind === 'grpc' && !e.incomplete && e.grpc?.statusCode !== undefined && !!grpcMethodPath(e.url);
}

/**
 * CONTRACTS §17.4: the replay entry of a gRPC call — response headers minus pseudo headers, content-type and framing,
 * the message frames in recorded order (`at` gaps over 5 s shortened to 5 s), the status, custom trailers and the
 * request hash.
 */
export function grpcReplayEntry(e: RecordedExchange): ReplayEntry {
  const headers: Record<string, string | string[]> = {};
  for (const [k, v] of Object.entries(customMetadata(e.responseHeaders) ?? {})) {
    if (k.toLowerCase().startsWith('grpc-')) continue;
    Object.defineProperty(headers, k, { value: Array.isArray(v) ? [...v] : v, enumerable: true, writable: true, configurable: true });
  }
  const frames: Frame[] = [];
  let shift = 0;
  let prev: number | undefined;
  for (const f of e.frames ?? []) {
    if (f.kind !== 'message' || f.dropped) continue;
    if (prev !== undefined && f.at - prev > MAX_REPLAY_GAP_MS) shift += f.at - prev - MAX_REPLAY_GAP_MS;
    prev = f.at;
    frames.push({ ...copyFrame(f), at: f.at - shift });
  }
  const trailers = customMetadata(e.responseTrailers);
  return {
    kind: 'grpc',
    method: 'POST',
    url: e.url,
    status: e.status ?? 200,
    headers,
    frames,
    grpc: {
      code: e.grpc?.statusCode ?? 0,
      ...(e.grpc?.statusMessage !== undefined ? { message: e.grpc.statusMessage } : {}),
      ...(trailers ? { trailers } : {}),
      ...(e.grpcRequestHash ? { requestHash: e.grpcRequestHash } : {}),
    },
  };
}

/** The first response message decoded with the schema (undefined: none, no schema, not decodable). */
export function firstResponseJson(e: Exchange, grpc: RecordingGrpc | undefined): unknown | undefined {
  if (!grpc) return undefined;
  const f = (e.frames ?? []).find((x) => x.kind === 'message' && x.dir === 'receive' && !x.dropped);
  if (!f || f.truncated || f.sizeUnknown) return undefined;
  try {
    if (!grpc.enabled()) return undefined;
    const d = decodeGrpcMessages({ url: e.url, frames: [] }, grpc, { frames: [f] }).messages[0];
    return d?.via === 'schema' ? d.json : undefined;
  } catch {
    return undefined;
  }
}
