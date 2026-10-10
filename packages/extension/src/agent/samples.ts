/**
 * Exchange helpers shared by the webview controller and the agent API for the v0.4.0 features (CONTRACTS
 * §10): JSON response decoding, grouping recorded samples by route, naming, the redacted exchange view that
 * fixtures are built from, and the agent view of contract results. Pure, no `vscode`.
 */
import * as fs from 'fs';
import * as path from 'path';
import type { Body, Exchange } from '@flutter-intercept/proxy';
import { formatPath, parsePath, type PathSegment } from '@flutter-intercept/proxy/jsonpath';
import { JsonDouble, parseJsonSample } from '../codegen/json';
import { parsePubspecDeps } from '../codegen/pubspec';
import type { FixtureApi } from '../codegen/types';
import type { ApiEndpoint, ContractResult, ContractViolation } from '../contract/types';
import { isSensitiveField, REDACTED, redactBody, redactHeaders, redactSecretValues, redactUrl } from './redact';

export const FINAL_STATES = new Set<Exchange['state']>(['completed', 'mocked', 'blocked', 'aborted', 'error']);

/** Max samples merged into one model; max fixtures per test. */
export const MAX_MODEL_SAMPLES = 200;
export const MAX_FIXTURES = 20;

function header(h: Exchange['responseHeaders'], name: string): string | undefined {
  for (const [k, v] of Object.entries(h ?? {})) if (k.toLowerCase() === name) return Array.isArray(v) ? v[0] : v;
  return undefined;
}

/** True when the response looks like JSON (content type, or a text body starting with `{` / `[`). */
export function looksJson(e: Exchange): boolean {
  const b = e.responseBody;
  if (!b || b.encoding !== 'utf8') return false;
  if (/[/+]json\b/i.test(header(e.responseHeaders, 'content-type') ?? '')) return true;
  const t = b.text.trimStart();
  return t.startsWith('{') || t.startsWith('[');
}

export type JsonBody = { ok: true; value: unknown } | { ok: false; reason: string };

/** The decoded JSON of a body, or why there is none. */
export function decodeJson(b: Body | undefined): JsonBody {
  if (!b) return { ok: false, reason: 'no body' };
  if (b.encoding !== 'utf8') return { ok: false, reason: 'the body is binary' };
  if (b.truncated) return { ok: false, reason: 'the body was truncated when recorded (too large)' };
  try {
    return { ok: true, value: JSON.parse(b.text) };
  } catch {
    return { ok: false, reason: 'the body is not valid JSON' };
  }
}

/**
 * A body decoded for model inference: like decodeJson, but numbers Dart decodes as `double` (`1.0`, `1e3`)
 * stay `JsonDouble` (src/codegen/json.ts), so models get `double`, not `int`.
 */
export function decodeSample(b: Body | undefined): JsonBody {
  const d = decodeJson(b);
  if (!d.ok) return d;
  try {
    return { ok: true, value: parseJsonSample(b!.text) };
  } catch {
    return d;
  }
}

/** A finished exchange whose response is checkable JSON (not truncated, not binary). */
export function isCheckable(e: Exchange): boolean {
  return FINAL_STATES.has(e.state) && looksJson(e) && !e.responseBody?.truncated;
}

export type RouteTemplate = (url: string) => string;

