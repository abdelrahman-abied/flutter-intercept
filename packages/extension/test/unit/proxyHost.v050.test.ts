// CONTRACTS §11.4: record / update forwarding, session warnings, vmHostDeps.
import { EventEmitter } from 'events';
import { describe, expect, it } from 'vitest';
import type { Exchange, InterceptProxyOptions } from '@flutter-intercept/proxy';
import { InterceptProxyHost, MAX_WARNINGS_PER_SESSION } from '../../src/proxyHost';
import type { SessionWarning } from '../../src/ui/protocol';

function fake(o: InterceptProxyOptions, calls: unknown[], features = true) {
  const ee = new EventEmitter();
  let n = 0;
  const base = {
    port: o.port ?? 0,
    start: async () => undefined,
    stop: async () => undefined,
    setRules: () => undefined,
    getExchanges: () => [],
    clear: () => undefined,
    resume: () => undefined,
    abort: () => undefined,
    on: (ev: string, l: (...a: any[]) => void) => ee.on(ev, l),
  };
  if (!features) return base;
  return {
    ...base,
    record: (ex: Omit<Exchange, 'id'>) => {
      calls.push(['record', ex]);
      if (ex.url.includes('boom')) throw new Error('bad exchange');
      return `vm-${++n}`;
    },
    update: (id: string, patch: Partial<Exchange>) => calls.push(['update', id, patch]),
  };
}

const profileEx = (url = 'https://api.example.com/native'): Omit<Exchange, 'id'> => ({
  startedAt: 1,
  method: 'GET',
  url,
  requestHeaders: {},
  state: 'pending',
});

const warn = (id: string, extra: Partial<SessionWarning> = {}): SessionWarning => ({ id, kind: 'background-isolate', text: `Requests from background isolate "${id}" are not intercepted.`, ...extra });

describe('record / update (CONTRACTS §11.4)', () => {
  it('nothing is recorded while the proxy is stopped', () => {
    const calls: unknown[] = [];
    const host = new InterceptProxyHost({ getPort: () => 7401, factory: (o) => fake(o, calls) });
    expect(host.record([profileEx()])).toEqual([]);
    host.update('vm-1', { status: 200 });
    expect(calls).toEqual([]);
  });

  it('forwards to the proxy, always marked captured: vm-profile; one failure does not stop the batch', async () => {
    const calls: unknown[] = [];
    const logs: string[] = [];
    const host = new InterceptProxyHost({ getPort: () => 7402, factory: (o) => fake(o, calls), log: (m) => logs.push(m) });
    await host.start();
    const ids = host.record([profileEx(), profileEx('https://boom.example.com/'), { ...profileEx(), captured: undefined }]);
    expect(ids).toEqual(['vm-1', 'vm-2']);
    expect(calls.filter((c) => (c as unknown[])[0] === 'record').every((c) => ((c as unknown[])[1] as Exchange).captured === 'vm-profile')).toBe(true);
    expect(logs.some((l) => /recording a profile exchange failed: bad exchange/.test(l))).toBe(true);
    host.update('vm-1', { id: 'evil', status: 200, state: 'completed' } as Partial<Exchange>);
    expect(calls.at(-1)).toEqual(['update', 'vm-1', { status: 200, state: 'completed' }]);
  });

  it('an older proxy build without record(): empty result, logged once', async () => {
    const logs: string[] = [];
    const host = new InterceptProxyHost({ getPort: () => 7403, factory: (o) => fake(o, [], false), log: (m) => logs.push(m) });
    await host.start();
    expect(host.record([profileEx()])).toEqual([]);
    expect(host.record([profileEx()])).toEqual([]);
    expect(() => host.update('x', { status: 1 })).not.toThrow();
    expect(logs.filter((l) => /cannot record/.test(l))).toHaveLength(1);
  });

  it('vmHostDeps is bound to the host', async () => {
    const calls: unknown[] = [];
    const logs: string[] = [];
    const host = new InterceptProxyHost({ getPort: () => 7404, factory: (o) => fake(o, calls), log: (m) => logs.push(m) });
    await host.start();
    const deps = host.vmHostDeps();
    const { record, update, setWarnings, log } = deps; // unbound use must work
    expect(record([profileEx()])).toEqual(['vm-1']);
    update('vm-1', { status: 204 });
    setWarnings('s1', [warn('worker')]);
    log('hello');
    expect(calls.at(-1)).toEqual(['update', 'vm-1', { status: 204 }]);
    expect(host.warnings.map((w) => w.id)).toEqual(['worker']);
    expect(logs).toContain('hello');
    const custom: string[] = [];
    host.vmHostDeps((m) => custom.push(m)).log('x');
    expect(custom).toEqual(['x']);
  });
});

