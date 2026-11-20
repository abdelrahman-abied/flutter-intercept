// CONTRACTS §22.10 (v0.16.0, H): the store messages — getStoreItems (page answer, validation), the debounced push of a
// resource whose data changes (last resource asked per panel), Status counts after data changes, updateStore and
// storeSnapshot to the service, a cancelled name prompt reports nothing, errors without stateful mocks.
import { EventEmitter } from 'events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Exchange, Rule } from '@flutter-intercept/proxy';
import { SnapshotCancelled } from '../../src/mocks/core';
import { AUTH_STATUS_DEBOUNCE_MS, CollectionsDeps, ControllerHost, InterceptController, STORE_ITEMS_PAGE, STORE_PUSH_DEBOUNCE_MS } from '../../src/ui/controller';
import type { CollectionStatus, HostMsg, StorePatch, ViewMsg } from '../../src/ui/protocol';

class FakeHost extends EventEmitter implements ControllerHost {
  running = true;
  port: number | undefined = 9123;
  getExchanges(): Exchange[] {
    return [];
  }
  getRules(): Rule[] {
    return [];
  }
  setRules() {}
  setCollectionRules() {}
  clear() {}
  resume() {}
  abort() {}
}

class FakeStore implements CollectionsDeps {
  listeners: (() => void)[] = [];
  storeListeners: ((id: string, r: string | undefined) => void)[] = [];
  records: unknown[] = [{ id: 1 }, { id: 2 }];
  asked: [string, string, unknown][] = [];
  patches: [string, StorePatch][] = [];
  snaps: [string, string, string | undefined][] = [];
  cancel = false;
  state(): CollectionStatus[] {
    return [];
  }
  rules() {
    return [];
  }
  fileProblems() {
    return [];
  }
  onDidChange(l: () => void) {
    this.listeners.push(l);
    return { dispose: () => undefined };
  }
  onDidChangeStore(l: (id: string, r: string | undefined) => void) {
    this.storeListeners.push(l);
    return { dispose: () => (this.storeListeners = this.storeListeners.filter((x) => x !== l)) };
  }
  fireStore(id: string, r?: string) {
    for (const l of this.storeListeners) l(id, r);
  }
  endpoints() {
    return [];
  }
  example(): never {
    throw new Error('no');
  }
  toRule(): never {
    throw new Error('no');
  }
  async update() {}
  async removeWithConfirmation() {
    return true;
  }
  async importInteractive() {
    return undefined;
  }
  storeItems(id: string, resource: string, opts?: { offset?: number; limit?: number; filter?: string }) {
    this.asked.push([id, resource, opts]);
    if (resource === 'nope') throw new Error(`The collection "${id}" has no resource "nope"`);
    const all = opts?.filter ? this.records.filter((r) => JSON.stringify(r).includes(opts.filter!)) : this.records;
    return { total: all.length, items: all.slice(opts?.offset ?? 0, (opts?.offset ?? 0) + (opts?.limit ?? 50)) };
  }
  async updateStore(id: string, patch: StorePatch) {
    this.patches.push([id, patch]);
  }
  async storeSnapshot(id: string, action: 'save' | 'load' | 'delete', name?: string) {
    if (this.cancel) throw new SnapshotCancelled('Not saved');
    this.snaps.push([id, action, name]);
    return { path: 'x', resources: 1, records: 2 };
  }
  storeStatus() {
    return undefined;
  }
}

const controllers: InterceptController[] = [];
afterEach(() => {
  vi.useRealTimers();
  while (controllers.length) controllers.pop()!.dispose();
});

function setup(store: FakeStore | null = new FakeStore()) {
  const host = new FakeHost();
  const c = new InterceptController({ host, saveRules: () => undefined, getEnabled: () => true, setEnabled: async () => undefined, throttleMs: 5, ...(store ? { collections: store } : {}) });
  controllers.push(c);
  const panel: HostMsg[] = [];
  const other: HostMsg[] = [];
  const panelSink = (m: HostMsg) => panel.push(m);
  const otherSink = (m: HostMsg) => other.push(m);
  c.attach(panelSink);
  c.attach(otherSink);
  const send = (m: unknown, sink = panelSink) => c.handle(m as ViewMsg, sink);
  return { c, store: store!, panel, other, send, otherSink };
}
const items = (msgs: HostMsg[]) => msgs.filter((m): m is Extract<HostMsg, { type: 'storeItems' }> => m.type === 'storeItems');
const errors = (msgs: HostMsg[]) => msgs.filter((m): m is Extract<HostMsg, { type: 'error' }> => m.type === 'error').map((m) => m.message);

