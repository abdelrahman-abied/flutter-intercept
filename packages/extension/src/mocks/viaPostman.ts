/**
 * Shared by the Insomnia and Bruno readers (CONTRACTS §24.4). Pure: no vscode, no fs, no network.
 *
 * Both formats describe requests the way Postman does (`{{var}}` templates, `:id` path params, saved answers), so a
 * reader turns its file into a list of `SourceRequest`s and this module writes them as a Postman Collection v2.1
 * document for `parsePostman`. One URL / variable / example / request-body / auth policy for every request-based
 * format: the same limits, problem lines and keys as §21.2.
 */
import { addProblem, dict, quoteFileText, setProp, utf8Bytes } from './ref';
import { parsePostman } from './postman';
import { COLLECTION_LIMITS, type CollectionFormat, type CollectionVars, type ParsedCollection } from './types';

/** Options of the Insomnia and Bruno readers (CONTRACTS §24.4). */
export interface SourceOptions {
  /** The link's `variables` (§21.6): win over every value in the files. */
  variables?: Readonly<Record<string, string>>;
  /** The environment to use, by name (Insomnia: a sub-environment; Bruno: `environments/<name>.bru`). */
  environment?: string;
}

/**
 * A parsed Insomnia / Bruno collection plus the names of the environments it offers. `envValues` (host only, never
 * exposed: REVIEW-16 #9) holds the chosen environment's expanded values, so the host can show `{{name}}` wherever one
 * of them ends up in a path or resource name (§21.6), as it does for a Postman environment file.
 */
export type SourceParsed = ParsedCollection & { environments: string[]; envValues?: ReadonlyMap<string, string> };

/** Environment names offered, ≤ 50, each ≤ 100 characters. */
export const MAX_ENVIRONMENTS = 50;

export interface SourceHeader {
  name: string;
  value: string;
}

/** A request body as the source wrote it. Only JSON text and form entries are used (§24.2, as Postman). */
export type SourceBody =
  | { kind: 'raw'; text: string }
  | { kind: 'form'; entries: { key: string; value: string }[] };

export interface SourceExample {
  name: string;
  /** Any value: a number 100–599 is used, anything else answers 200 with a problem line (§21.2). */
  status: unknown;
  headers: SourceHeader[];
  body: string;
  /** `json` / `xml` / `html` / `text`: the content type when the example sets none (§21.2). */
  language?: string;
  /** The URL the example was saved for (its query values choose the example, §21.2). */
  requestUrl?: string;
  requestBody?: SourceBody;
}

export interface SourceRequest {
  name: string;
  /** Upper case. */
  method: string;
  /** A Postman-style template: `{{var}}`, `:param`. */
  url: string;
  /** Query parameters declared next to the URL (Insomnia `parameters`, Bruno `params:query`). */
  query?: { key: string; value: string; disabled?: boolean }[];
  folder: string[];
  examples: SourceExample[];
  body?: SourceBody;
  /** The auth type the request uses after inheritance; never a value. */
  auth?: 'none' | 'declared';
}

interface FolderNode {
  items: Record<string, unknown>[];
  folders: Map<string, FolderNode>;
}

const POSTMAN_SCHEMA = 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json';

function obj(entries: [string, unknown][]): Record<string, unknown> {
  const o = dict();
  for (const [k, v] of entries) setProp(o, k, v);
  return o;
}

function postmanBody(body: SourceBody | undefined): Record<string, unknown> | undefined {
  if (!body) return undefined;
  if (body.kind === 'raw') return obj([['mode', 'raw'], ['raw', body.text]]);
  return obj([
    ['mode', 'urlencoded'],
    ['urlencoded', body.entries.map((e) => obj([['key', e.key], ['value', e.value]]))],
  ]);
}

/**
 * Writes `requests` as a Postman v2.1 document and parses it. Folders keep the order in which they first appear;
 * requests keep their order inside a folder. `problems` (the reader's own) come first in the result.
 */
