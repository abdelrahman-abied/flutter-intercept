/**
 * Retrofit and Chopper API declarations → endpoints (CONTRACTS §10.3). Reads the annotated abstract
 * class (`@RestApi(baseUrl:)` + `@GET('/users/{id}')`, `@ChopperApi(baseUrl:)` + `@Get(path:)`), and
 * the response model from the return type (`Future<User>`, `Future<HttpResponse<User>>`,
 * `Future<List<User>>`, `Future<Response<User>>`). Pure; never throws.
 */
import type { ApiEndpoint, ApiParam } from './types';
import { lineIndex, Parser, Tok, tokenize, TypeNode } from './dart';

export interface XEndpoint extends ApiEndpoint {
  /** The abstract API class, e.g. "UsersApi". */
  apiClass: string;
  kind: 'retrofit' | 'chopper';
  /** Literal path from the annotation (before joining the base). */
  rawPath: string;
}

const HTTP_METHODS: Record<string, string> = {
  GET: 'GET',
  POST: 'POST',
  PUT: 'PUT',
  DELETE: 'DELETE',
  PATCH: 'PATCH',
  HEAD: 'HEAD',
  OPTIONS: 'OPTIONS',
  Get: 'GET',
  Post: 'POST',
  Put: 'PUT',
  Delete: 'DELETE',
  Patch: 'PATCH',
  Head: 'HEAD',
  Options: 'OPTIONS',
};

const NOT_MODELS = new Set([
  'void',
  'dynamic',
  'Object',
  'String',
  'int',
  'double',
  'num',
  'bool',
  'Map',
  'List',
  'Set',
  'Iterable',
  'Uint8List',
  'Stream',
  'ResponseBody',
  'Null',
  'Never',
  'DateTime',
]);

interface Annotation {
  name: string;
  args: { name?: string; value: string | undefined }[];
}

/** Reads `@Name(args)` at `i` → annotation + index after it. String args only (others → undefined). */
function readAnnotation(toks: Tok[], i: number): { ann: Annotation; next: number } | undefined {
  if (toks[i]?.v !== '@' || toks[i + 1]?.k !== 'id') return undefined;
  let name = toks[i + 1].v;
  let j = i + 2;
  while (toks[j]?.v === '.' && toks[j + 1]?.k === 'id') {
    name = toks[j + 1].v; // `@retrofit.GET` → GET
    j += 2;
  }
  const ann: Annotation = { name, args: [] };
  if (toks[j]?.v === '(') {
    const p = new Parser(toks, j);
    const close = p.matching(j);
    try {
      for (const a of p.args()) ann.args.push({ name: a.name, value: a.value.k === 'str' ? a.value.v : undefined });
    } catch {
      // unreadable args
    }
    j = close + 1;
  }
  return { ann, next: j };
}

/** Peels Future/Stream, HttpResponse/Response wrappers and List. */
function responseOf(t: TypeNode | undefined): { model?: string; list: boolean } {
  let cur = t;
  for (let guard = 0; cur && guard < 6; guard++) {
    const name = cur.name.replace(/^.*\./, '');
    if ((name === 'Future' || name === 'FutureOr' || name === 'Stream' || name === 'HttpResponse' || name === 'Response') && cur.args.length) {
      cur = cur.args[0];
      continue;
    }
    break;
  }
  if (!cur) return { list: false };
  const name = cur.name.replace(/^.*\./, '');
  if ((name === 'List' || name === 'Iterable') && cur.args[0]) {
    const el = cur.args[0].name.replace(/^.*\./, '');
    return NOT_MODELS.has(el) || cur.args[0].name === 'Function' ? { list: true } : { model: el, list: true };
  }
  if (NOT_MODELS.has(name) || name === 'Function' || name === '?' || /^[A-Z]$/.test(name)) return { list: false };
  return { model: name, list: false };
}

/** Dio-style join (`baseUrl + path`, `//` collapsed after the scheme). */
export function joinUrl(base: string, path: string): string {
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(path)) return path;
  const url = base + path;
  const m = /^([a-z][a-z0-9+.-]*:\/)(\/.*)$/i.exec(url);
  return m ? `${m[1]}/${m[2].slice(1).replace(/\/{2,}/g, '/')}` : url.replace(/\/{2,}/g, '/');
}

