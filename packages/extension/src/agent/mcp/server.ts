/**
 * Local MCP server (CONTRACTS §8): Streamable HTTP on http://127.0.0.1:<port>/mcp, Bearer-token auth.
 * Pure Node (no `vscode` import) so it is unit-tested with the real SDK client.
 *
 * Security, in request order (nothing is parsed before all of it passes):
 * 1. bound to 127.0.0.1 only, verified after listen (fail closed);
 * 2. any `Origin` header → 403 (browsers send it; MCP clients don't) — with 3, this stops DNS
 *    rebinding and cross-site requests from a web page;
 * 3. `Host` must be exactly `127.0.0.1:<port>` or `localhost:<port>` → else 403;
 * 4. `Authorization: Bearer <token>`, compared in constant time → else 401;
 * 5. body ≤ 1 MiB (the SDK transport answers 413), ≤ 64 connections, ≤ 16 MCP sessions (oldest idle
 *    evicted), idle sessions closed after 1 h. The token is never logged.
 *
 * CONTRACTS §10.6: besides the tools, read-only resources (the same redacted views as the tools, read through
 * `AgentTools.call`, so access level and redaction apply) and short tool-oriented prompts. No change
 * notifications: the traffic changes constantly and `resources/subscribe` is being replaced (MCP 2026-07-28);
 * clients re-read. No Sampling, Roots or Logging.
 */
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'crypto';
import * as http from 'http';
import type { AddressInfo } from 'net';
import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { ErrorCode, McpError, type CallToolResult, type GetPromptResult, type ReadResourceResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { AgentToolError, CONFIRMED_READ_TOOLS, READ_TOOLS, toolImages, WRITE_TOOLS, type AgentTools, type ToolName } from '../types';

export const MCP_PATH = '/mcp';
export const DEFAULT_MCP_PORT = 47823;
const PORT_TRIES = 100;
const MAX_BODY_BYTES = 1024 * 1024;
const MAX_CONNECTIONS = 64;
const MAX_SESSIONS = 16;
const SESSION_IDLE_MS = 60 * 60 * 1000;

/**
 * Write tools that destroy state or work in progress (clients ask before running them). resend_request
 * replays a request, with the app's credentials, against the real backend (a POST may create data);
 * simulate_network can cut off all of the app's traffic ("offline") (REVIEW-3 #7).
 */
// REVIEW-6 #12: replay_recording (fallback "fail" fails all unmatched traffic) and add_map_remote (sends the app's
// requests, credentials included, to another server).
export const DESTRUCTIVE_TOOLS: ReadonlySet<ToolName> = new Set<ToolName>(['remove_rule', 'abort_request', 'clear_requests', 'stop_app', 'resend_request', 'simulate_network', 'replay_recording', 'add_map_remote']);

/**
 * CONTRACTS §9.5: write tools whose repeated call with the same input has no further effect. Not
 * simulate_network: with a url every call inserts another rule (REVIEW-3 #7).
 */
export const IDEMPOTENT_WRITE_TOOLS: ReadonlySet<ToolName> = new Set<ToolName>(['remove_rule', 'abort_request', 'clear_requests', 'stop_app', 'replay_recording']);

/** CONTRACTS §9.5: tools that reach beyond the local proxy (the real backend). */
export const OPEN_WORLD_TOOLS: ReadonlySet<ToolName> = new Set<ToolName>(['resend_request', 'add_map_remote']);

/** A zod schema (v3 or v4) — the SDK converts it to JSON Schema and validates input with it. */
export type ToolSchema = object;

export interface McpServerOptions {
  /** Preferred port; the next free one (up to +100) is used when it's taken. 0 = any free port. */
  port: number;
  token: string;
  tools: AgentTools;
  /** Input schema per tool (src/agent/schema.ts). */
  schemas: Partial<Record<ToolName, ToolSchema>>;
  /** Model-facing description per tool (reuses the LM tools' modelDescription). */
  descriptions?: Partial<Record<ToolName, string>>;
  log?: (message: string) => void;
  /** Server version reported to clients. */
  version?: string;
}

export interface RunningMcpServer {
  readonly port: number;
  readonly url: string;
  /** Live MCP sessions (≈ connected agent clients). */
  readonly sessions: number;
  /**
   * Issue (or, with `undefined`, revoke) the single URL-path credential: requests to
   * `/mcp/k/<pathToken>` are authorised like a Bearer token. Only for clients whose registration API
   * can't carry headers (Cursor's `vscode.cursor.mcp.registerServer` drops them in 3.23); a fresh
   * one replaces the previous. Returns the full URL to hand to that client.
   */
  issuePathToken(pathToken: string | undefined): string | undefined;
  close(): Promise<void>;
}

/** Test seams. Never set outside tests. */
export const mcpTesting: { bindHostOverride?: string } = {};

export function generateToken(): string {
  return randomBytes(32).toString('base64url');
}

const digest = (s: string) => createHash('sha256').update(s, 'utf8').digest();

/** Constant-time equality of two secrets (digests, so length doesn't leak either). */
export function tokenEquals(a: string, b: string): boolean {
  return timingSafeEqual(digest(a), digest(b)) && b.length > 0;
}

/** Constant-time `Authorization: Bearer <token>` check (digests, so length doesn't leak either). */
export function bearerOk(header: string | string[] | undefined, token: string): boolean {
  if (typeof header !== 'string') return false;
  const m = /^\s*Bearer\s+(\S+)\s*$/i.exec(header);
  return timingSafeEqual(digest(m ? m[1] : ''), digest(token)) && m !== null && token.length > 0;
}

export function toolAnnotations(tool: ToolName) {
  const write = (WRITE_TOOLS as readonly string[]).includes(tool);
  // CONTRACTS §13.8: take_screenshot reads, but is not marked read-only so clients ask before every call.
  const confirmed = (CONFIRMED_READ_TOOLS as readonly string[]).includes(tool);
  return {
    title: tool.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase()),
    readOnlyHint: !write && !confirmed,
    // The MCP default for destructiveHint is TRUE when readOnlyHint is false: say it explicitly.
    destructiveHint: write ? DESTRUCTIVE_TOOLS.has(tool) : false,
    idempotentHint: (!write && !confirmed) || IDEMPOTENT_WRITE_TOOLS.has(tool),
    openWorldHint: OPEN_WORLD_TOOLS.has(tool),
  };
}

