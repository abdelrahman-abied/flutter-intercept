/**
 * Insomnia exports (CONTRACTS §24.4). Pure: no vscode, no fs, no network.
 *
 * - v4 JSON: `{ _type: 'export', __export_format: 4, resources: [...] }` with `_type` `workspace`, `request`,
 *   `request_group`, `environment`, `api_spec` (and `mock_route`).
 * - v5 YAML: `type: collection.insomnia.rest/5.0` (`collection[]` with `children`, `environments` with
 *   `subEnvironments`, optional `spec`), `spec.insomnia.rest/5.0` (`spec.contents`: an OpenAPI document) and
 *   `mock.insomnia.rest/5.0` (`routes[]`: name = path, method, statusCode, statusText, headers, body, mimeType).
 *
 * Requests go through `parsePostman` (viaPostman.ts) and an embedded API spec through `parseOpenApi` /
 * `parseSwagger2Doc`. Only `{{ _.x }}` / `{{ x }}` variables are used; Nunjucks tags are never evaluated (§24.4).
 * Environment values resolve URLs only (§21.6): the result names variables and environments, never values.
 */
import { mergeCollectionVars } from './environment';
import { parseOpenApi } from './openapi';
import { addProblem, createWalkBudget, hasOwn, isObj, quoteFileText, touchNode, type Dict, type WalkBudget } from './ref';
import { parseSwagger2Doc, readStructuredText } from './swagger2';
import { COLLECTION_LIMITS, type CollectionVars, type ParsedCollection } from './types';
import {
  expandValues,
  MAX_ENVIRONMENTS,
  normaliseTemplate,
  parseSourceRequests,
  type SourceBody,
  type SourceHeader,
  type SourceOptions,
  type SourceParsed,
  type SourceRequest,
} from './viaPostman';

const V5_COLLECTION = 'collection.insomnia.rest/5.0';
const V5_SPEC = 'spec.insomnia.rest/5.0';
const V5_MOCK = 'mock.insomnia.rest/5.0';
const V5_ENVIRONMENT = 'environment.insomnia.rest/5.0';
const METHOD = /^[A-Za-z][A-Za-z0-9_-]{0,19}$/;
/** Nested environment objects (`{{ _.api.url }}`) are flattened this deep. */
const ENV_DEPTH = 8;
/** Entries read from one list (parameters, headers, form fields). */
const MAX_LIST = 1000;

interface Ctx {
  budget: WalkBudget;
  problems: string[];
  requests: SourceRequest[];
  /** Folder environments (`request_group.environment`): lowest priority, part of the collection. */
  folderEnv: Map<string, string>;
  skippedOther: number;
  /** Stopped at the endpoint limit. */
  truncated: boolean;
}

