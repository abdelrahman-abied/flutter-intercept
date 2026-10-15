/**
 * What agents see of exchanges, rules, gRPC calls and frames (QUALITY-1 Q5): redacted per the user's setting.
 */
import * as path from 'path';
import { fileURLToPath } from 'url';
import type { Body, Exchange, Rule, RuleAction, StackFrame } from '@flutter-intercept/proxy';
import { describeProfile, type NetworkProfile } from '@flutter-intercept/proxy/network';
import { toSnippet } from '../codegen/snippets';
import { toGrpcurl } from '../codegen/grpcurl';
import { readOnlyReason, tunnelReason } from '../ui/controller';
import { isSensitiveHeader, REDACTED, redactBody, redactBodyText, redactGrpcMetadata, redactLogLine, redactFrameText, redactHeaders, redactSecretValues, redactText, redactUrl } from './redact';
import { decodeGrpcMessages, decodeHeldMessage, grpcCodeName, grpcMethodFromGlob, grpcMethodPath, type DecodedMessage, type GrpcDeps } from '../grpc/service';
import type { GrpcSchema, ProtoFieldType, ProtoMessage } from '../grpc/types';
import { redactJsonValue } from './samples';
import { ToolInput } from './schema';
import { AgentToolError } from './types';
import { GRPC_MESSAGES_PER_DIR, MAX_GRPC_MESSAGES_JSON, OUTSIDE_PROJECT, bodyBytes, streamingLabel, protoTypeLabel, restoreRedactedJson } from './shared';
import type { AgentApiDeps, Frame, ResolvedFrame } from './shared';
import { LEARNED_SHOWN_MAX } from '@flutter-intercept/proxy/learned-meta';
import { AgentContext } from './context';

/** CONTRACTS §20.2: how many learned passthrough hosts get_status lists (the proxy keeps up to LEARNED_MAX). */
export const AGENT_MAX_LEARNED = LEARNED_SHOWN_MAX;

/**
 * QUALITY-1 Q4 (api.ts:916): a rule as agents see it. With redaction on, a grpcMock's base64 `messages` are shown
 * decoded (or summarised), so a view action is not a RuleAction the proxy could use.
 */
type GrpcMockView = Omit<Extract<RuleAction, { kind: 'grpcMock' }>, 'messages'> & { messages?: unknown[] };
type StepView = { action: ActionView; count?: number };
type ActionView = Exclude<RuleAction, { kind: 'grpcMock' } | { kind: 'sequence' }> | { kind: 'passthrough' } | GrpcMockView | (Omit<Extract<RuleAction, { kind: 'sequence' }>, 'steps'> & { steps: StepView[] });
export type RuleView = Omit<Rule, 'action'> & { action: ActionView };

export class AgentViews extends AgentContext {
  bodyView(b: Body | undefined, headers: Exchange['requestHeaders'] | undefined, maxChars: number): Record<string, unknown> | undefined {
    if (!b) return undefined;
    // CONTRACTS §14.6: a binary multipart/form-data body is shown parsed (fields redacted, files summarised).
    if (b.encoding === 'base64' && this.redact) {
      const parsed = redactBody(b, headers);
      if (parsed.encoding === 'utf8') {
        const cut = parsed.text.length > maxChars;
        return { text: cut ? parsed.text.slice(0, maxChars) : parsed.text, multipart: true, ...(cut || b.truncated ? { truncated: true } : {}), ...(cut ? { totalChars: parsed.text.length } : {}) };
      }
    }
    if (b.encoding === 'base64') {
      const n = Buffer.from(b.text, 'base64').length;
      return { text: `[binary ${n} bytes]`, binary: true, bytes: n, ...(b.truncated ? { truncated: true } : {}) };
    }
    const text = this.redact ? redactBodyText(b.text, headers) : b.text;
    const cut = text.length > maxChars;
    return { text: cut ? text.slice(0, maxChars) : text, ...(cut || b.truncated ? { truncated: true } : {}), ...(cut ? { totalChars: text.length } : {}) };
  }

