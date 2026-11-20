/**
 * OpenAPI 3.0 / 3.1 collection parser (CONTRACTS §21.1, §21.3).
 * Pure: no vscode, no fs, no network.
 */
import {
  COLLECTION_LIMITS,
  type CollectionVars,
  type MockEndpoint,
  type MockExample,
  type ParseOpenApi,
  type PathSegment,
  type VariableSource,
} from './types';
import {
  addProblem,
  createWalkBudget,
  deref,
  dict,
  formatJsonChecked,
  hasOwn,
  isObj,
  MAX_QUOTED_URL_CHARS,
  quoteFileText,
  touchNode,
  utf8Bytes,
  type Dict,
  type WalkBudget,
} from './ref';
import { generateSchemaBody } from './generate';

const HTTP_METHODS = new Set(['get', 'put', 'post', 'delete', 'patch', 'head', 'options']);
/** Cap on total example body text across one OpenAPI document (REVIEW-15 #2b). */
const MAX_TOTAL_BODY_BYTES = 64 * 1024 * 1024;

interface BodyBudget {
  usedBytes: number;
  readonly limitBytes: number;
  exceeded: boolean;
}

interface CachedJson {
  text: string;
  byteLen: number;
  cut: boolean;
}

interface ExampleCache {
  jsonObj: Map<object, CachedJson>;
  jsonStr: Map<string, CachedJson>;
  rawStrBytes: Map<string, number>;
  genJson: Map<object, { text: string; byteLen: number }>;
  genRaw: Map<object, { text: string; byteLen: number }>;
}

function createExampleCache(): ExampleCache {
  return {
    jsonObj: new Map(),
    jsonStr: new Map(),
    rawStrBytes: new Map(),
    genJson: new Map(),
    genRaw: new Map(),
  };
}

function tryConsumeBody(bodyBudget: BodyBudget, byteLen: number, problems: string[]): boolean {
  if (bodyBudget.exceeded) return false;
  if (bodyBudget.usedBytes + byteLen > bodyBudget.limitBytes) {
    bodyBudget.exceeded = true;
    const mb = Math.round(bodyBudget.limitBytes / (1024 * 1024));
    addProblem(problems, `Total example body size exceeded ${mb} MB limit; remaining examples skipped`);
    return false;
  }
  bodyBudget.usedBytes += byteLen;
  return true;
}

