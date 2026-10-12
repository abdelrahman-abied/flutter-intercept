/**
 * gRPC on the host side of the panel and agents (CONTRACTS §16.4, §17.2, §18.4; QUALITY-1 Q3: moved out of
 * controller.ts): resume edits with `messageJson`, a grpcMock from a recorded call, resend messages. Pure: no vscode.
 */
import * as path from 'path';
import type { Exchange, GrpcEdit, Rule, RuleAction } from '@flutter-intercept/proxy';
import { decodeGrpcMessages, decodeHeldMessage, grpcMethodPath, grpcProxyCodec, hexOf, type GrpcDeps } from '../grpc/service';
import type { GrpcDecoded } from './protocol';
import { tunnelReason, uiExchange } from './views';
import { grpcEditProblem } from '@flutter-intercept/proxy/rules';
import { GRPC_MOCK_RESERVED, GRPC_SEND_MAX_BYTES } from '@flutter-intercept/proxy/grpc-meta';
import { MAX_GRPC_MESSAGE_TEXT, TOKEN, validateGrpcEdit } from './validate';

/** CONTRACTS §16.4: JSON text of one decoded message shown in the panel (longer is cut, `truncated`). */
export const UI_MAX_GRPC_JSON_CHARS = 256 * 1024;
/** CONTRACTS §17.6: a held message is shown in full, within reason (a 4 MB message as pretty JSON). */
export const UI_MAX_PAUSED_JSON_CHARS = 16 * 1024 * 1024;
/**
 * CONTRACTS §17.6: validates a gRPC resume edit for `ex` and encodes `messageJson` with the call's request / response
 * type (the held message's direction) into `message`. Errors (no schema, a field that doesn't fit) are thrown; the call
 * then stays paused.
 */
export function resolveGrpcEdit(ex: Exchange, raw: unknown, grpc: Pick<GrpcDeps, 'codec' | 'schema' | 'enabled'> | undefined): GrpcEdit | undefined {
  const edit = validateGrpcEdit(raw, ex.grpcPause);
  if (!edit || edit.messageJson === undefined) return edit;
  const pause = ex.grpcPause;
  const path = grpcMethodPath(ex.url);
  if (!path || pause?.kind !== 'message') throw new Error("This call's method is unknown, so messageJson can't be encoded; pass message (base64).");
  if (!grpc) throw new Error('gRPC decoding is not available: pass message (base64) instead of messageJson.');
  let bytes: Uint8Array;
  try {
    bytes = grpcProxyCodec(grpc).encode(path, pause.dir, edit.messageJson);
  } catch (e) {
    throw new Error(`messageJson can't be encoded as the ${pause.dir === 'send' ? 'request' : 'response'} of ${path}: ${(e as Error)?.message ?? String(e)}`);
  }
  const out: GrpcEdit = { message: Buffer.from(bytes).toString('base64') };
  const problem = grpcEditProblem('message', out);
  if (problem) throw new Error(problem);
  return out;
}