  summary(e: Exchange): Record<string, unknown> {
    return {
      id: e.id,
      method: e.method,
      url: this.url(e.url),
      ...(e.status !== undefined ? { status: e.status } : {}),
      state: e.state,
      ...(e.durationMs !== undefined ? { durationMs: e.durationMs } : {}),
      startedAt: e.startedAt,
      ...(e.responseBody ? { responseBytes: bodyBytes(e.responseBody) } : {}),
      ...(e.matchedRuleId ? { matchedRuleId: e.matchedRuleId } : {}),
      ...(e.initiator ? { initiator: e.initiator } : {}),
      ...(e.simulated ? { simulated: e.simulated } : {}),
      // CONTRACTS §11.5
      ...(e.kind ? { kind: e.kind } : {}),
      ...(e.graphql?.operationName ? { graphqlOperation: e.graphql.operationName } : {}),
      ...(e.cors?.problem ? { corsProblem: true } : {}),
      ...(e.captured ? { captured: e.captured } : {}),
      ...(e.browserInternal ? { browserInternal: true } : {}),
      // CONTRACTS §14.2 / §14.3
      ...(e.kind === 'tunnel' ? { notDecrypted: true, ...(e.tunnelBytes ? { bytesSent: e.tunnelBytes.sent, bytesReceived: e.tunnelBytes.received } : {}) } : {}),
      ...(e.grpcTunnel ? { grpcTunnel: true } : {}),
      ...(e.clientCertificate ? { clientCertificate: e.clientCertificate } : {}),
      // CONTRACTS §20.2: this request taught the proxy to pass host:port through, or this tunnel is passed through because of it
      ...(e.learnedPassthrough ? { learnedPassthrough: { reason: e.learnedPassthrough.reason, host: e.learnedPassthrough.host, port: e.learnedPassthrough.port } } : {}),
      // CONTRACTS §20.7: the server wants the app's own client certificate (learned or not)
      ...(e.needsClientCertificate ? { needsClientCertificate: { host: e.needsClientCertificate.host, port: e.needsClientCertificate.port } } : {}),
      // CONTRACTS §19.4: informational notes (redacted like other free text)
      ...(e.notes?.length ? { notes: e.notes.map((n) => this.text(String(n))) } : {}),
      // CONTRACTS §16.4
      ...(e.kind === 'grpc' && e.grpc
        ? {
            grpc: {
              ...(e.grpc.statusCode !== undefined ? { code: e.grpc.statusCode, status: grpcCodeName(e.grpc.statusCode) } : {}),
              ...(e.grpc.web ? { web: e.grpc.web } : {}),
              messagesSent: e.grpc.messagesSent,
              messagesReceived: e.grpc.messagesReceived,
            },
          }
        : {}),
    };
  }

  detail(e: Exchange, includeBodies: boolean, maxBodyChars: number): Record<string, unknown> {
    const redactH = e.kind === 'grpc' ? redactGrpcMetadata : redactHeaders;
    const reqH = this.redact ? redactH(e.requestHeaders) : e.requestHeaders;
    const resH = this.redact ? redactH(e.responseHeaders) : e.responseHeaders;
    return {
      ...this.summary(e),
      requestHeaders: reqH ?? {},
      ...(resH ? { responseHeaders: resH } : {}),
      ...(includeBodies && e.requestBody ? { requestBody: this.bodyView(e.requestBody, e.requestHeaders, maxBodyChars) } : {}),
      ...(includeBodies && e.responseBody ? { responseBody: this.bodyView(e.responseBody, e.responseHeaders, maxBodyChars) } : {}),
      ...(e.pausedAt ? { pausedAt: e.pausedAt } : {}),
      ...(e.pauseDeadline ? { pauseDeadline: e.pauseDeadline } : {}),
      ...(e.error ? { error: this.text(e.error) } : {}),
      ...(e.resentFrom ? { resentFrom: e.resentFrom } : {}),
      ...(e.source?.frames?.length ? { hasSource: true } : {}),
      // CONTRACTS §11.5: frames are read with get_frames.
      ...(e.kind === 'websocket' || e.kind === 'sse' ? { frameCount: e.frames?.length ?? 0 } : {}),
      // CONTRACTS §14.2: a passed-through TLS connection has no request / response to show — say why.
      ...(e.kind === 'tunnel' ? { tunnel: { notDecrypted: tunnelReason(e), bytesSent: e.tunnelBytes?.sent ?? 0, bytesReceived: e.tunnelBytes?.received ?? 0 } } : {}),
      ...(e.framesDropped ? { framesDropped: e.framesDropped } : {}),
      ...(e.graphql ? { graphql: { ...e.graphql } } : {}),
      ...(e.cors ? { cors: { ...e.cors, ...(e.cors.problem ? { problem: this.text(e.cors.problem) } : {}) } } : {}),
      ...(e.captured ? { captured: e.captured, readOnly: readOnlyReason(e) } : {}),
      // CONTRACTS §13.2 / §13.4: scriptLog is free text from the user's script: redacted like bodies.
      ...(e.timings ? { timings: { ...e.timings } } : {}),
      ...(e.scriptLog?.length ? { scriptLog: e.scriptLog.map((l) => (this.redact ? redactLogLine(String(l)) : String(l))) } : {}),
      ...(e.kind === 'grpc' ? this.grpcDetail(e, includeBodies) : {}),
      ...this.grpcPauseView(e),
    };
  }

