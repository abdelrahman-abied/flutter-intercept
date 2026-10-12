/** The rule editor form: action fields, validation, form ↔ rule. Split out of ../state.ts (QUALITY-1 Q6). */
import type { FaultKind, MutateOp } from '@flutter-intercept/proxy/types';
import { corsActionError } from '../coverage';
import { isBase64, looksLikeGrpcUrl, reservedGrpcHeader } from '../grpc';
import { checkPath } from '../jsonpath';
import type { Rule, RuleAction } from '../protocol';
import {
  bodyFileError, checkMapTarget, emptyRewriteForm, grpcRewriteError, MAX_STEPS, rewriteError, rewriteFromForm, rewriteToForm, sequencePreview,
  stepCountError, type PreviewStep, type RewriteForm, type SequenceThen, type StepAction, type StepKind,
} from '../scenarios';
import { scriptCodeError, scriptFileError, scriptMatchError } from '../scripts';
import { type JsonCheck, describeMatcherUrl, headerValue, isJsonContentType, newId, validateJson } from '../util';
import type { HeaderRow } from './core';
import { headersToRows, rowsToFlatRecord, rowsToRecord } from './drafts';
import { type ThrottleFields, checkThrottle, isInt, throttleFieldsOf } from './profile';

/**
 * The editable fields of one action, shared by the rule itself and by each `sequence` step (CONTRACTS §12.3):
 * the step editor reuses the rule's action editors.
 */
export interface ActionFields {
  mockStatus: string;
  mockHeaders: HeaderRow[];
  mockBody: string;
  mockDelayMs: string;
  /** CONTRACTS §12.2: the body comes from a workspace file (`mock.bodyFile`). */
  mockUseFile: boolean;
  mockBodyFile: string;
  blockMode: 'reset' | 'status';
  blockStatus: string;
  phase: 'request' | 'response' | 'both';
  throttle: ThrottleFields;
  fault: FaultKind;
  mutateOps: MutateRow[];
  corsOrigin: string;           // '' = echo the request's Origin
  corsCredentials: boolean;
  /** CONTRACTS §12.6 */
  mapTo: string;
  mapPreserveHost: boolean;
  rewrite: RewriteForm;
  /** CONTRACTS §13.4 (kind 'script'; not a sequence step). With `scriptUseFile`, the code lives in `scriptFile`. */
  scriptCode: string;
  scriptUseFile: boolean;
  scriptFile: string;
  /** CONTRACTS §16.2 (kind 'grpcMock'). `grpcCode` is the status code as text ('0'–'16'). */
  grpcCode: string;
  grpcMessage: string;
  /** json = each entry is a JSON object the host encodes with the app's schema (`messagesJson`); base64 = raw protobuf. */
  grpcMessagesMode: 'json' | 'base64';
  grpcMessages: string[];
  grpcDelayMs: string;
  grpcGapMs: string;
  grpcHeaders: HeaderRow[];
  grpcTrailers: HeaderRow[];
}

/** One `sequence` step: an action (or the real server) answering `count` matching requests. */
export interface StepForm extends ActionFields { kind: StepKind; count: string }

export interface RuleForm extends ActionFields {
  id: string;
  isNew: boolean;
  enabled: boolean;
  name: string;
  method: string;               // '' = any
  url: string;
  kind: RuleAction['kind'];
  /** CONTRACTS §11: '' = any operation. */
  graphqlOperation: string;
  times: string;                // '' = unlimited; 1–1000
  expiresIn: string;            // '' = never
  expiresUnit: ExpiryUnit;
  /** The rule's current expiresAt, kept as is until the user edits the "Expires in" field. */
  keepExpiresAt?: number;
  /** CONTRACTS §12.3 (kind 'sequence'). */
  steps: StepForm[];
  seqThen: SequenceThen;
}

/** One `mutate` op as the editor holds it: `value` is JSON text (used for `set` only). */
export interface MutateRow { path: string; op: MutateOp['op']; value: string }

