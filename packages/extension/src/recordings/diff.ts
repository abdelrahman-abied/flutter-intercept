/**
 * Diff two recordings (CONTRACTS §12.5). Pure.
 *
 * `diff(a, b)` groups exchanges by route (method + path template via `routeTemplate`, plus the GraphQL operation;
 * the origin is kept only when the recordings span several origins) and reports, per route in a stable order:
 * added / removed routes, status changes, call-count changes, JSON shape changes (keys added / removed, type
 * changes, array element shape — `1.0` is a double, `1` an int, as Dart decodes them), body value changes (a count
 * only, never the values) and timing (median more than 2× slower).
 *
 * `diffText(rec)` is a normalised text of one recording for a side-by-side `vscode.diff`: exchanges ordered by route
 * then time, headers sorted with volatile ones (date, request ids, trace ids, …) dropped and cookie values
 * removed, secrets redacted like agent views (tokens change on every run, and the text lands in an editor), JSON
 * bodies pretty-printed without touching their number literals.
 */
import { createHash } from 'crypto';
import type { Body, Exchange } from '@flutter-intercept/proxy';
import { redactBodyText, redactHeaders, redactUrl } from '../agent/redact';
import { inferShape, mergeShapes, type Shape } from '../codegen/infer';
import { JsonDouble, parseJsonSample, prettyJson } from '../codegen/json';
import { isIdSegment, routeTemplate } from '../codegen/route';
import { requestBodyHash } from './replay';
import type { Recording, RecordingDiffEntry } from './types';

const MAX_SHAPE_CHANGES = 20;
const MAX_TEXT_BODY_CHARS = 256 * 1024;
const MAX_JSON_PARSE_CHARS = 5 * 1024 * 1024;
const SLOWER_FACTOR = 2;
const MIN_SLOWER_MS = 50;

const CHANGE_ORDER: RecordingDiffEntry['change'][] = ['removed', 'added', 'status', 'count', 'shape', 'body', 'timing'];

// ------------------------------------------------------------------ routes

