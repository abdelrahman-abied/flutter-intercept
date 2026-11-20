// CONTRACTS §22.8: the snapshot file format (validation and redaction on save).
import { describe, expect, it } from 'vitest';
import { detectResources } from '../../src/mocks/resources';
import { fieldWords, isSecretFieldName, parseSnapshot, snapshotText, validateSnapshot } from '../../src/mocks/snapshot';
import { ResourceStore } from '../../src/mocks/store';
import { STORE_LIMITS, type MockEndpoint, type StoreSnapshot } from '../../src/mocks/types';

const ORIGIN = 'https://api.test';
function ep(method: string, p: string, body?: unknown): MockEndpoint {
  const path = p
    .split('/')
    .filter(Boolean)
    .map((s) => (s.startsWith(':') ? { param: s.slice(1) } : s));
  const examples = body === undefined ? [] : [{ name: 'OK', status: 200, headers: {}, body: JSON.stringify(body) }];
  return { key: `${method} ${p}`, method, name: p, folder: [], origin: ORIGIN, path, examples, unresolved: [] };
}

const JWT = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U';

describe('snapshotText (save)', () => {
  it('blanks secret-named fields and credential-looking values a POST stored, and lists them', () => {
    const endpoints = [ep('GET', '/users', [{ id: 1, name: 'Sara' }]), ep('POST', '/users'), ep('GET', '/users/:id')];
    const store = new ResourceStore(detectResources(endpoints, {}).resources, endpoints);
    const a = store.handle({
      resource: 'users',
      op: 'create',
      params: {},
      query: [],
      contentType: 'application/json',
      body: { text: JSON.stringify({ name: 'Lina', password: 'hunter2', profile: { accessToken: 'abc', bio: JWT }, active: true, sessionCount: 3 }) },
    });
    expect(a.status).toBe(201);
    // the app's own answer keeps what it sent
    expect(a.body).toContain('hunter2');
    const dump = { ...store.dump(), collection: 'shop', savedAt: '2026-11-20T00:00:00.000Z' };
    const { text, blanked } = snapshotText(dump);
    expect(text).not.toContain('hunter2');
    expect(text).not.toContain(JWT);
    expect(text).not.toContain('"abc"');
    expect(blanked).toEqual(['users.password', 'users.profile.accessToken', 'users.profile.bio']);
    const parsed = JSON.parse(text);
    expect(parsed.resources.users[0].records[1]).toEqual({
      id: 2,
      name: 'Lina',
      password: '',
      profile: { accessToken: '', bio: '' },
      active: true,
      sessionCount: 3,
    });
    expect(text.endsWith('\n')).toBe(true);
    expect(text.split('\n')[1]).toBe('  "version": 1,');
  });

  it('stable key order: top level fixed, resource names and scope keys sorted, records as stored', () => {
    const dump: StoreSnapshot = {
      next: { b: 2, a: 1 },
      resources: { zebras: [{ records: [{ z: 1, id: 1 }] }], 'a.b': [{ scope: { y: '1', x: '2' }, records: [] }] },
      savedAt: 's',
      collection: 'c',
      version: 1,
    };
    const { text } = snapshotText(dump);
    const back = JSON.parse(text);
    expect(Object.keys(back)).toEqual(['version', 'collection', 'savedAt', 'resources', 'next']);
    expect(Object.keys(back.resources)).toEqual(['a.b', 'zebras']);
    expect(Object.keys(back.resources['a.b'][0].scope)).toEqual(['x', 'y']);
    expect(Object.keys(back.resources.zebras[0].records[0])).toEqual(['z', 'id']);
    expect(snapshotText(dump).text).toBe(text);
  });
});