export type ExpiryUnit = 's' | 'm' | 'h';
export const EXPIRY_UNIT_MS: Record<ExpiryUnit, number> = { s: 1000, m: 60_000, h: 3_600_000 };
export const MAX_EXPIRY_MS = 24 * 3_600_000;

export function defaultActionFields(): ActionFields {
  return {
    mockStatus: '200',
    mockHeaders: [{ name: 'content-type', value: 'application/json' }],
    mockBody: '{\n  \n}',
    mockDelayMs: '',
    mockUseFile: false,
    mockBodyFile: '',
    blockMode: 'reset',
    blockStatus: '403',
    phase: 'both',
    throttle: { latencyMs: '400', kbps: '', dropPct: '' },
    fault: 'reset',
    mutateOps: [{ path: '', op: 'null', value: '' }],
    corsOrigin: '',
    corsCredentials: false,
    mapTo: '',
    mapPreserveHost: false,
    rewrite: emptyRewriteForm(),
    scriptCode: '',
    scriptUseFile: false,
    scriptFile: '',
    grpcCode: '0',
    grpcMessage: '',
    grpcMessagesMode: 'json',
    grpcMessages: ['{}'],
    grpcDelayMs: '',
    grpcGapMs: '',
    grpcHeaders: [],
    grpcTrailers: [],
  };
}

export function newStep(kind: StepKind = 'mock', count = '1'): StepForm {
  return { ...defaultActionFields(), kind, count };
}

/** A new sequence: the first request fails with 500, then the real server answers. */
export function defaultSteps(): StepForm[] {
  return [{ ...newStep('mock'), mockStatus: '500', mockBody: '{"error":"server_error"}' }, newStep('passthrough')];
}

/** Copies an action's settings into the fields (the other fields keep their defaults). */
function fillActionFields<F extends ActionFields>(f: F, a: RuleAction | StepAction): F {
  if (a.kind === 'mock') {
    f.mockStatus = String(a.status);
    f.mockHeaders = headersToRows(a.headers);
    f.mockBody = a.body;
    f.mockDelayMs = a.delayMs ? String(a.delayMs) : '';
    if (a.bodyFile !== undefined) { f.mockUseFile = true; f.mockBodyFile = a.bodyFile; }
  } else if (a.kind === 'block') {
    f.blockMode = a.mode;
    if (a.status !== undefined) f.blockStatus = String(a.status);
  } else if (a.kind === 'breakpoint') {
    f.phase = a.phase;
  } else if (a.kind === 'throttle') {
    f.throttle = throttleFieldsOf(a);
  } else if (a.kind === 'fault') {
    f.fault = a.fault;
  } else if (a.kind === 'mutate') {
    // valueJson (byte-exact text) wins over value, like on the proxy.
    f.mutateOps = a.ops.map((o) => ({ path: o.path, op: o.op, value: o.op === 'set' ? o.valueJson ?? jsonText(o.value) : '' }));
  } else if (a.kind === 'cors') {
    f.corsOrigin = a.allowOrigin ?? '';
    f.corsCredentials = !!a.allowCredentials;
  } else if (a.kind === 'mapRemote') {
    f.mapTo = a.to;
    f.mapPreserveHost = !!a.preserveHost;
  } else if (a.kind === 'rewrite') {
    f.rewrite = rewriteToForm(a);
  } else if (a.kind === 'script') {
    f.scriptCode = a.code;
    if (a.file !== undefined) { f.scriptUseFile = true; f.scriptFile = a.file; }
  } else if (a.kind === 'grpcMock') {
    f.grpcCode = String(a.code ?? 0);
    f.grpcMessage = a.message ?? '';
    // messagesJson (what the user wrote) wins over the host-encoded messages, like mock.bodyFile over body.
    if (a.messagesJson) { f.grpcMessagesMode = 'json'; f.grpcMessages = a.messagesJson.map((m) => prettyJson(m)); }
    else if (a.messages) { f.grpcMessagesMode = 'base64'; f.grpcMessages = a.messages.slice(); }
    else { f.grpcMessagesMode = 'json'; f.grpcMessages = []; }
    f.grpcHeaders = headersToRows(a.headers);
    f.grpcTrailers = headersToRows(a.trailers);
    f.grpcDelayMs = a.delayMs ? String(a.delayMs) : '';
    f.grpcGapMs = a.gapMs ? String(a.gapMs) : '';
  }
  return f;
}