/** `GET https://api.example.com/users/{id}` — the route key samples are grouped by. */
export function routeOf(e: Pick<Exchange, 'method' | 'url'>, template: RouteTemplate): { origin: string; template: string; key: string } {
  let origin = '';
  let pathname = e.url.split(/[?#]/)[0];
  try {
    const u = new URL(e.url);
    origin = u.origin;
    pathname = u.pathname;
  } catch {
    // not absolute: group by the raw path
  }
  const t = template(pathname);
  return { origin, template: t, key: `${e.method.toUpperCase()} ${origin}${t}` };
}

const statusClass = (s: number | undefined) => (s === undefined ? -1 : Math.floor(s / 100));

/**
 * Samples for model generation: every finished JSON response of the same method + route with the same
 * status class as `target`. Rule-handled responses (mocked / mutated / …) only count when nothing else
 * exists, except `target` itself, which is always included. Oldest first, at most MAX_MODEL_SAMPLES.
 */
export function modelSamples(all: Exchange[], target: Exchange, template: RouteTemplate): Exchange[] {
  const key = routeOf(target, template).key;
  const same = all.filter((e) => FINAL_STATES.has(e.state) && statusClass(e.status) === statusClass(target.status) && decodeJson(e.responseBody).ok && routeOf(e, template).key === key);
  const real = same.filter((e) => e.state === 'completed' && !e.matchedRuleId);
  const picked = real.length ? real : same;
  if (!picked.some((e) => e.id === target.id) && decodeJson(target.responseBody).ok) picked.push(target);
  return picked.sort((a, b) => a.startedAt - b.startedAt).slice(-MAX_MODEL_SAMPLES);
}

/** Exchanges for a fixture test: same method + route, finished with a response, distinct status+body, newest MAX_FIXTURES. */
export function fixtureSamples(all: Exchange[], target: Exchange, template: RouteTemplate): Exchange[] {
  const key = routeOf(target, template).key;
  const seen = new Set<string>();
  const out: Exchange[] = [];
  const candidates = all
    .filter((e) => e.id === target.id || (FINAL_STATES.has(e.state) && e.status !== undefined && routeOf(e, template).key === key))
    .sort((a, b) => b.startedAt - a.startedAt);
  // the target first, then the newest others
  candidates.sort((a, b) => (a.id === target.id ? -1 : b.id === target.id ? 1 : 0));
  for (const e of candidates) {
    const sig = `${e.status} ${e.responseBody?.text ?? ''}`;
    if (seen.has(sig)) continue;
    seen.add(sig);
    out.push(e);
    if (out.length >= MAX_FIXTURES) break;
  }
  return out;
}

/** Values of sensitive keys (any depth) replaced by "[redacted]" in an already-decoded JSON value. */
export function redactJsonValue(v: unknown): unknown {
  if (v instanceof JsonDouble) return v; // a number, kept as is (codegen reads it as double)
  if (Array.isArray(v)) return v.map(redactJsonValue);
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) out[k] = isSensitiveField(k) ? REDACTED : redactJsonValue(x);
    return out;
  }
  // REVIEW-4 #9: JWTs / Bearer credentials / long opaque tokens under any key
  if (typeof v === 'string') return redactSecretValues(v, true);
  return v;
}

/** The exchange as agents see it with redaction on: URL query, headers and bodies (CONTRACTS §8). */
export function redactExchange(e: Exchange): Exchange {
  return {
    ...e,
    url: redactUrl(e.url),
    requestHeaders: redactHeaders(e.requestHeaders) ?? {},
    ...(e.responseHeaders ? { responseHeaders: redactHeaders(e.responseHeaders) } : {}),
    ...(e.requestBody ? { requestBody: redactBody(e.requestBody, e.requestHeaders) } : {}),
    ...(e.responseBody ? { responseBody: redactBody(e.responseBody, e.responseHeaders) } : {}),
  };
}

function words(s: string): string[] {
  return s
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean);
}

/** "users" → "user", "categories" → "category", "addresses" → "address", "status" stays. */
export function singular(w: string): string {
  if (/ies$/i.test(w) && w.length > 4) return w.slice(0, -3) + 'y';
  if (/(ss|us|is)$/i.test(w)) return w;
  if (/(sses|xes|ches|shes|zes)$/i.test(w)) return w.slice(0, -2);
  if (/s$/i.test(w) && w.length > 1) return w.slice(0, -1);
  return w;
}

/** Root model class name from a route template: "/v1/users/{id}" → "User", "/me" → "Me". */
export function defaultModelName(template: string): string {
  const segs = template.split('/').filter((s) => s && !/^\{.*\}$/.test(s) && !/^v\d+$/i.test(s) && !/^api$/i.test(s));
  const last = segs.at(-1);
  const parts = last ? words(last) : [];
  if (!parts.length) return 'ApiResponse';
  parts[parts.length - 1] = singular(parts[parts.length - 1]);
  const name = parts.map((p) => p.charAt(0).toUpperCase() + p.slice(1).toLowerCase()).join('');
  return /^[A-Za-z]/.test(name) ? name : `Model${name}`;
}