function errorText(e: unknown): string {
  if (e instanceof AgentToolError) return e.message;
  if (e instanceof Error && e.name === 'AbortError') return 'Cancelled.';
  return `Internal error: ${e instanceof Error ? e.message : String(e)}`;
}

interface Lifecycle {
  /** Aborted when the server shuts down: in-flight calls end with a tool error that still reaches the client. */
  shutdown: AbortSignal;
  inflight: Set<Promise<unknown>>;
}

/** One McpServer per session, with every Agent API tool registered. */
function buildServer(o: McpServerOptions, life: Lifecycle): McpServer {
  const server = new McpServer({ name: 'flutter-intercept', version: o.version ?? '0.0.0' });
  const register = server.registerTool.bind(server) as (name: string, config: Record<string, unknown>, cb: (...a: any[]) => Promise<CallToolResult>) => unknown;
  for (const tool of [...READ_TOOLS, ...WRITE_TOOLS] as ToolName[]) {
    const schema = o.schemas[tool];
    register(
      tool,
      {
        title: toolAnnotations(tool).title,
        description: o.descriptions?.[tool] ?? `Flutter Intercept: ${tool.replace(/_/g, ' ')}.`,
        ...(schema ? { inputSchema: schema } : {}),
        annotations: toolAnnotations(tool),
      },
      async (...args: any[]): Promise<CallToolResult> => {
        // With an input schema the SDK calls (args, extra); without one, (extra).
        const input = schema ? (args[0] as Record<string, unknown>) ?? {} : {};
        const extra = (schema ? args[1] : args[0]) as { signal?: AbortSignal } | undefined;
        const signal = extra?.signal ? AbortSignal.any([extra.signal, life.shutdown]) : life.shutdown;
        const run = (async (): Promise<CallToolResult> => {
          try {
            const result = await o.tools.call(tool, input, signal);
            // CONTRACTS §13.8: images (take_screenshot) go first as image content; the JSON stays the text part.
            const images = toolImages(result).map((img) => ({ type: 'image' as const, data: img.data, mimeType: img.mimeType }));
            return { content: [...images, { type: 'text', text: JSON.stringify(result, null, 2) }], structuredContent: result };
          } catch (e) {
            const text = life.shutdown.aborted ? 'Flutter Intercept stopped (VS Code closed or agent access turned off).' : errorText(e);
            return { content: [{ type: 'text', text }], isError: true };
          }
        })();
        life.inflight.add(run);
        try {
          return await run;
        } finally {
          life.inflight.delete(run);
        }
      },
    );
  }
  registerResources(server, o.tools);
  registerPrompts(server);
  return server;
}

