// CONTRACTS §13.4: script.file → code before the proxy gets the rules (rule id passed to the resolver), refresh on
// file change, fail closed; body files now get the rule id too.
import { EventEmitter } from 'events';
import { describe, expect, it } from 'vitest';
import type { InterceptProxyOptions, Rule } from '@flutter-intercept/proxy';
import { filesOf, InterceptProxyHost, scriptFilesOf } from '../../src/proxyHost';

function factory(made: { rules: Rule[] }[]) {
  return (opts: InterceptProxyOptions) => {
    const ee = new EventEmitter();
    const f = { rules: [] as Rule[] };
    made.push(f);
    return {
      port: opts.port ?? 0,
      start: async () => undefined,
      stop: async () => undefined,
      setRules: (r: Rule[]) => {
        f.rules = r;
      },
      getExchanges: () => [],
      clear: () => undefined,
      resume: () => undefined,
      abort: () => undefined,
      on: (ev: string, l: (...a: any[]) => void) => ee.on(ev, l),
    };
  };
}

let port = 7900;
const script = (id: string, file?: string, code = ''): Rule => ({ id, enabled: true, name: `S ${id}`, match: { url: '*' }, action: { kind: 'script', code, ...(file ? { file } : {}) } });
const fileMock = (id: string, bodyFile: string): Rule => ({ id, enabled: true, match: { url: '*' }, action: { kind: 'mock', status: 200, body: '', bodyFile } });

describe('script.file resolution (CONTRACTS §13.4)', () => {
  it('helpers', () => {
    expect(scriptFilesOf(script('a', 's/a.js'))).toEqual(['s/a.js']);
    expect(scriptFilesOf(script('b', undefined, 'x'))).toEqual([]);
    expect(filesOf(fileMock('m', 'm.json'))).toEqual(['m.json']);
  });

  it('reads files into code with the rule id, keeps authored rules, skips unreadable / unapproved ones with a warning', async () => {
    const made: { rules: Rule[] }[] = [];
    const host = new InterceptProxyHost({ getPort: () => port++, factory: factory(made) });
    const files: Record<string, string> = { 's/a.js': 'function onRequest(r){return r}' };
    const asked: [string, string][] = [];
    host.setScriptFileResolver(async (p, ruleId) => {
      asked.push([p, ruleId]);
      if (ruleId === 'shared1') throw new Error('the shared script changed and needs approval');
      if (!(p in files)) throw new Error(`${p} not found`);
      return files[p];
    });
    await host.start();
    const inline = script('inline', undefined, 'function onResponse(r){return r}');
    const authored = [script('a', 's/a.js'), script('gone', 's/missing.js'), script('shared1', 's/a.js'), inline];
    host.setRules(authored);
    expect(host.getRules()).toBe(authored);
    await host.rulesReady();
    expect(made[0].rules.map((r) => r.id)).toEqual(['a', 'inline']);
    expect(made[0].rules[0].action).toEqual({ kind: 'script', code: 'function onRequest(r){return r}', file: 's/a.js' });
    expect(made[0].rules[1]).toBe(inline);
    expect(asked).toEqual(expect.arrayContaining([['s/a.js', 'a'], ['s/missing.js', 'gone'], ['s/a.js', 'shared1']]));
    expect(host.warnings.map((w) => w.id)).toEqual(['scriptFile:gone', 'scriptFile:shared1']);
    expect(host.warnings[0].text).toMatch(/Rule "S gone" is skipped: its script file can't be used \(s\/missing\.js not found\)/);

    // Edited file → refresh re-reads (onDidChangeBodyFile fires for script files too).
    files['s/a.js'] = 'function onRequest(r){r.headers.x="1";return r}';
    files['s/missing.js'] = 'function onResponse(r){return r}';
    host.refreshBodyFiles('s/other.js');
    await host.rulesReady();
    expect((made[0].rules[0].action as { code: string }).code).toBe('function onRequest(r){return r}');
    host.refreshBodyFiles('s/a.js');
    await host.rulesReady();
    expect(made[0].rules.map((r) => r.id)).toEqual(['a', 'gone', 'inline']);
    expect((made[0].rules[0].action as { code: string }).code).toContain('r.headers.x');
    await host.stop();
  });

  it('without a resolver, file-backed scripts never reach the proxy (no empty code)', async () => {
    const made: { rules: Rule[] }[] = [];
    const host = new InterceptProxyHost({ getPort: () => port++, factory: factory(made) });
    await host.start();
    host.setRules([script('a', 's/a.js')]);
    await host.rulesReady();
    expect(made[0].rules).toEqual([]);
    expect(host.warnings[0].text).toMatch(/script files are not available/);
    host.setScriptFileResolver(async () => 'function onRequest(r){return r}');
    await host.rulesReady();
    expect(made[0].rules.map((r) => r.id)).toEqual(['a']);
    await host.stop();
  });

  it('body files get the rule id too', async () => {
    const made: { rules: Rule[] }[] = [];
    const host = new InterceptProxyHost({ getPort: () => port++, factory: factory(made) });
    const asked: [string, string][] = [];
    host.setBodyFileResolver(async (p, ruleId) => (asked.push([p, ruleId]), `{"from":"${ruleId}"}`));
    await host.start();
    host.setRules([fileMock('m1', 'mocks/a.json'), fileMock('m2', 'mocks/a.json')]);
    await host.rulesReady();
    expect(asked).toEqual([['mocks/a.json', 'm1'], ['mocks/a.json', 'm2']]);
    expect(made[0].rules.map((r) => (r.action as { body: string }).body)).toEqual(['{"from":"m1"}', '{"from":"m2"}']);
    await host.stop();
  });
});
