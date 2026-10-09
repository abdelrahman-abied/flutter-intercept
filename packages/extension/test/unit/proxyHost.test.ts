import { EventEmitter } from 'events';
import * as http from 'http';
import * as net from 'net';
import { afterEach, describe, expect, it } from 'vitest';
import { InterceptProxy, type Exchange } from '@flutter-intercept/proxy';
import { InterceptProxyHost } from '../../src/proxyHost';

function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => {
      const p = (s.address() as net.AddressInfo).port;
      s.close(() => resolve(p));
    });
  });
}

function occupy(port: number): Promise<net.Server> {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(port, '127.0.0.1', () => resolve(s));
  });
}

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!().catch(() => undefined);
});

describe('InterceptProxyHost with the real InterceptProxy', () => {
  it('starts lazily and idempotently, takes the next free port when busy, binds 127.0.0.1', async () => {
    const base = await freePort();
    const blocker = await occupy(base);
    cleanups.push(() => new Promise((r) => blocker.close(r)));
    let stopped = 0;
    const host = new InterceptProxyHost({
      getPort: () => base,
      factory: (o) => new InterceptProxy(o),
      onStop: async () => {
        stopped++;
      },
    });
    cleanups.push(() => host.stop());
    expect(host.running).toBe(false);
    const [p1, p2] = await Promise.all([host.start(), host.start()]);
    expect(p1).toBe(p2);
    expect(p1).toBeGreaterThan(base);
    expect(p1).toBeLessThanOrEqual(base + 100);
    expect(host.running).toBe(true);
    expect(await host.start()).toBe(p1);

    // Proxies a plain-http request (absolute-form) and records it; a rule set before start applies.
    const origin = http.createServer((_q, s) => s.end('origin'));
    await new Promise<void>((r) => origin.listen(0, '127.0.0.1', () => r()));
    cleanups.push(() => new Promise((r) => origin.close(r)));
    const oport = (origin.address() as net.AddressInfo).port;
    host.setRules([{ id: 'm', enabled: true, match: { url: `http://127.0.0.1:${oport}/mocked*` }, action: { kind: 'mock', status: 201, body: 'mocked!' } }]);
    const seen: Exchange[] = [];
    host.on('exchange', (e: Exchange) => seen.push(e));
    const get = (path: string) =>
      new Promise<{ status: number; body: string }>((resolve, reject) => {
        const req = http.request({ host: '127.0.0.1', port: p1, method: 'GET', path: `http://127.0.0.1:${oport}${path}`, headers: { host: `127.0.0.1:${oport}` } }, (res) => {
          let body = '';
          res.on('data', (d) => (body += d));
          res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
        });
        req.on('error', reject);
        req.end();
      });
    expect(await get('/plain')).toEqual({ status: 200, body: 'origin' });
    expect(await get('/mocked/1')).toEqual({ status: 201, body: 'mocked!' });
    await new Promise((r) => setTimeout(r, 50));
    expect(host.getExchanges().map((e) => e.state)).toEqual(['completed', 'mocked']);
    expect(seen.length).toBeGreaterThan(0);

    await host.stop();
    expect(host.running).toBe(false);
    expect(stopped).toBe(1);
    expect(host.getExchanges()).toEqual([]);
  }, 30_000);

  it('fails cleanly when the whole range is busy', async () => {
    const host = new InterceptProxyHost({
      getPort: () => 65535,
      factory: () => ({
        start: async () => {
          throw Object.assign(new Error('listen EADDRINUSE'), { code: 'EADDRINUSE' });
        },
        stop: async () => undefined,
        port: 0,
        setRules: () => undefined,
        getExchanges: () => [],
        clear: () => undefined,
        resume: () => undefined,
        abort: () => undefined,
        on: () => undefined,
      }),
    });
    await expect(host.start()).rejects.toThrow(/no free proxy port in 65535-65535/);
  });
});

describe('InterceptProxyHost port changes', () => {
  function fakeFactory(log: string[]) {
    return (o: { port: number }) => {
      let running = false;
      return {
        start: async () => {
          running = true;
          log.push(`start ${o.port}`);
        },
        stop: async () => {
          if (running) log.push(`stop ${o.port}`);
          running = false;
        },
        get port() {
          return o.port;
        },
        setRules: () => undefined,
        getExchanges: () => [],
        clear: () => undefined,
        resume: () => undefined,
        abort: () => undefined,
        on: () => undefined,
      };
    };
  }

  it('restarts on the new port only when allowed (no live session)', async () => {
    const log: string[] = [];
    let port = 9001;
    let live = true;
    const states: boolean[] = [];
    const host = new InterceptProxyHost({ getPort: () => port, factory: fakeFactory(log), canRestart: () => !live });
    host.on('state', (r: boolean) => states.push(r));
    expect(await host.start()).toBe(9001);
    port = 9002;
    expect(await host.start()).toBe(9001); // a session is live: keep the running proxy
    live = false;
    expect(await host.start()).toBe(9002);
    expect(await host.start()).toBe(9002);
    expect(log).toEqual(['start 9001', 'stop 9001', 'start 9002']);
    expect(states).toEqual([true, false, true]);
  });
});