// ------------------------------------------------------------------ resources (CONTRACTS §10.6)

export const RESOURCE_URIS = {
  exchange: 'intercept://exchange/{id}',
  paused: 'intercept://paused',
  rules: 'intercept://rules',
  contract: 'intercept://contract/{id}',
} as const;

const JSON_MIME = 'application/json';

/** Runs a read tool for a resource; tool errors become MCP errors (never a crash, never a token). */
async function readVia(tools: AgentTools, uri: URL, tool: ToolName, input: Record<string, unknown>): Promise<ReadResourceResult> {
  try {
    const result = await tools.call(tool, input);
    return { contents: [{ uri: uri.href, mimeType: JSON_MIME, text: JSON.stringify(result, null, 2) }] };
  } catch (e) {
    const code = e instanceof AgentToolError && (e.code === 'not_found' || e.code === 'invalid') ? ErrorCode.InvalidParams : ErrorCode.InternalError;
    throw new McpError(code, errorText(e));
  }
}

function idVar(v: string | string[] | undefined): string {
  const raw = Array.isArray(v) ? v[0] : v;
  let id = '';
  try {
    id = decodeURIComponent(raw ?? '');
  } catch {
    id = '';
  }
  if (!id || id.length > 200) throw new McpError(ErrorCode.InvalidParams, 'the resource URI needs an exchange id');
  return id;
}

function registerResources(server: McpServer, tools: AgentTools): void {
  server.registerResource(
    'exchange',
    new ResourceTemplate(RESOURCE_URIS.exchange, {
      // The newest recorded exchanges (same redacted summary as list_requests).
      list: async () => {
        try {
          const r = (await tools.call('list_requests', { limit: 50 })) as { items?: { id: string; method?: string; url?: string; status?: number; state?: string }[] };
          return {
            resources: (r.items ?? []).map((i) => ({
              uri: `intercept://exchange/${encodeURIComponent(i.id)}`,
              name: `${i.method ?? ''} ${i.url ?? i.id}`.trim().slice(0, 300),
              description: `${i.status ?? i.state ?? ''}`,
              mimeType: JSON_MIME,
            })),
          };
        } catch {
          return { resources: [] };
        }
      },
    }),
    {
      title: 'Recorded HTTP exchange',
      description: 'One recorded HTTP request/response of the running app, as get_request returns it (headers, bodies, timings; secrets redacted).',
      mimeType: JSON_MIME,
    },
    (uri, vars) => readVia(tools, uri, 'get_request', { id: idVar(vars.id) }),
  );
  server.registerResource(
    'paused',
    RESOURCE_URIS.paused,
    { title: 'Paused requests', description: 'Requests currently paused at a breakpoint (as list_paused returns them).', mimeType: JSON_MIME },
    (uri) => readVia(tools, uri, 'list_paused', {}),
  );
  server.registerResource(
    'rules',
    RESOURCE_URIS.rules,
    { title: 'Intercept rules', description: 'Active mock / block / breakpoint / throttle / fault / mutate / cors rules in priority order (as list_rules returns them).', mimeType: JSON_MIME },
    (uri) => readVia(tools, uri, 'list_rules', {}),
  );
  server.registerResource(
    'contract',
    new ResourceTemplate(RESOURCE_URIS.contract, { list: undefined }),
    {
      title: 'Contract check of an exchange',
      description: "The check of one recorded JSON response against the app's Dart models (as check_contract {id} returns it).",
      mimeType: JSON_MIME,
    },
    (uri, vars) => readVia(tools, uri, 'check_contract', { id: idVar(vars.id) }),
  );
}

