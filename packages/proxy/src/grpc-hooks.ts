// A flow module of InterceptProxy (QUALITY-1 Q1); it sees the proxy through ProxyContext.

import { type HeaderBag } from './body';
import { grpcEditProblem, GRPC_REWRITE_RESERVED, GRPC_TRAILER_RESERVED } from './rules';
import { applyOps } from './jsonpath';
import { MUTATE_MAX_TARGETS } from './mutate';
import {
  decodeGrpcMessage,
  encodeGrpcMessage,
  GrpcMessageParser,
  GrpcFrameRecorder,
  decompressPrefix,
  GRPC_COMPRESSED_KEEP_BYTES,
  GRPC_HELD_TOTAL_CAP_BYTES,
  GRPC_HOOK_CAP_BYTES,
  grpcHookTesting,
  GrpcMessageTransform,
  type HookedMessage,
  type HookOutcome,
  parseGrpcStatus,
  recordedHeaders,
} from './grpc';
import {
  GRPC_MUTATE_CALL_BYTES,
  GRPC_MUTATE_CALL_MS,
  GRPC_MUTATE_MAX_BYTES,
  GRPC_SCRIPT_MAX_MESSAGES,
} from './grpc-meta';
import { SCRIPT_BODY_MAX_BYTES } from './script';
import type { Frame, GrpcEdit, GrpcProxyCodec, GrpcScriptMessage, GrpcScriptStatus, MutateOp } from './types';
import type { ScriptAction, Decision, GrpcCall } from './flow-types';
import { HTTP_TOKEN, grpcPathOf } from './proxy-util';
import { validHeaderValue } from './rewrite-flow';
import type { ProxyContext } from './proxy-context';

/** Per-message gRPC hooks: breakpoints, mutate, rewrite metadata, scripts. */
export class GrpcHooks {
  /** CONTRACTS §17.3: protobuf codec the host injects for mutate rules (setGrpcCodec). */
  grpcCodec?: GrpcProxyCodec;
  /** CONTRACTS §17.7: bytes of gRPC messages held at breakpoints right now, across calls. */
  grpcHeld = 0;

  constructor(private readonly px: ProxyContext) {}

  /** The hooked link of one direction: whole messages through grpcHook; oversized ones recorded and passed on. */
  grpcTransform(call: GrpcCall, dir: Frame['dir'], recording: { parser: GrpcMessageParser; rec: GrpcFrameRecorder }): GrpcMessageTransform {
    const cap = () => grpcHookTesting.hookCap ?? GRPC_HOOK_CAP_BYTES;
    const t = new GrpcMessageTransform({
      cap,
      reserve: (n) => this.grpcReserve(n),
      release: (n) => this.grpcRelease(n),
      onMessage: (m) => this.grpcHook(call, dir, m, recording.rec),
      onOversize: (bytes, start) => {
        if (start?.reason === 'cap') this.px.grpc.grpcNote(call, `A message over ${Math.round(cap() / 1024 / 1024)} MB was forwarded unchanged (not paused / not mutated).`);
        else if (start) this.px.grpc.grpcNote(call, 'A message was forwarded unchanged (not paused / not mutated): too much gRPC data is held right now.');
        recording.parser.push(bytes);
      },
    });
    (call.transforms ??= []).push(t);
    return t;
  }

  /** REVIEW-11 #4: one budget for gRPC message bytes being collected, queued or held by hooks, across calls. */
  grpcReserve(n: number): boolean {
    if (this.grpcHeld + n > (grpcHookTesting.heldTotalCap ?? GRPC_HELD_TOTAL_CAP_BYTES)) return false;
    this.grpcHeld += n;
    return true;
  }

  grpcRelease(n: number): void {
    this.grpcHeld = Math.max(0, this.grpcHeld - n);
  }

