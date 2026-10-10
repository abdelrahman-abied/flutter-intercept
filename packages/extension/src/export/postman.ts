/**
 * Postman Collection v2.1 export of recorded traffic (CONTRACTS §13.5). Pure: no vscode, no fs.
 *
 * - A folder per host; one request per route (method + path template; a GraphQL endpoint: per operation), built
 *   from the latest sample; the latest sample of each status is saved as an example response.
 * - Each origin is a collection variable (`{{baseUrl}}`, `{{baseUrl2}}`, …); id path segments are `:id` path
 *   variables carrying the latest value.
 * - Redaction (default on): sensitive request header values become `{{<header name>}}` variables, declared empty
 *   in `variable` for the user to fill in; other header values, URLs and bodies are redacted like HAR exports
 *   (CONTRACTS §8). Bodies (requests and examples) longer than `maxExampleChars` are cut, with a note.
 */
import type { Body, Exchange } from '@flutter-intercept/proxy';
import type { ExportOptions, ExportResult, ToPostman } from './types';
import { prettyJson } from '../codegen/json';
import { isSensitiveHeader, redactBodyText, redactHeaders, redactSecretValues, redactUrl, REDACTED } from '../agent/redact';
import {
  bodyMediaType,
  cut,
  DEFAULT_MAX_EXAMPLE_CHARS,
  hasBody,
  isJsonMediaType,
  plural,
  reasonPhrase,
  selectExchanges,
  type Headers,
  type Sample,
} from './common';

type Json = Record<string, unknown>;

export const POSTMAN_SCHEMA = 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json';

/** Connection-level headers Postman sets itself (or that mean nothing in a saved request). */
const DROP_HEADERS = new Set(['host', 'content-length', 'connection', 'keep-alive', 'transfer-encoding', 'proxy-connection', 'te', 'upgrade']);

interface Route {
  key: string;
  origin: string;
  host: string;
  method: string;
  /** `/users/:id` */
  postmanPath: string;
  graphqlOperation?: string;
  samples: Sample[];
}

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/** A variable name for a header: `X-Api-Key` → `x-api-key` (Postman allows any text; keep it readable). */
function headerVariable(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9_.-]+/g, '_');
}

/** Postman's raw-body language from a media type. */
function rawLanguage(mt: string): string {
  if (isJsonMediaType(mt)) return 'json';
  if (mt.includes('xml')) return 'xml';
  if (mt.includes('html')) return 'html';
  if (mt.includes('javascript')) return 'javascript';
  return 'text';
}

class Builder {
  readonly notes: string[] = [];
  /** Header variables to declare (empty), in first-use order. */
  readonly headerVars: string[] = [];
  private readonly redact: boolean;
  private readonly maxChars: number;
  /** Bodies counted for the notes (each once, though a sample's request appears in its item and examples). */
  private readonly cutBodies = new Set<Body>();
  private readonly binaryBodies = new Set<Body>();

  constructor(
    opts: ExportOptions,
    private readonly baseVar: (origin: string) => string,
  ) {
    this.redact = opts.redact !== false;
    this.maxChars = Math.max(1, opts.maxExampleChars ?? DEFAULT_MAX_EXAMPLE_CHARS);
  }

  finishNotes(): void {
    if (this.cutBodies.size) this.notes.push(`${plural(this.cutBodies.size, 'body', 'bodies')} cut at ${this.maxChars} characters`);
    if (this.binaryBodies.size) this.notes.push(`${plural(this.binaryBodies.size, 'binary body', 'binary bodies')} left out (Postman raw bodies are text)`);
    if (this.redact && this.headerVars.length) {
      this.notes.push(`Secret headers are variables to fill in: ${this.headerVars.map((v) => `{{${v}}}`).join(', ')}`);
    }
  }

  private requestHeaders(h: Headers | undefined): Json[] {
    const out: Json[] = [];
    const safe = this.redact ? redactHeaders(h) : h;
    for (const [name, v] of Object.entries(h ?? {})) {
      const lower = name.toLowerCase();
      if (DROP_HEADERS.has(lower) || name.startsWith(':')) continue;
      const values = Array.isArray(v) ? v : [v];
      if (this.redact && isSensitiveHeader(name)) {
        const variable = headerVariable(name);
        if (!this.headerVars.includes(variable)) this.headerVars.push(variable);
        for (let i = 0; i < values.length; i++) out.push({ key: name, value: `{{${variable}}}` });
        continue;
      }
      const shown = safe?.[name] ?? v;
      for (const value of Array.isArray(shown) ? shown : [shown]) out.push({ key: name, value });
    }
    return out;
  }

  private responseHeaders(h: Headers | undefined): Json[] {
    const out: Json[] = [];
    const shown = this.redact ? redactHeaders(h) : h;
    for (const [name, v] of Object.entries(shown ?? {})) {
      if (name.startsWith(':')) continue;
      for (const value of Array.isArray(v) ? v : [v]) out.push({ key: name, value });
    }
    return out;
  }

  /** A body as text for Postman (redacted, cut), or undefined for none / binary. */
  private bodyText(b: Body | undefined, h: Headers | undefined): { text: string; mediaType: string } | undefined {
    if (!hasBody(b)) return undefined;
    if (b.encoding !== 'utf8') {
      this.binaryBodies.add(b);
      return undefined;
    }
    const mediaType = bodyMediaType(b, h);
    let text = this.redact ? redactBodyText(b.text, h) : b.text;
    if (isJsonMediaType(mediaType) && !b.truncated) {
      try {
        text = prettyJson(text); // re-indented without touching a literal
      } catch {
        // not valid JSON: as recorded
      }
    }
    const c = cut(text, this.maxChars);
    if (c.cut || b.truncated) this.cutBodies.add(b);
    return { text: c.text, mediaType };
  }

