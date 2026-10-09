// Cursor zero-config registration, the path credential, "Add to Claude Code now" and the connect flow.
import * as http from 'http';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { AgentTools, ToolName, ToolResult } from '../../src/agent/types';
import { generateToken, startMcpServer, type RunningMcpServer } from '../../src/agent/mcp/server';
import { CURSOR_SERVER_NAME, CursorRegistrar, detectCursorMcp, type CursorMcpApi } from '../../src/agent/mcp/cursor';
import { addToClaudeCode, claudeAddArgs, claudeRemoveArgs, findClaude, type RunResult } from '../../src/agent/mcp/claude';
import { ADD_TO_CLAUDE_NOW, COPY_ALTERNATIVE, runConnectAgent, type ConnectUi } from '../../src/agent/mcp/connectFlow';
import { connectSnippet } from '../../src/agent/mcp/connect';

const tools: AgentTools = {
  access: 'readWrite',
  async call(tool: ToolName): Promise<ToolResult> {
    return { tool };
  },
  onDidCall: () => ({ dispose: () => undefined }),
};

let server: RunningMcpServer;
let token: string;
beforeEach(async () => {
  token = generateToken();
  server = await startMcpServer({ port: 0, token, tools, schemas: {} });
});
afterEach(async () => {
  await server.close();
});

const eph = () => generateToken();

function rawPost(urlPath: string, headers: Record<string, string> = {}): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port: server.port,
        method: 'POST',
        path: urlPath,
        headers: { host: `127.0.0.1:${server.port}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers },
        agent: false,
      },
      (res) => (res.resume(), res.on('end', () => resolve(res.statusCode ?? 0))),
    );
    req.on('error', reject);
    req.end(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'x', version: '1' } } }));
  });
}

describe('path credential (for clients that cannot send headers)', () => {
  it('a header-less SDK client works through the issued URL; revoked or replaced URLs get 401', async () => {
    const first = eph();
    const url = server.issuePathToken(first)!;
    expect(url).toBe(`http://127.0.0.1:${server.port}/mcp/k/${first}`);
    const c = new Client({ name: 'cursor-like', version: '1' });
    await c.connect(new StreamableHTTPClientTransport(new URL(url))); // no Authorization header at all
    expect((await c.callTool({ name: 'get_status', arguments: {} })).structuredContent).toEqual({ tool: 'get_status' });
    await c.close();

    const second = eph();
    server.issuePathToken(second);
    expect(await rawPost(`/mcp/k/${first}`)).toBe(401); // replaced
    expect(await rawPost(`/mcp/k/${second}`)).toBe(200);
    server.issuePathToken(undefined);
    expect(await rawPost(`/mcp/k/${second}`)).toBe(401); // revoked
    expect(await rawPost(`/mcp/k/${token}`)).toBe(401); // the Bearer token is not a path credential
    expect(await rawPost('/mcp', { authorization: `Bearer ${token}` })).toBe(200); // Bearer unaffected
  });

  it('the path credential is still subject to the Origin and Host checks', async () => {
    const t = eph();
    server.issuePathToken(t);
    expect(await rawPost(`/mcp/k/${t}`, { origin: 'https://evil.example' })).toBe(403);
    expect(await rawPost(`/mcp/k/${t}`, { host: `evil.example:${server.port}` })).toBe(403);
  });

  it('rejects weak path tokens', () => {
    expect(() => server.issuePathToken('short')).toThrow();
  });
});