  // ------------------------------------------------------------------ CONTRACTS §16.4 (gRPC)

  /**
   * REVIEW-10 #5: a grpcMock's base64 `messages` as get_request would show them (redaction on): decoded with the schema
   * of the method its URL names → redacted JSON, else the raw decode redacted by value, else "[binary N bytes]".
   */
  grpcMockMessagesView(matchUrl: string, messages: readonly string[]): unknown[] {
    const methodPath = grpcMethodFromGlob(matchUrl);
    const frames = messages.map((b64, i) => {
      const size = typeof b64 === 'string' ? Buffer.from(b64, 'base64').length : 0;
      return { dir: 'receive' as const, at: i, kind: 'message' as const, base64: typeof b64 === 'string' ? b64 : '', size };
    });
    const decoded = decodeGrpcMessages({ url: `http://mock.invalid${methodPath ?? '/'}`, frames }, this.deps.grpc);
    return frames.map((f, i) => {
      const d = decoded.messages.find((m) => m.frame === i);
      if (d && d.json !== undefined && d.via !== 'none') return { via: d.via, json: redactJsonValue(d.json) };
      return `[binary ${f.size} bytes]`;
    });
  }

  /** A decoded message's JSON as agents see it (secret-named fields and credential-looking values redacted). */
  grpcJson(v: unknown): unknown {
    return this.redact ? redactJsonValue(v) : v;
  }

  /**
   * CONTRACTS §17.6: what a gRPC breakpoint holds, as agents see it — the held message decoded and redacted (never its
   * bytes), or the held status with redacted message and trailers.
   */
  grpcPauseView(e: Exchange): Record<string, unknown> {
    const p = e.grpcPause;
    if (!p) return {};
    if (p.kind === 'status') {
      const trailers = this.redact ? redactGrpcMetadata(p.trailers) : p.trailers;
      return {
        grpcPause: {
          kind: 'status',
          code: p.code,
          status: grpcCodeName(p.code),
          ...(p.message !== undefined ? { message: this.text(p.message) } : {}),
          ...(trailers && Object.keys(trailers).length ? { trailers } : {}),
        },
      };
    }
    const d = this.decodeHeld(e);
    let json: unknown;
    let jsonOmitted = false;
    if (d?.json !== undefined && d.via !== 'none') {
      json = this.heldJson(d);
      if (JSON.stringify(json).length > MAX_GRPC_MESSAGES_JSON) {
        json = undefined;
        jsonOmitted = true;
      }
    }
    return {
      grpcPause: {
        kind: 'message',
        dir: p.dir,
        index: p.index,
        size: p.size,
        via: d?.via ?? 'none',
        ...(json !== undefined ? { json } : {}),
        ...(jsonOmitted ? { jsonOmitted: true } : {}),
        ...(d?.error ? { error: this.scrub(d.error) } : {}),
      },
    };
  }

