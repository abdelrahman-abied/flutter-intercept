// CONTRACTS §23.3: drift — the collection's examples against what the server answers now.
import { describe, expect, it } from 'vitest';
import {
  DRIFT_LIMITS,
  DriftTracker,
  compareDrift,
  driftFingerprint,
  driftLine,
  driftSummary,
  endpointLabel,
  formatDriftPath,
  parseDriftPath,
  shapeOf,
  type DriftChange,
  type DriftExample,
} from '../../src/mocks/drift';
import { expectWithin } from './timing';

const EP = 'GET {{baseUrl}}/users/:id';
const LINK = 'shop';

function feed(t: DriftTracker, example: DriftExample | undefined, bodies: unknown[], status = 200, endpoint = EP): void {
  for (const b of bodies) t.observe({ linkId: LINK, endpoint, status, body: typeof b === 'string' ? b : JSON.stringify(b) }, example);
}

const changesOf = (t: DriftTracker): DriftChange[] => t.findings(LINK).flatMap((v) => v.changes);

const user = { id: 1, name: 'Ada', email: 'a@x.dev', price: 1, rating: 4.5, tags: [] as unknown[], meta: { '17': { x: 1 } }, items: [{ sku: 'a', qty: 1 }] };
const example: DriftExample = { status: 200, body: JSON.stringify(user) };

describe('DriftTracker: noise produces nothing', () => {
  it('stays quiet while answers match, before 3 answers, and for value changes', () => {
    const t = new DriftTracker();
    feed(t, example, [{ ...user, name: 'Bob', id: 2 }, { ...user, email: 'b@y.dev' }]);
    expect(t.findings(LINK)).toEqual([]);
    feed(t, example, [{ ...user, price: 2 }]);
    expect(t.findings(LINK)).toEqual([]);
  });

  it('ignores optional fields, an A/B field in 1 of 3, map-like objects and empty arrays', () => {
    const t = new DriftTracker();
    feed(t, example, [
      // `note` only in some items (optional), `beta` in 1 of 3, map keys change, tags fill up, items empty once
      { ...user, items: [{ sku: 'a', qty: 1, note: 'n' }, { sku: 'b', qty: 2 }], meta: { '18': { y: 's' } }, tags: [{ t: 1 }], beta: true },
      { ...user, items: [{ sku: 'a', qty: 1 }, { sku: 'b', qty: 2, note: 'x' }], meta: { '550e8400-e29b-41d4-a716-446655440000': 1 }, tags: [{ t: 2 }] },
      { ...user, items: [], meta: {}, tags: ['x'] },
    ]);
    expect(t.findings(LINK)).toEqual([]);
  });

  it('ignores double → int (writers drop .0) and mixed kinds', () => {
    const t = new DriftTracker();
    feed(t, example, ['{"id":1,"name":"a","email":"e","price":1,"rating":4,"tags":[],"meta":{},"items":[{"sku":"a","qty":1}]}'].concat(
      Array(2).fill('{"id":1,"name":"a","email":"e","price":1,"rating":5,"tags":[],"meta":{},"items":[{"sku":"a","qty":1},{"sku":"b","qty":"2"}]}'),
    ));
    expect(t.findings(LINK)).toEqual([]);
  });
});

