// CONTRACTS §14 (v0.8.0) host side: TLS passthrough hosts and client certificates forwarded to the proxy (constructor
// options + setters, re-applied after a restart), VS Code's http.proxy as the default upstream (user settings only,
// http.noProxy direct, source in Status), `bypass` session warnings kept.
import { EventEmitter } from 'events';
import { describe, expect, it } from 'vitest';
import type { ClientCertificate, InterceptProxyOptions } from '@flutter-intercept/proxy';
import { parseHostPattern } from '@flutter-intercept/proxy';
import { InterceptProxyHost, normalizeNoProxy, normalizeTlsPassthrough, resolveUpstreamProxy, splitNoProxy, type VscodeHttpProxy } from '../../src/proxyHost';

/** P's REVIEW-8 #4 parser is in the built proxy (it refuses `*.com`). */
export const SHARED_PARSER_FIXED = (() => {
  try {
    parseHostPattern('*.com');
    return false;
  } catch {
    return true;
  }
})();

interface Fake {
  opts: InterceptProxyOptions;
  calls: unknown[][];
}

function factory(made: Fake[], features = true) {
  return (opts: InterceptProxyOptions) => {
    const ee = new EventEmitter();
    const f: Fake = { opts, calls: [] };
    made.push(f);
    const base = {
      port: opts.port ?? 0,
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
      setUpstreamProxy: (...a: unknown[]) => {
        f.calls.push(['setUpstreamProxy', ...a]);
      },
      setTlsPassthrough: (...a: unknown[]) => {
        f.calls.push(['setTlsPassthrough', ...a]);
      },
      setClientCertificates: (...a: unknown[]) => {
        f.calls.push(['setClientCertificates', ...a]);
      },
    };
  };
}

function host(made: Fake[], o: { features?: boolean; vscodeHttpProxy?: () => VscodeHttpProxy | undefined; logs?: string[] } = {}) {
  return new InterceptProxyHost({
    getPort: () => 9100,
    factory: factory(made, o.features ?? true),
    log: (m) => o.logs?.push(m),
    canRestart: () => true,
    ...(o.vscodeHttpProxy ? { vscodeHttpProxy: o.vscodeHttpProxy } : {}),
  });
}

const KEY_MARKER = 'PRIVATE-KEY-MATERIAL-NEVER-LOGGED';
const cert = (h: string): ClientCertificate => ({ host: h, cert: '-----BEGIN CERTIFICATE-----\nAAA\n-----END CERTIFICATE-----', key: `-----BEGIN PRIVATE KEY-----\n${KEY_MARKER}\n-----END PRIVATE KEY-----`, passphrase: 'pass-NEVER-LOGGED' });

describe('normalizeTlsPassthrough (CONTRACTS §14.2)', () => {
  it('keeps lower-case hostname globs, dedupes, reports the rest', () => {
    // the proxy's own parseHostPattern decides (REVIEW-8 #4): bare * and non-host text are refused one by one
    const r = normalizeTlsPassthrough([' API.Bank.example ', '*.pinned.example', 'api.bank.example', '*', 'host.example.', '', 'https://x.example/', 'a b', 'x.example:443', 7]);
    expect(r.hosts).toEqual(['api.bank.example', '*.pinned.example', 'host.example', 'x.example:443']);
    expect(r.problems).toHaveLength(4);
    expect(r.problems.join('\n')).toMatch(/matches every host/);
    expect(r.problems.every((p) => p.startsWith('flutterIntercept.tlsPassthrough: '))).toBe(true);
  });

  // REVIEW-8 #4: needs P's label-bounded parser in the proxy build; skipped while the built proxy still accepts *.com.
  it.skipIf(!SHARED_PARSER_FIXED)('refuses patterns an attacker could register (shared parser, REVIEW-8 #4)', () => {
    const r = normalizeTlsPassthrough(['*.*', '*.com', '10.0.0.*', 'api.corp.*', '*.bank.example']);
    expect(r.hosts).toEqual(['*.bank.example']);
    expect(r.problems).toHaveLength(4);
  });

  it('non-arrays and caps', () => {
    expect(normalizeTlsPassthrough(undefined)).toEqual({ hosts: [], problems: [] });
    expect(normalizeTlsPassthrough('a.example').problems[0]).toMatch(/must be a list/);
    const many = normalizeTlsPassthrough(Array.from({ length: 250 }, (_, i) => `h${i}.example`));
    expect(many.hosts).toHaveLength(200);
    expect(many.problems[0]).toMatch(/first 200/);
  });
});