  /** One whole message of a hooked direction: mutate (response) or pause it; record what was delivered. */
  async grpcHook(call: GrpcCall, dir: Frame['dir'], m: HookedMessage, rec: GrpcFrameRecorder): Promise<HookOutcome> {
    const { info, flow } = call;
    const cap = grpcHookTesting.hookCap ?? GRPC_HOOK_CAP_BYTES;
    const count = () => {
      if (dir === 'send') info.messagesSent++;
      else info.messagesReceived++;
    };
    const record = (payload: Buffer, compressed: boolean, extra?: Pick<Frame, 'dropped' | 'edited'>) => {
      if (!call.isLive()) return;
      count();
      const kept = compressed ? payload.subarray(0, GRPC_COMPRESSED_KEEP_BYTES) : payload;
      rec.push({ compressed, size: payload.length, kept, complete: kept.length === payload.length }, extra);
    };
    const forward = (): HookOutcome => {
      record(m.payload, m.compressed);
      return { kind: 'forward' };
    };
    if (!call.isLive()) return { kind: 'forward' };
    let plain = m.payload;
    if (m.compressed) {
      const enc = dir === 'send' ? info.requestEncoding : info.responseEncoding;
      if (enc !== 'gzip' && enc !== 'deflate') {
        this.px.grpc.grpcNote(call, `A message compressed with ${enc ?? 'an unknown encoding'} can't be read; it was forwarded unchanged (not paused / not mutated).`);
        return forward();
      }
      const r = await decompressPrefix(m.payload, enc, cap);
      if (!r || !r.complete) {
        this.px.grpc.grpcNote(call, `A compressed message over ${Math.round(cap / 1024 / 1024)} MB (or unreadable) was forwarded unchanged (not paused / not mutated).`);
        return forward();
      }
      plain = r.data;
    }
    const a = flow.action;
    if (a?.kind === 'script') return this.grpcScriptMessage(call, a, dir, m, plain, forward, record);
    if (a?.kind === 'mutate') return dir === 'receive' ? this.grpcMutate(call, a.ops, plain, forward, record) : forward();
    // The decompressed copy counts too (the wire bytes were reserved by the transform).
    const extra = m.compressed ? plain.length : 0;
    if (extra && !this.grpcReserve(extra)) {
      this.px.grpc.grpcNote(call, 'A message was forwarded unchanged (not paused / not mutated): too much gRPC data is held right now.');
      return forward();
    }
    try {
      return await this.grpcPauseMessage(call, dir, m, plain, forward, record);
    } finally {
      if (extra) this.grpcRelease(extra);
    }
  }

  /** CONTRACTS §17.3: decode with the injected codec, applyOps, encode; any failure forwards the original with a note. */
  grpcMutate(
    call: GrpcCall,
    ops: MutateOp[],
    plain: Buffer,
    forward: () => HookOutcome,
    record: (p: Buffer, c: boolean, extra?: Pick<Frame, 'dropped' | 'edited'>) => void,
  ): HookOutcome {
    let path = '/';
    try {
      path = new URL(call.ex.url).pathname;
    } catch {
      /* keep / */
    }
    const codec = this.grpcCodec;
    // REVIEW-11 #6: the codec runs on the event loop — small messages only, and a budget per call.
    if (plain.length > GRPC_MUTATE_MAX_BYTES) {
      this.px.grpc.grpcNote(call, `mutate: messages over ${GRPC_MUTATE_MAX_BYTES / 1024 / 1024} MB are forwarded unchanged.`);
      return forward();
    }
    if (call.mutateStopped) return forward();
    if ((call.mutateBytes ?? 0) + plain.length > GRPC_MUTATE_CALL_BYTES || (call.mutateMs ?? 0) > GRPC_MUTATE_CALL_MS) {
      call.mutateStopped = true;
      this.px.grpc.grpcNote(call, `mutate: stopped for this call after ${GRPC_MUTATE_CALL_BYTES / 1024 / 1024} MB or ${GRPC_MUTATE_CALL_MS / 1000} s of decoding; later messages were forwarded unchanged.`);
      return forward();
    }
    call.mutateBytes = (call.mutateBytes ?? 0) + plain.length;
    const t0 = performance.now();
    const spent = () => (call.mutateMs = (call.mutateMs ?? 0) + (performance.now() - t0));
    let json: unknown;
    try {
      json = codec?.decode(path, 'receive', plain);
    } catch {
      json = undefined;
    }
    if (json === undefined) spent();
    if (json === undefined) {
      this.px.grpc.grpcNote(call, `mutate: no schema for ${path}; messages were forwarded unchanged.`);
      return forward();
    }
    let out: Uint8Array;
    try {
      const changed = applyOps(json, ops, { maxTargets: MUTATE_MAX_TARGETS }).value;
      out = codec!.encode(path, 'receive', changed);
    } catch (e) {
      spent();
      this.px.grpc.grpcNote(call, `mutate: ${(e as Error)?.message ?? String(e)}; the original message was forwarded.`);
      return forward();
    }
    spent();
    const payload = Buffer.from(out.buffer, out.byteOffset, out.byteLength);
    record(payload, false, { edited: true });
    call.ex.simulated = `Mutated: ${ops.map((o) => o.path).join(', ')}`.slice(0, 200);
    return { kind: 'replace', payload };
  }