function prettyJson(v: unknown): string {
  try { return JSON.stringify(v, null, 2) ?? ''; } catch { return ''; }
}

export function ruleToForm(rule?: Rule, now = Date.now()): RuleForm {
  const f: RuleForm = {
    ...defaultActionFields(),
    id: rule?.id ?? newId('rule'),
    isNew: !rule,
    enabled: rule?.enabled ?? true,
    name: rule?.name ?? '',
    method: rule?.match.method?.toUpperCase() ?? '',
    url: rule?.match.url ?? '',
    kind: rule?.action.kind ?? 'mock',
    graphqlOperation: rule?.match.graphqlOperation ?? '',
    times: rule?.times !== undefined ? String(rule.times) : '',
    expiresIn: '',
    expiresUnit: 'm',
    steps: defaultSteps(),
    seqThen: 'last',
  };
  if (rule?.expiresAt !== undefined) {
    f.keepExpiresAt = rule.expiresAt;
    const left = rule.expiresAt - now;
    if (left > 0) f.expiresIn = String(Math.max(1, Math.ceil(left / 60_000)));
  }
  const a = rule?.action;
  if (a?.kind === 'sequence') {
    f.steps = a.steps.map((s) => fillActionFields(newStep(s.action.kind, String(s.count ?? 1)), s.action));
    f.seqThen = a.then ?? 'last';
  } else if (a) {
    fillActionFields(f, a);
  }
  return f;
}

export type RuleFormField =
  | 'url' | 'method' | 'mockStatus' | 'mockDelayMs' | 'blockStatus' | 'mockHeaders'
  | 'latencyMs' | 'kbps' | 'uploadKbps' | 'dropPct' | 'throttle' | 'times' | 'expiresIn' | 'mutate' | 'graphqlOperation' | 'cors'
  | 'mockBodyFile' | 'mapTo' | 'rewrite' | 'sequence' | 'count' | 'scriptCode' | 'scriptFile'
  | 'grpcCode' | 'grpcMessages' | 'grpcDelayMs' | 'grpcGapMs' | 'grpcHeaders' | 'grpcTrailers';

/** Validation of one action's fields (the rule's, or one sequence step's). */
export interface ActionValidation {
  errors: Partial<Record<RuleFormField, string>>;
  json?: JsonCheck;
  /** Per mutate row: what is wrong with it (path or value), if anything. */
  opErrors?: (string | undefined)[];
  /** kind 'grpcMock': per message entry, what is wrong with it, if anything. */
  grpcErrors?: (string | undefined)[];
}

export interface RuleFormValidation extends ActionValidation {
  urlHint: string;
  /** kind 'sequence': per step. */
  stepChecks?: ActionValidation[];
}

const isStatus = (s: string) => /^\d{3}$/.test(s.trim()) && +s >= 100 && +s <= 599;

