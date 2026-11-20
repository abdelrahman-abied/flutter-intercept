// CONTRACTS §21.5–§21.8 (v0.15.0) host side: collection rules reach the proxy after the user's rules and never the
// panel's `rules`, Status.collections + link-file problems, the §21.8 messages (validation, answers, errors without
// the service), collectionToRule as a new first personal rule, and endpoints pushed for opened collections.
import { EventEmitter } from 'events';
import { afterEach, describe, expect, it } from 'vitest';
import type { Exchange, Rule } from '@flutter-intercept/proxy';
import { CollectionsDeps, ControllerDeps, ControllerHost, InterceptController, MAX_WATCHED_COLLECTIONS } from '../../src/ui/controller';
import type { CollectionEndpointView, CollectionPatch, CollectionStatus, HostMsg, Status, ViewMsg } from '../../src/ui/protocol';
import type { SharedRulesState } from '../../src/rules/types';

class FakeHost extends EventEmitter implements ControllerHost {
  running = true;
  port: number | undefined = 9123;
  exchanges: Exchange[] = [];
  rules: Rule[] = [];
  collectionRules: Rule[][] = [];
  getExchanges() {
    return this.exchanges;
  }
  getRules() {
    return this.rules;
  }
  setRules(r: Rule[]) {
    this.rules = r;
  }
  setCollectionRules(r: Rule[]) {
    this.collectionRules.push(r);
  }
  clear() {}
  resume() {}
  abort() {}
}

const mockRule = (id: string, body = 'x'): Rule => ({ id, enabled: true, name: `Shop API › ${id}`, match: { method: 'GET', url: '/^https:\\/\\/api\\.test\\/a\\/?(?:[?#]|$)/i' }, action: { kind: 'mock', status: 200, headers: {}, body } });

class FakeCollections implements CollectionsDeps {
  listeners: (() => void)[] = [];
  statuses: CollectionStatus[] = [];
  ruleList: Rule[] = [mockRule('collection:shop:1')];
  problems: string[] = [];
  views = new Map<string, CollectionEndpointView[]>();
  updates: [string, CollectionPatch][] = [];
  removed: string[] = [];
  imports = 0;
  state() {
    return this.statuses;
  }
  rules() {
    return this.ruleList;
  }
  fileProblems() {
    return this.problems;
  }
  onDidChange(l: () => void) {
    this.listeners.push(l);
    return { dispose: () => (this.listeners = this.listeners.filter((x) => x !== l)) };
  }
  fire() {
    for (const l of this.listeners) l();
  }
  endpoints(id: string) {
    const v = this.views.get(id);
    if (!v) throw new Error(`No collection "${id}" is linked`);
    return v;
  }
  example(id: string, endpoint: string, name: string) {
    this.endpoints(id);
    if (name !== 'OK') throw new Error(`The request "${endpoint}" has no example "${name}"`);
    return { status: 200, headers: { 'content-type': 'application/json' }, body: '{"a":1}', truncated: true as const };
  }
  toRule(id: string, endpoint: string): Rule {
    this.endpoints(id);
    return { ...mockRule('rule_new', endpoint), name: 'Shop API › Me · OK' };
  }
  async update(id: string, patch: CollectionPatch) {
    this.endpoints(id);
    this.updates.push([id, patch]);
    this.fire();
  }
  async removeWithConfirmation(id: string) {
    this.removed.push(id);
    return true;
  }
  async importInteractive() {
    this.imports++;
    return { id: 'shop' };
  }
}

const status = (id: string, name = 'Shop API'): CollectionStatus => ({
  id, name, file: `api/${id}.json`, format: 'postman', enabled: true, unmatched: 'passthrough',
  endpoints: 1, mocked: 1, noExample: 0, generated: 0, off: 0, unresolved: [], origins: ['https://api.test'], problems: [], overrides: 0,
});
const view = (name: string): CollectionEndpointView => ({ key: `GET {{baseUrl}}/${name}`, method: 'GET', name, folder: [], url: `https://api.test/${name}`, examples: [{ name: 'OK', status: 200 }] });

const controllers: InterceptController[] = [];
afterEach(() => {
  while (controllers.length) controllers.pop()!.dispose();
});

