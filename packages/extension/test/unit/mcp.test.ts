// MCP server (src/agent/mcp): real SDK client against the real server, fake AgentTools.
import * as http from 'http';
import * as net from 'net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { AgentToolError, READ_TOOLS, WRITE_TOOLS, type AgentTools, type ToolName, type ToolResult } from '../../src/agent/types';
import { bearerOk, generateToken, mcpTesting, startMcpServer, type RunningMcpServer } from '../../src/agent/mcp/server';
import { connectSnippet } from '../../src/agent/mcp/connect';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(cond: () => boolean, ms = 5000) {
  const end = Date.now() + ms;
  while (!cond() && Date.now() < end) await sleep(10);
}

const schemas: Partial<Record<ToolName, object>> = {
  get_status: z.object({}),
  get_request: z.object({ id: z.string(), includeBodies: z.boolean().optional() }),
  wait_for_request: z.object({ url: z.string(), timeoutMs: z.number().int().max(120_000).optional() }),
  list_rules: z.object({}),
  add_mock: z.object({ url: z.string(), status: z.number().int().optional(), body: z.union([z.string(), z.record(z.string(), z.unknown())]) }),
  remove_rule: z.object({ ruleId: z.string() }),
};

class FakeTools implements AgentTools {
  access = 'readWrite' as const;
  calls: Array<{ tool: ToolName; input: Record<string, unknown> }> = [];
  waitAborted = false;
  async call(tool: ToolName, input: Record<string, unknown>, signal?: AbortSignal): Promise<ToolResult> {
    this.calls.push({ tool, input });
    switch (tool) {
      case 'get_status':
        return { proxyRunning: true, port: 8899, pausedCount: 0 };
      case 'add_mock':
        return { ruleId: 'rule-1', echo: input };
      case 'get_request':
        throw new AgentToolError(`No request with id ${String(input.id)}.`, 'not_found');
      case 'list_rules':
        throw new Error('boom');
      case 'wait_for_request':
        return new Promise((_resolve, reject) => {
          const t = setTimeout(() => reject(new AgentToolError('timed out', 'timeout')), 60_000);
          signal?.addEventListener('abort', () => {
            clearTimeout(t);
            this.waitAborted = true;
            reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
          });
        });
      default:
        return { ok: true };
    }
  }
  onDidCall() {
    return { dispose: () => undefined };
  }
}

let server: RunningMcpServer;
let tools: FakeTools;
let token: string;
let logs: string[];
const clients: Client[] = [];

async function connect(auth = `Bearer ${token}`): Promise<Client> {
  const client = new Client({ name: 'vitest', version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(server.url), { requestInit: { headers: { Authorization: auth } } }));
  clients.push(client);
  return client;
}

/** Raw HTTP, so Host / Origin / Authorization can be set freely. */
function raw(opts: { headers?: Record<string, string>; method?: string; path?: string; body?: string | Buffer }): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port: server.port, method: opts.method ?? 'POST', path: opts.path ?? '/mcp', headers: opts.headers, agent: false },
      (res) => {
        let b = '';
        res.on('data', (d) => (b += d));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: b }));
      },
    );
    req.on('error', reject);
    req.end(opts.body);
  });
}

const initBody = JSON.stringify({
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'raw', version: '1' } },
});
const mcpHeaders = () => ({
  host: `127.0.0.1:${server.port}`,
  'content-type': 'application/json',
  accept: 'application/json, text/event-stream',
  authorization: `Bearer ${token}`,
});

beforeEach(async () => {
  tools = new FakeTools();
  token = generateToken();
  logs = [];
  server = await startMcpServer({ port: 0, token, tools, schemas, log: (m) => logs.push(m), version: '0.2.0' });
});
afterEach(async () => {
  for (const c of clients.splice(0)) await c.close().catch(() => undefined);
  await server.close();
  delete mcpTesting.bindHostOverride;
});

