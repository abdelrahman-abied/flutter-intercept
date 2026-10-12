// A flow module of InterceptProxy (QUALITY-1 Q1); it sees the proxy through ProxyContext.

import { requestInternals } from './mockttp-internals';
import { STATUS_CODES } from 'http';
import type { CompletedRequest } from 'mockttp';
import {
  cleanHeaders,
  decodeForDisplay,
  deleteHeader,
  frameBody,
  frameBodyAsync,
  getHeader,
  normalizedEncoding,
  setHeader,
  type HeaderBag,
} from './body';
import { corsResponseHeaders, hasAllowOrigin, isCorsRequest, preflightResponseHeaders } from './cors';
import { lanGateOf, lanTargetDenial, SSRF_MARKER } from './lan';
import { mutateBody } from './mutate';
import { TRACE_HEADER } from './trace';
import {
  readRequestResult,
  readResponseResult,
  sameHeaders,
  scriptRequestOf,
  scriptResponseOf,
  type ScriptHook,
  SCRIPT_LOG_MAX_CHARS,
  SCRIPT_LOG_MAX_LINES,
  type RequestOutcome,
  type ScriptOutcome,
} from './script';
import type { Body, Exchange, MutateOp, RequestEdit, ResponseEdit } from './types';
import type {
  ScriptAction,
  RewriteFlow,
  CallbackRequestResult,
  CallbackResponseResult,
  CallbackResponseMessageResult,
  PassThroughResponse,
  Flow,
} from './flow-types';
import { SEND_HEADER, FAULT_LABELS, decodeFull, sleep, isEventStream, copyHeaders, isEmptyEdit } from './proxy-util';
import {
  rewriteSets,
  rewriteHostOf,
  rewritePairs,
  pairsToObject,
  headerPairs,
  validRewriteStatus,
  replaceInBody,
} from './rewrite-flow';
import type { ProxyContext } from './proxy-context';

/** HTTP request / response changes: scripts, rewrite, mutate, breakpoint edits, faults, local answers. */
export class HttpEdits {
  constructor(private readonly px: ProxyContext) {}

  /** A 502 answered by the proxy (`Flutter Intercept: <error>`); the exchange ends 'error' with `error`. */
  localFailure(ex: Exchange, error: string): CallbackResponseMessageResult & { statusCode: number } {
    const text = `Flutter Intercept: ${error}`;
    const headers: HeaderBag = { 'content-type': 'text/plain; charset=utf-8' };
    const rawBody = frameBody(Buffer.from(text, 'utf8'), headers);
    ex.status = 502;
    ex.responseHeaders = cleanHeaders(headers);
    ex.responseBody = { text, encoding: 'utf8' };
    this.px.book.fail(ex, error);
    return { statusCode: 502, statusMessage: STATUS_CODES[502], headers, rawBody };
  }

  // ---------------------------------------------------------------- script rules (CONTRACTS §13.4)

  /** Run a hook of the flow's script rule; its log lines go to `scriptLog`. */
  async runScript(ex: Exchange, flow: Flow, action: ScriptAction, hook: ScriptHook, args: unknown[]): Promise<ScriptOutcome> {
    const rule = flow.rule;
    const id = rule?.id ?? '';
    const out = await this.px.scripts.run(id, rule?.name || id, action.code, hook, args, { ruleId: id, exchangeId: ex.id });
    if (out.lines.length) ex.scriptLog = [...(ex.scriptLog ?? []), ...out.lines].slice(0, SCRIPT_LOG_MAX_LINES);
    return out;
  }

  /** "Script <rule name>: <message>", also added as the last scriptLog line (room is made for it). */
  scriptError(ex: Exchange, flow: Flow, message: string): string {
    const text = `Script ${flow.rule?.name || flow.rule?.id || ''}: ${message}`.slice(0, 2 * SCRIPT_LOG_MAX_CHARS);
    ex.scriptLog = [...(ex.scriptLog ?? []).slice(0, SCRIPT_LOG_MAX_LINES - 1), text.slice(0, SCRIPT_LOG_MAX_CHARS)];
    return text;
  }