function originOf(url: string): string {
  return /^([a-z][a-z0-9+.-]*:\/\/[^/?#]*)/i.exec(url)?.[1]?.toLowerCase() ?? '';
}

interface RouteInfo {
  key: string; // sort + group key
  label: string; // "GET /users/{id}"
}

function routeOf(e: Exchange, withOrigin: boolean): RouteInfo {
  const method = e.method.toUpperCase();
  let template = routeTemplate(e.url);
  if (!withOrigin) {
    const o = /^[a-z][a-z0-9+.-]*:\/\/[^/?#]*/i.exec(template)?.[0];
    if (o) template = template.slice(o.length) || '/';
  }
  template = redactUrl(template);
  const op = e.graphql?.operationName ? ` (${e.graphql.operationName})` : '';
  return { key: `${template}${op}\u0000${method}`, label: `${method} ${template}${op}` };
}

function groupByRoute(entries: Exchange[], withOrigin: boolean): Map<string, { label: string; items: Exchange[] }> {
  const groups = new Map<string, { label: string; items: Exchange[] }>();
  const ordered = entries.map((e, i) => ({ e, i })).sort((x, y) => x.e.startedAt - y.e.startedAt || x.i - y.i);
  for (const { e } of ordered) {
    const r = routeOf(e, withOrigin);
    const g = groups.get(r.key);
    if (g) g.items.push(e);
    else groups.set(r.key, { label: r.label, items: [e] });
  }
  return groups;
}

function needsOrigin(...lists: Exchange[][]): boolean {
  const origins = new Set<string>();
  for (const l of lists) for (const e of l) origins.add(originOf(e.url));
  return origins.size > 1;
}

const byKey = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

// ------------------------------------------------------------------ JSON helpers

function jsonOf(b: Body | undefined): { ok: true; value: unknown } | { ok: false; text?: string } {
  if (!b || b.encoding !== 'utf8' || b.truncated) return { ok: false };
  const t = b.text.trim();
  if (!t) return { ok: false };
  if ((t.startsWith('{') || t.startsWith('[')) && t.length <= MAX_JSON_PARSE_CHARS) {
    try {
      return { ok: true, value: parseJsonSample(t) };
    } catch {
      // not JSON after all
    }
  }
  return { ok: false, text: b.text };
}

function typeName(s: Shape): string {
  if (s.kind === 'none') return s.nullable ? 'null' : 'empty';
  const k = s.kind === 'object' ? 'object' : s.kind === 'list' ? 'list' : s.kind === 'dynamic' ? 'mixed' : s.kind;
  return s.nullable ? `${k}?` : k;
}

const join = (path: string, key: string) => (path ? `${path}.${key}` : key);

function isMapLike(s: Shape): boolean {
  return s.kind === 'object' && s.fields!.size > 0 && [...s.fields!.keys()].every((k) => isIdSegment(k));
}

function mapValue(s: Shape): Shape {
  return [...s.fields!.values()].reduce<Shape>((acc, f) => mergeShapes(acc, f.shape), { kind: 'none', nullable: false });
}

/** Shape differences between a and b at `path`, appended to `out` as readable lines. */
export function compareShapes(a: Shape, b: Shape, path: string, out: string[]): void {
  // `empty` = no information (only seen inside empty arrays)
  if ((a.kind === 'none' && !a.nullable) || (b.kind === 'none' && !b.nullable)) return;
  const where = path || '(root)';
  if (a.kind !== b.kind) {
    out.push(`type ${where}: ${typeName(a)} → ${typeName(b)}`);
    return;
  }
  if (a.nullable !== b.nullable && a.kind !== 'none') out.push(`type ${where}: ${typeName(a)} → ${typeName(b)}`);
  if (a.kind === 'list') {
    compareShapes(a.of!, b.of!, `${path}[]`, out);
    return;
  }
  if (a.kind !== 'object') return;
  if (isMapLike(a) && isMapLike(b)) {
    compareShapes(mapValue(a), mapValue(b), `${path}{}`, out);
    return;
  }
  const af = a.fields!;
  const bf = b.fields!;
  for (const [k, f] of af) if (!bf.has(k)) out.push(`-field ${join(path, k)} (${typeName(f.shape)})`);
  for (const [k, f] of bf) if (!af.has(k)) out.push(`+field ${join(path, k)} (${typeName(f.shape)})`);
  for (const [k, f] of af) {
    const g = bf.get(k);
    if (g) compareShapes(f.shape, g.shape, join(path, k), out);
  }
}

/** Leaf values of the same type that differ at paths present in both (count only; type changes are shape). */
function countValueChanges(a: unknown, b: unknown): number {
  if (a instanceof JsonDouble || b instanceof JsonDouble) {
    if (!(a instanceof JsonDouble && b instanceof JsonDouble)) return 0;
    return a.value === b.value ? 0 : 1;
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    let n = 0;
    for (let i = 0; i < Math.min(a.length, b.length); i++) n += countValueChanges(a[i], b[i]);
    return n;
  }
  if (a && b && typeof a === 'object' && typeof b === 'object' && !Array.isArray(a) && !Array.isArray(b)) {
    let n = 0;
    const bo = b as Record<string, unknown>;
    for (const [k, v] of Object.entries(a as Record<string, unknown>)) if (Object.prototype.hasOwnProperty.call(bo, k)) n += countValueChanges(v, bo[k]);
    return n;
  }
  if ((a && typeof a === 'object') || (b && typeof b === 'object') || typeof a !== typeof b) return 0;
  return a === b ? 0 : 1;
}

function median(xs: number[]): number | undefined {
  if (!xs.length) return undefined;
  const s = [...xs].sort((x, y) => x - y);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function statuses(items: Exchange[]): string {
  const seen: number[] = [];
  for (const e of items) if (e.status !== undefined && !seen.includes(e.status)) seen.push(e.status);
  return seen.length ? seen.join('/') : 'no status';
}

const calls = (n: number) => `${n} call${n === 1 ? '' : 's'}`;

/** Exact request identity, for pairing responses of the same request across recordings. */
function requestKey(e: Exchange): string {
  return `${e.method.toUpperCase()} ${e.url} ${requestBodyHash(e.requestBody) ?? ''}`;
}

function routeChanges(route: string, a: Exchange[], b: Exchange[]): RecordingDiffEntry[] {
  const out: RecordingDiffEntry[] = [];
  const sa = statuses(a);
  const sb = statuses(b);
  if (sa !== sb) out.push({ route, change: 'status', detail: `${sa} → ${sb}` });
  if (a.length !== b.length) out.push({ route, change: 'count', detail: `${a.length} → ${calls(b.length)}` });

  // shape
  const ja = a.map((e) => jsonOf(e.responseBody));
  const jb = b.map((e) => jsonOf(e.responseBody));
  const va = ja.filter((x) => x.ok).map((x) => (x as { value: unknown }).value);
  const vb = jb.filter((x) => x.ok).map((x) => (x as { value: unknown }).value);
  const textA = ja.some((x) => !x.ok && x.text !== undefined);
  const textB = jb.some((x) => !x.ok && x.text !== undefined);
  if (va.length && vb.length) {
    const lines: string[] = [];
    compareShapes(inferShape(va), inferShape(vb), '', lines);
    for (const l of lines.slice(0, MAX_SHAPE_CHANGES)) out.push({ route, change: 'shape', detail: l });
    if (lines.length > MAX_SHAPE_CHANGES) out.push({ route, change: 'shape', detail: `… and ${lines.length - MAX_SHAPE_CHANGES} more shape changes` });
  } else if (va.length && textB && !vb.length) out.push({ route, change: 'shape', detail: 'response body: JSON → not JSON' });
  else if (vb.length && textA && !va.length) out.push({ route, change: 'shape', detail: 'response body: not JSON → JSON' });

  // body values: pair the same requests in order
  const queues = new Map<string, Exchange[]>();
  for (const e of b) {
    const k = requestKey(e);
    const q = queues.get(k);
    if (q) q.push(e);
    else queues.set(k, [e]);
  }
  let pairs = 0;
  let changedResponses = 0;
  let changedValues = 0;
  let allJson = true;
  for (const ea of a) {
    const eb = queues.get(requestKey(ea))?.shift();
    if (!eb) continue;
    const x = jsonOf(ea.responseBody);
    const y = jsonOf(eb.responseBody);
    pairs++;
    if (x.ok && y.ok) {
      const n = countValueChanges(x.value, y.value);
      if (n) {
        changedResponses++;
        changedValues += n;
      }
    } else {
      allJson = false;
      const ta = ea.responseBody ? `${ea.responseBody.encoding}:${ea.responseBody.text}` : '';
      const tb = eb.responseBody ? `${eb.responseBody.encoding}:${eb.responseBody.text}` : '';
      if (ta !== tb) changedResponses++;
    }
  }
  if (changedResponses) {
    const of = `${changedResponses} of ${pairs} response${pairs === 1 ? '' : 's'}`;
    out.push({
      route,
      change: 'body',
      detail: allJson ? `${changedValues} value${changedValues === 1 ? '' : 's'} changed in ${of}` : `${of} changed`,
    });
  }

  // timing
  const ma = median(a.flatMap((e) => (typeof e.durationMs === 'number' ? [e.durationMs] : [])));
  const mb = median(b.flatMap((e) => (typeof e.durationMs === 'number' ? [e.durationMs] : [])));
  if (ma !== undefined && mb !== undefined && mb > ma * SLOWER_FACTOR && mb - ma >= MIN_SLOWER_MS) {
    out.push({ route, change: 'timing', detail: `${Math.round(ma)} ms → ${Math.round(mb)} ms (median, ${(mb / Math.max(ma, 1)).toFixed(1)}× slower)` });
  }
  return out;
}

/** Changes from recording `a` to recording `b`, ordered by route, then by kind of change. */
export function diff(a: Recording, b: Recording): RecordingDiffEntry[] {
  const withOrigin = needsOrigin(a.entries, b.entries);
  const ga = groupByRoute(a.entries, withOrigin);
  const gb = groupByRoute(b.entries, withOrigin);
  const keys = [...new Set([...ga.keys(), ...gb.keys()])].sort(byKey);
  const out: RecordingDiffEntry[] = [];
  for (const k of keys) {
    const x = ga.get(k);
    const y = gb.get(k);
    if (x && !y) out.push({ route: x.label, change: 'removed', detail: `${calls(x.items.length)}, ${statuses(x.items)}` });
    else if (!x && y) out.push({ route: y.label, change: 'added', detail: `${calls(y.items.length)}, ${statuses(y.items)}` });
    else if (x && y) {
      const changes = routeChanges(x.label, x.items, y.items);
      changes.sort((p, q) => CHANGE_ORDER.indexOf(p.change) - CHANGE_ORDER.indexOf(q.change));
      out.push(...changes);
    }
  }
  return out;
}

// ------------------------------------------------------------------ diffText

const VOLATILE_HEADERS = new Set([
  'date', 'age', 'expires', 'last-modified', 'etag', 'content-length', 'x-request-id', 'request-id', 'x-correlation-id',
  'correlation-id', 'x-trace-id', 'x-span-id', 'traceparent', 'tracestate', 'sentry-trace', 'baggage', 'x-cloud-trace-context',
  'x-amzn-requestid', 'x-amzn-trace-id', 'x-amz-cf-id', 'x-amz-cf-pop', 'x-amz-request-id', 'x-amz-id-2', 'apigw-requestid',
  'cf-ray', 'x-cache', 'x-cache-hits', 'x-served-by', 'x-timer', 'via', 'server-timing', 'x-runtime', 'x-response-time',
  'x-envoy-upstream-service-time', 'x-github-request-id', 'report-to', 'nel', 'alt-svc', 'x-ratelimit-remaining',
  'x-ratelimit-reset', 'ratelimit-remaining', 'ratelimit-reset', 'if-none-match', 'if-modified-since', 'x-powered-by-request',
]);
const VOLATILE_PREFIX = /^x-b3-/;

/** Cookie header values without their values: `a=1; b=2` → `a=…; b=…` (set-cookie: name and attributes kept). */
function cookieNames(name: string, value: string): string {
  if (name === 'set-cookie') {
    const [pair, ...attrs] = value.split(';');
    const n = pair.split('=')[0].trim();
    const kept = attrs.map((x) => x.trim()).filter((x) => x && !/^(expires|max-age)=/i.test(x));
    return [`${n}=…`, ...kept].join('; ');
  }
  return value
    .split(';')
    .map((p) => p.split('=')[0].trim())
    .filter(Boolean)
    .map((n) => `${n}=…`)
    .join('; ');
}

function headerLines(h: Record<string, string | string[]> | undefined): string[] {
  const kept: Record<string, string | string[]> = {};
  const cookies: string[] = [];
  for (const [k, v] of Object.entries(h ?? {})) {
    const n = k.toLowerCase();
    if (VOLATILE_HEADERS.has(n) || VOLATILE_PREFIX.test(n)) continue;
    if (n === 'cookie' || n === 'set-cookie') {
      for (const x of Array.isArray(v) ? v : [v]) cookies.push(`${n}: ${cookieNames(n, x)}`);
      continue;
    }
    Object.defineProperty(kept, n, { value: v, enumerable: true, writable: true, configurable: true });
  }
  const lines: string[] = [];
  for (const [k, v] of Object.entries(redactHeaders(kept) ?? {})) for (const x of Array.isArray(v) ? v : [v]) lines.push(`${k}: ${x}`);
  return [...lines, ...cookies.sort()].sort(byKey);
}

function bodyLines(b: Body | undefined, headers: Record<string, string | string[]> | undefined): string[] {
  if (!b) return [];
  if (b.encoding === 'base64') {
    const bytes = Buffer.from(b.text, 'base64');
    const sha = createHash('sha256').update(bytes).digest('hex').slice(0, 12);
    return [`[binary ${bytes.length} bytes, sha256 ${sha}…${b.truncated ? ', truncated' : ''}]`];
  }
  if (!b.text) return [];
  let text = redactBodyText(b.text, headers);
  const t = text.trim();
  if ((t.startsWith('{') || t.startsWith('[')) && t.length <= MAX_JSON_PARSE_CHARS && !b.truncated) {
    try {
      text = prettyJson(t);
    } catch {
      // not JSON: as is
    }
  }
  text = text.replace(/\r\n?/g, '\n');
  const lines: string[] = [];
  if (text.length > MAX_TEXT_BODY_CHARS) lines.push(...text.slice(0, MAX_TEXT_BODY_CHARS).split('\n'), `[… ${text.length - MAX_TEXT_BODY_CHARS} more characters]`);
  else lines.push(...text.split('\n'));
  if (b.truncated) lines.push('[truncated at the 5 MB capture limit]');
  return lines;
}

/** Normalised, stable text of a recording for a side-by-side `vscode.diff`. */
export function diffText(rec: Recording): string {
  const withOrigin = needsOrigin(rec.entries);
  const groups = groupByRoute(rec.entries, withOrigin);
  const out: string[] = [`Recording: ${rec.name}`, `${rec.entries.length} exchange${rec.entries.length === 1 ? '' : 's'}${rec.redacted ? ' (saved redacted)' : ''}`, ''];
  const indent = (l: string) => (l ? `    ${l}` : '');
  for (const k of [...groups.keys()].sort(byKey)) {
    const g = groups.get(k)!;
    out.push(`=== ${g.label} — ${calls(g.items.length)}`, '');
    for (const e of g.items) {
      out.push(`${e.method.toUpperCase()} ${redactUrl(e.url)}`);
      out.push(...headerLines(e.requestHeaders).map(indent));
      const rq = bodyLines(e.requestBody, e.requestHeaders);
      if (rq.length) out.push('', ...rq.map(indent));
      out.push(`→ ${e.status ?? 'no status'}${e.state === 'mocked' ? ' (mocked)' : ''}`);
      out.push(...headerLines(e.responseHeaders).map(indent));
      const rs = bodyLines(e.responseBody, e.responseHeaders);
      if (rs.length) out.push('', ...rs.map(indent));
      out.push('');
    }
  }
  return out.join('\n');
}