describe('InterceptProxyHost CA wiring', () => {
  it('passes the install CA to every proxy it creates', async () => {
    const seen: unknown[] = [];
    const ca = { key: 'K', cert: 'C' };
    const host = new InterceptProxyHost({
      getPort: () => 1,
      getCa: async () => ca,
      factory: (o) => {
        seen.push(o.ca);
        return {
          port: o.port,
          start: async () => undefined,
          stop: async () => undefined,
          setRules: () => undefined,
          getExchanges: () => [],
          clear: () => undefined,
          resume: () => undefined,
          abort: () => undefined,
          on: () => undefined,
        };
      },
    });
    await host.start();
    await host.stop();
    await host.start();
    await host.stop();
    expect(seen).toEqual([ca, ca]);
  });
});

describe('InterceptProxyHost v0.3.0 forwarding (CONTRACTS §9.2/9.4)', () => {
  type Opts = { port: number; rewriteLocalhost?: boolean };
  function fake(o: Opts, calls: unknown[], features = true) {
    const ee = new EventEmitter();
    const base = {
      opts: o,
      ee,
      port: o.port,
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
      send: async (req: unknown) => {
        calls.push(['send', o.port, req]);
        return { id: 'x1' };
      },
      setNetworkProfile: (p: unknown) => calls.push(['profile', o.port, p]),
      setAppPackages: (n: unknown) => calls.push(['packages', o.port, n]),
    };
  }

  it('send starts the proxy on demand and forwards the request', async () => {
    const calls: unknown[] = [];
    const host = new InterceptProxyHost({ getPort: () => 7001, factory: (o) => fake(o, calls) });
    expect(host.running).toBe(false);
    await expect(host.send({ method: 'GET', url: 'https://a.dev/', initiator: 'editor' })).resolves.toEqual({ id: 'x1' });
    expect(host.running).toBe(true);
    expect(calls).toContainEqual(['send', 7001, { method: 'GET', url: 'https://a.dev/', initiator: 'editor' }]);
  });

  it('network profile and app packages are applied at start and re-applied after a restart', async () => {
    const calls: unknown[] = [];
    let port = 7101;
    const host = new InterceptProxyHost({ getPort: () => port, factory: (o) => fake(o, calls), canRestart: () => true });
    host.setNetworkProfile({ kind: 'offline' }); // before start: stored
    host.setAppPackages(['demo_app', 'demo_app', '']);
    expect(host.networkProfile).toEqual({ kind: 'offline' });
    await host.start();
    expect(calls).toEqual([
      ['profile', 7101, { kind: 'offline' }],
      ['packages', 7101, ['demo_app']],
    ]);
    host.setNetworkProfile({ kind: 'throttle', preset: 'slow-3g', latencyMs: 400, kbps: 400 });
    expect(calls.at(-1)).toEqual(['profile', 7101, { kind: 'throttle', preset: 'slow-3g', latencyMs: 400, kbps: 400 }]);
    port = 7102;
    await host.start(); // port changed → restart
    expect(calls.slice(-2)).toEqual([
      ['profile', 7102, { kind: 'throttle', preset: 'slow-3g', latencyMs: 400, kbps: 400 }],
      ['packages', 7102, ['demo_app']],
    ]);
  });

  it('re-emits rule-spent / rule-hit and passes rewriteLocalhost', async () => {
    const seen: unknown[] = [];
    const made: ReturnType<typeof fake>[] = [];
    const host = new InterceptProxyHost({
      getPort: () => 7201,
      rewriteLocalhost: () => false,
      factory: (o) => {
        const p = fake(o, []);
        made.push(p);
        return p;
      },
    });
    host.on('rule-spent', (...a: unknown[]) => seen.push(a));
    await host.start();
    expect(made[0].opts.rewriteLocalhost).toBe(false);
    host.on('rule-hit', (...a: unknown[]) => seen.push(['hit', ...a]));
    made[0].ee.emit('rule-spent', 'r1', 'times');
    made[0].ee.emit('rule-hit', 'r2', 2);
    expect(seen).toEqual([['r1', 'times'], ['hit', 'r2', 2]]);
  });

  it('an older proxy build: clear errors for send/profile, "none" still accepted', async () => {
    const logs: string[] = [];
    const host = new InterceptProxyHost({ getPort: () => 7301, factory: (o) => fake(o, [], false), log: (m) => logs.push(m) });
    await host.start();
    await expect(host.send({ method: 'GET', url: 'https://a.dev/', initiator: 'agent' })).rejects.toThrow(/cannot send requests/);
    expect(() => host.setNetworkProfile({ kind: 'offline' })).toThrow(/cannot simulate/);
    expect(() => host.setNetworkProfile({ kind: 'none' })).not.toThrow();
    expect(() => host.setAppPackages(['a'])).not.toThrow();
  });
});