/** snake_case base name for fixtures: "get_user". */
export function defaultFixtureName(method: string, template: string): string {
  const model = defaultModelName(template);
  const snake = model === 'ApiResponse' ? 'response' : words(model).map((w) => w.toLowerCase()).join('_');
  return `${method.toLowerCase().replace(/[^a-z]/g, '') || 'request'}_${snake}`.slice(0, 60);
}

/** `abs` relative to `root` with forward slashes, or undefined when outside it / not absolute. */
export function projectRelative(abs: string | undefined, root: string | undefined): string | undefined {
  if (!abs || !root || !path.isAbsolute(abs)) return undefined;
  const p = path.relative(root, abs);
  return p && !p.startsWith('..') && !path.isAbsolute(p) ? p.split(path.sep).join('/') : undefined;
}

/**
 * The category of a checker's `actual` text, without the value (REVIEW-4 #6): "null", "missing",
 * "unknown enum value", "string", "number", "bool", "list", "object", or "other".
 */
export function actualCategory(actual: string): string {
  const a = actual.trim().toLowerCase().replace(/^(an?|the)\s+/, '');
  if (/unknown enum/.test(a)) return 'unknown enum value';
  if (/^null\b/.test(a)) return 'null';
  if (/^missing\b/.test(a) || /\babsent\b/.test(a)) return 'missing';
  if (/^(string|text)\b/.test(a)) return 'string';
  if (/^(number|int|integer|double|num|float)\b/.test(a)) return 'number';
  if (/^(bool|boolean|true|false)\b/.test(a)) return 'bool';
  if (/^(list|array)\b/.test(a)) return 'list';
  if (/^(map|object)\b/.test(a)) return 'object';
  return 'other';
}

/** `path` cut after its first sensitive key (nothing below a redacted field is shown). */
function agentPath(p: string): string {
  let segs: PathSegment[];
  try {
    segs = parsePath(p);
  } catch {
    return '$';
  }
  const i = segs.findIndex((s) => 'key' in s && isSensitiveField(s.key));
  return i === -1 || i === segs.length - 1 ? p : formatPath(segs.slice(0, i + 1));
}

/**
 * A contract violation as agents see it (CONTRACTS §10.6, REVIEW-4 #6), built from the structured fields only:
 * `actual` is the category without the value, `message` is rebuilt (no response values, no URL, no absolute
 * path), `path` stops at a sensitive key, `file` is project-relative (dropped outside the project, REVIEW-3 #4).
 * The checker's own message text is never passed on.
 */
export function violationForAgent(v: ContractViolation, ctx: { root?: string; exchange?: Exchange; redact: boolean }): Record<string, unknown> {
  const rel = projectRelative(v.file, ctx.root);
  const actual = actualCategory(v.actual);
  const p = agentPath(v.path);
  const what = actual === 'missing' ? 'is missing' : actual === 'unknown enum value' ? 'has an unknown enum value' : actual === 'other' ? 'has an unexpected value' : `is ${actual}`;
  const message =
    `${v.key} ${what} at ${p}: ${v.model}.${v.field} expects ${v.expected}` +
    (v.severity === 'error' ? ', so fromJson would throw' : ' (suspicious; fromJson would not throw)');
  return {
    path: p,
    model: v.model,
    field: v.field,
    key: v.key,
    expected: v.expected,
    actual,
    severity: v.severity,
    message,
    ...(rel ? { file: rel } : {}),
    ...(rel && v.line !== undefined ? { line: v.line } : {}),
  };
}

/** A ContractResult as agents see it (see violationForAgent). */
export function contractForAgent(r: ContractResult, ctx: { root?: string; exchange?: Exchange; redact: boolean }): Record<string, unknown> {
  const e = ctx.exchange;
  return {
    exchangeId: r.exchangeId,
    ...(e ? { method: e.method, url: ctx.redact ? redactUrl(e.url) : e.url, ...(e.status !== undefined ? { status: e.status } : {}) } : {}),
    checked: r.checked,
    ...(r.model ? { model: r.model } : {}),
    ...(r.listOf ? { listOf: true } : {}),
    via: r.via,
    ...(r.reason ? { reason: r.reason } : {}),
    errors: r.violations.filter((v) => v.severity === 'error').length,
    warnings: r.violations.filter((v) => v.severity === 'warning').length,
    violations: r.violations.map((v) => violationForAgent(v, ctx)),
  };
}