  /** The message a gRPC breakpoint holds, decoded (schema, else raw; cached, ≤ 1 MB: REVIEW-11 #6). */
  decodeHeld(e: Exchange): DecodedMessage | undefined {
    return decodeHeldMessage(e, this.deps.grpc);
  }

  /** The redacted JSON of a decoded held message, computed once per decode (REVIEW-11 #6). */
  readonly heldRedacted = new WeakMap<DecodedMessage, unknown>();
  heldJson(d: DecodedMessage): unknown {
    if (!this.redact) return d.json;
    if (!this.heldRedacted.has(d)) this.heldRedacted.set(d, redactJsonValue(d.json));
    return this.heldRedacted.get(d);
  }

  /**
   * An agent's `grpc.messageJson` with every "[redacted]" string it only saw redacted put back to the held message's
   * value at the same path (the secret goes on to the app unchanged; the agent never learns it).
   */
  restoreRedactedGrpc(e: Exchange, raw: unknown): unknown {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return raw;
    const r = raw as Record<string, unknown>;
    if (r.messageJson === undefined) return raw;
    const d = this.decodeHeld(e);
    if (d?.via !== 'schema' || d.json === undefined) {
      if (JSON.stringify(r.messageJson)?.includes(REDACTED)) {
        throw new AgentToolError('messageJson contains "[redacted]", but the held message could not be decoded to restore those values; pass the full message or message (base64)', 'invalid');
      }
      return raw;
    }
    return { ...r, messageJson: restoreRedactedJson(r.messageJson, d.json) };
  }

  /** One decoded message for get_request. */
  grpcMessageView(m: DecodedMessage, index: number): Record<string, unknown> {
    return {
      index,
      dir: m.dir,
      at: m.at,
      size: m.size,
      via: m.via,
      ...(m.compressed ? { compressed: true } : {}),
      ...(m.truncated ? { truncated: true } : {}),
      ...(m.json !== undefined ? { json: this.grpcJson(m.json) } : {}),
      ...(m.error ? { error: this.scrub(m.error) } : {}),
    };
  }

  /** get_request's gRPC part: call info, trailers, and the first messages each way decoded (≤ 64 KB of JSON). */
  grpcDetail(e: Exchange, includeMessages: boolean): Record<string, unknown> {
    const info = e.grpc;
    const path = grpcMethodPath(e.url);
    const schemaMethod = path ? this.grpcSchema()?.method(path) : undefined;
    const trailers = this.redact ? redactGrpcMetadata(e.responseTrailers) : e.responseTrailers;
    const out: Record<string, unknown> = {
      grpc: {
        ...(info ? { service: info.service, method: info.method } : {}),
        ...(info?.web ? { web: info.web } : {}),
        ...(path ? { path } : {}),
        ...(info?.statusCode !== undefined ? { code: info.statusCode, status: grpcCodeName(info.statusCode) } : {}),
        ...(info?.statusMessage !== undefined ? { statusMessage: this.text(info.statusMessage) } : {}),
        ...(info?.trailersOnly ? { trailersOnly: true } : {}),
        ...(info?.requestEncoding ? { requestEncoding: info.requestEncoding } : {}),
        ...(info?.responseEncoding ? { responseEncoding: info.responseEncoding } : {}),
        ...(info?.deadlineMs !== undefined ? { deadlineMs: info.deadlineMs } : {}),
        ...(info ? { messagesSent: info.messagesSent, messagesReceived: info.messagesReceived } : {}),
        ...(schemaMethod
          ? { requestType: schemaMethod.requestType, responseType: schemaMethod.responseType, streaming: streamingLabel(schemaMethod) }
          : {}),
      },
      ...(trailers ? { responseTrailers: trailers } : {}),
    };
    if (!includeMessages) return out;
    const seen = { send: 0, receive: 0 };
    const decoded = decodeGrpcMessages(e, this.deps.grpc, {
      filter: (f) => {
        if (f.kind !== 'message') return false;
        return seen[f.dir]++ < GRPC_MESSAGES_PER_DIR;
      },
    });
    const dropped = e.framesDropped ?? 0;
    let budget = MAX_GRPC_MESSAGES_JSON;
    let omitted = 0;
    const messages = decoded.messages.map((m) => {
      const view = this.grpcMessageView(m, dropped + m.frame);
      const size = JSON.stringify(view).length;
      if (size <= budget) {
        budget -= size;
        return view;
      }
      omitted++;
      const { json: _j, ...rest } = view;
      return { ...rest, jsonOmitted: true };
    });
    const total = (e.frames ?? []).filter((f) => f.kind === 'message').length;
    const notes: string[] = [];
    if (total > messages.length || dropped) notes.push(`showing the first ${GRPC_MESSAGES_PER_DIR} messages each way of those kept${dropped ? ` (${dropped} older frames were dropped)` : ''}; read every message with get_frames`);
    if (omitted) notes.push(`${omitted} message(s) shown without json (over ${MAX_GRPC_MESSAGES_JSON / 1024} KB in all); read them with get_frames`);
    if (decoded.messages.some((m) => m.via === 'raw') && !schemaMethod) {
      notes.push(this.grpcSchema() ? `the app's generated code has no method ${path ?? '(unknown path)'}: messages are decoded raw (field numbers)` : 'no protobuf schema (gRPC support off or no generated *.pb.dart found): messages are decoded raw (field numbers)');
    }
    return { ...out, messages, ...(notes.length ? { messagesNote: notes.join('; ') } : {}) };
  }

