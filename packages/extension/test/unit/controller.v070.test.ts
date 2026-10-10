// CONTRACTS §13 (v0.7.0) controller: script rule validation, export (redact-or-keep every time → save dialog →
// write → exported), openScriptFile, openInNewWindow, select.
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { EventEmitter } from 'events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Exchange, Rule } from '@flutter-intercept/proxy';
import type { ExportOptions, ExportResult } from '../../src/export/types';
import { ControllerDeps, ControllerHost, EXPORT_GIT_CONFIRM, EXPORT_GIT_WARNING, EXPORT_KEEP, EXPORT_REDACT, InterceptController, validateRule, validateRules } from '../../src/ui/controller';
import type { HostMsg } from '../../src/ui/protocol';

class FakeHost extends EventEmitter implements ControllerHost {
  running = true;
  port: number | undefined = 9123;
  exchanges: Exchange[] = [];
  rules: Rule[] = [];
  getExchanges() {
    return this.exchanges.map((e) => ({ ...e }));
  }
  getRules() {
    return this.rules;
  }
  setRules(r: Rule[]) {
    this.rules = r;
  }
  clear() {
    this.exchanges = [];
  }
  resume() {}
  abort() {}
  push(e: Exchange) {
    this.exchanges.push(e);
    this.emit('exchange', { ...e });
  }
}

const ex = (id: string, extra: Partial<Exchange> = {}): Exchange => ({
  id,
  startedAt: 1,
  method: 'GET',
  url: 'https://api.example.com/v1/users/1?token=SECRET_Q',
  requestHeaders: { authorization: 'Bearer SECRET_H' },
  state: 'completed',
  status: 200,
  durationMs: 12,
  timings: { requestMs: 1, waitMs: 10 },
  responseHeaders: { 'content-type': 'application/json' },
  responseBody: { text: '{"id":1}', encoding: 'utf8' },
  ...extra,
});

