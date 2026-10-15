/**
 * What the controller shows of exchanges, rules, recordings and contract checks (QUALITY-1 Q3: moved out of
 * controller.ts). Pure: no vscode.
 */
import type { Exchange, Rule, RuleAction } from '@flutter-intercept/proxy';
import { fixtureApiFor, FINAL_STATES } from '../agent/samples';
import { toGrpcurl, type GrpcurlOptions } from '../codegen/grpcurl';
import { toSnippet } from '../codegen/snippets';
import type { FixtureApi } from '../codegen/types';
import type { ContractResult, ContractService } from '../contract/types';
import type { AuthAnalysis } from '../analysis/types';
import type { RecordingMeta } from '../recordings/types';
import type { SharedRulesState } from '../rules/types';
import type { AuthFlowSummary, ContractSummary, RecordingSummary, SnippetFormat, Status } from './protocol';

/** `Rule "Name" reason…` → {name, reason}; other lines keep the whole text as the reason. At most 50, each capped. */
export function pendingView(lines: readonly string[] | undefined): { name: string; reason: string }[] {
  return (lines ?? []).slice(0, 50).flatMap((line) => {
    if (typeof line !== 'string' || !line.trim()) return [];
    const m = /^Rule "((?:[^"\\]|\\.)*)"\s+([\s\S]+)$/.exec(line.trim());
    const name = m ? m[1] : 'Shared rule';
    const reason = (m ? m[2] : line.trim()).replace(/[\r\n]+/g, ' ');
    return [{ name: name.slice(0, 200), reason: reason.slice(0, 500) }];
  });
}

/** CONTRACTS §12.4: the exchanges a recording keeps — finished plain HTTP traffic the app made through the proxy. */
/** CONTRACTS §12.4 / §14.5: finished HTTP, WebSocket and SSE exchanges (not tunnels, native-client or browser traffic). */
export function isRecordable(e: Exchange): boolean {
  if (e.kind === 'websocket' && e.status !== 101) return false; // an upgrade that never opened (the store agrees)
  // CONTRACTS §17.4: a gRPC call that ended with a status (the store agrees)
  if (e.kind === 'grpc' && (e.grpc?.statusCode === undefined || (e.state !== 'completed' && e.state !== 'mocked'))) return false;
  return FINAL_STATES.has(e.state) && e.kind !== 'tunnel' && e.captured !== 'vm-profile' && !e.browserInternal;
}

export function recordingSummary(m: RecordingMeta): RecordingSummary {
  return {
    id: m.id,
    name: m.name,
    createdAt: m.createdAt,
    exchanges: m.exchanges,
    redacted: m.redacted,
    // CONTRACTS §14.5: WebSocket / SSE exchanges among them and their frames (absent in older recordings)
    ...(typeof m.streams === 'number' && m.streams > 0 ? { streams: m.streams } : {}),
    ...(typeof m.frames === 'number' && m.frames > 0 ? { frames: m.frames } : {}),
    // CONTRACTS §17.4
    ...(typeof m.grpc === 'number' && m.grpc > 0 ? { grpc: m.grpc } : {}),
  };
}

export function authFlowSummaries(a: AuthAnalysis | undefined): AuthFlowSummary[] {
  return (a?.flows ?? []).map((f) => ({
    steps: f.steps.map((s) => ({ exchangeId: s.exchangeId, role: s.role })),
    ...(f.stampede ? { stampede: { refreshCalls: f.stampede.refreshCalls, windowMs: f.stampede.windowMs } } : {}),
    ...(f.problem ? { problem: f.problem } : {}),
  }));
}

/** Status.sharedRules from the service state (omitted when there is neither a file nor anything to say). */
export function sharedRulesStatus(s: SharedRulesState | undefined): Status['sharedRules'] {
  if (!s) return undefined;
  if (!s.file && !s.rules.length && !s.problems.length && !s.pendingApproval.length) return undefined;
  return { ...(s.file ? { file: s.file } : {}), count: s.rules.length, problems: s.problems.slice(0, 50), pendingApproval: s.pendingApproval.length };
}

/** Deep JSON equality, object key order ignored (`used` is display-only and ignored). */
export function sameRules(a: Rule[], b: Rule[]): boolean {
  const norm = (r: Rule) => {
    const { used: _u, ...rest } = r;
    return rest;
  };
  return a.length === b.length && a.every((r, i) => deepEqual(norm(r), norm(b[i])));
}

export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) return a.length === (b as unknown[]).length && a.every((x, i) => deepEqual(x, (b as unknown[])[i]));
  const ka = Object.keys(a).filter((k) => (a as Record<string, unknown>)[k] !== undefined);
  const kb = Object.keys(b).filter((k) => (b as Record<string, unknown>)[k] !== undefined);
  return ka.length === kb.length && ka.every((k) => deepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
}