describe('InterceptProxyHost: TLS passthrough (CONTRACTS §14.2)', () => {
  it('passes hosts as a constructor option and through the setter, re-applied after a restart; emits on change', async () => {
    const made: Fake[] = [];
    const h = host(made);
    const events: unknown[] = [];
    h.on('tlsPassthrough', (x) => events.push(x));
    const r = h.setTlsPassthrough(['*.Bank.example', 'bad host']);
    expect(r.hosts).toEqual(['*.bank.example']);
    expect(events).toEqual([['*.bank.example']]);
    h.setTlsPassthrough(['*.bank.example']); // unchanged: no event
    expect(events).toHaveLength(1);
    await h.start();
    expect(made[0].opts.tlsPassthrough).toEqual(['*.bank.example']);
    expect(made[0].calls).toContainEqual(['setTlsPassthrough', ['*.bank.example']]);
    h.setTlsPassthrough(['a.example', 'b.example']);
    expect(made[0].calls.at(-1)).toEqual(['setTlsPassthrough', ['a.example', 'b.example']]);
    expect(h.tlsPassthrough).toEqual(['a.example', 'b.example']);
    await h.stop();
    await h.start();
    expect(made[1].opts.tlsPassthrough).toEqual(['a.example', 'b.example']);
    h.setTlsPassthrough([]);
    expect(made[1].calls.at(-1)).toEqual(['setTlsPassthrough', []]);
    expect(h.tlsPassthrough).toEqual([]);
  });

  it('an older proxy build: logged once, nothing thrown', async () => {
    const made: Fake[] = [];
    const logs: string[] = [];
    const h = host(made, { features: false, logs });
    await h.start();
    h.setTlsPassthrough(['a.example']);
    h.setTlsPassthrough(['b.example']);
    expect(logs.filter((l) => /cannot pass TLS through/.test(l))).toHaveLength(1);
  });
});