describe('getStoreItems', () => {
  it('answers a page of 200 to the asking panel only', async () => {
    const { send, panel, other, store } = setup();
    await send({ type: 'getStoreItems', id: 'shop', resource: 'users', offset: 0, filter: ' 1 ' });
    expect(items(panel)).toEqual([{ type: 'storeItems', id: 'shop', resource: 'users', offset: 0, total: 1, items: [{ id: 1 }] }]);
    expect(store.asked).toEqual([['shop', 'users', { offset: 0, limit: STORE_ITEMS_PAGE, filter: '1' }]]);
    expect(items(other)).toEqual([]);
  });

  it('validates the message', async () => {
    const { send, panel } = setup();
    for (const bad of [
      { type: 'getStoreItems', id: 'Bad', resource: 'users', offset: 0 },
      { type: 'getStoreItems', id: 'shop', resource: '', offset: 0 },
      { type: 'getStoreItems', id: 'shop', resource: 'users', offset: -1 },
      { type: 'getStoreItems', id: 'shop', resource: 'users', offset: 0, filter: 'x'.repeat(201) },
      { type: 'getStoreItems', id: 'shop', resource: 'users', offset: 0, extra: 1 },
      { type: 'updateStore', id: 'shop', patch: [] },
      { type: 'storeSnapshot', id: 'shop', action: 'rename', name: 'a' },
      { type: 'storeSnapshot', id: 'shop', action: 'save', name: '../x' },
      { type: 'storeSnapshot', id: 'shop', action: 'load' },
    ]) {
      await send(bad);
    }
    expect(errors(panel)).toHaveLength(9);
  });

  it('a service error reaches the panel as an error', async () => {
    const { send, panel } = setup();
    await send({ type: 'getStoreItems', id: 'shop', resource: 'nope', offset: 0 });
    expect(errors(panel)).toEqual([expect.stringMatching(/no resource "nope"/)]);
  });
});

describe('pushes (debounced 200 ms) while the data of the open resource changes', () => {
  it('pushes the last resource asked, once per burst, with what the panel loaded; Status follows', async () => {
    vi.useFakeTimers();
    const { send, panel, store } = setup();
    await send({ type: 'getStoreItems', id: 'shop', resource: 'orders', offset: 0 });
    await send({ type: 'getStoreItems', id: 'shop', resource: 'users', offset: 0 });
    await send({ type: 'getStoreItems', id: 'shop', resource: 'users', offset: 200 });
    panel.length = 0;
    store.records = [{ id: 1 }, { id: 2 }, { id: 3 }];
    store.fireStore('shop', 'users');
    store.fireStore('shop', 'users');
    store.fireStore('shop', 'orders'); // not open any more
    vi.advanceTimersByTime(STORE_PUSH_DEBOUNCE_MS - 1);
    expect(items(panel)).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(items(panel)).toEqual([{ type: 'storeItems', id: 'shop', resource: 'users', offset: 0, total: 3, items: store.records }]);
    expect(store.asked.at(-1)).toEqual(['shop', 'users', { offset: 0, limit: 400 }]);
    expect(panel.filter((m) => m.type === 'status')).toHaveLength(1);
    // another collection's change: Status only
    panel.length = 0;
    store.fireStore('other', undefined);
    vi.advanceTimersByTime(STORE_PUSH_DEBOUNCE_MS);
    expect(items(panel)).toEqual([]);
    expect(panel.filter((m) => m.type === 'status')).toHaveLength(1);
  });

  it('every panel keeps its own resource; ready forgets it; a failing read pushes an empty table', async () => {
    vi.useFakeTimers();
    const { send, panel, other, store, otherSink } = setup();
    await send({ type: 'getStoreItems', id: 'shop', resource: 'users', offset: 0 });
    await send({ type: 'getStoreItems', id: 'shop', resource: 'orders', offset: 0 }, otherSink);
    panel.length = 0;
    other.length = 0;
    store.fireStore('shop', undefined);
    vi.advanceTimersByTime(STORE_PUSH_DEBOUNCE_MS);
    expect(items(panel).map((m) => m.resource)).toEqual(['users']);
    expect(items(other).map((m) => m.resource)).toEqual(['orders']);
    await send({ type: 'ready' });
    panel.length = 0;
    other.length = 0;
    store.storeItems = () => {
      throw new Error('off');
    };
    store.fireStore('shop', undefined);
    vi.advanceTimersByTime(STORE_PUSH_DEBOUNCE_MS);
    expect(items(panel)).toEqual([]);
    expect(items(other)).toEqual([{ type: 'storeItems', id: 'shop', resource: 'orders', offset: 0, total: 0, items: [] }]);
  });
});

