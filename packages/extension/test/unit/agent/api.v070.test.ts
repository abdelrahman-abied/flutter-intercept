// CONTRACTS §13 (v0.7.0) agent side: timings + redacted scriptLog in get_request, list_requests slowerThanMs, script
// rules shown without code and never created by agents, export_openapi / export_postman (safe dir, redaction per
// setting), take_screenshot (setting, access, session choice, recent requests, image part), HAR timings.
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { EventEmitter } from 'events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Exchange, Rule } from '@flutter-intercept/proxy';
import { createAgentApi, SCREENSHOT_RECENT_MAX, type AgentApiDeps } from '../../../src/agent/api';
import { buildHar, harTimings } from '../../../src/agent/har';
import { parseToolInput } from '../../../src/agent/schema';
import { AgentToolError, CONFIRMED_READ_TOOLS, needsConfirmation, READ_TOOLS, toolImages, type AgentAccess, type AppLauncher } from '../../../src/agent/types';
import type { ExportOptions, ExportResult } from '../../../src/export/types';
import type { Screenshot, ScreenshotTarget } from '../../../src/screenshot/types';
import { validateRules } from '../../../src/ui/controller';

class FakeHost extends EventEmitter {
  running = true;
  port: number | undefined = 8899;
  exchanges: Exchange[] = [];
  rules: Rule[] = [];
  getExchanges() {
    return this.exchanges.map((e) => ({ ...e }));
  }
  getRules() {
    return this.rules;
  }
  resume() {}
  abort() {}
}

let seq = 0;
const ex = (over: Partial<Exchange> = {}): Exchange => ({
  id: `x${++seq}`,
  startedAt: 1000 + seq,
  method: 'GET',
  url: `https://api.example.com/v1/users/${seq}?token=SECRET_Q`,
  requestHeaders: { authorization: 'Bearer SECRET_H' },
  state: 'completed',
  status: 200,
  durationMs: 40,
  responseHeaders: { 'content-type': 'application/json' },
  responseBody: { text: '{"id":1}', encoding: 'utf8' },
  ...over,
});

const tmpDirs: string[] = [];
afterEach(() => {
  for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});
function tmpProject(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'fi-v070-'));
  tmpDirs.push(d);
  return d;
}

type Sessions = ReturnType<AppLauncher['sessions']>;

function setup(
  opts: {
    access?: AgentAccess;
    redact?: boolean;
    screenshots?: boolean;
    root?: string;
    sessions?: Sessions;
    exporters?: AgentApiDeps['exporters'];
    takeScreenshot?: AgentApiDeps['takeScreenshot'];
    now?: number;
  } = {},
) {
  const host = new FakeHost();
  const launcher = { launch: vi.fn(), stop: vi.fn(), hotRestart: vi.fn(), sessions: () => opts.sessions ?? [] } as unknown as AppLauncher;
  let idn = 0;
  const deps: AgentApiDeps = {
    host: host as unknown as AgentApiDeps['host'],
    applyRules: (rules) => {
      host.rules = validateRules(rules);
    },
    clear: () => undefined,
    getSettings: () => ({ access: opts.access ?? 'readWrite', redactSecrets: opts.redact ?? true, interceptEnabled: true, ...(opts.screenshots !== undefined ? { screenshots: opts.screenshots } : {}) }),
    launcher,
    projectRoot: () => opts.root ?? '/ws/app',
    appPackageName: () => 'demo_app',
    newRuleId: () => `agent_${++idn}`,
    now: () => opts.now ?? 50_000,
    ...(opts.exporters ? { exporters: opts.exporters } : {}),
    ...(opts.takeScreenshot ? { takeScreenshot: opts.takeScreenshot } : {}),
  };
  return { api: createAgentApi(deps), host };
}

const rejectsWith = async (p: Promise<unknown>, re: RegExp, code?: AgentToolError['code']) => {
  const e = await p.then(
    () => undefined,
    (err: unknown) => err,
  );
  expect(e).toBeInstanceOf(AgentToolError);
  expect((e as Error).message).toMatch(re);
  if (code) expect((e as AgentToolError).code).toBe(code);
};

