// CONTRACTS §14 (v0.8.0) controller: Status.upstreamProxySource / tlsPassthrough / clientCertificates (re-broadcast on
// host events), tunnel exchanges (block-only rules, no resend), WebSocket / SSE recordable, recording summaries with
// stream counts.
import { EventEmitter } from 'events';
import { afterEach, describe, expect, it } from 'vitest';
import type { Exchange, ReplayEntry, Rule } from '@flutter-intercept/proxy';
import type { Recording, RecordingMeta, RecordingService } from '../../src/recordings/types';
import { ControllerDeps, ControllerHost, InterceptController, isRecordable, recordingSummary, tunnelBlockRule, tunnelReason } from '../../src/ui/controller';
import type { HostMsg, Status } from '../../src/ui/protocol';

class FakeHost extends EventEmitter implements ControllerHost {
  running = true;
  port: number | undefined = 9123;
  exchanges: Exchange[] = [];
  rules: Rule[] = [];
  upstreamProxyInfo?: { display: string; ignoreCertErrors: boolean };
  upstreamProxySource?: 'flutterIntercept' | 'http.proxy';
  tlsPassthrough?: string[];
  clientCertificateStatus?: { host: string; problem?: string }[];
  sent: unknown[] = [];
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
  async send(req: unknown) {
    this.sent.push(req);
    return { id: 'sent1' };
  }
}

class FakeRecordings {
  saves: { name: string; ids: string[] }[] = [];
  metas: RecordingMeta[] = [];
  async list() {
    return this.metas;
  }
  async save(name: string, exchanges: Exchange[]): Promise<RecordingMeta> {
    this.saves.push({ name, ids: exchanges.map((e) => e.id) });
    const m: RecordingMeta = { id: 'r', name, createdAt: 1, exchanges: exchanges.length, path: '/p/r.json', redacted: false };
    this.metas = [m];
    return m;
  }
  async load(): Promise<Recording> {
    throw new Error('no');
  }
  async remove() {}
  async export(_id: string, d: string) {
    return d;
  }
  toReplay(): ReplayEntry[] {
    return [];
  }
  diff() {
    return [];
  }
  diffText() {
    return '';
  }
}

const tunnel = (id: string, extra: Partial<Exchange> = {}): Exchange => ({
  id,
  startedAt: 1,
  kind: 'tunnel',
  method: 'CONNECT',
  url: 'https://pinned.bank.example:443/',
  requestHeaders: {},
  state: 'completed',
  tunnelBytes: { sent: 1200, received: 5400 },
  ...extra,
});
const http = (id: string, extra: Partial<Exchange> = {}): Exchange => ({
  id,
  startedAt: 1,
  method: 'GET',
  url: 'https://api.example.com/x',
  requestHeaders: {},
  state: 'completed',
  status: 200,
  ...extra,
});

const controllers: InterceptController[] = [];
afterEach(() => {
  while (controllers.length) controllers.pop()!.dispose();
});

function setup(extra: Partial<ControllerDeps> = {}) {
  const host = new FakeHost();
  let n = 0;
  const c = new InterceptController({ host, saveRules: () => undefined, getEnabled: () => true, setEnabled: async () => undefined, throttleMs: 5, newRuleId: () => `r${++n}`, ...extra });
  controllers.push(c);
  const msgs: HostMsg[] = [];
  c.attach((m) => msgs.push(m));
  const replies: HostMsg[] = [];
  return { host, c, msgs, replies, reply: (m: HostMsg) => replies.push(m) };
}
const errors = (msgs: HostMsg[]) => msgs.filter((m): m is Extract<HostMsg, { type: 'error' }> => m.type === 'error').map((m) => m.message);
const lastStatus = (msgs: HostMsg[]): Status | undefined => (msgs.filter((m) => m.type === 'status').at(-1) as { status: Status } | undefined)?.status;

describe('Status: upstream source, passthrough hosts, client certificates (CONTRACTS §14)', () => {
  it('reports what the host has, and nothing when empty', () => {
    const { host, c } = setup();
    expect(c.status()).not.toHaveProperty('tlsPassthrough');
    expect(c.status()).not.toHaveProperty('clientCertificates');
    expect(c.status()).not.toHaveProperty('upstreamProxySource');
    host.upstreamProxySource = 'http.proxy'; // without a proxy in use: not shown
    expect(c.status()).not.toHaveProperty('upstreamProxySource');
    host.upstreamProxyInfo = { display: 'corp.example:3128', ignoreCertErrors: false };
    host.tlsPassthrough = ['*.bank.example'];
    host.clientCertificateStatus = [{ host: 'api.corp.example' }, { host: '*.x.example', problem: 'Client certificate for *.x.example: its pfx file was not found.' }];
    expect(c.status()).toMatchObject({
      upstreamProxy: 'corp.example:3128',
      upstreamProxySource: 'http.proxy',
      tlsPassthrough: ['*.bank.example'],
      clientCertificates: [{ host: 'api.corp.example' }, { host: '*.x.example', problem: 'Client certificate for *.x.example: its pfx file was not found.' }],
    });
  });

  it('re-broadcasts status on the host events', () => {
    const { host, msgs } = setup();
    host.tlsPassthrough = ['a.example'];
    host.emit('tlsPassthrough', ['a.example']);
    expect(lastStatus(msgs)?.tlsPassthrough).toEqual(['a.example']);
    host.clientCertificateStatus = [{ host: 'b.example' }];
    host.emit('clientCertificates', host.clientCertificateStatus);
    expect(lastStatus(msgs)?.clientCertificates).toEqual([{ host: 'b.example' }]);
  });
});

