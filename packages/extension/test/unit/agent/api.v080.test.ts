// CONTRACTS §14 (v0.8.0) agent side: tunnels (list_requests kind "tunnel", get_request explains, get_frames / resend
// refused), clientCertificate pattern, get_status (tlsPassthrough, clientCertificates, upstreamProxySource),
// save_recording with WebSocket / SSE, multipart bodies parsed and redacted in get_request.
import { EventEmitter } from 'events';
import { describe, expect, it, vi } from 'vitest';
import type { Exchange, Rule } from '@flutter-intercept/proxy';
import { createAgentApi, type AgentApiDeps } from '../../../src/agent/api';
import { parseToolInput } from '../../../src/agent/schema';
import { AgentToolError, type AppLauncher } from '../../../src/agent/types';
import type { Recording, RecordingMeta, RecordingService } from '../../../src/recordings/types';
import { validateRules } from '../../../src/ui/controller';

class FakeHost extends EventEmitter {
  running = true;
  port: number | undefined = 8899;
  exchanges: Exchange[] = [];
  rules: Rule[] = [];
  upstreamProxyInfo?: { display: string; ignoreCertErrors: boolean };
  upstreamProxySource?: 'flutterIntercept' | 'http.proxy';
  tlsPassthrough?: string[];
  clientCertificateStatus?: { host: string; problem?: string }[];
  getExchanges() {
    return this.exchanges.map((e) => ({ ...e }));
  }
  getRules() {
    return this.rules;
  }
  resume() {}
  abort() {}
}

class FakeRecordings {
  saves: { name: string; ids: string[]; redact?: boolean }[] = [];
  metas: RecordingMeta[] = [];
  async list() {
    return this.metas;
  }
  async save(name: string, exchanges: Exchange[], opts?: { redact?: boolean }): Promise<RecordingMeta> {
    this.saves.push({ name, ids: exchanges.map((e) => e.id), redact: opts?.redact });
    const streams = exchanges.filter((e) => e.kind === 'websocket' || e.kind === 'sse');
    const m: RecordingMeta = {
      id: 'rec',
      name,
      createdAt: 1,
      exchanges: exchanges.length,
      path: '/ws/app/.dart_tool/flutter_intercept/recordings/rec.json',
      redacted: !!opts?.redact,
      ...(streams.length ? { streams: streams.length, frames: streams.reduce((n, e) => n + (e.frames?.length ?? 0), 0) } : {}),
    };
    this.metas = [m];
    return m;
  }
  async load(): Promise<Recording> {
    throw new Error('no');
  }
}

let seq = 0;
const ex = (over: Partial<Exchange> = {}): Exchange => ({
  id: `x${++seq}`,
  startedAt: 1000 + seq,
  method: 'GET',
  url: `https://api.example.com/v1/users/${seq}`,
  requestHeaders: {},
  state: 'completed',
  status: 200,
  ...over,
});
const tunnel = (over: Partial<Exchange> = {}): Exchange =>
  ex({ kind: 'tunnel', method: 'CONNECT', url: 'https://pinned.bank.example:443/', status: undefined, tunnelBytes: { sent: 1500, received: 9000 }, timings: { connectMs: 12 }, ...over });