describe('get_request: timings and scriptLog (CONTRACTS §13.2 / §13.4)', () => {
  const timings = { requestMs: 2, dnsMs: 5, connectMs: 7, tlsMs: 11, sendMs: 1, waitMs: 30, receiveMs: 4 };
  const log = ['token=SECRET_L seen', 'calling https://api.example.com/x?access_token=SECRET_U', 'Authorization: Bearer abc.def.ghi', 'user password: SECRET_P, ok', 'sent with Bearer SECRET_B', '{"session":"SECRET_J","n":1}'];

  it('includes timings as recorded and the script log redacted', async () => {
    const { api, host } = setup();
    host.exchanges = [ex({ id: 'a', timings, scriptLog: log })];
    const r = (await api.call('get_request', { id: 'a' })) as Record<string, unknown>;
    expect(r.timings).toEqual(timings);
    const lines = r.scriptLog as string[];
    expect(lines).toHaveLength(6);
    expect(JSON.stringify(lines)).not.toMatch(/SECRET_|abc\.def\.ghi/);
    expect(lines[3]).toBe('user password: [redacted], ok');
    expect(lines[5]).toBe('{"session":"[redacted]","n":1}');
    // wait_for_request returns the same detail view.
    const w = (await api.call('wait_for_request', { url: '*', sinceMs: 0, timeoutMs: 0 })) as Record<string, unknown>;
    expect(w.timings).toEqual(timings);
  });

  it('keeps the script log as is with redaction off; omits absent fields', async () => {
    const { api, host } = setup({ redact: false });
    host.exchanges = [ex({ id: 'a', scriptLog: log }), ex({ id: 'b' })];
    expect(((await api.call('get_request', { id: 'a' })) as { scriptLog: string[] }).scriptLog).toEqual(log);
    const b = (await api.call('get_request', { id: 'b' })) as Record<string, unknown>;
    expect(b).not.toHaveProperty('timings');
    expect(b).not.toHaveProperty('scriptLog');
  });
});

describe('list_requests slowerThanMs (CONTRACTS §13.2)', () => {
  it('keeps only finished requests that took longer, newest first', async () => {
    const { api, host } = setup();
    host.exchanges = [ex({ id: 'fast', durationMs: 50 }), ex({ id: 'edge', durationMs: 300 }), ex({ id: 'slow', durationMs: 301 }), ex({ id: 'open', durationMs: undefined, state: 'pending' })];
    const r = (await api.call('list_requests', { slowerThanMs: 300 })) as { items: { id: string }[]; total: number };
    expect(r.items.map((i) => i.id)).toEqual(['slow']);
    expect(r.total).toBe(1);
    expect(((await api.call('list_requests', { slowerThanMs: 0 })) as { total: number }).total).toBe(3);
    expect(() => parseToolInput('list_requests', { slowerThanMs: -1 })).toThrow(/slowerThanMs/);
    expect(() => parseToolInput('list_requests', { slowerThanMs: 1.5 })).toThrow(/slowerThanMs/);
  });
});

describe('script rules and agents (CONTRACTS §13.4)', () => {
  const script: Rule = { id: 'scr', enabled: true, name: 'Sign requests', match: { url: 'https://api.example.com/*' }, action: { kind: 'script', code: 'function onRequest(r){ r.headers["x-key"]="SECRET_CODE"; return r }', file: '.vscode/flutter-intercept/scripts/sign.js' } };
  const inline: Rule = { id: 'inl', enabled: true, match: { url: '*' }, action: { kind: 'script', code: 'function onResponse(r){ return r }' } };

  it.each([true, false])('list_rules shows {kind:"script", file?} without code (redaction %s)', async (redact) => {
    const { api, host } = setup({ redact });
    host.rules = [script, inline];
    const r = (await api.call('list_rules', {})) as { rules: Rule[] };
    expect(r.rules[0].action).toEqual({ kind: 'script', file: '.vscode/flutter-intercept/scripts/sign.js' });
    expect(r.rules[1].action).toEqual({ kind: 'script' });
    expect(JSON.stringify(r)).not.toMatch(/SECRET_CODE|onResponse|onRequest/);
    expect(r.rules[0].name).toBe('Sign requests');
  });

  it("adding an agent rule keeps the user's script rules (and their code) untouched", async () => {
    const { api, host } = setup();
    host.rules = [script];
    await api.call('add_block', { url: 'https://api.example.com/x' });
    expect(host.rules.map((r) => r.id)).toEqual(['agent_1', 'scr']);
    expect(host.rules[1].action).toEqual(script.action);
  });

  it('no tool schema accepts a script', () => {
    expect(() => parseToolInput('add_sequence', { url: '*', steps: [{ kind: 'script', code: 'x' }] })).toThrow();
    expect(() => parseToolInput('add_mock', { url: '*', body: 'x', kind: 'script' })).toThrow();
    expect(() => parseToolInput('add_rewrite', { url: 'https://a.dev/*', response: { script: 'x' } })).toThrow();
  });
});

