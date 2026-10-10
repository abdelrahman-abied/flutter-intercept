/**
 * v0.6.0 helpers (CONTRACTS §12): sequences, Map Remote, rewrite, file-backed mocks, shared rules, recordings,
 * auth flows and the "Expire token" preset. Pure: no DOM, no state (state.ts builds the rule form on top of these).
 */
import type { AuthFlowSummary, Exchange, RecordingSummary, Rule, RuleAction, Status } from './protocol';
import type { RewriteSpec, SequenceStep } from '@flutter-intercept/proxy/types';
import { splitUrl } from './util';

const TOKEN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

// ---------------------------------------------------------------- sequences (§12.3)

export type StepAction = SequenceStep['action'];
export type StepKind = StepAction['kind'];
export type SequenceThen = 'last' | 'passthrough' | 'loop';

/** Step kinds offered in the editor, in menu order (no breakpoint / nested sequence: the proxy rejects them). */
export const STEP_KINDS: readonly StepKind[] = ['mock', 'passthrough', 'block', 'fault', 'throttle', 'mutate', 'rewrite', 'mapRemote', 'cors'];
export const STEP_KIND_LABEL: Record<StepKind, string> = {
  mock: 'Mock response', passthrough: 'Real server', block: 'Block', fault: 'Fault', throttle: 'Throttle',
  mutate: 'Mutate JSON', rewrite: 'Rewrite', mapRemote: 'Map remote', cors: 'CORS (dev only)',
};
export const THEN_LABEL: Record<SequenceThen, string> = {
  last: 'Keep answering with the last step',
  passthrough: 'Go to the real server',
  loop: 'Start again from step 1',
};
export const MAX_STEPS = 20;
export const MAX_STEP_COUNT = 1000;

/** A step in a few characters, for the preview line: "500", "real server", "timeout". */
export function stepLabel(a: StepAction): string {
  switch (a.kind) {
    case 'passthrough': return 'real server';
    case 'mock': return String(a.status);
    case 'block': return a.mode === 'reset' ? 'reset' : `blocked ${a.status ?? 403}`;
    case 'fault': return a.fault === 'dns' ? 'DNS failure' : a.fault === 'truncate' ? 'truncated' : a.fault;
    case 'throttle': return 'slow';
    case 'mutate': return 'mutated';
    case 'rewrite': return a.response?.status !== undefined ? `rewritten ${a.response.status}` : 'rewritten';
    case 'mapRemote': return `→ ${hostOf(a.to)}`;
    case 'cors': return 'CORS';
  }
}

/** `label` overrides the step's own label (the editor's preview of a step that doesn't validate yet). */
export interface PreviewStep { action: StepAction; count?: number; label?: string }

/**
 * "500 ×1 → 200 ×2 → real server". With `then: 'last'` (the default) the last step's count doesn't matter:
 * it reads "… → 200 from then on".
 */
export function sequencePreview(steps: readonly PreviewStep[], then: SequenceThen = 'last'): string {
  if (!steps.length) return 'no steps';
  const n = (s: PreviewStep) => s.count ?? 1;
  const label = (s: PreviewStep) => s.label ?? stepLabel(s.action);
  if (then === 'last') {
    const head = steps.slice(0, -1).map((s) => `${label(s)} ×${n(s)}`);
    const last = label(steps[steps.length - 1]);
    return [...head, steps.length === 1 ? `${last} every time` : `${last} from then on`].join(' → ');
  }
  const parts = steps.map((s) => `${label(s)} ×${n(s)}`);
  parts.push(then === 'passthrough' ? 'real server' : '↻ again');
  return parts.join(' → ');
}

/** Why a step's count can't be saved, if it can't ('' = 1). */
export function stepCountError(count: string): string | undefined {
  const c = count.trim();
  if (!c) return undefined;
  if (!/^\d+$/.test(c) || +c < 1 || +c > MAX_STEP_COUNT) return `Count: whole number 1–${MAX_STEP_COUNT}`;
  return undefined;
}

// ---------------------------------------------------------------- Map Remote (§12.6)

function hostOf(url: string): string {
  try { return new URL(url).host; } catch { return url; }
}

/** localhost, *.localhost, 127.0.0.0/8, ::1 — the machine running the proxy (what agents may map to). */
export function isLoopbackHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (h === 'localhost' || h.endsWith('.localhost')) return true;
  if (h === '::1' || h === '0:0:0:0:0:0:0:1') return true;
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h);
}