describe('parseSnapshot / validateSnapshot (load)', () => {
  const good = { version: 1, collection: 'shop', savedAt: '2026-11-20T00:00:00Z', resources: { users: [{ records: [{ id: 1 }] }] }, next: { users: 2 } };

  it('accepts a valid snapshot and returns a clean copy', () => {
    const r = parseSnapshot(JSON.stringify(good));
    expect(r.problems).toEqual([]);
    expect(JSON.parse(JSON.stringify(r.snapshot))).toEqual(good);
    expect(parseSnapshot(`﻿${JSON.stringify(good)}`).snapshot).toBeDefined();
  });

  it('refuses broken files with one readable line', () => {
    const bad: [unknown, RegExp][] = [
      ['nope', /isn't valid JSON/],
      [[], /not a JSON object/],
      [{ ...good, version: 2 }, /version must be 1/],
      [{ ...good, collection: 5 }, /collection/],
      [{ ...good, resources: [] }, /"resources"/],
      [{ ...good, resources: { users: {} } }, /list of \{scope\?, records\}/],
      [{ ...good, resources: { users: [{ records: [1] }] } }, /JSON object/],
      [{ ...good, resources: { users: [{ scope: { u: 1 }, records: [] }] } }, /scope/],
      [{ ...good, next: { users: -1 } }, /whole numbers/],
      [{ ...good, next: { users: 1.5 } }, /whole numbers/],
    ];
    for (const [value, re] of bad) {
      const r = parseSnapshot(typeof value === 'string' ? value : JSON.stringify(value));
      expect(r.snapshot).toBeUndefined();
      expect(r.problems).toHaveLength(1);
      expect(r.problems[0]).toMatch(re);
    }
  });

  it('__proto__: kept as a resource name (REVIEW-16 #15c), refused as a scope key, dropped inside records', () => {
    const named = parseSnapshot('{"version":1,"collection":"c","savedAt":"","resources":{"__proto__":[]},"next":{"__proto__":3}}').snapshot;
    expect(named && Object.keys(named.resources)).toEqual(['__proto__']);
    expect(named && Object.getPrototypeOf(named.resources)).toBeNull();
    expect(named?.next && Object.keys(named.next)).toEqual(['__proto__']);
    expect(parseSnapshot('{"version":1,"collection":"c","savedAt":"","resources":{"u":[{"scope":{"__proto__":"1"},"records":[]}]}}').snapshot).toBeUndefined();
    const r = parseSnapshot('{"version":1,"collection":"c","savedAt":"","resources":{"u":[{"records":[{"id":1,"__proto__":{"polluted":true}}]}]}}');
    expect(r.snapshot).toBeDefined();
    const rec = r.snapshot?.resources.u[0].records[0] as Record<string, unknown>;
    expect(Object.keys(rec)).toEqual(['id']);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('limits: records per resource, record size, depth', () => {
    const many = { ...good, resources: { users: [{ records: Array.from({ length: STORE_LIMITS.recordsPerResource + 1 }, (_, i) => ({ id: i })) }] } };
    expect(validateSnapshot(many).problems[0]).toMatch(/more than 5000 records/);
    const big = { ...good, resources: { users: [{ records: [{ id: 1, x: 'x'.repeat(STORE_LIMITS.recordBytes) }] }] } };
    expect(validateSnapshot(big).problems[0]).toMatch(/over 1 MB/);
    let deep: unknown = 1;
    for (let i = 0; i < 40; i++) deep = { d: deep };
    expect(validateSnapshot({ ...good, resources: { users: [{ records: [{ id: 1, deep }] }] } }).problems[0]).toMatch(/deeper than 32/);
  });

  it('a saved snapshot loads back into the store', () => {
    const endpoints = [ep('GET', '/users', [{ id: 1, name: 'Sara' }]), ep('POST', '/users'), ep('GET', '/users/:id')];
    const store = new ResourceStore(detectResources(endpoints, {}).resources, endpoints);
    store.put('users', { name: 'Omar', token: 'secret-value' });
    const { text } = snapshotText({ ...store.dump(), collection: 'shop' });
    const parsed = parseSnapshot(text);
    expect(parsed.problems).toEqual([]);
    const fresh = new ResourceStore(detectResources(endpoints, {}).resources, endpoints);
    expect(fresh.load(parsed.snapshot as StoreSnapshot)).toEqual([]);
    expect(fresh.items('users').items).toEqual([
      { id: 1, name: 'Sara' },
      { id: 2, name: 'Omar', token: '' },
    ]);
  });
});

describe('isSecretFieldName (snapshot redaction by name, §22.8)', () => {
  it('splits names into words', () => {
    expect(fieldWords('APIKey')).toEqual(['api', 'key']);
    expect(fieldWords('x_auth-token.v2')).toEqual(['x', 'auth', 'token', 'v', '2']);
    expect(fieldWords('sessionID')).toEqual(['session', 'id']);
    expect(fieldWords('pin2')).toEqual(['pin', '2']);
  });

  it('blanks every listed word and pair', () => {
    const secret = [
      'password', 'userPassword', 'passwd', 'pwd', 'passcode', 'clientSecret', 'secret', 'token', 'idToken',
      'apikey', 'apiKey', 'api_key', 'X-Api-Key', 'authorization', 'Authorization', 'auth', 'authToken', 'x_auth',
      'credential', 'credentials', 'cookie', 'privatekey', 'privateKey', 'private_key', 'otp', 'otpCode', 'pin',
      'cardPin', 'sessionid', 'sessionId', 'session_id', 'sessionToken', 'session_key', 'refreshToken',
      'refresh_token', 'accessToken', 'client_secret', 'signature', 'ssn', 'cvv', 'cvc', 'cardNumber', 'card_number',
      'session',
    ];
    for (const n of secret) expect(isSecretFieldName(n), n).toBe(true);
  });

  it('keeps look-alikes', () => {
    const plain = [
      // REVIEW-16 #5: a field named just `session` is secret now (the agent redaction always hid it)
      'author', 'authored', 'authorId', 'sessionCount', 'sessionStart', 'pinned', 'tokenizer',
      'privateNote', 'apiVersion', 'keyboard', 'cardHolder', 'number', 'opinion', 'spinner', 'passage', 'secretary',
    ];
    for (const n of plain) expect(isSecretFieldName(n), n).toBe(false);
  });

  it('snapshotText keeps look-alike fields and still blanks credential-looking values', () => {
    const dump: StoreSnapshot = {
      version: 1,
      collection: 'c',
      savedAt: '',
      resources: { posts: [{ records: [{ id: 1, author: 'Sara', sessionCount: 4, pinned: true, tokenizer: 'bpe', note: `Bearer ${'a1B2'.repeat(5)}` }] }] },
    };
    const { text, blanked } = snapshotText(dump);
    expect(JSON.parse(text).resources.posts[0].records[0]).toEqual({ id: 1, author: 'Sara', sessionCount: 4, pinned: true, tokenizer: 'bpe', note: '' });
    expect(blanked).toEqual(['posts.note']);
  });
});
