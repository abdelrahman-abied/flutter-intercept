// CONTRACTS §10.6: MCP resources (redacted tool views via AgentTools.call) and prompts, through the real SDK client.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { AgentToolError, type AgentTools, type ToolName, type ToolResult } from '../../src/agent/types';
import { generateToken, PROMPT_NAMES, startMcpServer, toolAnnotations, type RunningMcpServer } from '../../src/agent/mcp/server';
import { toolSchemas } from '../../src/agent/schema';

class FakeTools implements AgentTools {
  access: 'readWrite' | 'readOnly' | 'off' = 'readWrite';
  calls: { tool: ToolName; input: Record<string, unknown> }[] = [];
  async call(tool: ToolName, input: Record<string, unknown>): Promise<ToolResult> {
    this.calls.push({ tool, input });
    if (this.access === 'off') throw new AgentToolError('Flutter Intercept agent access is off.', 'access');
    switch (tool) {
      case 'list_requests':
        return { items: [{ id: 'e/1', method: 'GET', url: 'https://api.example.com/u?token=[redacted]', status: 200, state: 'completed' }], total: 1 };
      case 'get_request':
        if (input.id === 'missing') throw new AgentToolError('no recorded exchange with id "missing"', 'not_found');
        return { id: input.id, requestHeaders: { authorization: '[redacted]' } };
      case 'list_paused':
        return { items: [] };
      case 'list_rules':
        return { rules: [{ id: 'r1' }] };
      case 'check_contract':
        return { results: [{ exchangeId: input.id, checked: true, violations: [] }] };
      default:
        return {};
    }
  }
  onDidCall() {
    return { dispose: () => undefined };
  }
}

let server: RunningMcpServer;
let tools: FakeTools;
let client: Client;