  /** get_frames on a gRPC call: one decoded message (JSON text, redacted) as the frame's text. */
  grpcFrameView(e: Exchange, n: number, index: number, maxChars: number): Record<string, unknown> {
    const f = (e.frames ?? [])[n];
    const d = decodeGrpcMessages(e, this.deps.grpc, { filter: (_f, i) => i === n }).messages[0];
    let text: string | undefined;
    if (d?.json !== undefined) {
      try {
        text = JSON.stringify(this.grpcJson(d.json));
      } catch {
        text = undefined;
      }
    }
    const cut = text !== undefined && text.length > maxChars;
    return {
      index,
      dir: f.dir,
      at: f.at,
      kind: f.kind,
      size: f.size,
      ...(d ? { via: d.via } : {}),
      ...(f.compressed ? { compressed: true } : {}),
      ...(text !== undefined ? { text: cut ? text.slice(0, maxChars) : text } : f.kind === 'message' ? { text: `[binary ${f.size} bytes]`, binary: true } : {}),
      ...(cut || f.truncated ? { truncated: true } : {}),
      ...(cut ? { textChars: text!.length } : {}),
      ...(d?.error ? { error: this.scrub(d.error) } : {}),
    };
  }

  // ------------------------------------------------------------------ read tools

  /** CONTRACTS §16.4: gRPC interception state and the schema's counts. */
  grpcStatusView(): Record<string, unknown> {
    const g = this.deps.grpc;
    const hosts = this.deps.host.grpcDecryptHosts ?? [];
    const problem = this.deps.host.grpcProblem;
    if (!g && !hosts.length && !problem && !this.deps.host.simulatorTrust) return {};
    let enabled = true;
    let schema: Record<string, unknown> | undefined;
    try {
      enabled = g ? g.enabled() : true;
      const st = g?.status();
      if (st) schema = { methods: st.methods, messages: st.messages, ...(st.problems.length ? { problems: st.problems.slice(0, 10).map((p) => this.scrub(p)) } : {}) };
    } catch {
      // reported as unknown
    }
    const sim = this.deps.host.simulatorTrust;
    const simulatorTrust = sim
      ? { devices: sim.devices.map((d) => ({ udid: d.udid, ...(d.name ? { name: d.name } : {}), state: d.state, ...(d.problem ? { problem: this.scrub(d.problem) } : {}) })), decryptAll: sim.decryptAll }
      : undefined;
    return { grpc: { enabled, decryptHosts: [...hosts], ...(problem ? { problem } : {}), ...(schema ? { schema } : {}), ...(simulatorTrust ? { simulatorTrust } : {}) } };
  }