// ------------------------------------------------------------------ prompts (CONTRACTS §10.6)

const promptText = (text: string): GetPromptResult => ({ messages: [{ role: 'user', content: { type: 'text', text } }] });
const oneLine = (v: string | undefined, max: number) => (v ?? '').replace(/[\r\n]+/g, ' ').trim().slice(0, max);

export const PROMPT_NAMES = ['debug-failing-request', 'test-error-states', 'verify-change', 'build-api-layer-from-traffic'] as const;

function registerPrompts(server: McpServer): void {
  server.registerPrompt(
    'debug-failing-request',
    {
      title: 'Debug a failing request',
      description: 'Find why an HTTP request of the running Flutter app fails, fix it and verify the fix.',
      argsSchema: { id: z.string().max(200).optional().describe('Recorded exchange id (default: the newest failure).') },
    },
    ({ id }) => {
      const ex = oneLine(id, 200);
      return promptText(
        [
          'Debug a failing HTTP request of the running Flutter app with the flutter-intercept tools.',
          ex
            ? `1. Start from exchange "${ex}": get_request {"id": "${ex}"}.`
            : '1. Find it: list_requests with status "error", then "5xx", then "4xx" (newest first) and take the most recent failure.',
          '2. Read the request and response (get_request) and the Dart call site that sent it (get_request_source).',
          '3. If the response is JSON, run check_contract on it: a field that makes the generated fromJson throw is a common cause.',
          '4. Explain the cause (request built wrong, server error, or parsing) and fix the code.',
          '5. Verify: hot_restart (or trigger the flow again), then assert_traffic for that request (status "2xx", json fields).',
          'Secrets appear as "[redacted]"; that is intentional.',
        ].join('\n'),
      );
    },
  );
  server.registerPrompt(
    'test-error-states',
    {
      title: 'Test error states of an endpoint',
      description: 'Exercise how the app handles failures of one endpoint (errors, timeouts, bad fields) without touching the backend.',
      argsSchema: { url: z.string().min(1).max(2000).describe('URL glob of the endpoint, e.g. "*/api/users*".') },
    },
    ({ url }) => {
      const u = oneLine(url, 2000);
      return promptText(
        [
          `Test how the app handles error states of ${u} without changing the backend. For each case: add the rule with times: 1, hot_restart or trigger the call, observe the app (wait_for_request, get_request, its logs/UI), then go on.`,
          '- add_mock with status 500, 401 and 404 (realistic error bodies), and with an empty list / object.',
          `- simulate_network with url "${u}" and fault "timeout", then "reset"; and profile "slow-3g" for the same url.`,
          '- add_mutation: null and delete the fields the models need (get_body_shape and check_contract show which).',
          'Report what the app did in each case and what should change. At the end remove leftover rules (list_rules, remove_rule).',
        ].join('\n'),
      );
    },
  );
  server.registerPrompt(
    'verify-change',
    {
      title: 'Verify a change with real traffic',
      description: "Check that a code change produces the expected HTTP traffic and parses with the app's models.",
      argsSchema: { description: z.string().min(1).max(2000).describe('What changed and what the app should now send or receive.') },
    },
    ({ description }) =>
      promptText(
        [
          `Verify this change with the app's real traffic: ${oneLine(description, 2000)}`,
          '1. hot_restart the app (launch_app if get_status shows no session) and drive the affected flow, or ask the user to.',
          '2. assert_traffic for the requests the change should produce: url, method, status, count, order, json fields (withinMs to wait for them).',
          '3. check_contract on the responses involved.',
          '4. On failure use get_request / get_request_source, fix, and repeat. Report pass or fail with the evidence.',
        ].join('\n'),
      ),
  );
  server.registerPrompt(
    'build-api-layer-from-traffic',
    {
      title: 'Build the API layer from traffic',
      description: "Generate models, client methods and fixture tests for an API from the app's recorded traffic.",
      argsSchema: { urlPrefix: z.string().min(1).max(2000).describe('Base URL of the API, e.g. "https://api.example.com/v1/".') },
    },
    ({ urlPrefix }) => {
      const p = oneLine(urlPrefix, 2000).replace(/\*+$/, '');
      return promptText(
        [
          `Build or update the app's API layer for ${p} from recorded traffic.`,
          `1. list_requests with url "${p}*" (limit 200) and group the requests by method + route (ids become {id}).`,
          '2. For each route: get_body_shape, then generate_model {"id": …}. Write the files, merge them with existing models, and run build_runner for freezed / json_serializable.',
          "3. Add the endpoints to the API client in the project's style (Retrofit, Chopper or Dio).",
          '4. generate_fixture_test for the main routes and adapt the tests to call the new client.',
          '5. hot_restart and run check_contract on the new responses until it reports no errors.',
        ].join('\n'),
      );
    },
  );
}

