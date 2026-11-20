/**
 * Swagger 2.0 (OpenAPI 2) documents (CONTRACTS §24.4). Pure: no vscode, no fs, no network.
 *
 * `swagger2ToOas3` rewrites the document as OpenAPI 3.0 and `parseSwagger2` hands that to `parseOpenApi` (§21.3), so
 * both formats share one endpoint / example / schema policy. The conversion is bounded by the §21.3 walk budget: schemas
 * are copied iteratively (no recursion, so no input can exhaust the stack), shared values (YAML aliases) are copied
 * once and stay shared, cycles stop, and example values are referenced, not copied.
 */
import { parseOpenApi } from './openapi';
import {
  addProblem,
  createWalkBudget,
  dict,
  hasOwn,
  isObj,
  MAX_QUOTED_URL_CHARS,
  quoteFileText,
  resolvePointer,
  setProp,
  touchNode,
  utf8Bytes,
  type Dict,
  type WalkBudget,
} from './ref';
import { COLLECTION_LIMITS, type CollectionVars, type ParsedCollection } from './types';
import { isYamlFile, parseYaml } from './yaml';

const HTTP_METHODS = ['get', 'put', 'post', 'delete', 'patch', 'head', 'options'];
/** Nesting kept when copying a schema; deeper values become `{}` (one problem line). */
const MAX_COPY_DEPTH = 128;
/** Media types read from one `consumes` / `produces` list. */
const MAX_MEDIA_TYPES = 10;
/** Keys whose values are data, not schemas: shared as they are, never rewritten. */
const PLAIN_KEYS = new Set(['example', 'default', 'enum', 'const', 'examples', 'x-example', 'x-examples']);
/** Schema keywords whose value maps names to schemas. */
const SCHEMA_MAPS = new Set(['properties', 'patternProperties']);
/** Swagger parameter keys that describe the value: they move into the OAS3 parameter's `schema`. */
const PARAM_SCHEMA_KEYS = [
  'type',
  'format',
  'items',
  'default',
  'maximum',
  'exclusiveMaximum',
  'minimum',
  'exclusiveMinimum',
  'maxLength',
  'minLength',
  'pattern',
  'maxItems',
  'minItems',
  'uniqueItems',
  'enum',
  'multipleOf',
  'x-nullable',
];

interface Ctx {
  src: Dict;
  budget: WalkBudget;
  problems: string[];
  /** Source schema value → its copy (shared values stay shared, cycles stop). */
  memo: Map<object, unknown>;
  deepWarned: boolean;
}