describe('TLS passthrough: hosts in effect and problems in Status (REVIEW-8 #4)', () => {
  const proxyWith = (setTls: (hosts: string[]) => unknown, live?: () => string[]) =>
    new InterceptProxyHost({
      getPort: () => 9100,
      factory: (opts) => {
        const p = {
          port: opts.port,
          start: async () => undefined,
          stop: async () => undefined,
          setRules: () => undefined,
          getExchanges: () => [],
          clear: () => undefined,
          resume: () => undefined,
          abort: () => undefined,
          on: () => undefined,
          setTlsPassthrough: setTls,
        };
        if (live) Object.defineProperty(p, 'tlsPassthrough', { get: live });
        return p as never;
      },
    });

  it('a newer proxy returns what it accepted: Status shows only those, its problems become a warning', async () => {
    let inEffect: string[] = [];
    const h = proxyWith(
      (hosts) => {
        inEffect = hosts.filter((x) => x !== 'b.example');
        return { hosts: inEffect, problems: ['"b.example" refused by the proxy'] };
      },
      () => inEffect,
    );
    await h.start();
    const r = h.setTlsPassthrough(['a.example', 'b.example', '*']);
    expect(h.tlsPassthrough).toEqual(['a.example']);
    expect(r.hosts).toEqual(['a.example']);
    expect(r.problems).toHaveLength(2);
    const w = h.warnings.find((x) => x.id === 'settings:tlsPassthrough');
    expect(w?.text).toMatch(/matches every host.*b\.example" refused/);
    h.setTlsPassthrough(['a.example']);
    inEffect = ['a.example'];
    // the proxy still reports b's problem for the old list only: a clean list clears the warning
    const h2 = proxyWith((hosts) => ({ hosts, problems: [] }), () => ['a.example']);
    await h2.start();
    h2.setTlsPassthrough(['a.example']);
    expect(h2.warnings.find((x) => x.id === 'settings:tlsPassthrough')).toBeUndefined();
  });

  it('an older proxy that throws keeps its previous list: Status shows that list, not the new one', async () => {
    let inEffect: string[] = [];
    const h = proxyWith(
      (hosts) => {
        if (hosts.includes('bad.example')) throw new Error('TLS passthrough: "bad.example" refused');
        inEffect = hosts;
      },
      () => inEffect,
    );
    await h.start();
    h.setTlsPassthrough(['a.example']);
    expect(h.tlsPassthrough).toEqual(['a.example']);
    h.setTlsPassthrough(['a.example', 'bad.example']);
    expect(h.tlsPassthrough).toEqual(['a.example']);
    expect(h.warnings.find((x) => x.id === 'settings:tlsPassthrough')?.text).toMatch(/previous list stays in effect/);
  });

  it('setting problems before the proxy starts show up once it runs', async () => {
    const h = proxyWith((hosts) => ({ hosts, problems: [] }));
    h.setTlsPassthrough(['a.example', '*']);
    expect(h.warnings.find((x) => x.id === 'settings:tlsPassthrough')?.text).toMatch(/matches every host/);
    await h.start();
    expect(h.warnings.find((x) => x.id === 'settings:tlsPassthrough')?.text).toMatch(/matches every host/);
  });
});

describe('InterceptProxyHost: client certificates (CONTRACTS §14.3)', () => {
  it('forwards certificates (constructor + setter + restart) and keeps the status; key material never logged or emitted', async () => {
    const made: Fake[] = [];
    const logs: string[] = [];
    const h = host(made, { logs });
    const emitted: unknown[] = [];
    h.on('clientCertificates', (x) => emitted.push(x));
    h.setClientCertificates([cert('api.corp.example')], [{ host: 'api.corp.example' }, { host: '*.other.example', problem: 'Client certificate for *.other.example: its pfx file was not found.' }]);
    expect(h.clientCertificateStatus).toEqual([{ host: 'api.corp.example' }, { host: '*.other.example', problem: 'Client certificate for *.other.example: its pfx file was not found.' }]);
    await h.start();
    expect(made[0].opts.clientCertificates).toEqual([cert('api.corp.example')]);
    expect(made[0].calls).toContainEqual(['setClientCertificates', [cert('api.corp.example')]]);
    h.setClientCertificates([cert('a.example'), cert('b.example')]);
    expect(made[0].calls.at(-1)).toEqual(['setClientCertificates', [cert('a.example'), cert('b.example')]]);
    expect(h.clientCertificateStatus).toEqual([{ host: 'a.example' }, { host: 'b.example' }]);
    await h.stop();
    await h.start();
    expect(made[1].opts.clientCertificates).toHaveLength(2);
    const seen = JSON.stringify([logs, emitted, h.clientCertificateStatus]);
    expect(seen).not.toContain(KEY_MARKER);
    expect(seen).not.toContain('NEVER-LOGGED');
    expect(seen).not.toContain('BEGIN');
  });

  it('a proxy build without mTLS: every loaded certificate shows a problem, logged once', async () => {
    const made: Fake[] = [];
    const logs: string[] = [];
    const h = host(made, { features: false, logs });
    await h.start();
    h.setClientCertificates([cert('a.example')], [{ host: 'a.example' }, { host: 'b.example', problem: 'x' }]);
    expect(h.clientCertificateStatus).toEqual([{ host: 'a.example', problem: 'this proxy build cannot present client certificates' }, { host: 'b.example', problem: 'x' }]);
    expect(logs.filter((l) => /cannot present client certificates/.test(l))).toHaveLength(1);
  });

  it('a throwing proxy setter is logged without the certificate', async () => {
    const logs: string[] = [];
    const h = new InterceptProxyHost({
      getPort: () => 9100,
      log: (m) => logs.push(m),
      factory: (opts) =>
        ({
          port: opts.port,
          start: async () => undefined,
          stop: async () => undefined,
          setRules: () => undefined,
          getExchanges: () => [],
          clear: () => undefined,
          resume: () => undefined,
          abort: () => undefined,
          on: () => undefined,
          setClientCertificates: () => {
            throw new Error('bad certificate');
          },
        }) as never,
    });
    await h.start();
    expect(() => h.setClientCertificates([cert('a.example')])).not.toThrow();
    expect(logs.join('\n')).toMatch(/client certificates not applied: bad certificate/);
    expect(logs.join('\n')).not.toContain(KEY_MARKER);
  });
});

describe('normalizeNoProxy / resolveUpstreamProxy (CONTRACTS §14.6)', () => {
  it('normalizes http.noProxy forms', () => {
    expect(normalizeNoProxy(['localhost', '.corp.example', '*.svc.example:8443', 'Intranet', '10.1.2.3', '[::1]:80', '*', 'a,b c', '10.0.0.0/8', 'x*y.example', 7, 'bad!'])).toEqual([
      'localhost',
      '*.corp.example',
      '*.svc.example:8443',
      'intranet',
      '10.1.2.3',
      '[::1]:80',
      '*',
      'a',
      'b',
      'c',
    ]);
    expect(normalizeNoProxy(undefined)).toEqual([]);
    expect(normalizeNoProxy('x')).toEqual([]);
  });

  it('reports the http.noProxy entries it drops (REVIEW-8 #12): problem, log and a Status warning', () => {
    expect(splitNoProxy(['a.example', '10.0.0.0/8', '<local>', '*.ok.example']).dropped).toEqual(['10.0.0.0/8', '<local>']);
    const r = resolveUpstreamProxy({}, { url: 'http://corp:3128', noProxy: ['a.example', '10.0.0.0/8', '<local>'] });
    expect(r.cfg).toEqual({ url: 'http://corp:3128', noProxy: ['a.example'] });
    expect(r.problem).toMatch(/"10\.0\.0\.0\/8", "<local>" can't be used.*go through the proxy/);
    const logs: string[] = [];
    const h = host([], { vscodeHttpProxy: () => ({ url: 'http://corp:3128', noProxy: ['<local>'] }), logs });
    expect(h.applyUpstreamSettings({}).problem).toMatch(/<local>/);
    expect(logs.join('\n')).toMatch(/<local>/);
    expect(h.warnings.find((w) => w.id === 'settings:upstream')?.text).toMatch(/<local>/);
    expect(h.upstreamProxySource).toBe('http.proxy');
    h.applyUpstreamSettings({ url: 'http://mine:8888' });
    expect(h.warnings.find((w) => w.id === 'settings:upstream')).toBeUndefined();
  });

  it('ours wins; VS Code http.proxy only when ours is empty; noProxy carried; ignoreCertErrors only from ours', () => {
    expect(resolveUpstreamProxy({ url: 'http://charles.local:8888', ignoreCertErrors: true }, { url: 'http://corp:3128', noProxy: ['a.example'] })).toEqual({
      cfg: { url: 'http://charles.local:8888', ignoreCertErrors: true },
      source: 'flutterIntercept',
    });
    expect(resolveUpstreamProxy({ url: '  ' }, { url: 'http://corp.example:3128/', noProxy: ['.internal.example', 'localhost'] })).toEqual({
      cfg: { url: 'http://corp.example:3128/', noProxy: ['*.internal.example', 'localhost'] },
      source: 'http.proxy',
    });
    // http.proxyStrictSSL is not consulted: only ours turns checks off
    expect(resolveUpstreamProxy({ ignoreCertErrors: true }, { url: 'http://corp:3128' }).cfg).toEqual({ url: 'http://corp:3128', ignoreCertErrors: true });
    expect(resolveUpstreamProxy({}, undefined)).toEqual({});
    expect(resolveUpstreamProxy({}, { url: '' })).toEqual({});
  });

  it('a VS Code proxy we cannot chain → problem, direct; invalid OUR setting throws', () => {
    const https = resolveUpstreamProxy({}, { url: 'https://secure-proxy.example:443' });
    expect(https.cfg).toBeUndefined();
    expect(https.problem).toMatch(/https:\/\/ proxy.*goes direct/);
    expect(resolveUpstreamProxy({}, { url: 'socks5://127.0.0.1:1080' }).problem).toMatch(/socks5:\/\//);
    expect(resolveUpstreamProxy({}, { url: 'not a url' }).problem).toMatch(/can't be used/);
    expect(resolveUpstreamProxy({}, { url: 'http://corp:3128/path' }).problem).toMatch(/can't be used/);
    expect(() => resolveUpstreamProxy({ url: 'ftp://x' }, { url: 'http://corp:3128' })).toThrow(/http:\/\//);
  });

  it('never puts credentials of http.proxy in a problem or Status', () => {
    const r = resolveUpstreamProxy({}, { url: 'http://user:s3cr3t@corp.example:3128' });
    expect(r.source).toBe('http.proxy');
    const made: Fake[] = [];
    const h = host(made, { vscodeHttpProxy: () => ({ url: 'http://user:s3cr3t@corp.example:3128' }) });
    h.applyUpstreamSettings({});
    expect(h.upstreamProxyDisplay).toBe('corp.example:3128');
    expect(JSON.stringify(h.upstreamProxyInfo)).not.toContain('s3cr3t');
  });
});

describe('InterceptProxyHost.applyUpstreamSettings (CONTRACTS §14.6)', () => {
  it('uses the injected http.proxy when ours is empty, switches back to ours, emits upstream with the source', async () => {
    const made: Fake[] = [];
    let vs: VscodeHttpProxy | undefined = { url: 'http://corp.example:3128', noProxy: ['.internal.example'] };
    const h = host(made, { vscodeHttpProxy: () => vs });
    const events: unknown[] = [];
    h.on('upstream', (x) => events.push(x));
    await h.start();
    expect(h.applyUpstreamSettings({ url: '' })).toEqual({ source: 'http.proxy' });
    expect(h.upstreamProxySource).toBe('http.proxy');
    expect(made[0].calls.at(-1)).toEqual(['setUpstreamProxy', { url: 'http://corp.example:3128', noProxy: ['*.internal.example'] }]);
    expect(h.applyUpstreamSettings({ url: 'http://charles.local:8888' })).toEqual({ source: 'flutterIntercept' });
    expect(h.upstreamProxySource).toBe('flutterIntercept');
    // the same URL from the other source: Status must change (event), the proxy needn't
    vs = { url: 'http://charles.local:8888' };
    const calls = made[0].calls.length;
    expect(h.applyUpstreamSettings({})).toEqual({ source: 'http.proxy' });
    expect(made[0].calls.length).toBe(calls);
    expect(h.upstreamProxySource).toBe('http.proxy');
    vs = undefined;
    expect(h.applyUpstreamSettings({})).toEqual({});
    expect(h.upstreamProxySource).toBeUndefined();
    expect(made[0].calls.at(-1)).toEqual(['setUpstreamProxy', undefined]);
    expect(events.length).toBe(4);
  });

  it('a throwing or missing dep means no VS Code proxy; a bad VS Code proxy returns a problem and goes direct', () => {
    const logs: string[] = [];
    const made: Fake[] = [];
    const h1 = host(made, {
      vscodeHttpProxy: () => {
        throw new Error('boom');
      },
    });
    expect(h1.applyUpstreamSettings({})).toEqual({});
    const h2 = host(made);
    expect(h2.applyUpstreamSettings({})).toEqual({});
    const h3 = host(made, { vscodeHttpProxy: () => ({ url: 'https://p.example' }), logs });
    const r = h3.applyUpstreamSettings({});
    expect(r.problem).toMatch(/can't chain/);
    expect(h3.upstreamProxy).toBeUndefined();
    expect(logs.join('\n')).toMatch(/can't chain/);
  });

  it('invalid ours throws and keeps the previous proxy', () => {
    const made: Fake[] = [];
    const h = host(made);
    h.applyUpstreamSettings({ url: 'http://a.example:1' });
    expect(() => h.applyUpstreamSettings({ url: 'http://a.example:1/x' })).toThrow();
    expect(h.upstreamProxy).toEqual({ url: 'http://a.example:1' });
  });

  it('an upstream proxy the new proxy rejects at start is logged; the start still succeeds', async () => {
    const logs: string[] = [];
    const calls: unknown[] = [];
    const h = new InterceptProxyHost({
      getPort: () => 9100,
      log: (m) => logs.push(m),
      factory: (opts) =>
        ({
          port: opts.port,
          start: async () => undefined,
          stop: async () => undefined,
          setRules: () => undefined,
          getExchanges: () => [],
          clear: () => undefined,
          resume: () => undefined,
          abort: () => undefined,
          on: () => undefined,
          setUpstreamProxy: (c: unknown) => {
            calls.push(c);
            if (c) throw new Error('Upstream proxy http://127.0.0.1:9100 is Flutter Intercept itself; that would loop');
          },
        }) as never,
    });
    h.setUpstreamProxy({ url: 'http://127.0.0.1:9100' }, 'http.proxy');
    await expect(h.start()).resolves.toBe(9100);
    expect(logs.join('\n')).toMatch(/upstream proxy not used: .*loop/);
    expect(calls.at(-1)).toBeUndefined();
  });
});

describe('bypass warnings (CONTRACTS §14.7)', () => {
  it('keeps kind bypass', () => {
    const h = host([]);
    h.setWarnings('s1', [{ id: 'bypass:s1:api.example.com', kind: 'bypass', text: 'requests to api.example.com bypass the proxy' }]);
    expect(h.warnings).toEqual([{ id: 'bypass:s1:api.example.com', kind: 'bypass', text: 'requests to api.example.com bypass the proxy', sessionId: 's1' }]);
  });
});