export interface MapTargetCheck { error?: string; origin?: string; loopback: boolean }

/** `to` is an origin (https://staging.example.com) or a URL prefix (http://localhost:8080/api). */
export function checkMapTarget(to: string): MapTargetCheck {
  const t = to.trim();
  if (!t) return { error: 'Required: an origin such as http://localhost:8080, or a URL prefix', loopback: false };
  let u: URL;
  try { u = new URL(t); } catch { return { error: 'Not a URL — start with http:// or https://', loopback: false }; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return { error: 'Only http:// and https:// targets', loopback: false };
  if (u.username || u.password) return { error: 'No user name or password in the target URL', loopback: false };
  if (u.search || u.hash || /[?#]/.test(t)) return { error: 'An origin or a URL prefix — no ?query or #fragment', loopback: false };
  return { origin: u.origin, loopback: isLoopbackHost(u.hostname) };
}

/** Shown under a valid non-loopback target: the app's credentials travel with the request. */
export function mapRemoteWarning(to: string): string | undefined {
  const c = checkMapTarget(to);
  if (c.error || c.loopback) return undefined;
  return `Matching requests — with the app's credentials (Authorization header, cookies, API keys) — are sent to ` +
    `${c.origin}. Only map to a server you trust.`;
}

// ---------------------------------------------------------------- rewrite (§12.6)

export interface NameValue { name: string; value: string }
export interface ReplaceRow { find: string; replace: string; all: boolean }
export interface RewriteSideForm {
  setHeaders: NameValue[];
  /** Header names to remove, comma or space separated. */
  removeHeaders: string;
  replaceBody: ReplaceRow[];
}
export interface RewriteForm { request: RewriteSideForm; response: RewriteSideForm; status: string }

export const MAX_REPLACEMENTS = 20;

const emptySide = (): RewriteSideForm => ({ setHeaders: [], removeHeaders: '', replaceBody: [] });
export function emptyRewriteForm(): RewriteForm {
  return { request: emptySide(), response: emptySide(), status: '' };
}

function sideToForm(s: RewriteSpec | undefined): RewriteSideForm {
  return {
    setHeaders: Object.entries(s?.setHeaders ?? {}).map(([name, value]) => ({ name, value })),
    removeHeaders: (s?.removeHeaders ?? []).join(', '),
    replaceBody: (s?.replaceBody ?? []).map((r) => ({ find: r.find, replace: r.replace, all: !!r.all })),
  };
}

export function rewriteToForm(a: Extract<RuleAction, { kind: 'rewrite' }>): RewriteForm {
  return {
    request: sideToForm(a.request),
    response: sideToForm(a.response),
    status: a.response?.status !== undefined ? String(a.response.status) : '',
  };
}

export const removeList = (s: string): string[] => s.split(/[\s,]+/).map((x) => x.trim()).filter(Boolean);
const usedReplaceRows = (rows: ReplaceRow[]) => rows.filter((r) => r.find !== '' || r.replace !== '');

function sideFromForm(f: RewriteSideForm): RewriteSpec | undefined {
  const spec: RewriteSpec = {};
  const set: Record<string, string> = {};
  for (const r of f.setHeaders) if (r.name.trim()) set[r.name.trim()] = r.value;
  if (Object.keys(set).length) spec.setHeaders = set;
  const remove = removeList(f.removeHeaders);
  if (remove.length) spec.removeHeaders = remove;
  const rows = usedReplaceRows(f.replaceBody);
  if (rows.length) spec.replaceBody = rows.map((r) => (r.all ? { find: r.find, replace: r.replace, all: true } : { find: r.find, replace: r.replace }));
  return Object.keys(spec).length ? spec : undefined;
}

export function rewriteFromForm(f: RewriteForm): Extract<RuleAction, { kind: 'rewrite' }> {
  const a: Extract<RuleAction, { kind: 'rewrite' }> = { kind: 'rewrite' };
  const req = sideFromForm(f.request);
  if (req) a.request = req;
  const res: (RewriteSpec & { status?: number }) | undefined = sideFromForm(f.response);
  const status = f.status.trim();
  if (status) a.response = { ...(res ?? {}), status: Number(status) };
  else if (res) a.response = res;
  return a;
}

function sideError(f: RewriteSideForm, side: 'Request' | 'Response'): string | undefined {
  for (const r of f.setHeaders) {
    if (r.name.trim() && !TOKEN.test(r.name.trim())) return `${side} header name “${r.name.trim()}” is not valid`;
    if (!r.name.trim() && r.value.trim()) return `${side} header: a value needs a name`;
  }
  for (const n of removeList(f.removeHeaders)) if (!TOKEN.test(n)) return `${side} header to remove “${n}” is not valid`;
  const rows = usedReplaceRows(f.replaceBody);
  if (rows.some((r) => r.find === '')) return `${side} body: “Find” can't be empty`;
  if (rows.length > MAX_REPLACEMENTS) return `${side} body: at most ${MAX_REPLACEMENTS} replacements`;
  return undefined;
}

/** First problem with a rewrite form, if any (it must change something). */
export function rewriteError(f: RewriteForm): string | undefined {
  const e = sideError(f.request, 'Request') ?? sideError(f.response, 'Response');
  if (e) return e;
  const s = f.status.trim();
  if (s && (!/^\d{3}$/.test(s) || +s < 100 || +s > 599)) return 'Response status: 100–599 (empty = keep the server\'s)';
  const a = rewriteFromForm(f);
  if (!a.request && !a.response) return 'Set or remove a header, change the status, or add a body replacement.';
  return undefined;
}

/** Request headers this rewrite sets: the shared-rules approval gate holds such rules back (§12.1). */
export function rewriteSetsRequestHeaders(a: RuleAction): boolean {
  return a.kind === 'rewrite' && Object.keys(a.request?.setHeaders ?? {}).length > 0;
}

/** "Rewrite: request headers (2), status → 503, response body (1 replacement)". */
export function describeRewrite(a: Extract<RuleAction, { kind: 'rewrite' }>): string {
  const parts: string[] = [];
  const side = (s: RewriteSpec | undefined, name: string) => {
    if (!s) return;
    const h = Object.keys(s.setHeaders ?? {}).length + (s.removeHeaders?.length ?? 0);
    if (h) parts.push(`${name} headers (${h})`);
    const b = s.replaceBody?.length ?? 0;
    if (b) parts.push(`${name} body (${plural(b, 'replacement')})`);
  };
  side(a.request, 'request');
  if (a.response?.status !== undefined) parts.push(`status → ${a.response.status}`);
  side(a.response, 'response');
  return `Rewrite: ${parts.length ? parts.join(', ') : 'no changes'}`;
}

// ---------------------------------------------------------------- file-backed mocks (§12.2)

export const MOCKS_DIR = '.vscode/flutter-intercept/mocks';

/** Why `bodyFile` can't be used, if it can't. The host also realpath-checks it stays inside the workspace. */
export function bodyFileError(path: string): string | undefined {
  const p = path.trim();
  if (!p) return `Enter a workspace-relative path, e.g. ${MOCKS_DIR}/cart.json`;
  if (/^([\\/]|~|[A-Za-z]:)/.test(p) || /^[a-z][a-z0-9+.-]*:\/\//i.test(p)) return 'A workspace-relative path — not an absolute path or URL';
  if (p.split(/[\\/]/).includes('..')) return 'The file must be inside the workspace (no “..”)';
  if (p.endsWith('/') || p.endsWith('\\')) return 'A file, not a folder';
  return undefined;
}

/**
 * REVIEW-6 #5: what in a mock body looks like a live secret (a body copied from a real response often carries
 * tokens). A hint for the warning only — the host does the real check and refuses to write detected secrets.
 */
export function bodySecretHint(text: string): string | undefined {
  if (/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]+/.test(text)) return 'what looks like a JWT';
  if (/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(text)) return 'a private key';
  if (/\bAKIA[0-9A-Z]{16}\b/.test(text)) return 'what looks like an AWS access key';
  if (/\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/i.test(text)) return 'a bearer token';
  const key = /"((?:access|refresh|id)_?token|token|password|passwd|secret|client_?secret|api_?key|session_?id|authorization)"\s*:\s*"([^"]{6,})"/i.exec(text);
  if (key) return `a "${key[1]}" value`;
  return undefined;
}

/** `.vscode/flutter-intercept/mocks/<slug>.json` from the rule name, else the URL's last path segment. */
export function suggestBodyFile(name: string, url: string): string {
  const fromUrl = url.replace(/[?#].*$/, '').split('/').filter((s) => s && !/[*\\^$()[\]{}|]/.test(s)).pop() ?? '';
  const slug = (name.trim() || fromUrl || 'mock').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'mock';
  return `${MOCKS_DIR}/${slug}.json`;
}

// ---------------------------------------------------------------- shared rules (§12.1)

export const SHARED_FILE = '.vscode/flutter-intercept.json';

export const isShared = (r: Pick<Rule, 'shared'>): boolean => r.shared === true;

/** Shared rules run first: a personal rule may only move within the personal block. */
export function canMoveRule(rules: Rule[], from: number, to: number): boolean {
  if (from < 0 || to < 0 || from >= rules.length || to >= rules.length || from === to) return false;
  return !isShared(rules[from]) && !isShared(rules[to]);
}

/** Why sharing this rule makes teammates approve it first (map remote elsewhere / setting request headers). */
export function needsApproval(a: RuleAction): string | undefined {
  if (a.kind === 'mapRemote' && !checkMapTarget(a.to).loopback) return `it sends the app's traffic to ${hostOf(a.to)}`;
  if (rewriteSetsRequestHeaders(a)) return 'it sets request headers';
  if (a.kind === 'sequence') {
    for (const s of a.steps) {
      const why = s.action.kind === 'passthrough' ? undefined : needsApproval(s.action);
      if (why) return why;
    }
  }
  return undefined;
}

export function pendingApprovalText(sr: NonNullable<Status['sharedRules']>): string {
  const n = sr.pendingApproval;
  return `${plural(n, 'shared rule')} from ${sr.file ?? SHARED_FILE} ${n === 1 ? 'is' : 'are'} held back: ` +
    `${n === 1 ? 'it maps' : 'they map'} requests to another server or ${n === 1 ? 'sets' : 'set'} request headers. ` +
    'A cloned repository must not silently send the app\'s authenticated traffic elsewhere — review the file, then approve.';
}

// ---------------------------------------------------------------- recordings (§12.4–12.5)

/** What a recording keeps: finished HTTP exchanges (no WebSocket / SSE, no native captures, nothing in flight). */
export function isRecordable(ex: Pick<Exchange, 'state' | 'kind' | 'captured'>): boolean {
  if (ex.kind || ex.captured === 'vm-profile') return false;
  return ex.state !== 'pending' && ex.state !== 'paused-request' && ex.state !== 'paused-response';
}

export function sortRecordings(list: RecordingSummary[]): RecordingSummary[] {
  return list.slice().sort((a, b) => b.createdAt - a.createdAt || a.name.localeCompare(b.name));
}

export const MAX_RECORDING_NAME = 80;
export function recordingNameError(name: string): string | undefined {
  const n = name.trim();
  if (!n) return 'Give the recording a name';
  if (n.length > MAX_RECORDING_NAME) return `At most ${MAX_RECORDING_NAME} characters`;
  return undefined;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** "10 Oct 14:32". */
export function formatDate(epochMs: number): string {
  const d = new Date(epochMs);
  const p = (x: number) => String(x).padStart(2, '0');
  return `${d.getDate()} ${MONTHS[d.getMonth()]} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
export const defaultRecordingName = (now: number) => `Session ${formatDate(now)}`;

/** Diff selection: at most two; picking a third drops the oldest pick. */
export function togglePick(picks: string[], id: string): string[] {
  if (picks.includes(id)) return picks.filter((p) => p !== id);
  return [...picks, id].slice(-2);
}

/** The two picked recordings as (older, newer), when exactly two are picked and still listed. */
export function diffPair(recs: RecordingSummary[], picks: string[]): { a: RecordingSummary; b: RecordingSummary } | undefined {
  if (picks.length !== 2) return undefined;
  const [x, y] = picks.map((id) => recs.find((r) => r.id === id));
  if (!x || !y) return undefined;
  return x.createdAt <= y.createdAt ? { a: x, b: y } : { a: y, b: x };
}

/** Status.replay names the recording (name, or id for hosts that send it). */
export function isReplaying(status: Pick<Status, 'replay'>, rec: Pick<RecordingSummary, 'id' | 'name'>): boolean {
  const r = status.replay?.recording;
  return !!r && (r === rec.id || r === rec.name);
}

export const FALLBACK_LABEL: Record<'passthrough' | 'fail', string> = {
  passthrough: 'go to the real server',
  fail: 'fail like offline',
};

// ---------------------------------------------------------------- auth flows (§12.3)

export type FlowRole = AuthFlowSummary['steps'][number]['role'];
export const ROLE_LABEL: Record<FlowRole, string> = { unauthorized: 'Unauthorized', refresh: 'Refresh', retry: 'Retry', other: 'Other' };

export interface FlowRow { exchangeId: string; role: FlowRole; ex?: Exchange; offsetMs?: number }

/** Timeline rows with the exchange (when still listed) and its offset from the flow's first listed exchange. */
export function flowRows(flow: AuthFlowSummary, find: (id: string) => Exchange | undefined): FlowRow[] {
  const rows: FlowRow[] = flow.steps.map((s) => ({ exchangeId: s.exchangeId, role: s.role, ex: find(s.exchangeId) }));
  const t0 = Math.min(...rows.map((r) => r.ex?.startedAt ?? Infinity));
  if (Number.isFinite(t0)) for (const r of rows) if (r.ex) r.offsetMs = r.ex.startedAt - t0;
  return rows;
}

/** "GET /v1/me" of the first unauthorized step (else the first step). */
export function flowTitle(flow: AuthFlowSummary, find: (id: string) => Exchange | undefined): string {
  const first = flow.steps.find((s) => s.role === 'unauthorized') ?? flow.steps[0];
  const ex = first && find(first.exchangeId);
  if (!ex) return 'Token refresh';
  return `${ex.method} ${splitUrl(ex.url).path.split('?')[0] || '/'}`;
}

/** "3 refresh calls for one expiry (within 2 s)". */
export function stampedeText(s: NonNullable<AuthFlowSummary['stampede']>): string {
  const w = s.windowMs >= 1000 ? `${Math.round(s.windowMs / 100) / 10} s` : `${s.windowMs} ms`;
  return `${s.refreshCalls} refresh calls for one expiry (within ${w})`;
}

export const STAMPEDE_HINT =
  'Each failed request refreshed the token on its own. Share one in-flight refresh (a single Future, or Dio\'s ' +
  'QueuedInterceptor) so one expiry causes one refresh.';

/** Flows that need attention (stampede or a problem): the Auth tab's warning count. */
export function authAlerts(flows: AuthFlowSummary[]): number {
  let n = 0;
  for (const f of flows) if (f.stampede || f.problem) n++;
  return n;
}

// ---------------------------------------------------------------- Expire token preset (§12.3)

export const MAX_EXPIRE_COUNT = 100;

export function expireTokenError(url: string, count: string): string | undefined {
  if (!url.trim()) return 'Enter the URL (glob) whose requests should get 401';
  const c = count.trim();
  if (!/^\d+$/.test(c) || +c < 1 || +c > MAX_EXPIRE_COUNT) return `Count: whole number 1–${MAX_EXPIRE_COUNT}`;
  return undefined;
}

/** Notice text once the host has added the preset rule. */
export function expireTokenLabel(url: string, count: number): string {
  const who = count === 1 ? 'the next request' : `the next ${count} requests`;
  return `${who} to ${url} ${count === 1 ? 'gets' : 'get'} 401 {"error":"token_expired"}, then the real server answers.`;
}

// ---------------------------------------------------------------- upstream proxy (REVIEW-6 #1)

/** Tooltip of the "via upstream proxy host:port" indicator. */
export const UPSTREAM_TITLE = (hostPort: string): string =>
  `All pass-through traffic (every request a rule doesn't answer, HTTPS included) is sent through the proxy at ${hostPort}, ` +
  'which sees host names and — when it decrypts TLS (Charles, Burp) — headers, tokens and bodies. Set in your user ' +
  'settings: flutterIntercept.upstreamProxy.';

export const INSECURE_TITLE =
  'Certificate checks are OFF for traffic through the upstream proxy (flutterIntercept.upstreamProxyIgnoreCertErrors): ' +
  'any server certificate is accepted, so that proxy — or anyone in between — can read and change HTTPS traffic, tokens included. ' +
  'Only for a MITM proxy you run yourself (Charles, Burp).';