describe('MCP server: transport security', () => {
  it('binds 127.0.0.1 and serves /mcp', () => {
    expect(server.url).toBe(`http://127.0.0.1:${server.port}/mcp`);
  });

  it('401 without or with a wrong token; the SDK client cannot connect either', async () => {
    expect((await raw({ headers: { ...mcpHeaders(), authorization: '' }, body: initBody })).status).toBe(401);
    expect((await raw({ headers: { ...mcpHeaders(), authorization: `Bearer ${generateToken()}` }, body: initBody })).status).toBe(401);
    expect((await raw({ headers: { ...mcpHeaders(), authorization: `Basic ${token}` }, body: initBody })).status).toBe(401);
    await expect(connect(`Bearer wrong-${token}`)).rejects.toThrow();
    expect(tools.calls).toEqual([]);
  });

  it('rejects any Origin header and any Host other than 127.0.0.1:<port> / localhost:<port> (DNS rebinding)', async () => {
    for (const origin of ['https://evil.example', 'http://127.0.0.1:1234', 'null']) {
      expect((await raw({ headers: { ...mcpHeaders(), origin }, body: initBody })).status).toBe(403);
    }
    for (const host of ['evil.example', `evil.example:${server.port}`, `127.0.0.1:${server.port + 1}`, '127.0.0.1', `[::1]:${server.port}`]) {
      expect((await raw({ headers: { ...mcpHeaders(), host }, body: initBody })).status).toBe(403);
    }
    // the right ones pass auth and reach the MCP layer
    expect((await raw({ headers: mcpHeaders(), body: initBody })).status).toBe(200);
    expect((await raw({ headers: { ...mcpHeaders(), host: `localhost:${server.port}` }, body: initBody })).status).toBe(200);
  });

  it('only /mcp; only GET/POST/DELETE; no session → 400/404; body over 1 MiB → 413', async () => {
    expect((await raw({ headers: mcpHeaders(), path: '/other', body: initBody })).status).toBe(404);
    expect((await raw({ headers: mcpHeaders(), method: 'PUT', body: initBody })).status).toBe(405);
    expect((await raw({ headers: mcpHeaders(), method: 'GET' })).status).toBe(400);
    expect((await raw({ headers: { ...mcpHeaders(), 'mcp-session-id': 'nope' }, body: initBody })).status).toBe(404);
    const big = Buffer.alloc(1024 * 1024 + 10, 'a');
    // The server answers 413 and closes; on a fast close the client may still be writing and see
    // ECONNRESET/EPIPE instead of the status. Both mean the oversized body was refused.
    const outcome = await raw({ headers: mcpHeaders(), body: big }).then(
      (r) => r.status,
      (e: NodeJS.ErrnoException) => e.code,
    );
    expect([413, 'ECONNRESET', 'EPIPE']).toContain(outcome);
  });

  it('never logs the token', async () => {
    const c = await connect();
    await c.callTool({ name: 'get_status', arguments: {} });
    await raw({ headers: { ...mcpHeaders(), authorization: `Bearer ${token}x` }, body: initBody });
    expect(logs.length).toBeGreaterThan(0);
    expect(logs.join('\n')).not.toContain(token);
  });

  it('bind fails closed: a listener on another address is closed and start rejects', async () => {
    mcpTesting.bindHostOverride = '0.0.0.0';
    const probe = await new Promise<number>((r) => {
      const s = net.createServer().listen(0, '127.0.0.1', () => {
        const p = (s.address() as net.AddressInfo).port;
        s.close(() => r(p));
      });
    });
    await expect(startMcpServer({ port: probe, token, tools, schemas })).rejects.toThrow(/bound to 0\.0\.0\.0 instead of 127\.0\.0\.1; refusing to run/);
    const stillListening = await new Promise<boolean>((r) => {
      const c = net.connect(probe, '127.0.0.1');
      c.on('connect', () => (c.destroy(), r(true)));
      c.on('error', () => r(false));
    });
    expect(stillListening).toBe(false);
  });

  it('takes the next free port when the preferred one is busy', async () => {
    const busy = net.createServer();
    await new Promise<void>((r) => busy.listen(0, '127.0.0.1', r));
    const p = (busy.address() as net.AddressInfo).port;
    const s2 = await startMcpServer({ port: p, token, tools, schemas });
    expect(s2.port).toBeGreaterThan(p);
    await s2.close();
    await new Promise((r) => busy.close(r));
  });

  it('bearerOk is exact', () => {
    expect(bearerOk(`Bearer ${token}`, token)).toBe(true);
    expect(bearerOk(`bearer ${token}`, token)).toBe(true);
    expect(bearerOk(`Bearer ${token} `, token)).toBe(true);
    expect(bearerOk(`Bearer ${token}a`, token)).toBe(false);
    expect(bearerOk(undefined, token)).toBe(false);
    expect(bearerOk(['a', 'b'], token)).toBe(false);
    expect(bearerOk('Bearer ', '')).toBe(false);
  });
});