describe('export_openapi / export_postman (CONTRACTS §13.8)', () => {
  function fakeExporters() {
    const calls: { format: string; ids: string[]; opts: ExportOptions }[] = [];
    const make =
      (format: string) =>
      (list: readonly Exchange[], opts: ExportOptions): ExportResult => {
        calls.push({ format, ids: list.map((e) => e.id), opts });
        return { text: JSON.stringify({ format, n: list.length }), exchanges: list.length, routes: 1, notes: ['1 WebSocket exchange skipped', 'see https://api.example.com/x?token=SECRET_N'] };
      };
    return { calls, exporters: { openapi: make('openapi'), postman: make('postman') } };
  }

  it('writes <ts>.openapi.json / .postman_collection.json under .dart_tool/flutter_intercept/exports, redacted per setting', async () => {
    const root = tmpProject();
    const { calls, exporters } = fakeExporters();
    const { api, host } = setup({ root, exporters });
    host.exchanges = [ex({ id: 'a' }), ex({ id: 'b', url: 'https://other.dev/x' }), ex({ id: 'c', browserInternal: true })];
    const r = (await api.call('export_openapi', { url: 'https://api.example.com/*' })) as Record<string, unknown>;
    expect(path.dirname(r.path as string)).toBe(path.join(root, '.dart_tool', 'flutter_intercept', 'exports'));
    expect(r.path as string).toMatch(/\.openapi\.json$/);
    expect(JSON.parse(fs.readFileSync(r.path as string, 'utf8'))).toEqual({ format: 'openapi', n: 1 });
    expect(r).toMatchObject({ exchanges: 1, routes: 1, redacted: true });
    expect(JSON.stringify(r.notes)).not.toContain('SECRET_N');
    expect(calls[0]).toEqual({ format: 'openapi', ids: ['a'], opts: { title: 'demo_app', redact: true } });

    const p = (await api.call('export_postman', { title: 'My API' })) as Record<string, unknown>;
    expect(p.path as string).toMatch(/\.postman_collection\.json$/);
    expect(calls[1]).toEqual({ format: 'postman', ids: ['a', 'b'], opts: { title: 'My API', redact: true } }); // browser-internal excluded
    // Same timestamp twice: never overwrites.
    const again = (await api.call('export_postman', {})) as Record<string, unknown>;
    expect(again.path).not.toBe(p.path);
  });

  it('redaction off → redact:false; read-only access may export; off may not', async () => {
    const root = tmpProject();
    const { calls, exporters } = fakeExporters();
    const { api, host } = setup({ root, exporters, redact: false, access: 'readOnly' });
    host.exchanges = [ex({ id: 'a' })];
    await api.call('export_openapi', {});
    expect(calls[0].opts.redact).toBe(false);
    const off = setup({ root, exporters, access: 'off' });
    await rejectsWith(off.api.call('export_openapi', {}), /access is off/, 'access');
  });

  it('refuses a symlinked exports folder (same safe-dir logic as export_har)', async () => {
    const root = tmpProject();
    const outside = tmpProject();
    fs.mkdirSync(path.join(root, '.dart_tool', 'flutter_intercept'), { recursive: true });
    fs.symlinkSync(outside, path.join(root, '.dart_tool', 'flutter_intercept', 'exports'));
    const { exporters } = fakeExporters();
    const { api, host } = setup({ root, exporters });
    host.exchanges = [ex({ id: 'a' })];
    await rejectsWith(api.call('export_openapi', {}), /symbolic link/);
    expect(fs.readdirSync(outside)).toEqual([]);
  });

  it('clear errors: no exporter, no project, nothing matched', async () => {
    const none = setup();
    none.host.exchanges = [ex()];
    await rejectsWith(none.api.call('export_openapi', {}), /not available/, 'state');
    const { exporters } = fakeExporters();
    const noRoot = setup({ exporters, root: '' });
    noRoot.host.exchanges = [ex()];
    await rejectsWith(noRoot.api.call('export_postman', {}), /no workspace folder/, 'state');
    const empty = setup({ exporters, root: tmpProject() });
    await rejectsWith(empty.api.call('export_openapi', { url: 'https://nothing.dev/*' }), /no finished HTTP request matches/, 'not_found');
  });

  it('schema: title bounds, strict', () => {
    expect(parseToolInput('export_openapi', {})).toEqual({});
    expect(parseToolInput('export_postman', { title: '  X  ' })).toEqual({ title: 'X' });
    expect(() => parseToolInput('export_openapi', { title: '' })).toThrow(/title/);
    expect(() => parseToolInput('export_openapi', { format: 'yaml' })).toThrow();
    expect(() => parseToolInput('export_postman', { url: '/re/' })).toThrow(/regex/);
  });
});

