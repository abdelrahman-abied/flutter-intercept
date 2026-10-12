/**
 * Host-side validation of everything the webview, agents and shared rules hand to the proxy (review #7,
 * QUALITY-1 Q3: moved out of controller.ts). The webview is ours, but the host must never persist or apply a malformed
 * rule (a rule without `match` must not become match-all) nor forward an edit the proxy would turn into a broken
 * response for the app. Pure: no vscode.
 */
import type { GrpcEdit, GrpcPause, RequestEdit, ResponseEdit, Rule, RuleAction } from '@flutter-intercept/proxy';
import type { NetworkProfile } from '@flutter-intercept/proxy/network';
import { grpcEditProblem, ruleProblem } from '@flutter-intercept/proxy/rules';
import { pathError } from '../agent/paths';
import {
  GRPC_CALL_RESERVED,
  GRPC_HOOK_CAP_BYTES,
  GRPC_MOCK_RESERVED,
  GRPC_REWRITE_RESERVED,
  GRPC_SEND_MAX_BYTES,
  GRPC_SEND_MAX_MESSAGES,
  GRPC_TRAILER_RESERVED,
  mapTargetProblem,
  MAX_MUTATE_OPS,
  MAX_REWRITE_HEADERS,
  MAX_REWRITE_REPLACEMENTS,
  MAX_SCRIPT_BYTES,
  MAX_SEQUENCE_STEPS,
  metadataValueProblem,
} from '@flutter-intercept/proxy/grpc-meta';
import { grpcMethodFromGlob, grpcMethodPath } from '../grpc/service';
import { scriptFileSyntaxError } from '../rules/scriptFile';
import type { SendDraft } from './protocol';

/** Limits shared with the proxy and the agents (one definition, `@flutter-intercept/proxy/grpc-meta`). */
export { MAX_MUTATE_OPS, MAX_REWRITE_HEADERS, MAX_REWRITE_REPLACEMENTS, MAX_SCRIPT_BYTES, MAX_SEQUENCE_STEPS };

/** REVIEW-7 #6: an optional rule id on a view message. */
export function checkRuleId(v: unknown, where: string): string | undefined {
  if (v === undefined) return undefined;
  if (typeof v !== 'string' || !v || v.length > 200) fail(where, 'ruleId must be a rule id');
  return v;
}

export const FAULTS = new Set(['reset', 'timeout', 'truncate', 'dns']);
export const PRESET_IDS = new Set(['slow-3g', 'fast-3g', 'flaky']);

export class InvalidMessageError extends Error {}

export const MAX_RULES = 1000;
export const MAX_TEXT = 64 * 1024 * 1024; // bodies (well above the proxy's 5 MB body cap)
export const TOKEN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/; // RFC 9110 token (header names, methods)

export function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export function fail(where: string, what: string): never {
  throw new InvalidMessageError(`${where}: ${what}`);
}

export function onlyKeys(o: Record<string, unknown>, allowed: string[], where: string): void {
  for (const k of Object.keys(o)) if (!allowed.includes(k)) fail(where, `unknown field "${k}"`);
}

export function checkStatus(v: unknown, where: string): number {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 100 || v > 599) fail(where, 'status must be an integer 100–599');
  return v;
}

export function checkHeaderValue(v: unknown, where: string): void {
  if (typeof v !== 'string') fail(where, 'header values must be strings');
  if (/[\r\n\0]/.test(v)) fail(where, 'header values must not contain CR, LF or NUL');
}

/** `Record<string, string>` (mock headers) or, with `multi`, `Record<string, string | string[]>` (edits). */
export function checkHeaders(v: unknown, where: string, multi: boolean): void {
  if (!isObj(v)) fail(where, 'headers must be an object');
  for (const [name, value] of Object.entries(v)) {
    if (!TOKEN.test(name)) fail(where, `invalid header name "${name}"`);
    if (multi && Array.isArray(value)) value.forEach((x) => checkHeaderValue(x, `${where} "${name}"`));
    else checkHeaderValue(value, `${where} "${name}"`);
  }
}

export function isInt(v: unknown, min: number, max: number): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max;
}

export function isNum(v: unknown, min: number, max: number): v is number {
  return typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max;
}

/** latencyMs 0–600000 (integer), kbps / uploadKbps (CONTRACTS §14.4) 1–10 000 000, dropRate 0–1; each optional. */
export function checkThrottle(a: Record<string, unknown>, where: string): void {
  if (a.latencyMs !== undefined && !isInt(a.latencyMs, 0, 600_000)) fail(where, 'latencyMs must be an integer 0–600000');
  if (a.kbps !== undefined && !isNum(a.kbps, 1, 10_000_000)) fail(where, 'kbps must be a number 1–10000000');
  if (a.uploadKbps !== undefined && !isNum(a.uploadKbps, 1, 10_000_000)) fail(where, 'uploadKbps must be a number 1–10000000');
  if (a.dropRate !== undefined && !isNum(a.dropRate, 0, 1)) fail(where, 'dropRate must be a number 0–1');
}