export function parseSourceRequests(
  format: CollectionFormat,
  name: string,
  requests: SourceRequest[],
  vars: CollectionVars,
  problems: string[],
  /** The reader stopped collecting at the endpoint limit (more requests exist than `requests` holds). */
  truncated = false,
): ParsedCollection {
  const root: FolderNode = { items: [], folders: new Map() };
  let written = 0;
  for (const req of requests) {
    // one past the limit lets parsePostman report it; the rest would only cost time
    if (written > COLLECTION_LIMITS.endpoints) break;
    const label = quoteFileText(req.name);
    if (req.folder.length > COLLECTION_LIMITS.folderDepth) {
      addProblem(problems, `Request "${label}": folder depth over ${COLLECTION_LIMITS.folderDepth} (skipped)`);
      continue;
    }
    const url = req.url.trim();
    if (!url) {
      addProblem(problems, `Request "${label}": URL is empty (skipped)`);
      continue;
    }
    if (url.length > COLLECTION_LIMITS.urlChars) {
      addProblem(problems, `Request "${label}": URL exceeds ${COLLECTION_LIMITS.urlChars} characters (skipped)`);
      continue;
    }

    const examples: Record<string, unknown>[] = [];
    for (const ex of req.examples) {
      if (examples.length >= COLLECTION_LIMITS.examplesPerEndpoint) {
        addProblem(
          problems,
          `Request "${label}": has more than ${COLLECTION_LIMITS.examplesPerEndpoint} examples; only the first ${COLLECTION_LIMITS.examplesPerEndpoint} were kept`,
        );
        break;
      }
      if (utf8Bytes(ex.body) > COLLECTION_LIMITS.exampleBodyBytes) {
        addProblem(problems, `Request "${label}" example "${quoteFileText(ex.name)}": body exceeds 5 MB (skipped)`);
        continue;
      }
      const original: [string, unknown][] = [['method', req.method]];
      if (ex.requestUrl !== undefined && ex.requestUrl.length <= COLLECTION_LIMITS.urlChars) original.push(['url', ex.requestUrl]);
      const exBody = postmanBody(ex.requestBody);
      if (exBody) original.push(['body', exBody]);
      examples.push(
        obj([
          ['name', ex.name],
          ['code', ex.status],
          ['header', ex.headers.map((h) => obj([['key', h.name], ['value', h.value]]))],
          ['body', ex.body],
          ...(ex.language ? ([['_postman_previewlanguage', ex.language]] as [string, unknown][]) : []),
          ['originalRequest', obj(original)],
        ]),
      );
    }

    const request: [string, unknown][] = [
      ['method', req.method],
      ['header', []],
      [
        'url',
        req.query && req.query.length > 0
          ? obj([
              ['raw', url],
              ['query', req.query.map((q) => obj([['key', q.key], ['value', q.value], ...(q.disabled ? ([['disabled', true]] as [string, unknown][]) : [])]))],
            ])
          : url,
      ],
    ];
    const body = postmanBody(req.body);
    if (body) request.push(['body', body]);
    if (req.auth) request.push(['auth', obj([['type', req.auth === 'none' ? 'noauth' : 'bearer']])]);

    let node = root;
    for (const f of req.folder) {
      let next = node.folders.get(f);
      if (!next) {
        next = { items: [], folders: new Map() };
        node.folders.set(f, next);
        node.items.push(obj([['name', f], ['item', next.items]]));
      }
      node = next;
    }
    node.items.push(obj([['name', req.name], ['request', obj(request)], ['response', examples]]));
    written++;
  }

  const doc = obj([
    ['info', obj([['name', name], ['schema', POSTMAN_SCHEMA]])],
    ['item', root.items],
  ]);
  const parsed = parsePostman(doc, vars);
  const all = [...problems, ...parsed.problems];
  const limitLine = `Collection has more than ${COLLECTION_LIMITS.endpoints} endpoints; the rest were skipped.`;
  if (truncated && !all.includes(limitLine)) all.push(limitLine);
  return { ...parsed, format, name, problems: all };
}

// ------------------------------------------------------------------ variables

/**
 * Turns a template written for another tool into the `{{name}}` form `parsePostman` resolves (Insomnia, Bruno).
 * `{{ _.name }}`, `{{ name }}` and `{{ a.b }}` → `{{name}}` / `{{a.b}}`. Anything else between `{{ }}` (filters,
 * expressions) and every Nunjucks `{% … %}` tag becomes a dynamic `{{$tag}}`: never evaluated, unresolved in a host, a
 * parameter in a path (§24.4). Linear time; an unterminated `{{` / `{%` is left as text.
 */
export function normaliseTemplate(input: string, insomnia: boolean): string {
  let out = '';
  let pos = 0;
  // The next `{{` / `{%` at or after `pos`, searched again only once `pos` has passed it (REVIEW-16 #2): searching
  // from `pos` on every loop is quadratic when one of the two markers never occurs again.
  let a = -2;
  let b = insomnia ? -2 : -1;
  while (pos < input.length) {
    if (a !== -1 && a < pos) a = input.indexOf('{{', pos);
    if (b !== -1 && b < pos) b = input.indexOf('{%', pos);
    const open = a < 0 ? b : b < 0 ? a : Math.min(a, b);
    if (open < 0) {
      out += input.slice(pos);
      break;
    }
    const isTag = open === b;
    const close = input.indexOf(isTag ? '%}' : '}}', open + 2);
    if (close < 0) {
      out += input.slice(pos);
      break;
    }
    out += input.slice(pos, open);
    const inner = input.slice(open + 2, close).trim();
    if (isTag) {
      out += `{{$${tagName(inner)}}}`;
    } else {
      const name = insomnia && inner.startsWith('_.') ? inner.slice(2) : inner;
      out += VAR_NAME.test(name) && name.length <= 200 ? `{{${name}}}` : `{{$${tagName(inner)}}}`;
    }
    pos = close + 2;
  }
  return out;
}

const VAR_NAME = /^[A-Za-z_$][\w$-]*(?:\.[A-Za-z_$][\w$-]*)*$/;

function tagName(inner: string): string {
  const word = /^[A-Za-z_][\w]{0,29}/.exec(inner.replace(/^[_.\s]+/, ''));
  return word ? word[0] : 'template';
}

/** True when `value` still holds a template (so it can't be used as a literal URL part). */
export function hasTemplate(value: string): boolean {
  return value.includes('{{') || value.includes('{%');
}

/**
 * Expands `{{name}}` references between variable values (Insomnia and Bruno values may use other variables), at most
 * three rounds. A value that still holds a template afterwards is dropped (its variable stays unresolved).
 */
export function expandValues(values: Map<string, string>, insomnia: boolean): Map<string, string> {
  const cur = new Map<string, string>();
  for (const [k, v] of values) cur.set(k, normaliseTemplate(v, insomnia));
  for (let round = 0; round < 3; round++) {
    let changed = false;
    for (const [k, v] of cur) {
      if (!v.includes('{{')) continue;
      const next = v.replace(/\{\{([^{}]{1,200})\}\}/g, (m, name: string) => {
        if (name === k || name.startsWith('$')) return m;
        const val = cur.get(name);
        return val !== undefined && !val.includes('{{') ? val : m;
      });
      if (next !== v && next.length <= COLLECTION_LIMITS.urlChars) {
        cur.set(k, next);
        changed = true;
      }
    }
    if (!changed) break;
  }
  const out = new Map<string, string>();
  for (const [k, v] of cur) if (v !== '' && !hasTemplate(v)) out.set(k, v);
  return out;
}
