// Runs the proxy from a bundle built with EXACTLY the extension's esbuild options + stubs
// (build.mjs --smoke), in plain Node. Proves the minified bundle keeps both mockttp patches
// (listen-host, upstream-pool) and that no stubbed module is hit on our code paths.
import * as http from 'http';
import * as https from 'https';
import * as net from 'net';
import * as tls from 'tls';
import { InterceptProxy, type Exchange } from '@flutter-intercept/proxy';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { startMcpServer } from '../../src/agent/mcp/server';
import { toolDescriptions, toolSchemas } from '../../src/agent/schema';
import type { AgentTools } from '../../src/agent/types';

/**
 * PERF-2 #4: the MCP server through this bundle, where the SDK's Zod 3 paths are stubs that throw — every real tool
 * schema converts to JSON Schema, validates good input and rejects bad input on the Zod 4 paths.
 */
async function mcpSmoke(): Promise<string> {
  const calls: string[] = [];
  const tools: AgentTools = {
    access: 'readWrite',
    call: async (tool) => (calls.push(tool), { ok: true }),
    onDidCall: () => ({ dispose: () => undefined }),
  };
  const server = await startMcpServer({ port: 0, token: 'smoke-token', tools, schemas: toolSchemas, descriptions: toolDescriptions() });
  const client = new Client({ name: 'bundle-smoke', version: '1.0.0' });
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(server.url), { requestInit: { headers: { Authorization: 'Bearer smoke-token' } } }));
    const listed = (await client.listTools()).tools;
    const want = Object.keys(toolSchemas).length;
    if (listed.length !== want) fail(`MCP: ${listed.length} tools listed, ${want} expected`);
    const bad = listed.filter((t) => t.inputSchema?.type !== 'object');
    if (bad.length) fail(`MCP: tools without an object input schema: ${bad.map((t) => t.name).join(', ')}`);
    const ok = await client.callTool({ name: 'get_request', arguments: { id: 'x' } });
    if (ok.isError || calls[0] !== 'get_request') fail(`MCP: get_request call failed: ${JSON.stringify(ok)}`);
    const refused = await client.callTool({ name: 'get_request', arguments: { id: 42 } }).catch((e: Error) => ({ isError: true, content: [{ type: 'text', text: e.message }] }));
    if (!refused.isError || calls.length !== 1) fail(`MCP: invalid input was not refused: ${JSON.stringify(refused)}`);
    return `MCP ${listed.length} tools ok`;
  } finally {
    await client.close().catch(() => undefined);
    await server.close();
  }
}

function fail(msg: string): never {
  console.error(`[bundle-smoke] FAIL ${msg}`);
  process.exit(1);
}

async function viaTunnel(proxyPort: number, target: string, path: string): Promise<number> {
  const c = http.request({ host: '127.0.0.1', port: proxyPort, method: 'CONNECT', path: target });
  c.end();
  const sock = await new Promise<net.Socket>((r, j) => c.on('connect', (_res, s) => r(s)).on('error', j));
  const t = tls.connect({ socket: sock, rejectUnauthorized: false });
  return new Promise((resolve, reject) => {
    http
      .get({ path, headers: { host: target, connection: 'keep-alive' }, createConnection: () => t }, (res) => {
        res.resume();
        res.on('end', () => resolve(res.statusCode ?? 0));
      })
      .on('error', reject);
  });
}

(async () => {
  const t0 = Date.now();
  const proxy = new InterceptProxy({ port: 0, ignoreUpstreamCertErrors: true });
  await proxy.start();
  const startMs = Date.now() - t0;

  const raw = (proxy as any).server.server as net.Server;
  const addr = raw.address() as net.AddressInfo;
  if (addr.address !== '127.0.0.1') fail(`listen-host patch lost: bound to ${addr.address}`);
  if (!(proxy as any).pool?.active) fail('upstream-pool patch lost: getAgent hook inactive');

  // Self-signed HTTPS origin, cert from the proxy's own (bundled) CA generator path.
  const { generateCACertificate } = require('mockttp/dist/util/certificates');
  const { key, cert } = await generateCACertificate({ subject: { commonName: 'localhost' } });
  let upstreamConns = 0;
  const origin = https.createServer({ key, cert }, (_q, r) => r.end('ok'));
  origin.on('connection', () => upstreamConns++);
  await new Promise<void>((r) => origin.listen(0, '127.0.0.1', r));
  const target = `127.0.0.1:${(origin.address() as net.AddressInfo).port}`;

  for (let i = 0; i < 5; i++) {
    const s = await viaTunnel(proxy.port, target, `/n${i}`);
    if (s !== 200) fail(`HTTPS pass-through status ${s}`);
  }
  if (upstreamConns !== 1) fail(`expected 1 pooled upstream connection for 5 tunnels, got ${upstreamConns}`);

  // CONTRACTS §13.2: upstream phases survive bundling (the pool's per-request timing view).
  await new Promise((r) => setTimeout(r, 50));
  const passed = proxy.getExchanges().filter((e) => e.url.includes('/n'));
  const first = passed.find((e) => e.url.endsWith('/n0'));
  if (!first?.timings || typeof first.timings.waitMs !== 'number' || typeof first.timings.tlsMs !== 'number') {
    fail(`timings lost in the bundle: ${JSON.stringify(passed.map((e) => e.timings))}`);
  }
  if (!passed.some((e) => e.timings?.reused)) fail(`no reused-connection timings: ${JSON.stringify(passed.map((e) => e.timings))}`);

  // Mock and upstream failure (502) through the bundle.
  proxy.setRules([{ id: 'm', enabled: true, match: { url: '*/mocked' }, action: { kind: 'mock', status: 201, body: 'M' } }]);
  const get = (url: string) =>
    new Promise<number>((resolve, reject) =>
      http
        .get({ host: '127.0.0.1', port: proxy.port, path: url, headers: { host: new URL(url).host } }, (res) => {
          res.resume();
          res.on('end', () => resolve(res.statusCode ?? 0));
        })
        .on('error', reject),
    );
  if ((await get('http://127.0.0.1:1/mocked')) !== 201) fail('mock');
  if ((await get('http://127.0.0.1:1/dead')) !== 502) fail('upstream failure should be 502');
  await new Promise((r) => setTimeout(r, 50));
  const states = proxy.getExchanges().map((e: Exchange) => e.state);
  if (states.filter((s) => s === 'completed').length !== 5 || !states.includes('mocked') || !states.includes('error')) {
    fail(`unexpected states ${JSON.stringify(states)}`);
  }

  await proxy.stop();
  origin.close();
  const mcp = await mcpSmoke();
  console.log(`[bundle-smoke] ok: bound ${addr.address}, pool active, 5 tunnels -> ${upstreamConns} upstream conn, mock + 502 ok, start ${startMs} ms, ${mcp}`);
})().catch((e) => fail(String(e?.stack ?? e)));
