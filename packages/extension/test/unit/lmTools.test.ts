import { describe, expect, it } from 'vitest';
import {
  ALL_TOOLS,
  confirmationText,
  formatResult,
  invocationMessage,
  LmTool,
  LmVscode,
  lmToolName,
  registerLmTools,
} from '../../src/agent/lmTools';
import { AgentAccess, AgentToolError, AgentTools, READ_TOOLS, TOOL_IMAGES, ToolName, WRITE_TOOLS } from '../../src/agent/types';

class TextPart {
  constructor(readonly value: string) {}
}
class ToolResult {
  constructor(readonly content: unknown[]) {}
}
class Markdown {
  constructor(readonly value = '') {}
}

function fakeVscode(withLm = true) {
  const tools = new Map<string, LmTool>();
  const disposed: string[] = [];
  const vs: LmVscode = {
    MarkdownString: Markdown as unknown as LmVscode['MarkdownString'],
    LanguageModelTextPart: TextPart as unknown as LmVscode['LanguageModelTextPart'],
    LanguageModelToolResult: ToolResult as unknown as LmVscode['LanguageModelToolResult'],
    lm: withLm
      ? {
          registerTool: (name: string, tool: LmTool) => {
            if (tools.has(name)) throw new Error(`duplicate ${name}`);
            tools.set(name, tool);
            return { dispose: () => disposed.push(name) };
          },
        }
      : {},
  };
  return { vs, tools, disposed };
}

function fakeTools(access: AgentAccess = 'readWrite', impl?: (t: ToolName, i: Record<string, unknown>, s?: AbortSignal) => Promise<Record<string, unknown>>) {
  const calls: { tool: ToolName; input: Record<string, unknown>; signal?: AbortSignal }[] = [];
  const tools: AgentTools = {
    access,
    async call(tool, input, signal) {
      calls.push({ tool, input, signal });
      if (impl) return impl(tool, input, signal);
      if (tool === 'list_rules') return { rules: [{ id: 'r1', name: '[agent] login 500' }] };
      return { ok: true, tool };
    },
    onDidCall: () => ({ dispose: () => undefined }),
  };
  return { tools, calls };
}

const token = (cancelled = false) => {
  const listeners: (() => void)[] = [];
  return {
    isCancellationRequested: cancelled,
    onCancellationRequested: (l: () => void) => {
      listeners.push(l);
      return { dispose: () => undefined };
    },
    fire: () => listeners.forEach((l) => l()),
  };
};

describe('registerLmTools', () => {
  it('registers every tool as flutter_intercept_<name> and disposes with the context', () => {
    const { vs, tools, disposed } = fakeVscode();
    const ctx = { subscriptions: [] as { dispose(): unknown }[] };
    const reg = registerLmTools(ctx, { tools: fakeTools().tools, vscode: vs });
    expect(reg.registered).toEqual([...READ_TOOLS, ...WRITE_TOOLS].map((t) => `flutter_intercept_${t}`));
    expect([...tools.keys()]).toEqual(reg.registered);
    expect(ctx.subscriptions).toContain(reg);
    reg.dispose();
    expect(disposed.length).toBe(ALL_TOOLS.length);
  });

  it('is a no-op on hosts without vscode.lm.registerTool (engines ^1.90)', () => {
    const { vs } = fakeVscode(false);
    const logs: string[] = [];
    const reg = registerLmTools({ subscriptions: [] }, { tools: fakeTools().tools, vscode: vs, log: (m) => logs.push(m) });
    expect(reg.registered).toEqual([]);
    expect(logs.join()).toMatch(/not available/);
  });

  it('only registers names declared in the contribution and reports mismatches', () => {
    const { vs } = fakeVscode();
    const logs: string[] = [];
    const contribution = [{ name: 'flutter_intercept_get_status' }, { name: 'flutter_intercept_bogus' }];
    const reg = registerLmTools({ subscriptions: [] }, { tools: fakeTools().tools, vscode: vs, contribution, log: (m) => logs.push(m) });
    expect(reg.registered).toEqual(['flutter_intercept_get_status']);
    expect(logs.some((l) => l.includes('flutter_intercept_bogus'))).toBe(true);
    expect(logs.some((l) => l.includes('flutter_intercept_add_mock'))).toBe(true);
  });

  it('matches the package.json languageModelTools contribution when present', async () => {
    let contribution: { name: string }[] | undefined;
    try {
      // Agent B's schema module (may not exist yet in this checkout).
      const mod = (await import('../../src/agent/schema' as string)) as { languageModelToolsContribution?: () => { name: string }[] };
      contribution = mod.languageModelToolsContribution?.();
    } catch {
      contribution = undefined;
    }
    if (!contribution) return; // nothing to compare against yet
    expect(contribution.map((c) => c.name).sort()).toEqual(ALL_TOOLS.map(lmToolName).sort());
  });
});

