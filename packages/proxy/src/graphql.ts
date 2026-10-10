// GraphQL detection (CONTRACTS §11.2). Pure and dependency-free (type-only imports): the webview imports it
// through `@flutter-intercept/proxy/rules`, so its rule preview agrees with the proxy.
//
// No GraphQL parser: a small scanner reads the document's top-level definitions (operation keyword + name),
// skipping comments, strings, block strings, variable definitions (whose default values may contain braces),
// directives and fragment definitions. It never builds an AST; it is linear in the document length.
import type { GraphqlInfo } from './types';

export type GraphqlOperationType = 'query' | 'mutation' | 'subscription';

export interface GraphqlOperationRef {
  type: GraphqlOperationType;
  name?: string;
}

export interface GraphqlDetection {
  /** The (first) operation, as `Exchange.graphql`. */
  info: GraphqlInfo;
  /** Operations in the request (1, or the length of a batched array). */
  count: number;
  /** The name of each operation that would run, in request order (unnamed ones omitted). */
  operationNames: string[];
}

/** Documents longer than this are not scanned (the request is still shown, just not as GraphQL). */
export const GRAPHQL_SCAN_LIMIT = 8 * 1024 * 1024;
/** Operations / batch entries looked at. */
const MAX_OPERATIONS = 100;

const NAME_START = /[_A-Za-z]/;
const NAME_CHAR = /[_0-9A-Za-z]/;
const OPERATION_KEYWORDS = new Set<string>(['query', 'mutation', 'subscription']);
/** Longest operation name kept (REVIEW-5 #9). */
export const MAX_OPERATION_NAME = 200;
const GRAPHQL_NAME = /^[_A-Za-z][_0-9A-Za-z]*$/;

/** A GraphQL Name of at most MAX_OPERATION_NAME characters (look-alikes such as zero-width characters fail). */
export function isValidOperationName(name: unknown): name is string {
  return typeof name === 'string' && name.length > 0 && name.length <= MAX_OPERATION_NAME && GRAPHQL_NAME.test(name);
}

/**
 * The operations of an executable GraphQL document, in order. `undefined` when the text isn't one (e.g.
 * `"shoes"` sent as a REST `query` parameter): every top-level definition must be an operation (keyword or
 * `{` shorthand) or a fragment, with balanced brackets, and there must be at least one operation.
 */
export function scanOperations(doc: string): GraphqlOperationRef[] | undefined {
  if (typeof doc !== 'string' || doc.length === 0 || doc.length > GRAPHQL_SCAN_LIMIT) return undefined;
  const s = new Scanner(doc);
  const ops: GraphqlOperationRef[] = [];
  for (;;) {
    s.skipIgnored();
    if (s.eof()) break;
    const c = doc[s.pos];
    if (c === '{') {
      // Query shorthand: `{ field }`.
      if (!s.skipBalanced()) return undefined;
      ops.push({ type: 'query' });
    } else if (NAME_START.test(c)) {
      const word = s.readName();
      if (OPERATION_KEYWORDS.has(word)) {
        s.skipIgnored();
        let name: string | undefined;
        if (!s.eof() && NAME_START.test(doc[s.pos])) {
          name = s.readName();
          if (name.length > MAX_OPERATION_NAME) name = undefined; // kept unnamed
        }
        if (!s.skipToSelectionSet() || !s.skipBalanced()) return undefined;
        ops.push(name ? { type: word as GraphqlOperationType, name } : { type: word as GraphqlOperationType });
      } else if (word === 'fragment') {
        if (!s.skipToSelectionSet() || !s.skipBalanced()) return undefined;
      } else {
        return undefined; // schema definitions, or not GraphQL at all
      }
    } else {
      return undefined;
    }
    if (ops.length >= MAX_OPERATIONS) break;
  }
  return ops.length ? ops : undefined;
}

class Scanner {
  pos = 0;
  constructor(private readonly s: string) {}

  eof(): boolean {
    return this.pos >= this.s.length;
  }

  /** Whitespace, commas, line terminators, a BOM and `#` comments. */
  skipIgnored(): void {
    const s = this.s;
    while (this.pos < s.length) {
      const c = s.charCodeAt(this.pos);
      if (c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0d || c === 0x2c || c === 0xfeff) this.pos++;
      else if (c === 0x23 /* # */) {
        while (this.pos < s.length && s[this.pos] !== '\n' && s[this.pos] !== '\r') this.pos++;
      } else break;
    }
  }