beforeEach(async () => {
  tools = new FakeTools();
  const token = generateToken();
  server = await startMcpServer({ port: 0, token, tools, schemas: toolSchemas, version: '0.4.0' });
  client = new Client({ name: 'vitest', version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(server.url), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
});
afterEach(async () => {
  await client.close().catch(() => undefined);
  await server.close();
});

describe('MCP resources', () => {
  it('lists static resources, the exchange list and both templates', async () => {
    expect(client.getServerCapabilities()?.resources).toBeDefined();
    const { resources } = await client.listResources();
    expect(resources.map((r) => r.uri).sort()).toEqual(['intercept://exchange/e%2F1', 'intercept://paused', 'intercept://rules']);
    const ex = resources.find((r) => r.uri.startsWith('intercept://exchange/'))!;
    expect(ex).toMatchObject({ mimeType: 'application/json', name: 'GET https://api.example.com/u?token=[redacted]' });
    const { resourceTemplates } = await client.listResourceTemplates();
    expect(resourceTemplates.map((t) => t.uriTemplate).sort()).toEqual(['intercept://contract/{id}', 'intercept://exchange/{id}']);
  });

  it('reads through the same tools (same redacted views)', async () => {
    const r = await client.readResource({ uri: 'intercept://exchange/e%2F1' });
    expect(r.contents[0]).toMatchObject({ uri: 'intercept://exchange/e%2F1', mimeType: 'application/json' });
    expect(JSON.parse(String((r.contents[0] as { text: string }).text))).toEqual({ id: 'e/1', requestHeaders: { authorization: '[redacted]' } });
    expect(JSON.parse(String(((await client.readResource({ uri: 'intercept://rules' })).contents[0] as { text: string }).text))).toEqual({ rules: [{ id: 'r1' }] });
    expect(JSON.parse(String(((await client.readResource({ uri: 'intercept://paused' })).contents[0] as { text: string }).text))).toEqual({ items: [] });
    const c = await client.readResource({ uri: 'intercept://contract/e7' });
    expect(JSON.parse(String((c.contents[0] as { text: string }).text)).results[0].exchangeId).toBe('e7');
    expect(tools.calls.map((x) => [x.tool, x.input])).toContainEqual(['check_contract', { id: 'e7' }]);
    expect(tools.calls.map((x) => [x.tool, x.input])).toContainEqual(['get_request', { id: 'e/1' }]);
  });

  it('turns tool errors into MCP errors (unknown id, access off, unknown resource)', async () => {
    await expect(client.readResource({ uri: 'intercept://exchange/missing' })).rejects.toThrow(/no recorded exchange/);
    await expect(client.readResource({ uri: 'intercept://nothing' })).rejects.toThrow(/not found/);
    tools.access = 'off';
    await expect(client.readResource({ uri: 'intercept://rules' })).rejects.toThrow(/access is off/);
    expect((await client.listResources()).resources.map((r) => r.uri).sort()).toEqual(['intercept://paused', 'intercept://rules']);
  });
});

describe('MCP prompts', () => {
  it('lists the four prompts with their arguments', async () => {
    const { prompts } = await client.listPrompts();
    expect(prompts.map((p) => p.name).sort()).toEqual([...PROMPT_NAMES].sort());
    const args = Object.fromEntries(prompts.map((p) => [p.name, (p.arguments ?? []).map((a) => `${a.name}${a.required ? '!' : '?'}`)]));
    expect(args).toEqual({
      'debug-failing-request': ['id?'],
      'test-error-states': ['url!'],
      'verify-change': ['description!'],
      'build-api-layer-from-traffic': ['urlPrefix!'],
    });
  });

  it('returns short tool-oriented user messages', async () => {
    const text = async (name: string, args: Record<string, string> = {}) => {
      const r = await client.getPrompt({ name, arguments: args });
      expect(r.messages).toHaveLength(1);
      expect(r.messages[0].role).toBe('user');
      return String((r.messages[0].content as { text: string }).text);
    };
    const d1 = await text('debug-failing-request');
    expect(d1).toMatch(/list_requests/);
    expect(d1).toMatch(/check_contract/);
    expect(await text('debug-failing-request', { id: 'e42' })).toContain('get_request {"id": "e42"}');
    const t = await text('test-error-states', { url: '*/api/users*' });
    for (const tool of ['add_mock', 'simulate_network', 'add_mutation', 'remove_rule']) expect(t).toContain(tool);
    expect(t).toContain('*/api/users*');
    expect(await text('verify-change', { description: 'login sends\nthe device id' })).toMatch(/login sends the device id[\s\S]*assert_traffic/);
    const b = await text('build-api-layer-from-traffic', { urlPrefix: 'https://api.example.com/v1/*' });
    expect(b).toContain('list_requests with url "https://api.example.com/v1/*"');
    expect(b).toMatch(/generate_model[\s\S]*generate_fixture_test[\s\S]*check_contract/);
    for (const s of [d1, t, b]) expect(s.length).toBeLessThan(1200);
  });

  it('validates required arguments', async () => {
    await expect(client.getPrompt({ name: 'test-error-states', arguments: {} })).rejects.toThrow();
  });
});

describe('annotations for the v0.4.0 tools', () => {
  it('read tools are read-only and idempotent; add_mutation is like add_mock', () => {
    for (const t of ['check_contract', 'generate_model', 'generate_fixture_test', 'assert_traffic'] as ToolName[]) {
      expect(toolAnnotations(t)).toMatchObject({ readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false });
    }
    const { title: _a, ...mutation } = toolAnnotations('add_mutation');
    const { title: _b, ...mock } = toolAnnotations('add_mock');
    expect(mutation).toEqual(mock);
    expect(mutation).toMatchObject({ readOnlyHint: false, destructiveHint: false, idempotentHint: false });
  });

  it('every tool is listed with its schema', async () => {
    const { tools: listed } = await client.listTools();
    for (const t of ['check_contract', 'generate_model', 'generate_fixture_test', 'assert_traffic', 'add_mutation']) {
      expect(listed.find((x) => x.name === t)?.inputSchema?.type).toBe('object');
    }
  });
});