/** Parses an OpenAPI 3.0 / 3.1 document into endpoints, URL variables and readable problems (§21.3). Never throws. */
export const parseOpenApi: ParseOpenApi = (doc, vars) => {
  const problems: string[] = [];
  const budget = createWalkBudget();
  const bodyBudget: BodyBudget = { usedBytes: 0, limitBytes: MAX_TOTAL_BODY_BYTES, exceeded: false };
  const cache = createExampleCache();

  if (!isObj(doc)) {
    addProblem(problems, 'OpenAPI document must be a JSON/YAML object');
    return { format: 'openapi', name: 'OpenAPI', endpoints: [], variables: [], problems };
  }
  if (!touchNode(budget, problems)) {
    return { format: 'openapi', name: 'OpenAPI', endpoints: [], variables: [], problems };
  }

  const name = readTitle(doc['info']);

  if (doc['swagger'] === '2.0') {
    addProblem(problems, "Swagger 2.0 isn't supported yet: convert it to OpenAPI 3.");
    return { format: 'openapi', name, endpoints: [], variables: [], problems };
  }
  if (typeof doc['openapi'] !== 'string' || !doc['openapi'].startsWith('3.')) {
    addProblem(problems, 'OpenAPI document must specify a 3.x "openapi" version');
    return { format: 'openapi', name, endpoints: [], variables: [], problems };
  }

  if (!hasOwn(doc, 'paths') || doc['paths'] === undefined) {
    addProblem(problems, 'OpenAPI document has no "paths" object');
    return { format: 'openapi', name, endpoints: [], variables: [], problems };
  }
  if (!isObj(doc['paths'])) {
    addProblem(problems, 'OpenAPI "paths" must be an object');
    return { format: 'openapi', name, endpoints: [], variables: [], problems };
  }

  const docServers = Array.isArray(doc['servers']) && doc['servers'].length > 0 ? doc['servers'] : undefined;
  const usedVars = new Map<string, VariableSource | undefined>();
  const usedKeys = new Map<string, number>();
  const endpoints: MockEndpoint[] = [];

  const pathsObj = doc['paths'];
  for (const pathKey of Object.keys(pathsObj)) {
    if (budget.exceeded) break;
    if (pathKey.startsWith('x-')) continue;

    const safePath = quoteFileText(pathKey);
    if (pathKey.length > COLLECTION_LIMITS.urlChars) {
      addProblem(problems, `Path "${safePath}" exceeds ${COLLECTION_LIMITS.urlChars} characters (skipped)`);
      continue;
    }

    const rawPathItem = pathsObj[pathKey];
    const pathDeref = deref(rawPathItem, doc, budget, problems, safePath);
    if (!pathDeref.ok) continue;
    if (!isObj(pathDeref.value)) {
      addProblem(problems, `Path "${safePath}": path item must be an object (skipped)`);
      continue;
    }
    const pathItem = pathDeref.value;
    const pathServers = Array.isArray(pathItem['servers']) && pathItem['servers'].length > 0 ? pathItem['servers'] : undefined;

    for (const methodKey of Object.keys(pathItem)) {
      if (budget.exceeded) break;
      if (!HTTP_METHODS.has(methodKey)) continue;

      if (endpoints.length >= COLLECTION_LIMITS.endpoints) {
        addProblem(problems, `More than ${COLLECTION_LIMITS.endpoints} endpoints; the rest are skipped`);
        return finalizeResult(name, endpoints, usedVars, problems);
      }

      const method = methodKey.toUpperCase();
      const baseKey = `${method} ${pathKey}`;
      const problemCtx = `${method} ${safePath}`;
      const rawOp = pathItem[methodKey];
      if (!touchNode(budget, problems, problemCtx)) break;
      if (!isObj(rawOp)) {
        addProblem(problems, `${problemCtx}: operation must be an object (skipped)`);
        continue;
      }

      const opServers = Array.isArray(rawOp['servers']) && rawOp['servers'].length > 0 ? rawOp['servers'] : undefined;
      const effectiveServers = opServers ?? pathServers ?? docServers;

      const resolved = resolveServer(effectiveServers, vars, usedVars, problems, problemCtx);
      if (resolved.urlTooLong) continue;

      const epName = readOperationName(rawOp, baseKey);
      const folder = readFirstTag(rawOp);
      const path = [...resolved.prefixSegments, ...parsePathSegments(pathKey)];
      const key = uniqueKey(baseKey, usedKeys);
      const examples = parseResponses(rawOp, doc, problemCtx, budget, bodyBudget, cache, problems);

      const endpoint: MockEndpoint = {
        key,
        method,
        name: epName,
        folder,
        ...(resolved.origin !== undefined ? { origin: resolved.origin } : {}),
        path,
        examples,
        unresolved: resolved.unresolved,
      };
      endpoints.push(endpoint);
    }
  }

  return finalizeResult(name, endpoints, usedVars, problems);
};

function finalizeResult(
  name: string,
  endpoints: MockEndpoint[],
  usedVars: Map<string, VariableSource | undefined>,
  problems: string[],
): ReturnType<ParseOpenApi> {
  const variables: { name: string; from?: VariableSource }[] = [];
  for (const [varName, from] of usedVars.entries()) {
    variables.push(from !== undefined ? { name: varName, from } : { name: varName });
  }
  return { format: 'openapi', name, endpoints, variables, problems };
}

function readTitle(info: unknown): string {
  if (isObj(info) && typeof info['title'] === 'string') {
    const trimmed = info['title'].trim();
    if (trimmed) return trimmed;
  }
  return 'OpenAPI';
}

function readOperationName(op: Dict, fallback: string): string {
  if (typeof op['operationId'] === 'string') {
    const id = op['operationId'].trim();
    if (id) return id;
  }
  if (typeof op['summary'] === 'string') {
    const sum = op['summary'].trim();
    if (sum) return sum;
  }
  return fallback;
}

function readFirstTag(op: Dict): string[] {
  const tags = op['tags'];
  if (Array.isArray(tags) && typeof tags[0] === 'string') {
    const first = tags[0].trim();
    if (first) return [first];
  }
  return [];
}

function uniqueKey(baseKey: string, usedKeys: Map<string, number>): string {
  const count = (usedKeys.get(baseKey) ?? 0) + 1;
  usedKeys.set(baseKey, count);
  return count === 1 ? baseKey : `${baseKey} #${count}`;
}