  /**
   * CONTRACTS §18.1: set / remove gRPC metadata. Reserved names (pseudo, the status, framing, deadline, encoding —
   * plus content-type / te for trailers and headers alike on a gRPC call), invalid names and values, and `-bin` values
   * that aren't base64 are skipped with a note (ruleProblem refuses them up front).
   */
  grpcRewriteMeta(
    call: GrpcCall,
    h: Record<string, string | string[]>,
    set: Record<string, string> | undefined,
    remove: string[] | undefined,
    what: 'request' | 'response' | 'trailers',
  ): Record<string, string | string[]> {
    const out = { ...h };
    const skipped: string[] = [];
    const ok = (l: string) => HTTP_TOKEN.test(l) && !l.startsWith(':') && !GRPC_TRAILER_RESERVED.has(l) && !GRPC_REWRITE_RESERVED.has(l);
    for (const n of Array.isArray(remove) ? remove : []) {
      const l = String(n).trim().toLowerCase();
      if (!ok(l)) skipped.push(l);
      else delete out[l];
    }
    for (const [k, v] of Object.entries(set && typeof set === 'object' ? set : {})) {
      const l = k.trim().toLowerCase();
      if (!ok(l) || !validHeaderValue(v) || (l.endsWith('-bin') && !/^[A-Za-z0-9+/_-]*={0,2}$/.test(v))) skipped.push(l);
      else out[l] = v;
    }
    if (skipped.length) this.px.grpc.grpcNote(call, `Rewrite rule: ${what} metadata ${skipped.map((x) => `"${x.slice(0, 40)}"`).join(', ')} can't be changed on a gRPC call; skipped.`);
    return out;
  }

