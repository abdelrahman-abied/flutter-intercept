/**
 * Agent tools: mock from a collection (CONTRACTS §21.10). Reads go through the agent's redaction; writes are the
 * service's own (workspace-relative files inside the workspace only, no copying, no dialogs, no removal).
 */
import { isOpaqueToken, isSensitiveField, REDACTED, redactBodyText, redactHeaders, redactUrl } from '../redact';
import { exampleDiff } from '../../mocks/core';
import type { ToolInput } from '../schema';
import { AgentToolError, ToolResult } from '../types';
import type { AgentViews } from '../views';
import type { ToolHandlers } from './types';
import type { CollectionPatch, CollectionStatus, DriftView } from '../../ui/protocol';

/** CONTRACTS §23.5: drift findings per collection in agent outputs. */
export const MAX_AGENT_DRIFT = 20;

/** A service error as a tool error: "no such collection / request / example" → not_found, the rest → invalid. */
function toolError(e: unknown): AgentToolError {
  if (e instanceof AgentToolError) return e;
  const message = e instanceof Error ? e.message : String(e);
  return new AgentToolError(message, /^No collection|has no (request|example)/.test(message) ? 'not_found' : 'invalid');
}

function statusOf(ag: AgentViews, id: string): Record<string, unknown> | undefined {
  const s = ag.collectionsOrThrow().state().find((x) => x.id === id);
  return s ? collectionView(ag, s) : undefined;
}

/** §23.5: findings as agents see them — ≤ 20, request keys redacted like any URL, paths and kinds only. */
function driftView(ag: AgentViews, views: readonly DriftView[]): DriftView[] {
  return views.slice(0, MAX_AGENT_DRIFT).map((v) => ({ ...v, endpoint: ag.endpointKeyView(v.endpoint), changes: v.changes.map((c) => ({ ...c })) }));
}

function driftOf(ag: AgentViews, id: string): DriftView[] {
  const svc = ag.collectionsOrThrow();
  try {
    return svc.drift ? driftView(ag, svc.drift(id)) : [];
  } catch {
    return [];
  }
}

/** A collection's status for agents: `drift` is the list of findings (§23.5), not the panel's one-line summary. */
function collectionView(ag: AgentViews, s: CollectionStatus): Record<string, unknown> {
  const { drift: summary, ...rest } = s;
  const drift = summary ? driftOf(ag, s.id) : [];
  return { ...rest, ...(drift.length ? { drift } : {}) };
}

export function listCollections(ag: AgentViews): ToolResult {
  const collections = ag.collectionsOrThrow().state().map((s) => collectionView(ag, s));
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
    ...(e.drift ? { drift: driftView(ag, e.drift) } : {}),
  }));
  const status = ag.collectionsOrThrow().state().find((s) => s.id === i.id);
  const drift = status?.drift ? driftOf(ag, i.id) : [];
  return {
    id: i.id,
    endpoints,
    total: matching.length,
    ...(matching.length > endpoints.length ? { more: matching.length - endpoints.length } : {}),
    ...(status?.seen ? { seen: status.seen } : {}),
    ...(drift.length ? { drift } : {}),
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

/**
 * CONTRACTS §23.5: a collection from real traffic (no dialogs: the agent passes the choices). Sanitising is always on,
 * whatever `agent.redactSecrets` says, and so is personal-data replacement (REVIEW-16 #15d: an agent's
 * `replacePersonalData: false` is ignored); `dryRun` writes nothing (and is allowed with read-only access, api.ts).
 */
export async function mockFromTraffic(ag: AgentViews, i: ToolInput<'mock_from_traffic'>): Promise<ToolResult> {
  const svc = ag.collectionsOrThrow();
  if (!svc.mockFromTraffic) throw new AgentToolError('making a collection from traffic is not available here', 'state');
  if (i.recording !== undefined && (i.url !== undefined || i.sinceMs !== undefined)) throw new AgentToolError('url and sinceMs filter this session; leave them out with recording', 'invalid');
  if (i.recording !== undefined && !ag.deps.recordings) throw new AgentToolError('recordings are not available here', 'state');
  const source =
    i.recording !== undefined
      ? { recording: i.recording }
      : { session: { ...(i.sinceMs !== undefined ? { sinceMs: i.sinceMs } : {}), ...(i.url !== undefined ? { url: i.url } : {}) } };
  let r;
  try {
    r = await svc.mockFromTraffic({
      source,
      ...(i.name !== undefined ? { name: i.name } : {}),
      ...(i.origins !== undefined ? { origins: i.origins } : {}),
      unmatched: i.unmatched,
      // REVIEW-16 #15d: the file is linked for the team, so agents can't turn personal-data replacement off
      // (`replacePersonalData: false` from an agent is ignored; only the IDE's own dialog offers it)
      replacePersonalData: true,
      ...(i.dryRun ? { dryRun: true } : {}),
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    throw new AgentToolError(ag.scrub(message), /^No recording|not found|ENOENT/i.test(message) ? 'not_found' : /^No answer from a real server/.test(message) ? 'state' : 'invalid');
  }
  return {
    id: r.id,
    file: r.file,
    endpoints: r.endpoints,
    examples: r.examples,
    resources: r.resources,
    skipped: r.skipped,
    removed: r.removed,
    ...(r.limited ? { limited: r.limited } : {}),
    ...(r.dryRun ? { dryRun: true } : {}),
    note: r.dryRun
      ? 'nothing was written; call again without dryRun to make it'
      : `mocking from it now (hot_restart so the app sends its requests again); credentials were removed, but example bodies are real data — tell the user to review ${r.file} before committing it`,
  };
}

/** CONTRACTS §23.5: the diff of an example update, never a write (the user applies it from the panel). */
export async function updateCollectionExample(ag: AgentViews, i: ToolInput<'update_collection_example'>): Promise<ToolResult> {
  const svc = ag.collectionsOrThrow();
  if (!svc.previewExampleUpdate) throw new AgentToolError('updating a collection example is not available here', 'state');
  const endpoint = resolveEndpoint(ag, i.id, i, 'update_collection_example');
  let u;
  try {
    u = await svc.previewExampleUpdate(i.id, endpoint, i.status, i.mode);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    throw new AgentToolError(ag.scrub(message), /^No collection|has no request/.test(message) ? 'not_found' : /^No answer of the server|^Nothing to update/.test(message) ? 'state' : 'invalid');
  }
  const json = { 'content-type': 'application/json' };
  const view = (body: string) => (ag.redact ? redactBodyText(body, json) : body);
  return {
    id: i.id,
    endpoint: ag.endpointKeyView(endpoint),
    status: i.status,
    mode: u.mode,
    file: u.file,
    diff: exampleDiff(u, view, ag.endpointKeyView(endpoint)),
    note: u.edit
      ? 'nothing was written: the collection file is the team\'s — tell the user to apply it in the Flutter Intercept panel (Update example), or ignore the difference there'
      : `nothing was written; this file is not edited by Flutter Intercept (${u.copyOnly ?? 'its format'}): the user can copy the updated example from the panel`,
  };
}

export const collectionsTools: ToolHandlers = {
  list_collections: (ag, _i) => listCollections(ag),
  get_collection: (ag, i) => getCollection(ag, i),
  get_collection_example: (ag, i) => getCollectionExample(ag, i),
  import_collection: (ag, i) => importCollection(ag, i),
  set_collection: (ag, i) => setCollection(ag, i),
  mock_from_traffic: (ag, i) => mockFromTraffic(ag, i),
  update_collection_example: (ag, i) => updateCollectionExample(ag, i),
};