interface ResolvedServer {
  origin?: string;
  prefixSegments: PathSegment[];
  unresolved: string[];
  urlTooLong?: boolean;
}

function recordUsedVar(
  usedVars: Map<string, VariableSource | undefined>,
  name: string,
  from: VariableSource | undefined,
): void {
  if (!usedVars.has(name)) {
    usedVars.set(name, from);
  } else if (usedVars.get(name) === undefined && from !== undefined) {
    usedVars.set(name, from);
  }
}

function resolveBaseUrl(
  vars: CollectionVars,
  usedVars: Map<string, VariableSource | undefined>,
  problems: string[],
  context: string,
): { origin?: string; baseSegments: PathSegment[]; unresolved: string[] } {
  const val = vars.values.get('baseUrl');
  if (val === undefined || val === '') {
    recordUsedVar(usedVars, 'baseUrl', undefined);
    return { origin: undefined, baseSegments: [], unresolved: ['baseUrl'] };
  }
  const trimmed = val.trim();
  if (trimmed.length > COLLECTION_LIMITS.urlChars) {
    addProblem(problems, `${context}: baseUrl exceeds ${COLLECTION_LIMITS.urlChars} characters`);
    recordUsedVar(usedVars, 'baseUrl', vars.sources.get('baseUrl'));
    return { origin: undefined, baseSegments: [], unresolved: ['baseUrl'] };
  }
  const candidate = trimmed.includes('://') ? trimmed : trimmed.startsWith('/') ? '' : `https://${trimmed}`;
  if (!candidate) {
    addProblem(problems, `${context}: baseUrl must be a full URL (e.g. https://api.example.com)`);
    recordUsedVar(usedVars, 'baseUrl', vars.sources.get('baseUrl'));
    return { origin: undefined, baseSegments: [], unresolved: ['baseUrl'] };
  }
  try {
    const parsed = new URL(candidate);
    if (!parsed.hostname) {
      addProblem(problems, `${context}: baseUrl has no host`);
      recordUsedVar(usedVars, 'baseUrl', vars.sources.get('baseUrl'));
      return { origin: undefined, baseSegments: [], unresolved: ['baseUrl'] };
    }
    const origin = `${parsed.protocol}//${parsed.hostname}${parsed.port ? `:${parsed.port}` : ''}`;
    const baseSegments = parsePathSegments(parsed.pathname);
    recordUsedVar(usedVars, 'baseUrl', vars.sources.get('baseUrl'));
    return { origin, baseSegments, unresolved: [] };
  } catch {
    addProblem(problems, `${context}: baseUrl is not a valid URL`);
    recordUsedVar(usedVars, 'baseUrl', vars.sources.get('baseUrl'));
    return { origin: undefined, baseSegments: [], unresolved: ['baseUrl'] };
  }
}