  /**
   * CONTRACTS §18.2: `onGrpcMessage(message, context)` for one message (≤ 1 MB; at most GRPC_SCRIPT_MAX_MESSAGES per
   * call). `{json}` is encoded with the host codec, `{base64}` replaces, `{drop: true}` drops; anything invalid, a
   * throw or a timeout logs to scriptLog and sends the original.
   */
  async grpcScriptMessage(
    call: GrpcCall,
    action: ScriptAction,
    dir: Frame['dir'],
    m: HookedMessage,
    plain: Buffer,
    forward: () => HookOutcome,
    record: (p: Buffer, c: boolean, extra?: Pick<Frame, 'dropped' | 'edited'>) => void,
  ): Promise<HookOutcome> {
    const { ex, flow } = call;
    if (plain.length > SCRIPT_BODY_MAX_BYTES) {
      this.px.grpc.grpcNote(call, `script: messages over ${SCRIPT_BODY_MAX_BYTES / 1024 / 1024} MB are not passed to onGrpcMessage; forwarded unchanged.`);
      return forward();
    }
    call.scriptCalls = (call.scriptCalls ?? 0) + 1;
    if (call.scriptCalls > GRPC_SCRIPT_MAX_MESSAGES) {
      this.px.grpc.grpcNote(call, `script: onGrpcMessage ran for the first ${GRPC_SCRIPT_MAX_MESSAGES} messages of this call; later ones were forwarded unchanged.`);
      return forward();
    }
    const path = grpcPathOf(ex.url);
    const json = this.grpcDecodeBounded(call, path, dir, plain);
    const input: GrpcScriptMessage = { path, dir, index: m.index, ...(json !== undefined ? { json } : {}), base64: plain.toString('base64'), size: plain.length };
    const out = await this.px.edits.runScript(ex, flow, action, 'onGrpcMessage', [input]);
    if (!call.isLive()) return { kind: 'drop' };
    if (out.error !== undefined) {
      this.px.edits.scriptError(ex, flow, `onGrpcMessage: ${out.error}; the original message was sent`);
      return forward();
    }
    const v = out.value as { json?: unknown; base64?: unknown; drop?: unknown } | undefined;
    if (v === undefined || v === null) return forward();
    const keys = typeof v === 'object' && !Array.isArray(v) ? Object.keys(v) : [];
    const bad = (why: string) => {
      this.px.edits.scriptError(ex, flow, `onGrpcMessage: ${why}; the original message was sent`);
      return forward();
    };
    if (keys.length !== 1) return bad('return undefined, {json}, {base64} or {drop: true}');
    if (keys[0] === 'drop') {
      if (v.drop !== true) return bad('drop must be true');
      record(m.payload, m.compressed, { dropped: true });
      return { kind: 'drop' };
    }
    let payload: Buffer;
    if (keys[0] === 'base64') {
      if (typeof v.base64 !== 'string' || !/^[A-Za-z0-9+/_-]*={0,2}$/.test(v.base64)) return bad('base64 is not base64');
      payload = Buffer.from(v.base64, 'base64');
    } else if (keys[0] === 'json') {
      const codec = this.grpcCodec;
      if (!codec) return bad(`no schema to encode json for ${path}`);
      try {
        const bytes = codec.encode(path, dir, v.json);
        payload = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      } catch (e) {
        return bad((e as Error)?.message ?? String(e));
      }
    } else return bad(`unknown field "${keys[0].slice(0, 40)}"`);
    if (payload.length > (grpcHookTesting.hookCap ?? GRPC_HOOK_CAP_BYTES)) return bad('the new message is over 4 MB');
    record(payload, false, { edited: true });
    return { kind: 'replace', payload };
  }

  /** Decode for a hook with the host codec (≤ 1 MB, the per-call codec budget of REVIEW-11 #6); undefined = unknown. */
  grpcDecodeBounded(call: GrpcCall, path: string, dir: Frame['dir'], plain: Buffer): unknown {
    const codec = this.grpcCodec;
    if (!codec || plain.length > GRPC_MUTATE_MAX_BYTES || call.mutateStopped) return undefined;
    if ((call.mutateBytes ?? 0) + plain.length > GRPC_MUTATE_CALL_BYTES || (call.mutateMs ?? 0) > GRPC_MUTATE_CALL_MS) {
      call.mutateStopped = true;
      this.px.grpc.grpcNote(call, 'script: messages are no longer decoded for this call (codec budget used up); json is absent.');
      return undefined;
    }
    call.mutateBytes = (call.mutateBytes ?? 0) + plain.length;
    const t0 = performance.now();
    try {
      return codec.decode(path, dir, plain);
    } catch {
      return undefined;
    } finally {
      call.mutateMs = (call.mutateMs ?? 0) + (performance.now() - t0);
    }
  }