/** Field errors of an action; `kind` is the rule's or the step's kind. */
export function validateActionFields(kind: RuleAction['kind'] | StepKind, f: ActionFields): ActionValidation {
  const errors: ActionValidation['errors'] = {};
  let json: JsonCheck | undefined;
  let opErrors: (string | undefined)[] | undefined;
  let grpcErrors: (string | undefined)[] | undefined;
  if (kind === 'cors') {
    const c = corsActionError(f.corsOrigin, f.corsCredentials);
    if (c) errors.cors = c;
  } else if (kind === 'mock') {
    if (!isStatus(f.mockStatus)) errors.mockStatus = '100–599';
    if (f.mockDelayMs.trim() && !/^\d+$/.test(f.mockDelayMs.trim())) errors.mockDelayMs = 'Milliseconds, whole number';
    if (f.mockHeaders.some((r) => r.name.trim() && !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(r.name.trim()))) {
      errors.mockHeaders = 'Invalid header name';
    }
    if (f.mockUseFile) {
      const e = bodyFileError(f.mockBodyFile);
      if (e) errors.mockBodyFile = e;
    } else {
      const ct = headerValue(rowsToRecord(f.mockHeaders), 'content-type');
      if (isJsonContentType(ct) && f.mockBody.trim()) json = validateJson(f.mockBody);
    }
  } else if (kind === 'block' && f.blockMode === 'status' && !isStatus(f.blockStatus)) {
    errors.blockStatus = '100–599';
  } else if (kind === 'throttle') {
    const t = checkThrottle(f.throttle);
    if (t.errors.latencyMs) errors.latencyMs = t.errors.latencyMs;
    if (t.errors.kbps) errors.kbps = t.errors.kbps;
    if (t.errors.uploadKbps) errors.uploadKbps = t.errors.uploadKbps;
    if (t.errors.dropPct) errors.dropPct = t.errors.dropPct;
    if (t.errors.all) errors.throttle = t.errors.all;
  } else if (kind === 'mutate') {
    opErrors = f.mutateOps.map(mutateRowError);
    const first = opErrors.findIndex(Boolean);
    if (!f.mutateOps.length) errors.mutate = 'Add at least one change.';
    else if (first >= 0) errors.mutate = `Change ${first + 1}: ${opErrors[first]}`;
  } else if (kind === 'mapRemote') {
    const m = checkMapTarget(f.mapTo);
    if (m.error) errors.mapTo = m.error;
  } else if (kind === 'rewrite') {
    const r = rewriteError(f.rewrite);
    if (r) errors.rewrite = r;
  } else if (kind === 'script') {
    const e = f.scriptUseFile ? scriptFileError(f.scriptFile) : scriptCodeError(f.scriptCode);
    if (e) errors[f.scriptUseFile ? 'scriptFile' : 'scriptCode'] = e;
  } else if (kind === 'grpcMock') {
    if (!/^\d{1,9}$/.test(f.grpcCode.trim())) errors.grpcCode = 'A gRPC status code, e.g. 0 (OK) or 14 (UNAVAILABLE)';
    if (f.grpcDelayMs.trim() && !/^\d+$/.test(f.grpcDelayMs.trim())) errors.grpcDelayMs = 'Delay: milliseconds, whole number';
    if (f.grpcGapMs.trim() && !/^\d+$/.test(f.grpcGapMs.trim())) errors.grpcGapMs = 'Gap: milliseconds, whole number';
    const h = grpcHeaderError(f.grpcHeaders, 'Header');
    if (h) errors.grpcHeaders = h;
    const t = grpcHeaderError(f.grpcTrailers, 'Trailer');
    if (t) errors.grpcTrailers = t;
    grpcErrors = f.grpcMessages.map((m) => grpcMessageError(m, f.grpcMessagesMode));
    const first = grpcErrors.findIndex(Boolean);
    if (first >= 0) errors.grpcMessages = `Message ${first + 1}: ${grpcErrors[first]}`;
  }
  return { errors, json, opErrors, grpcErrors };
}

/** Why a grpcMock message entry can't be saved, if it can't (empty entries are skipped). */
export function grpcMessageError(text: string, mode: ActionFields['grpcMessagesMode']): string | undefined {
  const t = text.trim();
  if (!t) return undefined;
  if (mode === 'base64') return isBase64(t) ? undefined : 'not valid base64 (A–Z, a–z, 0–9, +, /, = padding)';
  const j = validateJson(t);
  if (!j.ok) return `not valid JSON (line ${j.line}, column ${j.column}): ${j.message}`;
  if (!t.startsWith('{')) return 'a JSON object (one protobuf message), e.g. {"id": "42"}';
  return undefined;
}