const controllers: InterceptController[] = [];
const tmp: string[] = [];
afterEach(() => {
  while (controllers.length) controllers.pop()!.dispose();
  for (const d of tmp.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

function setup(extra: Partial<ControllerDeps> = {}) {
  const host = new FakeHost();
  const saved: Rule[][] = [];
  const c = new InterceptController({ host, saveRules: (r) => saved.push(r), getEnabled: () => true, setEnabled: async () => undefined, throttleMs: 5, ...extra });
  controllers.push(c);
  const msgs: HostMsg[] = [];
  c.attach((m) => msgs.push(m));
  const replies: HostMsg[] = [];
  return { host, c, msgs, replies, reply: (m: HostMsg) => replies.push(m), saved };
}
const errors = (msgs: HostMsg[]) => msgs.filter((m): m is Extract<HostMsg, { type: 'error' }> => m.type === 'error').map((m) => m.message);

const base = { id: 'r1', enabled: true, match: { url: 'https://api.example.com/*' } };
const CODE = 'function onRequest(r, ctx) { ctx.log("hi"); return r }';

describe('validateRule: script (CONTRACTS §13.4)', () => {
  it('accepts inline code, and a .js file with empty code', () => {
    expect(validateRule({ ...base, action: { kind: 'script', code: CODE } }).action).toEqual({ kind: 'script', code: CODE });
    expect(validateRule({ ...base, action: { kind: 'script', code: '', file: '.vscode/flutter-intercept/scripts/a.js' } }).action).toEqual({
      kind: 'script',
      code: '',
      file: '.vscode/flutter-intercept/scripts/a.js',
    });
    expect(validateRule({ ...base, action: { kind: 'script', file: 'scripts/a.JS' } }).action).toEqual({ kind: 'script', code: '', file: 'scripts/a.JS' });
  });

  it.each<[unknown, RegExp]>([
    [{ kind: 'script' }, /code or a file/],
    [{ kind: 'script', code: '' }, /needs code/],
    [{ kind: 'script', code: 42 }, /code must be a string/],
    [{ kind: 'script', code: 'x'.repeat(256 * 1024 + 1) }, /256 KB/],
    [{ kind: 'script', code: CODE, file: 'a.ts' }, /\.js/],
    [{ kind: 'script', code: CODE, file: '/etc/x.js' }, /relative/],
    [{ kind: 'script', code: CODE, file: '../x.js' }, /inside the workspace/],
    [{ kind: 'script', code: CODE, bogus: 1 }, /unknown field "bogus"/],
  ])('refuses %j', (action, re) => {
    expect(() => validateRule({ ...base, action })).toThrow(re);
  });

  it('refuses scripts inside sequence steps and on WebSocket rules', () => {
    expect(() => validateRule({ ...base, action: { kind: 'sequence', steps: [{ action: { kind: 'script', code: CODE } }] } })).toThrow(/sequence step cannot be a script/);
    expect(() => validateRule({ ...base, match: { url: 'wss://ws.example.com/*' }, action: { kind: 'script', code: CODE } })).toThrow(/WebSocket/);
    expect(() => validateRule({ ...base, match: { url: 'wss://ws.example.com/*' }, action: { kind: 'script', code: '', file: 'a.js' } })).toThrow(/WebSocket/);
  });

  it('setRules round-trips script rules to the host', async () => {
    const { host, c, reply, msgs } = setup();
    await c.handle({ type: 'setRules', rules: [{ ...base, action: { kind: 'script', code: '', file: 'scripts/a.js' } }] }, reply);
    expect(errors(msgs)).toEqual([]);
    expect(host.rules[0].action).toEqual({ kind: 'script', code: '', file: 'scripts/a.js' });
    expect(validateRules(host.rules)).toEqual(host.rules);
  });
});

describe('export (CONTRACTS §13.5 / §13.7)', () => {
  function exporters() {
    const calls: { format: string; ids: string[]; opts: ExportOptions }[] = [];
    const make =
      (format: string, n?: number) =>
      (list: readonly Exchange[], opts: ExportOptions): ExportResult => {
        calls.push({ format, ids: list.map((e) => e.id), opts });
        return { text: `{"${format}":${list.length}}`, exchanges: n ?? list.length, routes: 1, notes: [] };
      };
    return { calls, ex: { openapi: make('openapi'), postman: make('postman') }, make };
  }
  function exportSetup(choice: string | undefined, file: string | undefined, extra: Partial<ControllerDeps> = {}) {
    const e = exporters();
    const picks: { items: string[]; placeHolder: string }[] = [];
    const dialogs: { defaultPath: string; format: string }[] = [];
    const writes: { file: string; text: string }[] = [];
    const s = setup({
      exporters: e.ex,
      pickOne: async (items, placeHolder) => (picks.push({ items, placeHolder }), choice),
      showSaveDialog: async (defaultPath, format) => (dialogs.push({ defaultPath, format }), file),
      writeFile: async (f, t) => void writes.push({ file: f, text: t }),
      projectRoot: () => '/ws/demo',
      appPackageName: () => 'demo_app',
      version: '0.7.0',
      ...extra,
    });
    s.host.exchanges = [ex('a'), ex('b'), ex('c', { browserInternal: true }), ex('open', { state: 'pending', status: undefined }), ex('ws', { kind: 'websocket', status: 101 })];
    return { ...s, ...e, picks, dialogs, writes };
  }

  it('asks redact-or-keep, offers <project>/<name>.openapi.json, writes, replies exported', async () => {
    const t = exportSetup(EXPORT_REDACT, '/ws/demo/api.openapi.json');
    await t.c.handle({ type: 'export', format: 'openapi' }, t.reply);
    expect(errors(t.replies)).toEqual([]);
    expect(t.picks[0].items).toEqual(['Redact secrets (recommended)', 'Keep values']);
    expect(t.calls[0]).toEqual({ format: 'openapi', ids: ['a', 'b'], opts: { title: 'demo_app', redact: true } });
    expect(t.dialogs[0]).toEqual({ defaultPath: path.join('/ws/demo', 'demo_app.openapi.json'), format: 'openapi' });
    expect(t.writes).toEqual([{ file: '/ws/demo/api.openapi.json', text: '{"openapi":2}' }]);
    expect(t.replies).toContainEqual({ type: 'exported', format: 'openapi', path: '/ws/demo/api.openapi.json' });
    expect(t.msgs.filter((m) => m.type === 'exported')).toEqual([]); // only the asking view
  });

  it('"Keep values" exports unredacted; ids pick the exchanges; postman default name', async () => {
    const t = exportSetup(EXPORT_KEEP, '/tmp/x.json');
    await t.c.handle({ type: 'export', format: 'postman', ids: ['b', 'c'] }, t.reply);
    expect(t.calls[0]).toEqual({ format: 'postman', ids: ['b', 'c'], opts: { title: 'demo_app', redact: false } });
    expect(t.dialogs[0].defaultPath).toBe(path.join('/ws/demo', 'demo_app.postman_collection.json'));
  });

  it('HAR is built here, redacted on request, with timings', async () => {
    const t = exportSetup(EXPORT_REDACT, '/ws/demo/t.har');
    await t.c.handle({ type: 'export', format: 'har' }, t.reply);
    const har = JSON.parse(t.writes[0].text) as { log: { creator: { version: string }; entries: { timings: Record<string, number>; request: { url: string } }[] } };
    expect(har.log.entries).toHaveLength(3); // a, b and the finished WebSocket (frames); not the open one
    expect(har.log.creator.version).toBe('0.7.0');
    expect(har.log.entries[0].timings).toMatchObject({ blocked: 1, wait: 10 });
    expect(t.writes[0].text).not.toMatch(/SECRET_Q|SECRET_H/);
    expect(t.dialogs[0].defaultPath).toBe(path.join('/ws/demo', 'demo_app.har'));
    const keep = exportSetup(EXPORT_KEEP, '/ws/demo/t.har');
    await keep.c.handle({ type: 'export', format: 'har' }, keep.reply);
    expect(keep.writes[0].text).toContain('SECRET_H');
  });

  it('asks every time; cancelling either step writes nothing and sends nothing', async () => {
    const t = exportSetup(undefined, '/x.json');
    await t.c.handle({ type: 'export', format: 'openapi' }, t.reply);
    await t.c.handle({ type: 'export', format: 'openapi' }, t.reply);
    expect(t.picks).toHaveLength(2);
    expect(t.dialogs).toEqual([]);
    const u = exportSetup(EXPORT_REDACT, undefined);
    await u.c.handle({ type: 'export', format: 'openapi' }, u.reply);
    expect(u.writes).toEqual([]);
    expect(u.replies).toEqual([]);
  });

  it('readable errors: bad format/ids, nothing to export, no exporter, no dialog', async () => {
    const t = exportSetup(EXPORT_REDACT, '/x.json');
    await t.c.handle({ type: 'export', format: 'yaml' }, t.reply);
    await t.c.handle({ type: 'export', format: 'openapi', ids: [1] }, t.reply);
    await t.c.handle({ type: 'export', format: 'openapi', ids: ['zzz'] }, t.reply);
    expect(errors(t.replies)).toEqual([expect.stringMatching(/unknown format/), expect.stringMatching(/ids must be/), expect.stringMatching(/no recorded traffic/)]);
    const none = exportSetup(EXPORT_REDACT, '/x.json', { exporters: { openapi: exporters().make('openapi', 0) } });
    await none.c.handle({ type: 'export', format: 'openapi' }, none.reply);
    expect(errors(none.replies)[0]).toMatch(/Nothing to export/);
    await none.c.handle({ type: 'export', format: 'postman' }, none.reply);
    expect(errors(none.replies)[1]).toMatch(/Postman export is not available/);
    const bare = setup();
    bare.host.exchanges = [ex('a')];
    await bare.c.handle({ type: 'export', format: 'har' }, bare.reply);
    expect(errors(bare.replies)[0]).toMatch(/not available in this editor/);
  });

  it('writes with fs by default (the command path: exportTraffic resolves the file)', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fi-exp-'));
    tmp.push(dir);
    const file = path.join(dir, 'out.har');
    const t = exportSetup(EXPORT_REDACT, file, { writeFile: undefined });
    await expect(t.c.exportTraffic('har')).resolves.toBe(file);
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).log.entries).toHaveLength(3);
  });
});