/** The response messages of a finished gRPC exchange as a grpcMock (JSON when the schema decodes every one). */
export function grpcMockRuleFromExchange(e: Exchange, id: string, grpc: Pick<GrpcDeps, 'codec' | 'schema'> | undefined): Rule {
  if (e.kind !== 'grpc') throw new Error('a gRPC mock needs a gRPC call; use a mock rule for HTTP requests');
  const path = grpcMethodPath(e.url);
  let origin = '';
  try {
    origin = new URL(e.url).origin;
  } catch {
    // reported below
  }
  if (!path || !origin || origin === 'null') throw new Error("its URL isn't a gRPC method (…/package.Service/Method)");
  if (e.state === 'pending' || e.state === 'paused-request' || e.state === 'paused-response') throw new Error('the call has not finished yet; mock it once it has its status');
  if (e.framesDropped) throw new Error('some of its messages were not kept (too many), so the mock would be incomplete');
  const received = (e.frames ?? []).filter((f) => f.kind === 'message' && f.dir === 'receive');
  if (received.some((f) => f.truncated || typeof f.base64 !== 'string')) throw new Error('some of its response messages were too large to record in full');
  const decoded = decodeGrpcMessages(e, grpc, { filter: (f) => f.dir === 'receive' });
  const allJson = decoded.messages.length > 0 && decoded.messages.every((m) => m.via === 'schema');
  const info = e.grpc;
  const code = info?.statusCode ?? 0;
  const custom = (h: Record<string, string | string[]> | undefined): Record<string, string> | undefined => {
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(h ?? {})) {
      const n = k.toLowerCase();
      if (n.startsWith(':') || GRPC_MOCK_RESERVED.has(n) || n === 'date' || n === 'server' || n.startsWith('grpc-') || n === 'content-encoding') continue;
      if (!TOKEN.test(k)) continue;
      const value = Array.isArray(v) ? v.join(', ') : v;
      if (typeof value !== 'string' || /[\r\n\0]/.test(value)) continue;
      out[n] = value;
    }
    return Object.keys(out).length ? out : undefined;
  };
  const headers = custom(e.responseHeaders);
  const trailers = custom(e.responseTrailers);
  const action: RuleAction = {
    kind: 'grpcMock',
    ...(code !== 0 ? { code } : {}),
    ...(info?.statusMessage ? { message: info.statusMessage.slice(0, MAX_GRPC_MESSAGE_TEXT) } : {}),
    ...(received.length ? (allJson ? { messagesJson: decoded.messages.map((m) => m.json) } : { messages: received.map((f) => f.base64 as string) }) : {}),
    ...(headers ? { headers } : {}),
    ...(trailers ? { trailers } : {}),
  };
  const name = `gRPC mock ${path} → ${info?.statusCode !== undefined ? `${code}` : 'OK'}${received.length ? ` (${received.length} message${received.length === 1 ? '' : 's'})` : ''}`;
  return { id, enabled: true, name: name.slice(0, 500), match: { method: 'POST', url: `${origin}${path}` }, action };
}

/** CONTRACTS §19: gRPC-Web calls are not resent yet (owner decision 2026-10-12). */
export const GRPC_WEB_RESEND = "Resending gRPC-Web calls comes later: the proxy resends over HTTP/2, which a gRPC-Web-only server may not accept.";

/**
 * CONTRACTS §18.4: the request messages of a recorded gRPC call, to resend unchanged (base64, what the server got:
 * messages dropped at a breakpoint are left out). Throws a readable Error when one was cut (64 KB frame cap / size
 * unknown) or frames were dropped from the record.
 */
export function grpcResendMessages(e: Exchange): string[] {
  if (e.kind !== 'grpc') throw new Error('not a gRPC call');
  if (e.framesDropped) throw new Error('some of its messages were not kept (too many), so its request is incomplete; edit & resend it with messagesJson or messages');
  const sent = (e.frames ?? []).filter((f) => f.kind === 'message' && f.dir === 'send' && !f.dropped);
  if (sent.some((f) => f.truncated || f.sizeUnknown || typeof f.base64 !== 'string')) throw new Error('a request message was too large to record in full (64 KB), so it can only be resent edited (messagesJson or messages)');
  return sent.map((f) => f.base64 as string);
}

/**
 * CONTRACTS §18.4: `send.grpc` ready for the proxy — `messagesJson` encoded with the method's request type (errors name
 * the message and JSON path). The proxy refuses `messagesJson`.
 */
export function resolveSendGrpc(url: string, grpcIn: { messages?: string[]; messagesJson?: unknown[] }, grpc: Pick<GrpcDeps, 'codec' | 'schema' | 'enabled'> | undefined): { messages: string[] } {
  if (grpcIn.messages) return { messages: grpcIn.messages };
  const path = grpcMethodPath(url);
  if (!path) throw new Error('the URL of a gRPC call ends in /<package.Service>/<Method>');
  if (!grpc) throw new Error('gRPC decoding is not available: pass messages (base64) instead of messagesJson.');
  const codec = grpcProxyCodec(grpc);
  let total = 0;
  return {
    messages: (grpcIn.messagesJson ?? []).map((json, i) => {
      let bytes: Uint8Array;
      try {
        bytes = codec.encode(path, 'send', json);
      } catch (e) {
        throw new Error(`messagesJson[${i}] can't be encoded as the request of ${path}: ${(e as Error)?.message ?? String(e)}`);
      }
      total += bytes.length;
      // REVIEW-12 #4: a total cap on the encoded messages (as the proxy's send cap)
      if (total > GRPC_SEND_MAX_BYTES) throw new Error('the encoded messages must total at most 16 MB');
      return Buffer.from(bytes).toString('base64');
    }),
  };
}