describe('invoke', () => {
  it('calls AgentTools with the input and returns a LanguageModelToolResult with JSON text', async () => {
    const { vs, tools } = fakeVscode();
    const { tools: agent, calls } = fakeTools();
    registerLmTools({ subscriptions: [] }, { tools: agent, vscode: vs });
    const res = (await tools.get('flutter_intercept_list_requests')!.invoke({ input: { url: '*/login', limit: 5 } }, token())) as ToolResult;
    expect(calls[0]).toMatchObject({ tool: 'list_requests', input: { url: '*/login', limit: 5 } });
    expect(calls[0].signal).toBeInstanceOf(AbortSignal);
    expect(res).toBeInstanceOf(ToolResult);
    const part = res.content[0] as TextPart;
    expect(part).toBeInstanceOf(TextPart);
    expect(JSON.parse(part.value)).toEqual({ ok: true, tool: 'list_requests' });
  });

  it('cancellation aborts the signal passed to the tool', async () => {
    const { vs, tools } = fakeVscode();
    let seen: AbortSignal | undefined;
    const { tools: agent } = fakeTools('readWrite', (_t, _i, s) => {
      seen = s;
      return new Promise((resolve) => s!.addEventListener('abort', () => resolve({ timedOut: true })));
    });
    registerLmTools({ subscriptions: [] }, { tools: agent, vscode: vs });
    const tok = token();
    const p = tools.get('flutter_intercept_wait_for_request')!.invoke({ input: { url: '*' } }, tok);
    tok.fire();
    await p;
    expect(seen!.aborted).toBe(true);
  });

  it('turns AgentToolError (and anything else) into an Error with code and message', async () => {
    const { vs, tools } = fakeVscode();
    const { tools: agent } = fakeTools('readOnly', async (t) => {
      if (t === 'add_mock') throw new AgentToolError('write tools are disabled (readOnly)', 'access');
      throw 'weird';
    });
    registerLmTools({ subscriptions: [] }, { tools: agent, vscode: vs });
    await expect(tools.get('flutter_intercept_add_mock')!.invoke({ input: { url: 'x', body: '' } }, token())).rejects.toThrow('access: write tools are disabled (readOnly)');
    await expect(tools.get('flutter_intercept_get_status')!.invoke({ input: {} }, token())).rejects.toThrow('internal: weird');
  });

  it('refuses everything when access is off', async () => {
    const { vs, tools } = fakeVscode();
    const { tools: agent, calls } = fakeTools('off');
    registerLmTools({ subscriptions: [] }, { tools: agent, vscode: vs });
    await expect(tools.get('flutter_intercept_get_status')!.invoke({ input: {} }, token())).rejects.toThrow(/access: .*off/);
    expect(calls).toEqual([]);
  });
});

