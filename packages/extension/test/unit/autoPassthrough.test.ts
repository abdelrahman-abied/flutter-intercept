// CONTRACTS §20.7 (host + agents): `flutterIntercept.autoPassthrough` → InterceptProxyHost.setAutoPassthrough (option
// at start, setter while running, kept across restarts, event), Status.autoPassthrough (re-broadcast), texts that point
// to "Add client certificate…" for `needsClientCertificate`, agents' get_status / list_requests / get_request, HAR
// `_needsClientCertificate`, and the setting / tool descriptions in package.json.
import * as fs from 'fs';
import * as path from 'path';
import { EventEmitter } from 'events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Exchange, InterceptProxyOptions, Rule } from '@flutter-intercept/proxy';
import type { NetworkProfile } from '@flutter-intercept/proxy/network';
import { createAgentApi, type AgentApiDeps } from '../../src/agent/api';
import { buildHar } from '../../src/agent/har';
import { TOOL_DOCS } from '../../src/agent/schema';
import type { AppLauncher } from '../../src/agent/types';
import { InterceptProxyHost } from '../../src/proxyHost';
import { ControllerHost, InterceptController, tunnelReason, validateRules } from '../../src/ui/controller';
import type { HostMsg, Status, ViewMsg } from '../../src/ui/protocol';
import { withFakeProxy } from './proxy.fakes';

const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'package.json'), 'utf8')) as {
  contributes: { configuration: { properties: Record<string, { type?: string; default?: unknown; scope?: string; description?: string }> }; languageModelTools: { name: string; modelDescription: string }[] };
};

const needs: Exchange = {
  id: 'f1',
  startedAt: 10,
  method: 'GET',
  url: 'https://mtls.example/v1/me',
  requestHeaders: {},
  state: 'error',
  status: 502,
  error:
    "This server needs the app's own client certificate (TLS alert certificate_required). Automatic passthrough is off (flutterIntercept.autoPassthrough), so its requests keep failing through Flutter Intercept: add the certificate in the Flutter Intercept panel (Add client certificate…), or turn it on.",
  needsClientCertificate: { host: 'mtls.example', port: 443 },
};

describe('setting (package.json)', () => {
  it('boolean, default true, any scope, plain description', () => {
    const p = pkg.contributes.configuration.properties['flutterIntercept.autoPassthrough'];
    expect(p).toMatchObject({ type: 'boolean', default: true });
    expect(p.scope).toBeUndefined();
    expect(p.description).toBe(
      "Pass a server through without decryption when it needs the app's own client certificate or the app pins its certificate. Off: those requests keep failing until you add the certificate, and Flutter Intercept never tries the server on its own.",
    );
  });
});

describe('InterceptProxyHost.setAutoPassthrough (CONTRACTS §20.7)', () => {
  function makeHost() {
    const made: { opts: InterceptProxyOptions; calls: boolean[] }[] = [];
    const host = new InterceptProxyHost(
      withFakeProxy({
        getPort: () => 9100,
        canRestart: () => true,
        factory: (opts) => {
          const f = { opts, calls: [] as boolean[] };
          made.push(f);
          return { setAutoPassthrough: (on: boolean) => f.calls.push(on) };
        },
      }),
    );
    return { host, made };
  }

  it('default on: no option, no call; off before start → option + setter; kept across restarts; event once per change', async () => {
    const { host, made } = makeHost();
    const events: unknown[] = [];
    host.on('autoPassthrough', (on) => events.push(on));
    expect(host.autoPassthrough).toBe(true);
    host.setAutoPassthrough(true);
    expect(events).toEqual([]);
    await host.start();
    expect(made[0].opts).not.toHaveProperty('autoPassthrough');
    expect(made[0].calls).toEqual([]);
    host.setAutoPassthrough(false);
    host.setAutoPassthrough(false);
    expect(made[0].calls).toEqual([false]);
    expect(events).toEqual([false]);
    await host.stop();
    await host.start();
    expect(made[1].opts.autoPassthrough).toBe(false);
    expect(made[1].calls).toEqual([false]);
    host.setAutoPassthrough(true);
    expect(made[1].calls).toEqual([false, true]);
    expect(host.autoPassthrough).toBe(true);
    expect(events).toEqual([false, true]);
    await host.stop();
  });

  it('a failing setter is logged, never thrown', async () => {
    const logs: string[] = [];
    const host = new InterceptProxyHost(
      withFakeProxy({
        getPort: () => 9100,
        factory: () => ({
          setAutoPassthrough: () => {
            throw new Error('nope');
          },
        }),
        log: (m) => logs.push(m),
      }),
    );
    host.setAutoPassthrough(false);
    await host.start();
    expect(logs.join('\n')).toMatch(/automatic passthrough not applied: nope/);
    await host.stop();
  });
});

class FakeHost extends EventEmitter implements ControllerHost {
  running = true;
  port: number | undefined = 9123;
  exchanges: Exchange[] = [];
  rules: Rule[] = [];
  autoPassthrough?: boolean;
  getExchanges() {
    return this.exchanges.map((e) => ({ ...e }));
  }
  getRules() {
    return this.rules;
  }
  setRules(r: Rule[]) {
    this.rules = r;
  }
  clear() {}
  resume() {}
  abort() {}
}

