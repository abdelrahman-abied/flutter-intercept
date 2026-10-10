import * as fs from 'fs';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import { checkValue, ModelLookup, pathKey } from '../../src/contract/check';
import { parseGeneratedDart } from '../../src/contract/generated';
import { IntegralDouble, parseJson } from '../../src/contract/json';
import { LinkedModel, linkModelsToOwner } from '../../src/contract/owner';

const FIX = path.join(__dirname, 'fixtures', 'contract');
const DEMO = path.join(__dirname, '..', '..', '..', '..', 'samples', 'demo_app', 'lib');

function index(...pairs: [string, string][]): ModelLookup & { all: LinkedModel[] } {
  const all: LinkedModel[] = [];
  for (const [gen, owner] of pairs) {
    const info = parseGeneratedDart(fs.readFileSync(gen, 'utf8'), gen);
    linkModelsToOwner(info.models, fs.readFileSync(owner, 'utf8'), owner);
    all.push(...(info.models as LinkedModel[]));
  }
  return { all, get: (n) => all.find((m) => m.name === n) };
}

const demo = index([path.join(DEMO, 'models', 'user.g.dart'), path.join(DEMO, 'models', 'user.dart')], [path.join(DEMO, 'models', 'todo.g.dart'), path.join(DEMO, 'models', 'todo.dart')]);
const probe = index([path.join(FIX, 'probe', 'models.g.dart'), path.join(FIX, 'probe', 'models.dart')]);
const order = index([path.join(FIX, 'legacy', 'order.g.dart'), path.join(FIX, 'legacy', 'order.dart')]);

// jsonplaceholder's real /users/1
const realUser = {
  id: 1,
  name: 'Leanne Graham',
  username: 'Bret',
  email: 'Sincere@april.biz',
  address: { street: 'Kulas Light', suite: 'Apt. 556', city: 'Gwenborough', zipcode: '92998-3874', geo: { lat: '-37.3159', lng: '81.1496' } },
  phone: '1-770-736-8031 x56442',
  website: 'hildegard.org',
  company: { name: 'Romaguera-Crona', catchPhrase: 'Multi-layered client-server neural-net', bs: 'harness real-time e-markets' },
};

const run = (lookup: ModelLookup, model: string, body: unknown, listOf = false, opts = {}) => {
  const parsed = parseJson(JSON.stringify(body));
  if (!parsed.ok) throw new Error('bad json');
  return checkValue(parsed.value, lookup.get(model)!, listOf, lookup, { method: 'GET', urlPath: '/users/1', ...opts });
};

describe('parseJson', () => {
  it('keeps Dart number semantics: 1.0 is a double', () => {
    const r = parseJson('{"a": 1, "b": 1.0, "c": 1.5, "d": 2e3, "e": -0, "s": "x\\u00e9\\n", "n": null, "l": [true, false]}');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const v = r.value as Record<string, unknown>;
    expect(v.a).toBe(1);
    expect(v.b).toBeInstanceOf(IntegralDouble);
    expect(v.c).toBe(1.5);
    expect(v.d).toBeInstanceOf(IntegralDouble);
    expect(v.s).toBe('xé\n');
    expect(v.l).toEqual([true, false]);
    expect(Object.getPrototypeOf(v)).toBeNull();
  });
  it('rejects invalid JSON with a reason and never throws', () => {
    for (const bad of ['', '{', '{"a":}', '[1,]', 'nul', '"\u0001"', '01', '{"a" 1}', '1 2', '{"a":1}}']) {
      const r = parseJson(bad);
      expect(r.ok, bad).toBe(false);
    }
    expect(parseJson('['.repeat(10_000) + ']'.repeat(10_000)).ok).toBe(true); // deep: JSON.parse fallback
    expect(parseJson('﻿{"a":1}').ok).toBe(true);
  });
  it('keeps __proto__ as a plain key', () => {
    const r = parseJson('{"__proto__": {"x": 1}}');
    expect(r.ok && Object.keys(r.value as object)).toEqual(['__proto__']);
  });
});

