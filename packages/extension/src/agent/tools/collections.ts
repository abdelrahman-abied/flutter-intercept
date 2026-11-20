/**
 * Agent tools: mock from a collection (CONTRACTS §21.10). Reads go through the agent's redaction; writes are the
 * service's own (workspace-relative files inside the workspace only, no copying, no dialogs, no removal).
 */
import { isOpaqueToken, isSensitiveField, REDACTED, redactHeaders, redactUrl } from '../redact';
import type { ToolInput } from '../schema';
import { AgentToolError, ToolResult } from '../types';
import type { AgentViews } from '../views';
import type { ToolHandlers } from './types';
import type { CollectionPatch } from '../../ui/protocol';

/** A service error as a tool error: "no such collection / request / example" → not_found, the rest → invalid. */
function toolError(e: unknown): AgentToolError {
  if (e instanceof AgentToolError) return e;
  const message = e instanceof Error ? e.message : String(e);
  return new AgentToolError(message, /^No collection|has no (request|example)/.test(message) ? 'not_found' : 'invalid');
}

function statusOf(ag: AgentViews, id: string): Record<string, unknown> | undefined {
  return ag.collectionsOrThrow().state().find((s) => s.id === id) as unknown as Record<string, unknown> | undefined;
}

export function listCollections(ag: AgentViews): ToolResult {
  const collections = ag.collectionsOrThrow().state();
  return {
    collections,
    ...(collections.length ? {} : { note: 'no collection is linked; import_collection links a Postman collection or an OpenAPI document from the workspace' }),
  };
}

/** REVIEW-15 #5: an example's query values as agents see them (credential-like names or values redacted). */
function queryView(ag: AgentViews, q: Record<string, string> | undefined): Record<string, string> | undefined {
  if (!q || !ag.redact) return q;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(q)) {
    Object.defineProperty(out, k, { value: isSensitiveField(k) || isOpaqueToken(v) ? REDACTED : v, enumerable: true, writable: true, configurable: true });
  }
  return out;
}

/**
 * CONTRACTS §21.15 #3: the endpoint key a tool call means — `request` (an exchange id from the traffic), or `endpoint`
 * as get_collection listed it (exact, or the redacted form agents were shown when it held a credential).
 */
function resolveEndpoint(ag: AgentViews, id: string, ref: { endpoint?: string; request?: string }, field: string): string {
  if ((ref.endpoint === undefined) === (ref.request === undefined)) throw new AgentToolError(`${field}: give exactly one of endpoint or request`, 'invalid');
  const svc = ag.collectionsOrThrow();
  if (ref.request !== undefined) {
    const ex = ag.find(ref.request);
    if (!svc.endpointForRequest) throw new AgentToolError('finding a collection request from traffic is not available here', 'state');
    try {
      return svc.endpointForRequest(id, ex);
    } catch (e) {
      throw toolError(e);
    }
  }
  const key = ref.endpoint!;
  let all;
  try {
    all = svc.endpoints(id);
  } catch (e) {
    throw toolError(e);
  }
  if (all.some((e) => e.key === key)) return key;
  const shown = all.filter((e) => ag.endpointKeyView(e.key) === key);
  if (shown.length === 1) return shown[0].key;
  return key; // the service answers "has no request …"
}

export function getCollection(ag: AgentViews, i: ToolInput<'get_collection'>): ToolResult {
  let all;
  try {
    all = ag.collectionsOrThrow().endpoints(i.id);
  } catch (e) {
    throw toolError(e);
  }
  const f = i.filter?.toLowerCase();
  const matching = f ? all.filter((e) => `${e.method} ${e.url} ${e.name} ${e.folder.join('/')}`.toLowerCase().includes(f)) : all;
  // REVIEW-15 #5: keys, URLs and example query values through the agent redaction
  const endpoints = matching.slice(0, i.limit).map((e) => ({
    ...e,
    key: ag.endpointKeyView(e.key),
    url: ag.redact ? redactUrl(e.url) : e.url,
    examples: e.examples.map((x) => (x.query ? { ...x, query: queryView(ag, x.query) } : x)),
  }));
  const status = ag.collectionsOrThrow().state().find((s) => s.id === i.id);
  return {
    id: i.id,
    endpoints,
    total: matching.length,
    ...(matching.length > endpoints.length ? { more: matching.length - endpoints.length } : {}),
    ...(status?.seen ? { seen: status.seen } : {}),
  };
}