describe('prepareInvocation', () => {
  it('read tools get a contextual invocation message and no confirmation', async () => {
    const { vs, tools } = fakeVscode();
    registerLmTools({ subscriptions: [] }, { tools: fakeTools().tools, vscode: vs });
    const p = await tools.get('flutter_intercept_wait_for_request')!.prepareInvocation({ input: { url: '*/login', method: 'get', timeoutMs: 10_000 } }, token());
    expect(p).toEqual({ invocationMessage: 'Waiting for GET */login (up to 10 s)' });
  });

  it('every write tool asks for confirmation describing the change', async () => {
    const { vs, tools } = fakeVscode();
    registerLmTools({ subscriptions: [] }, { tools: fakeTools().tools, vscode: vs });
    for (const t of WRITE_TOOLS) {
      const p = await tools.get(lmToolName(t))!.prepareInvocation({ input: { url: 'https://api.example.com/login', ruleId: 'r1', id: 'x1' } }, token());
      expect(p?.confirmationMessages?.title, t).toBeTruthy();
      expect(p?.confirmationMessages?.message, t).toBeInstanceOf(Markdown);
    }
    const mock = await tools.get('flutter_intercept_add_mock')!.prepareInvocation(
      { input: { url: 'https://api.example.com/login', method: 'post', status: 500, body: { error: 'x' }, name: 'login 500' } },
      token(),
    );
    expect((mock!.confirmationMessages!.message as Markdown).value).toContain('Mock POST `https://api.example.com/login` → **500**');
    expect((mock!.confirmationMessages!.message as Markdown).value).toContain('`[agent] login 500`');
    const rm = await tools.get('flutter_intercept_remove_rule')!.prepareInvocation({ input: { ruleId: 'r1' } }, token());
    expect((rm!.confirmationMessages!.message as Markdown).value).toBe('Remove rule `r1` (`[agent] login 500`).');
  });

  it('resend_request confirmation names the exact method + origin + path (REVIEW-3 #1)', async () => {
    const { vs, tools } = fakeVscode();
    const ft = fakeTools('readWrite', async (t, i) => (t === 'get_request' ? { id: i.id, method: 'POST', url: 'https://api.example.com/v1/login?token=[redacted]' } : {}));
    registerLmTools({ subscriptions: [] }, { tools: ft.tools, vscode: vs });
    const p = await tools.get('flutter_intercept_resend_request')!.prepareInvocation({ input: { id: 'e7' } }, token());
    expect((p!.confirmationMessages!.message as Markdown).value).toBe(
      "Send **POST** `https://api.example.com/v1/login` (recorded request `e7`) again to the real server, with the original request's credentials.",
    );
    expect(ft.calls[0]).toMatchObject({ tool: 'get_request', input: { id: 'e7', includeBodies: false } });
  });

  it('no confirmation under readOnly (the call is refused anyway)', async () => {
    const { vs, tools } = fakeVscode();
    registerLmTools({ subscriptions: [] }, { tools: fakeTools('readOnly').tools, vscode: vs });
    const p = await tools.get('flutter_intercept_add_block')!.prepareInvocation({ input: { url: 'x' } }, token());
    expect(p?.confirmationMessages).toBeUndefined();
  });
});