function own(o: Dict, key: string): unknown {
  return hasOwn(o, key) ? Object.getOwnPropertyDescriptor(o, key)?.value : undefined;
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

function scalar(v: unknown): string | undefined {
  if (typeof v === 'string') return v;
  if ((typeof v === 'number' && Number.isFinite(v)) || typeof v === 'boolean') return String(v);
  return undefined;
}

/** One request past the endpoint limit is enough for `parsePostman` to report it; the rest is not walked. */
function full(ctx: Ctx): boolean {
  if (ctx.requests.length <= COLLECTION_LIMITS.endpoints) return false;
  ctx.truncated = true;
  return true;
}

function empty(name: string, problems: string[], environments: string[] = []): SourceParsed {
  return { format: 'insomnia', name, endpoints: [], variables: [], problems, environments };
}

/** True for an Insomnia v4 export or a v5 file (`type: *.insomnia.rest/5.0`). */
export function isInsomniaDoc(doc: unknown): boolean {
  if (!isObj(doc)) return false;
  if (own(doc, '_type') === 'export') return true;
  const type = own(doc, 'type');
  return typeof type === 'string' && /\.insomnia(\.rest)?\/5\.\d+$/.test(type);
}

// ------------------------------------------------------------------ environments

/** Flattens Insomnia environment `data` (nested objects → `a.b`) or `kvPairData`; the first value of a name wins. */
function readEnvironment(env: Dict, out: Map<string, string>, ctx: Ctx): void {
  const kv = own(env, 'kvPairData');
  if (own(env, 'environmentType') === 'kv' && Array.isArray(kv)) {
    for (const e of kv.slice(0, MAX_LIST)) {
      if (!touchNode(ctx.budget, ctx.problems) || !isObj(e) || own(e, 'enabled') === false) continue;
      const name = str(own(e, 'name'));
      const value = scalar(own(e, 'value'));
      if (name && value !== undefined && !out.has(name) && value.length <= COLLECTION_LIMITS.urlChars) out.set(name, value);
    }
    return;
  }
  flatten(own(env, 'data'), '', 0, out, ctx);
}

function flatten(data: unknown, prefix: string, depth: number, out: Map<string, string>, ctx: Ctx): void {
  if (!isObj(data) || depth > ENV_DEPTH) return;
  for (const k of Object.keys(data)) {
    if (!touchNode(ctx.budget, ctx.problems)) return;
    const v = own(data, k);
    const name = prefix + k;
    if (isObj(v)) flatten(v, `${name}.`, depth + 1, out, ctx);
    else {
      const s = scalar(v);
      // REVIEW-16 #2: a value longer than a URL can't end up in one; it would only cost time to expand
      if (s !== undefined && !out.has(name) && s.length <= COLLECTION_LIMITS.urlChars) out.set(name, s);
    }
  }
}

interface Environments {
  base: Map<string, string>;
  subs: { name: string; values: Map<string, string> }[];
}

function buildVars(envs: Environments, opts: SourceOptions, ctx: Ctx): { vars: CollectionVars; environments: string[]; envValues: Map<string, string> } {
  const environments = envs.subs.map((s) => s.name).filter((n, i, all) => all.indexOf(n) === i).slice(0, MAX_ENVIRONMENTS);
  let chosen: Map<string, string> | undefined;
  if (opts.environment !== undefined) {
    chosen = envs.subs.find((s) => s.name === opts.environment)?.values;
    if (!chosen) addProblem(ctx.problems, `Environment "${quoteFileText(opts.environment)}" is not in the file`);
  }
  // Insomnia's own order: sub-environment over base over folder; values may use other variables.
  const raw = new Map<string, string>(ctx.folderEnv);
  for (const [k, v] of envs.base) raw.set(k, v);
  for (const [k, v] of chosen ?? []) raw.set(k, v);
  const expanded = expandValues(raw, true);
  const env = new Map<string, string>();
  const coll = new Map<string, string>();
  for (const [k, v] of expanded) (chosen?.has(k) ? env : coll).set(k, v);
  return { vars: mergeCollectionVars(opts.variables ?? {}, env, coll), environments, envValues: env };
}

// ------------------------------------------------------------------ requests

function authOf(a: unknown): 'none' | 'declared' | undefined {
  if (!isObj(a)) return undefined;
  const type = own(a, 'type');
  if (typeof type !== 'string' || type === '') return undefined; // `{}` = inherit from the folder
  if (type === 'none' || own(a, 'disabled') === true) return 'none';
  return 'declared';
}

function bodyOf(b: unknown): SourceBody | undefined {
  if (!isObj(b)) return undefined;
  const mime = str(own(b, 'mimeType'))?.toLowerCase() ?? '';
  const text = own(b, 'text');
  if (typeof text === 'string' && text.trim() !== '' && (mime === '' || mime.includes('json'))) return { kind: 'raw', text };
  const params = own(b, 'params');
  if (mime.startsWith('application/x-www-form-urlencoded') && Array.isArray(params)) {
    const entries: { key: string; value: string }[] = [];
    for (const p of params.slice(0, MAX_LIST)) {
      if (!isObj(p) || own(p, 'disabled') === true) continue;
      const key = str(own(p, 'name'));
      if (key) entries.push({ key, value: scalar(own(p, 'value')) ?? '' });
    }
    return entries.length > 0 ? { kind: 'form', entries } : undefined;
  }
  return undefined;
}

function addRequest(r: Dict, folder: string[], inherited: 'none' | 'declared' | undefined, ctx: Ctx): void {
  const rawUrl = str(own(r, 'url')) ?? '';
  const rawMethod = str(own(r, 'method'))?.trim() || 'GET';
  const rawName = str(own(r, 'name'))?.trim();
  if (!METHOD.test(rawMethod)) {
    addProblem(ctx.problems, `Request "${quoteFileText(rawName ?? 'Unnamed request')}": invalid method (skipped)`);
    return;
  }
  const method = rawMethod.toUpperCase();
  // Over-long URLs are reported by the shared writer; don't spend time normalising them.
  const url = rawUrl.length > COLLECTION_LIMITS.urlChars ? rawUrl : normaliseTemplate(rawUrl, true);
  const query: SourceRequest['query'] = [];
  const params = own(r, 'parameters');
  if (Array.isArray(params)) {
    for (const p of params.slice(0, MAX_LIST)) {
      if (!isObj(p)) continue;
      const key = str(own(p, 'name'));
      if (key) query.push({ key, value: scalar(own(p, 'value')) ?? '', ...(own(p, 'disabled') === true ? { disabled: true } : {}) });
    }
  }
  // Query parameters written in the URL itself are kept next to the declared ones.
  const q = url.indexOf('?');
  if (query.length > 0 && q >= 0) {
    const inUrl: { key: string; value: string }[] = [];
    for (const part of url.slice(q + 1).split('#')[0].split('&').slice(0, MAX_LIST)) {
      const eq = part.indexOf('=');
      const key = eq < 0 ? part : part.slice(0, eq);
      if (key) inUrl.push({ key, value: eq < 0 ? '' : part.slice(eq + 1) });
    }
    query.unshift(...inUrl);
  }
  const body = bodyOf(own(r, 'body'));
  const auth = authOf(own(r, 'authentication')) ?? inherited;
  ctx.requests.push({
    name: rawName || `${method} ${url}`,
    method,
    url,
    ...(query.length > 0 ? { query } : {}),
    folder,
    examples: [],
    ...(body ? { body } : {}),
    ...(auth ? { auth } : {}),
  });
}

function folderName(g: Dict): string {
  return str(own(g, 'name'))?.trim() || 'Unnamed folder';
}

function readFolderEnv(g: Dict, ctx: Ctx): void {
  const env = own(g, 'environment');
  if (isObj(env)) flatten(env, '', 0, ctx.folderEnv, ctx);
}

// ------------------------------------------------------------------ mock routes

function routesToRequests(routes: unknown[], folder: string[], ctx: Ctx): void {
  const byKey = new Map<string, SourceRequest>();
  for (const route of routes) {
    if (full(ctx) || !touchNode(ctx.budget, ctx.problems)) return;
    if (!isObj(route)) continue;
    let path = (str(own(route, 'name')) ?? '/').trim() || '/';
    if (path.length > COLLECTION_LIMITS.urlChars) {
      addProblem(ctx.problems, `Mock route "${quoteFileText(path)}": path exceeds ${COLLECTION_LIMITS.urlChars} characters (skipped)`);
      continue;
    }
    if (!path.startsWith('/')) path = `/${path}`;
    const rawMethod = str(own(route, 'method'))?.trim() || 'GET';
    if (!METHOD.test(rawMethod)) {
      addProblem(ctx.problems, `Mock route "${quoteFileText(path)}": invalid method (skipped)`);
      continue;
    }
    const method = rawMethod.toUpperCase();
    const code = own(route, 'statusCode');
    const status = typeof code === 'number' ? code : typeof code === 'string' && /^\d{3}$/.test(code) ? Number(code) : 200;
    const headers: SourceHeader[] = [];
    const rawHeaders = own(route, 'headers');
    if (Array.isArray(rawHeaders)) {
      for (const h of rawHeaders.slice(0, MAX_LIST)) {
        if (!isObj(h) || own(h, 'disabled') === true) continue;
        const name = str(own(h, 'name'));
        if (name) headers.push({ name, value: scalar(own(h, 'value')) ?? '' });
      }
    }
    const body = str(own(route, 'body')) ?? '';
    const mime = str(own(route, 'mimeType'))?.trim() || 'application/json';
    if (body !== '' && !headers.some((h) => h.name.trim().toLowerCase() === 'content-type')) {
      headers.push({ name: 'content-type', value: mime });
    }
    const key = `${method} ${path}`;
    let req = byKey.get(key);
    if (!req) {
      req = { name: path, method, url: `{{baseUrl}}${normaliseTemplate(path, true)}`, folder, examples: [] };
      byKey.set(key, req);
      ctx.requests.push(req);
    }
    req.examples.push({ name: str(own(route, 'statusText'))?.trim() || String(status), status, headers, body });
  }
}

// ------------------------------------------------------------------ API spec

function parseSpec(contents: unknown, vars: CollectionVars, problems: string[]): ParsedCollection | undefined {
  let doc = contents;
  if (typeof contents === 'string') {
    if (contents.trim() === '') return undefined;
    doc = readStructuredText(contents, 'spec.yaml', problems);
  }
  if (!isObj(doc)) return undefined;
  const openapi = own(doc, 'openapi');
  if (typeof openapi === 'string' && openapi.startsWith('3.')) return parseOpenApi(doc, vars);
  const swagger = own(doc, 'swagger');
  if (typeof swagger === 'string' && swagger.startsWith('2.')) return parseSwagger2Doc(doc, vars);
  return undefined;
}

/** The spec's endpoints when it has any (they carry examples; the requests generated from it don't), else the requests. */
function finish(
  name: string,
  spec: unknown,
  envs: Environments,
  opts: SourceOptions,
  ctx: Ctx,
): SourceParsed {
  if (ctx.skippedOther > 0) {
    addProblem(ctx.problems, `${ctx.skippedOther} gRPC, WebSocket, Socket.IO or MCP requests skipped (HTTP only)`);
  }
  const { vars, environments, envValues } = buildVars(envs, opts, ctx);
  if (spec !== undefined) {
    const specProblems: string[] = [];
    const fromSpec = parseSpec(spec, vars, specProblems);
    if (fromSpec && fromSpec.endpoints.length > 0) {
      return {
        ...fromSpec,
        format: 'insomnia',
        name,
        problems: [...ctx.problems, ...specProblems, ...fromSpec.problems],
        environments,
        envValues,
      };
    }
  }
  const parsed = parseSourceRequests('insomnia', name, ctx.requests, vars, ctx.problems, ctx.truncated);
  return { ...parsed, environments, envValues };
}

// ------------------------------------------------------------------ v4

function sortKey(r: Dict): number {
  const k = own(r, 'metaSortKey');
  return typeof k === 'number' && Number.isFinite(k) ? k : 0;
}

function parseV4(doc: Dict, opts: SourceOptions, ctx: Ctx): SourceParsed {
  const fmt = own(doc, '__export_format');
  if (fmt !== 4 && fmt !== '4') {
    addProblem(ctx.problems, `Insomnia export format ${quoteFileText(String(scalar(fmt) ?? '?'))} isn't supported: export as v4 (JSON) or v5 (YAML)`);
    return empty('Insomnia', ctx.problems);
  }
  const resources = own(doc, 'resources');
  if (!Array.isArray(resources)) {
    addProblem(ctx.problems, 'Insomnia export has no "resources" array');
    return empty('Insomnia', ctx.problems);
  }

  const types = new Map<string, string>();
  const items: Dict[] = [];
  const workspaces: Dict[] = [];
  const envResources: Dict[] = [];
  const routes: Dict[] = [];
  let spec: unknown;
  for (const r of resources) {
    if (!touchNode(ctx.budget, ctx.problems)) break;
    if (!isObj(r)) continue;
    const type = str(own(r, '_type'));
    const id = str(own(r, '_id'));
    if (!type) continue;
    if (id && !types.has(id)) types.set(id, type);
    if (type === 'request' || type === 'request_group') items.push(r);
    else if (type === 'workspace') workspaces.push(r);
    else if (type === 'environment') envResources.push(r);
    else if (type === 'mock_route') routes.push(r);
    else if (type === 'api_spec' && spec === undefined) {
      const c = own(r, 'contents');
      if (typeof c === 'string' && c.trim() !== '') spec = c;
    } else if (/^(grpc_request|websocket_request|socket_io_request|mcp_request)$/.test(type)) ctx.skippedOther++;
  }

  const name = str(workspaces[0] && own(workspaces[0], 'name'))?.trim() || 'Insomnia';

  // environments: a base one per workspace, sub-environments below it
  const envs: Environments = { base: new Map(), subs: [] };
  for (const e of envResources) {
    const parent = str(own(e, 'parentId'));
    if (parent && types.get(parent) === 'environment') {
      if (own(e, 'isPrivate') === true) continue;
      const values = new Map<string, string>();
      readEnvironment(e, values, ctx);
      envs.subs.push({ name: (str(own(e, 'name'))?.trim() || 'Environment').slice(0, 100), values });
    } else {
      readEnvironment(e, envs.base, ctx);
    }
  }

  // the request tree: children by parent, in Insomnia's own order (metaSortKey, then file order)
  const children = new Map<string, Dict[]>();
  const rootParents: string[] = [];
  for (const it of items) {
    const parent = str(own(it, 'parentId')) ?? '';
    let list = children.get(parent);
    if (!list) {
      list = [];
      children.set(parent, list);
      if (types.get(parent) !== 'request_group') rootParents.push(parent);
    }
    list.push(it);
  }
  for (const list of children.values()) {
    const keyed = list.map((r, i) => ({ r, i, k: sortKey(r) }));
    keyed.sort((a, b) => a.k - b.k || a.i - b.i);
    list.splice(0, list.length, ...keyed.map((x) => x.r));
  }
  const workspaceNames = new Map<string, string>();
  for (const w of workspaces) {
    const id = str(own(w, '_id'));
    if (id) workspaceNames.set(id, str(own(w, 'name'))?.trim() || 'Workspace');
  }
  const several = rootParents.filter((p) => workspaceNames.has(p)).length > 1;

  const active = new Set<Dict>();
  const walk = (list: Dict[], folder: string[], inherited: 'none' | 'declared' | undefined): void => {
    for (const it of list) {
      if (full(ctx) || !touchNode(ctx.budget, ctx.problems)) return;
      if (own(it, '_type') === 'request') {
        addRequest(it, folder, inherited, ctx);
        continue;
      }
      const fname = folderName(it);
      const id = str(own(it, '_id'));
      if (active.has(it) || !id) continue;
      if (folder.length >= COLLECTION_LIMITS.folderDepth) {
        addProblem(ctx.problems, `Folder "${quoteFileText(fname)}" exceeds maximum depth of ${COLLECTION_LIMITS.folderDepth} (skipped)`);
        continue;
      }
      readFolderEnv(it, ctx);
      active.add(it);
      walk(children.get(id) ?? [], [...folder, fname], authOf(own(it, 'authentication')) ?? inherited);
      active.delete(it);
    }
  };
  for (const parent of rootParents) {
    const prefix = several && workspaceNames.has(parent) ? [workspaceNames.get(parent)!] : [];
    walk(children.get(parent) ?? [], prefix, undefined);
  }
  if (routes.length > 0) routesToRequests(routes, [], ctx);
  return finish(name, spec, envs, opts, ctx);
}

// ------------------------------------------------------------------ v5

function readV5Environments(raw: unknown, ctx: Ctx): Environments {
  const envs: Environments = { base: new Map(), subs: [] };
  if (!isObj(raw)) return envs;
  readEnvironment(raw, envs.base, ctx);
  const subs = own(raw, 'subEnvironments');
  if (Array.isArray(subs)) {
    for (const s of subs.slice(0, MAX_LIST)) {
      if (!touchNode(ctx.budget, ctx.problems) || !isObj(s)) continue;
      if (own(s, 'isPrivate') === true) continue;
      const values = new Map<string, string>();
      readEnvironment(s, values, ctx);
      envs.subs.push({ name: (str(own(s, 'name'))?.trim() || 'Environment').slice(0, 100), values });
    }
  }
  return envs;
}

const OTHER_REQUEST_ID = /^(ws-req|greq|socket-io|mcp)/;

function walkV5(list: unknown, folder: string[], inherited: 'none' | 'declared' | undefined, ctx: Ctx, active: Set<unknown>): void {
  if (!Array.isArray(list)) return;
  for (const it of list) {
    if (full(ctx) || !touchNode(ctx.budget, ctx.problems)) return;
    if (!isObj(it) || active.has(it)) continue;
    const children = own(it, 'children');
    const meta = own(it, 'meta');
    const id = isObj(meta) ? str(own(meta, 'id')) : undefined;
    if (Array.isArray(children)) {
      const fname = folderName(it);
      if (folder.length >= COLLECTION_LIMITS.folderDepth) {
        addProblem(ctx.problems, `Folder "${quoteFileText(fname)}" exceeds maximum depth of ${COLLECTION_LIMITS.folderDepth} (skipped)`);
        continue;
      }
      readFolderEnv(it, ctx);
      active.add(it);
      walkV5(children, [...folder, fname], authOf(own(it, 'authentication')) ?? inherited, ctx, active);
      active.delete(it);
    } else if ((id && OTHER_REQUEST_ID.test(id)) || hasOwn(it, 'protoMethodName')) {
      ctx.skippedOther++;
    } else if (typeof own(it, 'url') === 'string') {
      addRequest(it, folder, inherited, ctx);
    }
  }
}

function parseV5(doc: Dict, type: string, opts: SourceOptions, ctx: Ctx): SourceParsed {
  const name = str(own(doc, 'name'))?.trim() || 'Insomnia';
  if (type === V5_MOCK) {
    const routes = own(doc, 'routes');
    if (!Array.isArray(routes)) {
      addProblem(ctx.problems, 'Insomnia mock server file has no "routes"');
      return empty(name, ctx.problems);
    }
    routesToRequests(routes, [], ctx);
    return finish(name, undefined, { base: new Map(), subs: [] }, opts, ctx);
  }
  if (type === V5_ENVIRONMENT) {
    addProblem(ctx.problems, 'This is an Insomnia environment file, not a collection');
    return empty(name, ctx.problems);
  }
  if (type !== V5_COLLECTION && type !== V5_SPEC) {
    addProblem(ctx.problems, `Insomnia file type "${quoteFileText(type)}" isn't supported (collection, design document or mock server)`);
    return empty(name, ctx.problems);
  }
  const envs = readV5Environments(own(doc, 'environments'), ctx);
  walkV5(own(doc, 'collection'), [], authOf(own(doc, 'authentication')), ctx, new Set());
  const spec = own(doc, 'spec');
  const contents = isObj(spec) ? own(spec, 'contents') : undefined;
  if (isObj(spec) && typeof own(spec, 'file') === 'string' && contents === undefined) {
    addProblem(ctx.problems, 'The API spec is in another file (not followed)');
  }
  return finish(name, contents, envs, opts, ctx);
}

// ------------------------------------------------------------------ public API

/** §24.4: an already-parsed Insomnia v4 / v5 document. `format: 'insomnia'`. Never throws. */
export function parseInsomniaDoc(doc: unknown, opts: SourceOptions = {}): SourceParsed {
  const ctx: Ctx = { budget: createWalkBudget(), problems: [], requests: [], folderEnv: new Map(), skippedOther: 0, truncated: false };
  try {
    if (!isObj(doc)) {
      addProblem(ctx.problems, 'Insomnia file must be a JSON or YAML object');
      return empty('Insomnia', ctx.problems);
    }
    if (own(doc, '_type') === 'export') return parseV4(doc, opts, ctx);
    const type = own(doc, 'type');
    if (typeof type === 'string') return parseV5(doc, type, opts, ctx);
    addProblem(ctx.problems, 'Not an Insomnia export (expected a v4 JSON export or a v5 YAML file)');
    return empty('Insomnia', ctx.problems);
  } catch {
    addProblem(ctx.problems, 'Insomnia file could not be read');
    return empty('Insomnia', ctx.problems);
  }
}

/** §24.4: Insomnia export text — v4 JSON or v5 YAML. `fileName` picks YAML first for `.yaml` / `.yml`. Never throws. */
export function parseInsomnia(text: string, fileName: string, opts: SourceOptions = {}): SourceParsed {
  const problems: string[] = [];
  const doc = readStructuredText(typeof text === 'string' ? text : '', fileName, problems);
  if (doc === undefined) return empty('Insomnia', problems);
  const parsed = parseInsomniaDoc(doc, opts);
  return { ...parsed, problems: [...problems, ...parsed.problems] };
}
