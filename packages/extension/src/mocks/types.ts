/**
 * Mock from a collection (CONTRACTS §21). Shared types, lead-owned. Pure: imported by the extension, the sidecar
 * and the CLI from source. The parsers (M1, M2), `toRules` (M3) and the host service (H) implement these.
 */
import type { Rule } from '@flutter-intercept/proxy';

export type CollectionFormat = 'postman' | 'openapi';

/** One saved (or generated) answer of an endpoint (§21.1). */
export interface MockExample {
  /** Postman: the example's name; OpenAPI: "200", "200 · <example name>", "default". */
  name: string;
  /** 100–599. */
  status: number;
  headers: Record<string, string>;
  /** Text; '' when none. */
  body: string;
  /** OpenAPI only: built from the schema (§21.4), no example was written in the document. */
  generated?: true;
  /** Postman only: literal query values of the example's `originalRequest` that differ from the request's own (§21.2). */
  query?: Record<string, string>;
}

/** A path segment: a literal, or a parameter (`:id`, `{id}`, an unresolved `{{id}}`, a dynamic `{{$guid}}`). */
export type PathSegment = string | { param: string };

export interface MockEndpoint {
  /** Stable inside one collection: `<METHOD> <url template as written>`, e.g. `GET {{baseUrl}}/users/:id`; repeated
   *  keys get ` #2`, ` #3` in file order. */
  key: string;
  /** Upper case. */
  method: string;
  /** The request's name / operationId / summary. */
  name: string;
  /** Postman folders; OpenAPI: the first tag (empty when none). */
  folder: string[];
  /** `scheme://host[:port]`, lower-cased host, default port dropped; absent while a variable is unset. */
  origin?: string;
  /** Segments after the origin, without empty ones: `/users/:id/` → `['users', {param: 'id'}]`. */
  path: PathSegment[];
  /** File order. */
  examples: MockExample[];
  /** Variables the origin still needs (e.g. `baseUrl`). Non-empty → not mocked. */
  unresolved: string[];
}

export type VariableSource = 'link' | 'environment' | 'collection' | 'server';

export interface ParsedCollection {
  format: CollectionFormat;
  name: string;
  endpoints: MockEndpoint[];
  /** Every variable used in a URL and where its value came from (absent = no value). Never the values. */
  variables: { name: string; from?: VariableSource }[];
  /** Readable, one line each. */
  problems: string[];
}

/**
 * Variables already merged by the caller: link `variables` → environment file → the collection's own variables
 * (the first non-empty value wins). The parsers record which source each name came from through `sources`.
 */
export interface CollectionVars {
  values: ReadonlyMap<string, string>;
  sources: ReadonlyMap<string, VariableSource>;
}

// ------------------------------------------------------------------ functions (signatures; implemented by the owners)

/** §21.1: `postman` / `openapi`, or undefined with a readable problem (Swagger 2.0, Postman v1, anything else). */
export type DetectFormat = (doc: unknown) => { format?: CollectionFormat; problem?: string };
/** §21.2 (M1). Never throws. */
export type ParsePostman = (doc: unknown, vars: CollectionVars) => ParsedCollection;
/** §21.2 (M1): `values[]` with `enabled !== false`; empty values kept out. */
export type ParsePostmanEnvironment = (doc: unknown) => { values: Map<string, string>; problems: string[] };
/** §21.2 (M1): the collection's own `variable[]`, for the caller's merge. */
export type PostmanCollectionVariables = (doc: unknown) => Map<string, string>;
/** §21.3 (M2). Never throws. */
export type ParseOpenApi = (doc: unknown, vars: CollectionVars) => ParsedCollection;
/** §21.4 (M2): deterministic example text from a schema; `root` is the whole document (for local `$ref`s). */
export type GenerateFromSchema = (schema: unknown, root: unknown) => { text: string; problems: string[] };
/** §21.6 (M1): the copy written by "Copy without credentials". `removed` = what was removed (names, never values). */
export type SanitisePostman = (doc: unknown) => { doc: unknown; removed: string[] };

export interface ToRulesOptions {
  /** The link id (`[a-z0-9-]{1,40}`). */
  id: string;
  /** Collection name used in rule names. */
  name: string;
  /** Endpoint key → example name. */
  selected: Readonly<Record<string, string>>;
  /** Endpoint keys that are not mocked. */
  off: readonly string[];
  unmatched: 'passthrough' | 'fail';
}

export interface ToRulesStats {
  endpoints: number;
  mocked: number;
  noExample: number;
  unresolved: number;
  off: number;
  generated: number;
  /** Endpoints not mocked because their exact pattern would pass the proxy's 256-character limit (§21.5, REVIEW-15 #3). */
  tooLong: number;
}

/** §21.15 #2: what a collection rule answers — its endpoint key and example (or the 501 / the unmatched failure). */
export interface CollectionRuleMeta {
  endpoint?: string;
  example?: string;
  noExample?: true;
  /** The `unmatched: 'fail'` rule of an origin. */
  unmatched?: true;
}

/** §21.5 (M3). Never throws; problems for endpoints it couldn't turn into a precise rule. `meta` by rule id. */
export type ToRules = (
  parsed: ParsedCollection,
  opts: ToRulesOptions,
) => { rules: Rule[]; stats: ToRulesStats; problems: string[]; meta: Map<string, CollectionRuleMeta> };

// ------------------------------------------------------------------ the link in the shared file (§21.6)

export interface CollectionLink {
  id: string;
  /** Workspace-relative, `/`-separated. */
  file: string;
  environment?: string;
  /** URL variables only. */
  variables: Record<string, string>;
  /** Default for everyone (a personal override may turn it off). */
  enabled: boolean;
  unmatched: 'passthrough' | 'fail';
  selected: Record<string, string>;
  off: string[];
}

// ------------------------------------------------------------------ limits (§21.1, §21.4, §21.5, §21.6)

export const COLLECTION_LIMITS = {
  fileBytes: 20 * 1024 * 1024,
  endpoints: 2000,
  examplesPerEndpoint: 20,
  exampleBodyBytes: 5 * 1024 * 1024,
  folderDepth: 32,
  urlChars: 8 * 1024,
  /** Values visited while walking one OpenAPI document (`$ref`s and YAML aliases make it a graph). */
  walkNodes: 200_000,
  generateDepth: 12,
  generateBytes: 256 * 1024,
  linksPerFile: 20,
  /** A path parameter value longer than this isn't matched (the regex is bounded, §21.5). */
  paramChars: 100,
  /** Query parameters an example can be chosen by (§21.5). */
  exampleQueryParams: 2,
  /** The panel's example view (§21.8). */
  panelBodyBytes: 256 * 1024,
} as const;

export const LINK_ID = /^[a-z0-9-]{1,40}$/;
export const COLLECTION_RULE_PREFIX = 'collection:';
export const NO_EXAMPLE_HEADER = 'x-flutter-intercept';
export const NO_EXAMPLE_HEADER_VALUE = 'no-example';