  /**
   * CONTRACTS §14.2 / §14.3 / §20.2: passthrough hosts, client certificates (host patterns and problems only) and the
   * hosts the proxy learned to pass through (at most AGENT_MAX_LEARNED; `until` absent = until the proxy stops).
   */
  tlsView(): Record<string, unknown> {
    const hosts = this.deps.host.tlsPassthrough ?? [];
    const certs = this.deps.host.clientCertificateStatus ?? [];
    let learned: NonNullable<AgentApiDeps['host']['learnedPassthrough']> = [];
    try {
      learned = this.deps.host.learnedPassthrough ?? [];
    } catch {
      learned = [];
    }
    const auto = this.deps.host.autoPassthrough;
    return {
      // CONTRACTS §20.7
      ...(typeof auto === 'boolean' ? { autoPassthrough: auto } : {}),
      ...(learned.length
        ? {
            learnedPassthrough: learned.slice(0, AGENT_MAX_LEARNED).map((l) => ({
              host: l.host,
              port: l.port,
              reason: l.reason,
              ...(typeof l.until === 'number' ? { until: new Date(l.until).toISOString() } : { untilProxyStops: true }),
            })),
            ...(learned.length > AGENT_MAX_LEARNED ? { learnedPassthroughTotal: learned.length } : {}),
          }
        : {}),
      ...(hosts.length ? { tlsPassthrough: [...hosts] } : {}),
      ...(certs.length
        ? {
            clientCertificates: certs.map((c) => ({
              host: c.host,
              loaded: !c.problem,
              ...(c.problem ? { problem: this.redact ? redactText(c.problem) : c.problem } : {}),
            })),
          }
        : {}),
    };
  }

  replayView(): { replaying?: Record<string, unknown> } {
    const r = this.deps.host.replay;
    return r ? { replaying: { ...(r.id !== undefined ? { id: r.id } : {}), name: r.recording, fallback: r.fallback } } : {};
  }

  /**
   * A rule as agents see it: with redaction on, credential-carrying header values in mock headers and rewrite
   * setHeaders read "[redacted]" and a map target is shown like a redacted URL (shared rules may carry them).
   */
  ruleView(rule: Rule): RuleView {
    // CONTRACTS §13.4: agents never see a script's code (whatever the redaction setting).
    if (rule.action?.kind === 'script') {
      const { file } = rule.action;
      rule = { ...rule, action: { kind: 'script', ...(file !== undefined ? { file } : {}) } as RuleAction };
    }
    if (!this.redact) return rule as RuleView;
    const headers = (h: Record<string, string> | undefined) =>
      h ? Object.fromEntries(Object.entries(h).map(([k, v]) => [k, isSensitiveHeader(k) ? REDACTED : redactSecretValues(v, true)])) : h;
    const spec = <T extends { setHeaders?: Record<string, string>; replaceBody?: { find: string; replace: string; all?: boolean }[] }>(s: T | undefined): T | undefined =>
      s
        ? {
            ...s,
            ...(s.setHeaders ? { setHeaders: headers(s.setHeaders) } : {}),
            ...(s.replaceBody ? { replaceBody: s.replaceBody.map((r) => ({ ...r, find: redactSecretValues(r.find, true), replace: redactSecretValues(r.replace, true) })) } : {}),
          }
        : s;
    const action = (a: RuleAction | { kind: 'passthrough' }): ActionView => {
      switch (a.kind) {
        case 'mock':
          // REVIEW-10 #5: a mock made from a captured response carries its body (tokens included).
          return { ...a, ...(a.headers ? { headers: headers(a.headers) } : {}), ...(typeof a.body === 'string' ? { body: redactBodyText(a.body, a.headers) } : {}) };
        case 'mapRemote':
          return { ...a, to: redactUrl(a.to) };
        case 'grpcMock':
          return {
            ...a,
            ...(a.headers ? { headers: headers(a.headers) } : {}),
            ...(a.trailers ? { trailers: headers(a.trailers) } : {}),
            ...(a.messagesJson ? { messagesJson: a.messagesJson.map((m) => redactJsonValue(m)) } : {}),
            // objects in place of base64 strings: what get_request shows (not a rule the proxy could use)
            ...(a.messages ? { messages: this.grpcMockMessagesView(rule.match?.url ?? '', a.messages) } : {}),
          };
        case 'rewrite':
          return { ...a, ...(a.request ? { request: spec(a.request) } : {}), ...(a.response ? { response: spec(a.response) } : {}) };
        case 'sequence':
          return { ...a, steps: a.steps.map((s) => ({ ...s, action: action(s.action) })) };
        default:
          return a;
      }
    };
    return { ...rule, action: action(rule.action) };
  }