  url(route: Route, s: Sample): Json {
    let u: URL | undefined;
    try {
      u = new URL(this.redact ? redactUrl(s.e.url) : s.e.url);
    } catch {
      u = undefined; // never fall back to the unredacted URL: the query is left out instead
    }
    const base = `{{${this.baseVar(route.origin)}}}`;
    const path = route.postmanPath.split('/').slice(1);
    const query: Json[] = [];
    u?.searchParams.forEach((value, key) => query.push({ key, value }));
    const variable: Json[] = [];
    s.params.forEach((name, i) => {
      if (!name) return;
      const raw = safeDecode(s.segments[i]);
      variable.push({ key: name, value: this.redact && redactSecretValues(raw, true) !== raw ? REDACTED : raw });
    });
    const search = u?.search ?? '';
    return {
      raw: `${base}${route.postmanPath}${search}`,
      host: [base],
      path,
      ...(query.length ? { query } : {}),
      ...(variable.length ? { variable } : {}),
    };
  }

  request(route: Route, s: Sample): Json {
    const req: Json = { method: route.method, header: this.requestHeaders(s.e.requestHeaders), url: this.url(route, s) };
    const body = this.bodyText(s.e.requestBody, s.e.requestHeaders);
    if (body) req.body = { mode: 'raw', raw: body.text, options: { raw: { language: rawLanguage(body.mediaType) } } };
    return req;
  }

  /** Saved example: the response of sample `s`, with the request that got it. */
  example(route: Route, s: Sample): Json {
    const code = s.e.status!;
    const body = this.bodyText(s.e.responseBody, s.e.responseHeaders);
    const status = reasonPhrase(code);
    return {
      name: `${code}${status ? ` ${status}` : ''}`,
      originalRequest: this.request(route, s),
      status,
      code,
      _postman_previewlanguage: body ? rawLanguage(body.mediaType) : 'text',
      header: this.responseHeaders(s.e.responseHeaders),
      cookie: [],
      body: body?.text ?? '',
    };
  }

  item(route: Route): Json {
    const latest = route.samples[route.samples.length - 1];
    const latestByStatus = new Map<number, Sample>();
    for (const s of route.samples) latestByStatus.set(s.e.status!, s);
    const name = `${route.method} ${route.postmanPath}${route.graphqlOperation ? ` — ${route.graphqlOperation}` : ''}`;
    return {
      name,
      request: { ...this.request(route, latest), description: `Recorded ${plural(route.samples.length, 'time')}.` },
      response: [...latestByStatus.keys()].sort((a, b) => a - b).map((st) => this.example(route, latestByStatus.get(st)!)),
    };
  }
}

export const toPostman: ToPostman = (exchanges: readonly Exchange[], opts: ExportOptions): ExportResult => {
  const { samples, notes } = selectExchanges(exchanges);

  const origins: string[] = [];
  const routes = new Map<string, Route>();
  for (const s of samples) {
    if (!origins.includes(s.origin)) origins.push(s.origin);
    const postmanPath = '/' + s.segments.map((seg, i) => (s.params[i] ? `:${s.params[i]}` : seg)).join('/');
    const g = s.e.graphql;
    const graphqlOperation = g ? `${g.operationType ?? 'query'} ${g.operationName ?? '(anonymous)'}` : undefined;
    const key = `${s.origin} ${s.method} ${postmanPath}${graphqlOperation ? ` ${graphqlOperation}` : ''}`;
    let r = routes.get(key);
    if (!r) routes.set(key, (r = { key, origin: s.origin, host: s.host, method: s.method, postmanPath, graphqlOperation, samples: [] }));
    r.samples.push(s);
  }
  const baseVars = new Map(origins.map((o, i) => [o, i === 0 ? 'baseUrl' : `baseUrl${i + 1}`]));
  const b = new Builder(opts, (o) => baseVars.get(o)!);
  b.notes.push(...notes);

  // folders by host (first-seen order), requests sorted by path, then method
  const folders = new Map<string, Route[]>();
  for (const o of origins) {
    const host = new URL(o).host;
    if (!folders.has(host)) folders.set(host, []);
  }
  for (const r of routes.values()) folders.get(r.host)!.push(r);
  const item: Json[] = [];
  for (const [host, list] of folders) {
    list.sort((x, y) => (x.postmanPath < y.postmanPath ? -1 : x.postmanPath > y.postmanPath ? 1 : x.method < y.method ? -1 : x.method > y.method ? 1 : (x.graphqlOperation ?? '') < (y.graphqlOperation ?? '') ? -1 : 1));
    const hostOrigins = origins.filter((o) => new URL(o).host === host);
    item.push({
      name: host,
      description: hostOrigins.map((o) => `{{${baseVars.get(o)}}} = ${o}`).join('\n'),
      item: list.map((r) => b.item(r)),
    });
  }
  b.finishNotes();

  const redact = opts.redact !== false;
  const variable: Json[] = [
    ...origins.map((o) => ({ key: baseVars.get(o)!, value: o, type: 'string' })),
    ...b.headerVars.map((key) => ({ key, value: '', type: 'string' })),
  ];
  const collection: Json = {
    info: {
      name: opts.title || 'Recorded API',
      description:
        `Generated by Flutter Intercept from ${plural(samples.length, 'recorded request')}.` +
        (redact && b.headerVars.length ? ' Secret header values are collection variables: fill them in under Variables.' : '') +
        (redact ? ' Secrets in URLs and bodies are redacted.' : ''),
      schema: POSTMAN_SCHEMA,
    },
    item,
    variable,
  };
  return { text: JSON.stringify(collection, null, 2), exchanges: samples.length, routes: routes.size, notes: b.notes };
};