function setup(extra: Partial<ControllerDeps> = {}, collections: FakeCollections | null = new FakeCollections()) {
  const host = new FakeHost();
  const saved: Rule[][] = [];
  const c = new InterceptController({ host, saveRules: (r) => saved.push(r), getEnabled: () => true, setEnabled: async () => undefined, throttleMs: 5, newRuleId: () => 'rule_id', ...(collections ? { collections } : {}), ...extra });
  controllers.push(c);
  const msgs: HostMsg[] = [];
  c.attach((m) => msgs.push(m));
  const replies: HostMsg[] = [];
  const send = (m: unknown) => c.handle(m as ViewMsg, (r) => replies.push(r));
  return { host, c, msgs, replies, send, saved, col: collections! };
}
const errors = (msgs: HostMsg[]) => msgs.filter((m): m is Extract<HostMsg, { type: 'error' }> => m.type === 'error').map((m) => m.message);
const lastStatus = (msgs: HostMsg[]): Status | undefined => (msgs.filter((m) => m.type === 'status').at(-1) as { status: Status } | undefined)?.status;
const endpointMsgs = (msgs: HostMsg[]) => msgs.filter((m): m is Extract<HostMsg, { type: 'collectionEndpoints' }> => m.type === 'collectionEndpoints');

describe('collection rules', () => {
  it('reach the proxy host at start and on every change, never the panel', () => {
    const { host, c, col, msgs } = setup();
    expect(host.collectionRules).toEqual([[mockRule('collection:shop:1')]]);
    col.ruleList = [mockRule('collection:shop:1', 'y')];
    col.fire();
    expect(host.collectionRules.at(-1)).toEqual(col.ruleList);
    expect(host.rules).toEqual([]);
    const snap = c.snapshot() as Extract<HostMsg, { type: 'snapshot' }>;
    expect(snap.rules).toEqual([]);
    expect(msgs.filter((m) => m.type === 'rules')).toEqual([]);
  });

  it('a failing service gives no rules (logged), not an exception', () => {
    const col = new FakeCollections();
    col.rules = () => {
      throw new Error('boom');
    };
    const logs: string[] = [];
    const { host } = setup({ log: (m) => logs.push(m) }, col);
    expect(host.collectionRules).toEqual([[]]);
    expect(logs).toEqual(['collection rules failed: boom']);
  });
});

describe('Status', () => {
  it('collections, and [] when none is linked; absent without the service', () => {
    const { c, col } = setup();
    expect(c.status().collections).toEqual([]);
    col.statuses = [status('shop')];
    expect(c.status().collections).toEqual([status('shop')]);
    expect(setup({}, null).c.status().collections).toBeUndefined();
  });

  it('is broadcast when the collections change', () => {
    const { col, msgs } = setup();
    col.statuses = [status('shop')];
    col.fire();
    expect(lastStatus(msgs)?.collections).toEqual([status('shop')]);
  });

  it('link-file problems join the shared-rules problems', () => {
    const state: SharedRulesState = { file: '.vscode/flutter-intercept.json', rules: [], problems: ['rule problem'], pendingApproval: [] };
    const shared = { state: () => state, save: async () => undefined, approvePending: async () => undefined };
    const { c, col } = setup({ shared });
    col.problems = ['.vscode/flutter-intercept.json: collection 1: bad (skipped)'];
    expect(c.status().sharedRules).toEqual({ file: '.vscode/flutter-intercept.json', count: 0, problems: ['rule problem', '.vscode/flutter-intercept.json: collection 1: bad (skipped)'], pendingApproval: 0 });
    const alone = setup();
    alone.col.problems = ['x: bad'];
    expect(alone.c.status().sharedRules).toEqual({ count: 0, problems: ['x: bad'], pendingApproval: 0 });
  });
});