// ------------------------------------------------------------------ fixtures: the Retrofit interface (mocktail)

/** How well `ep` matches a request: the number of literal path characters, or undefined when it doesn't. */
export function endpointScore(ep: ApiEndpoint, method: string, url: string): number | undefined {
  if (ep.method.toUpperCase() !== method.toUpperCase()) return undefined;
  let target: string;
  try {
    const u = new URL(url);
    target = /^https?:\/\//i.test(ep.pathTemplate) ? `${u.origin}${u.pathname}` : u.pathname;
  } catch {
    return undefined;
  }
  const tpl = ep.pathTemplate.split(/[?#]/)[0].replace(/\/+$/, '') || '/';
  const re = new RegExp(`${/^https?:/i.test(tpl) ? '^' : '(^|/)'}${tpl.replace(/^\//, '').split(/\{[^}/]*\}/).map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('[^/]+')}/?$`);
  return re.test(target) ? tpl.replace(/\{[^}/]*\}/g, '').length : undefined;
}

/** `package:<pkg>/<path under lib>` for a file in the project's lib/, else undefined. */
export function packageUri(file: string | undefined, root: string | undefined, pkg: string | undefined): string | undefined {
  if (!pkg) return undefined;
  const rel = projectRelative(file, root);
  return rel?.startsWith('lib/') ? `package:${pkg}/${rel.slice(4)}` : undefined;
}

/**
 * The Retrofit/Chopper class a mocktail fixture test mocks: the class whose endpoints match most of the
 * exchanges (best literal match per exchange). Its endpoints, its import and the package URIs of its response
 * models. Undefined when no annotated endpoint matches.
 */
export function fixtureApiFor(
  endpoints: ApiEndpoint[],
  exchanges: Pick<Exchange, 'method' | 'url'>[],
  models: { name: string; file: string }[],
  ctx: { root?: string; packageName?: string },
): FixtureApi | undefined {
  const votes = new Map<string, { n: number; score: number }>();
  for (const e of exchanges) {
    let best: { cls: string; score: number } | undefined;
    for (const ep of endpoints) {
      if (!ep.className) continue;
      const score = endpointScore(ep, e.method, e.url);
      if (score !== undefined && (!best || score > best.score)) best = { cls: ep.className, score };
    }
    if (!best) continue;
    const v = votes.get(best.cls) ?? { n: 0, score: 0 };
    votes.set(best.cls, { n: v.n + 1, score: Math.max(v.score, best.score) });
  }
  const pick = [...votes.entries()].sort((a, b) => b[1].n - a[1].n || b[1].score - a[1].score)[0]?.[0];
  if (!pick) return undefined;
  const eps = endpoints.filter((ep) => ep.className === pick);
  const imports = new Set<string>();
  for (const ep of eps) if (ep.importUri) imports.add(ep.importUri);
  for (const name of new Set(eps.map((ep) => ep.responseModel).filter((m): m is string => !!m))) {
    const uri = packageUri(models.find((m) => m.name === name)?.file, ctx.root, ctx.packageName);
    if (uri) imports.add(uri);
  }
  return { className: pick, ...(imports.size ? { imports: [...imports] } : {}), endpoints: eps };
}

/** `test` for a pure Dart package (no `flutter` dependency in pubspec.yaml), else undefined (= flutter_test). */
export function testPackageFor(root: string | undefined, read: (file: string) => string = (f) => fs.readFileSync(f, 'utf8')): 'test' | undefined {
  if (!root) return undefined;
  try {
    return parsePubspecDeps(read(path.join(root, 'pubspec.yaml'))).dependencies.has('flutter') ? undefined : 'test';
  } catch {
    return undefined;
  }
}
