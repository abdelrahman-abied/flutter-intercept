// CONTRACTS §23 (v0.16.0 part 2, X2): the collections host core — a fake backend from real traffic (written through
// copyIn 'sanitised', never over a file, linked, remembering), drift from real exchanges (N = 3, ignore, the setting,
// cleared when the file changes), and Update example (merge / add on Postman and OpenAPI JSON with every other byte
// unchanged, hash-checked writes, YAML and generated examples copy-only, merge refused without an example). Planted
// values never reach the file, the results, the drift views, the diff text or the logs.
import * as fs from 'fs';
import * as path from 'path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Exchange, RequestHandler } from '@flutter-intercept/proxy';
import { compileRules, findRule } from '@flutter-intercept/proxy/rules';
import { DRIFT_IGNORED_KEY, exampleDiff, MockCollectionsCore, NOTHING_RECORDED, type ExampleUpdate } from '../../src/mocks/core';
import { JWT_PLACEHOLDER } from '../../src/mocks/fromTraffic';
import { collectionParsers } from '../../src/mocks/parsers';
import { locate, parseJsonTree } from '../../src/mocks/splice';
import { SharedRulesCore } from '../../src/rules/core';
import { FakeFs, FakeMemento, FILE, fakeValidateRule, ROOT } from './rules.fakes';

vi.mock('vscode', () => ({}));

const SESSION = path.join(__dirname, '..', 'fixtures', 'traffic', 'session.json');
const session = (): Exchange[] => (JSON.parse(fs.readFileSync(SESSION, 'utf8')) as { exchanges: Exchange[] }).exchanges;
const A = 'https://api.shop.example';
const DIR = `${ROOT}/.vscode/flutter-intercept/collections`;
const NAME = 'api-shop-example-recorded';
const USER = 'GET {{baseUrl}}/users/:userId';

/** Values planted in the fixture (and in new answers below) that must never leave the host. */
const PLANTED = [
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9',
  'SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c',
  'eyJhbGciOiJSUzI1NiIsImtpZCI6ImsxIn0',
  'Zm9vYmFyYmF6cXV4MTIzNDU2Nzg5MGFiY2RlZg',
  's3cr3tCookieValue42',
  'rt_9f8e7d6c5b4a39281706f5e4d3c2b1a0ZZqq',
  'Hunter2!PlantedPw',
  'deadbeefcafef00d1234567890abcdef0042',
  'AKIAPLANTEDCRED',
  'qTok3nPlantedValue99',
  'tkPlantedHeader0042',
  'ada@lovelace.dev',
  'charles@engine.dev',
  '7946 0958',
  '12 Analytical Way',
  'NW1 6XE',
  '51.5072',
  'req-abc-123-trace',
  "default-src 'self'",
  // planted in the new answers of this file
  'grace@hopper.dev',
  'PlantedNewSig777',
  'sk_live_PlantedKey0001',
  'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJncmFjZSJ9.PlantedNewJwtSignature0000',
  '+1 415 555 0199',
  'Bearer PlantedBearerValue12345678',
];
const clean = (what: string, v: unknown) => {
  const s = typeof v === 'string' ? v : JSON.stringify(v);
  for (const p of PLANTED) expect(s, `${what} holds ${p}`).not.toContain(p);
};

let files: FakeFs;
let memento: FakeMemento;
let shared: SharedRulesCore;
let traffic: Exchange[];
let handlers: Map<string, RequestHandler>;
let logs: string[];
let driftEvents: number;
let driftOn: boolean;
let core: MockCollectionsCore;
let seq = 0;

function makeCore(): MockCollectionsCore {
  return new MockCollectionsCore({
    links: () => shared.collectionLinks(),
    saveLinks: (folder, links) => shared.saveCollections(folder, links),
    primaryFolderPath: () => shared.primaryFolderPath(),
    writeWorkspaceFile: (folder, rel, text) => shared.writeWorkspaceFile(folder, rel, text),
    workspaceRoots: () => [ROOT],
    fs: files,
    memento,
    parsers: collectionParsers,
    newRuleId: () => 'rule_new',
    log: (m) => logs.push(m),
    exchanges: () => traffic,
    setHandler: (id, fn) => void (fn ? handlers.set(id, fn) : handlers.delete(id)),
    saveStore: (folder, collection, entry) => shared.saveStore(folder, collection, entry),
    isThrottleOnlyRule: (id) => id === 'throttle-only',
    driftEnabled: () => driftOn,
    onDriftChange: () => driftEvents++,
    now: () => Date.UTC(2026, 10, 20, 12, 0, 0),
  });
}