describe('Cursor zero-config', () => {
  class FakeCursor implements CursorMcpApi {
    log: string[] = [];
    registered = new Map<string, { url: string; headers?: Record<string, string> }>();
    failRegister = false;
    async registerServer(c: { name: string; server: { url: string; headers?: Record<string, string> } }) {
      if (this.failRegister) throw new Error('Invalid MCP server config');
      if (this.registered.has(c.name)) return; // Cursor ignores duplicates
      this.registered.set(c.name, c.server);
      this.log.push(`register ${c.name}`);
    }
    async unregisterServer(name: string) {
      this.registered.delete(name);
      this.log.push(`unregister ${name}`);
    }
  }
  const target = () => ({
    token,
    issueUrl: () => server.issuePathToken(eph())!,
    revoke: () => void server.issuePathToken(undefined),
  });

  it('detects only an API with both functions; a throwing getter or VS Code is "absent"', () => {
    expect(detectCursorMcp({})).toBeUndefined();
    expect(detectCursorMcp({ cursor: { mcp: { registerServer: () => undefined } } })).toBeUndefined();
    const api = { registerServer: () => undefined, unregisterServer: () => undefined };
    expect(detectCursorMcp({ cursor: { mcp: api } })).toBe(api);
    const throwing = Object.defineProperty({}, 'cursor', { get: () => { throw new Error('nope'); } });
    expect(detectCursorMcp(throwing)).toBeUndefined();
  });

  it('registers `flutter-intercept` with a working URL + Bearer header; re-registers on restart; unregisters when stopped', async () => {
    const fake = new FakeCursor();
    const reg = new CursorRegistrar(fake, () => undefined);
    await reg.sync(target());
    const s1 = fake.registered.get(CURSOR_SERVER_NAME)!;
    expect(s1.url).toMatch(new RegExp(`^http://127\\.0\\.0\\.1:${server.port}/mcp/k/[A-Za-z0-9_-]{43}$`));
    expect(s1.headers).toEqual({ Authorization: `Bearer ${token}` });
    // Cursor 3.23 drops headers: the URL alone must authenticate.
    const c = new Client({ name: 'cursor', version: '1' });
    await c.connect(new StreamableHTTPClientTransport(new URL(s1.url)));
    await c.close();

    await reg.sync(target()); // server restarted / moved
    const s2 = fake.registered.get(CURSOR_SERVER_NAME)!;
    expect(s2.url).not.toBe(s1.url);
    expect(await rawPost(new URL(s1.url).pathname)).toBe(401); // the old credential is dead
    expect(fake.log).toEqual(['register flutter-intercept', 'unregister flutter-intercept', 'register flutter-intercept']);

    await reg.sync(undefined); // access off / dispose
    expect(fake.registered.size).toBe(0);
    expect(reg.isRegistered).toBe(false);
  });

  it('a different API shape never throws: logs, revokes the credential, and stops trying', async () => {
    const fake = new FakeCursor();
    fake.failRegister = true;
    const logs: string[] = [];
    const reg = new CursorRegistrar(fake, (m) => logs.push(m));
    let issued: string | undefined;
    await expect(
      reg.sync({ token, issueUrl: () => (issued = server.issuePathToken(eph())!), revoke: () => void server.issuePathToken(undefined) }),
    ).resolves.toBeUndefined();
    expect(reg.available).toBe(false);
    expect(logs.join('\n')).toMatch(/Cursor registration failed.*Connect AI Agent/);
    expect(await rawPost(new URL(issued!).pathname)).toBe(401);
    expect(logs.join('\n')).not.toContain(token);
  });

  it('is a no-op without the API (VS Code)', async () => {
    const reg = new CursorRegistrar(undefined, () => undefined);
    await reg.sync(target());
    expect(reg.isRegistered).toBe(false);
  });
});

describe('Add to Claude Code now (fake runner — never touches the real Claude config)', () => {
  const url = 'http://127.0.0.1:47823/mcp';
  const tok = generateToken();
  const ok = (stdout = ''): RunResult => ({ code: 0, stdout, stderr: '' });
  const fail = (stderr: string): RunResult => ({ code: 1, stdout: '', stderr });

  it('runs exactly `claude mcp add --transport http --scope user flutter-intercept <url> --header "Authorization: Bearer <token>"`', async () => {
    const calls: Array<[string, string[]]> = [];
    const r = await addToClaudeCode({ url, token: tok, find: () => '/opt/homebrew/bin/claude', run: async (f, a) => (calls.push([f, a]), ok()) });
    expect(r).toMatchObject({ ok: true, replaced: false });
    expect(calls).toEqual([
      ['/opt/homebrew/bin/claude', ['mcp', 'add', '--transport', 'http', '--scope', 'user', 'flutter-intercept', url, '--header', `Authorization: Bearer ${tok}`]],
    ]);
    expect(r.message).not.toContain(tok);
  });

  it('an existing entry: removes ONLY flutter-intercept (user scope), then adds again', async () => {
    const calls: string[][] = [];
    let n = 0;
    const r = await addToClaudeCode({
      url,
      token: tok,
      find: () => 'claude',
      run: async (_f, a) => {
        calls.push(a);
        return ++n === 1 ? fail('MCP server flutter-intercept already exists in user config') : ok();
      },
    });
    expect(r).toMatchObject({ ok: true, replaced: true });
    expect(calls).toEqual([claudeAddArgs(url, tok), ['mcp', 'remove', '--scope', 'user', 'flutter-intercept'], claudeAddArgs(url, tok)]);
    expect(claudeRemoveArgs()).toEqual(['mcp', 'remove', '--scope', 'user', 'flutter-intercept']);
  });

  it('claude not found, a failing remove, and other errors are reported without the token', async () => {
    expect(await addToClaudeCode({ url, token: tok, find: () => undefined, run: async () => ok() })).toMatchObject({
      ok: false,
      message: expect.stringMatching(/not found on PATH/),
    });
    let n = 0;
    const rmFail = await addToClaudeCode({ url, token: tok, find: () => 'claude', run: async () => (++n === 1 ? fail('already exists') : fail('permission denied')) });
    expect(rmFail).toMatchObject({ ok: false, message: expect.stringMatching(/Could not replace.*permission denied/) });
    const other = await addToClaudeCode({ url, token: tok, find: () => 'claude', run: async () => fail(`bad header Authorization: Bearer ${tok}`) });
    expect(other.ok).toBe(false);
    expect(other.message).not.toContain(tok);
    expect(other.message).toContain('<token>');
  });

  it('refuses unsafe input before running anything', async () => {
    let ran = false;
    await expect(addToClaudeCode({ url: 'http://evil.example/mcp', token: tok, find: () => 'claude', run: async () => ((ran = true), ok()) })).rejects.toThrow();
    expect(ran).toBe(false);
  });

  it('findClaude: PATH first, then the usual install dirs', () => {
    const p = (...s: string[]) => path.join(...s);
    const exe = process.platform === 'win32' ? 'claude.exe' : 'claude';
    expect(findClaude({ PATH: ['/a', '/b'].join(path.delimiter), HOME: '/home/u' }, (f) => f === p('/b', exe))).toBe(p('/b', exe));
    expect(findClaude({ PATH: '/a', HOME: '/home/u' }, (f) => f === p('/home/u', '.claude', 'local', exe))).toBe(p('/home/u', '.claude', 'local', exe));
    expect(findClaude({ PATH: '/a', HOME: '/home/u' }, () => false)).toBeUndefined();
  });
});