describe('texts', () => {
  it('cover every tool and escape markdown breakouts', () => {
    for (const t of ALL_TOOLS) expect(invocationMessage(t, {}).length, t).toBeGreaterThan(5);
    const c = confirmationText('add_block', { url: 'a`b\nc', mode: 'reset' });
    expect(c.message).toContain('`a b c`');
    expect(c.message).toContain('connection is reset');
    expect(confirmationText('resume_request', { id: 'e1', edit: { status: 503, body: 'xx' } }).message).toBe(
      'Resume paused request `e1` with edits: status **503**, body (2 chars).',
    );
    expect(confirmationText('stop_app', {}).message).toContain('**every**');
    expect(confirmationText('launch_app', { deviceId: 'emulator-5554', flutterMode: 'profile' }).message).toContain('`emulator-5554` in **profile** mode');
    // CONTRACTS §9.5
    expect(confirmationText('simulate_network', { profile: 'slow-3g' }).message).toBe("Set **all** of the app's traffic to **Slow 3G** (+400 ms, 400 kbps) until changed.");
    expect(confirmationText('simulate_network', { url: '*/login', method: 'post', fault: 'timeout', times: 1 }).message).toBe(
      'Give POST `*/login` a timeout (no answer) (only the next matching request; then removed automatically). Inserted as the first rule.',
    );
    expect(confirmationText('add_mock', { url: '*/a', body: 'x', times: 2, ttlMs: 30_000 }).message).toContain('(the next 2 matching requests, for 30 s; then removed automatically)');
    const req = { method: 'GET', url: 'https://api.example.com/v1/users/1?token=[redacted]' };
    expect(confirmationText('resend_request', { id: 'e1', edit: { method: 'put', body: 'xx' } }, undefined, req).message).toBe(
      "Send **PUT** `https://api.example.com/v1/users/1` (recorded request `e1`) again to the real server, with the original request's credentials. Also edited: body (2 chars).",
    );
    expect(confirmationText('resend_request', { id: 'e1', edit: { url: 'https://evil.example/x' } }, undefined, req).message).toContain(
      'This changes the origin from `https://api.example.com`, so the call will be refused.',
    );
    expect(confirmationText('resend_request', { id: 'e1' }).message).toContain('was not found');
    expect(invocationMessage('get_body_shape', { id: 'e1' })).toBe('Reading the response body structure of e1');    // CONTRACTS §10.6
    expect(
      confirmationText('add_mutation', { url: '*/users/*', method: 'get', ops: [{ path: '$.avatar_url', op: 'null' }, { path: '$.id', op: 'set', value: '42' }, { path: '$.x`y', op: 'delete' }], times: 1 }).message,
    ).toBe(
      'For GET `*/users/*`: forward to the real server, then set `$.avatar_url` to **null**, set `$.id` to `"42"`, **remove** `$.x y` in the JSON response before the app gets it (only the next matching request; then removed automatically).\n\nInserted as the first rule.',
    );
    expect(invocationMessage('assert_traffic', { url: '*/a', method: 'post', withinMs: 5000 })).toBe('Checking traffic for POST */a (waiting up to 5 s)');
    expect(invocationMessage('check_contract', { id: 'e1' })).toBe('Checking request e1 against the Dart models');
    expect(invocationMessage('generate_fixture_test', { ids: ['a', 'b'] })).toBe('Generating a fixture test from 2 request(s)');
  });

  it('formatResult is pretty when small and compact when large', () => {
    expect(formatResult({ a: 1 })).toBe('{\n  "a": 1\n}');
    const big = { items: Array.from({ length: 300 }, (_, i) => ({ id: i, url: 'https://example.com/' + i })) };
    expect(formatResult(big)).not.toContain('\n');
  });
});