function setup(opts: { redact?: boolean } = {}) {
  const host = new FakeHost();
  const recordings = new FakeRecordings();
  const launcher = { launch: vi.fn(), stop: vi.fn(), hotRestart: vi.fn(), sessions: () => [] } as unknown as AppLauncher;
  let idn = 0;
  const deps: AgentApiDeps = {
    host: host as unknown as AgentApiDeps['host'],
    applyRules: (rules) => {
      host.rules = validateRules(rules);
    },
    clear: () => undefined,
    getSettings: () => ({ access: 'readWrite', redactSecrets: opts.redact ?? true, interceptEnabled: true }),
    launcher,
    projectRoot: () => '/ws/app',
    newRuleId: () => `agent_${++idn}`,
    now: () => 50_000,
    recordings: recordings as unknown as RecordingService,
    recordingsChanged: () => undefined,
  };
  return { api: createAgentApi(deps), host, recordings };
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

describe('tunnels (CONTRACTS §14.2)', () => {
  it('list_requests kind "tunnel" (schema accepts it) and summaries say notDecrypted with byte counts', async () => {
    const { api, host } = setup();
    const t = tunnel({ id: 't1' });
    host.exchanges = [ex({ id: 'h1' }), t, ex({ id: 'w1', kind: 'websocket', status: 101 })];
    expect(parseToolInput('list_requests', { kind: 'tunnel' })).toMatchObject({ kind: 'tunnel' });
    const r = (await api.call('list_requests', { kind: 'tunnel' })) as { items: Record<string, unknown>[]; total: number };
    expect(r.total).toBe(1);
    expect(r.items[0]).toMatchObject({ id: 't1', method: 'CONNECT', kind: 'tunnel', notDecrypted: true, bytesSent: 1500, bytesReceived: 9000 });
    expect(r.items[0]).not.toHaveProperty('status');
    const httpOnly = (await api.call('list_requests', { kind: 'http' })) as { items: { id: string }[] };
    expect(httpOnly.items.map((i) => i.id)).toEqual(['h1']);
  });

  it('get_request explains why nothing is decrypted; no frameCount; get_frames and resend refused', async () => {
    const { api, host } = setup();
    host.exchanges = [tunnel({ id: 't1' }), tunnel({ id: 't2', state: 'pending', tunnelBytes: undefined })];
    const d = (await api.call('get_request', { id: 't1' })) as Record<string, any>;
    expect(d.tunnel.notDecrypted).toMatch(/pinned\.bank\.example was passed through without decryption.*flutterIntercept\.tlsPassthrough/);
    expect(d.tunnel).toMatchObject({ bytesSent: 1500, bytesReceived: 9000 });
    expect(d).not.toHaveProperty('frameCount');
    expect(d.timings).toEqual({ connectMs: 12 });
    const open = (await api.call('get_request', { id: 't2' })) as Record<string, any>;
    expect(open.tunnel).toMatchObject({ bytesSent: 0, bytesReceived: 0 });
    await rejectsWith(api.call('get_frames', { id: 't1' }), /passed through without decryption.*no messages/, 'invalid');
    await rejectsWith(api.call('resend_request', { id: 't1' }), /passed through without decryption/);
  });

  it('clientCertificate pattern on exchanges', async () => {
    const { api, host } = setup();
    host.exchanges = [ex({ id: 'm1', clientCertificate: '*.corp.example' })];
    const d = (await api.call('get_request', { id: 'm1' })) as Record<string, unknown>;
    expect(d.clientCertificate).toBe('*.corp.example');
    const l = (await api.call('list_requests', {})) as { items: Record<string, unknown>[] };
    expect(l.items[0].clientCertificate).toBe('*.corp.example');
  });
});

describe('get_status (CONTRACTS §14)', () => {
  it('lists passthrough hosts, client certificates (patterns + problems) and the upstream source', async () => {
    const { api, host } = setup();
    let s = (await api.call('get_status', {})) as Record<string, unknown>;
    expect(s).not.toHaveProperty('tlsPassthrough');
    expect(s).not.toHaveProperty('clientCertificates');
    host.upstreamProxyInfo = { display: 'corp.example:3128', ignoreCertErrors: false };
    host.upstreamProxySource = 'http.proxy';
    host.tlsPassthrough = ['*.bank.example', 'pinned.example'];
    host.clientCertificateStatus = [{ host: 'api.corp.example' }, { host: '*.x.example', problem: 'Client certificate for *.x.example: it needs a passphrase (run "Flutter Intercept: Set Client Certificate Passphrase…").' }];
    s = (await api.call('get_status', {})) as Record<string, unknown>;
    expect(s).toMatchObject({
      upstreamProxy: 'corp.example:3128',
      upstreamProxySource: 'http.proxy',
      tlsPassthrough: ['*.bank.example', 'pinned.example'],
      clientCertificates: [
        { host: 'api.corp.example', loaded: true },
        { host: '*.x.example', loaded: false, problem: expect.stringMatching(/needs a passphrase/) },
      ],
    });
  });
});

describe('save_recording with streams (CONTRACTS §14.5)', () => {
  it('includes finished WebSocket / SSE exchanges, never tunnels or open streams; returns stream counts', async () => {
    const { api, host, recordings } = setup();
    const frames = [{ dir: 'receive', at: 1, kind: 'text', size: 2, text: 'hi' }] as Exchange['frames'];
    host.exchanges = [
      ex({ id: 'a' }),
      ex({ id: 'ws', kind: 'websocket', status: 101, frames }),
      ex({ id: 'sse', kind: 'sse', frames }),
      tunnel({ id: 't' }),
      ex({ id: 'open', kind: 'websocket', status: 101, state: 'pending' }),
    ];
    const r = (await api.call('save_recording', { name: 'with streams' })) as Record<string, unknown>;
    expect(recordings.saves[0].ids).toEqual(['a', 'ws', 'sse']);
    expect(r).toMatchObject({ exchanges: 3, streams: 2, frames: 2 });
    const list = (await api.call('list_recordings', {})) as { recordings: Record<string, unknown>[] };
    expect(list.recordings[0]).toMatchObject({ streams: 2, frames: 2 });
    host.exchanges = [tunnel({ id: 't' })];
    await rejectsWith(api.call('save_recording', { name: 'x' }), /no finished HTTP request, WebSocket or SSE stream.*TLS tunnels/, 'not_found');
  });
});

describe('multipart bodies in get_request (CONTRACTS §14.6)', () => {
  const B = 'fi-boundary-42';
  const SECRET = ['s3', 'cr', '3t', '-pw'].join('');
  const raw = Buffer.concat([
    Buffer.from(`--${B}\r\nContent-Disposition: form-data; name="password"\r\n\r\n${SECRET}\r\n`),
    Buffer.from(`--${B}\r\nContent-Disposition: form-data; name="photo"; filename="cat.jpg"\r\nContent-Type: image/jpeg\r\n\r\n`),
    Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00]),
    Buffer.from(`\r\n--${B}--\r\n`),
  ]);
  const headers = { 'content-type': `multipart/form-data; boundary=${B}` };

  it('binary-recorded multipart: parsed and redacted (redaction on); summarised as binary when off', async () => {
    const { api, host } = setup();
    host.exchanges = [ex({ id: 'u1', method: 'POST', requestHeaders: headers, requestBody: { text: raw.toString('base64'), encoding: 'base64' } })];
    const d = (await api.call('get_request', { id: 'u1' })) as Record<string, any>;
    expect(d.requestBody.multipart).toBe(true);
    expect(d.requestBody.text).toContain('[file cat.jpg, 5 bytes]');
    expect(d.requestBody.text).toContain('[redacted]');
    expect(JSON.stringify(d)).not.toContain(SECRET);
    const off = setup({ redact: false });
    off.host.exchanges = host.exchanges;
    const d2 = (await off.api.call('get_request', { id: 'u1' })) as Record<string, any>;
    expect(d2.requestBody).toMatchObject({ binary: true, bytes: raw.length });
  });

  it('text multipart is redacted by field', async () => {
    const { api, host } = setup();
    const text = `--${B}\r\nContent-Disposition: form-data; name="client_secret"\r\n\r\n${SECRET}\r\n--${B}\r\nContent-Disposition: form-data; name="title"\r\n\r\nhello\r\n--${B}--\r\n`;
    host.exchanges = [ex({ id: 'u2', method: 'POST', requestHeaders: headers, requestBody: { text, encoding: 'utf8' } })];
    const d = (await api.call('get_request', { id: 'u2' })) as Record<string, any>;
    expect(d.requestBody.text).toContain('name="title"\r\n\r\nhello');
    expect(d.requestBody.text).not.toContain(SECRET);
  });
});