describe('DriftTracker: one finding per kind', () => {
  it('added: in all of the last 3 answers, not in the example', () => {
    const t = new DriftTracker({ now: () => 1234 });
    feed(t, example, [1, 2, 3].map(() => ({ ...user, avatar: 'a.png' })));
    expect(t.findings(LINK)).toEqual([{ endpoint: EP, status: 200, samples: 3, since: 1234, changes: [{ kind: 'added', path: 'avatar', to: 'string' }] }]);
  });

  it('added inside every element of an array of objects (topmost only)', () => {
    const t = new DriftTracker();
    feed(t, example, [1, 2, 3].map(() => ({ ...user, items: [{ sku: 'a', qty: 1, discount: { pct: 5 } }, { sku: 'b', qty: 1, discount: { pct: 0 } }] })));
    expect(changesOf(t)).toEqual([{ kind: 'added', path: 'items[].discount', to: 'object' }]);
  });

  it('removed: in the example, in none of the 3 (never for a generated example)', () => {
    const { email: _e, ...rest } = user;
    const t = new DriftTracker();
    feed(t, example, [rest, rest, rest]);
    expect(changesOf(t)).toEqual([{ kind: 'removed', path: 'email', from: 'string' }]);
    const g = new DriftTracker();
    feed(g, { ...example, generated: true }, [rest, rest, rest]);
    expect(g.findings(LINK)).toEqual([]);
  });

  it('type: another non-null kind in all 3; int → double counts', () => {
    const t = new DriftTracker();
    feed(t, example, [1, 2, 3].map((n) => ({ ...user, id: `u${n}` })));
    expect(changesOf(t)).toEqual([{ kind: 'type', path: 'id', from: 'int', to: 'string' }]);
    const d = new DriftTracker();
    feed(d, example, Array(3).fill(JSON.stringify(user).replace('"price":1', '"price":1.5')));
    expect(changesOf(d)).toEqual([{ kind: 'type', path: 'price', from: 'int', to: 'double' }]);
  });

  it('a type change hides what was under the old value', () => {
    const t = new DriftTracker();
    feed(t, example, [1, 2, 3].map(() => ({ ...user, items: 'none' })));
    expect(changesOf(t)).toEqual([{ kind: 'type', path: 'items', from: 'list', to: 'string' }]);
  });

  it('nullable: null in ≥ 2 of the 3 where the example has a value', () => {
    const t = new DriftTracker();
    feed(t, example, [{ ...user, email: null }, { ...user }, { ...user, email: null }]);
    expect(changesOf(t)).toEqual([{ kind: 'nullable', path: 'email', from: 'string', to: 'null' }]);
  });

  it('status: 3 answers with a status the endpoint has no example for; 5xx never', () => {
    const t = new DriftTracker();
    feed(t, undefined, ['{"error":"gone"}', '{"error":"gone"}'], 410);
    expect(t.findings(LINK)).toEqual([]);
    feed(t, undefined, ['{"error":"gone"}'], 410);
    expect(t.findings(LINK)).toEqual([expect.objectContaining({ status: 410, changes: [{ kind: 'status', path: '', to: '410' }] })]);
    feed(t, undefined, ['{}', '{}', '{}', '{}'], 503);
    expect(t.findings(LINK)).toHaveLength(1);
  });

  it('clears when newer answers disagree', () => {
    const t = new DriftTracker();
    feed(t, example, [1, 2, 3].map(() => ({ ...user, avatar: 'a.png' })));
    expect(t.findings(LINK)).toHaveLength(1);
    feed(t, example, [user]);
    expect(t.findings(LINK)).toEqual([]);
    expect(t.fingerprint(LINK, EP, 200)).toBeUndefined();
  });

  it('follows the example the host passes (the collection was updated)', () => {
    const t = new DriftTracker();
    const answers = [1, 2, 3].map(() => ({ ...user, avatar: 'a.png' }));
    feed(t, example, answers);
    expect(t.findings(LINK)).toHaveLength(1);
    feed(t, { status: 200, body: JSON.stringify({ ...user, avatar: 'x' }) }, [answers[0]]);
    expect(t.findings(LINK)).toEqual([]);
  });

  it('stays within depth 8 and 20 changes per endpoint', () => {
    let deep: Record<string, unknown> = { leaf: 1 };
    let deepNew: Record<string, unknown> = { leaf: 1, extra: 2 };
    for (let i = 0; i < 10; i++) {
      deep = { n: deep };
      deepNew = { n: deepNew };
    }
    const t = new DriftTracker();
    feed(t, { status: 200, body: JSON.stringify(deep) }, [deepNew, deepNew, deepNew]);
    expect(t.findings(LINK)).toEqual([]);

    const wide = Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`f${i}`, i]));
    const w = new DriftTracker();
    feed(w, { status: 200, body: '{}' }, [wide, wide, wide]);
    expect(changesOf(w)).toHaveLength(DRIFT_LIMITS.changesPerEndpoint);
  });
});