describe('tunnel exchanges (CONTRACTS §14.2)', () => {
  it('block rule from a tunnel: the recorded authority, any method; mock / breakpoint refused', async () => {
    const { host, c, replies, reply } = setup();
    host.exchanges = [tunnel('t1'), tunnel('t2', { url: 'https://other.example/', state: 'pending' })];
    await c.handle({ type: 'createRuleFromExchange', id: 't1', action: 'block' }, reply);
    expect(errors(replies)).toEqual([]);
    expect(host.rules[0]).toMatchObject({ enabled: true, match: { url: 'https://pinned.bank.example:443/*' }, action: { kind: 'block', mode: 'status', status: 403 } });
    expect(host.rules[0].match.method).toBeUndefined();
    await c.handle({ type: 'createRuleFromExchange', id: 't2', action: 'block' }, reply); // still open: fine
    expect(host.rules[0].match.url).toBe('https://other.example/*');
    await c.handle({ type: 'createRuleFromExchange', id: 't1', action: 'mock' }, reply);
    await c.handle({ type: 'createRuleFromExchange', id: 't1', action: 'breakpoint' }, reply);
    expect(errors(replies)).toHaveLength(2);
    expect(errors(replies)[0]).toMatch(/passed-through TLS connection.*only be blocked/);
  });

  it('cannot be resent', async () => {
    const { host, c, replies, reply } = setup();
    host.exchanges = [tunnel('t1')];
    await c.handle({ type: 'send', request: { method: 'GET', url: 'https://pinned.bank.example/', headers: {} }, resentFrom: 't1' } as never, reply);
    expect(errors(replies)[0]).toMatch(/Can't resend a passed-through TLS connection/);
    expect(host.sent).toEqual([]);
  });

  it('tunnelReason / tunnelBlockRule', () => {
    expect(tunnelReason(http('h'))).toBeUndefined();
    expect(tunnelReason(tunnel('t'))).toMatch(/to pinned\.bank\.example was passed through without decryption.*tlsPassthrough/);
    expect(tunnelBlockRule(tunnel('t', { url: 'https://h.example/' }), 'x').name).toBe('block h.example (TLS passthrough)');
    expect(() => tunnelBlockRule(tunnel('t', { url: 'not a url' }), 'x')).toThrow(/not a URL/);
  });
});

describe('recordings with streams (CONTRACTS §14.5)', () => {
  it('isRecordable: finished HTTP / WebSocket (101) / SSE; not open streams, refused upgrades, tunnels', () => {
    expect(isRecordable(http('a', { kind: 'sse' }))).toBe(true);
    expect(isRecordable(http('a', { kind: 'websocket', status: 101 }))).toBe(true);
    expect(isRecordable(http('a', { kind: 'websocket', status: 101, state: 'pending' }))).toBe(false);
    expect(isRecordable(http('a', { kind: 'websocket', status: 403 }))).toBe(false);
    expect(isRecordable(tunnel('t'))).toBe(false);
  });

  it('saveRecording: default includes finished streams, never tunnels; ids may name streams', async () => {
    const recordings = new FakeRecordings();
    const { host, c, replies, reply } = setup({ recordings: recordings as unknown as RecordingService });
    host.exchanges = [http('a'), http('ws', { kind: 'websocket', status: 101 }), http('sse', { kind: 'sse' }), tunnel('t'), http('open', { kind: 'websocket', status: 101, state: 'pending' })];
    await c.handle({ type: 'saveRecording', name: 'all' }, reply);
    await c.handle({ type: 'saveRecording', name: 'ws only', ids: ['ws', 't'] }, reply);
    expect(errors(replies)).toEqual([]);
    expect(recordings.saves).toEqual([
      { name: 'all', ids: ['a', 'ws', 'sse'] },
      { name: 'ws only', ids: ['ws'] },
    ]);
    await c.handle({ type: 'saveRecording', name: 'nothing', ids: ['t'] }, reply);
    expect(errors(replies)[0]).toMatch(/no finished HTTP request, WebSocket or SSE stream/);
  });

  it('recordingSummary carries streams / frames when present', () => {
    const m: RecordingMeta = { id: 'r', name: 'n', createdAt: 1, exchanges: 3, path: '/p', redacted: true };
    expect(recordingSummary(m)).toEqual({ id: 'r', name: 'n', createdAt: 1, exchanges: 3, redacted: true });
    expect(recordingSummary({ ...m, streams: 2, frames: 40 })).toEqual({ id: 'r', name: 'n', createdAt: 1, exchanges: 3, redacted: true, streams: 2, frames: 40 });
    expect(recordingSummary({ ...m, streams: 0, frames: 0 })).not.toHaveProperty('streams');
  });
});