  /**
   * CONTRACTS §18.2: `onGrpcStatus(status, context)` before the trailers go to the app. Returns the headers to set /
   * remove (like a breakpoint status edit), or undefined when the call ended meanwhile.
   */
  async grpcStatusScript(call: GrpcCall, t: HeaderBag): Promise<{ headers: Record<string, string>; removed: string[] } | undefined> {
    const { ex, flow, info } = call;
    const action = flow.action as ScriptAction;
    const custom = recordedHeaders(t);
    for (const k of ['grpc-status', 'grpc-message', 'content-type']) delete custom[k];
    const code = parseGrpcStatus(t['grpc-status']) ?? 0;
    const message = decodeGrpcMessage(t['grpc-message']);
    const input: GrpcScriptStatus = { path: grpcPathOf(ex.url), code, ...(message !== undefined ? { message } : {}), trailers: custom };
    const out = await this.px.edits.runScript(ex, flow, action, 'onGrpcStatus', [input]);
    if (!call.isLive()) return undefined;
    const none = { headers: {}, removed: [] };
    if (out.error !== undefined) {
      this.px.edits.scriptError(ex, flow, `onGrpcStatus: ${out.error}; the original status was sent`);
      return none;
    }
    const v = out.value as { code?: unknown; message?: unknown; trailers?: unknown } | undefined;
    if (v === undefined || v === null) return none;
    if (typeof v !== 'object' || Array.isArray(v) || Object.keys(v).some((k) => k !== 'code' && k !== 'message' && k !== 'trailers')) {
      this.px.edits.scriptError(ex, flow, 'onGrpcStatus: return undefined or {code?, message?, trailers?}; the original status was sent');
      return none;
    }
    const newCode = v.code === undefined ? code : v.code;
    const edit = {
      ...(v.code !== undefined || v.message !== undefined ? { status: { code: newCode as number, ...(v.message !== undefined ? { message: v.message as string } : {}) } } : {}),
      ...(v.trailers !== undefined ? { trailers: v.trailers as Record<string, string> } : {}),
    };
    const why = grpcEditProblem('status', edit);
    if (why) {
      this.px.edits.scriptError(ex, flow, `onGrpcStatus: ${why}; the original status was sent`);
      return none;
    }
    const headers: Record<string, string> = {};
    const removed: string[] = [];
    if (edit.status) {
      headers['grpc-status'] = String(edit.status.code);
      info.statusCode = edit.status.code;
      const msg = 'message' in edit.status ? edit.status.message : message;
      if (msg) {
        headers['grpc-message'] = encodeGrpcMessage(msg);
        info.statusMessage = msg;
      } else {
        removed.push('grpc-message');
        delete info.statusMessage;
      }
    }
    if (edit.trailers) {
      for (const k of Object.keys(custom)) removed.push(k);
      for (const [k, val] of Object.entries(edit.trailers)) {
        const lk = k.toLowerCase();
        headers[lk] = val;
        const i = removed.indexOf(lk);
        if (i >= 0) removed.splice(i, 1);
      }
    }
    return { headers, removed };
  }

  /** Run `fn` as this call's next pause (one pause at a time per call; each has its own deadline). */
  grpcSerialPause<T>(call: GrpcCall, fn: () => Promise<T>): Promise<T> {
    const p = (call.pauseChain ?? Promise.resolve()).then(fn);
    call.pauseChain = p.catch(() => undefined);
    return p;
  }

