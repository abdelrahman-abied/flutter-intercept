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
 */
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'crypto';
import * as http from 'http';
import type { AddressInfo } from 'net';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { AgentToolError, READ_TOOLS, WRITE_TOOLS, type AgentTools, type ToolName } from '../types';

export const MCP_PATH = '/mcp';
export const DEFAULT_MCP_PORT = 47823;
const PORT_TRIES = 100;
const MAX_BODY_BYTES = 1024 * 1024;
const MAX_CONNECTIONS = 64;
const MAX_SESSIONS = 16;
const SESSION_IDLE_MS = 60 * 60 * 1000;

/** Write tools that destroy state or work in progress (clients ask before running them). */
export const DESTRUCTIVE_TOOLS: ReadonlySet<ToolName> = new Set<ToolName>(['remove_rule', 'abort_request', 'clear_requests', 'stop_app']);

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
  close(): Promise<void>;
}

/** Test seams. Never set outside tests. */
export const mcpTesting: { bindHostOverride?: string } = {};

export function generateToken(): string {
  return randomBytes(32).toString('base64url');
}

const digest = (s: string) => createHash('sha256').update(s, 'utf8').digest();

/** Constant-time `Authorization: Bearer <token>` check (digests, so length doesn't leak either). */
export function bearerOk(header: string | string[] | undefined, token: string): boolean {
  if (typeof header !== 'string') return false;
  const m = /^\s*Bearer\s+(\S+)\s*$/i.exec(header);
  return timingSafeEqual(digest(m ? m[1] : ''), digest(token)) && m !== null && token.length > 0;
}

export function toolAnnotations(tool: ToolName) {
  const write = (WRITE_TOOLS as readonly string[]).includes(tool);
  return {
    title: tool.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase()),
    readOnlyHint: !write,
    // The MCP default for destructiveHint is TRUE when readOnlyHint is false: say it explicitly.
    destructiveHint: write ? DESTRUCTIVE_TOOLS.has(tool) : false,
    idempotentHint: !write,
    openWorldHint: false,
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
            return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }], structuredContent: result };
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
  return server;
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

  const closeSession = async (id: string) => {
    const s = sessions.get(id);
    if (!s) return;
    sessions.delete(id);
    await s.transport.close().catch(() => undefined);
    await s.server.close().catch(() => undefined);
  };

  const handle = async (req: http.IncomingMessage, res: http.ServerResponse) => {
    const path = (req.url ?? '').split('?')[0];
    if (closing) return send(res, 503, jsonRpcError('Server shutting down'));
    // 2. Browsers attach Origin; an MCP client has no reason to.
    if (req.headers.origin !== undefined) return send(res, 403, jsonRpcError('Forbidden'));
    // 3. DNS rebinding: the name the client connected with must be this machine's loopback.
    const host = (req.headers.host ?? '').toLowerCase();
    if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) return send(res, 403, jsonRpcError('Forbidden'));
    // 4. Token.
    if (!bearerOk(req.headers.authorization, o.token)) {
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
