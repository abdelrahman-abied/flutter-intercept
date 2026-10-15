// CONTRACTS §20 (v0.14.0) host side: Status.learnedPassthrough (re-broadcast on the host event), the panel's client
// certificate messages (strict validation, tokens bound to the view they were issued to, no clientCertUi → error),
// forgetLearnedPassthrough, tunnel texts for learned hosts, and InterceptProxyHost's learned list / event / forget.
import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Exchange, InterceptProxyOptions, Rule } from '@flutter-intercept/proxy';
import { InterceptProxyHost, learnedPassthroughView } from '../../src/proxyHost';
import { CLIENT_CERT_UI_MISSING, ControllerDeps, ControllerHost, InterceptController, STATUS_MAX_LEARNED, tunnelReason } from '../../src/ui/controller';
import { CERT_TOKEN_EXPIRED, type ClientCertUi } from '../../src/ui/clientCertUi';
import { learnedKeyOf } from '../../src/ui/handlers';
import type { HostMsg, Status, ViewMsg } from '../../src/ui/protocol';
import { withFakeProxy } from './proxy.fakes';

type Learned = NonNullable<Status['learnedPassthrough']>;

class FakeHost extends EventEmitter implements ControllerHost {
  running = true;
  port: number | undefined = 9123;
  exchanges: Exchange[] = [];
  rules: Rule[] = [];
  learnedPassthrough?: Learned;
  forgotten: (string | undefined)[] = [];
  forgetLearnedPassthrough?: (key?: string) => void = (key) => {
    this.forgotten.push(key);
  };
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

/** A ClientCertUi double: tokens tN, records calls (the passphrase only to check it arrives). */
class FakeUi implements ClientCertUi {
  n = 0;
  adds: Parameters<ClientCertUi['add']>[0][] = [];
  removed: string[] = [];
  next: { problem?: string } = {};
  chooseResult: 'file' | 'cancel' | 'throw' = 'file';
  async choose() {
    if (this.chooseResult === 'cancel') return undefined;
    if (this.chooseResult === 'throw') throw new Error('The pfx file is larger than 1 MB.');
    return { token: `tok_${String(++this.n).padStart(20, '0')}`, name: 'client.p12' };
  }
  async add(req: Parameters<ClientCertUi['add']>[0]) {
    this.adds.push(req);
    return this.next;
  }
  cancelRemove = false;
  async remove(host: string) {
    this.removed.push(host);
    return this.cancelRemove ? { cancelled: true as const } : {};
  }
}

const controllers: InterceptController[] = [];
afterEach(() => {
  while (controllers.length) controllers.pop()!.dispose();
});

function setup(extra: Partial<ControllerDeps> = {}) {
  const host = new FakeHost();
  const logs: string[] = [];
  const c = new InterceptController({ host, saveRules: () => undefined, getEnabled: () => true, setEnabled: async () => undefined, throttleMs: 5, log: (m) => logs.push(m), ...extra });
  controllers.push(c);
  const msgs: HostMsg[] = [];
  c.attach((m) => msgs.push(m));
  const replies: HostMsg[] = [];
  const reply = (m: HostMsg) => replies.push(m);
  return { host, c, msgs, replies, reply, logs };
}
const errors = (msgs: HostMsg[]) => msgs.filter((m): m is Extract<HostMsg, { type: 'error' }> => m.type === 'error').map((m) => m.message);
const lastStatus = (msgs: HostMsg[]): Status | undefined => (msgs.filter((m) => m.type === 'status').at(-1) as { status: Status } | undefined)?.status;
const send = (c: InterceptController, msg: unknown, reply: (m: HostMsg) => void) => c.handle(msg as ViewMsg, reply);

describe('Status.learnedPassthrough (CONTRACTS §20.2)', () => {
  it('from the host, re-broadcast on its event; absent when empty; capped', () => {
    const { host, c, msgs } = setup();
    expect(c.status()).not.toHaveProperty('learnedPassthrough');
    host.learnedPassthrough = [
      { host: 'mtls.example', port: 443, reason: 'client-certificate' },
      { host: 'pinned.example', port: 8443, reason: 'pinned', until: 99_000 },
    ];
    host.emit('learnedPassthrough', host.learnedPassthrough);
    expect(lastStatus(msgs)?.learnedPassthrough).toEqual([
      { host: 'mtls.example', port: 443, reason: 'client-certificate' },
      { host: 'pinned.example', port: 8443, reason: 'pinned', until: 99_000 },
    ]);
    host.learnedPassthrough = Array.from({ length: 1000 }, (_, i) => ({ host: `h${i}.example`, port: 443, reason: 'pinned' as const, until: 1 }));
    expect(c.status().learnedPassthrough).toHaveLength(STATUS_MAX_LEARNED);
  });
});

describe('client certificate messages (CONTRACTS §20.3)', () => {
  it('without clientCertUi: an error for each of them', async () => {
    const { c, reply, replies } = setup();
    await send(c, { type: 'chooseClientCertificateFile', role: 'pfx' }, reply);
    await send(c, { type: 'addClientCertificate', host: 'a.example', pfx: 'A'.repeat(24) }, reply);
    await send(c, { type: 'removeClientCertificate', host: 'a.example' }, reply);
    expect(errors(replies)).toEqual([CLIENT_CERT_UI_MISSING, CLIENT_CERT_UI_MISSING, CLIENT_CERT_UI_MISSING]);
  });

  it('choose → clientCertificateFile with token + name; cancel → neither; a problem → problem', async () => {
    const ui = new FakeUi();
    const { c, reply, replies } = setup({ clientCertUi: ui });
    await send(c, { type: 'chooseClientCertificateFile', role: 'pfx' }, reply);
    ui.chooseResult = 'cancel';
    await send(c, { type: 'chooseClientCertificateFile', role: 'cert' }, reply);
    ui.chooseResult = 'throw';
    await send(c, { type: 'chooseClientCertificateFile', role: 'key' }, reply);
    expect(replies).toEqual([
      { type: 'clientCertificateFile', role: 'pfx', file: { token: 'tok_00000000000000000001', name: 'client.p12' } },
      { type: 'clientCertificateFile', role: 'cert' },
      { type: 'clientCertificateFile', role: 'key', problem: 'The pfx file is larger than 1 MB.' },
    ]);
  });

  it('add: tokens must come from this view; the answer is clientCertificateSaved; tokens used up on success', async () => {
    const ui = new FakeUi();
    const { c, reply, replies } = setup({ clientCertUi: ui });
    const other: HostMsg[] = [];
    await send(c, { type: 'chooseClientCertificateFile', role: 'pfx' }, reply);
    const token = (replies[0] as Extract<HostMsg, { type: 'clientCertificateFile' }>).file!.token;
    const pass = ['p', String(Date.now())].join('');
    // another view can't use it
    await send(c, { type: 'addClientCertificate', host: 'a.example', pfx: token }, (m) => other.push(m));
    expect(other).toEqual([{ type: 'clientCertificateSaved', host: 'a.example', problem: CERT_TOKEN_EXPIRED }]);
    expect(ui.adds).toEqual([]);
    // a problem keeps the token
    ui.next = { problem: 'The passphrase is wrong.' };
    await send(c, { type: 'addClientCertificate', host: 'a.example', pfx: token, passphrase: pass }, reply);
    ui.next = {};
    await send(c, { type: 'addClientCertificate', host: 'a.example', pfx: token, passphrase: pass }, reply);
    await send(c, { type: 'addClientCertificate', host: 'a.example', pfx: token }, reply);
    expect(replies.slice(1)).toEqual([
      { type: 'clientCertificateSaved', host: 'a.example', problem: 'The passphrase is wrong.' },
      { type: 'clientCertificateSaved', host: 'a.example' },
      { type: 'clientCertificateSaved', host: 'a.example', problem: CERT_TOKEN_EXPIRED },
    ]);
    expect(ui.adds).toEqual([
      { host: 'a.example', pfx: token, passphrase: pass },
      { host: 'a.example', pfx: token, passphrase: pass },
    ]);
    expect(JSON.stringify(replies)).not.toContain(pass);
  });

  it('strict validation (unknown fields, roles, tokens, passphrase); never echoes the passphrase', async () => {
    const ui = new FakeUi();
    const { c, reply, replies, logs } = setup({ clientCertUi: ui });
    const pass = ['secret', String(process.pid)].join('-');
    const bad: unknown[] = [
      { type: 'chooseClientCertificateFile', role: 'p12' },
      { type: 'chooseClientCertificateFile', role: 'pfx', path: '/etc/passwd' },
      { type: 'addClientCertificate', host: 1, pfx: 'A'.repeat(24) },
      { type: 'addClientCertificate', host: 'a.example', pfx: '../x' },
      { type: 'addClientCertificate', host: 'a.example', pfx: '/abs/client.p12' },
      { type: 'addClientCertificate', host: 'a.example', pfx: 'A'.repeat(24), passphrase: 5 },
      { type: 'addClientCertificate', host: 'a.example', pfx: 'A'.repeat(24), passphrase: pass + 'x'.repeat(1100) },
      { type: 'addClientCertificate', host: 'a.example', pfx: 'A'.repeat(24), passphrase: pass, file: '/x' },
      { type: 'removeClientCertificate', host: '' },
      { type: 'removeClientCertificate', host: 'a.example', all: true },
      { type: 'forgetLearnedPassthrough', port: 443 },
      { type: 'forgetLearnedPassthrough', host: 'a.example', port: 0 },
      { type: 'forgetLearnedPassthrough', host: 'a b' },
      { type: 'forgetLearnedPassthrough', host: 'a.example', extra: 1 },
    ];
    for (const m of bad) await send(c, m, reply);
    const errs = errors(replies);
    expect(errs).toHaveLength(bad.length);
    expect(ui.adds).toEqual([]);
    expect(ui.removed).toEqual([]);
    expect(JSON.stringify([errs, logs])).not.toContain(pass);
  });

  it('remove goes to the ui', async () => {
    const ui = new FakeUi();
    const { c, reply, replies } = setup({ clientCertUi: ui });
    await send(c, { type: 'removeClientCertificate', host: 'API.example' }, reply);
    expect(ui.removed).toEqual(['API.example']);
    expect(replies).toEqual([]);
  });

  it('REVIEW-14 #4: a Remove cancelled in the IDE sends nothing (no error, no message)', async () => {
    const ui = new FakeUi();
    ui.cancelRemove = true;
    const { c, reply, replies, msgs } = setup({ clientCertUi: ui });
    const before = msgs.length;
    await send(c, { type: 'removeClientCertificate', host: 'a.example' }, reply);
    expect(ui.removed).toEqual(['a.example']);
    expect(replies).toEqual([]);
    expect(msgs.length).toBe(before);
  });
});

describe('forgetLearnedPassthrough (CONTRACTS §20.3)', () => {
  it('all, one host:port, or every port of a host', async () => {
    const { c, host, reply, replies } = setup();
    host.learnedPassthrough = [
      { host: 'a.example', port: 443, reason: 'client-certificate' },
      { host: 'a.example', port: 8443, reason: 'pinned', until: 5 },
      { host: 'b.example', port: 443, reason: 'pinned', until: 5 },
    ];
    await send(c, { type: 'forgetLearnedPassthrough' }, reply);
    await send(c, { type: 'forgetLearnedPassthrough', host: 'B.example', port: 443 }, reply);
    await send(c, { type: 'forgetLearnedPassthrough', host: 'a.example' }, reply);
    expect(host.forgotten).toEqual([undefined, 'b.example:443', 'a.example']); // a bare host = every port (the proxy's form)
    expect(replies).toEqual([]);
  });

  it('REVIEW-14 #5: IPv6 hosts are keyed [v6]:port (bracketed or not in the message), a bare v6 without a port', async () => {
    const { c, host, reply, replies } = setup();
    await send(c, { type: 'forgetLearnedPassthrough', host: '2001:DB8::1', port: 443 }, reply);
    await send(c, { type: 'forgetLearnedPassthrough', host: '[2001:db8::1]', port: 8443 }, reply);
    await send(c, { type: 'forgetLearnedPassthrough', host: '2001:db8::1' }, reply);
    await send(c, { type: 'forgetLearnedPassthrough', host: '10.0.0.5', port: 443 }, reply);
    expect(host.forgotten).toEqual(['[2001:db8::1]:443', '[2001:db8::1]:8443', '2001:db8::1', '10.0.0.5:443']);
    expect(replies).toEqual([]);
  });

  it('REVIEW-14 #5: the keys round-trip through the proxy parser', async () => {
    // the proxy's own parser, from its build (the package doesn't export the module)
    const built = path.resolve(__dirname, '..', '..', '..', 'proxy', 'dist', 'learned.js');
    if (!fs.existsSync(built)) return;
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { parseLearnedKey } = require(built) as { parseLearnedKey: (k: string) => { host: string; port?: number } | undefined };
    expect(parseLearnedKey(learnedKeyOf('2001:db8::1', 443))).toEqual({ host: '2001:db8::1', port: 443 });
    expect(parseLearnedKey(learnedKeyOf('[2001:db8::1]'))).toEqual({ host: '2001:db8::1' });
    expect(parseLearnedKey(learnedKeyOf('API.example', 8443))).toEqual({ host: 'api.example', port: 8443 });
  });

  it('a host without it answers an error', async () => {
    const { c, host, reply, replies } = setup();
    host.forgetLearnedPassthrough = undefined;
    await send(c, { type: 'forgetLearnedPassthrough' }, reply);
    expect(errors(replies)[0]).toMatch(/isn't available/);
  });
});

describe('learned tunnels (CONTRACTS §20.1)', () => {
  const t = (extra: Partial<Exchange>): Exchange => ({ id: 't', startedAt: 1, kind: 'tunnel', method: 'CONNECT', url: 'https://mtls.example:443/', requestHeaders: {}, state: 'completed', ...extra });
  it('tunnelReason says why, and rules from it point to adding the certificate', async () => {
    expect(tunnelReason(t({ learnedPassthrough: { reason: 'client-certificate', host: 'mtls.example', port: 443 } }))).toMatch(/asks the app for its own client certificate.*Add client certificate…/);
    expect(tunnelReason(t({ learnedPassthrough: { reason: 'pinned', host: 'mtls.example', port: 443 } }))).toMatch(/pins its certificate.*10 minutes/);
    const { c, host, reply, replies } = setup();
    host.exchanges = [t({ learnedPassthrough: { reason: 'client-certificate', host: 'mtls.example', port: 443 } })];
    await send(c, { type: 'createRuleFromExchange', id: 't', action: 'mock' }, reply);
    expect(errors(replies)[0]).toMatch(/app's own client certificate.*Add the certificate/);
  });
});

describe('InterceptProxyHost learned passthrough (CONTRACTS §20.2)', () => {
  function makeHost() {
    let list: unknown[] = [];
    const forgot: (string | undefined)[] = [];
    let proxyEmit: ((ev: string, ...a: unknown[]) => void) | undefined;
    const host = new InterceptProxyHost(
      withFakeProxy({
        getPort: () => 9100,
        factory: (_opts: InterceptProxyOptions) => {
          const ee = new EventEmitter();
          proxyEmit = (ev, ...a) => ee.emit(ev, ...a);
          return {
            on: (ev: string, l: (...a: any[]) => void) => ee.on(ev, l),
            get learnedPassthrough() {
              return list;
            },
            forgetLearnedPassthrough: (key?: string) => {
              forgot.push(key);
              list = key === undefined ? [] : list.filter((e) => `${(e as { host: string }).host}:${(e as { port: number }).port}` !== key);
              ee.emit('learnedPassthrough', list);
            },
          };
        },
      }),
    );
    return { host, setList: (l: unknown[]) => (list = l), emit: (...a: unknown[]) => proxyEmit?.('learnedPassthrough', ...a), forgot };
  }

  it('reads the running proxy, re-emits deduplicated, forgets, empties on stop', async () => {
    const { host, setList, emit, forgot } = makeHost();
    const events: unknown[] = [];
    host.on('learnedPassthrough', (l) => events.push(l));
    expect(host.learnedPassthrough).toEqual([]);
    host.forgetLearnedPassthrough(); // not running: nothing
    await host.start();
    setList([{ host: 'MTLS.example', port: 443, reason: 'client-certificate' }, { host: 'p.example', port: 443, reason: 'pinned', until: Date.now() + 60_000, grpc: true }]);
    emit();
    emit(); // same list: no second event
    expect(events).toHaveLength(1);
    expect(host.learnedPassthrough).toEqual([
      { host: 'mtls.example', port: 443, reason: 'client-certificate' },
      { host: 'p.example', port: 443, reason: 'pinned', until: expect.any(Number) },
    ]);
    host.forgetLearnedPassthrough('p.example:443');
    expect(forgot).toEqual(['p.example:443']);
    expect(events).toHaveLength(2);
    await host.stop();
    expect(events.at(-1)).toEqual([]);
    expect(host.learnedPassthrough).toEqual([]);
  });

  it('a proxy build without the API: empty list, forget says so', async () => {
    const host = new InterceptProxyHost(withFakeProxy({ getPort: () => 9100, factory: () => ({}) }));
    await host.start();
    expect(host.learnedPassthrough).toEqual([]);
    expect(() => host.forgetLearnedPassthrough()).toThrow(/cannot forget/);
    await host.stop();
  });

  it('learnedPassthroughView drops malformed and expired entries', () => {
    expect(
      learnedPassthroughView(
        [
          { host: 'ok.example', port: 443, reason: 'pinned', until: 2000 },
          { host: 'old.example', port: 443, reason: 'pinned', until: 500 },
          { host: 'a b', port: 443, reason: 'pinned' },
          { host: 'x.example', port: 70000, reason: 'pinned' },
          { host: 'x.example', port: 443, reason: 'other' },
          null,
          'junk',
        ],
        1000,
      ),
    ).toEqual([{ host: 'ok.example', port: 443, reason: 'pinned', until: 2000 }]);
    expect(learnedPassthroughView(undefined)).toEqual([]);
  });
});