describe('session warnings (CONTRACTS §11.4)', () => {
  it('replaces per session, dedupes by id across sessions, clears with []', () => {
    const host = new InterceptProxyHost({ getPort: () => 1, factory: (o) => fake(o, []) });
    const events: SessionWarning[][] = [];
    host.on('warnings', (w: SessionWarning[]) => events.push(w));
    host.setWarnings('s1', [warn('a'), warn('b'), warn('a')]);
    host.setWarnings('s2', [warn('b'), warn('c', { kind: 'native-client' })]);
    expect(host.warnings.map((w) => [w.id, w.sessionId])).toEqual([
      ['a', 's1'],
      ['b', 's1'],
      ['c', 's2'],
    ]);
    host.setWarnings('s1', [warn('b')]); // replaces s1's set
    expect(host.warnings.map((w) => w.id)).toEqual(['b', 'c']);
    host.setWarnings('s1', [warn('b')]); // unchanged → no event
    host.setWarnings('s1', []);
    expect(host.warnings.map((w) => [w.id, w.sessionId])).toEqual([
      ['b', 's2'],
      ['c', 's2'],
    ]);
    host.setWarnings('s2', []);
    expect(host.warnings).toEqual([]);
    expect(events).toHaveLength(5);
    expect(events.at(-1)).toEqual([]);
  });

  it('drops malformed entries, normalises kind, caps text and count', () => {
    const host = new InterceptProxyHost({ getPort: () => 1, factory: (o) => fake(o, []) });
    host.setWarnings('', [warn('x')]);
    expect(host.warnings).toEqual([]);
    host.setWarnings('s1', [
      null as unknown as SessionWarning,
      { id: '', kind: 'other', text: 'x' },
      { id: 'k', kind: 'weird' as SessionWarning['kind'], text: `line1\nline2 ${'y'.repeat(900)}`, sessionId: 'spoofed' },
      { id: 'blank', kind: 'other', text: '   ' },
    ]);
    expect(host.warnings).toHaveLength(1);
    const w = host.warnings[0];
    expect(w.kind).toBe('other');
    expect(w.sessionId).toBe('s1');
    expect(w.text).not.toMatch(/\n/);
    expect(w.text.length).toBeLessThanOrEqual(500);
    host.setWarnings('s1', Array.from({ length: 80 }, (_, i) => warn(`w${i}`)));
    expect(host.warnings).toHaveLength(MAX_WARNINGS_PER_SESSION);
  });
});

describe('setWebSessionActive (CONTRACTS §11.3)', () => {
  it('stored before start, applied at start and after a restart, forwarded while running', async () => {
    const calls: unknown[] = [];
    let port = 7501;
    const host = new InterceptProxyHost({
      getPort: () => port,
      canRestart: () => true,
      factory: (o) => ({ ...fake(o, []), setWebSessionActive: (a: boolean) => calls.push([o.port, a]) }),
    });
    host.setWebSessionActive(true);
    expect(host.webSession).toBe(true);
    await host.start();
    expect(calls).toEqual([[7501, true]]);
    host.setWebSessionActive(false);
    expect(calls.at(-1)).toEqual([7501, false]);
    host.setWebSessionActive(true);
    port = 7502;
    await host.start(); // restart on the new port
    expect(calls.at(-1)).toEqual([7502, true]);
  });

  it('a proxy without it: no error', async () => {
    const host = new InterceptProxyHost({ getPort: () => 7503, factory: (o) => fake(o, [], false) });
    await host.start();
    expect(() => host.setWebSessionActive(true)).not.toThrow();
  });
});