/** CONTRACTS §16.4: the panel's `decodeGrpc`: the messages it holds (uiExchange's frames), decoded. */
export function decodeGrpcForPanel(ex: Exchange, g: GrpcDeps | undefined, projectRoot: string | undefined): GrpcDecoded {
  if (ex.kind !== 'grpc') throw new Error(ex.kind === 'tunnel' && ex.grpcTunnel ? (tunnelReason(ex) ?? 'This gRPC connection is not decrypted.') : 'This exchange is not a gRPC call.');
  const shown = uiExchange(ex);
  const frames = shown.frames ?? [];
  const call = decodeGrpcMessages(ex, g, { frames });
  const m = call.method;
  const skeleton = (type: string): string | undefined => {
    try {
      const schema = g?.schema();
      if (!schema || !g) return undefined;
      const v = g.codec.skeleton(schema, type);
      return v === undefined ? undefined : JSON.stringify(v, null, 2);
    } catch {
      return undefined;
    }
  };
  const pretty = (v: unknown): { json?: string; truncated?: true } => {
    let t: string | undefined;
    try {
      t = JSON.stringify(v, null, 2);
    } catch {
      t = undefined;
    }
    if (t === undefined) return {};
    return t.length > UI_MAX_GRPC_JSON_CHARS ? { json: t.slice(0, UI_MAX_GRPC_JSON_CHARS), truncated: true } : { json: t };
  };
  let problem: string | undefined;
  if (!g) problem = 'gRPC decoding is not available in this build.';
  else if (!g.enabled()) problem = 'gRPC support is off (setting flutterIntercept.grpc.enabled): messages are shown as hex only.';
  else if (!g.schema()) problem = "No protobuf schema was found (the app's generated *.pb.dart / *.pbgrpc.dart files): messages are decoded without field names.";
  else if (!m) problem = `The app's generated code has no method ${call.path ?? ex.url}: messages are decoded without field names.`;
  const sk = m ? { request: skeleton(m.requestType), response: skeleton(m.responseType) } : undefined;
  return {
    ...(m ? { method: { requestType: m.requestType, responseType: m.responseType, clientStreaming: m.clientStreaming, serverStreaming: m.serverStreaming, ...(m.file ? { file: fileLabel(m.file, projectRoot) } : {}) } } : {}),
    messages: call.messages.map((d) => {
      const p = d.json !== undefined && d.via !== 'none' ? pretty(d.json) : {};
      return {
        dir: d.dir,
        via: p.json !== undefined ? d.via : 'none',
        hex: d.bytes ? hexOf(d.bytes) : '',
        size: d.size,
        ...(p.json !== undefined ? { json: p.json } : {}),
        ...(d.truncated || p.truncated ? { truncated: true as const } : {}),
        ...(d.error ? { error: d.error } : {}),
      };
    }),
    framesDropped: shown.framesDropped ?? 0,
    ...pausedView(ex, g),
    ...(sk && (sk.request || sk.response) ? { skeletons: { ...(sk.request ? { request: sk.request } : {}), ...(sk.response ? { response: sk.response } : {}) } } : {}),
    ...(problem ? { problem } : {}),
  };
}

/** CONTRACTS §17.6: the message a gRPC breakpoint holds, decoded in full (≤ 4 MB). */
function pausedView(ex: Exchange, g: GrpcDeps | undefined): Pick<GrpcDecoded, 'paused'> {
  const p = ex.grpcPause;
  if (p?.kind !== 'message' || typeof p.base64 !== 'string') return {};
  const d = decodeHeldMessage(ex, g); // cached, ≤ 1 MB decoded (REVIEW-11 #6)
  if (!d) return {};
  let json: string | undefined;
  try {
    json = d.json !== undefined && d.via !== 'none' ? JSON.stringify(d.json, null, 2) : undefined;
  } catch {
    json = undefined;
  }
  const cut = json !== undefined && json.length > UI_MAX_PAUSED_JSON_CHARS;
  return {
    paused: {
      index: p.index,
      dir: d.dir,
      via: json !== undefined ? d.via : 'none',
      hex: d.bytes ? hexOf(d.bytes) : '',
      size: p.size,
      ...(json !== undefined ? { json: cut ? json.slice(0, UI_MAX_PAUSED_JSON_CHARS) : json } : {}),
      ...(cut ? { truncated: true as const } : {}),
      ...(d.error ? { error: d.error } : {}),
    },
  };
}

/** A schema source file for the panel: project-relative when inside the project, else its name. */
function fileLabel(file: string, root: string | undefined): string {
  if (root) {
    const rel = path.relative(root, file);
    if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) return rel.split(path.sep).join('/');
  }
  return path.basename(file);
}
