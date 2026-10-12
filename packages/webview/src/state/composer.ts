/** Edit & resend (CONTRACTS §9.3 `send`, gRPC §18.4) and snippets. Split out of ../state.ts (QUALITY-1 Q6). */
import { GRPC_SEND_MAX_MESSAGES } from '@flutter-intercept/proxy/grpc-meta';
import { type GrpcDecodeEntry, decodedMessages, isGrpc } from '../grpc';
import type { Exchange, SendDraft, SnippetFormat } from '../protocol';
import { type Headers, isAbsoluteUrl, isPaused } from '../util';
import type { Composer, GrpcComposer, HeaderRow } from './core';
import { headersToRows, rowsToRecord } from './drafts';
import { grpcMessageError } from './ruleForm';

// ---------------------------------------------------------------- edit & resend (CONTRACTS §9.3 `send`)

/** A finished exchange can be resent (not pending, not waiting at a breakpoint). */
export function canResend(ex: Pick<Exchange, 'state'>): boolean {
  return ex.state !== 'pending' && !isPaused(ex);
}

/** Why the original request body can't be reproduced as text, if it can't. */
export function unsendableBody(ex: Pick<Exchange, 'requestBody'>): string | undefined {
  const b = ex.requestBody;
  if (!b) return undefined;
  if (b.encoding === 'base64') return 'The original body is binary and can\'t be resent as text — it is not included.';
  if (b.truncated) return 'The original body was truncated at 5 MB — it is not included.';
  return undefined;
}

/** Headers the proxy sets itself on a gRPC send (CONTRACTS §18.4): not copied into the editor. */
const GRPC_SEND_DROP = new Set(['content-type', 'te', 'grpc-encoding', 'grpc-accept-encoding', 'content-length', 'host', 'connection']);
const grpcSendHeaders = (h: Headers | undefined): HeaderRow[] =>
  headersToRows(h).filter((r) => !r.name.startsWith(':') && !GRPC_SEND_DROP.has(r.name.toLowerCase()));

/** The request messages of a recorded gRPC call (base64), and why they aren't complete, if they aren't. */
export function grpcRequestMessages(ex: Exchange): { messages: string[]; problem?: string } {
  const frames = (ex.frames ?? []).filter((f) => f.kind === 'message' && f.dir === 'send');
  const messages = frames.map((f) => f.base64 ?? '');
  const cut = frames.findIndex((f) => f.truncated || f.sizeUnknown || f.base64 === undefined);
  if (cut >= 0) return { messages, problem: `Request message ${cut + 1} was cut at 64 KB — it can't be resent as recorded.` };
  if ((ex.grpc?.messagesSent ?? frames.length) > frames.length) {
    return { messages, problem: `Only ${frames.length} of the ${ex.grpc!.messagesSent} request messages were kept — they can't be resent as recorded.` };
  }
  return { messages };
}

export function composerFromExchange(ex: Exchange, decode?: GrpcDecodeEntry): Composer {
  if (isGrpc(ex)) {
    const { messages, problem } = grpcRequestMessages(ex);
    // JSON editing when the schema decoded every request message in full.
    const frames = ex.frames ?? [];
    const decoded = decodedMessages(decode, frames, ex.framesDropped ?? 0).filter((_, i) => frames[i].kind === 'message' && frames[i].dir === 'send');
    const json = decoded.length === messages.length && decoded.every((m) => m?.via === 'schema' && m.json !== undefined && !m.truncated)
      ? decoded.map((m) => m!.json!) : undefined;
    return {
      resentFrom: ex.id,
      draft: { kind: 'request', method: 'POST', url: ex.url, headers: grpcSendHeaders(ex.requestHeaders), body: '' },
      open: true,
      sending: false,
      grpc: { mode: json ? 'json' : 'base64', ...(json ? { json } : {}), base64: messages, ...(problem ? { note: problem } : {}) },
    };
  }
  const bodyNote = unsendableBody(ex);
  const text = !bodyNote && ex.requestBody ? ex.requestBody.text : '';
  return {
    resentFrom: ex.id,
    draft: { kind: 'request', method: ex.method, url: ex.url, headers: headersToRows(ex.requestHeaders), body: text },
    bodyNote,
    originalBody: bodyNote ? undefined : text,
    open: true,
    sending: false,
  };
}

export function blankComposer(): Composer {
  return { draft: { kind: 'request', method: 'GET', url: 'https://', headers: [], body: '' }, open: true, sending: false };
}

/**
 * The `send` request for a composer draft. content-length is dropped whenever the body differs from the
 * original (or the original body is unknown) so a stale length never reaches the server; a Host header that
 * doesn't match the URL is dropped too.
 */