/** CONTRACTS §10.5: the panel's view of a contract result (no file paths). */
export function contractSummary(r: ContractResult): ContractSummary {
  return {
    id: r.exchangeId,
    checked: r.checked,
    ...(r.model ? { model: r.model } : {}),
    via: r.via,
    violations: r.violations.map((v) => ({ path: v.path, field: v.field, expected: v.expected, actual: v.actual, severity: v.severity, message: v.message })),
    ...(r.reason ? { reason: r.reason } : {}),
  };
}

export const CONTRACT_OFF = 'Contract check is off (setting flutterIntercept.contractCheck).';

/**
 * CONTRACTS §10.4: the Retrofit/Chopper interface a mocktail fixture test mocks, from the contract service's
 * endpoint index. Undefined (the generator then falls back to MockClient) without a service or a match.
 */
export async function fixtureApi(
  contract: ContractService | undefined,
  exchanges: Exchange[],
  root: string | undefined,
  packageName: string | undefined,
  log?: (msg: string) => void,
): Promise<FixtureApi | undefined> {
  if (!contract) return undefined;
  try {
    const [endpoints, models] = await Promise.all([contract.endpoints(), contract.models()]);
    return fixtureApiFor(endpoints, exchanges, models, { root, packageName });
  } catch (e) {
    log?.(`fixture API lookup failed: ${e instanceof Error ? e.message : String(e)}`);
    return undefined;
  }
}

/** Kinds `createRuleFromExchange` can build (throttle/fault rules come from the rule editor); grpcMock: CONTRACTS §16.4. */
export const RULE_KINDS = new Set<RuleAction['kind']>(['mock', 'block', 'breakpoint', 'grpcMock']);
/** CONTRACTS §11: what the panel gets of a WebSocket / SSE exchange's frames (the newest; the rest is counted). */
export const UI_MAX_FRAMES = 200;
export const UI_MAX_FRAME_CHARS = 2_000_000;
/** REVIEW-5 #4: an open WebSocket / SSE exchange updates the panel at most every this many ms (≤ 2×/s). */
export const UI_STREAM_UPDATE_MS = 500;

export type Frame = NonNullable<Exchange['frames']>[number];

/** A frame's weight, as the proxy counts it (packages/proxy/src/frames.ts `frameCost`, not exported). */
export function uiFrameCost(f: Frame): number {
  return (f.text?.length ?? 0) + (f.base64?.length ?? 0) + (f.event?.length ?? 0) + (f.id?.length ?? 0) + 32;
}

/** A WebSocket / SSE exchange that is still open (its frames keep changing). */
export function isLiveStream(e: Exchange): boolean {
  return !!e.kind && e.state === 'pending';
}

/**
 * The exchange as sent to the webview: at most UI_MAX_FRAMES newest frames and UI_MAX_FRAME_CHARS of frame
 * payload (text, base64, SSE event name and id: `uiFrameCost`), the older ones added to `framesDropped`. Other exchanges are returned as is.
 */
export function uiExchange(e: Exchange): Exchange {
  const frames = e.frames;
  if (!frames || !frames.length) return e;
  let keep = 0;
  let chars = 0;
  for (let i = frames.length - 1; i >= 0 && keep < UI_MAX_FRAMES; i--) {
    const n = uiFrameCost(frames[i]);
    if (keep > 0 && chars + n > UI_MAX_FRAME_CHARS) break;
    chars += n;
    keep++;
  }
  if (keep === frames.length) return e;
  return { ...e, frames: frames.slice(frames.length - keep), framesDropped: (e.framesDropped ?? 0) + (frames.length - keep) };
}

/** CONTRACTS §11.4: why a rule / resend can't be based on this exchange, or undefined. */
export function readOnlyReason(e: Exchange): string | undefined {
  if (e.captured === 'vm-profile') {
    return "this request was made by a native HTTP client (read from the app's HTTP profile); it never went through the proxy, so rules can't change it and it can't be resent from here";
  }
  return undefined;
}

/**
 * CONTRACTS §14.2: a block rule for a passed-through TLS connection: every connection to that origin (any method, so
 * it also covers the CONNECT), 403.
 */