  /** CONTRACTS §9.5: the snippet is built from the redacted view (secrets stay "[redacted]"). */
  redactedSnippet(e: Exchange, format: NonNullable<ToolInput<'get_request'>['snippet']>, maxChars: number): string {
    // CONTRACTS §19.2: gRPC calls as grpcurl (redacted metadata and request JSON); grpcurl only for gRPC calls
    if (format === 'grpcurl') {
      if (e.kind !== 'grpc') throw new AgentToolError(`exchange "${e.id}" is not a gRPC call: use snippet "curl", "dart_http" or "dio"`, 'invalid');
      return toGrpcurl(e, { grpc: this.deps.grpc, projectRoot: this.deps.projectRoot(), redact: this.redact, maxDataChars: maxChars });
    }
    if (e.kind === 'grpc') throw new AgentToolError(`exchange "${e.id}" is a gRPC call: use snippet "grpcurl"`, 'invalid');
    const headers = (this.redact ? redactHeaders(e.requestHeaders) : e.requestHeaders) ?? {};
    let body: Body | undefined = e.requestBody;
    if (body && body.encoding === 'utf8') {
      const text = this.redact ? redactBodyText(body.text, e.requestHeaders) : body.text;
      const cut = text.length > maxChars;
      body = { text: cut ? text.slice(0, maxChars) : text, encoding: 'utf8', ...(cut || body.truncated ? { truncated: true } : {}) };
    }
    return toSnippet({ method: e.method, url: this.url(e.url), headers, ...(body ? { body } : {}) }, format);
  }

  profileView(p: NetworkProfile): Record<string, unknown> {
    return { ...p, label: describeProfile(p) };
  }

  /**
   * A frame for agents (REVIEW-3 #4): never an absolute path. `path` is project-relative; `uri` is kept for
   * `package:` / `dart:` / SDK URIs, becomes "<project>/<path>" for a `file:` inside the project, and
   * "<outside project>" for any other URI (absolute `file:` URIs would reveal user names and folders).
   */
  frameView(f: StackFrame | ResolvedFrame, root: string | undefined): Record<string, unknown> {
    const r = f as Partial<ResolvedFrame>;
    const relTo = (abs: string): string | undefined => {
      if (!root || !path.isAbsolute(abs)) return undefined;
      const p = path.relative(root, abs);
      return p && !p.startsWith('..') && !path.isAbsolute(p) ? p.split(path.sep).join('/') : undefined;
    };
    let rel: string | undefined;
    if (r.path) rel = path.isAbsolute(r.path) ? relTo(r.path) : r.path.startsWith('..') ? undefined : r.path.split(path.sep).join('/');
    let uri: string;
    if (/^(package|dart|org-dartlang-sdk):/.test(f.uri)) uri = f.uri;
    else {
      if (!rel && f.uri.startsWith('file:')) {
        try {
          rel = relTo(fileURLToPath(f.uri));
        } catch {
          // not a local file URI
        }
      }
      uri = rel && f.uri.startsWith('file:') ? `<project>/${rel}` : OUTSIDE_PROJECT;
    }
    return {
      fn: f.fn,
      uri,
      ...(rel ? { path: rel } : {}),
      ...(f.line !== undefined ? { line: f.line } : {}),
      ...(f.column !== undefined ? { column: f.column } : {}),
      ...(typeof r.inProject === 'boolean' ? { inProject: r.inProject } : {}),
      ...(f.afterAsyncGap ? { afterAsyncGap: true } : {}),
    };
  }

