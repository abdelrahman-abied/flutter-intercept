// CONTRACTS §20.2 (v0.14.0) agent side: get_status / list_requests / get_request show learnedPassthrough, HAR carries
// `_learnedPassthrough`, the tool descriptions say so, and no agent tool adds, removes or reads client certificates or
// forgets learned hosts.
import * as fs from 'fs';
import * as path from 'path';
import { EventEmitter } from 'events';
import { describe, expect, it, vi } from 'vitest';
import type { Exchange, Rule } from '@flutter-intercept/proxy';
import type { NetworkProfile } from '@flutter-intercept/proxy/network';
import { createAgentApi, type AgentApiDeps } from '../../../src/agent/api';
import { buildHar } from '../../../src/agent/har';
import { ALL_TOOLS, TOOL_DOCS } from '../../../src/agent/schema';
import { AGENT_MAX_LEARNED } from '../../../src/agent/views';
import type { AppLauncher } from '../../../src/agent/types';
import { validateRules } from '../../../src/ui/controller';

class FakeHost extends EventEmitter {
  running = true;
  port: number | undefined = 8899;
  exchanges: Exchange[] = [];
  rules: Rule[] = [];
  learnedPassthrough?: { host: string; port: number; reason: 'client-certificate' | 'pinned'; until?: number }[];
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
  const host = new FakeHost();
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

const ERROR = 'This server needs the app\'s own client certificate (TLS alert certificate_required). From now on mtls.example is passed through without decryption, so the app talks to it directly with its own certificate. To see these requests, add the certificate in the Flutter Intercept panel (Add client certificate…).';
const failed: Exchange = {
  id: 'f1',
  startedAt: 10,
  method: 'GET',
  url: 'https://mtls.example/v1/me',
  requestHeaders: {},
  state: 'error',
  status: 502,
  error: ERROR,
  learnedPassthrough: { reason: 'client-certificate', host: 'mtls.example', port: 443 },
};
const tunnel: Exchange = {
  id: 't1',
  startedAt: 20,
  kind: 'tunnel',
  method: 'CONNECT',
  url: 'https://mtls.example:443/',
  requestHeaders: {},
  state: 'completed',
  tunnelBytes: { sent: 900, received: 4000 },
  notes: ["This server needs the app's own certificate: passed through without decryption."],
  learnedPassthrough: { reason: 'client-certificate', host: 'mtls.example', port: 443 },
};

describe('learned passthrough for agents (CONTRACTS §20.2)', () => {
  it('get_status lists the learned hosts (until as ISO time, or untilProxyStops); capped', async () => {
    const { api, host } = setup();
    expect(await api.call('get_status', {})).not.toHaveProperty('learnedPassthrough');
    host.learnedPassthrough = [
      { host: 'mtls.example', port: 443, reason: 'client-certificate' },
      { host: 'pinned.example', port: 443, reason: 'pinned', until: Date.UTC(2026, 0, 1) },
    ];
    const s = (await api.call('get_status', {})) as Record<string, unknown>;
    expect(s.learnedPassthrough).toEqual([
      { host: 'mtls.example', port: 443, reason: 'client-certificate', untilProxyStops: true },
      { host: 'pinned.example', port: 443, reason: 'pinned', until: '2026-01-01T00:00:00.000Z' },
    ]);
    host.learnedPassthrough = Array.from({ length: 1000 }, (_, i) => ({ host: `h${i}.example`, port: 443, reason: 'pinned' as const, until: 1 }));
    const big = (await api.call('get_status', {})) as { learnedPassthrough: unknown[]; learnedPassthroughTotal: number };
    expect(big.learnedPassthrough).toHaveLength(AGENT_MAX_LEARNED);
    expect(big.learnedPassthroughTotal).toBe(1000);
  });

  it('list_requests and get_request carry learnedPassthrough; the tunnel explains itself', async () => {
    const { api, host } = setup();
    host.exchanges = [failed, tunnel];
    const list = (await api.call('list_requests', {})) as { items: Record<string, unknown>[] };
    expect(list.items.map((i) => i.learnedPassthrough)).toEqual([
      { reason: 'client-certificate', host: 'mtls.example', port: 443 },
      { reason: 'client-certificate', host: 'mtls.example', port: 443 },
    ]);
    const f = (await api.call('get_request', { id: 'f1' })) as Record<string, any>;
    expect(f.error).toBe(ERROR);
    expect(f.learnedPassthrough).toEqual({ reason: 'client-certificate', host: 'mtls.example', port: 443 });
    const t = (await api.call('get_request', { id: 't1' })) as Record<string, any>;
    expect(t.tunnel.notDecrypted).toMatch(/own client certificate.*Add client certificate…/);
    expect(t.notes).toEqual(tunnel.notes);
  });

  it('HAR: _learnedPassthrough', () => {
    const har = buildHar([failed], { redact: true }) as any;
    expect(har.log.entries[0]._learnedPassthrough).toEqual({ reason: 'client-certificate', host: 'mtls.example', port: 443 });
  });

  it('descriptions mention it; no tool adds / removes / reads certificates or forgets learned hosts', () => {
    expect(TOOL_DOCS.get_status.model).toMatch(/learnedPassthrough.*Agents cannot add, remove or read client certificates, nor forget learned hosts/);
    expect(TOOL_DOCS.list_requests.model).toMatch(/learnedPassthrough/);
    expect(TOOL_DOCS.get_request.model).toMatch(/learnedPassthrough/);
    for (const t of ALL_TOOLS) expect(t, t).not.toMatch(/cert|forget|learned|passphrase/i);
    const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', '..', 'package.json'), 'utf8')) as { contributes: { languageModelTools: { name: string; modelDescription: string }[] } };
    for (const tool of ['get_status', 'list_requests', 'get_request'] as const) {
      expect(pkg.contributes.languageModelTools.find((x) => x.name === `flutter_intercept_${tool}`)?.modelDescription).toBe(TOOL_DOCS[tool].model);
    }
  });
});