  readName(): string {
    const start = this.pos;
    this.pos++;
    while (this.pos < this.s.length && NAME_CHAR.test(this.s[this.pos])) this.pos++;
    return this.s.slice(start, this.pos);
  }

  /** At a `"`: skip a string or block string. false = unterminated. */
  skipString(): boolean {
    const s = this.s;
    if (s.startsWith('"""', this.pos)) {
      let i = this.pos + 3;
      for (;;) {
        const end = s.indexOf('"""', i);
        if (end < 0) return false;
        if (s[end - 1] === '\\') {
          i = end + 3; // \""" is an escaped triple quote
          continue;
        }
        this.pos = end + 3;
        return true;
      }
    }
    let i = this.pos + 1;
    while (i < s.length) {
      const c = s[i];
      if (c === '\\') i += 2;
      else if (c === '"') {
        this.pos = i + 1;
        return true;
      } else if (c === '\n' || c === '\r') return false;
      else i++;
    }
    return false;
  }

  /**
   * From after an operation name / fragment keyword to its selection set's `{`: skips variable definitions
   * and arguments in parentheses (default values may contain `{}`), `on Type`, directives. false = no `{`.
   */
  skipToSelectionSet(): boolean {
    const s = this.s;
    let parens = 0;
    while (this.pos < s.length) {
      this.skipIgnored();
      if (this.eof()) return false;
      const c = s[this.pos];
      if (c === '"') {
        if (!this.skipString()) return false;
      } else if (c === '(' || c === '[') {
        parens++;
        this.pos++;
      } else if (c === ')' || c === ']') {
        if (--parens < 0) return false;
        this.pos++;
      } else if (c === '{') {
        if (parens === 0) return true;
        this.pos++;
        parens++; // an object value inside a default: count it with the parentheses
      } else if (c === '}') {
        if (--parens < 0) return false;
        this.pos++;
      } else {
        this.pos++;
      }
    }
    return false;
  }

  /** At a `{`: skip to after its matching `}`. false = unbalanced. */
  skipBalanced(): boolean {
    const s = this.s;
    let depth = 0;
    while (this.pos < s.length) {
      const c = s[this.pos];
      if (c === '"') {
        if (!this.skipString()) return false;
        continue;
      }
      if (c === '#') {
        this.skipIgnored();
        continue;
      }
      this.pos++;
      if (c === '{' || c === '(' || c === '[') depth++;
      else if (c === '}' || c === ')' || c === ']') {
        if (--depth < 0) return false;
        if (depth === 0) return c === '}';
      }
    }
    return false;
  }
}

/** The JSON media types GraphQL-over-HTTP uses (`application/json`, `application/graphql+json`, any `+json`). */
function isJsonType(ct: string): boolean {
  return ct === 'application/json' || ct.endsWith('+json');
}

function mediaType(contentType: string | undefined): string {
  return (contentType ?? '').split(';')[0].trim().toLowerCase();
}

interface OneOperation {
  info: GraphqlInfo;
  name?: string;
}

/** One GraphQL-over-HTTP request object (`{query, operationName, variables, extensions}`). */
function fromRequestObject(o: unknown): OneOperation | undefined {
  if (!o || typeof o !== 'object' || Array.isArray(o)) return undefined;
  const r = o as Record<string, unknown>;
  // Only a valid GraphQL Name ≤ 200 chars (REVIEW-5 #9); anything else counts as no operationName.
  const opName = isValidOperationName(r.operationName) ? r.operationName : undefined;
  const ext = r.extensions;
  const persistedQuery =
    !!ext && typeof ext === 'object' && !!(ext as Record<string, unknown>).persistedQuery && typeof (ext as Record<string, unknown>).persistedQuery === 'object';
  const ops = typeof r.query === 'string' ? scanOperations(r.query) : undefined;
  if (ops) return fromOperations(ops, opName);
  if (persistedQuery) {
    const info: GraphqlInfo = { persisted: true };
    if (opName) info.operationName = opName;
    return { info, name: opName };
  }
  return undefined;
}

/** The operation that runs: the one named `operationName`, else the first. */
function fromOperations(ops: GraphqlOperationRef[], opName: string | undefined): OneOperation {
  const chosen = (opName && ops.find((o) => o.name === opName)) || ops[0];
  const name = opName ?? chosen.name;
  const info: GraphqlInfo = { operationType: chosen.type };
  if (name) info.operationName = name;
  return { info, name };
}

