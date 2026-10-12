/**
 * Agent tools: traffic (QUALITY-1 Q5: split out of api.ts). Each handler gets the shared AgentViews and its parsed input.
 */
import type { Exchange, StackFrame } from '@flutter-intercept/proxy';
import { buildHar, writeHar } from '../har';
import { decodeGrpcMessages } from '../../grpc/service';
import { FINAL_STATES } from '../samples';
import { ToolInput } from '../schema';
import { bodyShape } from '../shape';
import { AgentToolError, ToolResult } from '../types';
import { MAX_FRAME_RESULT_CHARS, bodyBytes } from '../shared';
import type { ResolvedFrame, StatusFilter, ExchangeFilter } from '../shared';
import type { AgentViews } from '../views';
import type { ToolHandlers } from './types';

export function getStatus(ag: AgentViews): ToolResult {
  const all = ag.deps.host.getExchanges();
  const s = ag.deps.getSettings();
  return {
    proxyRunning: ag.deps.host.running,
    ...(ag.deps.host.port !== undefined ? { port: ag.deps.host.port } : {}),
    interceptEnabled: s.interceptEnabled,
    sessions: ag.deps.launcher.sessions(),
    pausedCount: all.filter((e) => e.state === 'paused-request' || e.state === 'paused-response').length,
    exchangeCount: all.length,
    agentAccess: s.access,
    networkProfile: ag.profileView(ag.deps.host.networkProfile ?? { kind: 'none' }),
    // REVIEW-5 #6: what list / wait / assert hide by default.
    browserInternalHidden: all.filter((e) => e.browserInternal).length,
    warnings: (ag.deps.host.warnings ?? []).map((w) => ({ kind: w.kind, text: w.text, ...(w.sessionId ? { sessionId: w.sessionId } : {}) })),
    // CONTRACTS §12
    ...ag.replayView(),
    sharedRules: ag.deps.host.getRules().filter((r) => r.shared).length,
    // REVIEW-6 #1: pass-through traffic goes via this proxy (host:port only); §14.6 where the setting came from.
    ...(ag.deps.host.upstreamProxyInfo
      ? {
          upstreamProxy: ag.deps.host.upstreamProxyInfo.display,
          ...(ag.deps.host.upstreamProxyInfo.ignoreCertErrors ? { upstreamProxyInsecure: true } : {}),
          ...(ag.deps.host.upstreamProxySource ? { upstreamProxySource: ag.deps.host.upstreamProxySource } : {}),
        }
      : {}),
    ...ag.tlsView(),
    ...ag.grpcStatusView(),
  };
}


export function listRequests(ag: AgentViews, i: ToolInput<'list_requests'>): ToolResult {
  const keep = ag.filter(i as ExchangeFilter);
  const matched = ag.deps.host
    .getExchanges()
    .filter((e) => keep(e) && (i.state === undefined || e.state === i.state) && (i.slowerThanMs === undefined || (e.durationMs !== undefined && e.durationMs > i.slowerThanMs)))
    .sort((a, b) => b.startedAt - a.startedAt);
  return { items: matched.slice(0, i.limit).map((e) => ag.summary(e)), total: matched.length };
}


export function getRequest(ag: AgentViews, i: ToolInput<'get_request'>): ToolResult {
  const e = ag.find(i.id);
  const view = ag.detail(e, i.includeBodies, i.maxBodyChars);
  if (i.snippet) view.snippet = ag.redactedSnippet(e, i.snippet, i.maxBodyChars);
  return view;
}


export function listPaused(ag: AgentViews): ToolResult {
  const items = ag.deps.host
    .getExchanges()
    .filter((e) => e.state === 'paused-request' || e.state === 'paused-response')
    .map((e) => ({
      ...ag.summary(e),
      phase: e.state === 'paused-request' ? 'request' : 'response',
      ...(e.pausedAt ? { pausedAt: e.pausedAt } : {}),
      ...(e.pauseDeadline ? { pauseDeadline: e.pauseDeadline } : {}),
      ...ag.grpcPauseView(e),
    }));
  return { items };
}


/**
 * First exchange matching url/method/status that STARTED at or after `sinceMs` and has reached a
 * final state. Already-recorded ones are checked first (oldest wins), then 'exchange' events are
 * awaited — no polling. Resolves `{timedOut:true}` at the timeout; rejects on abort. Never hangs.
 */