describe('checkValue on the demo models', () => {
  it('real jsonplaceholder data is clean (no false positives)', () => {
    expect(run(demo, 'User', realUser).violations).toEqual([]);
  });

  it('a nulled required field is an error on the model field line, like the contract example', () => {
    const { violations } = run(demo, 'User', { ...realUser, email: null });
    expect(violations).toHaveLength(1);
    const v = violations[0];
    expect(v).toMatchObject({ path: '$.email', model: 'User', field: 'email', key: 'email', expected: 'String', actual: 'null', severity: 'error' });
    expect(v.message).toBe("email is null in GET /users/1 → type 'Null' is not a subtype of type 'String' in type cast");
    expect(v.file).toBe(path.join(DEMO, 'models', 'user.dart'));
    expect(fs.readFileSync(v.file!, 'utf8').split('\n')[v.line! - 1]).toMatch(/final String email;/);
    expect(v.column).toBe(15);
  });

  it('missing / wrong-typed nested fields report their path and the nested model', () => {
    const body = structuredClone(realUser) as Record<string, any>;
    delete body.address.zipcode;
    body.address.geo.lat = -37.3159;
    body.username = 42;
    const { violations } = run(demo, 'User', body);
    expect(violations.map((v) => [v.path, v.model, v.field, v.actual])).toEqual([
      ['$.username', 'User', 'handle', 'number 42'],
      ['$.address.zipcode', 'Address', 'zipCode', 'missing'],
      ['$.address.geo.lat', 'Geo', 'lat', 'number -37.3159'],
    ]);
    expect(violations[2].message).toBe("address.geo.lat is a number (-37.3159) in GET /users/1 → type 'double' is not a subtype of type 'String' in type cast");
  });

  it('a nested object that is null or a list is an error', () => {
    expect(run(demo, 'User', { ...realUser, company: null }).violations[0].message).toContain("type 'Null' is not a subtype of type 'Map<String, dynamic>'");
    expect(run(demo, 'User', { ...realUser, company: [] }).violations[0].message).toContain("type 'List<dynamic>' is not a subtype of type 'Map<String, dynamic>'");
  });

  it('nullable and defaulted fields accept null / missing; extra keys are ignored', () => {
    expect(run(demo, 'User', { ...realUser, avatar_url: null, tier: null, extra: 1 }).violations).toEqual([]);
  });

  it('an unknown value of a lenient enum is a warning naming the fallback', () => {
    const { violations } = run(demo, 'User', { ...realUser, tier: 'gold' });
    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({ severity: 'warning', actual: 'unknown enum value "gold"', expected: 'enum UserTier(free|pro|unknown)' });
    expect(violations[0].message).toBe('tier is "gold" in GET /users/1 → not a UserTier value: decoded as UserTier.unknown');
  });

  it('a list response checks every element and merges repeats', () => {
    const todos = Array.from({ length: 20 }, (_, i) => ({ userId: 1, id: i + 1, title: i % 2 ? null : 't', completed: false }));
    const { violations } = run(demo, 'Todo', todos, true, { urlPath: '/users/1/todos' });
    expect(violations).toHaveLength(1);
    expect(violations[0].path).toBe('$[1].title');
    expect(violations[0].count).toBe(10);
    expect(violations[0].message).toMatch(/\(10 places in this response\)$/);
    const notList = run(demo, 'Todo', { a: 1 }, true);
    expect(notList.violations[0]).toMatchObject({ path: '$', expected: 'List<Todo>', actual: 'object' });
    expect(notList.violations[0].message).toMatch(/^the response is an object in GET .* type '_Map<String, dynamic>' is not a subtype of type 'List<dynamic>'/);
  });
});