describe('openScriptFile / openInNewWindow / select (CONTRACTS §13.6 / §13.7)', () => {
  it('opens .js files inside the workspace; empty create content = the template naming the rule', async () => {
    const opened: unknown[][] = [];
    const t = setup({ openScriptFile: async (p, create) => void opened.push([p, create]) });
    t.host.rules = [{ ...base, name: 'Sign requests', action: { kind: 'script', code: '', file: 'scripts/sign.js' } }];
    await t.c.handle({ type: 'openScriptFile', path: 'scripts/sign.js' }, t.reply);
    await t.c.handle({ type: 'openScriptFile', path: 'scripts/sign.js', create: { content: '' } }, t.reply);
    await t.c.handle({ type: 'openScriptFile', path: 'scripts/b.js', create: { content: CODE } }, t.reply);
    expect(errors(t.replies)).toEqual([]);
    expect(opened[0]).toEqual(['scripts/sign.js', undefined]);
    expect((opened[1][1] as { content: string }).content).toMatch(/Flutter Intercept script for the rule "Sign requests"/);
    expect(opened[2]).toEqual(['scripts/b.js', { content: CODE }]);
  });

  it.each<[unknown, RegExp]>([
    [{ path: 'scripts/a.ts' }, /\.js/],
    [{ path: '../a.js' }, /inside the workspace/],
    [{ path: '/abs/a.js' }, /relative/],
    [{ path: 'a.js', create: 'x' }, /create must be an object/],
    [{ path: 'a.js', create: { content: 1 } }, /create\.content must be a string/],
    [{ path: 'a.js', create: { content: 'x'.repeat(256 * 1024 + 1) } }, /256 KB/],
    [{ path: 'a.js', create: { content: '', extra: 1 } }, /unknown field/],
  ])('openScriptFile refuses %j', async (msg, re) => {
    const open = vi.fn();
    const t = setup({ openScriptFile: open });
    await t.c.handle({ type: 'openScriptFile', ...(msg as object) }, t.reply);
    expect(errors(t.replies)[0]).toMatch(re);
    expect(open).not.toHaveBeenCalled();
  });

  it('without the deps: readable errors', async () => {
    const t = setup();
    await t.c.handle({ type: 'openScriptFile', path: 'a.js' }, t.reply);
    await t.c.handle({ type: 'openInNewWindow' }, t.reply);
    expect(errors(t.replies)).toEqual([expect.stringMatching(/script files is not available/), expect.stringMatching(/new window is not available/)]);
  });

  it('openInNewWindow calls the injected dep', async () => {
    const open = vi.fn(async () => undefined);
    const t = setup({ openInNewWindow: open });
    await t.c.handle({ type: 'openInNewWindow' }, t.reply);
    expect(open).toHaveBeenCalledTimes(1);
    expect(errors(t.replies)).toEqual([]);
  });

  it('select(id) flushes pending updates, then posts select to every view', () => {
    const t = setup();
    const other: HostMsg[] = [];
    t.c.attach((m) => other.push(m));
    t.host.push(ex('n1'));
    t.c.select('n1');
    const types = t.msgs.map((m) => m.type);
    expect(types.indexOf('exchange')).toBeLessThan(types.indexOf('select'));
    expect(t.msgs.at(-1)).toEqual({ type: 'select', id: 'n1' });
    expect(other.at(-1)).toEqual({ type: 'select', id: 'n1' });
    t.c.select('');
    expect(t.msgs.filter((m) => m.type === 'select')).toHaveLength(1);
  });
});