export function grpcHeaderError(rows: HeaderRow[], what: 'Header' | 'Trailer'): string | undefined {
  for (const r of rows) {
    const n = r.name.trim();
    if (!n) { if (r.value.trim()) return `${what}: a value needs a name`; continue; }
    if (reservedGrpcHeader(n)) return `${what} “${n}” is set by the proxy (content-type, grpc-status, grpc-message and :pseudo headers can't be set)`;
    if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(n)) return `${what} name “${n}” is not valid`;
  }
  return undefined;
}

/** The first error of an action, as one line ("Status: 100–599"). */
export function firstActionError(v: ActionValidation): string | undefined {
  const e = v.errors;
  if (e.count) return e.count;
  if (e.mockStatus) return `Status: ${e.mockStatus}`;
  if (e.mockDelayMs) return `Delay: ${e.mockDelayMs}`;
  if (e.blockStatus) return `Status: ${e.blockStatus}`;
  const first = Object.values(e).find(Boolean);
  return first;
}

export function validateRuleForm(f: RuleForm): RuleFormValidation {
  let urlHint = 'Glob on the full URL — * matches any characters, e.g. https://api.example.com/users/*';
  const url = f.url.trim();
  const head: ActionValidation['errors'] = {};
  if (!url) head.url = 'Required. Use * to match every URL.';
  else {
    const p = describeMatcherUrl(url);
    if (p.kind === 'any') urlHint = 'Matches every URL.';
    else if (p.kind === 'regex') {
      if (p.error) head.url = `Invalid regular expression: ${p.error}`;
      else urlHint = `Regular expression /${p.source}/${p.flags} tested against the full URL (g/y flags ignored)`;
    } else if (!url.includes('*') && !/^https?:\/\//i.test(url)) {
      urlHint = 'Glob without * must equal the full URL (scheme included). Add * to match a prefix or part.';
    } else {
      urlHint = 'Case-sensitive glob on the full URL — * matches any characters, including /.';
    }
  }
  if (f.kind === 'script' && !head.url) {
    const w = scriptMatchError(url);
    if (w) head.url = w;
  }
  if (f.method.trim() && !/^[A-Za-z]+$/.test(f.method.trim())) head.method = 'Letters only, e.g. GET';
  const op = f.graphqlOperation.trim();
  if (op && !/^[_A-Za-z][_0-9A-Za-z]*$/.test(op)) head.graphqlOperation = 'A GraphQL operation name: letters, digits and _, e.g. getUser';

  // CONTRACTS §18.1: a rewrite on a gRPC URL can't touch the reserved metadata in its headers either.
  const grpcUrl = looksLikeGrpcUrl(url);
  const withGrpcRewrite = (kind: string, af: ActionFields, v: ActionValidation): ActionValidation => {
    if (kind !== 'rewrite' || !grpcUrl || v.errors.rewrite) return v;
    const e = grpcRewriteError(af.rewrite);
    return e ? { ...v, errors: { ...v.errors, rewrite: e } } : v;
  };
  const action = f.kind === 'sequence' ? { errors: {} } as ActionValidation : withGrpcRewrite(f.kind, f, validateActionFields(f.kind, f));
  const errors: RuleFormValidation['errors'] = { ...head, ...action.errors };
  let stepChecks: ActionValidation[] | undefined;
  if (f.kind === 'sequence') {
    stepChecks = f.steps.map((s) => {
      const v = withGrpcRewrite(s.kind, s, validateActionFields(s.kind, s));
      const c = stepCountError(s.count);
      return c ? { ...v, errors: { ...v.errors, count: c } } : v;
    });
    const bad = stepChecks.findIndex((v) => Object.keys(v.errors).length > 0);
    if (!f.steps.length) errors.sequence = 'Add at least one step.';
    else if (f.steps.length > MAX_STEPS) errors.sequence = `At most ${MAX_STEPS} steps.`;
    else if (bad >= 0) errors.sequence = `Step ${bad + 1}: ${firstActionError(stepChecks[bad])}`;
  }
  const times = f.times.trim();
  if (times && (!isInt(times) || +times < 1 || +times > 1000)) errors.times = 'Whole number 1–1000 (empty = every request)';
  const exp = f.expiresIn.trim();
  if (exp && f.keepExpiresAt === undefined) {
    const ms = Number(exp) * EXPIRY_UNIT_MS[f.expiresUnit];
    if (!/^\d+(\.\d+)?$/.test(exp) || !(ms >= 1000) || ms > MAX_EXPIRY_MS) errors.expiresIn = 'Between 1 second and 24 hours (empty = never)';
  }
  return { errors, urlHint, json: action.json, opErrors: action.opErrors, stepChecks };
}