describe('checkValue: every wire type', () => {
  const good = {
    first_name: 'A',
    created_at: '2024-01-02T03:04:05.123Z',
    score: 1,
    tags: ['x'],
    matrix: [[1, 2.5]],
    items: [{ 'item-id': 1, price: 2, label: 'l' }],
    by_id: { a: { 'item-id': 2, price: 1.5, label: 'm' } },
    role: 'admin',
    big: '123456789012345678901234567890',
    duration: 10,
    flag: true,
    extra: { anything: [1, null] },
    epoch: 'not checked: converter',
    nested: { 'item-id': 3, price: 0, label: 'n' },
    names_by_id: { a: 'b' },
    set_of: [],
  };

  it('a complete valid body is clean', () => {
    expect(run(probe, 'Profile', good).violations).toEqual([]);
  });

  const cases: [string, Record<string, unknown>, string, 'error' | 'warning', RegExp][] = [
    ['date', { created_at: '02/01/2024' }, '$.created_at', 'error', /FormatException: Invalid date format/],
    ['date number', { created_at: 1700000000 }, '$.created_at', 'error', /type 'int' is not a subtype of type 'String'/],
    ['double as string', { score: '1.5' }, '$.score', 'error', /type 'String' is not a subtype of type 'num'/],
    ['list element', { tags: ['x', 3] }, '$.tags[1]', 'error', /type 'int' is not a subtype of type 'String'/],
    ['list null element', { tags: [null] }, '$.tags[0]', 'error', /type 'Null' is not a subtype of type 'String'/],
    ['nested list', { matrix: [[1], ['a']] }, '$.matrix[1][0]', 'error', /'String' is not a subtype of type 'num'/],
    ['model in list', { items: [{ 'item-id': 1, price: 2 }] }, "$.items[0].label", 'error', /MissingRequiredKeysException/],
    ['checked wrap', { items: [{ 'item-id': 'x', price: 2, label: 'l' }] }, "$.items[0]['item-id']", 'error', /^.*CheckedFromJsonException: Could not create `Item`. There is a problem with "item-id". type 'String' is not a subtype of type 'num'/],
    ['disallowNull', { nested: { 'item-id': 1, price: 2, label: null } }, '$.nested.label', 'error', /DisallowedNullValueException/],
    ['map value', { by_id: { a: 5 } }, '$.by_id.a', 'error', /'int' is not a subtype of type 'Map<String, dynamic>'/],
    ['map odd key', { names_by_id: { 'a b': 1 } }, "$.names_by_id['a b']", 'error', /'int' is not a subtype of type 'String'/],
    ['enum', { role: 'guest' }, '$.role', 'error', /Invalid argument\(s\): `guest` is not one of the supported values: admin, user/],
    ['enum null', { role: null }, '$.role', 'error', /A value must be provided. Supported values: admin, user/],
    ['enum missing', { role: undefined }, '$.role', 'error', /A value must be provided/],
    ['bigint', { big: '12x' }, '$.big', 'error', /Could not parse BigInt/],
    ['bool', { flag: 'true' }, '$.flag', 'error', /'String' is not a subtype of type 'bool'/],
    ['int truncation', { duration: 1.5 }, '$.duration', 'warning', /toInt\(\) truncates it to 1/],
    ['nullable typed', { surname: 3 }, '$.surname', 'error', /type 'int' is not a subtype of type 'String\?' in type cast/],
    ['nullable enum unknown → null', { status: 'gone' }, '$.status', 'warning', /decoded as null/],
    ['map of dynamic not a map', { extra: 'x' }, '$.extra', 'error', /'String' is not a subtype of type 'Map<String, dynamic>'/],
  ];
  for (const [name, patch, p, severity, msg] of cases) {
    it(name, () => {
      const { violations } = run(probe, 'Profile', { ...good, ...patch });
      expect(violations, JSON.stringify(violations)).toHaveLength(1);
      expect(violations[0].path).toBe(p);
      expect(violations[0].severity).toBe(severity);
      expect(violations[0].message).toMatch(msg);
    });
  }

  it('enum JSON values keep their types (2 matches 2, not "2")', () => {
    expect(run(probe, 'Profile', { ...good, status: 2 }).violations).toEqual([]);
    expect(run(probe, 'Profile', { ...good, status: '2' }).violations[0].severity).toBe('warning');
  });
});