describe('MCP server: tools', () => {
  it('lists exactly the Agent API tools with the right annotations', async () => {
    const c = await connect();
    const { tools: listed } = await c.listTools();
    expect(listed.map((t) => t.name).sort()).toEqual([...READ_TOOLS, ...WRITE_TOOLS].sort());
    const destructive = new Set(['remove_rule', 'abort_request', 'clear_requests', 'stop_app', 'resend_request', 'simulate_network']); // REVIEW-3 #7
    const idempotentWrites = new Set(['remove_rule', 'abort_request', 'clear_requests', 'stop_app']);
    for (const t of listed) {
      const write = (WRITE_TOOLS as readonly string[]).includes(t.name);
      expect(t.annotations?.readOnlyHint, t.name).toBe(!write);
      expect(t.annotations?.destructiveHint, t.name).toBe(write && destructive.has(t.name));
      expect(t.annotations?.idempotentHint, t.name).toBe(!write || idempotentWrites.has(t.name)); // CONTRACTS §9.5
      expect(t.annotations?.openWorldHint, t.name).toBe(t.name === 'resend_request');
      expect(t.description, t.name).toBeTruthy();
      expect(t.inputSchema.type).toBe('object');
    }
    const addMock = listed.find((t) => t.name === 'add_mock')!;
    expect(addMock.inputSchema.required).toEqual(expect.arrayContaining(['url', 'body']));
  });

  it('a read call and a write call reach AgentTools with validated input', async () => {
    const c = await connect();
    const status = await c.callTool({ name: 'get_status', arguments: {} });
    expect(status.isError).toBeFalsy();
    expect(status.structuredContent).toEqual({ proxyRunning: true, port: 8899, pausedCount: 0 });
    expect(JSON.parse((status.content as Array<{ text: string }>)[0].text)).toEqual(status.structuredContent);

    const mock = await c.callTool({ name: 'add_mock', arguments: { url: 'https://api.example.com/users*', status: 500, body: { error: 'x' } } });
    expect(mock.structuredContent).toMatchObject({ ruleId: 'rule-1', echo: { url: 'https://api.example.com/users*', status: 500, body: { error: 'x' } } });
    expect(tools.calls.map((x) => x.tool)).toEqual(['get_status', 'add_mock']);
  });

  it('invalid input never reaches AgentTools', async () => {
    const c = await connect();
    const r = await c.callTool({ name: 'add_mock', arguments: { status: 'x' } }).catch((e) => ({ isError: true, error: String(e) }));
    expect(r.isError).toBe(true);
    expect(tools.calls).toEqual([]);
  });

  it('errors become MCP tool errors: AgentToolError message as is, anything else as an internal error', async () => {
    const c = await connect();
    const nf = await c.callTool({ name: 'get_request', arguments: { id: 'abc' } });
    expect(nf.isError).toBe(true);
    expect((nf.content as Array<{ text: string }>)[0].text).toBe('No request with id abc.');
    const boom = await c.callTool({ name: 'list_rules', arguments: {} });
    expect(boom.isError).toBe(true);
    expect((boom.content as Array<{ text: string }>)[0].text).toBe('Internal error: boom');
  });

  it('client cancellation of a long wait_for_request aborts the AgentTools call', async () => {
    const c = await connect();
    const ac = new AbortController();
    const pending = c.callTool({ name: 'wait_for_request', arguments: { url: '*/slow*', timeoutMs: 60_000 } }, undefined, { signal: ac.signal });
    await until(() => tools.calls.some((x) => x.tool === 'wait_for_request'));
    ac.abort();
    await expect(pending).rejects.toThrow();
    await until(() => tools.waitAborted, 5000);
    expect(tools.waitAborted).toBe(true);
  });

  it('closing the server aborts in-flight calls and closes sessions', async () => {
    const c = await connect();
    expect(server.sessions).toBe(1);
    const pending = c.callTool({ name: 'wait_for_request', arguments: { url: '*' } }).catch((e) => e);
    await until(() => tools.calls.some((x) => x.tool === 'wait_for_request'));
    await server.close();
    expect(tools.waitAborted).toBe(true);
    expect(server.sessions).toBe(0);
    // the client gets a tool error instead of hanging until its own timeout
    const r = (await Promise.race([pending, sleep(3000).then(() => 'still pending')])) as { isError?: boolean; content?: Array<{ text: string }> };
    expect(r).not.toBe('still pending');
    expect(r.isError).toBe(true);
    expect(r.content?.[0].text).toMatch(/stopped/);
  });
});

describe('connect snippets', () => {
  const url = 'http://127.0.0.1:47823/mcp';
  const tok = 'AbC_dEf-123'.padEnd(43, 'x');
  it('Claude Code: the documented `claude mcp add --transport http` form', () => {
    expect(connectSnippet('claude', url, tok).text).toBe(
      `claude mcp add --transport http flutter-intercept ${url} --header "Authorization: Bearer ${tok}"`,
    );
  });
  it('Cursor: mcp.json with url + headers', () => {
    expect(JSON.parse(connectSnippet('cursor', url, tok).text)).toEqual({
      mcpServers: { 'flutter-intercept': { url, headers: { Authorization: `Bearer ${tok}` } } },
    });
  });
  it('Other: URL + header', () => {
    expect(connectSnippet('other', url, tok).text).toContain(`Header: Authorization: Bearer ${tok}`);
  });
  it('refuses anything that could break out of the shell command', () => {
    expect(() => connectSnippet('claude', url, 'a"; rm -rf ~; "')).toThrow();
    expect(() => connectSnippet('claude', 'http://evil.example/mcp', tok)).toThrow();
  });
});