describe('REVIEW-7 #9: exports that keep live values', () => {
  const tmpRoot = () => {
    const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fi-keep-')));
    tmp.push(d);
    return d;
  };
  function keepSetup(root: string, choice: string, pickFile: (defaultPath: string) => string | undefined, extra: Partial<ControllerDeps> = {}) {
    const dialogs: string[] = [];
    const warnings: string[] = [];
    const s = setup({
      pickOne: async () => choice,
      showSaveDialog: async (d) => (dialogs.push(d), pickFile(d)),
      projectRoot: () => root,
      appPackageName: () => 'demo_app',
      confirmWarning: async (m, b) => (warnings.push(`${m}|${b}`), false),
      ...extra,
    });
    s.host.exchanges = [ex('a')];
    return { ...s, dialogs, warnings };
  }

  it('"Keep values" defaults to .dart_tool/flutter_intercept/exports/ (created) and writes 0600; redacted keeps the project folder', async () => {
    const root = tmpRoot();
    const k = keepSetup(root, EXPORT_KEEP, (d) => d);
    const file = await k.c.exportTraffic('har');
    expect(k.dialogs[0]).toBe(path.join(root, '.dart_tool', 'flutter_intercept', 'exports', 'demo_app.har'));
    expect(file).toBe(k.dialogs[0]);
    expect(fs.statSync(file!).mode & 0o777).toBe(0o600);
    expect(fs.readFileSync(file!, 'utf8')).toContain('SECRET_H');
    // An existing file chosen again stays 0600.
    fs.chmodSync(file!, 0o644);
    await k.c.exportTraffic('har');
    expect(fs.statSync(file!).mode & 0o777).toBe(0o600);
    const r = keepSetup(root, EXPORT_REDACT, (d) => d);
    await r.c.exportTraffic('har');
    expect(r.dialogs[0]).toBe(path.join(root, 'demo_app.har'));
  });

  it('asks before saving live values where git would commit them; declining writes nothing', async () => {
    const root = tmpRoot();
    fs.mkdirSync(path.join(root, '.git'));
    const target = path.join(root, 'leak.har');
    const k = keepSetup(root, EXPORT_KEEP, () => target);
    await k.c.handle({ type: 'export', format: 'har' }, k.reply);
    expect(k.warnings).toEqual([`${EXPORT_GIT_WARNING}|${EXPORT_GIT_CONFIRM}`]);
    expect(fs.existsSync(target)).toBe(false);
    expect(k.replies).toEqual([]);
    const yes = keepSetup(root, EXPORT_KEEP, () => target, { confirmWarning: async () => true });
    await yes.c.handle({ type: 'export', format: 'har' }, yes.reply);
    expect(fs.existsSync(target)).toBe(true);
    expect(yes.replies).toContainEqual({ type: 'exported', format: 'har', path: target });
    // Without a way to ask: refused with a readable error.
    fs.rmSync(target);
    const none = keepSetup(root, EXPORT_KEEP, () => target, { confirmWarning: undefined });
    await none.c.handle({ type: 'export', format: 'har' }, none.reply);
    expect(errors(none.replies)[0]).toMatch(/would be committed with live credentials/);
    expect(fs.existsSync(target)).toBe(false);
  });

  it('no question for ignored paths, the default exports folder, or redacted exports', async () => {
    const root = tmpRoot();
    fs.mkdirSync(path.join(root, '.git'));
    fs.writeFileSync(path.join(root, '.gitignore'), '*.har\n.dart_tool/\n');
    const k = keepSetup(root, EXPORT_KEEP, () => path.join(root, 'ok.har'));
    await k.c.exportTraffic('har');
    const d = keepSetup(root, EXPORT_KEEP, (p) => p);
    await d.c.exportTraffic('har');
    fs.writeFileSync(path.join(root, '.gitignore'), '');
    const r = keepSetup(root, EXPORT_REDACT, () => path.join(root, 'red.har'));
    await r.c.exportTraffic('har');
    expect([...k.warnings, ...d.warnings, ...r.warnings]).toEqual([]);
    expect(fs.existsSync(path.join(root, 'red.har'))).toBe(true);
  });
});