function resolveServer(
  servers: unknown[] | undefined,
  vars: CollectionVars,
  usedVars: Map<string, VariableSource | undefined>,
  problems: string[],
  context: string,
): ResolvedServer {
  if (!servers || servers.length === 0) {
    const base = resolveBaseUrl(vars, usedVars, problems, context);
    return { origin: base.origin, prefixSegments: base.baseSegments, unresolved: base.unresolved };
  }

  const first = servers[0];
  if (!isObj(first) || typeof first['url'] !== 'string' || first['url'].trim() === '') {
    if (!isObj(first) || (hasOwn(first, 'url') && first['url'] !== '')) {
      addProblem(problems, `${context}: server entry is missing a valid "url" (falling back to baseUrl)`);
    }
    const base = resolveBaseUrl(vars, usedVars, problems, context);
    return { origin: base.origin, prefixSegments: base.baseSegments, unresolved: base.unresolved };
  }

  const rawUrl = first['url'].trim();
  if (rawUrl.length > COLLECTION_LIMITS.urlChars) {
    addProblem(problems, `${context}: server URL exceeds ${COLLECTION_LIMITS.urlChars} characters (skipped)`);
    return { prefixSegments: [], unresolved: [], urlTooLong: true };
  }

  const serverVars = isObj(first['variables']) ? first['variables'] : undefined;
  const { substituted, unresolvedTemplateVars } = substituteServerVars(rawUrl, serverVars, vars, usedVars);

  if (substituted.length > COLLECTION_LIMITS.urlChars) {
    addProblem(problems, `${context}: resolved server URL exceeds ${COLLECTION_LIMITS.urlChars} characters (skipped)`);
    return { prefixSegments: [], unresolved: [], urlTooLong: true };
  }

  const schemeEnd = findSchemeEnd(substituted);
  if (schemeEnd < 0) {
    // Relative server URL (§21.3): keep server path prefix, resolve origin via `baseUrl`.
    const serverPrefix = parsePathSegments(substituted);
    const base = resolveBaseUrl(vars, usedVars, problems, context);
    return {
      origin: base.origin,
      prefixSegments: [...base.baseSegments, ...serverPrefix],
      unresolved: base.unresolved,
    };
  }

  const schemePart = substituted.slice(0, schemeEnd);
  const afterScheme = substituted.slice(schemeEnd + 3);
  const pathStart = findDelimiter(afterScheme);
  const authorityPart = pathStart >= 0 ? afterScheme.slice(0, pathStart) : afterScheme;
  const pathPart = pathStart >= 0 ? afterScheme.slice(pathStart) : '';
  const prefixSegments = parsePathSegments(pathPart);

  const authorityUnresolved = collectUnresolvedInSlice(schemePart, authorityPart, unresolvedTemplateVars);
  if (authorityUnresolved.length > 0 || authorityPart === '') {
    return { origin: undefined, prefixSegments, unresolved: authorityUnresolved };
  }

  try {
    const parsed = new URL(`${schemePart}://${authorityPart}`);
    if (!parsed.hostname) {
      addProblem(problems, `${context}: server URL "${quoteFileText(rawUrl, MAX_QUOTED_URL_CHARS)}" has no host`);
      return { origin: undefined, prefixSegments, unresolved: [] };
    }
    const origin = `${parsed.protocol}//${parsed.hostname}${parsed.port ? `:${parsed.port}` : ''}`;
    return { origin, prefixSegments, unresolved: [] };
  } catch {
    addProblem(problems, `${context}: server URL "${quoteFileText(rawUrl, MAX_QUOTED_URL_CHARS)}" is not valid`);
    return { origin: undefined, prefixSegments, unresolved: [] };
  }
}

function substituteServerVars(
  template: string,
  serverVars: Dict | undefined,
  vars: CollectionVars,
  usedVars: Map<string, VariableSource | undefined>,
): { substituted: string; unresolvedTemplateVars: Set<string> } {
  const unresolvedTemplateVars = new Set<string>();
  let out = '';
  let i = 0;
  while (i < template.length) {
    const open = template.indexOf('{', i);
    if (open < 0) {
      out += template.slice(i);
      break;
    }
    const close = template.indexOf('}', open + 1);
    if (close < 0) {
      out += template.slice(i);
      break;
    }
    const varName = template.slice(open + 1, close);
    if (!varName || varName.includes('{')) {
      out += template.slice(i, open + 1);
      i = open + 1;
      continue;
    }
    out += template.slice(i, open);
    i = close + 1;

    const linkVal = vars.values.get(varName);
    if (linkVal !== undefined && linkVal !== '') {
      recordUsedVar(usedVars, varName, vars.sources.get(varName));
      out += linkVal;
      continue;
    }

    let serverDefault: string | undefined;
    if (serverVars && hasOwn(serverVars, varName)) {
      const defObj = serverVars[varName];
      if (isObj(defObj)) {
        const d = defObj['default'];
        if (typeof d === 'string' && d !== '') serverDefault = d;
        else if (typeof d === 'number' || typeof d === 'boolean') serverDefault = String(d);
      }
    }
    if (serverDefault !== undefined) {
      recordUsedVar(usedVars, varName, 'server');
      out += serverDefault;
    } else {
      recordUsedVar(usedVars, varName, undefined);
      unresolvedTemplateVars.add(varName);
      out += `{${varName}}`;
    }
  }
  return { substituted: out, unresolvedTemplateVars };
}