  /**
   * onRequest: forward unchanged (undefined), forward the edited request (re-framed like a request edit), or answer
   * locally (`{response}`, like a mock: state 'mocked'). A throw, timeout or invalid result → 502, state 'error'.
   */
  async scriptRequest(
    req: CompletedRequest,
    ex: Exchange,
    flow: Flow,
    action: ScriptAction,
    body: Body | undefined,
  ): Promise<CallbackRequestResult | undefined> {
    this.px.book.track(ex, flow);
    const input = scriptRequestOf(ex.method, ex.url, ex.requestHeaders, body);
    const out = await this.runScript(ex, flow, action, 'onRequest', [input]);
    if (this.px.book.live.get(ex.id)?.ex !== ex || ex.state !== 'pending') return { response: 'close' }; // the app left
    let plan: RequestOutcome | undefined;
    let error = out.error;
    if (error === undefined && out.value !== undefined) {
      try {
        plan = readRequestResult(out.value);
      } catch (e) {
        error = (e as Error).message;
      }
    }
    if (error !== undefined) return { response: this.localFailure(ex, this.scriptError(ex, flow, error)) };
    if (plan?.kind === 'respond') {
      const headers: HeaderBag = { ...plan.headers };
      this.addCorsToLocalResponse(ex, headers);
      const decoded = Buffer.from(plan.body, 'utf8');
      const rawBody = frameBody(decoded, headers);
      ex.status = plan.status;
      ex.responseHeaders = cleanHeaders(headers);
      ex.responseBody = await decodeForDisplay(decoded, undefined, true);
      if (isEventStream(getHeader(headers, 'content-type'))) this.px.taps.setSseFrames(ex, decoded);
      this.px.book.finish(ex, 'mocked');
      return { response: { statusCode: plan.status, statusMessage: STATUS_CODES[plan.status] ?? 'Unknown', headers, rawBody } };
    }
    let result: CallbackRequestResult | undefined;
    if (plan) {
      const edit: RequestEdit = {};
      if (plan.method !== undefined && plan.method !== ex.method) edit.method = plan.method;
      if (plan.url !== undefined && plan.url !== ex.url) edit.url = plan.url;
      if (plan.headers && !sameHeaders(plan.headers, input.headers)) edit.headers = plan.headers;
      if (plan.body !== undefined && plan.body !== input.body) edit.body = plan.body;
      result = await this.applyRequestEdit(req, ex, edit);
    }
    if (!(await this.latency(ex, flow))) return { response: 'close' };
    return result;
  }

  /** onResponse: the response unchanged or edited (re-framed like a response edit); failures → 502. */
  async scriptResponse(
    res: PassThroughResponse,
    ex: Exchange,
    flow: Flow,
    action: ScriptAction,
  ): Promise<CallbackResponseResult | undefined> {
    const input = scriptResponseOf(res.statusCode, ex.responseHeaders ?? {}, ex.responseBody);
    const request = scriptRequestOf(ex.method, ex.url, ex.requestHeaders, ex.requestBody);
    const out = await this.runScript(ex, flow, action, 'onResponse', [input, request]);
    if (this.px.book.live.get(ex.id)?.ex !== ex || ex.state !== 'pending') return 'close';
    let edit: ResponseEdit | undefined;
    let error = out.error;
    if (error === undefined && out.value !== undefined) {
      try {
        const r = readResponseResult(out.value);
        edit = {};
        if (r.status !== undefined && r.status !== res.statusCode) edit.status = r.status;
        if (r.headers && !sameHeaders(r.headers, input.headers)) edit.headers = r.headers;
        if (r.body !== undefined && r.body !== input.body) edit.body = r.body;
      } catch (e) {
        error = (e as Error).message;
      }
    }
    if (error !== undefined) return this.localFailure(ex, this.scriptError(ex, flow, error));
    return this.applyResponseEdit(res, ex, edit);
  }