describe('REVIEW-7 #6 / #1: ruleId on openBodyFile / openScriptFile', () => {
  it('validates ruleId and passes it on; the template names the rule with that id', async () => {
    const calls: unknown[][] = [];
    const t = setup({ openBodyFile: async (...a) => void calls.push(['body', ...a]), openScriptFile: async (...a) => void calls.push(['script', ...a]) });
    t.host.rules = [{ ...base, id: 'shared-1', name: 'Team signer', action: { kind: 'script', code: '', file: 'scripts/s.js' } }];
    await t.c.handle({ type: 'openBodyFile', path: 'mocks/a.json', ruleId: 'r9' }, t.reply);
    await t.c.handle({ type: 'openScriptFile', path: 'scripts/s.js', create: { content: '' }, ruleId: 'shared-1' }, t.reply);
    await t.c.handle({ type: 'openScriptFile', path: 'scripts/s.js' }, t.reply);
    expect(errors(t.replies)).toEqual([]);
    expect(calls[0]).toEqual(['body', 'mocks/a.json', undefined, 'r9']);
    expect(calls[1][3]).toBe('shared-1');
    expect((calls[1][2] as { content: string }).content).toMatch(/for the rule "Team signer"/);
    expect(calls[2]).toEqual(['script', 'scripts/s.js', undefined, undefined]);
    for (const bad of [42, '', 'x'.repeat(201)]) {
      await t.c.handle({ type: 'openScriptFile', path: 'scripts/s.js', ruleId: bad }, t.reply);
      await t.c.handle({ type: 'openBodyFile', path: 'mocks/a.json', ruleId: bad }, t.reply);
    }
    expect(errors(t.replies)).toHaveLength(6);
    expect(errors(t.replies).every((m) => /ruleId must be a rule id/.test(m))).toBe(true);
    expect(calls).toHaveLength(3);
  });

  it('creating a script file that already exists: the dep\'s error reaches the view', async () => {
    const t = setup({ openScriptFile: async () => Promise.reject(new Error('scripts/s.js already exists: pick another name')) });
    await t.c.handle({ type: 'openScriptFile', path: 'scripts/s.js', create: { content: '' } }, t.reply);
    expect(errors(t.replies)).toEqual(['scripts/s.js already exists: pick another name']);
  });
});
