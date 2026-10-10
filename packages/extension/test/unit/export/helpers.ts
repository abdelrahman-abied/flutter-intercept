import type { Exchange } from '@flutter-intercept/proxy';

let seq = 0;
let clock = 1_700_000_000_000;

/** A finished JSON exchange; override anything. Bodies given as objects are JSON-encoded. */
export function ex(
  method: string,
  url: string,
  status: number,
  resBody?: unknown,
  over: Partial<Exchange> & { reqBody?: unknown } = {},
): Exchange {
  const { reqBody, ...rest } = over;
  const enc = (b: unknown) => (typeof b === 'string' ? b : JSON.stringify(b));
  return {
    id: `x${++seq}`,
    startedAt: (clock += 1000),
    durationMs: 12,
    method,
    url,
    requestHeaders: { 'user-agent': 'Dart/3.5', ...(reqBody !== undefined ? { 'content-type': 'application/json' } : {}) },
    ...(reqBody !== undefined ? { requestBody: { text: enc(reqBody), encoding: 'utf8' as const } } : {}),
    status,
    responseHeaders: resBody !== undefined ? { 'content-type': 'application/json; charset=utf-8' } : {},
    ...(resBody !== undefined ? { responseBody: { text: enc(resBody), encoding: 'utf8' as const } } : {}),
    state: 'completed',
    ...rest,
  };
}

type Json = Record<string, unknown>;
const TYPES = new Set(['null', 'boolean', 'object', 'array', 'number', 'string', 'integer']);

/** Asserts a JSON Schema (as this exporter writes them) is well formed; returns problems. */
export function schemaProblems(s: unknown, at = '$'): string[] {
  const out: string[] = [];
  if (typeof s !== 'object' || s === null || Array.isArray(s)) return [`${at}: not an object`];
  const o = s as Json;
  if ('$ref' in o) out.push(`${at}: $ref`);
  const types: unknown[] = o.type === undefined ? [] : Array.isArray(o.type) ? o.type : [o.type];
  for (const t of types) if (typeof t !== 'string' || !TYPES.has(t)) out.push(`${at}: bad type ${JSON.stringify(t)}`);
  if (new Set(types).size !== types.length) out.push(`${at}: duplicate types`);
  if (Array.isArray(o.type) && o.type.length < 2) out.push(`${at}: type array with < 2 entries`);
  if (o.properties !== undefined) {
    if (!types.includes('object')) out.push(`${at}: properties without type object`);
    for (const [k, v] of Object.entries(o.properties as Json)) out.push(...schemaProblems(v, `${at}.properties.${k}`));
  }
  if (o.required !== undefined) {
    const req = o.required as unknown[];
    if (!Array.isArray(req) || !req.length) out.push(`${at}: empty or non-array required`);
    else for (const r of req) if (!o.properties || !(String(r) in (o.properties as Json))) out.push(`${at}: required ${String(r)} not in properties`);
  }
  if (o.items !== undefined) {
    if (!types.includes('array')) out.push(`${at}: items without type array`);
    out.push(...schemaProblems(o.items, `${at}.items`));
  }
  if (o.additionalProperties !== undefined) out.push(...schemaProblems(o.additionalProperties, `${at}.additionalProperties`));
  return out;
}

const METHODS = ['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace'];

/** Structural checks of an OpenAPI 3.1 document; returns problems (empty = fine). */
export function openApiProblems(doc: Json): string[] {
  const out: string[] = [];
  if (doc.openapi !== '3.1.0') out.push('openapi version');
  const info = doc.info as Json;
  if (!info || typeof info.title !== 'string' || typeof info.version !== 'string') out.push('info');
  const ids = new Set<string>();
  for (const [path, item] of Object.entries(doc.paths as Json)) {
    if (!path.startsWith('/')) out.push(`${path}: does not start with /`);
    const templ = [...path.matchAll(/\{([^}]+)\}/g)].map((m) => m[1]);
    for (const [method, op] of Object.entries(item as Json)) {
      if (method === 'servers') continue;
      if (!METHODS.includes(method)) {
        out.push(`${path}: bad key ${method}`);
        continue;
      }
      const o = op as Json;
      const where = `${method.toUpperCase()} ${path}`;
      if (typeof o.operationId !== 'string' || !/^[A-Za-z][A-Za-z0-9]*$/.test(o.operationId)) out.push(`${where}: operationId`);
      else if (ids.has(o.operationId)) out.push(`${where}: duplicate operationId ${o.operationId}`);
      else ids.add(o.operationId);
      const params = (o.parameters as Json[] | undefined) ?? [];
      const pathParams = params.filter((p) => p.in === 'path');
      for (const name of templ) {
        const p = pathParams.find((x) => x.name === name);
        if (!p) out.push(`${where}: path param ${name} not declared`);
        else if (p.required !== true) out.push(`${where}: path param ${name} not required`);
      }
      for (const p of pathParams) if (!templ.includes(String(p.name))) out.push(`${where}: extra path param ${String(p.name)}`);
      const keys = new Set<string>();
      for (const p of params) {
        const k = `${String(p.in)}:${String(p.name)}`;
        if (keys.has(k)) out.push(`${where}: duplicate param ${k}`);
        keys.add(k);
        if (!['path', 'query', 'header', 'cookie'].includes(String(p.in))) out.push(`${where}: param in ${String(p.in)}`);
        out.push(...schemaProblems(p.schema, `${where} param ${String(p.name)}`));
      }
      const content = (c: unknown, label: string) => {
        for (const [mt, media] of Object.entries((c ?? {}) as Json)) {
          if (!/^[a-z0-9.+-]+\/[a-z0-9.+*-]+$/i.test(mt)) out.push(`${label}: media type ${mt}`);
          const m = media as Json;
          if (m.schema !== undefined) out.push(...schemaProblems(m.schema, `${label} ${mt}`));
          if (m.example !== undefined && m.examples !== undefined) out.push(`${label}: example and examples`);
        }
      };
      if (o.requestBody) content((o.requestBody as Json).content, `${where} request`);
      const responses = o.responses as Json;
      if (!responses || !Object.keys(responses).length) out.push(`${where}: no responses`);
      for (const [code, r] of Object.entries(responses ?? {})) {
        if (!/^([1-5]\d\d|default)$/.test(code)) out.push(`${where}: response key ${code}`);
        if (typeof (r as Json).description !== 'string' || !(r as Json).description) out.push(`${where} ${code}: description`);
        content((r as Json).content, `${where} ${code}`);
      }
    }
  }
  return out;
}