describe('messages', () => {
  it('getCollectionEndpoints answers the asking view', async () => {
    const { send, replies, col } = setup();
    col.views.set('shop', [view('a')]);
    await send({ type: 'getCollectionEndpoints', id: 'shop' });
    expect(replies).toEqual([{ type: 'collectionEndpoints', id: 'shop', endpoints: [view('a')] }]);
  });

  it('getCollectionExample answers with the example (and truncated)', async () => {
    const { send, replies, col } = setup();
    col.views.set('shop', [view('a')]);
    await send({ type: 'getCollectionExample', id: 'shop', endpoint: 'GET {{baseUrl}}/a', name: 'OK' });
    expect(replies).toEqual([{ type: 'collectionExample', id: 'shop', endpoint: 'GET {{baseUrl}}/a', name: 'OK', status: 200, headers: { 'content-type': 'application/json' }, body: '{"a":1}', truncated: true }]);
  });

  it('updateCollection, removeCollection, importCollection go to the service', async () => {
    const { send, col, replies } = setup();
    col.views.set('shop', [view('a')]);
    await send({ type: 'updateCollection', id: 'shop', patch: { unmatched: 'fail' } });
    await send({ type: 'removeCollection', id: 'shop' });
    await send({ type: 'importCollection' });
    expect(col.updates).toEqual([['shop', { unmatched: 'fail' }]]);
    expect(col.removed).toEqual(['shop']);
    expect(col.imports).toBe(1);
    expect(errors(replies)).toEqual([]);
  });

  it('validates every message strictly', async () => {
    const { send, replies, col } = setup();
    col.views.set('shop', [view('a')]);
    const bad: unknown[] = [
      { type: 'getCollectionEndpoints', id: 'Bad Id' },
      { type: 'getCollectionEndpoints', id: 'shop', extra: 1 },
      { type: 'getCollectionExample', id: 'shop', endpoint: '', name: 'OK' },
      { type: 'getCollectionExample', id: 'shop', endpoint: 'x'.repeat(9000), name: 'OK' },
      { type: 'getCollectionExample', id: 'shop', endpoint: 'GET {{baseUrl}}/a', name: 'Nope' },
      { type: 'updateCollection', id: 'shop', patch: 'all' },
      { type: 'updateCollection', id: 42, patch: {} },
      { type: 'removeCollection', id: '../x' },
      { type: 'collectionToRule', id: 'shop' },
      { type: 'collectionToRule', id: 'nope', endpoint: 'GET x' },
      { type: 'importCollection', file: '/etc/passwd' },
    ];
    for (const m of bad) await send(m);
    const errs = errors(replies);
    expect(errs).toHaveLength(bad.length);
    expect(errs[4]).toContain('has no example "Nope"');
    expect(errs[9]).toContain('No collection "nope" is linked');
    expect(col.updates).toEqual([]);
    expect(col.removed).toEqual([]);
    expect(col.imports).toBe(0);
  });

  it('without the service every §21.8 message is a readable error', async () => {
    const { send, replies } = setup({}, null);
    for (const m of [{ type: 'importCollection' }, { type: 'getCollectionEndpoints', id: 'shop' }, { type: 'updateCollection', id: 'shop', patch: {} }, { type: 'removeCollection', id: 'shop' }, { type: 'collectionToRule', id: 'shop', endpoint: 'GET x' }, { type: 'getCollectionExample', id: 'shop', endpoint: 'x', name: 'y' }]) await send(m);
    expect(errors(replies)).toEqual(Array(6).fill('Mocking from a collection needs the Flutter project folder open.'));
  });
});

describe('collectionToRule (§21.8 decision)', () => {
  it('adds the copy as a new personal rule, first among the personal rules, and broadcasts rules', async () => {
    const { host, send, saved, msgs, col } = setup();
    col.views.set('shop', [view('me')]);
    const shared: Rule = { ...mockRule('shared:s1'), shared: true };
    const mine = mockRule('rule_old');
    host.rules = [shared, mine];
    await send({ type: 'collectionToRule', id: 'shop', endpoint: 'GET {{baseUrl}}/me' });
    expect(host.rules.map((r) => r.id)).toEqual(['shared:s1', 'rule_new', 'rule_old']);
    expect(saved.at(-1)!.map((r) => r.id)).toEqual(['rule_new', 'rule_old']);
    const rulesMsg = msgs.filter((m) => m.type === 'rules').at(-1) as Extract<HostMsg, { type: 'rules' }>;
    expect(rulesMsg.rules.map((r) => r.id)).toEqual(['shared:s1', 'rule_new', 'rule_old']);
    expect(msgs.some((m) => (m as { type: string }).type === 'collectionRule')).toBe(false);
  });
});