describe('updateStore and storeSnapshot', () => {
  it('go to the service; a cancelled name prompt reports nothing', async () => {
    const { send, panel, store } = setup();
    await send({ type: 'updateStore', id: 'shop', patch: { resource: 'users', remembers: false, scope: 'team' } });
    await send({ type: 'storeSnapshot', id: 'shop', action: 'save' });
    await send({ type: 'storeSnapshot', id: 'shop', action: 'delete', name: 'checkout' });
    expect(store.patches).toEqual([['shop', { resource: 'users', remembers: false, scope: 'team' }]]);
    expect(store.snaps).toEqual([['shop', 'save', undefined], ['shop', 'delete', 'checkout']]);
    store.cancel = true;
    await send({ type: 'storeSnapshot', id: 'shop', action: 'save' });
    expect(errors(panel)).toEqual([]);
  });

  it('answer an error without stateful mocks', async () => {
    const { send, panel } = setup(null);
    await send({ type: 'getStoreItems', id: 'shop', resource: 'users', offset: 0 });
    await send({ type: 'updateStore', id: 'shop', patch: { reset: 'data' } });
    expect(errors(panel)).toHaveLength(2);
  });
});

// CONTRACTS §24.9 (part 3): sessions are pushed live; the auth / dynamic patch goes to the service as it is.
describe('sign-in simulation (§24.1, §24.9)', () => {
  class AuthStore extends FakeStore {
    authListeners: ((id: string) => void)[] = [];
    onDidChangeAuth(l: (id: string) => void) {
      this.authListeners.push(l);
      return { dispose: () => (this.authListeners = this.authListeners.filter((x) => x !== l)) };
    }
  }
  const statuses = (msgs: HostMsg[]) => msgs.filter((m) => m.type === 'status');

  it('re-sends status, debounced 500 ms, when the session count changes — and no table', async () => {
    vi.useFakeTimers();
    const store = new AuthStore();
    const { send, panel, c } = setup(store);
    await send({ type: 'getStoreItems', id: 'shop', resource: 'users', offset: 0 });
    vi.advanceTimersByTime(1000);
    panel.length = 0;
    for (let i = 0; i < 5; i++) store.authListeners[0]('shop'); // a burst of logins
    vi.advanceTimersByTime(AUTH_STATUS_DEBOUNCE_MS - 1);
    expect(statuses(panel)).toHaveLength(0);
    vi.advanceTimersByTime(1);
    expect(statuses(panel)).toHaveLength(1);
    expect(items(panel)).toEqual([]);
    store.authListeners[0]('shop');
    vi.advanceTimersByTime(AUTH_STATUS_DEBOUNCE_MS);
    expect(statuses(panel)).toHaveLength(2);
    // disposed: the listener is gone and a pending push is dropped
    store.authListeners[0]('shop');
    c.dispose();
    expect(store.authListeners).toEqual([]);
    vi.advanceTimersByTime(AUTH_STATUS_DEBOUNCE_MS);
    expect(statuses(panel)).toHaveLength(2);
  });

  it('updateStore passes auth and dynamic to the service (which checks every field)', async () => {
    const { send, store, panel } = setup();
    const team = { enabled: true, startsFrom: null, auth: { enabled: true, ttlSeconds: 600, protect: 'all' }, dynamic: 'seeded', scope: 'team' };
    await send({ type: 'updateStore', id: 'shop', patch: team });
    await send({ type: 'updateStore', id: 'shop', patch: { auth: { expire: 'all' } } });
    expect(store.patches).toEqual([['shop', team], ['shop', { auth: { expire: 'all' } }]]);
    expect(errors(panel)).toEqual([]);
  });
});