const controllers: InterceptController[] = [];
afterEach(() => {
  while (controllers.length) controllers.pop()!.dispose();
});

describe('controller (CONTRACTS §20.7)', () => {
  function setup() {
    const host = new FakeHost();
    const c = new InterceptController({ host, saveRules: () => undefined, getEnabled: () => true, setEnabled: async () => undefined, throttleMs: 5 });
    controllers.push(c);
    const msgs: HostMsg[] = [];
    c.attach((m) => msgs.push(m));
    return { host, c, msgs };
  }
  const lastStatus = (msgs: HostMsg[]): Status | undefined => (msgs.filter((m) => m.type === 'status').at(-1) as { status: Status } | undefined)?.status;

  it('Status.autoPassthrough from the host, re-broadcast on its event; absent on an older host', () => {
    const { host, c, msgs } = setup();
    expect(c.status()).not.toHaveProperty('autoPassthrough');
    host.autoPassthrough = true;
    expect(c.status().autoPassthrough).toBe(true);
    host.autoPassthrough = false;
    host.emit('autoPassthrough', false);
    expect(lastStatus(msgs)?.autoPassthrough).toBe(false);
  });

  it('rules from a tunnel and tunnelReason point to "Add client certificate…" for needsClientCertificate too', async () => {
    const { host, c } = setup();
    const t: Exchange = { id: 't', startedAt: 1, kind: 'tunnel', method: 'CONNECT', url: 'https://mtls.example:443/', requestHeaders: {}, state: 'completed', needsClientCertificate: { host: 'mtls.example', port: 443 } };
    expect(tunnelReason(t)).toMatch(/own client certificate.*Add client certificate…/);
    host.exchanges = [t];
    const replies: HostMsg[] = [];
    await c.handle({ type: 'createRuleFromExchange', id: 't', action: 'mock' } as ViewMsg, (m) => replies.push(m));
    expect((replies[0] as { message: string }).message).toMatch(/app's own client certificate.*Add client certificate…/);
  });
});

describe('agents and HAR (CONTRACTS §20.7)', () => {
  class AgentHost extends EventEmitter {
    running = true;
    port: number | undefined = 8899;
    exchanges: Exchange[] = [];
    rules: Rule[] = [];
    autoPassthrough?: boolean;
    getExchanges() {
      return this.exchanges.map((e) => ({ ...e }));
    }
    getRules() {
      return this.rules;
    }
    resume() {}
    abort() {}
    networkProfile: NetworkProfile = { kind: 'none' };
    setNetworkProfile(p: NetworkProfile) {
      this.networkProfile = p;
    }
  }
  function setup() {
    const host = new AgentHost();
    const launcher = { launch: vi.fn(), stop: vi.fn(), hotRestart: vi.fn(), sessions: () => [] } as unknown as AppLauncher;
    const deps: AgentApiDeps = {
      host: host as unknown as AgentApiDeps['host'],
      applyRules: (rules) => {
        host.rules = validateRules(rules);
      },
      clear: () => undefined,
      getSettings: () => ({ access: 'readWrite', redactSecrets: true, interceptEnabled: true }),
      launcher,
      projectRoot: () => '/ws/app',
      now: () => 50_000,
    };
    return { api: createAgentApi(deps), host };
  }

  it('get_status shows autoPassthrough; list_requests / get_request show needsClientCertificate', async () => {
    const { api, host } = setup();
    expect(await api.call('get_status', {})).not.toHaveProperty('autoPassthrough');
    host.autoPassthrough = false;
    expect(await api.call('get_status', {})).toMatchObject({ autoPassthrough: false });
    host.exchanges = [needs];
    const list = (await api.call('list_requests', {})) as { items: Record<string, unknown>[] };
    expect(list.items[0].needsClientCertificate).toEqual({ host: 'mtls.example', port: 443 });
    expect(list.items[0]).not.toHaveProperty('learnedPassthrough');
    const d = (await api.call('get_request', { id: 'f1' })) as Record<string, unknown>;
    expect(d.needsClientCertificate).toEqual({ host: 'mtls.example', port: 443 });
    expect(d.error).toBe(needs.error);
  });

  it('HAR: _needsClientCertificate', () => {
    const har = buildHar([needs], { redact: true }) as { log: { entries: Record<string, unknown>[] } };
    expect(har.log.entries[0]._needsClientCertificate).toEqual({ host: 'mtls.example', port: 443 });
  });

  it('descriptions (schema.ts = package.json)', () => {
    expect(TOOL_DOCS.get_status.model).toMatch(/autoPassthrough: false = automatic passthrough is off/);
    expect(TOOL_DOCS.list_requests.model).toMatch(/needsClientCertificate \{host, port\}/);
    expect(TOOL_DOCS.get_request.model).toMatch(/needsClientCertificate \{host, port\}/);
    for (const tool of ['get_status', 'list_requests', 'get_request'] as const) {
      expect(pkg.contributes.languageModelTools.find((x) => x.name === `flutter_intercept_${tool}`)?.modelDescription).toBe(TOOL_DOCS[tool].model);
    }
  });
});