/** Why a mutate row can't be saved, if it can't. */
export function mutateRowError(r: MutateRow): string | undefined {
  const p = checkPath(r.path);
  if (p) return `Path: ${p}`;
  if (r.op === 'set') {
    if (!r.value.trim()) return 'Value: enter JSON, e.g. "text", 42, null, {"a":1}';
    const j = validateJson(r.value);
    if (!j.ok) return `Value is not valid JSON (column ${j.column}): ${j.message}`;
  }
  return undefined;
}

/** JSON text for an editor field. */
export function jsonText(v: unknown): string {
  try { return JSON.stringify(v) ?? ''; } catch { return ''; }
}

/** The action the fields describe. `kind` 'sequence' is built by formToRule (it needs the steps). */
export function fieldsToAction(kind: Exclude<RuleAction['kind'], 'sequence'>, f: ActionFields): Exclude<RuleAction, { kind: 'sequence' }>;
export function fieldsToAction(kind: StepKind, f: ActionFields): StepAction;
export function fieldsToAction(kind: Exclude<RuleAction['kind'], 'sequence'> | StepKind, f: ActionFields): Exclude<RuleAction, { kind: 'sequence' }> | StepAction {
  switch (kind) {
    case 'mock': {
      const headers = rowsToFlatRecord(f.mockHeaders);
      const action: Extract<RuleAction, { kind: 'mock' }> = { kind: 'mock', status: Number(f.mockStatus), body: f.mockBody };
      if (Object.keys(headers).length) action.headers = headers;
      if (f.mockDelayMs.trim() && Number(f.mockDelayMs) > 0) action.delayMs = Number(f.mockDelayMs);
      if (f.mockUseFile && f.mockBodyFile.trim()) action.bodyFile = f.mockBodyFile.trim();
      return action;
    }
    case 'block':
      return f.blockMode === 'reset' ? { kind: 'block', mode: 'reset' } : { kind: 'block', mode: 'status', status: Number(f.blockStatus) };
    case 'throttle':
      return { kind: 'throttle', ...checkThrottle(f.throttle).value };
    case 'fault':
      return { kind: 'fault', fault: f.fault };
    case 'mutate':
      return {
        kind: 'mutate',
        // valueJson keeps the literal text (1.0 stays a double for Dart); value is for hosts without valueJson.
        ops: f.mutateOps.map((r): MutateOp => (r.op === 'set'
          ? { path: r.path.trim(), op: 'set', value: JSON.parse(r.value), valueJson: r.value.trim() }
          : { path: r.path.trim(), op: r.op })),
      };
    case 'cors': {
      const action: Extract<RuleAction, { kind: 'cors' }> = { kind: 'cors' };
      if (f.corsOrigin.trim()) action.allowOrigin = f.corsOrigin.trim();
      if (f.corsCredentials) action.allowCredentials = true;
      return action;
    }
    case 'mapRemote':
      return f.mapPreserveHost ? { kind: 'mapRemote', to: f.mapTo.trim(), preserveHost: true } : { kind: 'mapRemote', to: f.mapTo.trim() };
    case 'rewrite':
      return rewriteFromForm(f.rewrite);
    case 'script': {
      // File-backed: the host reads the file into `code` (like mock.bodyFile); the last known content travels along.
      const action: Extract<RuleAction, { kind: 'script' }> = { kind: 'script', code: f.scriptCode };
      if (f.scriptUseFile && f.scriptFile.trim()) action.file = f.scriptFile.trim();
      return action;
    }
    case 'passthrough':
      return { kind: 'passthrough' };
    case 'breakpoint':
      return { kind: 'breakpoint', phase: f.phase };
    case 'grpcMock': {
      const action: Extract<RuleAction, { kind: 'grpcMock' }> = { kind: 'grpcMock', code: Number(f.grpcCode.trim() || '0') };
      if (f.grpcMessage.trim()) action.message = f.grpcMessage.trim();
      const entries = f.grpcMessages.map((m) => m.trim()).filter(Boolean);
      // JSON entries are encoded by the host (`messagesJson`, like mock.bodyFile); base64 entries go as they are.
      if (entries.length) {
        if (f.grpcMessagesMode === 'json') action.messagesJson = entries.map((m) => JSON.parse(m) as unknown);
        else action.messages = entries.map((m) => m.replace(/\s+/g, ''));
      }
      const headers = rowsToFlatRecord(f.grpcHeaders);
      if (Object.keys(headers).length) action.headers = headers;
      const trailers = rowsToFlatRecord(f.grpcTrailers);
      if (Object.keys(trailers).length) action.trailers = trailers;
      if (f.grpcDelayMs.trim() && Number(f.grpcDelayMs) > 0) action.delayMs = Number(f.grpcDelayMs);
      if (f.grpcGapMs.trim() && Number(f.grpcGapMs) > 0) action.gapMs = Number(f.grpcGapMs);
      return action;
    }
  }
}