describe('strict `as int` (json_serializable < 6.8)', () => {
  const base = { order_id: 1, total: 2, placed_at: '2024-01-01', state: 'open' };
  it('a double for `as int` is an error, also when written 1.0', () => {
    const lookup = order;
    const m = lookup.get('Order')!;
    const check = (text: string) => {
      const r = parseJson(text);
      if (!r.ok) throw new Error(r.error);
      return checkValue(r.value, m, false, lookup, { method: 'GET', urlPath: '/o' }).violations;
    };
    expect(check(JSON.stringify(base))).toEqual([]);
    expect(check(JSON.stringify({ ...base, order_id: 1.5 }))[0].message).toMatch(/type 'double' is not a subtype of type 'int' in type cast/);
    expect(check(JSON.stringify(base).replace('"order_id":1', '"order_id":1.0'))[0]).toMatchObject({ actual: 'number 1.0', severity: 'error' });
    expect(check(JSON.stringify({ ...base, quantity: 2.5 }))[0].message).toMatch(/'double' is not a subtype of type 'int\?'/);
    expect(check(JSON.stringify({ ...base, items: [null] }))[0].message).toMatch(/'Null' is not a subtype of type 'Map<String, dynamic>'/);
    // `(as num).toDouble()` takes ints
    expect(check(JSON.stringify({ ...base, total: 3 }))).toEqual([]);
  });
});

describe('limits', () => {
  it('stops after 50 violations', () => {
    const items = Array.from({ length: 200 }, (_, i) => ({ [`k${i}`]: 1 }));
    const lookup: ModelLookup = {
      get: () =>
        ({
          name: 'M',
          generatedFile: '/x.g.dart',
          generatedLine: 1,
          fn: '_$MFromJson',
          fields: Array.from({ length: 200 }, (_, i) => ({ key: `k${i}`, dartName: `k${i}`, type: { kind: 'string' }, nullable: false, hasDefault: false })),
        }) as LinkedModel,
    };
    const { violations } = checkValue(Object.assign({}, ...items), lookup.get('M')!, false, lookup, { method: 'GET', urlPath: '/' });
    expect(violations).toHaveLength(50);
    expect(violations[0].file).toBe('/x.g.dart'); // no owner: falls back to the generated file
  });

  it('checks a typical response in well under 5 ms and caps huge bodies', () => {
    const body = JSON.stringify(realUser);
    const m = demo.get('User')!;
    const t0 = performance.now();
    for (let i = 0; i < 200; i++) {
      const r = parseJson(body);
      if (r.ok) checkValue(r.value, m, false, demo, { method: 'GET', urlPath: '/users/1' });
    }
    expect((performance.now() - t0) / 200).toBeLessThan(5);

    const many = JSON.stringify(Array.from({ length: 50_000 }, (_, i) => ({ userId: 1, id: i, title: 't', completed: true })));
    const t1 = performance.now();
    const r = parseJson(many);
    const out = r.ok ? checkValue(r.value, demo.get('Todo')!, true, demo, { method: 'GET', urlPath: '/todos', maxNodes: 10_000 }) : undefined;
    expect(out?.partial).toMatch(/stopped after 10000 values/);
    expect(performance.now() - t1).toBeLessThan(1000);
  });

  it('pathKey matches the proxy jsonpath canonical form', () => {
    expect(pathKey('$', 'avatar_url')).toBe('$.avatar_url');
    expect(pathKey('$', 'item-id')).toBe("$['item-id']");
    expect(pathKey('$', "it's")).toBe("$['it\\'s']");
  });
});