describe('pushed endpoints (§21.8 decision)', () => {
  it('are pushed for opened collections when they change, only when different', async () => {
    const { send, col, msgs } = setup();
    col.views.set('shop', [view('a')]);
    col.views.set('other', [view('b')]);
    await send({ type: 'getCollectionEndpoints', id: 'shop' });
    col.fire();
    expect(endpointMsgs(msgs)).toEqual([]); // unchanged: nothing pushed
    col.views.set('shop', [view('a'), view('c')]);
    col.views.set('other', [view('b2')]);
    col.fire();
    expect(endpointMsgs(msgs)).toEqual([{ type: 'collectionEndpoints', id: 'shop', endpoints: [view('a'), view('c')] }]);
  });

  it('after an update from the panel (or an agent) the fresh endpoints arrive', async () => {
    const { send, col, msgs } = setup();
    col.views.set('shop', [view('a')]);
    await send({ type: 'getCollectionEndpoints', id: 'shop' });
    const updated = { ...view('a'), selected: 'OK' };
    col.update = async (id, patch) => {
      col.updates.push([id, patch]);
      col.views.set('shop', [updated]);
      col.fire();
    };
    await send({ type: 'updateCollection', id: 'shop', patch: { example: { endpoint: 'GET {{baseUrl}}/a', name: 'OK' } } });
    expect(endpointMsgs(msgs)).toEqual([{ type: 'collectionEndpoints', id: 'shop', endpoints: [updated] }]);
  });

  it('forgets everything on ready, and a removed collection', async () => {
    const { send, col, msgs } = setup();
    col.views.set('shop', [view('a')]);
    await send({ type: 'getCollectionEndpoints', id: 'shop' });
    await send({ type: 'ready' });
    col.views.set('shop', [view('z')]);
    col.fire();
    expect(endpointMsgs(msgs)).toEqual([]);
    await send({ type: 'getCollectionEndpoints', id: 'shop' });
    col.views.delete('shop');
    col.fire();
    col.views.set('shop', [view('back')]);
    col.fire();
    expect(endpointMsgs(msgs)).toEqual([]);
  });

  it(`remembers at most ${MAX_WATCHED_COLLECTIONS} collections, the most recent`, async () => {
    const { send, col, msgs } = setup();
    for (let i = 0; i < MAX_WATCHED_COLLECTIONS + 3; i++) {
      col.views.set(`c${i}`, [view(`v${i}`)]);
      await send({ type: 'getCollectionEndpoints', id: `c${i}` });
    }
    for (let i = 0; i < MAX_WATCHED_COLLECTIONS + 3; i++) col.views.set(`c${i}`, [view(`w${i}`)]);
    col.fire();
    const pushed = endpointMsgs(msgs).map((m) => m.id);
    expect(pushed).toHaveLength(MAX_WATCHED_COLLECTIONS);
    expect(pushed).not.toContain('c0');
    expect(pushed).toContain(`c${MAX_WATCHED_COLLECTIONS + 2}`);
  });
});

describe('approveCollection (CONTRACTS §21.16)', () => {
  it('goes to the IDE prompt of the service; without one it answers an error', async () => {
    const col = new FakeCollections() as FakeCollections & { approveWithConfirmation?: (id: string) => Promise<boolean> };
    const asked: string[] = [];
    col.approveWithConfirmation = async (id) => (asked.push(id), true);
    const { send, replies } = setup({}, col);
    await send({ type: 'approveCollection', id: 'shop' });
    expect(asked).toEqual(['shop']);
    expect(errors(replies)).toEqual([]);
    await send({ type: 'approveCollection', id: 'Bad Id' });
    await send({ type: 'approveCollection', id: 'shop', extra: 1 });
    expect(asked).toEqual(['shop']);
    expect(errors(replies)).toHaveLength(2);

    const plain = setup();
    await plain.send({ type: 'approveCollection', id: 'shop' });
    expect(errors(plain.replies)).toEqual(["Approving a collection is not available here."]);
  });
});