  /**
   * Map Remote / rewrite on a hooked route (CONTRACTS §12.6): what decide() couldn't do — a rule chosen only now
   * (GraphQL scope), a Host header other than the URL's, request body replacements.
   */
  async forwardChanges(req: CompletedRequest, ex: Exchange, flow: Flow): Promise<CallbackRequestResult | undefined> {
    const result: CallbackRequestResult = {};
    let headers: HeaderBag | undefined;
    let urlHost = new URL(req.url).host;
    if (!flow.reqApplied) {
      // Decided in beforeRequest: nothing was applied to the request yet.
      if (flow.map) {
        if (flow.viaLan) {
          // The LAN deny rule saw the original URL: check the mapped target now (CONTRACTS §7).
          const gate = lanGateOf(requestInternals(req).socket);
          const reason = await lanTargetDenial(flow.map.url, gate?.host);
          if (reason || !gate || gate.closed) {
            const text = reason ?? `${SSRF_MARKER}: LAN mode is off.`;
            ex.status = 403;
            ex.responseBody = { text, encoding: 'utf8' };
            this.px.book.fail(ex, text);
            return { response: { statusCode: 403, statusMessage: 'Forbidden', headers: { 'content-type': 'text/plain; charset=utf-8', connection: 'close' }, body: text } };
          }
        }
        result.url = flow.map.url;
        urlHost = new URL(flow.map.url).host;
      }
      let pairs = Object.entries(req.headers as HeaderBag).flatMap(([k, v]) =>
        v === undefined ? [] : (Array.isArray(v) ? v : [v]).map((x) => [k, x] as [string, string]),
      );
      if (flow.rewrite?.request) pairs = rewritePairs(pairs, rewriteSets(flow.rewrite.request));
      headers = pairsToObject(pairs);
      const want = rewriteHostOf(flow.rewrite?.request) ?? flow.map?.host ?? urlHost;
      if (want !== urlHost) flow.wantHost = want;
    }
    if (flow.wantHost) {
      headers ??= { ...(req.headers as HeaderBag) };
      setHeader(headers, 'host', flow.wantHost);
    }
    const replace = flow.rewrite?.reqBody ? flow.rewrite.request?.replaceBody : undefined;
    if (replace?.length) {
      headers ??= { ...(req.headers as HeaderBag) };
      const out = await replaceInBody(req.body.buffer, getHeader(headers, 'content-encoding'), replace);
      if (out.kind === 'skipped') this.px.book.addNote(ex, `Rewrite rule: request body not changed: ${out.reason}; it was forwarded unchanged.`);
      else {
        result.rawBody = frameBody(out.decoded, headers);
        this.px.book.setRequestBody(ex, await decodeForDisplay(out.decoded, undefined, true));
        if (out.unmatched) this.px.book.addNote(ex, `Rewrite rule: ${out.unmatched} request body replacement(s) found nothing.`);
      }
    }
    if (headers) {
      if (getHeader(headers, 'host') === urlHost) deleteHeader(headers, 'host'); // mockttp derives it from the URL
      result.headers = headers;
      const recorded: HeaderBag = { ...headers };
      if (!getHeader(recorded, 'host')) recorded.host = urlHost;
      ex.requestHeaders = cleanHeaders(recorded);
      this.px.book.emitChange(ex);
    }
    return Object.keys(result).length ? result : undefined;
  }

  /** A CORS preflight answered locally for a mock / block / cors rule (CONTRACTS §11.3). */
  answerPreflight(req: CompletedRequest, ex: Exchange, flow: Flow): CallbackRequestResult {
    this.px.book.track(ex, flow);
    const headers: HeaderBag = preflightResponseHeaders(req.headers as HeaderBag, flow.corsPatch ?? {}) ?? { 'content-length': '0' };
    // REVIEW-13: a grpcMock's answer depends on the call, not just its URL: the browser must not cache this preflight.
    if (flow.action?.kind === 'grpcMock') setHeader(headers, 'access-control-max-age', '0');
    ex.status = 204;
    ex.responseHeaders = cleanHeaders(headers);
    ex.cors = { preflight: true, patched: true };
    this.px.book.finish(ex, 'mocked');
    return { response: { statusCode: 204, statusMessage: STATUS_CODES[204], headers, rawBody: Buffer.alloc(0) } };
  }

  /** Mock / block answers to browser requests get Access-Control-Allow-Origin when they lack it. */
  addCorsToLocalResponse(ex: Exchange, headers: HeaderBag): void {
    if (hasAllowOrigin(headers) || !isCorsRequest(ex.method, ex.url, ex.requestHeaders)) return;
    const vary = getHeader(headers, 'vary');
    const set = corsResponseHeaders(ex.requestHeaders, Object.keys(headers), vary); // loopback origins only
    if (!set) return;
    deleteHeader(headers, 'vary');
    Object.assign(headers, set);
    ex.cors = { ...ex.cors, patched: true };
  }

  /** Throttle latency before forwarding on a hooked route. false = the exchange ended meanwhile. */
  async latency(ex: Exchange, flow: Flow): Promise<boolean> {
    const ms = flow.throttle?.latencyMs;
    if (ms && ms > 0) {
      const from = performance.now();
      await sleep(ms);
      if (this.px.book.live.get(ex.id)?.ex === ex) this.px.book.addPhase(ex, 'delayMs', performance.now() - from);
    }
    return this.px.book.live.has(ex.id);
  }