interface Session {
  transport: StreamableHTTPServerTransport;
  server: McpServer;
  lastUsed: number;
}

function send(res: http.ServerResponse, status: number, body: string, extra: Record<string, string> = {}): void {
  if (res.headersSent) return void res.end();
  res.writeHead(status, { 'content-type': 'application/json', connection: 'close', ...extra });
  res.end(body);
}

const jsonRpcError = (message: string) => JSON.stringify({ jsonrpc: '2.0', error: { code: -32000, message }, id: null });

export async function startMcpServer(o: McpServerOptions): Promise<RunningMcpServer> {
  const log = o.log ?? (() => undefined);
  const sessions = new Map<string, Session>();
  const shutdown = new AbortController();
  const life: Lifecycle = { shutdown: shutdown.signal, inflight: new Set() };
  /** POST responses still streaming (a tool result may still be on its way out). */
  const postResponses = new Set<http.ServerResponse>();
  let port = 0;
  let closing = false;
  let pathToken: string | undefined;

  const closeSession = async (id: string) => {
    const s = sessions.get(id);
    if (!s) return;
    sessions.delete(id);
    await s.transport.close().catch(() => undefined);
    await s.server.close().catch(() => undefined);
  };

  const handle = async (req: http.IncomingMessage, res: http.ServerResponse) => {
    const rawPath = (req.url ?? '').split('?')[0];
    // `/mcp/k/<token>`: the path credential (see issuePathToken). Checked in constant time below.
    const pathCred = /^\/mcp\/k\/([A-Za-z0-9_-]+)$/.exec(rawPath)?.[1];
    const path = pathCred !== undefined ? MCP_PATH : rawPath;
    if (closing) return send(res, 503, jsonRpcError('Server shutting down'));
    // 2. Browsers attach Origin; an MCP client has no reason to.
    if (req.headers.origin !== undefined) return send(res, 403, jsonRpcError('Forbidden'));
    // 3. DNS rebinding: the name the client connected with must be this machine's loopback.
    const host = (req.headers.host ?? '').toLowerCase();
    if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) return send(res, 403, jsonRpcError('Forbidden'));
    // 4. Token.
    const authorised = pathCred !== undefined ? pathToken !== undefined && tokenEquals(pathCred, pathToken) : bearerOk(req.headers.authorization, o.token);
    if (!authorised) {
      return send(res, 401, jsonRpcError('Unauthorized'), { 'www-authenticate': 'Bearer realm="flutter-intercept"' });
    }
    if (path !== MCP_PATH) return send(res, 404, jsonRpcError('Not found'));
    if (req.method !== 'POST' && req.method !== 'GET' && req.method !== 'DELETE') {
      return send(res, 405, jsonRpcError('Method not allowed'), { allow: 'GET, POST, DELETE' });
    }

    if (req.method === 'POST') {
      postResponses.add(res);
      res.once('close', () => postResponses.delete(res));
    }
    const sid = req.headers['mcp-session-id'];
    if (typeof sid === 'string') {
      const s = sessions.get(sid);
      if (!s) return send(res, 404, jsonRpcError('Session not found'));
      s.lastUsed = Date.now();
      await s.transport.handleRequest(req, res);
      return;
    }
    if (req.method !== 'POST') return send(res, 400, jsonRpcError('Bad Request: no session'));

    // A new session (the SDK transport rejects anything but `initialize` here).
    if (sessions.size >= MAX_SESSIONS) {
      const oldest = [...sessions.entries()].sort((a, b) => a[1].lastUsed - b[1].lastUsed)[0];
      if (oldest) await closeSession(oldest[0]);
    }
    const server = buildServer(o, life);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      maxRequestBodySize: MAX_BODY_BYTES,
      onsessioninitialized: (id) => {
        sessions.set(id, { transport, server, lastUsed: Date.now() });
        log(`MCP: client session opened (${sessions.size} active)`);
      },
      onsessionclosed: (id) => {
        // DELETE from the client: let the transport finish answering, then tear the session down.
        setImmediate(() => void closeSession(id).then(() => log(`MCP: client session closed (${sessions.size} active)`)));
      },
    });
    transport.onclose = () => {
      const id = transport.sessionId;
      if (id && sessions.get(id)?.transport === transport) sessions.delete(id);
    };
    await server.connect(transport);
    await transport.handleRequest(req, res);
    if (!transport.sessionId) {
      // Not a valid initialize: don't keep anything around.
      await transport.close().catch(() => undefined);
      await server.close().catch(() => undefined);
    }
  };

  const httpServer = http.createServer((req, res) => {
    handle(req, res).catch((e) => {
      log(`MCP: request failed: ${e instanceof Error ? e.message : String(e)}`);
      send(res, 500, jsonRpcError('Internal error'));
    });
  });
  httpServer.maxConnections = MAX_CONNECTIONS;
  httpServer.on('clientError', (_e, socket) => socket.destroy());

  port = await listen(httpServer, o.port);
  const sweep = setInterval(() => {
    const now = Date.now();
    for (const [id, s] of sessions) if (now - s.lastUsed > SESSION_IDLE_MS) void closeSession(id);
  }, 5 * 60 * 1000);
  sweep.unref();
  const url = `http://127.0.0.1:${port}${MCP_PATH}`;
  log(`MCP: listening on ${url}`);

  return {
    port,
    url,
    get sessions() {
      return sessions.size;
    },
    issuePathToken(t) {
      if (t !== undefined && !/^[A-Za-z0-9_-]{32,}$/.test(t)) throw new Error('path token must be ≥ 32 base64url characters');
      pathToken = t;
      return t === undefined ? undefined : `http://127.0.0.1:${port}${MCP_PATH}/k/${t}`;
    },
    async close() {
      if (closing) return;
      closing = true;
      clearInterval(sweep);
      // End in-flight calls first and give their error results a moment to reach the clients
      // (a long wait_for_request would otherwise leave the client hanging until its own timeout).
      shutdown.abort();
      const deadline = Date.now() + 2000;
      await Promise.race([Promise.allSettled([...life.inflight]), new Promise((r) => setTimeout(r, 2000))]);
      // …and for the POST responses carrying those results to finish streaming.
      while (postResponses.size > 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10));
      await Promise.all([...sessions.keys()].map(closeSession));
      await new Promise<void>((r) => {
        httpServer.close(() => r());
        httpServer.closeAllConnections();
      });
      log('MCP: stopped');
    },
  };
}

/** Listen on 127.0.0.1 (next free port on conflict) and verify the bound address: fail closed. */
async function listen(server: http.Server, preferred: number): Promise<number> {
  const host = mcpTesting.bindHostOverride ?? '127.0.0.1';
  const tries = preferred === 0 ? 1 : PORT_TRIES;
  for (let i = 0; i < tries; i++) {
    const port = preferred === 0 ? 0 : preferred + i;
    if (port > 65535) break;
    try {
      await new Promise<void>((resolve, reject) => {
        const onError = (e: Error) => reject(e);
        server.once('error', onError);
        server.listen(port, host, () => {
          server.off('error', onError);
          resolve();
        });
      });
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'EADDRINUSE' && preferred !== 0) continue;
      throw e;
    }
    const addr = server.address() as AddressInfo | null;
    if (!addr || addr.address !== '127.0.0.1') {
      await new Promise<void>((r) => server.close(() => r()));
      throw new Error(`Flutter Intercept: MCP server bound to ${addr?.address ?? '?'} instead of 127.0.0.1; refusing to run`);
    }
    return addr.port;
  }
  throw new Error(`Flutter Intercept: no free port for the MCP server in ${preferred}–${preferred + PORT_TRIES - 1}`);
}
