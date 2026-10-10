/**
 * OpenAPI 3.1 export of recorded traffic (CONTRACTS §13.5). Pure: no vscode, no fs.
 *
 * - `servers`: one per origin; a path served by only some of them carries its own `servers` (and an operation
 *   whose origins differ from its path's carries its own too). Paths are shared when the templates agree.
 * - Paths: `routeTemplate`-style (`/users/{id}`), every `{param}` declared as a required path parameter whose
 *   schema comes from the observed values (integer / uuid / string).
 * - Query parameters seen, `required` when present in every sample; repeated ones are arrays.
 * - Request body per media type, response per status + media type; JSON bodies get a schema inferred from ALL
 *   samples (`codegen/infer.ts` shapes → JSON Schema: `required` = present in every object, nullable via
 *   `type: [..., "null"]`, id-keyed objects → `additionalProperties`) and ONE example (the latest sample,
 *   redacted, embedded verbatim; over `maxExampleChars` it is cut and becomes a string example with a note).
 *   Non-JSON (or binary, or truncated) bodies: the media type only.
 * - `operationId` from method + path, unique. GraphQL: one path; the operations seen are listed in the description.
 */
import type { Body, Exchange } from '@flutter-intercept/proxy';
import type { ExportOptions, ExportResult, ToOpenApi } from './types';
import { inferShape, mergeShapes, type Shape } from '../codegen/infer';
import { parseJsonSample } from '../codegen/json';
import { isIdSegment } from '../codegen/route';
import { pascalCase } from '../codegen/naming';
import { redactBodyText, redactSecretValues, redactUrl, REDACTED } from '../agent/redact';
import {
  bodyMediaType,
  cut,
  DEFAULT_MAX_EXAMPLE_CHARS,
  hasBody,
  isJsonMediaType,
  jsonWithRaw,
  plural,
  RawJson,
  reasonPhrase,
  selectExchanges,
  type Headers,
  type Sample,
} from './common';

type Json = Record<string, unknown>;
type BodyItem = Body & { headers: Headers | undefined };

/** Path Item keys OpenAPI 3.1 allows; other methods (WebDAV …) can't be described. */
const OPENAPI_METHODS = new Set(['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace']);
const METHOD_ORDER = ['get', 'post', 'put', 'patch', 'delete', 'head', 'options', 'trace'];

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const INT = /^-?\d+$/;
const NUMBER = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/;

interface Operation {
  method: string; // lower case
  template: string;
  params: (string | undefined)[];
  samples: Sample[];
}

// ------------------------------------------------------------------ JSON Schema from inferred shapes

/** JSON Schema (2020-12, as OpenAPI 3.1 uses it) for an inferred shape. */
export function shapeToSchema(s: Shape): Json {
  let schema: Json;
  switch (s.kind) {
    case 'none':
      // only nulls → null; only items of empty arrays → anything
      return s.nullable ? { type: 'null' } : {};
    case 'dynamic':
      // values of different types (the shape doesn't keep which)
      return {};
    case 'bool':
      schema = { type: 'boolean' };
      break;
    case 'int':
      schema = { type: 'integer' };
      break;
    case 'double':
      schema = { type: 'number' };
      break;
    case 'string':
      schema = { type: 'string' };
      break;
    case 'list':
      schema = { type: 'array', items: shapeToSchema(s.of!) };
      break;
    case 'object': {
      const fields = s.fields!;
      if (fields.size > 0 && [...fields.keys()].every((k) => isIdSegment(k))) {
        // `{"17": {...}, "42": {...}}`: a map keyed by ids, not fields
        let merged: Shape = { kind: 'none', nullable: false };
        for (const f of fields.values()) merged = mergeShapes(merged, f.shape);
        schema = { type: 'object', additionalProperties: shapeToSchema(merged) };
        break;
      }
      const properties: Json = {};
      const required: string[] = [];
      for (const [k, f] of fields) {
        properties[k] = shapeToSchema(f.shape);
        if (f.present >= s.count!) required.push(k);
      }
      schema = { type: 'object', properties, ...(required.length ? { required } : {}) };
      break;
    }
  }
  if (s.nullable) schema.type = [schema.type, 'null'];
  return schema;
}

/** Schema for path / query values (always strings on the wire). */
function valueSchema(values: readonly string[]): Json {
  if (values.length && values.every((v) => INT.test(v))) return { type: 'integer' };
  if (values.length && values.every((v) => NUMBER.test(v))) return { type: 'number' };
  if (values.length && values.every((v) => v === 'true' || v === 'false')) return { type: 'boolean' };
  if (values.length && values.every((v) => UUID.test(v))) return { type: 'string', format: 'uuid' };
  return { type: 'string' };
}

/** A typed example for a wire value, matching `valueSchema`. */
function typedExample(value: string, schema: Json): unknown {
  if (value === REDACTED) return value;
  if (schema.type === 'integer' || schema.type === 'number') {
    const n = Number(value);
    return Number.isSafeInteger(n) || (schema.type === 'number' && Number.isFinite(n)) ? n : value;
  }
  if (schema.type === 'boolean') return value === 'true';
  return value;
}

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