describe('Connect AI Agent flow', () => {
  const url = 'http://127.0.0.1:47823/mcp';
  const tok = generateToken();
  function fakeUi(pick: string | undefined, click?: string) {
    const ui = {
      copied: [] as string[],
      infos: [] as string[],
      errors: [] as string[],
      items: [] as string[],
      pick: async (items: Array<{ label: string; client: string }>) => ((ui.items = items.map((i) => i.label)), pick as never),
      copy: async (t: string) => void ui.copied.push(t),
      info: async (m: string, ...buttons: string[]) => (ui.infos.push(m), buttons.includes(click ?? '') ? click : undefined),
      error: async (m: string) => void ui.errors.push(m),
    };
    return ui;
  }

  it('offers Claude Code, Cursor, Gemini CLI, Other', async () => {
    const ui = fakeUi(undefined);
    await runConnectAgent(ui as ConnectUi, { url, token: tok });
    expect(ui.items).toEqual(['Claude Code', 'Cursor', 'Gemini CLI', 'Other MCP client']);
    expect(ui.copied).toEqual([]);
  });

  it('Claude Code: copies; runs claude ONLY after the click', async () => {
    let calls = 0;
    const addToClaude = async () => (calls++, { ok: true, replaced: false, message: 'Added' });
    const noClick = fakeUi('claude');
    await runConnectAgent(noClick as ConnectUi, { url, token: tok, addToClaude });
    expect(noClick.copied).toEqual([connectSnippet('claude', url, tok).text]);
    expect(calls).toBe(0);
    const click = fakeUi('claude', ADD_TO_CLAUDE_NOW);
    await runConnectAgent(click as ConnectUi, { url, token: tok, addToClaude });
    expect(calls).toBe(1);
    expect(click.infos.at(-1)).toBe('Added');
    const failing = fakeUi('claude', ADD_TO_CLAUDE_NOW);
    await runConnectAgent(failing as ConnectUi, { url, token: tok, addToClaude: async () => ({ ok: false, replaced: false, message: 'not found' }) });
    expect(failing.errors).toEqual(['not found']);
  });

  it('Gemini CLI: command, and the settings.json snippet on request', async () => {
    const ui = fakeUi('gemini', COPY_ALTERNATIVE);
    await runConnectAgent(ui as ConnectUi, { url, token: tok });
    expect(ui.copied[0]).toBe(`gemini mcp add --transport http --scope user --header "Authorization: Bearer ${tok}" flutter-intercept ${url}`);
    expect(JSON.parse(ui.copied[1])).toEqual({ mcpServers: { 'flutter-intercept': { httpUrl: url, headers: { Authorization: `Bearer ${tok}` } } } });
  });

  it('Cursor: snippet, with a note when it is already registered automatically', async () => {
    const ui = fakeUi('cursor');
    await runConnectAgent(ui as ConnectUi, { url, token: tok, cursorAutoRegistered: true });
    expect(JSON.parse(ui.copied[0]).mcpServers['flutter-intercept'].url).toBe(url);
    expect(ui.infos[0]).toMatch(/registered automatically/);
    expect(ui.infos[0]).toMatch(/treat it like a password/);
  });
});