export function getCollectionExample(ag: AgentViews, i: ToolInput<'get_collection_example'>): ToolResult {
  const endpoint = resolveEndpoint(ag, i.id, i, 'get_collection_example');
  let x;
  try {
    x = ag.collectionsOrThrow().example(i.id, endpoint, i.example);
  } catch (e) {
    throw toolError(e);
  }
  const headers = ag.redact ? (redactHeaders(x.headers) as Record<string, string>) : x.headers;
  const body = ag.bodyView({ text: x.body, encoding: 'utf8', ...(x.truncated ? { truncated: true } : {}) }, x.headers, i.maxBodyChars);
  return { id: i.id, endpoint: ag.endpointKeyView(endpoint), example: i.example, status: x.status, headers, ...(body ? { body } : {}) };
}

export async function importCollection(ag: AgentViews, i: ToolInput<'import_collection'>): Promise<ToolResult> {
  let id: string;
  try {
    ({ id } = await ag.collectionsOrThrow().importFile({ file: i.file, ...(i.environment !== undefined ? { environment: i.environment } : {}) }));
  } catch (e) {
    throw toolError(e);
  }
  const s = statusOf(ag, id);
  const unresolved = (s?.unresolved as string[] | undefined) ?? [];
  return {
    ...(s ?? { id }),
    ...(unresolved.length ? { note: `requests using ${unresolved.map((v) => `{{${v}}}`).join(', ')} are not mocked until their server is known: set_collection {id: "${id}", variable: {name, value: "https://…"}}` } : {}),
  };
}

export async function setCollection(ag: AgentViews, i: ToolInput<'set_collection'>): Promise<ToolResult> {
  let patch: CollectionPatch;
  if (i.reset) {
    if (i.enabled !== undefined || i.unmatched !== undefined || i.variable !== undefined || i.example !== undefined || i.off !== undefined) {
      throw new AgentToolError("reset can't be combined with other changes", 'invalid');
    }
    if (i.scope === 'team') throw new AgentToolError('reset undoes your own changes: leave scope out (or "me")', 'invalid');
    const one = i.endpoint !== undefined || i.request !== undefined ? resolveEndpoint(ag, i.id, i, 'reset') : undefined;
    patch = { reset: true, ...(one !== undefined ? { endpoint: one } : {}) };
  } else {
    if (i.endpoint !== undefined || i.request !== undefined) throw new AgentToolError('endpoint / request at the top level are only used with reset; put them inside example or off', 'invalid');
    patch = {
      ...(i.enabled !== undefined ? { enabled: i.enabled } : {}),
      ...(i.unmatched !== undefined ? { unmatched: i.unmatched } : {}),
      ...(i.variable !== undefined ? { variable: i.variable } : {}),
      ...(i.example !== undefined ? { example: { endpoint: resolveEndpoint(ag, i.id, i.example, 'example'), name: i.example.name } } : {}),
      ...(i.off !== undefined ? { off: { endpoint: resolveEndpoint(ag, i.id, i.off, 'off'), off: i.off.off } } : {}),
    };
    if (!Object.keys(patch).length) throw new AgentToolError('pass at least one of enabled, unmatched, variable, example, off, or reset', 'invalid');
    if (i.scope === 'team') patch.scope = 'team';
  }
  try {
    await ag.collectionsOrThrow().update(i.id, patch);
  } catch (e) {
    throw toolError(e);
  }
  const forMe = !i.reset && i.scope !== 'team' && (i.example !== undefined || i.off !== undefined || i.unmatched !== undefined);
  return {
    ...(statusOf(ag, i.id) ?? { id: i.id }),
    note: `requests the app sends from now on get the new answers (a running app may need hot_restart to send them again)${forMe ? '; changed for you only — set_collection {reset: true} undoes it' : ''}`,
  };
}

export const collectionsTools: ToolHandlers = {
  list_collections: (ag, _i) => listCollections(ag),
  get_collection: (ag, i) => getCollection(ag, i),
  get_collection_example: (ag, i) => getCollectionExample(ag, i),
  import_collection: (ag, i) => importCollection(ag, i),
  set_collection: (ag, i) => setCollection(ag, i),
};