export function checkUrl(v: unknown, where: string): string {
  if (typeof v !== 'string') fail(where, 'url must be a string');
  let u: URL;
  try {
    u = new URL(v);
  } catch {
    fail(where, `url must be absolute: ${v}`);
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') fail(where, 'url must be http(s)');
  return v;
}

export function checkBody(v: unknown, where: string): void {
  if (typeof v !== 'string') fail(where, 'body must be a string');
  if (v.length > MAX_TEXT) fail(where, 'body is too large');
}

export const MAX_MUTATE_VALUE_CHARS = 1024 * 1024;
export const MUTATE_OPS = new Set(['null', 'delete', 'set']);

/**
 * CONTRACTS §10.2: 1–20 ops; path valid (jsonpath.ts), op null|delete|set; `set` needs `value` (a JSON value) or
 * `valueJson` (JSON text, byte-exact, wins over `value`), each ≤ 1 MB.
 */
export function checkMutateOps(ops: unknown, where: string): void {
  if (!Array.isArray(ops) || ops.length < 1 || ops.length > MAX_MUTATE_OPS) fail(where, `ops must be a list of 1–${MAX_MUTATE_OPS} changes`);
  ops.forEach((op, i) => {
    const ow = `${where}.ops[${i}]`;
    if (!isObj(op)) fail(ow, 'must be an object');
    onlyKeys(op, ['path', 'op', 'value', 'valueJson'], ow);
    const bad = pathError(op.path);
    if (bad) fail(ow, bad);
    if (typeof op.op !== 'string' || !MUTATE_OPS.has(op.op)) fail(ow, 'op must be "null", "delete" or "set"');
    if (op.op !== 'set') {
      if (op.value !== undefined || op.valueJson !== undefined) fail(ow, `value / valueJson are only used with op "set"`);
      return;
    }
    if (op.valueJson !== undefined) {
      if (typeof op.valueJson !== 'string') fail(ow, 'valueJson must be a string of JSON text');
      if (op.valueJson.length > MAX_MUTATE_VALUE_CHARS) fail(ow, 'valueJson must be at most 1 MB');
      try {
        JSON.parse(op.valueJson);
      } catch {
        fail(ow, 'valueJson must be valid JSON text (e.g. "1.0", "12345678901234567890", "\\"text\\"")');
      }
    }
    if (op.value === undefined) {
      if (op.valueJson === undefined) fail(ow, 'op "set" needs a value (or valueJson)');
      return;
    }
    let text: string | undefined;
    try {
      text = JSON.stringify(op.value);
    } catch {
      text = undefined;
    }
    if (typeof text !== 'string' || !isJsonValue(op.value)) fail(ow, 'value must be a JSON value (string, number, boolean, null, array or object)');
    if (text.length > MAX_MUTATE_VALUE_CHARS) fail(ow, 'value must be at most 1 MB as JSON');
  });
}

/** Plain JSON only: no functions, symbols, bigints, NaN/Infinity, class instances or cycles (depth ≤ 200). */
export function isJsonValue(v: unknown, depth = 0): boolean {
  if (depth > 200) return false;
  if (v === null || typeof v === 'string' || typeof v === 'boolean') return true;
  if (typeof v === 'number') return Number.isFinite(v);
  if (Array.isArray(v)) return v.every((x) => isJsonValue(x, depth + 1));
  if (typeof v === 'object') {
    const proto = Object.getPrototypeOf(v);
    if (proto !== Object.prototype && proto !== null) return false;
    return Object.values(v as Record<string, unknown>).every((x) => isJsonValue(x, depth + 1));
  }
  return false;
}

export function validateRule(raw: unknown, where = 'rule'): Rule {
  if (!isObj(raw)) fail(where, 'must be an object');
  // `used` is display-only (CONTRACTS §9.2 rule-hit): accepted so the webview can round-trip rules, then dropped.
  onlyKeys(raw, ['id', 'enabled', 'name', 'match', 'action', 'times', 'expiresAt', 'used', 'shared'], where);
  if (typeof raw.id !== 'string' || !raw.id.trim() || raw.id.length > 200) fail(where, 'id must be a non-empty string');
  if (typeof raw.enabled !== 'boolean') fail(where, 'enabled must be a boolean');
  if (raw.name !== undefined && (typeof raw.name !== 'string' || raw.name.length > 500)) fail(where, 'name must be a string');
  if (raw.times !== undefined && !isInt(raw.times, 1, 1000)) fail(where, 'times must be an integer 1–1000');
  if (raw.expiresAt !== undefined && (typeof raw.expiresAt !== 'number' || !Number.isFinite(raw.expiresAt) || raw.expiresAt <= 0)) {
    fail(where, 'expiresAt must be a time in epoch milliseconds');
  }
  // CONTRACTS §12.1: set by the shared-rules service (rules from .vscode/flutter-intercept.json).
  if (raw.shared !== undefined && raw.shared !== true) fail(where, 'shared must be true or absent');
  const m = raw.match;
  if (!isObj(m)) fail(where, 'match is required (a rule without match would match everything)');
  onlyKeys(m, ['url', 'method', 'graphqlOperation'], `${where}.match`);
  if (typeof m.url !== 'string' || !m.url.trim() || m.url.length > 8192) fail(`${where}.match`, 'url must be a non-empty string (use "*" to match everything)');
  if (m.method !== undefined && (typeof m.method !== 'string' || (m.method !== '' && m.method !== '*' && !TOKEN.test(m.method)))) {
    fail(`${where}.match`, 'method must be an HTTP method name');
  }
  if (m.graphqlOperation !== undefined && (typeof m.graphqlOperation !== 'string' || m.graphqlOperation.length > 200 || !GRAPHQL_NAME.test(m.graphqlOperation))) {
    fail(`${where}.match`, 'graphqlOperation must be a GraphQL operation name (letters, digits, _; not starting with a digit; at most 200)');
  }
  const action = validateAction(raw.action, `${where}.action`, false);
  const out: Record<string, unknown> = { ...raw, action };
  delete out.used;
  // CONTRACTS §11.1 / REVIEW-5 #16: refuse rules the proxy can never apply (e.g. a mock or a truncate fault on a
  // ws:// URL, a GraphQL operation on a WebSocket upgrade, a script on a WebSocket). CONTRACTS §13.4: a script whose
  // `file` supplies the code is checked as if it had code (the host reads the file before the proxy gets it).
  const probe =
    action.kind === 'script' && action.file !== undefined && !action.code.trim() ? { ...out, action: { ...action, code: '/* read from file */' } } : out;
  const problem = ruleProblem(probe as unknown as Rule) ?? grpcRewriteProblem(out as unknown as Rule);
  if (problem) fail(where, problem);
  return out as unknown as Rule;
}

/** CONTRACTS §12.6: rewrite limits (step / header / replacement counts come from grpc-meta). */
export const MAX_REWRITE_FIND = 10 * 1024;
/** REVIEW-6 #3: each replacement text, and all find + replace texts of one rule together (the proxy also caps the output). */
export const MAX_REWRITE_REPLACE = 64 * 1024;
export const MAX_REWRITE_TEXT_TOTAL = 256 * 1024;
/** CONTRACTS §12.2: `mock.bodyFile` length. */
export const MAX_BODY_FILE_PATH = 300;
export const SEQUENCE_THEN = new Set(['last', 'passthrough', 'loop']);
/** Headers a rewrite may not set on the request: framing and hop-by-hop ones the proxy owns, and the proxy's credential. */
export const REWRITE_REQUEST_FORBIDDEN = new Set(['host', 'content-length', 'transfer-encoding', 'connection', 'keep-alive', 'proxy-connection', 'proxy-authorization', 'te', 'trailer', 'upgrade', 'x-fi-id']);
export const REWRITE_RESPONSE_FORBIDDEN = new Set(['content-length', 'transfer-encoding', 'connection', 'keep-alive', 'trailer', 'upgrade']);

/**
 * One rule action. Inside a sequence step (`inStep`), `{kind:'passthrough'}` is allowed and `breakpoint` /
 * `sequence` are not (CONTRACTS §12.3). Returns a copy (mock `body` defaults to "" when `bodyFile` is given).
 */
export function validateAction(a: unknown, aw: string, inStep: boolean): RuleAction {
  if (!isObj(a)) fail(aw.replace(/\.action$/, ''), 'action is required');
  switch (a.kind) {
    case 'mock': {
      onlyKeys(a, ['kind', 'status', 'headers', 'body', 'delayMs', 'bodyFile'], aw);
      checkStatus(a.status, aw);
      if (a.headers !== undefined) checkHeaders(a.headers, aw, false);
      if (a.bodyFile !== undefined) checkBodyFile(a.bodyFile, aw);
      if (a.body !== undefined || a.bodyFile === undefined) checkBody(a.body, aw);
      if (a.delayMs !== undefined && (typeof a.delayMs !== 'number' || !Number.isInteger(a.delayMs) || a.delayMs < 0 || a.delayMs > 600_000)) {
        fail(aw, 'delayMs must be an integer 0–600000');
      }
      return { ...a, body: (a.body as string | undefined) ?? '' } as RuleAction;
    }
    case 'block':
      onlyKeys(a, ['kind', 'mode', 'status'], aw);
      if (a.mode !== 'reset' && a.mode !== 'status') fail(aw, 'mode must be "reset" or "status"');
      if (a.status !== undefined) checkStatus(a.status, aw);
      break;
    case 'breakpoint':
      if (inStep) fail(aw, 'a sequence step cannot be a breakpoint');
      onlyKeys(a, ['kind', 'phase'], aw);
      if (a.phase !== 'request' && a.phase !== 'response' && a.phase !== 'both') fail(aw, 'phase must be "request", "response" or "both"');
      break;
    case 'throttle':
      onlyKeys(a, ['kind', 'latencyMs', 'kbps', 'uploadKbps', 'dropRate'], aw);
      checkThrottle(a, aw);
      break;
    case 'fault':
      onlyKeys(a, ['kind', 'fault'], aw);
      if (typeof a.fault !== 'string' || !FAULTS.has(a.fault)) fail(aw, 'fault must be "reset", "timeout", "truncate" or "dns"');
      break;
    case 'mutate':
      onlyKeys(a, ['kind', 'ops'], aw);
      checkMutateOps(a.ops, aw);
      break;
    case 'cors':
      onlyKeys(a, ['kind', 'allowOrigin', 'allowCredentials'], aw);
      if (typeof a.allowOrigin === 'string' && a.allowOrigin.trim().toLowerCase() === 'null') {
        fail(aw, 'allowOrigin "null" is refused: sandboxed frames and file pages send it, so it would let any of them read the responses');
      }
      if (a.allowOrigin !== undefined && !isAllowOrigin(a.allowOrigin)) {
        fail(aw, 'allowOrigin must be "*" or one origin such as "http://localhost:5000" (at most 500 characters, no spaces or commas)');
      }
      if (a.allowCredentials !== undefined && typeof a.allowCredentials !== 'boolean') fail(aw, 'allowCredentials must be a boolean');
      if (a.allowOrigin === '*' && a.allowCredentials === true) {
        fail(aw, 'allowOrigin "*" cannot be combined with allowCredentials: browsers reject credentials with a wildcard origin (omit allowOrigin to echo the request\'s Origin)');
      }
      break;
    case 'passthrough':
      if (!inStep) fail(aw, '"passthrough" is only a sequence step (a rule that changes nothing)');
      onlyKeys(a, ['kind'], aw);
      break;
    case 'sequence': {
      if (inStep) fail(aw, 'a sequence step cannot be another sequence');
      onlyKeys(a, ['kind', 'steps', 'then'], aw);
      if (!Array.isArray(a.steps) || a.steps.length < 1 || a.steps.length > MAX_SEQUENCE_STEPS) fail(aw, `steps must be a list of 1–${MAX_SEQUENCE_STEPS} steps`);
      if (a.then !== undefined && (typeof a.then !== 'string' || !SEQUENCE_THEN.has(a.then))) fail(aw, 'then must be "last", "passthrough" or "loop"');
      const steps = a.steps.map((step, i) => {
        const sw = `${aw}.steps[${i}]`;
        if (!isObj(step)) fail(sw, 'must be an object {action, count?}');
        onlyKeys(step, ['action', 'count'], sw);
        if (step.count !== undefined && !isInt(step.count, 1, 1000)) fail(sw, 'count must be an integer 1–1000');
        return { ...step, action: validateAction(step.action, `${sw}.action`, true) };
      });
      return { ...a, steps } as unknown as RuleAction;
    }
    case 'mapRemote': {
      onlyKeys(a, ['kind', 'to', 'preserveHost'], aw);
      checkMapTarget(a.to, aw);
      if (a.preserveHost !== undefined && typeof a.preserveHost !== 'boolean') fail(aw, 'preserveHost must be a boolean');
      break;
    }
    case 'rewrite': {
      onlyKeys(a, ['kind', 'request', 'response'], aw);
      if (a.request === undefined && a.response === undefined) fail(aw, 'a rewrite needs request and/or response changes');
      let text = 0;
      if (a.request !== undefined) text += checkRewriteSpec(a.request, `${aw}.request`, 'request');
      if (a.response !== undefined) text += checkRewriteSpec(a.response, `${aw}.response`, 'response');
      if (text > MAX_REWRITE_TEXT_TOTAL) fail(aw, 'the find and replace texts of one rewrite must total at most 256 KB');
      break;
    }
    case 'grpcMock':
      checkGrpcMock(a, aw);
      return { ...a } as unknown as RuleAction;
    case 'script': {
      // CONTRACTS §13.4: never inside a sequence; `code` may be empty when `file` supplies it (read by the host).
      if (inStep) fail(aw, 'a sequence step cannot be a script');
      onlyKeys(a, ['kind', 'code', 'file'], aw);
      if (a.file !== undefined) checkScriptFile(a.file, aw);
      if (a.code !== undefined && typeof a.code !== 'string') fail(aw, 'code must be a string (the JavaScript source)');
      if (a.code === undefined && a.file === undefined) fail(aw, 'a script needs code or a file');
      if (a.file === undefined && typeof a.code === 'string' && !a.code.trim()) fail(aw, 'a script needs code (define onRequest and / or onResponse) or a file');
      if (typeof a.code === 'string' && Buffer.byteLength(a.code, 'utf8') > MAX_SCRIPT_BYTES) fail(aw, 'code must be at most 256 KB');
      return { ...a, code: (a.code as string | undefined) ?? '' } as RuleAction;
    }
    default:
      fail(aw, `unknown kind ${JSON.stringify(a.kind)}`);
  }
  return { ...a } as unknown as RuleAction;
}

/** CONTRACTS §16.2: grpcMock limits. */
export const MAX_GRPC_MOCK_MESSAGES = 1000;
export const MAX_GRPC_MOCK_BYTES = 4 * 1024 * 1024;
export const MAX_GRPC_MESSAGE_TEXT = 4096;
export const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

/**
 * CONTRACTS §16.2 / §16.8: `grpcMock` — code an integer 0–16, message ≤ 4 KB, `messages` (base64 protobuf
 * payloads) or `messagesJson` (JSON values the host encodes with the app's schema), not both, ≤ 1000 and ≤ 4 MB together;
 * headers / trailers without pseudo headers, content-type, grpc-status / grpc-message or connection headers; delayMs /
 * gapMs 0–600000.
 */
export function checkGrpcMock(a: Record<string, unknown>, aw: string): void {
  onlyKeys(a, ['kind', 'code', 'message', 'messages', 'messagesJson', 'headers', 'trailers', 'delayMs', 'gapMs'], aw);
  if (a.code !== undefined && !isInt(a.code, 0, 16)) fail(aw, 'code must be a gRPC status code (an integer 0–16, e.g. 14 = UNAVAILABLE)');
  if (a.message !== undefined && (typeof a.message !== 'string' || a.message.length > MAX_GRPC_MESSAGE_TEXT)) fail(aw, `message must be text of at most ${MAX_GRPC_MESSAGE_TEXT} characters`);
  if (a.messages !== undefined && a.messagesJson !== undefined) fail(aw, 'pass messages (base64) or messagesJson (JSON), not both');
  let bytes = 0;
  if (a.messages !== undefined) {
    if (!Array.isArray(a.messages) || a.messages.length > MAX_GRPC_MOCK_MESSAGES) fail(aw, `messages must be a list of at most ${MAX_GRPC_MOCK_MESSAGES} base64 protobuf payloads`);
    a.messages.forEach((m, i) => {
      if (typeof m !== 'string' || !BASE64.test(m)) fail(aw, `messages[${i}] must be base64 (a serialized protobuf message)`);
      bytes += m.length;
    });
  }
  if (a.messagesJson !== undefined) {
    if (!Array.isArray(a.messagesJson) || a.messagesJson.length > MAX_GRPC_MOCK_MESSAGES) fail(aw, `messagesJson must be a list of at most ${MAX_GRPC_MOCK_MESSAGES} JSON messages`);
    a.messagesJson.forEach((m, i) => {
      if (!isJsonValue(m)) fail(aw, `messagesJson[${i}] must be a JSON value`);
      bytes += JSON.stringify(m).length;
    });
  }
  if (bytes > MAX_GRPC_MOCK_BYTES) fail(aw, 'the messages must total at most 4 MB');
  for (const side of ['headers', 'trailers'] as const) {
    if (a[side] === undefined) continue;
    checkHeaders(a[side], `${aw}.${side}`, false);
    for (const name of Object.keys(a[side] as object)) {
      const n = name.toLowerCase();
      if (n.startsWith(':') || GRPC_MOCK_RESERVED.has(n)) fail(`${aw}.${side}`, `"${name}" can't be set by a gRPC mock (the proxy sets it; use code / message for the status)`);
    }
  }
  for (const k of ['delayMs', 'gapMs'] as const) if (a[k] !== undefined && !isInt(a[k], 0, 600_000)) fail(aw, `${k} must be an integer 0–600000`);
}

/** CONTRACTS §17.2 / §17.7: the largest replacement message (decoded bytes) and its base64 length. */
export const MAX_GRPC_EDIT_B64 = 4 * Math.ceil(GRPC_HOOK_CAP_BYTES / 3);

/**
 * CONTRACTS §17.2: a `resume` edit for a paused gRPC call. A message pause takes exactly one of `message` (base64, ≤ 4 MB),
 * `messageJson` (a JSON value, ≤ 4 MB as text; the host encodes it) or `drop: true`; a status pause takes `status`
 * ({code 0–16, message ≤ 4 KB}) and optional custom `trailers` (no pseudo, content-type, grpc-status / grpc-message or
 * connection headers). Empty / undefined = resume unchanged. Throws InvalidMessageError.
 */
export function validateGrpcEdit(raw: unknown, pause: GrpcPause | undefined): GrpcEdit | undefined {
  const edit = checkGrpcEdit(raw, pause);
  // The proxy's own rules (packages/proxy rules.ts), so host and proxy never disagree; messageJson is resolved later.
  if (edit && pause && edit.messageJson === undefined) {
    const problem = grpcEditProblem(pause.kind, edit);
    if (problem) fail('edit', problem);
  }
  return edit;
}

export function checkGrpcEdit(raw: unknown, pause: GrpcPause | undefined): GrpcEdit | undefined {
  const where = 'edit';
  if (raw === undefined || raw === null) return undefined;
  if (!isObj(raw)) fail(where, 'must be an object');
  onlyKeys(raw, ['message', 'messageJson', 'drop', 'status', 'trailers'], where);
  if (!Object.keys(raw).length) return undefined;
  if (!pause) fail(where, 'the call is not held at a gRPC breakpoint');
  if (pause.kind === 'message') {
    if (raw.status !== undefined || raw.trailers !== undefined) fail(where, 'status and trailers only apply when the call is held at its end (status); this pause holds a message');
    const given = ['message', 'messageJson', 'drop'].filter((k) => raw[k] !== undefined);
    if (given.length !== 1) fail(where, 'pass exactly one of message (base64), messageJson or drop');
    if (raw.drop !== undefined) {
      if (raw.drop !== true) fail(where, 'drop must be true');
      return { drop: true };
    }
    if (raw.message !== undefined) {
      if (typeof raw.message !== 'string' || raw.message.length > MAX_GRPC_EDIT_B64 || !BASE64.test(raw.message)) fail(where, 'message must be base64 of a serialized protobuf message (at most 4 MB)');
      return { message: raw.message };
    }
    if (!isJsonValue(raw.messageJson)) fail(where, 'messageJson must be a JSON value');
    if (JSON.stringify(raw.messageJson).length > GRPC_HOOK_CAP_BYTES) fail(where, 'messageJson must be at most 4 MB as JSON');
    return { messageJson: raw.messageJson };
  }
  if (raw.message !== undefined || raw.messageJson !== undefined || raw.drop !== undefined) fail(where, 'message, messageJson and drop only apply to a held message; this pause holds the end of the call (edit status / trailers)');
  if (raw.status === undefined) fail(where, 'pass status {code, message?} (and optionally trailers)');
  const st = raw.status;
  if (!isObj(st)) fail(where, 'status must be an object {code, message?}');
  onlyKeys(st, ['code', 'message'], `${where}.status`);
  if (!isInt(st.code, 0, 16)) fail(`${where}.status`, 'code must be a gRPC status code (an integer 0–16)');
  if (st.message !== undefined && (typeof st.message !== 'string' || st.message.length > MAX_GRPC_MESSAGE_TEXT)) fail(`${where}.status`, `message must be text of at most ${MAX_GRPC_MESSAGE_TEXT} characters`);
  const out: GrpcEdit = { status: { code: st.code as number, ...(st.message !== undefined ? { message: st.message as string } : {}) } };
  if (raw.trailers !== undefined) {
    checkHeaders(raw.trailers, `${where}.trailers`, false);
    const names = Object.keys(raw.trailers as object);
    if (names.length > 100) fail(`${where}.trailers`, 'at most 100 trailers');
    for (const name of names) {
      const n = name.toLowerCase();
      if (n.startsWith(':') || GRPC_MOCK_RESERVED.has(n)) fail(`${where}.trailers`, `"${name}" can't be set (the proxy sets it; use status for the code and message)`);
    }
    out.trailers = { ...(raw.trailers as Record<string, string>) };
  }
  return out;
}

/** CONTRACTS §12.2: a workspace-relative path: no absolute path, drive, `..` segment or control characters; ≤ 300. */
export function checkBodyFile(v: unknown, where: string, field = 'bodyFile'): string {
  if (typeof v !== 'string' || !v.trim() || v.length > MAX_BODY_FILE_PATH) fail(where, `${field} must be a workspace-relative path (1–${MAX_BODY_FILE_PATH} characters)`);
  if (/[\0-\x1f]/.test(v)) fail(where, `${field} must not contain control characters`);
  if (/^[\\/]/.test(v) || /^[A-Za-z]:/.test(v) || /^~/.test(v)) fail(where, `${field} must be relative to the workspace folder (no absolute path)`);
  if (v.split(/[\\/]+/).some((seg) => seg === '..')) fail(where, `${field} must stay inside the workspace (no ".." segments)`);
  return v;
}

/**
 * CONTRACTS §13.4: `script.file` = a workspace-relative `.js` path (no absolute path, `..`, control characters; the
 * shared-rules service's `scriptFileSyntaxError`). The disk checks (inside the workspace, ≤ 256 KB) happen on read.
 */
export function checkScriptFile(v: unknown, where: string, field = 'file'): string {
  const p = checkBodyFile(v, where, field);
  const bad = scriptFileSyntaxError(p);
  if (bad) fail(where, `${field} ${bad}`);
  return p;
}

/** CONTRACTS §12.2: the most a new body file may hold (the proxy's body cap). */
export const MAX_BODY_FILE_BYTES = 5 * 1024 * 1024;

/**
 * CONTRACTS §12.6: `mapRemote.to` = absolute http(s) origin or URL prefix: grpc-meta's `mapTargetProblem` (no
 * credentials, ?query or #fragment, no whitespace or backslash, ≤ 2048), surrounding whitespace refused too.
 */
export function checkMapTarget(v: unknown, where = 'mapRemote'): URL {
  if (typeof v === 'string' && v !== v.trim()) fail(where, 'to must not contain whitespace');
  const bad = mapTargetProblem(v);
  if (bad) fail(where, bad);
  return new URL(v as string);
}

/** Validates one side of a rewrite; returns the total length of its find + replace texts. */
/** `-bin` metadata values must be base64 (grpc-meta's `metadataValueProblem`), CONTRACTS §18.1. */
function checkMetadataValue(name: string, value: unknown, where: string): void {
  const bad = metadataValueProblem(name, value);
  if (bad) fail(where, bad);
}

/** CONTRACTS §18.1: names a rewrite may not touch on a gRPC call (any side, set or remove). */
export function grpcMetadataNames(spec: Record<string, unknown> | undefined): string[] {
  if (!spec) return [];
  return [
    ...Object.keys(isObj(spec.setHeaders) ? spec.setHeaders : {}),
    ...(Array.isArray(spec.removeHeaders) ? (spec.removeHeaders as unknown[]).filter((x): x is string => typeof x === 'string') : []),
    ...Object.keys(isObj(spec.setTrailers) ? spec.setTrailers : {}),
    ...(Array.isArray(spec.removeTrailers) ? (spec.removeTrailers as unknown[]).filter((x): x is string => typeof x === 'string') : []),
  ];
}

/**
 * CONTRACTS §18.1: for a rule whose URL names a gRPC method, a rewrite may not set / remove `content-type` or `te`
 * either (reserved `grpc-*` names are refused for every rewrite in `checkRewriteSpec`). Undefined when fine.
 */
export function grpcRewriteProblem(rule: { match: { url: string }; action: RuleAction }): string | undefined {
  if (!grpcMethodFromGlob(rule.match.url)) return undefined;
  const visit = (a: RuleAction | { kind: 'passthrough' }): string | undefined => {
    if (a.kind === 'sequence') {
      for (const st of a.steps ?? []) {
        const r = visit(st.action as RuleAction);
        if (r) return r;
      }
      return undefined;
    }
    if (a.kind !== 'rewrite') return undefined;
    for (const name of [...grpcMetadataNames(a.request as Record<string, unknown> | undefined), ...grpcMetadataNames(a.response as Record<string, unknown> | undefined)]) {
      const n = name.toLowerCase();
      if (n.startsWith(':') || GRPC_CALL_RESERVED.has(n)) return `"${name}" can't be changed on a gRPC call (the proxy and the protocol own it)`;
    }
    return undefined;
  };
  return visit(rule.action);
}

export function checkRewriteSpec(raw: unknown, where: string, side: 'request' | 'response'): number {
  if (!isObj(raw)) fail(where, 'must be an object');
  onlyKeys(raw, side === 'response' ? ['setHeaders', 'removeHeaders', 'replaceBody', 'status', 'setTrailers', 'removeTrailers'] : ['setHeaders', 'removeHeaders', 'replaceBody'], where);
  if (side === 'response' && raw.status !== undefined) checkStatus(raw.status, where);
  const forbidden = side === 'request' ? REWRITE_REQUEST_FORBIDDEN : REWRITE_RESPONSE_FORBIDDEN;
  let headers = 0;
  if (raw.setHeaders !== undefined) {
    checkHeaders(raw.setHeaders, `${where}.setHeaders`, false);
    for (const [name, value] of Object.entries(raw.setHeaders as Record<string, unknown>)) {
      if (forbidden.has(name.toLowerCase())) fail(`${where}.setHeaders`, `"${name}" can't be set by a rewrite (the proxy manages it)`);
      if (GRPC_REWRITE_RESERVED.has(name.toLowerCase())) fail(`${where}.setHeaders`, `"${name}" can't be set by a rewrite (gRPC protocol metadata; change the status with a breakpoint, mutate or a script)`);
      checkMetadataValue(name, value, `${where}.setHeaders`);
      headers++;
    }
  }
  if (raw.removeHeaders !== undefined) {
    if (!Array.isArray(raw.removeHeaders)) fail(where, 'removeHeaders must be a list of header names');
    for (const name of raw.removeHeaders) {
      if (typeof name !== 'string' || !TOKEN.test(name)) fail(`${where}.removeHeaders`, `invalid header name ${JSON.stringify(name)}`);
      if (GRPC_REWRITE_RESERVED.has(name.toLowerCase())) fail(`${where}.removeHeaders`, `"${name}" can't be removed by a rewrite (gRPC protocol metadata)`);
      headers++;
    }
  }
  // CONTRACTS §18.1: gRPC trailers (custom metadata only; ignored for HTTP)
  if (raw.setTrailers !== undefined) {
    checkHeaders(raw.setTrailers, `${where}.setTrailers`, false);
    for (const [name, value] of Object.entries(raw.setTrailers as Record<string, unknown>)) {
      const n = name.toLowerCase();
      if (n.startsWith(':') || GRPC_TRAILER_RESERVED.has(n)) fail(`${where}.setTrailers`, `"${name}" can't be set as a trailer (the proxy sets it; change the status with a breakpoint, mutate or a script)`);
      checkMetadataValue(name, value, `${where}.setTrailers`);
      headers++;
    }
  }
  if (raw.removeTrailers !== undefined) {
    if (!Array.isArray(raw.removeTrailers)) fail(where, 'removeTrailers must be a list of trailer names');
    for (const name of raw.removeTrailers) {
      if (typeof name !== 'string' || !TOKEN.test(name)) fail(`${where}.removeTrailers`, `invalid trailer name ${JSON.stringify(name)}`);
      const n = name.toLowerCase();
      if (GRPC_TRAILER_RESERVED.has(n)) fail(`${where}.removeTrailers`, `"${name}" can't be removed (gRPC protocol metadata)`);
      headers++;
    }
  }
  if (headers > MAX_REWRITE_HEADERS) fail(where, `at most ${MAX_REWRITE_HEADERS} headers per side`);
  if (raw.replaceBody !== undefined) {
    if (!Array.isArray(raw.replaceBody) || raw.replaceBody.length > MAX_REWRITE_REPLACEMENTS) fail(where, `replaceBody must be a list of at most ${MAX_REWRITE_REPLACEMENTS} replacements`);
    raw.replaceBody.forEach((r, i) => {
      const rw = `${where}.replaceBody[${i}]`;
      if (!isObj(r)) fail(rw, 'must be an object {find, replace, all?}');
      onlyKeys(r, ['find', 'replace', 'all'], rw);
      if (typeof r.find !== 'string' || !r.find || r.find.length > MAX_REWRITE_FIND) fail(rw, 'find must be non-empty text of at most 10 KB');
      if (typeof r.replace !== 'string' || r.replace.length > MAX_REWRITE_REPLACE) fail(rw, 'replace must be text of at most 64 KB');
      if (r.all !== undefined && typeof r.all !== 'boolean') fail(rw, 'all must be a boolean');
    });
    return (raw.replaceBody as { find: string; replace: string }[]).reduce((n, r) => n + r.find.length + r.replace.length, 0);
  }
  return 0;
}

/**
 * CONTRACTS §12.3 "Expire token" preset: the next `count` matching requests get 401 {"error":"token_expired"},
 * then the real server answers. `url` is used as the rule's glob; an absolute URL without `*` becomes
 * origin + path + `*` (its query, which may hold secrets, is dropped).
 */
export function expireTokenRule(id: string, url: string, count: number, opts: { method?: string; namePrefix?: string } = {}): Rule {
  if (typeof url !== 'string' || !url.trim() || url.length > 8192) fail('expireToken', 'url must be a non-empty URL or URL glob');
  if (!isInt(count, 1, 1000)) fail('expireToken', 'count must be an integer 1–1000');
  let pattern = url.trim();
  if (!pattern.includes('*')) {
    try {
      const u = new URL(pattern);
      if (u.protocol === 'http:' || u.protocol === 'https:') pattern = `${u.origin}${u.pathname}*`;
    } catch {
      // a glob without * — used as is
    }
  }
  return {
    id,
    enabled: true,
    name: `${opts.namePrefix ?? ''}Expire token: ${opts.method ? `${opts.method.toUpperCase()} ` : ''}${pattern}`.slice(0, 500),
    match: { url: pattern, ...(opts.method ? { method: opts.method.toUpperCase() } : {}) },
    action: {
      kind: 'sequence',
      steps: [
        { action: { kind: 'mock', status: 401, headers: { 'content-type': 'application/json' }, body: '{"error":"token_expired"}' }, count },
        { action: { kind: 'passthrough' } },
      ],
      then: 'last',
    },
  };
}

/** GraphQL Name (spec §2.1.9). */
export const GRAPHQL_NAME = /^[_A-Za-z][_0-9A-Za-z]*$/;

/** `*`, or one serialized origin / token-ish value: printable, no whitespace or commas (a header value), ≤ 500. */
export function isAllowOrigin(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0 && v.length <= 500 && /^[\x21-\x7e]+$/.test(v) && !v.includes(',');
}

export function validateRules(raw: unknown): Rule[] {
  if (!Array.isArray(raw)) fail('setRules', 'rules must be an array');
  if (raw.length > MAX_RULES) fail('setRules', `at most ${MAX_RULES} rules`);
  const ids = new Set<string>();
  return raw.map((r, i) => {
    const rule = validateRule(r, `rule ${i + 1}`);
    if (ids.has(rule.id)) fail(`rule ${i + 1}`, `duplicate id "${rule.id}"`);
    ids.add(rule.id);
    return rule;
  });
}

/**
 * Validates a resume edit. `phase` (from the paused exchange) narrows the allowed fields:
 * a paused request accepts method/url/headers/body, a paused response status/headers/body.
 */
export function validateEdit(raw: unknown, phase?: 'request' | 'response'): RequestEdit | ResponseEdit | undefined {
  if (raw === undefined || raw === null) return undefined;
  const where = 'edit';
  if (!isObj(raw)) fail(where, 'must be an object');
  const allowed = phase === 'request' ? ['method', 'url', 'headers', 'body'] : phase === 'response' ? ['status', 'headers', 'body'] : ['method', 'url', 'status', 'headers', 'body'];
  onlyKeys(raw, allowed, where);
  if (raw.method !== undefined && (typeof raw.method !== 'string' || !TOKEN.test(raw.method))) fail(where, 'method must be an HTTP method name');
  if (raw.url !== undefined) checkUrl(raw.url, where);
  if (raw.status !== undefined) checkStatus(raw.status, where);
  if (raw.headers !== undefined) checkHeaders(raw.headers, where, true);
  if (raw.body !== undefined) checkBody(raw.body, where);
  return raw as RequestEdit | ResponseEdit;
}

/** Headers `send` never forwards: framing the proxy recomputes, hop-by-hop, and the proxy's own credential. */
export const SEND_DROPPED = new Set(['content-length', 'host', 'connection', 'keep-alive', 'proxy-connection', 'proxy-authorization', 'transfer-encoding', 'te', 'trailer', 'upgrade', 'x-fi-id']);

/** Drops framing / hop-by-hop / proxy headers from a request about to be sent again. */
export function sanitizeSendHeaders(h: Record<string, string | string[]> | undefined): Record<string, string | string[]> | undefined {
  if (!h) return h;
  const out: Record<string, string | string[]> = {};
  for (const [k, v] of Object.entries(h)) if (!SEND_DROPPED.has(k.toLowerCase()) && !k.startsWith(':')) out[k] = v;
  return out;
}

/** Validates the webview composer's request (CONTRACTS §9.3 `send`): method, absolute http(s) URL, headers, text body. */
export function validateSendDraft(raw: unknown): SendDraft {
  const where = 'send';
  if (!isObj(raw)) fail(where, 'request must be an object');
  onlyKeys(raw, ['method', 'url', 'headers', 'body', 'grpc'], where);
  if (typeof raw.method !== 'string' || !TOKEN.test(raw.method)) fail(where, 'method must be an HTTP method name');
  checkUrl(raw.url, where);
  if (raw.headers !== undefined) checkHeaders(raw.headers, where, true);
  if (raw.body !== undefined) checkBody(raw.body, where);
  const grpc = raw.grpc !== undefined ? checkSendGrpc(raw, where) : undefined;
  const headers = raw.headers !== undefined ? sanitizeSendHeaders(raw.headers as Record<string, string | string[]>) : undefined;
  return {
    method: raw.method.toUpperCase(),
    url: raw.url as string,
    ...(headers !== undefined ? { headers: grpc ? sanitizeGrpcSendHeaders(headers) : headers } : {}),
    ...(raw.body !== undefined ? { body: raw.body as string } : {}),
    ...(grpc ? { grpc } : {}),
  };
}

/** `send.grpc`: POST to a gRPC method URL, no body, exactly one of `messages` (base64) / `messagesJson`, within the caps. */
export function checkSendGrpc(raw: Record<string, unknown>, where: string): { messages?: string[]; messagesJson?: unknown[] } {
  const g = raw.grpc;
  if (!isObj(g)) fail(where, 'grpc must be an object {messages} or {messagesJson}');
  onlyKeys(g, ['messages', 'messagesJson'], `${where}.grpc`);
  if (String(raw.method).toUpperCase() !== 'POST') fail(where, 'a gRPC call is sent with method POST');
  if (raw.body !== undefined) fail(where, 'a gRPC call has no body: pass grpc.messages or grpc.messagesJson');
  if (!grpcMethodPath(String(raw.url))) fail(where, 'the URL of a gRPC call ends in /<package.Service>/<Method>');
  if ((g.messages === undefined) === (g.messagesJson === undefined)) fail(`${where}.grpc`, 'pass exactly one of messages (base64) or messagesJson');
  if (g.messages !== undefined) {
    if (!Array.isArray(g.messages) || g.messages.length > GRPC_SEND_MAX_MESSAGES) fail(`${where}.grpc`, `messages must be a list of at most ${GRPC_SEND_MAX_MESSAGES} base64 protobuf messages`);
    let total = 0;
    g.messages.forEach((m, i) => {
      if (typeof m !== 'string' || m.length > MAX_GRPC_EDIT_B64 || !BASE64.test(m)) fail(`${where}.grpc`, `messages[${i}] must be base64 of a serialized protobuf message (at most 4 MB)`);
      total += Math.floor((m.length * 3) / 4);
    });
    if (total > GRPC_SEND_MAX_BYTES) fail(`${where}.grpc`, 'the messages must total at most 16 MB');
    return { messages: [...(g.messages as string[])] };
  }
  if (!Array.isArray(g.messagesJson) || g.messagesJson.length > GRPC_SEND_MAX_MESSAGES) fail(`${where}.grpc`, `messagesJson must be a list of at most ${GRPC_SEND_MAX_MESSAGES} JSON messages`);
  let jsonTotal = 0;
  g.messagesJson.forEach((m, i) => {
    if (!isJsonValue(m)) fail(`${where}.grpc`, `messagesJson[${i}] must be a JSON value`);
    const n = JSON.stringify(m).length;
    if (n > GRPC_HOOK_CAP_BYTES) fail(`${where}.grpc`, `messagesJson[${i}] must be at most 4 MB as JSON`);
    jsonTotal += n;
  });
  // REVIEW-12 #4: bound the encoding work too (the encoded total is capped in resolveSendGrpc)
  if (jsonTotal > GRPC_SEND_MAX_BYTES * 2) fail(`${where}.grpc`, 'messagesJson must total at most 32 MB as JSON');
  return { messagesJson: [...(g.messagesJson as unknown[])] };
}

/** Request metadata a gRPC send never forwards (the proxy sets content-type / te / encodings itself, CONTRACTS §18.4). */
export const GRPC_SEND_DROPPED = new Set(['content-type', 'te', 'grpc-encoding', 'grpc-accept-encoding', 'content-encoding']);
export function sanitizeGrpcSendHeaders(h: Record<string, string | string[]>): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  for (const [k, v] of Object.entries(sanitizeSendHeaders(h) ?? {})) if (!GRPC_SEND_DROPPED.has(k.toLowerCase())) out[k] = v;
  return out;
}

/** Validates a network profile (CONTRACTS §9.2 network.ts). */
export function validateNetworkProfile(raw: unknown): NetworkProfile {
  const where = 'networkProfile';
  if (!isObj(raw)) fail(where, 'must be an object');
  switch (raw.kind) {
    case 'none':
    case 'offline':
      onlyKeys(raw, ['kind'], where);
      return { kind: raw.kind };
    case 'throttle':
      onlyKeys(raw, ['kind', 'preset', 'latencyMs', 'kbps', 'uploadKbps', 'dropRate'], where);
      if (raw.preset !== undefined && (typeof raw.preset !== 'string' || !PRESET_IDS.has(raw.preset))) fail(where, 'preset must be "slow-3g", "fast-3g" or "flaky"');
      checkThrottle(raw, where);
      return raw as unknown as NetworkProfile;
    default:
      return fail(where, `unknown kind ${JSON.stringify(raw.kind)}`);
  }
}

export function checkId(v: unknown, where: string): string {
  if (typeof v !== 'string' || !v) fail(where, 'id must be a non-empty string');
  return v;
}