function findSchemeEnd(url: string): number {
  const idx = url.indexOf('://');
  if (idx <= 0) return -1;
  const delim = findDelimiter(url);
  if (delim >= 0 && delim < idx) return -1;
  const scheme = url.slice(0, idx);
  // Allow static schemes (`https`) or unresolved template (`{scheme}`).
  if (/^(?:[A-Za-z][A-Za-z0-9+.-]*|\{[^{}/?#: ]+\})$/.test(scheme)) {
    return idx;
  }
  return -1;
}

function findDelimiter(s: string): number {
  let best = -1;
  for (const ch of ['/', '?', '#']) {
    const pos = s.indexOf(ch);
    if (pos >= 0 && (best < 0 || pos < best)) best = pos;
  }
  return best;
}

function collectUnresolvedInSlice(scheme: string, authority: string, candidates: Set<string>): string[] {
  if (candidates.size === 0) return [];
  const combined = `${scheme}://${authority}`;
  const out: string[] = [];
  for (const name of candidates) {
    if (combined.includes(`{${name}}`)) out.push(name);
  }
  return out;
}

function parsePathSegments(rawPath: string): PathSegment[] {
  const qIdx = rawPath.indexOf('?');
  const hIdx = rawPath.indexOf('#');
  const end = qIdx >= 0 && hIdx >= 0 ? Math.min(qIdx, hIdx) : qIdx >= 0 ? qIdx : hIdx;
  const clean = end >= 0 ? rawPath.slice(0, end) : rawPath;
  const segments: PathSegment[] = [];
  for (const seg of clean.split('/')) {
    if (!seg) continue;
    if (seg.startsWith('{') && seg.endsWith('}') && seg.length > 2) {
      const inner = seg.slice(1, -1);
      if (!inner.includes('{') && !inner.includes('}')) {
        segments.push({ param: inner });
        continue;
      }
    }
    segments.push(seg);
  }
  return segments;
}

function parseStatusCode(code: string, onlyDefault: boolean): number | undefined {
  if (code === 'default') return onlyDefault ? 200 : 500;
  if (/^[1-5]XX$/i.test(code)) return Number(code[0]) * 100;
  if (/^[1-5]\d{2}$/.test(code)) return Number(code);
  return undefined;
}

function isJsonMediaType(mediaType: string): boolean {
  const base = mediaType.split(';')[0].trim().toLowerCase();
  return base === 'application/json' || base.endsWith('/json') || base.endsWith('+json');
}

function pickMediaType(content: Dict): string | undefined {
  const keys = Object.keys(content);
  for (const k of keys) {
    if (k.split(';')[0].trim().toLowerCase() === 'application/json') return k;
  }
  for (const k of keys) {
    const base = k.split(';')[0].trim().toLowerCase();
    if (base.endsWith('/json') || base.endsWith('+json')) return k;
  }
  return keys[0];
}

function cloneHeadersWithContentType(base: Record<string, string>, contentType?: string): Record<string, string> {
  const out = dict<string>();
  if (contentType !== undefined) {
    out['content-type'] = contentType;
  }
  for (const k of Object.keys(base)) {
    if (contentType !== undefined && k === 'content-type') continue;
    out[k] = base[k];
  }
  return out;
}

function extractHeaders(
  rawHeaders: unknown,
  doc: unknown,
  budget: WalkBudget,
  problems: string[],
  context: string,
): Record<string, string> {
  const headers = dict<string>();
  if (rawHeaders === undefined) return headers;
  if (!isObj(rawHeaders)) {
    addProblem(problems, `${context}: "headers" must be an object (ignored)`);
    return headers;
  }

  for (const hName of Object.keys(rawHeaders)) {
    if (budget.exceeded) break;
    const safeHdr = quoteFileText(hName);
    const hDeref = deref(rawHeaders[hName], doc, budget, problems, `${context} header "${safeHdr}"`);
    if (!hDeref.ok || !isObj(hDeref.value)) continue;
    const hObj = hDeref.value;

    let val: unknown;
    let found = false;
    if (hasOwn(hObj, 'example') && hObj['example'] !== undefined) {
      val = hObj['example'];
      found = true;
    } else if (hasOwn(hObj, 'schema') && hObj['schema'] !== undefined) {
      const sDeref = deref(hObj['schema'], doc, budget, problems, `${context} header "${safeHdr}"`);
      if (sDeref.ok && isObj(sDeref.value)) {
        const hs = sDeref.value;
        if (hasOwn(hs, 'example') && hs['example'] !== undefined) {
          val = hs['example'];
          found = true;
        } else if (Array.isArray(hs['examples']) && hs['examples'].length > 0 && hs['examples'][0] !== undefined) {
          val = hs['examples'][0];
          found = true;
        }
      }
    }

    if (!found || val === undefined || val === null) continue;
    let str: string;
    if (typeof val === 'string') {
      str = val;
    } else if (typeof val === 'number' || typeof val === 'boolean') {
      str = String(val);
    } else {
      const formatted = formatJsonChecked(val, COLLECTION_LIMITS.exampleBodyBytes, budget, problems, `${context} header "${safeHdr}"`);
      if (budget.exceeded || formatted.cut) continue;
      str = formatted.text;
    }
    headers[hName.toLowerCase()] = str;
  }

  return headers;
}

function parseResponses(
  op: Dict,
  doc: unknown,
  endpointCtx: string,
  budget: WalkBudget,
  bodyBudget: BodyBudget,
  cache: ExampleCache,
  problems: string[],
): MockExample[] {
  if (!hasOwn(op, 'responses') || op['responses'] === undefined) {
    addProblem(problems, `${endpointCtx}: missing "responses" object`);
    return [];
  }
  if (!isObj(op['responses'])) {
    addProblem(problems, `${endpointCtx}: "responses" must be an object`);
    return [];
  }
  if (bodyBudget.exceeded) return [];

  const responsesObj = op['responses'];
  const responseCodes = Object.keys(responsesObj).filter((k) => !k.startsWith('x-'));
  const onlyDefault = responseCodes.length === 1 && responseCodes[0] === 'default';
  const examples: MockExample[] = [];
  let exampleLimitReported = false;
  const reportExampleLimit = (): void => {
    if (!exampleLimitReported) {
      exampleLimitReported = true;
      addProblem(problems, `${endpointCtx}: more than ${COLLECTION_LIMITS.examplesPerEndpoint} examples; the rest are skipped`);
    }
  };

  for (const code of responseCodes) {
    if (budget.exceeded || bodyBudget.exceeded) break;
    if (examples.length >= COLLECTION_LIMITS.examplesPerEndpoint) {
      reportExampleLimit();
      break;
    }

    const safeCode = quoteFileText(code);
    const status = parseStatusCode(code, onlyDefault);
    if (status === undefined) {
      addProblem(problems, `${endpointCtx}: unrecognized response code "${safeCode}" (skipped)`);
      continue;
    }

    const resCtx = `${endpointCtx} (${safeCode})`;
    const resDeref = deref(responsesObj[code], doc, budget, problems, resCtx);
    if (!resDeref.ok) continue;
    if (!isObj(resDeref.value)) {
      addProblem(problems, `${resCtx}: response must be an object (skipped)`);
      continue;
    }
    const resp = resDeref.value;
    const baseHeaders = extractHeaders(resp['headers'], doc, budget, problems, resCtx);

    if (!hasOwn(resp, 'content') || resp['content'] === undefined || resp['content'] === null) {
      if (tryConsumeBody(bodyBudget, 0, problems)) {
        examples.push({ name: code, status, headers: cloneHeadersWithContentType(baseHeaders), body: '' });
      }
      continue;
    }
    if (!isObj(resp['content'])) {
      addProblem(problems, `${resCtx}: "content" must be an object`);
      if (tryConsumeBody(bodyBudget, 0, problems)) {
        examples.push({ name: code, status, headers: cloneHeadersWithContentType(baseHeaders), body: '' });
      }
      continue;
    }

    const chosenMt = pickMediaType(resp['content']);
    if (!chosenMt) {
      if (tryConsumeBody(bodyBudget, 0, problems)) {
        examples.push({ name: code, status, headers: cloneHeadersWithContentType(baseHeaders), body: '' });
      }
      continue;
    }

    const mtDeref = deref(resp['content'][chosenMt], doc, budget, problems, resCtx);
    if (!mtDeref.ok) continue;
    if (!isObj(mtDeref.value)) {
      addProblem(problems, `${resCtx}: media type "${quoteFileText(chosenMt)}" must be an object (skipped)`);
      continue;
    }
    const mtObj = mtDeref.value;
    const isJson = isJsonMediaType(chosenMt);

    const maxMb = Math.round(COLLECTION_LIMITS.exampleBodyBytes / (1024 * 1024));
    const formatExplicit = (val: unknown, ctx: string): { text: string; byteLen: number } | undefined => {
      if (!isJson && typeof val === 'string') {
        let byteLen = cache.rawStrBytes.get(val);
        if (byteLen === undefined) {
          byteLen = utf8Bytes(val);
          cache.rawStrBytes.set(val, byteLen);
        }
        if (byteLen > COLLECTION_LIMITS.exampleBodyBytes) {
          addProblem(problems, `${ctx}: example body exceeds ${maxMb} MB limit (skipped)`);
          return undefined;
        }
        return { text: val, byteLen };
      }
      if (typeof val === 'string') {
        const hit = cache.jsonStr.get(val);
        if (hit) {
          if (hit.cut) {
            addProblem(problems, `${ctx}: example body exceeds ${maxMb} MB limit (skipped)`);
            return undefined;
          }
          return { text: hit.text, byteLen: hit.byteLen };
        }
        const res = formatJsonChecked(val, COLLECTION_LIMITS.exampleBodyBytes, budget, problems, ctx);
        if (budget.exceeded) return undefined;
        const entry: CachedJson = res.cut
          ? { text: '', byteLen: 0, cut: true }
          : { text: res.text, byteLen: utf8Bytes(res.text), cut: false };
        cache.jsonStr.set(val, entry);
        if (entry.cut) {
          addProblem(problems, `${ctx}: example body exceeds ${maxMb} MB limit (skipped)`);
          return undefined;
        }
        return { text: entry.text, byteLen: entry.byteLen };
      }
      if (typeof val === 'object' && val !== null) {
        const hit = cache.jsonObj.get(val);
        if (hit) {
          if (hit.cut) {
            addProblem(problems, `${ctx}: example body exceeds ${maxMb} MB limit (skipped)`);
            return undefined;
          }
          return { text: hit.text, byteLen: hit.byteLen };
        }
        const res = formatJsonChecked(val, COLLECTION_LIMITS.exampleBodyBytes, budget, problems, ctx);
        if (budget.exceeded) return undefined;
        const entry: CachedJson = res.cut
          ? { text: '', byteLen: 0, cut: true }
          : { text: res.text, byteLen: utf8Bytes(res.text), cut: false };
        cache.jsonObj.set(val, entry);
        if (entry.cut) {
          addProblem(problems, `${ctx}: example body exceeds ${maxMb} MB limit (skipped)`);
          return undefined;
        }
        return { text: entry.text, byteLen: entry.byteLen };
      }
      const res = formatJsonChecked(val, COLLECTION_LIMITS.exampleBodyBytes, budget, problems, ctx);
      if (budget.exceeded) return undefined;
      if (res.cut) {
        addProblem(problems, `${ctx}: example body exceeds ${maxMb} MB limit (skipped)`);
        return undefined;
      }
      return { text: res.text, byteLen: utf8Bytes(res.text) };
    };

    // 1. Named `examples` map (§21.3).
    let handled = false;
    let skippedExplicit = false;
    if (hasOwn(mtObj, 'examples') && mtObj['examples'] !== undefined) {
      if (!isObj(mtObj['examples'])) {
        addProblem(problems, `${resCtx}: "examples" must be an object (ignored)`);
      } else {
        let addedNamed = 0;
        const exMap = mtObj['examples'];
        for (const exKey of Object.keys(exMap)) {
          if (budget.exceeded || bodyBudget.exceeded) break;
          if (examples.length >= COLLECTION_LIMITS.examplesPerEndpoint) {
            reportExampleLimit();
            handled = true;
            break;
          }
          const exCtx = `${endpointCtx} (${safeCode} · ${quoteFileText(exKey)})`;
          const exDeref = deref(exMap[exKey], doc, budget, problems, exCtx);
          if (!exDeref.ok) {
            skippedExplicit = true;
            continue;
          }
          if (!isObj(exDeref.value)) {
            addProblem(problems, `${exCtx}: example must be an object (skipped)`);
            skippedExplicit = true;
            continue;
          }
          const exObj = exDeref.value;
          if (hasOwn(exObj, 'value') && exObj['value'] !== undefined) {
            const formatted = formatExplicit(exObj['value'], exCtx);
            if (!formatted) {
              skippedExplicit = true;
              continue;
            }
            if (!tryConsumeBody(bodyBudget, formatted.byteLen, problems)) {
              handled = true;
              break;
            }
            examples.push({
              name: `${code} · ${exKey}`,
              status,
              headers: cloneHeadersWithContentType(baseHeaders, chosenMt),
              body: formatted.text,
            });
            addedNamed += 1;
          } else if (hasOwn(exObj, 'externalValue') && exObj['externalValue'] !== undefined) {
            addProblem(
              problems,
              `${exCtx}: externalValue is not fetched (${quoteFileText(String(exObj['externalValue']), MAX_QUOTED_URL_CHARS)}) (skipped)`,
            );
            skippedExplicit = true;
          } else {
            addProblem(problems, `${exCtx}: example has no "value" (skipped)`);
            skippedExplicit = true;
          }
        }
        if (addedNamed > 0) handled = true;
      }
    }
    if (handled || budget.exceeded || bodyBudget.exceeded) continue;

    // 2. Single `example` on media type (§21.3).
    if (hasOwn(mtObj, 'example') && mtObj['example'] !== undefined) {
      const formatted = formatExplicit(mtObj['example'], resCtx);
      if (budget.exceeded) continue;
      if (formatted) {
        if (tryConsumeBody(bodyBudget, formatted.byteLen, problems)) {
          examples.push({
            name: code,
            status,
            headers: cloneHeadersWithContentType(baseHeaders, chosenMt),
            body: formatted.text,
          });
        }
        continue;
      }
      skippedExplicit = true;
    }

    // 3 & 4. Schema `example` / `examples[0]` or generated from schema (§21.3, §21.4).
    if (hasOwn(mtObj, 'schema') && mtObj['schema'] !== undefined) {
      const sDeref = deref(mtObj['schema'], doc, budget, problems, resCtx);
      if (!sDeref.ok) continue;
      if (sDeref.value !== true && sDeref.value !== false && !isObj(sDeref.value)) {
        addProblem(problems, `${resCtx}: schema must be an object (skipped)`);
        continue;
      }

      if (isObj(sDeref.value)) {
        const schemaObj = sDeref.value;
        if (hasOwn(schemaObj, 'example') && schemaObj['example'] !== undefined) {
          const formatted = formatExplicit(schemaObj['example'], resCtx);
          if (formatted && tryConsumeBody(bodyBudget, formatted.byteLen, problems)) {
            examples.push({
              name: code,
              status,
              headers: cloneHeadersWithContentType(baseHeaders, chosenMt),
              body: formatted.text,
            });
          }
          continue;
        }
        if (hasOwn(schemaObj, 'examples') && schemaObj['examples'] !== undefined) {
          if (!Array.isArray(schemaObj['examples'])) {
            addProblem(problems, `${resCtx}: schema "examples" must be an array (ignored)`);
          } else if (schemaObj['examples'].length > 0 && schemaObj['examples'][0] !== undefined) {
            const formatted = formatExplicit(schemaObj['examples'][0], resCtx);
            if (formatted && tryConsumeBody(bodyBudget, formatted.byteLen, problems)) {
              examples.push({
                name: code,
                status,
                headers: cloneHeadersWithContentType(baseHeaders, chosenMt),
                body: formatted.text,
              });
            }
            continue;
          }
        }
      }

      const genCache = isJson ? cache.genJson : cache.genRaw;
      const cacheKey = sDeref.targetObj !== undefined && sDeref.value === sDeref.targetObj ? sDeref.targetObj : undefined;
      let genBody: string;
      let genBytes: number;
      const cachedGen = cacheKey ? genCache.get(cacheKey) : undefined;
      if (cachedGen) {
        genBody = cachedGen.text;
        genBytes = cachedGen.byteLen;
      } else {
        const genProblems: string[] = [];
        genBody = generateSchemaBody(
          mtObj['schema'],
          doc,
          { isJson, budget, maxBytes: COLLECTION_LIMITS.generateBytes, context: resCtx },
          genProblems,
        );
        for (const p of genProblems) problems.push(p);
        genBytes = utf8Bytes(genBody);
        if (cacheKey && genProblems.length === 0 && !budget.exceeded) {
          genCache.set(cacheKey, { text: genBody, byteLen: genBytes });
        }
      }
      if (tryConsumeBody(bodyBudget, genBytes, problems)) {
        examples.push({
          name: code,
          status,
          headers: cloneHeadersWithContentType(baseHeaders, chosenMt),
          body: genBody,
          generated: true,
        });
      }
      continue;
    }

    // 5. Media type present without example or schema -> empty body with content-type (unless explicit example was skipped).
    if (!skippedExplicit && tryConsumeBody(bodyBudget, 0, problems)) {
      examples.push({
        name: code,
        status,
        headers: cloneHeadersWithContentType(baseHeaders, chosenMt),
        body: '',
      });
    }
  }

  return examples;
}