describe('DriftTracker: ignore, fingerprints, limits', () => {
  it('ignore hides a finding until its set of changes differs', () => {
    const t = new DriftTracker();
    feed(t, example, [1, 2, 3].map(() => ({ ...user, avatar: 'a.png' })));
    const fp = t.fingerprint(LINK, EP, 200)!;
    expect(fp).toBe(driftFingerprint(EP, 200, [{ kind: 'added', path: 'avatar', to: 'string' }]));
    t.ignore(fp);
    expect(t.isIgnored(fp)).toBe(true);
    expect(t.findings(LINK)).toEqual([]);
    feed(t, example, [{ ...user, avatar: 'b.png' }]); // same set: still hidden
    expect(t.findings(LINK)).toEqual([]);
    feed(t, example, [1, 2, 3].map(() => ({ ...user, avatar: 'a.png', badge: 1 })));
    expect(changesOf(t).map((c) => c.path)).toEqual(['avatar', 'badge']);
    // ignored fingerprints come back from workspaceState
    expect(new DriftTracker({ ignored: [fp] }).isIgnored(fp)).toBe(true);
  });

  it('fingerprints ignore order, samples and time, and differ per endpoint', () => {
    const a: DriftChange[] = [{ kind: 'added', path: 'a', to: 'int' }, { kind: 'removed', path: 'b', from: 'string' }];
    expect(driftFingerprint(EP, 200, a)).toBe(driftFingerprint(EP, 200, [...a].reverse()));
    expect(driftFingerprint(EP, 200, a)).not.toBe(driftFingerprint('GET {{baseUrl}}/x', 200, a));
    expect(driftFingerprint(EP, 200, a)).not.toBe(driftFingerprint(EP, 201, a));
  });

  it('keeps ≤ 500 windows per link (least recently used dropped) and forgets on request', () => {
    const t = new DriftTracker();
    for (let i = 0; i < 600; i++) feed(t, example, [user], 200, `GET {{baseUrl}}/e${i}`);
    expect(t.windows(LINK)).toBe(DRIFT_LIMITS.windowsPerLink);
    t.forget(LINK, 'GET {{baseUrl}}/e599');
    expect(t.windows(LINK)).toBe(DRIFT_LIMITS.windowsPerLink - 1);
    t.forget(LINK);
    expect(t.windows(LINK)).toBe(0);
  });

  it('ignores bodies that are not JSON', () => {
    const t = new DriftTracker();
    feed(t, example, ['<html>', '{"a":', 'null x']);
    expect(t.findings(LINK)).toEqual([]);
    expect(shapeOf('{"a":1,}')).toBeUndefined();
    expect(shapeOf('{"a\\u0022b":[1,2.0,"x"]}')?.nodes.has('a"b[]')).toBe(true);
  });

  it('observes a 100 KB answer within 2 ms', async () => {
    const items = Array.from({ length: 950 }, (_, i) => ({ id: i, name: `item ${i}`, price: i + 0.5, tags: ['a', 'b'], owner: { id: i, email: `u${i}@x.dev`, active: true } }));
    const body = JSON.stringify({ items, total: 950 });
    expect(body.length).toBeGreaterThan(100 * 1024);
    expect(body.length).toBeLessThan(120 * 1024);
    const t = new DriftTracker();
    const ex: DriftExample = { status: 200, body };
    feed(t, ex, [body, body, body]); // warm; the example's shape is cached
    await expectWithin(() => t.observe({ linkId: LINK, endpoint: EP, status: 200, body }, ex), 2, 7);
  });
});

describe('lines and paths', () => {
  it('builds "GET /users/:id now has avatar (and 2 more)"', () => {
    const views = [
      { endpoint: EP, status: 200, samples: 3, since: 0, changes: [{ kind: 'added' as const, path: 'avatar', to: 'string' }, { kind: 'removed' as const, path: 'email', from: 'string' }] },
      { endpoint: 'POST {{baseUrl}}/login', status: 401, samples: 3, since: 0, changes: [{ kind: 'status' as const, path: '', to: '401' }] },
    ];
    expect(driftLine(views)).toBe('GET /users/:id now has avatar (and 2 more)');
    expect(driftSummary(views)).toEqual({ endpoints: 2, line: 'GET /users/:id now has avatar (and 2 more)' });
    expect(driftSummary([])).toBeUndefined();
    expect(driftLine([{ ...views[1] }])).toBe('POST /login now answers 401');
    expect(endpointLabel('GET https://api.x.example:8443/a/b #2')).toBe('GET /a/b #2');
    expect(endpointLabel('GET {{baseUrl}}')).toBe('GET /');
  });

  it('round-trips paths with escaped keys', () => {
    const segs = ['items', [] as [], 'a.b', 'c[]', 'd\\e'];
    const p = formatDriftPath(segs);
    expect(p).toBe('items[].a\\.b.c\\[\\].d\\\\e');
    expect(parseDriftPath(p)).toEqual(segs);
    expect(parseDriftPath('')).toEqual([]);
    expect(parseDriftPath('[]')).toEqual([[]]);
  });

  it('compareDrift needs the window to be full', () => {
    const ex = shapeOf('{"a":1}')!;
    const s = shapeOf('{"a":1,"b":2}')!;
    expect(compareDrift(ex, [s, s], false)).toEqual([]);
    expect(compareDrift(ex, [s, s, s], false)).toEqual([{ kind: 'added', path: 'b', to: 'int' }]);
  });
});