beforeEach(async () => {
  files = new FakeFs();
  files.put(`${ROOT}/pubspec.yaml`, 'name: app');
  memento = new FakeMemento();
  shared = new SharedRulesCore({ folders: () => [{ name: 'app', path: ROOT }], fs: files, validateRule: fakeValidateRule, memento });
  traffic = session();
  handlers = new Map();
  logs = [];
  driftEvents = 0;
  driftOn = true;
  await shared.reload();
  core = makeCore();
  await core.reload();
});

/** A real server's answer (no rule matched it). */
function answer(method: string, url: string, status: number, body: unknown, extra: Partial<Exchange> = {}): Exchange {
  seq++;
  return {
    id: `n${seq}`,
    startedAt: 1_800_000_000_000 + seq,
    method,
    url,
    requestHeaders: { authorization: 'Bearer PlantedBearerValue12345678' },
    status,
    responseHeaders: { 'content-type': 'application/json', 'set-cookie': 'sid=s3cr3tCookieValue42' },
    responseBody: { text: typeof body === 'string' ? body : JSON.stringify(body), encoding: 'utf8' },
    state: 'completed',
    ...extra,
  };
}

/** Feeds answers to the core as the proxy's `exchange` event does, then runs the debounced batch. */
function serve(...xs: Exchange[]): void {
  for (const x of xs) {
    traffic.push(x);
    core.observeExchange(x);
  }
  core.flushDrift();
}