describe('take_screenshot (CONTRACTS §13.8): a read tool confirmed every time', () => {
  const statusAndShot = (sessions: unknown[]) => async (t: ToolName): Promise<Record<string, unknown>> => {
    if (t === 'get_status') return { sessions };
    if (t === 'take_screenshot') {
      const r: Record<string | symbol, unknown> = { path: '/p/s.png', method: 'adb' };
      Object.defineProperty(r, TOOL_IMAGES, { value: [{ data: Buffer.from('PNGDATA').toString('base64'), mimeType: 'image/png' }], enumerable: false });
      return r as Record<string, unknown>;
    }
    return {};
  };

  it.each<AgentAccess>(['readWrite', 'readOnly'])('asks "Take a screenshot of <device>?" under %s access', async (access) => {
    const { vs, tools } = fakeVscode();
    registerLmTools({ subscriptions: [] }, { tools: fakeTools(access, statusAndShot([{ id: 's1', deviceId: 'emulator-5554' }])).tools, vscode: vs });
    const p = await tools.get('flutter_intercept_take_screenshot')!.prepareInvocation({ input: {} }, token());
    expect(p?.confirmationMessages?.title).toBe('Take a screenshot');
    expect((p!.confirmationMessages!.message as Markdown).value).toMatch(/^Take a screenshot of `emulator-5554`\?/);
    expect(p?.invocationMessage).toBe('Taking a screenshot of the running app');
  });

  it('names the chosen session, or falls back when the device is unknown; no confirmation when access is off', async () => {
    const { vs, tools } = fakeVscode();
    const sessions = [{ id: 's1', deviceId: 'emulator-5554' }, { id: 's2', deviceId: 'iPhone `15`' }];
    registerLmTools({ subscriptions: [] }, { tools: fakeTools('readOnly', statusAndShot(sessions)).tools, vscode: vs });
    const p = await tools.get('flutter_intercept_take_screenshot')!.prepareInvocation({ input: { sessionId: 's2' } }, token());
    expect((p!.confirmationMessages!.message as Markdown).value).toMatch(/^Take a screenshot of `iPhone  15 `\?/); // backticks can't break out
    const q = await tools.get('flutter_intercept_take_screenshot')!.prepareInvocation({ input: {} }, token());
    expect((q!.confirmationMessages!.message as Markdown).value).toMatch(/^Take a screenshot of the running app\?/);
    const off = fakeVscode();
    registerLmTools({ subscriptions: [] }, { tools: fakeTools('off').tools, vscode: off.vs });
    expect(await off.tools.get('flutter_intercept_take_screenshot')!.prepareInvocation({ input: {} }, token())).toEqual({ invocationMessage: 'Taking a screenshot of the running app' });
  });

  it('invoke returns the image as a data part when the host supports it, then the JSON', async () => {
    class DataPart {
      constructor(readonly data: Uint8Array, readonly mimeType: string) {}
      static image(data: Uint8Array, mime: string) {
        return new DataPart(data, mime);
      }
    }
    const { vs, tools } = fakeVscode();
    vs.LanguageModelDataPart = DataPart as unknown as LmVscode['LanguageModelDataPart'];
    registerLmTools({ subscriptions: [] }, { tools: fakeTools('readOnly', statusAndShot([])).tools, vscode: vs });
    const res = (await tools.get('flutter_intercept_take_screenshot')!.invoke({ input: {} }, token())) as ToolResult;
    expect(res.content[0]).toBeInstanceOf(DataPart);
    expect(Buffer.from((res.content[0] as DataPart).data).toString()).toBe('PNGDATA');
    expect((res.content[0] as DataPart).mimeType).toBe('image/png');
    expect(JSON.parse((res.content[1] as TextPart).value)).toEqual({ path: '/p/s.png', method: 'adb' });
    // Older hosts: text only.
    const old = fakeVscode();
    registerLmTools({ subscriptions: [] }, { tools: fakeTools('readOnly', statusAndShot([])).tools, vscode: old.vs });
    const r2 = (await old.tools.get('flutter_intercept_take_screenshot')!.invoke({ input: {} }, token())) as ToolResult;
    expect(r2.content).toHaveLength(1);
    expect(r2.content[0]).toBeInstanceOf(TextPart);
  });

  it('export tools have messages and no confirmation', async () => {
    expect(invocationMessage('export_openapi', { url: '*/v1/*' })).toBe('Exporting captured traffic as OpenAPI (*/v1/*)');
    expect(invocationMessage('export_postman', {})).toBe('Exporting captured traffic as a Postman collection');
    const { vs, tools } = fakeVscode();
    registerLmTools({ subscriptions: [] }, { tools: fakeTools().tools, vscode: vs });
    expect((await tools.get('flutter_intercept_export_openapi')!.prepareInvocation({ input: {} }, token()))?.confirmationMessages).toBeUndefined();
  });
});