export function composeSend(c: Pick<Composer, 'draft' | 'originalBody'> & Partial<Pick<Composer, 'grpc'>>): SendDraft {
  const d = c.draft;
  if (c.grpc) {
    // CONTRACTS §18.4: always POST; the proxy sets content-type / te itself.
    const req: SendDraft = { method: 'POST', url: d.url.trim(), grpc: grpcSendMessages(c.grpc) };
    const rows = d.headers.filter((r) => r.name.trim() && !GRPC_SEND_DROP.has(r.name.trim().toLowerCase()) && !r.name.trim().startsWith(':'));
    if (rows.length) req.headers = rowsToRecord(rows);
    return req;
  }
  const req: SendDraft = { method: d.method.trim().toUpperCase(), url: d.url.trim() };
  let rows = d.headers.filter((r) => r.name.trim());
  const bodyChanged = c.originalBody === undefined || d.body !== c.originalBody;
  if (bodyChanged) rows = rows.filter((r) => r.name.trim().toLowerCase() !== 'content-length');
  // A copied Host header that no longer matches the (edited) URL would send the request to the wrong virtual host.
  let urlHost: string | undefined;
  try { urlHost = new URL(req.url).host.toLowerCase(); } catch { /* validated elsewhere */ }
  rows = rows.filter((r) => r.name.trim().toLowerCase() !== 'host' || r.value.trim().toLowerCase() === urlHost);
  if (rows.length) req.headers = rowsToRecord(rows);
  if (d.body !== '') req.body = d.body;
  return req;
}

/** CONTRACTS §18.4 caps: ≤ 100 messages, ≤ 4 MB each, ≤ 16 MB in all. */
export { GRPC_SEND_MAX_MESSAGES as MAX_GRPC_SEND_MESSAGES } from '@flutter-intercept/proxy/grpc-meta';

/** The `grpc` part of a send: JSON entries (encoded by the host) or base64 (an empty entry = an empty message). */
export function grpcSendMessages(g: GrpcComposer): NonNullable<SendDraft['grpc']> {
  if (g.mode === 'json') return { messagesJson: (g.json ?? []).map((m) => JSON.parse(m) as unknown) };
  return { messages: g.base64.map((m) => m.replace(/\s+/g, '')) };
}

/** Problems with a gRPC composer, one line each (empty = it can be sent). */
export function grpcComposerErrors(c: Pick<Composer, 'draft' | 'grpc'>): string[] {
  const g = c.grpc;
  if (!g) return [];
  const errors: string[] = [];
  if (!isAbsoluteUrl(c.draft.url.trim())) errors.push('URL must be absolute (http:// or https://)');
  else if (!/^\/[^/]+\/[^/]+$/.test(new URL(c.draft.url.trim()).pathname)) errors.push('URL path must be /package.Service/Method');
  const list = g.mode === 'json' ? g.json ?? [] : g.base64;
  if (list.length > GRPC_SEND_MAX_MESSAGES) errors.push(`At most ${GRPC_SEND_MAX_MESSAGES} messages`);
  list.forEach((m, i) => {
    if (g.mode === 'json' && !m.trim()) { errors.push(`Message ${i + 1}: enter a JSON object, e.g. {}`); return; }
    const e = grpcMessageError(m, g.mode);
    if (e) errors.push(`Message ${i + 1}: ${e}`);
  });
  for (const r of c.draft.headers) {
    if (r.name.trim() && !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(r.name.trim())) errors.push(`Invalid header name “${r.name}”`);
  }
  return errors;
}

/** Why a gRPC call can't be resent as recorded, if it can't (Edit and resend still works). */
export function grpcUnsendable(ex: Exchange): string | undefined {
  return isGrpc(ex) ? grpcRequestMessages(ex).problem : undefined;
}

/** One-click "Resend": the recorded request as is. undefined when its body can't be reproduced. */
export function resendRequest(ex: Exchange): SendDraft | undefined {
  if (isGrpc(ex)) {
    if (!canResend(ex)) return undefined;
    const { messages, problem } = grpcRequestMessages(ex);
    if (problem) return undefined;
    const rows = grpcSendHeaders(ex.requestHeaders);
    return { method: 'POST', url: ex.url, ...(rows.length ? { headers: rowsToRecord(rows) } : {}), grpc: { messages } };
  }
  if (!canResend(ex) || unsendableBody(ex)) return undefined;
  const req: SendDraft = { method: ex.method, url: ex.url };
  if (Object.keys(ex.requestHeaders).length) req.headers = ex.requestHeaders;
  if (ex.requestBody?.text) req.body = ex.requestBody.text;
  return req;
}

/** Who sent an exchange that the app didn't (list badge + detail line). */
export function initiatorLabel(ex: Pick<Exchange, 'initiator' | 'resentFrom'>): string | undefined {
  if (!ex.initiator && !ex.resentFrom) return undefined;
  const who = ex.initiator === 'agent' ? 'an AI agent' : 'the editor';
  return ex.resentFrom ? `Resent by ${who}` : `Sent by ${who}`;
}

export const SNIPPET_LABEL: Record<SnippetFormat, string> = { curl: 'cURL', dart_http: 'Dart (http)', dio: 'Dio', grpcurl: 'grpcurl' };
export const SNIPPET_FORMATS: readonly SnippetFormat[] = ['curl', 'dart_http', 'dio'];
/** CONTRACTS §19.2: gRPC calls (HTTP/2 and gRPC-Web) copy as grpcurl only. */
export const GRPC_SNIPPET_FORMATS: readonly SnippetFormat[] = ['grpcurl'];
export function snippetFormatsFor(ex: Pick<Exchange, 'kind'>): readonly SnippetFormat[] {
  return isGrpc(ex) ? GRPC_SNIPPET_FORMATS : SNIPPET_FORMATS;
}