describe('take_screenshot (CONTRACTS §13.8)', () => {
  const png = Buffer.from('89504e470d0a1a0a00000000', 'hex');
  function shooter(over: Partial<Screenshot> = {}) {
    const targets: ScreenshotTarget[] = [];
    const take = async (t: ScreenshotTarget): Promise<Screenshot> => {
      targets.push(t);
      return { path: `${t.projectRoot}/.dart_tool/flutter_intercept/screenshots/s.png`, png, width: 1080, height: 2400, takenAt: 50_000, method: 'adb', ...over };
    };
    return { targets, take };
  }
  const one: Sessions = [{ id: 's1', deviceId: 'emulator-5554', program: 'lib/main.dart', mode: 'debug' }];

  it('is a read tool that needs confirmation', () => {
    expect(READ_TOOLS).toContain('take_screenshot');
    expect(CONFIRMED_READ_TOOLS).toEqual(['take_screenshot']);
    expect(needsConfirmation('take_screenshot')).toBe(true);
    expect(needsConfirmation('list_requests')).toBe(false);
    expect(needsConfirmation('add_mock')).toBe(true);
  });

  it('captures the only session, returns the image part and the requests of the 5 s before (redacted, ≤ 10)', async () => {
    const s = shooter();
    const { api, host } = setup({ sessions: one, takeScreenshot: s.take, access: 'readOnly' });
    host.exchanges = [
      ex({ id: 'old', startedAt: 44_000 }),
      ...Array.from({ length: 12 }, (_, n) => ex({ id: `r${n}`, startedAt: 45_000 + n * 100 })),
      ex({ id: 'internal', startedAt: 49_000, browserInternal: true }),
      ex({ id: 'after', startedAt: 50_001 }),
    ];
    const r = (await api.call('take_screenshot', {})) as Record<string, unknown>;
    expect(s.targets).toEqual([{ sessionId: 's1', deviceId: 'emulator-5554', projectRoot: '/ws/app' }]);
    expect(r).toMatchObject({ path: '/ws/app/.dart_tool/flutter_intercept/screenshots/s.png', width: 1080, height: 2400, takenAt: 50_000, method: 'adb', bytes: png.length, sessionId: 's1', deviceId: 'emulator-5554' });
    const recent = r.recentRequests as { id: string; url: string }[];
    expect(recent).toHaveLength(SCREENSHOT_RECENT_MAX);
    expect(recent[0].id).toBe('r11'); // newest first
    expect(recent.map((x) => x.id)).not.toContain('old');
    expect(recent.map((x) => x.id)).not.toContain('internal');
    expect(recent.map((x) => x.id)).not.toContain('after');
    expect(JSON.stringify(r)).not.toContain('SECRET_Q');
    expect(toolImages(r)).toEqual([{ data: png.toString('base64'), mimeType: 'image/png' }]);
    // The image never ends up in the JSON (MCP structuredContent / LM text).
    expect(JSON.stringify(r)).not.toContain(png.toString('base64'));
    expect(Object.keys(r)).not.toContain('png');
  });

  it('refused when the setting is off or access is off; clear errors otherwise', async () => {
    const s = shooter();
    await rejectsWith(setup({ sessions: one, takeScreenshot: s.take, screenshots: false }).api.call('take_screenshot', {}), /flutterIntercept\.agent\.screenshots/, 'access');
    await rejectsWith(setup({ sessions: one, takeScreenshot: s.take, access: 'off' }).api.call('take_screenshot', {}), /access is off/, 'access');
    expect(s.targets).toEqual([]);
    await rejectsWith(setup({ sessions: one }).api.call('take_screenshot', {}), /not available/, 'state');
    await rejectsWith(setup({ takeScreenshot: s.take }).api.call('take_screenshot', {}), /launch_app/, 'state');
    const two: Sessions = [...one, { id: 's2', deviceId: 'macos', program: 'lib/main.dart', mode: 'debug' }];
    await rejectsWith(setup({ sessions: two, takeScreenshot: s.take }).api.call('take_screenshot', {}), /pass sessionId \(one of s1, s2\)/, 'invalid');
    await rejectsWith(setup({ sessions: two, takeScreenshot: s.take }).api.call('take_screenshot', { sessionId: 'nope' }), /no intercepted debug session "nope"/, 'not_found');
    await setup({ sessions: two, takeScreenshot: s.take }).api.call('take_screenshot', { sessionId: 's2' });
    expect(s.targets.at(-1)).toEqual({ sessionId: 's2', deviceId: 'macos', projectRoot: '/ws/app' });
  });

  it('an unsupported device is a readable tool error (redacted); a too large PNG is not sent inline', async () => {
    const failing = async (): Promise<Screenshot> => {
      throw new Error('screenshots are not supported on macos (see https://x.dev/?token=SECRET_E)');
    };
    await rejectsWith(setup({ sessions: one, takeScreenshot: failing }).api.call('take_screenshot', {}), /^take_screenshot: screenshots are not supported on macos(?!.*SECRET_E)/, 'state');
    const big = shooter({ png: Buffer.alloc(16 * 1024 * 1024 + 1) });
    const r = (await setup({ sessions: one, takeScreenshot: big.take }).api.call('take_screenshot', {})) as Record<string, unknown>;
    expect(toolImages(r)).toEqual([]);
    expect(r.note).toMatch(/too large/);
  });
});