// ------------------------------------------------------------------ operation ids

function operationIdBase(method: string, template: string): string {
  const parts = template
    .split('/')
    .filter(Boolean)
    .map((seg) => {
      const p = /^\{(.+)\}$/.exec(seg);
      return p ? `By${pascalCase(p[1])}` : pascalCase(safeDecode(seg));
    });
  const tail = parts.join('') || 'Root';
  return method.toLowerCase() + tail;
}

// ------------------------------------------------------------------ the builder

class Builder {
  readonly notes: string[] = [];
  private readonly redact: boolean;
  private readonly maxChars: number;
  private cutExamples = 0;
  private unparsed = 0;

  constructor(opts: ExportOptions) {
    this.redact = opts.redact !== false;
    this.maxChars = Math.max(1, opts.maxExampleChars ?? DEFAULT_MAX_EXAMPLE_CHARS);
  }

  finishNotes(): void {
    if (this.cutExamples) this.notes.push(`${plural(this.cutExamples, 'example')} cut at ${this.maxChars} characters`);
    if (this.unparsed) this.notes.push(`${plural(this.unparsed, 'JSON body', 'JSON bodies')} not used for schemas (truncated or not valid JSON)`);
  }

  /** `content` for a set of bodies (request or one response status), keyed by media type. */
  content(items: BodyItem[]): Json {
    const byType = new Map<string, typeof items>();
    for (const it of items) {
      const mt = bodyMediaType(it, it.headers);
      const list = byType.get(mt) ?? [];
      list.push(it);
      byType.set(mt, list);
    }
    const out: Json = {};
    for (const [mt, list] of byType) out[mt] = isJsonMediaType(mt) ? this.jsonMedia(list) : {};
    return out;
  }

  private jsonMedia(list: BodyItem[]): Json {
    const values: unknown[] = [];
    let latest: BodyItem | undefined;
    for (const it of list) {
      if (it.encoding !== 'utf8' || it.truncated) {
        this.unparsed++;
        continue;
      }
      try {
        values.push(parseJsonSample(it.text));
        latest = it;
      } catch {
        this.unparsed++;
      }
    }
    if (!values.length || !latest) return {};
    const media: Json = { schema: shapeToSchema(inferShape(values)) };
    const text = this.redact ? redactBodyText(latest.text, latest.headers) : latest.text;
    const c = cut(text, this.maxChars);
    if (c.cut) {
      this.cutExamples++;
      media.examples = { recorded: { summary: `Recorded sample, cut at ${this.maxChars} characters (not valid JSON)`, value: c.text } };
    } else {
      media.example = new RawJson(text);
    }
    return media;
  }

  parameters(op: Operation): Json[] {
    const out: Json[] = [];
    const latest = op.samples[op.samples.length - 1];
    // path parameters
    op.params.forEach((name, i) => {
      if (!name) return;
      const values = op.samples.map((s) => safeDecode(s.segments[i]));
      const schema = valueSchema(values);
      const raw = safeDecode(latest.segments[i]);
      const param: Json = { name, in: 'path', required: true, schema };
      // A credential-looking segment never becomes an example (it's somebody's token); with redaction, neither
      // does an id that looks like one (redactUrl's path rule).
      if (isIdSegment(raw) && (!this.redact || redactSecretValues(raw, true) === raw)) param.example = typedExample(raw, schema);
      out.push(param);
    });
    // query parameters
    const seen = new Map<string, { count: number; values: string[]; repeated: boolean }>();
    for (const s of op.samples) {
      const counts = new Map<string, number>();
      let params: URLSearchParams;
      try {
        params = new URL(s.e.url).searchParams;
      } catch {
        continue;
      }
      params.forEach((value, name) => {
        counts.set(name, (counts.get(name) ?? 0) + 1);
        const q = seen.get(name) ?? { count: 0, values: [], repeated: false };
        q.values.push(value);
        seen.set(name, q);
      });
      for (const [name, n] of counts) {
        const q = seen.get(name)!;
        q.count++;
        if (n > 1) q.repeated = true;
      }
    }
    let latestParams: URLSearchParams | undefined;
    try {
      latestParams = new URL(this.redact ? redactUrl(latest.e.url) : latest.e.url).searchParams;
    } catch {
      latestParams = undefined;
    }
    for (const [name, q] of seen) {
      const item = valueSchema(q.values);
      const schema = q.repeated ? { type: 'array', items: item } : item;
      const param: Json = { name, in: 'query', required: q.count === op.samples.length, schema };
      const ex = latestParams?.getAll(name) ?? [];
      if (ex.length) param.example = q.repeated ? ex.map((v) => typedExample(v, item)) : typedExample(ex[0], item);
      out.push(param);
    }
    return out;
  }

