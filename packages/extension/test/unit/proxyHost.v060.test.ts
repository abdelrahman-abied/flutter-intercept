// CONTRACTS §12: replay / resetSequences / upstream proxy forwarding (re-applied after restart), bodyFile resolution.
import { EventEmitter } from 'events';
import { describe, expect, it } from 'vitest';
import type { InterceptProxyOptions, ReplayEntry, Rule } from '@flutter-intercept/proxy';
import { bodyFilesOf, checkUpstreamProxy, InterceptProxyHost } from '../../src/proxyHost';

interface Fake {
  opts: InterceptProxyOptions;
  calls: unknown[][];
  rules: Rule[];
}

function factory(made: Fake[], features = true) {
  return (opts: InterceptProxyOptions) => {
    const ee = new EventEmitter();
    const f: Fake = { opts, calls: [], rules: [] };
    made.push(f);
    const base = {
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
    if (!features) return base;
    return {
      ...base,
      setReplay: (...a: unknown[]) => f.calls.push(['setReplay', ...a]),
      resetSequences: () => f.calls.push(['resetSequences']),
      setUpstreamProxy: (...a: unknown[]) => f.calls.push(['setUpstreamProxy', ...a]),
    };
  };
}

const entry: ReplayEntry = { method: 'GET', url: 'https://a.dev/x', status: 200, headers: {} };
let port = 7600;

describe('replay (CONTRACTS §12.4)', () => {
  it('forwards, keeps the state for Status.replay, emits replay, re-applies after a restart', async () => {
    const made: Fake[] = [];
    let p = port++;
    const host = new InterceptProxyHost({ getPort: () => p, factory: factory(made), canRestart: () => true });
    const events: unknown[] = [];
    host.on('replay', (s) => events.push(s));
    host.setReplay([entry], { fallback: 'fail', matchTemplates: true }, { id: 'demo', name: 'Demo' }); // before start: kept
    expect(host.replay).toEqual({ id: 'demo', recording: 'Demo', fallback: 'fail', entries: 1 });
    await host.start();
    expect(made[0].calls).toContainEqual(['setReplay', [entry], { fallback: 'fail', matchTemplates: true, name: 'Demo' }]);
    p = port++;
    await host.start(); // port changed → restart
    expect(made[1].calls).toContainEqual(['setReplay', [entry], { fallback: 'fail', matchTemplates: true, name: 'Demo' }]);
    host.setReplay(undefined);
    expect(host.replay).toBeUndefined();
    expect(made[1].calls.at(-1)).toEqual(['setReplay', undefined, { fallback: 'passthrough' }]);
    expect(events).toEqual([{ id: 'demo', recording: 'Demo', fallback: 'fail', entries: 1 }, undefined]);
    await host.stop();
  });

  it('an older proxy build: setReplay throws while running; a kept replay is dropped at start', async () => {
    const made: Fake[] = [];
    const logs: string[] = [];
    const host = new InterceptProxyHost({ getPort: () => port++, factory: factory(made, false), log: (m) => logs.push(m) });
    host.setReplay([entry], { fallback: 'passthrough' }, { name: 'Old' });
    await host.start();
    expect(host.replay).toBeUndefined();
    expect(logs.join('\n')).toMatch(/cannot replay/);
    expect(() => host.setReplay([entry])).toThrow(/cannot replay/);
    host.resetSequences(); // no-op
    await host.stop();
  });
});

describe('resetSequences / upstream proxy (CONTRACTS §12.3, §12.6)', () => {
  it('forwards resetSequences only to a running proxy', async () => {
    const made: Fake[] = [];
    const host = new InterceptProxyHost({ getPort: () => port++, factory: factory(made) });
    host.resetSequences();
    await host.start();
    host.resetSequences();
    expect(made[0].calls).toEqual([['resetSequences']]);
    await host.stop();
  });

  it('passes the upstream proxy at start and forwards changes while running', async () => {
    const made: Fake[] = [];
    let p = port++;
    const host = new InterceptProxyHost({ getPort: () => p, factory: factory(made), canRestart: () => true });
    host.setUpstreamProxy({ url: 'http://127.0.0.1:8888', ignoreCertErrors: true });
    await host.start();
    expect(made[0].opts.upstreamProxy).toEqual({ url: 'http://127.0.0.1:8888', ignoreCertErrors: true });
    host.setUpstreamProxy(undefined);
    expect(made[0].calls.at(-1)).toEqual(['setUpstreamProxy', undefined]);
    expect(host.upstreamProxy).toBeUndefined();
    p = port++;
    await host.start();
    expect(made[1].opts.upstreamProxy).toBeUndefined();
    await host.stop();
  });

  it('older builds: the change applies at the next start (logged)', async () => {
    const made: Fake[] = [];
    const logs: string[] = [];
    const host = new InterceptProxyHost({ getPort: () => port++, factory: factory(made, false), log: (m) => logs.push(m) });
    await host.start();
    host.setUpstreamProxy({ url: 'http://proxy.corp:3128' });
    expect(logs.join('\n')).toMatch(/applies when the proxy restarts/);
    await host.stop();
  });

  it.each([
    [{ url: 'https://p:1' }, /http:\/\//],
    [{ url: 'http://p:1/path' }, /just http/],
    [{ url: 'nope' }, /URL/],
    [{ url: 'http://p:1', ignoreCertErrors: 'yes' }, /boolean/],
    ['http://p:1', /object/],
  ])('checkUpstreamProxy rejects %j', (cfg, re) => {
    expect(() => checkUpstreamProxy(cfg)).toThrow(re);
  });
  it('checkUpstreamProxy drops ignoreCertErrors: false', () => {
    expect(checkUpstreamProxy({ url: 'http://p:1', ignoreCertErrors: false })).toEqual({ url: 'http://p:1' });
    expect(checkUpstreamProxy(undefined)).toBeUndefined();
  });
});

describe('mock.bodyFile resolution (CONTRACTS §12.2)', () => {
  const fileMock = (id: string, bodyFile: string): Rule => ({ id, enabled: true, match: { url: '*' }, action: { kind: 'mock', status: 200, body: '', bodyFile } });
  const plain: Rule = { id: 'plain', enabled: true, match: { url: '*' }, action: { kind: 'block', mode: 'reset' } };

  it('without file rules the proxy gets the rules synchronously', async () => {
    const made: Fake[] = [];
    const host = new InterceptProxyHost({ getPort: () => port++, factory: factory(made) });
    await host.start();
    host.setRules([plain]);
    expect(made[0].rules).toEqual([plain]);
    await host.stop();
  });

  it('resolves bodies (also in sequence steps), keeps authored rules in getRules, skips unreadable ones with a warning', async () => {
    const made: Fake[] = [];
    const host = new InterceptProxyHost({ getPort: () => port++, factory: factory(made) });
    const files: Record<string, string> = { 'mocks/a.json': '{"a":1}' };
    host.setBodyFileResolver(async (p) => {
      if (!(p in files)) throw new Error(`${p} not found`);
      return files[p];
    });
    const warned: unknown[] = [];
    host.on('warnings', (w) => warned.push(w));
    await host.start();
    const seq: Rule = {
      id: 'seq',
      enabled: true,
      name: 'Steps',
      match: { url: '*' },
      action: { kind: 'sequence', steps: [{ action: { kind: 'mock', status: 500, body: '', bodyFile: 'mocks/a.json' } }, { action: { kind: 'passthrough' } }] },
    };
    const authored = [fileMock('a', 'mocks/a.json'), fileMock('gone', 'mocks/missing.json'), seq, plain];
    host.setRules(authored);
    expect(host.getRules()).toBe(authored);
    await host.rulesReady();
    expect(made[0].rules.map((r) => r.id)).toEqual(['a', 'seq', 'plain']);
    expect(made[0].rules[0].action).toEqual({ kind: 'mock', status: 200, body: '{"a":1}' });
    const step = (made[0].rules[1].action as Extract<Rule['action'], { kind: 'sequence' }>).steps[0].action;
    expect(step).toEqual({ kind: 'mock', status: 500, body: '{"a":1}' });
    expect(host.warnings).toEqual([{ id: 'bodyFile:gone', kind: 'other', text: expect.stringMatching(/Rule "gone" is skipped.*mocks\/missing\.json not found/) }]);
    expect(warned).toHaveLength(1);

    // The file appears / changes: refresh re-reads it.
    files['mocks/missing.json'] = '[]';
    files['mocks/a.json'] = '{"a":2}';
    host.refreshBodyFiles('mocks/unrelated.json'); // no rule uses it: nothing happens
    await host.rulesReady();
    expect(made[0].rules.map((r) => r.id)).toEqual(['a', 'seq', 'plain']);
    host.refreshBodyFiles('mocks/missing.json');
    await host.rulesReady();
    expect(made[0].rules.map((r) => r.id)).toEqual(['a', 'gone', 'seq', 'plain']);
    expect((made[0].rules[0].action as { body: string }).body).toBe('{"a":2}');
    expect(host.warnings).toEqual([]);

    // A restart hands the resolved rules to the new proxy.
    await host.stop();
    await host.start();
    expect(made[1].rules.map((r) => r.id)).toEqual(['a', 'gone', 'seq', 'plain']);
    await host.stop();
  });

  it('without a resolver, file rules are skipped (never sent with an empty body)', async () => {
    const made: Fake[] = [];
    const host = new InterceptProxyHost({ getPort: () => port++, factory: factory(made) });
    await host.start();
    host.setRules([fileMock('a', 'm.json'), plain]);
    await host.rulesReady();
    expect(made[0].rules.map((r) => r.id)).toEqual(['plain']);
    expect(host.warnings[0].text).toMatch(/not available/);
    host.setRules([plain]);
    expect(host.warnings).toEqual([]);
    await host.stop();
  });

  it('a slower, older resolution never overwrites a newer rule set', async () => {
    const made: Fake[] = [];
    const host = new InterceptProxyHost({ getPort: () => port++, factory: factory(made) });
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    host.setBodyFileResolver(async () => {
      await gate;
      return 'late';
    });
    await host.start();
    host.setRules([fileMock('a', 'm.json')]);
    const first = host.rulesReady();
    host.setRules([plain]);
    release();
    await first;
    expect(made[0].rules).toEqual([plain]);
    await host.stop();
  });

  it('bodyFilesOf', () => {
    expect(bodyFilesOf(fileMock('a', 'x.json'))).toEqual(['x.json']);
    expect(bodyFilesOf(plain)).toEqual([]);
  });
});