function own(o: Dict, key: string): unknown {
  return hasOwn(o, key) ? Object.getOwnPropertyDescriptor(o, key)?.value : undefined;
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

function mediaList(v: unknown): string[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out: string[] = [];
  for (const m of v.slice(0, MAX_MEDIA_TYPES)) {
    if (typeof m === 'string' && m.trim() !== '' && !out.includes(m.trim())) out.push(m.trim());
  }
  return out.length > 0 ? out : undefined;
}

/** `#/definitions/X` → `#/components/schemas/X` (and parameters, responses, securityDefinitions). Others unchanged. */
export function rewriteRef(ref: string): string {
  if (ref.startsWith('#/definitions/')) return `#/components/schemas/${ref.slice(14)}`;
  if (ref.startsWith('#/parameters/')) return `#/components/parameters/${ref.slice(13)}`;
  if (ref.startsWith('#/responses/')) return `#/components/responses/${ref.slice(12)}`;
  if (ref.startsWith('#/securityDefinitions/')) return `#/components/securitySchemes/${ref.slice(22)}`;
  return ref;
}

/**
 * Copies a Swagger schema as an OAS3 schema: `$ref`s rewritten, `x-nullable: true` → `nullable: true`, `type: file`
 * → `string` / `binary`, a string `discriminator` → `{ propertyName }`. Iterative and budgeted.
 */
function copySchema(value: unknown, ctx: Ctx, isMap = false): unknown {
  if (typeof value !== 'object' || value === null) return value;
  const hit = ctx.memo.get(value);
  if (hit !== undefined) return hit;
  const rootCopy: unknown = Array.isArray(value) ? [] : dict();
  ctx.memo.set(value, rootCopy);
  // `map`: an object whose every value is a schema (`definitions`, `properties`): its keys are names, not keywords.
  const stack: { s: object; t: unknown; depth: number; map: boolean }[] = [{ s: value, t: rootCopy, depth: 0, map: isMap }];

  const child = (v: unknown, depth: number, map = false): unknown => {
    if (typeof v !== 'object' || v === null) return v;
    const seen = ctx.memo.get(v);
    if (seen !== undefined) return seen;
    if (depth > MAX_COPY_DEPTH) {
      if (!ctx.deepWarned) {
        ctx.deepWarned = true;
        addProblem(ctx.problems, `Schema nesting deeper than ${MAX_COPY_DEPTH} levels was cut`);
      }
      return dict();
    }
    const t: unknown = Array.isArray(v) ? [] : dict();
    ctx.memo.set(v, t);
    stack.push({ s: v, t, depth, map });
    return t;
  };

  while (stack.length > 0) {
    const { s, t, depth, map } = stack.pop()!;
    if (!touchNode(ctx.budget, ctx.problems)) break;
    if (Array.isArray(s)) {
      const arr = t as unknown[];
      for (let i = 0; i < s.length; i++) {
        if (!touchNode(ctx.budget, ctx.problems)) break;
        arr.push(child(s[i], depth + 1));
      }
      continue;
    }
    const so = s as Dict;
    const to = t as Dict;
    for (const k of Object.keys(so)) {
      if (!touchNode(ctx.budget, ctx.problems)) break;
      const v = own(so, k);
      if (map) {
        setProp(to, k, child(v, depth + 1));
      } else if (k === '$ref' && typeof v === 'string') {
        setProp(to, k, rewriteRef(v));
      } else if (k === 'x-nullable') {
        setProp(to, k, v);
        if (v === true) setProp(to, 'nullable', true);
      } else if (k === 'type' && v === 'file') {
        setProp(to, 'type', 'string');
        if (!hasOwn(so, 'format')) setProp(to, 'format', 'binary');
      } else if (k === 'discriminator' && typeof v === 'string') {
        const d = dict();
        setProp(d, 'propertyName', v);
        setProp(to, k, d);
      } else if (PLAIN_KEYS.has(k)) {
        setProp(to, k, v);
      } else {
        setProp(to, k, child(v, depth + 1, SCHEMA_MAPS.has(k)));
      }
    }
  }
  return rootCopy;
}

/** Follows local `$ref`s inside the Swagger document (parameters, responses), ≤ 12 hops, cycles stop. */
function resolveLocal(value: unknown, ctx: Ctx, context: string): Dict | undefined {
  let cur = value;
  const seen = new Set<string>();
  for (let hops = 0; isObj(cur) && typeof own(cur, '$ref') === 'string'; hops++) {
    if (!touchNode(ctx.budget, ctx.problems, context)) return undefined;
    const ref = own(cur, '$ref') as string;
    if (!ref.startsWith('#/')) {
      addProblem(ctx.problems, `${context}: external $ref "${quoteFileText(ref, MAX_QUOTED_URL_CHARS)}" is not followed (skipped)`);
      return undefined;
    }
    if (seen.has(ref) || hops >= COLLECTION_LIMITS.generateDepth) {
      addProblem(ctx.problems, `${context}: circular or too deep $ref "${quoteFileText(ref)}" (skipped)`);
      return undefined;
    }
    seen.add(ref);
    const hit = resolvePointer(ctx.src, ref);
    if (!hit.found) {
      addProblem(ctx.problems, `${context}: unresolved $ref "${quoteFileText(ref)}" (skipped)`);
      return undefined;
    }
    cur = hit.value;
  }
  return isObj(cur) ? cur : undefined;
}

// ------------------------------------------------------------------ parameters and request bodies

function paramSchema(p: Dict, ctx: Ctx): Dict {
  const s = dict();
  for (const k of PARAM_SCHEMA_KEYS) {
    if (hasOwn(p, k)) setProp(s, k, own(p, k));
  }
  return copySchema(s, ctx) as Dict;
}

/** A non-body Swagger parameter as an OAS3 parameter. */
function convertParam(p: Dict, ctx: Ctx): Dict {
  const out = dict();
  for (const k of ['name', 'in', 'description', 'required', 'deprecated', 'allowEmptyValue']) {
    if (hasOwn(p, k)) setProp(out, k, own(p, k));
  }
  setProp(out, 'schema', paramSchema(p, ctx));
  if (hasOwn(p, 'x-example')) setProp(out, 'example', own(p, 'x-example'));
  return out;
}

function bodyContent(param: Dict, consumes: string[], ctx: Ctx): Dict {
  const content = dict();
  const xExamples = own(param, 'x-examples');
  const schema = hasOwn(param, 'schema') ? copySchema(own(param, 'schema'), ctx) : undefined;
  for (const mt of consumes) {
    const media = dict();
    if (schema !== undefined) setProp(media, 'schema', schema);
    if (isObj(xExamples) && hasOwn(xExamples, mt)) setProp(media, 'example', own(xExamples, mt));
    else if (hasOwn(param, 'x-example')) setProp(media, 'example', own(param, 'x-example'));
    setProp(content, mt, media);
  }
  return content;
}

function formContent(params: Dict[], consumes: string[] | undefined, ctx: Ctx): Dict {
  const props = dict();
  const required: string[] = [];
  let hasFile = false;
  const example = dict();
  let hasExample = false;
  for (const p of params) {
    const name = str(own(p, 'name'));
    if (!name) continue;
    if (own(p, 'type') === 'file') hasFile = true;
    setProp(props, name, paramSchema(p, ctx));
    if (own(p, 'required') === true) required.push(name);
    if (hasOwn(p, 'x-example')) {
      setProp(example, name, own(p, 'x-example'));
      hasExample = true;
    }
  }
  const mt = hasFile || consumes?.includes('multipart/form-data') ? 'multipart/form-data' : 'application/x-www-form-urlencoded';
  const schema = dict();
  setProp(schema, 'type', 'object');
  setProp(schema, 'properties', props);
  if (required.length > 0) setProp(schema, 'required', required);
  const media = dict();
  setProp(media, 'schema', schema);
  if (hasExample) setProp(media, 'example', example);
  const content = dict();
  setProp(content, mt, media);
  return content;
}

// ------------------------------------------------------------------ responses

function convertHeaders(headers: unknown, ctx: Ctx): Dict | undefined {
  if (!isObj(headers)) return undefined;
  const out = dict();
  for (const name of Object.keys(headers)) {
    if (!touchNode(ctx.budget, ctx.problems)) break;
    const h = own(headers, name);
    if (!isObj(h)) continue;
    const header = dict();
    if (typeof own(h, 'description') === 'string') setProp(header, 'description', own(h, 'description'));
    setProp(header, 'schema', paramSchema(h, ctx));
    if (hasOwn(h, 'x-example')) setProp(header, 'example', own(h, 'x-example'));
    setProp(out, name, header);
  }
  return out;
}

function convertResponse(resp: unknown, produces: string[], ctx: Ctx): unknown {
  if (!isObj(resp)) return resp;
  if (typeof own(resp, '$ref') === 'string') {
    const r = dict();
    setProp(r, '$ref', rewriteRef(own(resp, '$ref') as string));
    return r;
  }
  const out = dict();
  setProp(out, 'description', str(own(resp, 'description')) ?? '');
  const headers = convertHeaders(own(resp, 'headers'), ctx);
  if (headers) setProp(out, 'headers', headers);

  const examples = own(resp, 'examples');
  const hasSchema = hasOwn(resp, 'schema') && own(resp, 'schema') !== undefined;
  const content = dict();
  if (hasSchema) {
    const schema = copySchema(own(resp, 'schema'), ctx);
    for (const mt of produces) {
      const media = dict();
      setProp(media, 'schema', schema);
      if (isObj(examples) && hasOwn(examples, mt)) setProp(media, 'example', own(examples, mt));
      setProp(content, mt, media);
    }
  }
  if (isObj(examples)) {
    for (const mt of Object.keys(examples).slice(0, MAX_MEDIA_TYPES)) {
      if (hasOwn(content, mt)) continue;
      const media = dict();
      setProp(media, 'example', own(examples, mt));
      setProp(content, mt, media);
    }
  }
  if (Object.keys(content).length > 0) setProp(out, 'content', content);
  return out;
}

function convertResponses(responses: unknown, produces: string[], ctx: Ctx): unknown {
  if (!isObj(responses)) return responses;
  const out = dict();
  for (const code of Object.keys(responses)) {
    if (!touchNode(ctx.budget, ctx.problems)) break;
    const r = own(responses, code);
    setProp(out, code, code.startsWith('x-') ? r : convertResponse(r, produces, ctx));
  }
  return out;
}

// ------------------------------------------------------------------ security

const OAUTH_FLOWS: Record<string, string> = {
  implicit: 'implicit',
  password: 'password',
  application: 'clientCredentials',
  accessCode: 'authorizationCode',
};

function convertSecurityScheme(def: Dict, name: string, ctx: Ctx): Dict | undefined {
  const type = own(def, 'type');
  const out = dict();
  if (typeof own(def, 'description') === 'string') setProp(out, 'description', own(def, 'description'));
  if (type === 'basic') {
    setProp(out, 'type', 'http');
    setProp(out, 'scheme', 'basic');
  } else if (type === 'apiKey') {
    setProp(out, 'type', 'apiKey');
    setProp(out, 'name', str(own(def, 'name')) ?? '');
    setProp(out, 'in', str(own(def, 'in')) ?? 'header');
  } else if (type === 'oauth2') {
    const flowName = str(own(def, 'flow'));
    const oas3Flow = flowName && hasOwn(OAUTH_FLOWS, flowName) ? OAUTH_FLOWS[flowName] : 'implicit';
    const flow = dict();
    if (typeof own(def, 'authorizationUrl') === 'string') setProp(flow, 'authorizationUrl', own(def, 'authorizationUrl'));
    if (typeof own(def, 'tokenUrl') === 'string') setProp(flow, 'tokenUrl', own(def, 'tokenUrl'));
    setProp(flow, 'scopes', isObj(own(def, 'scopes')) ? own(def, 'scopes') : dict());
    const flows = dict();
    setProp(flows, oas3Flow, flow);
    setProp(out, 'type', 'oauth2');
    setProp(out, 'flows', flows);
  } else {
    addProblem(ctx.problems, `Security definition "${quoteFileText(name)}" has an unknown type (skipped)`);
    return undefined;
  }
  return out;
}

// ------------------------------------------------------------------ operations

function serverUrl(scheme: string, host: string | undefined, basePath: string): string | undefined {
  if (host === undefined) return basePath || undefined;
  return `${scheme}://${host}${basePath}`;
}

function server(url: string): Dict {
  const s = dict();
  setProp(s, 'url', url);
  return s;
}

interface DocDefaults {
  consumes?: string[];
  produces?: string[];
  scheme: string;
  host?: string;
  basePath: string;
}

function convertOperation(op: Dict, pathParams: unknown[], context: string, d: DocDefaults, ctx: Ctx): Dict {
  const out = dict();
  for (const k of Object.keys(op)) {
    if (k.startsWith('x-') || ['operationId', 'summary', 'description', 'tags', 'deprecated', 'externalDocs', 'security'].includes(k)) {
      setProp(out, k, own(op, k));
    }
  }

  // Path-level parameters first; an operation parameter with the same name and location replaces one.
  const merged: Dict[] = [];
  const ownParams = Array.isArray(own(op, 'parameters')) ? (own(op, 'parameters') as unknown[]) : [];
  for (const raw of [...pathParams, ...ownParams]) {
    if (!touchNode(ctx.budget, ctx.problems, context)) break;
    const p = resolveLocal(raw, ctx, context);
    if (!p) continue;
    const name = own(p, 'name');
    const where = own(p, 'in');
    const at = merged.findIndex((m) => own(m, 'name') === name && own(m, 'in') === where);
    if (at >= 0) merged[at] = p;
    else merged.push(p);
  }

  const consumes = mediaList(own(op, 'consumes')) ?? d.consumes;
  const params: Dict[] = [];
  const form: Dict[] = [];
  let body: Dict | undefined;
  for (const p of merged) {
    const where = own(p, 'in');
    if (where === 'body') body = p;
    else if (where === 'formData') form.push(p);
    else params.push(convertParam(p, ctx));
  }
  if (params.length > 0) setProp(out, 'parameters', params);
  if (body) {
    const rb = dict();
    if (typeof own(body, 'description') === 'string') setProp(rb, 'description', own(body, 'description'));
    if (own(body, 'required') === true) setProp(rb, 'required', true);
    setProp(rb, 'content', bodyContent(body, consumes ?? ['application/json'], ctx));
    setProp(out, 'requestBody', rb);
  } else if (form.length > 0) {
    const rb = dict();
    setProp(rb, 'content', formContent(form, consumes, ctx));
    setProp(out, 'requestBody', rb);
  }

  const produces = mediaList(own(op, 'produces')) ?? d.produces ?? ['application/json'];
  if (hasOwn(op, 'responses')) setProp(out, 'responses', convertResponses(own(op, 'responses'), produces, ctx));

  // An operation's own `schemes` → its own server, when the document has a host.
  const opSchemes = own(op, 'schemes');
  if (Array.isArray(opSchemes) && typeof opSchemes[0] === 'string' && opSchemes[0] !== d.scheme && d.host !== undefined) {
    const url = serverUrl(opSchemes[0].toLowerCase(), d.host, d.basePath);
    if (url) setProp(out, 'servers', [server(url)]);
  }
  return out;
}

// ------------------------------------------------------------------ public API

/**
 * CONTRACTS §24.4: a Swagger 2.0 document rewritten as OpenAPI 3.0 (`host` + `basePath` + `schemes[0]` → `servers`;
 * `definitions` / `parameters` / `responses` / `securityDefinitions` → `components`, local `$ref`s rewritten;
 * response `schema` + `examples{mime}` + `produces` → `content`; `in: body` / `formData` → `requestBody`;
 * `x-example` → `example`). Pure, bounded by `COLLECTION_LIMITS.walkNodes`; never throws. The result shares example
 * values with `doc` (they are read, never changed).
 */
export function swagger2ToOas3(doc: unknown): { doc?: Dict; problems: string[] } {
  const problems: string[] = [];
  try {
    return convert(doc, problems);
  } catch {
    addProblem(problems, 'Swagger document could not be converted');
    return { problems };
  }
}

function convert(doc: unknown, problems: string[]): { doc?: Dict; problems: string[] } {
  if (!isObj(doc)) {
    addProblem(problems, 'Swagger document must be a JSON/YAML object');
    return { problems };
  }
  const version = own(doc, 'swagger');
  // `swagger: 2.0` unquoted in YAML reads as the number 2: accept it too.
  if (!(version === 2 || (typeof version === 'string' && version.startsWith('2.')))) {
    addProblem(problems, 'Not a Swagger 2.0 document (expected "swagger": "2.0")');
    return { problems };
  }
  const ctx: Ctx = { src: doc, budget: createWalkBudget(), problems, memo: new Map(), deepWarned: false };
  touchNode(ctx.budget, problems);

  const out = dict();
  setProp(out, 'openapi', '3.0.3');
  const info = own(doc, 'info');
  setProp(out, 'info', isObj(info) ? info : dict());
  for (const k of ['tags', 'externalDocs', 'security']) {
    if (hasOwn(doc, k)) setProp(out, k, own(doc, k));
  }

  // servers
  const rawHost = str(own(doc, 'host'))?.trim();
  let host: string | undefined;
  if (rawHost) {
    if (rawHost.length > COLLECTION_LIMITS.urlChars || /[\s/?#]/.test(rawHost)) {
      addProblem(problems, `Swagger "host" is not a valid host (ignored)`);
    } else {
      host = rawHost;
    }
  }
  let basePath = str(own(doc, 'basePath'))?.trim() ?? '';
  if (basePath.length > COLLECTION_LIMITS.urlChars) {
    addProblem(problems, `Swagger "basePath" exceeds ${COLLECTION_LIMITS.urlChars} characters (ignored)`);
    basePath = '';
  }
  if (basePath && !basePath.startsWith('/')) basePath = `/${basePath}`;
  basePath = basePath.replace(/\/+$/, '');
  const schemes = own(doc, 'schemes');
  const scheme = Array.isArray(schemes) && typeof schemes[0] === 'string' && schemes[0] ? schemes[0].toLowerCase() : 'https';
  const url = serverUrl(scheme, host, basePath);
  if (url) setProp(out, 'servers', [server(url)]);

  const d: DocDefaults = {
    consumes: mediaList(own(doc, 'consumes')),
    produces: mediaList(own(doc, 'produces')),
    scheme,
    host,
    basePath,
  };

  // components
  const components = dict();
  const definitions = own(doc, 'definitions');
  if (isObj(definitions)) setProp(components, 'schemas', copySchema(definitions, ctx, true));
  const parameters = own(doc, 'parameters');
  if (isObj(parameters)) {
    const params = dict();
    const bodies = dict();
    for (const name of Object.keys(parameters)) {
      if (!touchNode(ctx.budget, problems)) break;
      const p = own(parameters, name);
      if (!isObj(p)) continue;
      const where = own(p, 'in');
      if (where === 'body') {
        const rb = dict();
        setProp(rb, 'content', bodyContent(p, d.consumes ?? ['application/json'], ctx));
        setProp(bodies, name, rb);
      } else if (where !== 'formData') {
        setProp(params, name, convertParam(p, ctx));
      }
    }
    if (Object.keys(params).length > 0) setProp(components, 'parameters', params);
    if (Object.keys(bodies).length > 0) setProp(components, 'requestBodies', bodies);
  }
  const responses = own(doc, 'responses');
  if (isObj(responses)) setProp(components, 'responses', convertResponses(responses, d.produces ?? ['application/json'], ctx));
  const secDefs = own(doc, 'securityDefinitions');
  if (isObj(secDefs)) {
    const schemes3 = dict();
    for (const name of Object.keys(secDefs)) {
      if (!touchNode(ctx.budget, problems)) break;
      const def = own(secDefs, name);
      if (!isObj(def)) continue;
      const s = convertSecurityScheme(def, name, ctx);
      if (s) setProp(schemes3, name, s);
    }
    setProp(components, 'securitySchemes', schemes3);
  }
  if (Object.keys(components).length > 0) setProp(out, 'components', components);

  // paths
  const paths = own(doc, 'paths');
  if (paths === undefined) {
    setProp(out, 'paths', dict());
    addProblem(problems, 'Swagger document has no "paths" object');
    return { doc: out, problems };
  }
  if (!isObj(paths)) {
    setProp(out, 'paths', paths);
    return { doc: out, problems };
  }
  const outPaths = dict();
  for (const pathKey of Object.keys(paths)) {
    if (!touchNode(ctx.budget, problems)) break;
    const item = own(paths, pathKey);
    if (pathKey.startsWith('x-') || !isObj(item)) {
      setProp(outPaths, pathKey, item);
      continue;
    }
    if (typeof own(item, '$ref') === 'string') {
      const r = dict();
      setProp(r, '$ref', rewriteRef(own(item, '$ref') as string));
      setProp(outPaths, pathKey, r);
      continue;
    }
    const outItem = dict();
    const pathParams = Array.isArray(own(item, 'parameters')) ? (own(item, 'parameters') as unknown[]) : [];
    for (const k of Object.keys(item)) {
      if (ctx.budget.exceeded) break;
      const v = own(item, k);
      if (HTTP_METHODS.includes(k)) {
        if (!isObj(v)) {
          setProp(outItem, k, v);
          continue;
        }
        setProp(outItem, k, convertOperation(v, pathParams, `${k.toUpperCase()} ${quoteFileText(pathKey)}`, d, ctx));
      } else if (k.startsWith('x-') || k === 'summary' || k === 'description') {
        setProp(outItem, k, v);
      }
    }
    setProp(outPaths, pathKey, outItem);
  }
  setProp(out, 'paths', outPaths);
  return { doc: out, problems };
}

/** Parses already-read Swagger text: JSON, else YAML (`.yaml` / `.yml` names go to YAML first). Never throws. */
export function readStructuredText(text: string, fileName: string, problems: string[]): unknown {
  const label = quoteFileText(fileName || 'file');
  if (utf8Bytes(text) > COLLECTION_LIMITS.fileBytes) {
    addProblem(problems, `${label} is larger than ${COLLECTION_LIMITS.fileBytes / (1024 * 1024)} MB (not read)`);
    return undefined;
  }
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  if (!isYamlFile(fileName) && /^\s*[{[]/.test(src)) {
    try {
      return JSON.parse(src) as unknown;
    } catch {
      // JSON.parse messages quote the file: never shown. YAML (a JSON superset) reports a position instead.
    }
  }
  const y = parseYaml(src, label);
  if (y.problem) {
    addProblem(problems, y.problem);
    return undefined;
  }
  return y.value;
}

/** §24.4: a parsed Swagger 2.0 document → `swagger2ToOas3` → `parseOpenApi`, `format: 'swagger'`. Never throws. */
export function parseSwagger2Doc(doc: unknown, vars: CollectionVars): ParsedCollection {
  const conv = swagger2ToOas3(doc);
  const info = isObj(doc) ? own(doc, 'info') : undefined;
  const title = isObj(info) && typeof own(info, 'title') === 'string' ? (own(info, 'title') as string).trim() : '';
  const name = title || 'Swagger';
  if (!conv.doc) return { format: 'swagger', name, endpoints: [], variables: [], problems: conv.problems };
  try {
    const parsed = parseOpenApi(conv.doc, vars);
    return { ...parsed, format: 'swagger', name, problems: [...conv.problems, ...parsed.problems] };
  } catch {
    addProblem(conv.problems, 'Swagger document could not be read');
    return { format: 'swagger', name, endpoints: [], variables: [], problems: conv.problems };
  }
}

/** §24.4: Swagger 2.0 text (JSON or YAML) → endpoints, `format: 'swagger'`. Never throws. */
export function parseSwagger2(text: string, fileName: string, vars: CollectionVars): ParsedCollection {
  const problems: string[] = [];
  const doc = readStructuredText(typeof text === 'string' ? text : '', fileName, problems);
  if (doc === undefined) return { format: 'swagger', name: 'Swagger', endpoints: [], variables: [], problems };
  const parsed = parseSwagger2Doc(doc, vars);
  return { ...parsed, problems: [...problems, ...parsed.problems] };
}