  operation(op: Operation, operationId: string): Json {
    const n = op.samples.length;
    const graphql = op.samples.some((s) => s.e.graphql);
    const out: Json = { operationId, summary: `${op.method.toUpperCase()} ${op.template}` };
    const description: string[] = [`Recorded ${plural(n, 'time')}.`];
    if (graphql) description.push(graphqlDescription(op.samples));
    out.description = description.join('\n\n');
    const parameters = this.parameters(op);
    if (parameters.length) out.parameters = parameters;
    // request body
    const withBody = op.samples.filter((s) => hasBody(s.e.requestBody));
    if (withBody.length) {
      out.requestBody = {
        required: withBody.length === n,
        content: this.content(withBody.map((s) => ({ ...s.e.requestBody!, headers: s.e.requestHeaders }))),
      };
    }
    // responses, by status
    const byStatus = new Map<string, Sample[]>();
    for (const s of op.samples) {
      const st = s.e.status!;
      const key = Number.isInteger(st) && st >= 100 && st <= 599 ? String(st) : 'default';
      const list = byStatus.get(key) ?? [];
      list.push(s);
      byStatus.set(key, list);
    }
    const responses: Json = {};
    for (const key of [...byStatus.keys()].sort()) {
      const list = byStatus.get(key)!;
      const res: Json = { description: (key === 'default' ? '' : reasonPhrase(Number(key))) || 'Response' };
      const bodies = list.filter((s) => hasBody(s.e.responseBody));
      if (bodies.length) res.content = this.content(bodies.map((s) => ({ ...s.e.responseBody!, headers: s.e.responseHeaders })));
      responses[key] = res;
    }
    out.responses = responses;
    return out;
  }
}

function graphqlDescription(samples: readonly Sample[]): string {
  const ops = new Map<string, number>();
  for (const s of samples) {
    const g = s.e.graphql;
    if (!g) continue;
    const label = `${g.operationType ?? 'query'} ${g.operationName ?? '(anonymous)'}${g.persisted ? ' (persisted)' : ''}${g.batch ? ` (batch of ${g.batch})` : ''}`;
    ops.set(label, (ops.get(label) ?? 0) + 1);
  }
  const lines = [...ops].map(([label, count]) => `- \`${label}\`${count > 1 ? ` × ${count}` : ''}`);
  return `GraphQL endpoint. Operations seen:\n${lines.join('\n')}`;
}

function sameSet(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  return a.size === b.size && [...a].every((x) => b.has(x));
}

export const toOpenApi: ToOpenApi = (exchanges: readonly Exchange[], opts: ExportOptions): ExportResult => {
  const { samples, notes } = selectExchanges(exchanges);
  const b = new Builder(opts);
  b.notes.push(...notes);

  const origins: string[] = [];
  const ops = new Map<string, Operation>();
  const unsupported = new Map<string, number>();
  let used = 0;
  for (const s of samples) {
    const method = s.method.toLowerCase();
    if (!OPENAPI_METHODS.has(method)) {
      unsupported.set(s.method, (unsupported.get(s.method) ?? 0) + 1);
      continue;
    }
    used++;
    if (!origins.includes(s.origin)) origins.push(s.origin);
    const key = `${method} ${s.template}`;
    let op = ops.get(key);
    if (!op) ops.set(key, (op = { method, template: s.template, params: s.params, samples: [] }));
    op.samples.push(s);
  }
  for (const [m, n] of unsupported) b.notes.push(`${plural(n, `${m} exchange`)} skipped (OpenAPI 3.1 has no ${m} operations)`);

  // paths in a stable order: by template, then method
  const byPath = new Map<string, Operation[]>();
  for (const op of [...ops.values()].sort((x, y) => (x.template < y.template ? -1 : x.template > y.template ? 1 : METHOD_ORDER.indexOf(x.method) - METHOD_ORDER.indexOf(y.method)))) {
    const list = byPath.get(op.template) ?? [];
    list.push(op);
    byPath.set(op.template, list);
  }

  const allOrigins = new Set(origins);
  const ids = new Set<string>();
  const paths: Json = {};
  for (const [template, list] of byPath) {
    const item: Json = {};
    const pathOrigins = new Set(list.flatMap((op) => op.samples.map((s) => s.origin)));
    const pathScoped = !sameSet(pathOrigins, allOrigins);
    if (pathScoped) item.servers = origins.filter((o) => pathOrigins.has(o)).map((url) => ({ url }));
    for (const op of list) {
      const base = operationIdBase(op.method, template);
      let id = base;
      for (let i = 2; ids.has(id); i++) id = `${base}${i}`;
      ids.add(id);
      const operation = b.operation(op, id);
      const opOrigins = new Set(op.samples.map((s) => s.origin));
      if (!sameSet(opOrigins, pathOrigins)) operation.servers = origins.filter((o) => opOrigins.has(o)).map((url) => ({ url }));
      item[op.method] = operation;
    }
    paths[template] = item;
  }
  b.finishNotes();

  const redact = opts.redact !== false;
  const doc: Json = {
    openapi: '3.1.0',
    info: {
      title: opts.title || 'Recorded API',
      version: '1.0.0',
      description:
        `Generated by Flutter Intercept from ${plural(used, 'recorded request')}. Schemas are inferred from what was seen, ` +
        `not from the server's own definition.` +
        (redact ? ' Secrets in examples are redacted.' : ''),
    },
    servers: origins.map((url) => ({ url })),
    paths,
  };
  return { text: jsonWithRaw(doc), exchanges: used, routes: ops.size, notes: b.notes };
};