  /**
   * reset / drop: RST after the tunnel is up; dns: close without a response (FIN); timeout: hold until
   * the app gives up (or breakpointTimeoutMs, then RST). Never at the CONNECT/TLS level, where dart:io
   * would fall back to DIRECT (docs/spikes/faults.md). The exchange ends 'blocked'.
   */
  async applyFault(ex: Exchange, flow: Flow): Promise<CallbackRequestResult> {
    this.px.book.track(ex, flow);
    if (flow.fault === 'drop' && !(await this.latency(ex, flow))) return { response: 'close' };
    if (flow.fault === 'timeout') {
      const appLeft = await new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => settle(false), this.px.breakpointTimeoutMs);
        timer.unref?.();
        const settle = (left: boolean) => {
          clearTimeout(timer);
          this.px.holds.delete(ex.id);
          resolve(left);
        };
        this.px.holds.set(ex.id, settle);
      });
      if (!this.px.book.live.has(ex.id)) return { response: 'close' }; // proxy stopped
      const s = ((Date.now() - ex.startedAt) / 1000).toFixed(1);
      ex.simulated = appLeft ? `${FAULT_LABELS.timeout} (the app gave up after ${s} s)` : `${FAULT_LABELS.timeout} (reset after ${s} s)`;
      this.px.book.finish(ex, 'blocked');
      return appLeft ? { response: 'close' } : { response: 'reset' };
    }
    if (!this.px.book.live.has(ex.id)) return { response: 'close' };
    this.px.book.finish(ex, 'blocked');
    return flow.fault === 'dns' ? { response: 'close' } : { response: 'reset' };
  }

  /**
   * The mutate rule (CONTRACTS §10.2): JSON ops on the complete upstream body, re-encoded and re-framed
   * like a body edit. Anything that can't be mutated is forwarded unchanged with a note in `error`.
   */
  async applyMutation(res: PassThroughResponse, ex: Exchange, ops: MutateOp[]): Promise<CallbackResponseMessageResult | undefined> {
    const outcome = await mutateBody(res.body.buffer, getHeader(res.headers, 'content-encoding'), ops);
    if (outcome.kind === 'skipped') {
      this.px.book.addNote(ex, outcome.note);
      return undefined;
    }
    const headers: HeaderBag = { ...res.headers };
    // Integrity headers would no longer describe the body.
    for (const h of ['content-md5', 'digest', 'content-digest', 'repr-digest']) deleteHeader(headers, h);
    const rawBody = await frameBodyAsync(outcome.decoded, headers); // off the event loop (REVIEW-4 #4)
    ex.responseHeaders = cleanHeaders(headers);
    ex.responseBody = await decodeForDisplay(outcome.decoded, undefined, true);
    ex.simulated = ex.simulated ? `${ex.simulated} · ${outcome.label}` : outcome.label;
    if (outcome.unmatched.length) this.px.book.addNote(ex, `Mutate rule: nothing matched ${outcome.unmatched.join(', ')} (the other changes were applied).`);
    return { headers, rawBody };
  }

  /** A rewrite rule on a buffered response (CONTRACTS §12.6): status, headers, literal body replacements. */
  async applyRewriteResponse(res: PassThroughResponse, ex: Exchange, rw: RewriteFlow): Promise<CallbackResponseMessageResult | undefined> {
    const spec = rw.response!;
    const result: CallbackResponseMessageResult = {};
    if (spec.status !== undefined && validRewriteStatus(spec.status) && spec.status !== res.statusCode) {
      result.statusCode = spec.status;
      result.statusMessage = STATUS_CODES[spec.status] ?? 'Unknown';
      ex.status = spec.status;
    }
    const sets = rewriteSets(spec, true);
    const replace = rw.resBody ? spec.replaceBody : undefined;
    if (!sets.remove.length && !sets.set.length && !replace?.length) return Object.keys(result).length ? result : undefined;
    const headers = pairsToObject(rewritePairs(headerPairs(res.headers as HeaderBag), sets));
    let rawBody: Buffer = res.body.buffer;
    if (replace?.length) {
      const out = await replaceInBody(res.body.buffer, getHeader(res.headers as HeaderBag, 'content-encoding'), replace);
      if (out.kind === 'skipped') this.px.book.addNote(ex, `Rewrite rule: response body not changed: ${out.reason}; it was forwarded unchanged.`);
      else {
        for (const h of ['content-md5', 'digest', 'content-digest', 'repr-digest']) deleteHeader(headers, h);
        rawBody = await frameBodyAsync(out.decoded, headers);
        ex.responseBody = await decodeForDisplay(out.decoded, undefined, true);
        if (out.unmatched) this.px.book.addNote(ex, `Rewrite rule: ${out.unmatched} response body replacement(s) found nothing.`);
      }
    }
    if (rawBody === res.body.buffer) {
      deleteHeader(headers, 'transfer-encoding');
      setHeader(headers, 'content-length', String(rawBody.length));
    }
    result.headers = headers;
    result.rawBody = rawBody;
    ex.responseHeaders = cleanHeaders(headers);
    return result;
  }

  async applyRequestEdit(
    req: CompletedRequest,
    ex: Exchange,
    edit: RequestEdit | undefined,
  ): Promise<CallbackRequestResult | undefined> {
    if (!edit || isEmptyEdit(edit)) return undefined;
    const result: CallbackRequestResult = {};

    if (edit.method) {
      result.method = edit.method.toUpperCase();
      ex.method = result.method;
    }
    if (edit.url) {
      result.url = edit.url;
      ex.url = edit.url;
    }

    const originalHeaders: HeaderBag = { ...req.headers };
    const headers: HeaderBag = edit.headers ? copyHeaders(edit.headers) : { ...originalHeaders };
    deleteHeader(headers, TRACE_HEADER); // never upstream, even if an edit adds it back
    deleteHeader(headers, SEND_HEADER);
    // A Host header left over from the original request would pin the old virtual host when the
    // URL changes; drop it unless the user deliberately changed it, so mockttp derives it.
    const originalHost = getHeader(originalHeaders, 'host');
    if (getHeader(headers, 'host') === originalHost) deleteHeader(headers, 'host');

    const encodingChanged =
      normalizedEncoding(getHeader(headers, 'content-encoding')) !==
      normalizedEncoding(getHeader(originalHeaders, 'content-encoding'));

    let decodedBody: Buffer | undefined;
    if (edit.body !== undefined || encodingChanged) {
      // The request body here is complete and ≤ REQUEST_PAUSE_LIMIT_BYTES (see decide()).
      decodedBody = edit.body !== undefined ? Buffer.from(edit.body, 'utf8') : await decodeFull(req.body);
      result.rawBody = frameBody(decodedBody, headers);
    }
    if (edit.headers || decodedBody) result.headers = headers;

    if (result.headers) {
      const recorded: HeaderBag = { ...headers };
      if (!getHeader(recorded, 'host')) recorded.host = new URL(ex.url).host;
      ex.requestHeaders = cleanHeaders(recorded);
    }
    if (decodedBody) this.px.book.setRequestBody(ex, await decodeForDisplay(decodedBody, undefined, true));
    return result;
  }

  async applyResponseEdit(
    res: PassThroughResponse,
    ex: Exchange,
    edit: ResponseEdit | undefined,
  ): Promise<CallbackResponseMessageResult | undefined> {
    if (!edit || isEmptyEdit(edit)) return undefined;
    const result: CallbackResponseMessageResult = {};

    if (edit.status !== undefined && edit.status !== res.statusCode) {
      result.statusCode = edit.status;
      result.statusMessage = STATUS_CODES[edit.status] ?? 'Unknown';
      ex.status = edit.status;
    }

    if (edit.body !== undefined || edit.headers) {
      // Re-frame whenever headers are replaced too: an edited header set can't be trusted to
      // still describe the original bytes (content-encoding, content-length, transfer-encoding).
      const headers: HeaderBag = edit.headers ? copyHeaders(edit.headers) : { ...res.headers };
      const sameEncoding =
        normalizedEncoding(getHeader(headers, 'content-encoding')) ===
        normalizedEncoding(getHeader(res.headers, 'content-encoding'));
      if (edit.body === undefined && sameEncoding) {
        // Headers only, same encoding: forward the original wire bytes, just fix the framing.
        result.rawBody = res.body.buffer;
        deleteHeader(headers, 'transfer-encoding');
        deleteHeader(headers, 'content-length');
        headers['content-length'] = String(res.body.buffer.length);
      } else {
        const decodedBody = edit.body !== undefined ? Buffer.from(edit.body, 'utf8') : await decodeFull(res.body);
        result.rawBody = frameBody(decodedBody, headers);
        if (edit.body !== undefined) ex.responseBody = await decodeForDisplay(decodedBody, undefined, true);
      }
      result.headers = headers;
      ex.responseHeaders = cleanHeaders(headers);
    }
    return result;
  }
}