  /** CONTRACTS §17.2: hold one message until resume (edit / drop), abort, the app leaving or the timeout. */
  grpcPauseMessage(
    call: GrpcCall,
    dir: Frame['dir'],
    m: HookedMessage,
    plain: Buffer,
    forward: () => HookOutcome,
    record: (p: Buffer, c: boolean, extra?: Pick<Frame, 'dropped' | 'edited'>) => void,
  ): Promise<HookOutcome> {
    return this.grpcSerialPause(call, async (): Promise<HookOutcome> => {
      const { ex } = call;
      if (!call.isLive()) return { kind: 'drop' };
      // The pause's base64 copy (shown to the host) counts on top of the reserved wire bytes.
      const copy = Math.ceil(plain.length / 3) * 4;
      if (!this.grpcReserve(copy)) {
        this.px.grpc.grpcNote(call, 'Breakpoint skipped for a message: 64 MB of gRPC messages are already held.');
        return forward();
      }
      let d: Decision;
      try {
        ex.grpcPause = { kind: 'message', dir, index: m.index, base64: plain.toString('base64'), size: plain.length };
        const decision = this.px.pause(ex, dir === 'send' ? 'request' : 'response');
        this.px.book.emitChange(ex);
        d = await decision;
      } finally {
        this.grpcRelease(copy);
        delete ex.grpcPause;
      }
      if (d.kind === 'gone' || !call.isLive()) return { kind: 'drop' };
      if (d.kind === 'abort') {
        this.px.grpc.grpcAbort(call);
        return { kind: 'drop' };
      }
      ex.state = 'pending';
      const e = d.edit as GrpcEdit | undefined;
      let out: HookOutcome;
      if (e?.drop) {
        record(m.payload, m.compressed, { dropped: true });
        out = { kind: 'drop' };
      } else if (e?.message !== undefined) {
        const payload = Buffer.from(e.message, 'base64');
        record(payload, false, { edited: true });
        out = { kind: 'replace', payload };
      } else out = forward();
      this.px.book.emitChange(ex);
      return out;
    });
  }

  /**
   * CONTRACTS §17.2: hold the end of the call (its trailers, or a trailers-only answer). Resolves with the headers
   * to set / remove on the status frame, or undefined when the call ended meanwhile (aborted, the app left).
   */
  grpcStatusBreakpoint(call: GrpcCall, t: HeaderBag): Promise<{ headers: Record<string, string>; removed: string[] } | undefined> {
    return this.grpcSerialPause(call, async () => {
      const { ex, info } = call;
      if (!call.isLive()) return undefined;
      const custom = recordedHeaders(t);
      for (const k of ['grpc-status', 'grpc-message', 'content-type']) delete custom[k];
      const code = parseGrpcStatus(t['grpc-status']) ?? 0;
      const message = decodeGrpcMessage(t['grpc-message']);
      ex.grpcPause = { kind: 'status', code, ...(message !== undefined ? { message } : {}), trailers: custom };
      const decision = this.px.pause(ex, 'response');
      this.px.book.emitChange(ex);
      const d = await decision;
      delete ex.grpcPause;
      if (d.kind === 'gone' || !call.isLive()) return undefined;
      if (d.kind === 'abort') {
        this.px.grpc.grpcAbort(call);
        return undefined;
      }
      ex.state = 'pending';
      const e = d.edit as GrpcEdit | undefined;
      const headers: Record<string, string> = {};
      const removed: string[] = [];
      if (e?.status) {
        headers['grpc-status'] = String(e.status.code);
        info.statusCode = e.status.code;
        if (e.status.message) {
          headers['grpc-message'] = encodeGrpcMessage(e.status.message);
          info.statusMessage = e.status.message;
        } else {
          removed.push('grpc-message');
          delete info.statusMessage;
        }
      }
      if (e?.trailers) {
        for (const k of Object.keys(custom)) removed.push(k);
        for (const [k, v] of Object.entries(e.trailers)) {
          const lk = k.toLowerCase();
          headers[lk] = v;
          const i = removed.indexOf(lk);
          if (i >= 0) removed.splice(i, 1);
        }
      }
      if (e?.status || e?.trailers) ex.simulated = ex.simulated ? `${ex.simulated} · Status edited at a breakpoint` : 'Status edited at a breakpoint';
      this.px.book.emitChange(ex);
      return { headers, removed };
    });
  }
}