describe('HAR timings (CONTRACTS §13.2)', () => {
  it('maps phases: blocked = request + paused + delay, connect includes TLS, -1 when unknown', () => {
    expect(harTimings({ timings: { requestMs: 2, pausedMs: 100, dnsMs: 5, connectMs: 7, tlsMs: 11, sendMs: 1, waitMs: 30, receiveMs: 4 }, durationMs: 160 })).toEqual({
      blocked: 102,
      dns: 5,
      connect: 18,
      ssl: 11,
      send: 1,
      wait: 30,
      receive: 4,
    });
    // Reused connection: dns / connect / ssl don't apply.
    expect(harTimings({ timings: { requestMs: 1, reused: true, sendMs: 0, waitMs: 20, receiveMs: 2 } })).toEqual({ blocked: 1, dns: -1, connect: -1, ssl: -1, send: 0, wait: 20, receive: 2 });
    // Mocked: only request + delay; plain http: connect without TLS.
    expect(harTimings({ timings: { requestMs: 1, delayMs: 500 } })).toEqual({ blocked: 501, dns: -1, connect: -1, ssl: -1, send: 0, wait: 0, receive: 0 });
    expect(harTimings({ timings: { connectMs: 3 } })).toMatchObject({ blocked: -1, connect: 3, ssl: -1 });
    // No timings (older data): the whole duration is wait.
    expect(harTimings({ durationMs: 42 })).toEqual({ send: 0, wait: 42, receive: 0 });
  });

  it('buildHar uses them and marks reused connections', () => {
    const har = buildHar([ex({ id: 'a', timings: { reused: true, waitMs: 9 } })], { redact: true }) as { log: { entries: Record<string, unknown>[] } };
    expect(har.log.entries[0].timings).toEqual({ blocked: -1, dns: -1, connect: -1, ssl: -1, send: 0, wait: 9, receive: 0 });
    expect(har.log.entries[0]._reusedConnection).toBe(true);
  });
});

describe('export with the real builders (src/export/**)', () => {
  it('OpenAPI and Postman files carry no secrets while redaction is on', async () => {
    const { toOpenApi } = await import('../../../src/export/openapi');
    const { toPostman } = await import('../../../src/export/postman');
    const root = tmpProject();
    const { api, host } = setup({ root, exporters: { openapi: toOpenApi, postman: toPostman } });
    host.exchanges = [
      ex({ id: 'a', requestHeaders: { authorization: 'Bearer SECRET_H', 'x-api-key': 'SECRET_K' }, responseBody: { text: '{"id":1,"password":"SECRET_P"}', encoding: 'utf8' } }),
      ex({ id: 'b', url: 'https://api.example.com/v1/users/2?token=SECRET_Q2' }),
    ];
    for (const tool of ['export_openapi', 'export_postman'] as const) {
      const r = (await api.call(tool, {})) as { path: string; exchanges: number; routes: number };
      const text = fs.readFileSync(r.path, 'utf8');
      expect(r.exchanges).toBe(2);
      expect(r.routes).toBe(1);
      expect(text).not.toMatch(/SECRET_/);
      expect(() => JSON.parse(text)).not.toThrow();
    }
  });
});