  /** One frame as agents see it: redacted text (cut at maxChars), binary summarised, absolute `index`. */
  wsFrameView(f: Frame, index: number, maxChars: number): Record<string, unknown> {
    let text: string | undefined;
    let binary = false;
    if (f.base64 !== undefined && f.text === undefined) {
      text = `[binary ${f.size} bytes]`;
      binary = true;
    } else if (f.text !== undefined) {
      text = this.redact ? redactFrameText(f.text) : f.text;
    }
    const cut = text !== undefined && !binary && text.length > maxChars;
    return {
      index,
      dir: f.dir,
      at: f.at,
      kind: f.kind,
      size: f.size,
      ...(text !== undefined ? { text: cut ? text.slice(0, maxChars) : text } : {}),
      ...(binary ? { binary: true } : {}),
      ...(cut || f.truncated ? { truncated: true } : {}),
      ...(cut ? { textChars: text!.length } : {}),
      ...(f.event !== undefined ? { event: f.event } : {}),
      ...(f.id !== undefined ? { id: this.redact ? redactSecretValues(f.id, true) : f.id } : {}),
      ...(f.closeCode !== undefined ? { closeCode: f.closeCode } : {}),
    };
  }

  /** Up to 10 method paths that look like `wanted` (same method or service name, case-insensitive). */
  similarMethods(schema: GrpcSchema, wanted: string): string[] {
    const parts = wanted.toLowerCase().split(/[/.]/).filter(Boolean);
    const last = parts[parts.length - 1] ?? '';
    return schema.methods
      .map((m) => m.path)
      .filter((p) => (last && p.toLowerCase().includes(last)) || parts.some((x) => x.length > 2 && p.toLowerCase().includes(x)))
      .slice(0, 10);
  }

  /** A schema source file for agents: project-relative, else its file name (never an absolute path). */
  schemaFile(file: string | undefined): string | undefined {
    if (!file) return undefined;
    return this.projectPath(file) ?? path.basename(file);
  }

  /** One message type for get_grpc_schema: fields, the enums they use, its file. */
  messageView(schema: GrpcSchema, msg: ProtoMessage): Record<string, unknown> {
    const enums: Record<string, string[]> = {};
    const collect = (t: ProtoFieldType) => {
      if (t.kind === 'enum' && Object.keys(enums).length < 30 && !enums[t.type]) {
        const en = schema.enumType(t.type);
        if (en) enums[t.type] = en.values.slice(0, 100).map((v) => v.name);
      }
      if (t.kind === 'map') collect(t.value);
    };
    const fields = msg.fields.slice(0, 500).map((f) => {
      collect(f.type);
      return {
        number: f.number,
        name: f.name,
        type: protoTypeLabel(f.type),
        ...(f.repeated ? { repeated: true } : {}),
        ...(f.oneof ? { oneof: f.oneof } : {}),
        ...(f.required ? { required: true } : {}),
      };
    });
    const file = this.schemaFile(msg.file);
    return { name: msg.name, fields, ...(Object.keys(enums).length ? { enums } : {}), ...(file ? { file } : {}), ...(msg.line !== undefined ? { line: msg.line } : {}) };
  }

  skeletonOf(g: GrpcDeps, schema: GrpcSchema, type: string): unknown {
    try {
      return g.codec.skeleton(schema, type);
    } catch (e) {
      return { error: `no skeleton: ${(e as Error)?.message ?? String(e)}` };
    }
  }

  /** Finds a message by full name, `.name`, short name or Dart class name. */
  findMessage(schema: GrpcSchema, name: string): ProtoMessage | undefined {
    const n = name.trim().replace(/^\./, '');
    const exact = schema.message(n);
    if (exact) return exact;
    const hits = schema.messages.filter((m) => m.name.endsWith(`.${n}`) || m.dartClass === n || m.name === n);
    return hits.length === 1 ? hits[0] : undefined;
  }
}