const linkFile = () => JSON.parse(files.text(FILE)!) as { collections: { id: string; file: string; unmatched: string }[] };
/** A newer answer of GET /users/:id: the recorded example's fields (planted values), plus `extra`. */
const userBody = (extra: Record<string, unknown> = {}) => ({
  id: 42,
  name: 'Grace Hopper',
  email: 'grace@hopper.dev',
  phone: '+1 415 555 0199',
  rating: 4.5,
  seen: 3,
  address: { street: '1 Navy Way', city: 'Arlington', zip: '22201' },
  // ints: the recorded example's coordinates were replaced by 0 (an int), see the report on fromTraffic
  lat: 38,
  lng: -77,
  avatarUrl: 'https://cdn.example/a.png?X-Amz-Signature=PlantedNewSig777&w=1',
  bio: 'Mail grace@hopper.dev',
  big: 1,
  ...extra,
});
const SECRETS = { session: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJncmFjZSJ9.PlantedNewJwtSignature0000', apiKey: 'sk_live_PlantedKey0001' };

async function recorded(o: { unmatched?: 'passthrough' | 'fail' } = {}): Promise<string> {
  const r = await core.mockFromTraffic({ source: { session: {} }, ...(o.unmatched ? { unmatched: o.unmatched } : {}) });
  return r.id;
}

describe('mockFromTraffic (§23.1, §23.2)', () => {
  it('end to end: the fixture session becomes a linked collection that answers and remembers', async () => {
    const r = await core.mockFromTraffic({ source: { session: {} } });
    expect(r).toMatchObject({ id: NAME, file: `.vscode/flutter-intercept/collections/${NAME}.json`, endpoints: 11, examples: 12, resources: ['users'] });
    expect(r.skipped).toEqual(expect.arrayContaining(['1 GraphQL request', '1 mocked or replayed answer', '1 OPTIONS request']));
    expect(r.removed).toEqual(expect.arrayContaining(['e-mail addresses', 'phone numbers', 'authorization']));
    // written, never as-is: through copyIn 'sanitised'
    const text = files.text(`${DIR}/${NAME}.json`)!;
    expect(JSON.parse(text).info.name).toBe('api.shop.example (recorded)');
    // linked for the team, unmatched passthrough by default
    expect(linkFile().collections).toEqual([{ id: NAME, file: r.file }]); // unmatched passthrough = the default, not written
    const s = core.state().find((x) => x.id === NAME)!;
    expect(s).toMatchObject({ enabled: true, endpoints: 11, mocked: 11, unresolved: [] });
    expect(s.store?.resources.map((x) => x.name)).toEqual(['users']);
    // it answers: the newest recorded answer, from the collection's rules
    const rule = findRule(compileRules(core.rules()), 'GET', `${A}/users/42`);
    expect(rule?.id.startsWith(`collection:${NAME}:`)).toBe(true);
    // and it remembers (a store handler is registered for it)
    expect(handlers.has(`collection:${NAME}`)).toBe(true);
    // no IDE-level notification text is needed: the log line has counts only
    expect(logs.some((l) => l.includes(`made "${NAME}" from traffic (11 requests, 12 examples)`))).toBe(true);
  });

  it('offline: unmatched "fail" is written to the link', async () => {
    await recorded({ unmatched: 'fail' });
    expect(linkFile().collections[0].unmatched).toBe('fail');
    expect(core.state()[0].unmatched).toBe('fail');
  });

  it('never overwrites: a second run (or a file already there) gets -2, -3', async () => {
    files.put(`${DIR}/${NAME}.json`, '{"keep":"me"}');
    const a = await core.mockFromTraffic({ source: { session: {} } });
    expect(a.file).toBe(`.vscode/flutter-intercept/collections/${NAME}-2.json`);
    expect(files.text(`${DIR}/${NAME}.json`)).toBe('{"keep":"me"}');
    const b = await core.mockFromTraffic({ source: { session: {} } });
    expect(b.file).toBe(`.vscode/flutter-intercept/collections/${NAME}-3.json`);
    expect(b.id).toBe(`${NAME}-2`);
    expect(linkFile().collections.map((c) => c.id)).toEqual([NAME, `${NAME}-2`]);
  });

  it('dry run: the same result, nothing written or linked', async () => {
    const before = [...files.files.keys()].sort();
    const r = await core.mockFromTraffic({ source: { session: {} }, dryRun: true });
    expect(r).toMatchObject({ id: NAME, file: `.vscode/flutter-intercept/collections/${NAME}.json`, endpoints: 11, examples: 12, resources: ['users'], dryRun: true });
    expect([...files.files.keys()].sort()).toEqual(before);
    expect(core.state()).toEqual([]);
  });

  it('origins, url and sinceMs narrow the source; unknown origins are refused with the list', async () => {
    const r = await core.mockFromTraffic({ source: { session: { url: `${A}/users*` } }, dryRun: true });
    expect(r.endpoints).toBe(2);
    const since = await core.mockFromTraffic({ source: { session: { sinceMs: 1_700_000_013_000 } }, dryRun: true });
    expect(since.endpoints).toBeLessThan(11);
    const one = await core.mockFromTraffic({ source: { session: {} }, origins: ['https://feed.media.example:8443/'], dryRun: true });
    expect(one).toMatchObject({ endpoints: 1, id: 'feed-media-example-8443-recorded' });
    await expect(core.mockFromTraffic({ source: { session: {} }, origins: ['https://elsewhere.example'] })).rejects.toThrow(/didn't answer in this traffic; servers that did: https:\/\/api\.shop\.example/);
  });

  it('origins: JSON servers preselected, third-party services listed unselected', async () => {
    traffic.push(answer('GET', 'https://firebaseinstallations.googleapis.com/v1/x', 200, { ok: 1 }), answer('GET', 'https://img.cdn.example/a.png', 200, 'PNG', { responseHeaders: { 'content-type': 'image/png' } }));
    const o = await core.trafficOrigins({ session: {} });
    expect(o.find((x) => x.origin === A)).toMatchObject({ preselected: true, thirdParty: false });
    expect(o.find((x) => x.origin.includes('googleapis'))).toMatchObject({ preselected: false, thirdParty: true });
    expect(o.find((x) => x.origin.includes('img.cdn'))).toMatchObject({ preselected: false, json: 0 });
    const r = await core.mockFromTraffic({ source: { session: {} }, dryRun: true });
    expect(r.endpoints).toBe(11); // neither of them by default
  });

  it('refuses when nothing qualifies: run the app against the real server first', async () => {
    traffic = traffic.filter((e) => e.state !== 'completed');
    await expect(core.mockFromTraffic({ source: { session: {} } })).rejects.toThrow(NOTHING_RECORDED);
    traffic = [answer('GET', `${A}/x`, 302, '')];
    await expect(core.mockFromTraffic({ source: { session: {} } })).rejects.toThrow(/Run the app against the real server first/);
    expect(files.writes.filter((w) => w.includes('collections/'))).toEqual([]);
  });

  it('a recording is a source too (and its absence is said)', async () => {
    await expect(core.mockFromTraffic({ source: { recording: 'r1' } })).rejects.toThrow(/Recordings aren't available here/);
    const withRec = new MockCollectionsCore({ ...(core as unknown as { deps: object }).deps, loadRecording: async (id: string) => (id === 'r1' ? session() : Promise.reject(new Error('No recording "x"'))) } as never);
    await withRec.reload();
    expect((await withRec.mockFromTraffic({ source: { recording: 'r1' }, dryRun: true })).endpoints).toBe(11);
    await expect(withRec.mockFromTraffic({ source: { recording: 'x' } })).rejects.toThrow(/No recording/);
  });

  it('planted values: none in the written file, the results (dry run too) or the logs', async () => {
    const dry = await core.mockFromTraffic({ source: { session: {} }, dryRun: true });
    const r = await core.mockFromTraffic({ source: { session: {} } });
    const text = files.text(`${DIR}/${NAME}.json`)!;
    clean('file', text);
    clean('dry run', dry);
    clean('result', r);
    clean('state', core.state());
    clean('endpoints', core.endpoints(NAME));
    clean('logs', logs);
    expect(text).toContain(JWT_PLACEHOLDER);
    expect(text).toContain('user1@example.com');
  });
});

describe('drift (§23.3)', () => {
  async function stale(): Promise<string> {
    const id = await recorded();
    await core.update(id, { enabled: false }); // a teammate with a real server: the main case
    return id;
  }

  it('N = 3: the same new field in three answers is a finding; Status, endpoints and the event follow', async () => {
    const id = await stale();
    serve(answer('GET', `${A}/users/42`, 200, userBody({ tier: 'gold' })), answer('GET', `${A}/users/7`, 200, userBody({ tier: 'gold' })));
    expect(core.state()[0].drift).toBeUndefined();
    expect(driftEvents).toBe(0);
    serve(answer('GET', `${A}/users/9`, 200, userBody({ tier: 'silver' })));
    expect(driftEvents).toBe(1);
    expect(core.state()[0].drift).toEqual({ endpoints: 1, line: 'GET /users/:userId now has tier' });
    const ep = core.endpoints(id).find((e) => e.key === USER)!;
    expect(ep.drift).toEqual([expect.objectContaining({ endpoint: USER, status: 200, samples: 3, changes: [{ kind: 'added', path: 'tier', to: 'string' }] })]);
    expect(core.driftOf(id)).toHaveLength(1);
    clean('drift views', [core.state(), core.endpoints(id), core.driftOf(id)]);
  });

  it('only real answers count: mocked, rule-answered, non-JSON, redirects and other origins are skipped', async () => {
    await stale();
    const x = () => answer('GET', `${A}/users/42`, 200, userBody({ tier: 'gold' }));
    serve(
      { ...x(), state: 'mocked', matchedRuleId: `collection:${NAME}:1` },
      { ...x(), matchedRuleId: 'my-mock' },
      { ...x(), responseHeaders: { 'content-type': 'text/plain' }, responseBody: { text: 'hello', encoding: 'utf8' } },
      { ...x(), url: 'https://other.example/users/42' },
      { ...x(), responseBody: { text: '{"id":1', encoding: 'utf8', truncated: true } },
      { ...x(), status: 304 },
      { ...x(), method: 'OPTIONS' },
      { ...x(), kind: 'websocket' },
      x(),
      x(),
    );
    expect(core.state()[0].drift).toBeUndefined();
    serve({ ...x(), matchedRuleId: 'throttle-only' }); // a throttle-only rule still reached the server
    expect(core.state()[0].drift?.line).toBe('GET /users/:userId now has tier');
  });

  it('each exchange is looked at once (the proxy fires updates more than once)', async () => {
    await stale();
    const x = answer('GET', `${A}/users/42`, 200, userBody({ tier: 'gold' }));
    serve(x, x, x);
    expect(core.state()[0].drift).toBeUndefined();
  });

  it('a status the endpoint has no example for, three times (never 5xx)', async () => {
    const id = await stale();
    serve(...[1, 2, 3].map(() => answer('GET', `${A}/users/42`, 500, { error: 'boom' })));
    expect(core.state()[0].drift).toBeUndefined();
    serve(...[1, 2, 3].map(() => answer('GET', `${A}/users/42`, 409, { error: 'conflict' })));
    expect(core.driftOf(id)).toEqual([expect.objectContaining({ status: 409, changes: [{ kind: 'status', path: '', to: '409' }] })]);
  });

  it('ignore: hidden until the set of changes differs; kept in workspaceState; {id} alone = everything', async () => {
    const id = await stale();
    serve(...[1, 2, 3].map(() => answer('GET', `${A}/users/42`, 200, userBody({ tier: 'gold' }))));
    expect(await core.ignoreDrift(id, USER, 200)).toBe(1);
    expect(core.state()[0].drift).toBeUndefined();
    expect(Object.keys(memento.get<Record<string, string>>(DRIFT_IGNORED_KEY)!)).toEqual([`${ROOT}\0${id}\0${USER}\u0000200`]);
    // a new core (VS Code restarted) remembers what was ignored
    core = makeCore();
    await core.reload();
    serve(...[1, 2, 3].map(() => answer('GET', `${A}/users/42`, 200, userBody({ tier: 'gold' }))));
    expect(core.state()[0].drift).toBeUndefined();
    // another change: it comes back
    serve(...[1, 2, 3].map(() => answer('GET', `${A}/users/42`, 200, userBody({ tier: 'gold', badge: 'x' }))));
    expect(core.state()[0].drift?.line).toMatch(/now has/);
    // everything of the collection
    serve(...[1, 2, 3].map(() => answer('GET', `${A}/users/42`, 409, { e: 1 })));
    expect(core.driftOf(id).length).toBe(2);
    expect(await core.ignoreDrift(id)).toBe(2);
    expect(core.driftOf(id)).toEqual([]);
    await expect(core.ignoreDrift(id, undefined, 200)).rejects.toThrow(/status needs an endpoint/);
  });

  it('the setting off: nothing tracked, no drift fields; on again starts empty', async () => {
    const id = await stale();
    serve(...[1, 2, 3].map(() => answer('GET', `${A}/users/42`, 200, userBody({ tier: 'gold' }))));
    expect(core.driftOf(id)).toHaveLength(1);
    driftOn = false;
    core.refreshDrift();
    expect(core.state()[0].drift).toBeUndefined();
    expect(core.endpoints(id).some((e) => e.drift)).toBe(false);
    serve(...[1, 2, 3].map(() => answer('GET', `${A}/users/42`, 200, userBody({ tier: 'gold' }))));
    driftOn = true;
    expect(core.driftOf(id)).toEqual([]);
  });

  it('cleared when the collection file changes (a new parse)', async () => {
    const id = await stale();
    serve(...[1, 2, 3].map(() => answer('GET', `${A}/users/42`, 200, userBody({ tier: 'gold' }))));
    expect(core.driftOf(id)).toHaveLength(1);
    const f = `${DIR}/${NAME}.json`;
    files.put(f, `${files.text(f)}\n`);
    await core.reload();
    expect(core.driftOf(id)).toEqual([]);
  });

  it('turned on for this user, the collection answers itself: those exchanges never count', async () => {
    const id = await recorded();
    const rule = findRule(compileRules(core.rules()), 'GET', `${A}/users/42`)!;
    serve(...[1, 2, 3].map(() => answer('GET', `${A}/users/42`, 200, userBody({ tier: 'gold' }), { state: 'mocked', matchedRuleId: rule.id })));
    expect(core.driftOf(id)).toEqual([]);
  });
});

/** The span of the value at `p` in `text`. */
function span(text: string, p: (string | number)[]): { start: number; end: number } {
  const t = parseJsonTree(text);
  const n = locate(t.root!, p)!.node;
  return { start: n.start, end: n.end };
}

/** `after` = `before` with only [start, end) replaced (every other byte identical). */
function onlyChanged(before: string, after: string, at: { start: number; end: number }): void {
  expect(after.slice(0, at.start)).toBe(before.slice(0, at.start));
  expect(after.slice(after.length - (before.length - at.end))).toBe(before.slice(at.end));
}

/** `after` = `before` with one piece of text inserted somewhere (nothing else changed); the piece. */
function onlyInserted(before: string, after: string): { inserted: string } {
  let p = 0;
  while (p < before.length && before[p] === after[p]) p++;
  let q = 0;
  while (q < before.length - p && before[before.length - 1 - q] === after[after.length - 1 - q]) q++;
  expect(p + q).toBe(before.length);
  return { inserted: after.slice(p, after.length - q) };
}

describe('Update example (§23.4): Postman', () => {
  async function drifted(): Promise<string> {
    const id = await recorded();
    await core.update(id, { enabled: false });
    serve(...[1, 2, 3].map(() => answer('GET', `${A}/users/42`, 200, userBody({ tier: 'gold', ...SECRETS }))));
    expect(core.driftOf(id)).toHaveLength(1);
    return id;
  }

  it('merge: only the example body changes; the team values stay; sanitised; written after the hash check', async () => {
    const id = await drifted();
    const f = `${DIR}/${NAME}.json`;
    const before = files.text(f)!;
    const u = await core.exampleUpdate(id, USER, 200, 'merge');
    expect(u).toMatchObject({ mode: 'merge', example: '200 OK', file: `.vscode/flutter-intercept/collections/${NAME}.json`, format: 'postman' });
    expect(u.edit!.before).toBe(before);
    const at = (() => {
      const t = parseJsonTree(before).root!;
      // find the response named "200 OK" of that request by walking items
      const walk = (n: ReturnType<typeof parseJsonTree>['root'], p: (string | number)[]): (string | number)[] | undefined => {
        if (!n) return undefined;
        if (n.type === 'object') {
          const req = n.members.find((m) => m.key === 'request');
          if (req && JSON.stringify(before.slice(req.value.start, req.value.end)).includes(':userId')) {
            const res = n.members.find((m) => m.key === 'response')!.value;
            if (res.type === 'array') {
              const k = res.items.findIndex((x) => x.type === 'object' && x.members.some((m) => m.key === 'name' && m.value.type === 'string' && m.value.value === '200 OK'));
              if (k >= 0) return [...p, 'response', k, 'body'];
            }
          }
          for (const m of n.members) {
            const r = walk(m.value, [...p, m.key]);
            if (r) return r;
          }
        } else if (n.type === 'array') {
          for (let k = 0; k < n.items.length; k++) {
            const r = walk(n.items[k], [...p, k]);
            if (r) return r;
          }
        }
        return undefined;
      };
      return walk(t, [])!;
    })();
    onlyChanged(before, u.edit!.after, span(before, at));
    const body = JSON.parse((locate(parseJsonTree(u.edit!.after).root!, at)!.node as { value: string }).value);
    expect(body.tier).toBe('gold'); // the new field, from the newest answer
    expect(body.session).toBe(JWT_PLACEHOLDER); // sanitised as §23.1
    expect(body.apiKey).toBe('');
    expect(body.name).toBe('Ada Lovelace'); // the team's values stay
    expect(body.email).toBe('user1@example.com');
    clean('update', u);
    clean('diff', exampleDiff(u));
    await core.applyExampleUpdate(u);
    expect(files.text(f)).toBe(u.edit!.after);
    // the file changed: the drift observed so far is gone
    expect(core.driftOf(id)).toEqual([]);
    clean('logs', logs);
  });

  it('refused when the file changed since the preview', async () => {
    const id = await drifted();
    const f = `${DIR}/${NAME}.json`;
    const u = await core.exampleUpdate(id, USER, 200);
    files.put(f, `${files.text(f)} `);
    const now = files.text(f);
    await expect(core.applyExampleUpdate(u)).rejects.toThrow(/changed since the preview; nothing was written/);
    expect(files.text(f)).toBe(now);
  });

  it('add: a new example "<status> (from the server, <date>)" before the old one, everything else unchanged', async () => {
    const id = await drifted();
    const before = files.text(`${DIR}/${NAME}.json`)!;
    const u = await core.exampleUpdate(id, USER, 200, 'add');
    expect(u.example).toBe('200 (from the server, 2026-11-20)');
    onlyInserted(before, u.edit!.after);
    expect(u.edit!.after).toContain('"name": "200 (from the server, 2026-11-20)"');
    clean('add', u);
    await core.applyExampleUpdate(u);
    const ep = core.endpoints(id).find((e) => e.key === USER)!;
    expect(ep.examples.map((x) => x.name)).toEqual(['200 (from the server, 2026-11-20)', '200 OK', '404 Not Found']);
  });

  it('merge on a status without an example is refused (§24.9); add works there', async () => {
    const id = await recorded();
    await core.update(id, { enabled: false });
    serve(...[1, 2, 3].map(() => answer('GET', `${A}/users/42`, 409, { error: 'conflict', contact: 'grace@hopper.dev' })));
    await expect(core.exampleUpdate(id, USER, 409, 'merge')).rejects.toThrow(/has no example to merge into: add the server's answer as a new example instead/);
    const u = await core.exampleUpdate(id, USER, 409, 'add');
    expect(u.example).toBe('409 (from the server, 2026-11-20)');
    expect(JSON.parse(u.newBody)).toEqual({ error: 'conflict', contact: 'user1@example.com' });
  });

  it('refused without an answer in this session, or with nothing to merge', async () => {
    const id = await drifted();
    await expect(core.exampleUpdate(id, USER, 404, 'merge')).rejects.toThrow(/No answer of the server/);
    traffic = [];
    await expect(core.exampleUpdate(id, USER, 200)).rejects.toThrow(/No answer of the server for GET \/users\/:userId \(200\) is in this session/);
  });
});

const OPENAPI = {
  openapi: '3.0.3',
  info: { title: 'Pets', version: '1' },
  servers: [{ url: 'https://pets.example' }],
  paths: {
    '/pets/{id}': {
      get: {
        responses: {
          '200': { description: 'ok', content: { 'application/json': { examples: { rex: { value: { id: 1, name: 'Rex' } } } } } },
        },
      },
    },
    '/owners/{id}': {
      get: { responses: { '200': { description: 'ok', content: { 'application/json': { example: { id: 1, name: 'Ann' } } } } } },
    },
    '/toys': {
      get: { responses: { '200': { description: 'ok', content: { 'application/json': { schema: { type: 'object', properties: { id: { type: 'integer' }, name: { type: 'string' } }, required: ['id', 'name'] } } } } } },
    },
  },
};

describe('Update example (§23.4): OpenAPI', () => {
  const P = 'https://pets.example';
  async function linked(file: string, text: string): Promise<string> {
    files.put(`${ROOT}/${file}`, text);
    const { id } = await core.addLink({ file });
    return id;
  }

  it('JSON, examples[k].value: merge splices only that value; add inserts a named example', async () => {
    const text = `${JSON.stringify(OPENAPI, null, '\t')}\r\n`;
    const id = await linked('api/pets.json', text);
    serve(...[1, 2, 3].map((n) => answer('GET', `${P}/pets/${n}`, 200, { id: n, name: 'Fido', vaccinated: true, owner: 'grace@hopper.dev' })));
    expect(core.driftOf(id)[0].changes.map((c) => c.path).sort()).toEqual(['owner', 'vaccinated']);
    const u = await core.exampleUpdate(id, 'GET /pets/{id}', 200, 'merge');
    expect(u.example).toBe('200 · rex');
    onlyChanged(text, u.edit!.after, span(text, ['paths', '/pets/{id}', 'get', 'responses', '200', 'content', 'application/json', 'examples', 'rex', 'value']));
    const merged = JSON.parse(u.edit!.after).paths['/pets/{id}'].get.responses['200'].content['application/json'].examples.rex.value;
    expect(merged).toEqual({ id: 1, name: 'Rex', vaccinated: true, owner: 'user1@example.com' });
    expect(u.edit!.after).toContain('\r\n'); // the file's line ends and tabs kept around it
    const add = await core.exampleUpdate(id, 'GET /pets/{id}', 200, 'add');
    expect(add.example).toBe('200 · from the server, 2026-11-20');
    onlyInserted(text, add.edit!.after);
    expect(add.edit!.after).toContain('"from the server, 2026-11-20": {\r\n');
    const ex = JSON.parse(add.edit!.after).paths['/pets/{id}'].get.responses['200'].content['application/json'].examples;
    expect(Object.keys(ex)).toEqual(['from the server, 2026-11-20', 'rex']);
    await core.applyExampleUpdate(u);
    expect(files.text(`${ROOT}/api/pets.json`)).toBe(u.edit!.after);
  });

  it('JSON, a single example: merge splices it; add without a named examples map is copy-only', async () => {
    const text = JSON.stringify(OPENAPI, null, 2);
    const id = await linked('api/pets.json', text);
    serve(...[1, 2, 3].map((n) => answer('GET', `${P}/owners/${n}`, 200, { id: n, name: 'Bo', city: 'Oslo' })));
    const u = await core.exampleUpdate(id, 'GET /owners/{id}', 200);
    onlyChanged(text, u.edit!.after, span(text, ['paths', '/owners/{id}', 'get', 'responses', '200', 'content', 'application/json', 'example']));
    expect(JSON.parse(u.edit!.after).paths['/owners/{id}'].get.responses['200'].content['application/json'].example).toEqual({ id: 1, name: 'Ann', city: 'Oslo' });
    const add = await core.exampleUpdate(id, 'GET /owners/{id}', 200, 'add');
    expect(add.edit).toBeUndefined();
    expect(add.copyOnly).toMatch(/no named examples/);
  });

  it('a generated example is copy-only', async () => {
    const id = await linked('api/pets.json', JSON.stringify(OPENAPI));
    serve(...[1, 2, 3].map((n) => answer('GET', `${P}/toys`, 200, { id: n, name: 'Ball', color: 'red' })));
    const u = await core.exampleUpdate(id, 'GET /toys', 200);
    expect(u.edit).toBeUndefined();
    expect(u.copyOnly).toMatch(/generated from the schema/);
    expect(JSON.parse(u.newBody)).toMatchObject({ color: 'red' });
    await expect(core.applyExampleUpdate(u)).rejects.toThrow(/isn't edited here: copy the updated example instead/);
  });

  it('YAML: copy only, the file is never written', async () => {
    const yaml = [
      'openapi: 3.0.3',
      'info: {title: Pets, version: "1"}',
      'servers: [{url: "https://pets.example"}]',
      'paths:',
      '  /pets/{id}:',
      '    get:',
      '      responses:',
      '        "200":',
      '          description: ok',
      '          content:',
      '            application/json:',
      '              example: {id: 1, name: Rex}',
      '',
    ].join('\n');
    const id = await linked('api/pets.yaml', yaml);
    serve(...[1, 2, 3].map((n) => answer('GET', `${P}/pets/${n}`, 200, { id: n, name: 'Fido', vaccinated: true })));
    const u = await core.exampleUpdate(id, 'GET /pets/{id}', 200);
    expect(u.edit).toBeUndefined();
    expect(u.copyOnly).toMatch(/OpenAPI YAML files are not edited here/);
    expect(JSON.parse(u.newBody)).toEqual({ id: 1, name: 'Rex', vaccinated: true });
    const writes = files.writes.length;
    await expect(core.applyExampleUpdate(u)).rejects.toThrow(/isn't edited here/);
    expect(files.writes.length).toBe(writes);
    expect(files.text(`${ROOT}/api/pets.yaml`)).toBe(yaml);
  });
});

describe('exampleDiff (§23.5)', () => {
  it('a unified diff of the readable bodies; a view redacts first', () => {
    const u: ExampleUpdate = {
      id: 'c',
      endpoint: 'GET /u',
      status: 200,
      mode: 'merge',
      file: 'api/c.json',
      format: 'postman',
      example: 'OK',
      oldBody: '{"id":1,"name":"Ann","token":"abc"}',
      newBody: '{"id":1,"name":"Ann","token":"abc","tier":"gold"}',
      changes: [{ kind: 'added', path: 'tier' }],
    };
    const d = exampleDiff(u);
    expect(d.split('\n').slice(0, 2)).toEqual(['--- api/c.json · GET /u · example "OK"', '+++ api/c.json · GET /u · example "OK", merged with the server\'s answer']);
    expect(d).toContain('+  "tier": "gold"');
    expect(d).toContain('-  "token": "abc"');
    const redacted = exampleDiff(u, (b) => b.replace(/abc/g, '[redacted]'));
    expect(redacted).not.toContain('abc');
  });
});