export function waitForRequest(ag: AgentViews, i: ToolInput<'wait_for_request'>, signal?: AbortSignal): Promise<ToolResult> {
  const since = i.sinceMs === undefined ? ag.defaultSince() : i.sinceMs === 'now' ? ag.now() : i.sinceMs;
  const f = { url: i.url, method: i.method, status: i.status as StatusFilter, sinceMs: since, includeBrowserInternal: i.includeBrowserInternal, kind: i.kind };
  const keep = ag.filter(f);
  const hit = (e: Exchange) => FINAL_STATES.has(e.state) && keep(e);
  const view = (e: Exchange) => ({ timedOut: false, sinceMs: since, ...ag.detail(e, i.includeBodies, 20_000) });
  if (signal?.aborted) return Promise.reject(new AgentToolError('wait_for_request was cancelled', 'state'));

  return new Promise<ToolResult>((resolve, reject) => {
    let done = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (fn: () => void) => {
      if (done) return;
      done = true;
      ag.deps.host.off('exchange', onExchange);
      if (timer) clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      fn();
    };
    const onExchange = (e: Exchange) => {
      if (hit(e)) finish(() => resolve(view(e)));
    };
    const onAbort = () => finish(() => reject(new AgentToolError('wait_for_request was cancelled', 'state')));
    // Subscribe before scanning so an exchange finishing in between is not missed.
    ag.deps.host.on('exchange', onExchange);
    signal?.addEventListener('abort', onAbort, { once: true });
    timer = setTimeout(() => finish(() => resolve({ timedOut: true, waitedMs: i.timeoutMs, sinceMs: since })), i.timeoutMs);
    const recorded = ag.deps.host
      .getExchanges()
      .filter(hit)
      .sort((a, b) => a.startedAt - b.startedAt)[0];
    if (recorded) finish(() => resolve(view(recorded)));
  });
}


export async function exportHar(ag: AgentViews, i: ToolInput<'export_har'>): Promise<ToolResult> {
  const root = ag.deps.projectRoot();
  if (!root) throw new AgentToolError('no workspace folder is open to export into', 'state');
  const list = ag.deps.host.getExchanges().filter(ag.filter({ url: i.url, method: i.method, sinceMs: i.sinceMs, includeBrowserInternal: i.includeBrowserInternal }));
  const g = ag.deps.grpc;
  const grpcDecode = g ? (e: Exchange) => decodeGrpcMessages(e, g).messages.map((m) => (m.via === 'schema' ? m.json : undefined)) : undefined;
  const har = buildHar(list, { redact: ag.redact, creatorVersion: ag.deps.version, ...(grpcDecode ? { grpcDecode } : {}) });
  const file = await writeHar(root, har, new Date(ag.now()));
  return { path: file, entries: list.length, redacted: ag.redact };
}

// ------------------------------------------------------------------ write tools


export function clearRequests(ag: AgentViews): ToolResult {
  const before = ag.deps.host.getExchanges().length;
  ag.deps.clear();
  const after = ag.deps.host.getExchanges().length;
  return { cleared: Math.max(0, before - after) };
}

// ------------------------------------------------------------------ v0.3.0 (CONTRACTS §9.5)


export async function getRequestSource(ag: AgentViews, i: ToolInput<'get_request_source'>): Promise<ToolResult> {
  const e = ag.find(i.id);
  const src = e.source;
  if (!src?.frames?.length) {
    return {
      available: false,
      reason: e.initiator
        ? `this request was sent by ${e.initiator === 'agent' ? 'an agent (resend_request)' : 'the editor'}, not by the app`
        : 'no stack trace has arrived for this request: source capture may be off (setting flutterIntercept.captureSource), the app may have been launched by an older Flutter Intercept, or the trace is still on its way (retry in a moment)',
    };
  }
  const app = src.appFrame !== undefined && src.appFrame >= 0 && src.appFrame < src.frames.length ? src.appFrame : undefined;
  const upto = Math.max(i.maxFrames, app !== undefined ? app + 1 : 0);
  let frames: (StackFrame | ResolvedFrame)[] = src.frames.slice(0, upto);
  if (ag.deps.resolveFrames) {
    try {
      const resolved = await ag.deps.resolveFrames(frames);
      if (Array.isArray(resolved) && resolved.length === frames.length) frames = resolved;
    } catch {
      // unresolved frames are still useful
    }
  }
  const root = ag.deps.projectRoot();
  const views = frames.map((f) => ag.frameView(f, root));
  const appView = app !== undefined ? (({ inProject: _i, afterAsyncGap: _a, ...rest }) => rest)(views[app]) : undefined;
  return {
    available: true,
    ...(appView ? { appFrame: appView, appFrameIndex: app } : {}),
    frames: views.slice(0, i.maxFrames),
    totalFrames: src.frames.length,
  };
}