function fromJsonText(text: string): GraphqlDetection | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (Array.isArray(parsed)) {
    let first: OneOperation | undefined;
    let count = 0;
    const names: string[] = [];
    for (const item of parsed.slice(0, MAX_OPERATIONS)) {
      const op = fromRequestObject(item);
      if (!op) continue;
      first ??= op;
      count++;
      if (op.name) names.push(op.name);
    }
    // GraphqlInfo.batch: set for any batched array (even of one), the fields describe the first operation.
    return first ? { info: { ...first.info, batch: count }, count, operationNames: names } : undefined;
  }
  const op = fromRequestObject(parsed);
  return op ? { info: op.info, count: 1, operationNames: op.name ? [op.name] : [] } : undefined;
}

function fromDocument(doc: string, opName?: string): GraphqlDetection | undefined {
  const ops = scanOperations(doc);
  if (!ops) return undefined;
  const op = fromOperations(ops, opName);
  return { info: op.info, count: 1, operationNames: op.name ? [op.name] : [] };
}

/** GET (or any URL) form: `?query=…&operationName=…&extensions={"persistedQuery":…}`. */
function fromUrl(url: string): GraphqlDetection | undefined {
  const q = url.indexOf('?');
  if (q < 0) return undefined;
  let params: URLSearchParams;
  try {
    params = new URLSearchParams(url.slice(q + 1).split('#')[0]);
  } catch {
    return undefined;
  }
  const query = params.get('query');
  const extensions = params.get('extensions');
  const operationName = params.get('operationName') ?? undefined;
  if (query === null && extensions === null) return undefined;
  const obj: Record<string, unknown> = {};
  if (query !== null) obj.query = query;
  if (operationName) obj.operationName = operationName;
  if (extensions !== null && extensions.length <= 64 * 1024) {
    try {
      obj.extensions = JSON.parse(extensions);
    } catch {
      /* not JSON: ignored */
    }
  }
  const op = fromRequestObject(obj);
  return op ? { info: op.info, count: 1, operationNames: op.name ? [op.name] : [] } : undefined;
}

export interface GraphqlRequest {
  method: string;
  url: string;
  /** The request's Content-Type. When given, detection is strict (as for `Exchange.graphql`). */
  contentType?: string;
  /** The decoded request body text. */
  body?: string;
}

/**
 * Detect a GraphQL request (CONTRACTS §11.2).
 * - With `contentType` (strict, used for `Exchange.graphql`): POST/PUT/PATCH `application/json` (or `+json`)
 *   bodies with a `query` document and/or `extensions.persistedQuery`, batched arrays (first operation +
 *   count), `application/graphql` bodies; GET/HEAD `?query=` / `?extensions=` URLs.
 * - Without it (lenient, used for rule matching where only method, URL and body are known): a body that
 *   starts with `{`/`[` is tried as JSON, then as a document; no body → the URL form, for any method.
 * `query` texts that don't scan as an executable document (`?query=shoes`) are not GraphQL.
 */
export function detectGraphql(req: GraphqlRequest): GraphqlDetection | undefined {
  const method = (req.method ?? '').toUpperCase();
  const body = typeof req.body === 'string' ? req.body : undefined;
  const hasBody = body !== undefined && body.trim() !== '';
  if (req.contentType !== undefined) {
    if (method === 'GET' || method === 'HEAD') return fromUrl(req.url);
    if (!hasBody) return undefined;
    const ct = mediaType(req.contentType);
    if (isJsonType(ct)) return fromJsonText(body!);
    if (ct === 'application/graphql') return fromDocument(body!, urlOperationName(req.url));
    return undefined;
  }
  if (!hasBody) return fromUrl(req.url);
  const t = body!.trimStart();
  if (t[0] === '{' || t[0] === '[') {
    const json = fromJsonText(t);
    if (json) return json;
    if (t[0] === '[') return undefined;
    try {
      JSON.parse(t);
      return undefined; // valid JSON, just not a GraphQL request
    } catch {
      /* `{ hello }` is a document, not JSON */
    }
  }
  return fromDocument(t, urlOperationName(req.url));
}

function urlOperationName(url: string): string | undefined {
  const q = url.indexOf('?');
  if (q < 0) return undefined;
  try {
    const n = new URLSearchParams(url.slice(q + 1).split('#')[0]).get('operationName');
    return isValidOperationName(n) ? n : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Names of the operations a request would run, for `Matcher.graphqlOperation` (lenient detection). An empty
 * list means "not GraphQL, or only unnamed operations".
 */
export function graphqlOperationNames(method: string, url: string, body?: string): string[] {
  return detectGraphql({ method, url, body })?.operationNames ?? [];
}