/** The sequence preview line for the editor; steps that don't validate yet still get a label. */
export function stepsPreview(steps: StepForm[], then: SequenceThen): string {
  return sequencePreview(steps.map((s): PreviewStep => {
    const count = /^\d+$/.test(s.count.trim()) && +s.count > 0 ? +s.count : 1;
    if (s.kind === 'mock') return { action: { kind: 'passthrough' }, count, label: isStatus(s.mockStatus) ? s.mockStatus.trim() : '?' };
    if (s.kind === 'mutate') return { action: { kind: 'mutate', ops: [] }, count };
    // Only the code matters for the label: the messages may not parse yet.
    if (s.kind === 'grpcMock') return { action: { kind: 'grpcMock', code: /^\d+$/.test(s.grpcCode.trim()) ? +s.grpcCode : 0 }, count };
    return { action: fieldsToAction(s.kind, s), count };
  }), then);
}

export function formToRule(f: RuleForm, now = Date.now()): Rule {
  const action: RuleAction = f.kind === 'sequence'
    ? {
      kind: 'sequence',
      steps: f.steps.map((s) => ({ action: fieldsToAction(s.kind, s), count: s.count.trim() ? Number(s.count.trim()) : 1 })),
      ...(f.seqThen !== 'last' ? { then: f.seqThen } : {}),
    }
    : fieldsToAction(f.kind, f);
  const rule: Rule = { id: f.id, enabled: f.enabled, match: { url: f.url.trim() }, action };
  if (f.name.trim()) rule.name = f.name.trim();
  if (f.method.trim()) rule.match.method = f.method.trim().toUpperCase();
  if (f.graphqlOperation.trim()) rule.match.graphqlOperation = f.graphqlOperation.trim();
  if (f.times.trim()) rule.times = Number(f.times.trim());
  if (f.keepExpiresAt !== undefined) rule.expiresAt = f.keepExpiresAt;
  else if (f.expiresIn.trim()) rule.expiresAt = now + Math.round(Number(f.expiresIn.trim()) * EXPIRY_UNIT_MS[f.expiresUnit]);
  return rule;
}