/** Splits a joined URL template into base (origin) + path template. */
function splitTemplate(full: string): { origin?: string; path: string } {
  const m = /^([a-z][a-z0-9+.-]*:\/\/[^/?#]+)(.*)$/i.exec(full);
  const rest = m ? m[2] : full;
  const path = rest.replace(/[?#].*$/, '');
  return { origin: m?.[1], path: path.startsWith('/') ? path : `/${path}` };
}

export function parseApiFile(text: string, file: string): XEndpoint[] {
  const out: XEndpoint[] = [];
  let toks: Tok[];
  try {
    toks = tokenize(text);
  } catch {
    return out;
  }
  const lineOf = lineIndex(text);
  for (let i = 0; i < toks.length; i++) {
    const a = readAnnotation(toks, i);
    if (!a || (a.ann.name !== 'RestApi' && a.ann.name !== 'ChopperApi')) continue;
    try {
      const kind = a.ann.name === 'RestApi' ? 'retrofit' : 'chopper';
      const baseArg = a.ann.args.find((x) => x.name === 'baseUrl');
      const baseKnown = !baseArg || baseArg.value !== undefined;
      const base = baseArg?.value ?? '';
      // skip further annotations, then `abstract class Name … {`
      let j = a.next;
      while (toks[j]?.v === '@') j = readAnnotation(toks, j)?.next ?? j + 1;
      while (j < toks.length && toks[j].v !== 'class') j++;
      const apiClass = toks[j + 1]?.v;
      while (j < toks.length && toks[j].v !== '{') j++;
      if (!apiClass || toks[j]?.v !== '{') continue;
      const close = new Parser(toks, j).matching(j);
      out.push(...parseMembers(toks, j + 1, close, { kind, base, baseKnown, apiClass, file, lineOf, text }));
      i = close;
    } catch {
      // skip this API class
    }
  }
  return out;
}

interface ClassCtx {
  text: string;
  kind: 'retrofit' | 'chopper';
  base: string;
  baseKnown: boolean;
  apiClass: string;
  file: string;
  lineOf: (p: number) => number;
}

function parseMembers(toks: Tok[], from: number, to: number, c: ClassCtx): XEndpoint[] {
  const out: XEndpoint[] = [];
  let k = from;
  let last = -1;
  while (k < to) {
    if (k === last) k++; // always progress
    last = k;
    if (k >= to) break;
    if (toks[k].v !== '@') {
      // skip a non-annotated member: to `;` or a balanced body
      if (toks[k].v === '{' || toks[k].v === '(' || toks[k].v === '[') k = new Parser(toks, k).matching(k);
      k++;
      continue;
    }
    let method: string | undefined;
    let path: string | undefined;
    let annLine = c.lineOf(toks[k].pos);
    while (toks[k]?.v === '@' && k < to) {
      const a = readAnnotation(toks, k);
      if (!a) break;
      const m = HTTP_METHODS[a.ann.name];
      if (m) {
        method = m;
        annLine = c.lineOf(toks[k].pos);
        const named = a.ann.args.find((x) => x.name === 'path');
        const positional = a.ann.args.find((x) => !x.name);
        path = (named ?? positional)?.value ?? (c.kind === 'chopper' && !named && !positional ? '' : undefined);
      } else if (a.ann.name === 'Method' || a.ann.name === 'Http') {
        // retrofit @Method('GET', '/x') / chopper @Method(HttpMethod.Get, path: ...)
        const pos = a.ann.args.filter((x) => !x.name);
        const meth = a.ann.args.find((x) => x.name === 'method')?.value ?? pos[0]?.value;
        if (meth) method = meth.toUpperCase();
        path = a.ann.args.find((x) => x.name === 'path')?.value ?? pos[1]?.value ?? path;
      }
      k = a.next;
    }
    // return type, then method name, then (
    const p = new Parser(toks, k);
    const typeStart = p.i;
    const type = p.tryType();
    const typeEnd = p.i;
    const nameTok = p.t;
    if (!type || nameTok.k !== 'id' || toks[p.i + 1]?.v !== '(') {
      continue;
    }
    const paren = p.i + 1;
    k = new Parser(toks, paren).matching(paren) + 1;
    if (toks[k]?.v === '{') k = new Parser(toks, k).matching(k) + 1;
    else if (toks[k]?.v === '=>') {
      while (k < to && toks[k].v !== ';') k++;
    }
    if (!method || path === undefined) continue;
    const resp = responseOf(type);
    let full: string;
    if (c.kind === 'chopper') {
      // ChopperApi baseUrl is a path prefix (or a full URL) joined with the method path
      full = /^[a-z][a-z0-9+.-]*:\/\//i.test(path) ? path : joinPath(c.base, path);
    } else {
      full = joinUrl(c.baseKnown ? c.base : '', path);
    }
    const { origin, path: pathTemplate } = splitTemplate(full);
    const ep: XEndpoint = {
      method,
      pathTemplate,
      dartMethod: nameTok.v,
      file: c.file,
      line: annLine,
      apiClass: c.apiClass,
      kind: c.kind,
      rawPath: path,
      className: c.apiClass,
      returnType: sourceText(c.text, toks, typeStart, typeEnd),
      params: parseParams(toks, paren, c.text),
    };
    if (origin) ep.baseUrl = c.kind === 'retrofit' && c.base && !/^[a-z][a-z0-9+.-]*:\/\//i.test(path) ? c.base : origin;
    if (resp.model) ep.responseModel = resp.model;
    if (resp.list) ep.responseIsList = true;
    out.push(ep);
  }
  return out;
}

function joinPath(a: string, b: string): string {
  if (!a) return b || '/';
  if (!b) return a;
  return `${a.replace(/\/+$/, '')}/${b.replace(/^\/+/, '')}`;
}

/** Source text of tokens [from, to) with whitespace collapsed: "Future<HttpResponse<User>>". */
function sourceText(text: string, toks: Tok[], from: number, to: number): string {
  if (to <= from) return '';
  return text.slice(toks[from].pos, toks[to - 1].end).replace(/\s+/g, ' ').replace(/\s*([<>,?])\s*/g, (m, c: string) => (c === ',' ? ', ' : c));
}

const PARAM_KINDS: Record<string, ApiParam['kind']> = {
  Path: 'path',
  Query: 'query',
  Queries: 'query',
  QueryMap: 'query',
  Body: 'body',
  BodyExtra: 'body',
  Header: 'header',
  Headers: 'header',
  HeaderMap: 'header',
  Field: 'field',
  FieldMap: 'field',
  Part: 'field',
  PartFile: 'field',
  PartMap: 'field',
};

/** Parameters of the method whose `(` is at `paren`. */
function parseParams(toks: Tok[], paren: number, text: string): ApiParam[] {
  const out: ApiParam[] = [];
  const close = new Parser(toks, paren).matching(paren);
  let k = paren + 1;
  let named = false;
  while (k < close) {
    const t = toks[k];
    if (t.v === '{' || t.v === '[') {
      named = t.v === '{';
      k++;
      continue;
    }
    if (t.v === '}' || t.v === ']' || t.v === ',') {
      k++;
      continue;
    }
    // one parameter: annotations, `required`, type, name, `= default`
    let kind: ApiParam['kind'] = 'other';
    let key: string | undefined;
    const start = k;
    while (toks[k]?.v === '@' && k < close) {
      const a = readAnnotation(toks, k);
      if (!a) break;
      const pk = PARAM_KINDS[a.ann.name];
      if (pk) {
        kind = pk;
        key = a.ann.args.find((x) => !x.name)?.value ?? a.ann.args.find((x) => x.name === 'name' || x.name === 'value')?.value;
      }
      k = a.next;
    }
    if (toks[k]?.v === 'required') k++;
    const p = new Parser(toks, k);
    const typeStart = k;
    const type = toks[k + 1]?.v === ',' || toks[k + 1]?.v === ')' || toks[k + 1]?.v === '}' || toks[k + 1]?.v === ']' || toks[k + 1]?.v === '=' ? undefined : p.tryType();
    const nameIdx = type ? p.i : k;
    const nameTok = toks[nameIdx];
    // advance to the next top-level comma / closer
    let j = nameIdx + 1;
    while (j < close && toks[j].v !== ',' && toks[j].v !== '}' && toks[j].v !== ']') {
      if (toks[j].v === '(' || toks[j].v === '[' || toks[j].v === '{') j = new Parser(toks, j).matching(j);
      j++;
    }
    if (nameTok?.k === 'id' && nameIdx < close) {
      const param: ApiParam = { name: nameTok.v, type: type ? sourceText(text, toks, typeStart, nameIdx) : 'dynamic', kind };
      if (key !== undefined && key !== nameTok.v) param.key = key;
      if (named) param.named = true;
      out.push(param);
    }
    k = Math.max(j, start + 1);
  }
  return out;
}