export function getBodyShape(ag: AgentViews, i: ToolInput<'get_body_shape'>): ToolResult {
  const e = ag.find(i.id);
  const body = i.which === 'request' ? e.requestBody : e.responseBody;
  const headers = i.which === 'request' ? e.requestHeaders : e.responseHeaders;
  const ctRaw = Object.entries(headers ?? {}).find(([k]) => k.toLowerCase() === 'content-type')?.[1];
  const contentType = Array.isArray(ctRaw) ? ctRaw[0] : ctRaw;
  const base = { ...(contentType ? { contentType } : {}), bytes: bodyBytes(body) ?? 0 };
  if (!body) {
    const pending = i.which === 'response' && !FINAL_STATES.has(e.state);
    return { ...base, shape: null, reason: pending ? `the response has not arrived yet (state ${e.state})` : `the ${i.which} has no body` };
  }
  if (body.encoding === 'base64') return { ...base, shape: null, reason: `the ${i.which} body is binary` };
  const r = bodyShape(body.text, { maxDepth: i.maxDepth, bodyTruncated: body.truncated });
  return { ...base, shape: r.shape, ...(r.truncated ? { truncated: true } : {}), ...(r.reason ? { reason: r.reason } : {}) };
}


/**
 * get_frames: frames of a WebSocket / SSE exchange, oldest first. Indexes are absolute (`framesDropped` +
 * position), so `since` = the previous `next` keeps paging correct while old frames are dropped.
 */
export function getFrames(ag: AgentViews, i: ToolInput<'get_frames'>): ToolResult {
  const e = ag.find(i.id);
  if (!e.kind) {
    throw new AgentToolError(`exchange "${e.id}" is a plain HTTP request, not a WebSocket, SSE stream or gRPC call; read it with get_request`, 'invalid');
  }
  if (e.kind === 'tunnel') {
    throw new AgentToolError(`exchange "${e.id}" is a TLS connection passed through without decryption (flutterIntercept.tlsPassthrough): it has no messages to read; get_request shows its byte counts`, 'invalid');
  }
  const frames = e.frames ?? [];
  const dropped = e.framesDropped ?? 0;
  const total = dropped + frames.length;
  const from = Math.max(i.since ?? dropped, dropped);
  const out: Record<string, unknown>[] = [];
  let chars = 0;
  let next = from;
  for (let n = from - dropped; n < frames.length && out.length < i.limit; n++) {
    const view = e.kind === 'grpc' ? ag.grpcFrameView(e, n, dropped + n, i.maxChars) : ag.wsFrameView(frames[n], dropped + n, i.maxChars);
    const len = typeof view.text === 'string' ? view.text.length : 0;
    if (out.length && chars + len > MAX_FRAME_RESULT_CHARS) break;
    chars += len;
    out.push(view);
    next = dropped + n + 1;
  }
  return {
    id: e.id,
    kind: e.kind,
    state: e.state,
    frames: out,
    next,
    total,
    ...(dropped ? { dropped } : {}),
    ...(i.since !== undefined && i.since < dropped ? { skipped: dropped - i.since, note: `frames ${i.since}-${dropped - 1} were dropped (only the newest are kept)` } : {}),
    more: next < total,
    ...(e.state === 'pending' ? { open: true } : {}),
  };
}

export const trafficTools: ToolHandlers = {
  get_status: (ag, _i) => getStatus(ag),
  list_requests: (ag, i) => listRequests(ag, i),
  get_request: (ag, i) => getRequest(ag, i),
  wait_for_request: (ag, i, signal) => waitForRequest(ag, i, signal),
  list_paused: (ag, _i) => listPaused(ag),
  export_har: (ag, i) => exportHar(ag, i),
  clear_requests: (ag, _i) => clearRequests(ag),
  get_request_source: (ag, i) => getRequestSource(ag, i),
  get_body_shape: (ag, i) => getBodyShape(ag, i),
  get_frames: (ag, i) => getFrames(ag, i),
};