export function tunnelBlockRule(e: Exchange, id: string): Rule {
  // The authority exactly as the proxy recorded it (`https://host:port`), so the rule matches the tunnel's own URL
  // whether or not the proxy spells out the default port; no method, so it also covers the CONNECT.
  const m = /^(https?:\/\/[^/?#\s*]+)/i.exec(e.url ?? '');
  let ok = false;
  try {
    ok = !!m && !!new URL(m[1]).hostname;
  } catch {
    ok = false;
  }
  if (!m || !ok) throw new Error("Can't create a rule from this connection: its address is not a URL.");
  const authority = m[1];
  return { id, enabled: true, name: `block ${authority.replace(/^https?:\/\//i, '')} (TLS passthrough)`, match: { url: `${authority}/*` }, action: { kind: 'block', mode: 'status', status: 403 } };
}

/**
 * CONTRACTS §20.7: the server wants the app's own client certificate — the proxy concluded it on this request
 * (`needsClientCertificate`, learned or not) or passes this tunnel through because of it.
 */
export function needsOwnCertificate(e: Exchange): boolean {
  return !!e.needsClientCertificate || e.learnedPassthrough?.reason === 'client-certificate';
}

/** CONTRACTS §14.2: why a tunnel's contents are not shown (agents' `get_request`, the panel). */
export function tunnelReason(e: Exchange): string | undefined {
  if (e.kind !== 'tunnel') return undefined;
  let host = '';
  try {
    host = new URL(e.url).hostname;
  } catch {
    // keep generic
  }
  // CONTRACTS §20.1: passed through because the proxy learned it (the app's own client certificate, or it pins).
  const learned = e.learnedPassthrough;
  if (needsOwnCertificate(e)) {
    return `the server${host ? ` ${host}` : ''} asks the app for its own client certificate (mutual TLS), so Flutter Intercept passes it through without decryption and the app talks to it directly; only the bytes each way and the timing are known. To see these requests, add the certificate in the Flutter Intercept panel (Add client certificate…). Only block rules (and faults) apply to it.`;
  }
  if (learned?.reason === 'pinned') {
    return `the app rejected the Flutter Intercept certificate for${host ? ` ${host}` : ' this host'} (it pins its certificate), so the host is passed through without decryption for 10 minutes; only the bytes each way and the timing are known. Add the host to flutterIntercept.tlsPassthrough to keep it that way, or forget it in the panel to try decrypting again. Only block rules (and faults) apply to it.`;
  }
  // CONTRACTS §16.5: a gRPC connection over TLS with the app's default credentials.
  if (e.grpcTunnel) {
    return `gRPC over TLS${host ? ` to ${host}` : ''}, not decrypted: the app trusts only its own certificate roots, so only the bytes each way and the timing are known. Add the host to flutterIntercept.grpc.decryptHosts if the app trusts the Flutter Intercept CA in debug (pinned to it, or onBadCertificate). Only block rules (and faults) apply to it.`;
  }
  return `the TLS connection${host ? ` to ${host}` : ''} was passed through without decryption because the host matches flutterIntercept.tlsPassthrough (for apps that pin certificates); only the bytes each way and the timing are known, no request, headers or bodies. Only block rules (and faults) apply to it.`;
}

// ---------------------------------------------------------------------------------------------
// Host-side validation of everything the webview sends (review #7). The webview is ours, but
// the host must never persist or apply a malformed rule (a rule without `match` must not become
// match-all) nor forward an edit the proxy would turn into a broken response for the app.
// ---------------------------------------------------------------------------------------------

/** Turns a ruleFromExchange failure (proxy's typed error for truncated/binary bodies, review #8) into user text. */
export function ruleFromExchangeErrorMessage(e: unknown, kind: string): string {
  const err = e as { code?: unknown; message?: unknown };
  const what = kind === 'mock' ? 'a mock rule' : `a ${kind} rule`;
  if (err?.code === 'truncated') return `Can't create ${what} from this exchange: its response body was truncated (too large to store), so the mock would be incomplete.`;
  if (err?.code === 'binary') return `Can't create ${what} from this exchange: its response body is binary, and mock bodies are text.`;
  const msg = typeof err?.message === 'string' && err.message ? err.message : String(e);
  return `Can't create ${what} from this exchange: ${msg}`;
}

/** The request of `ex` as a code snippet (unredacted: the caller decides what to redact). */
export function snippetFor(ex: Exchange, format: SnippetFormat, grpcurl?: GrpcurlOptions): string {
  // CONTRACTS §19.2: gRPC calls (HTTP/2 and gRPC-Web) are copied as grpcurl; grpcurl only for them
  if (format === 'grpcurl') return toGrpcurl(ex, grpcurl);
  if (ex.kind === 'grpc') throw new Error(`This is a gRPC call: copy it as grpcurl (a ${format === 'curl' ? 'curl' : 'Dart'} snippet can't replay its protobuf messages).`);
  return toSnippet({ method: ex.method, url: ex.url, headers: ex.requestHeaders, ...(ex.requestBody ? { body: ex.requestBody } : {}) }, format);
}
