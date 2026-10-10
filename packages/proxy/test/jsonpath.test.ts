// jsonpath.ts (CONTRACTS §10.2) and json-text.ts (number-preserving JSON for mutate rules). Pure.
import { describe, expect, it } from 'vitest';
import { applyOps, formatPath, parsePath, SELECT_LIMIT, selectPath, type PathSegment } from '../src/jsonpath';
import { MAX_JSON_DEPTH, parseJsonText, RawNumber, stringifyJsonText } from '../src/json-text';
import { mutateLabel } from '../src/mutate';

describe('parsePath', () => {
  it('parses every form of the grammar', () => {
    expect(parsePath('$')).toEqual([]);
    expect(parsePath('  $  ')).toEqual([]);
    expect(parsePath('$.avatar_url')).toEqual([{ key: 'avatar_url' }]);
    expect(parsePath('$.user.avatar-url')).toEqual([{ key: 'user' }, { key: 'avatar-url' }]);
    expect(parsePath('$.items[0].id')).toEqual([{ key: 'items' }, { index: 0 }, { key: 'id' }]);
    expect(parsePath('$.items[*].price')).toEqual([{ key: 'items' }, { wildcard: true }, { key: 'price' }]);
    expect(parsePath('$.items.*')).toEqual([{ key: 'items' }, { wildcard: true }]);
    expect(parsePath("$['odd key']")).toEqual([{ key: 'odd key' }]);
    expect(parsePath('$["odd key"][12]')).toEqual([{ key: 'odd key' }, { index: 12 }]);
    expect(parsePath("$[ 'a' ][ 3 ][ * ]")).toEqual([{ key: 'a' }, { index: 3 }, { wildcard: true }]);
    expect(parsePath('$.$ref._x9')).toEqual([{ key: '$ref' }, { key: '_x9' }]);
    expect(parsePath('$.名前')).toEqual([{ key: '名前' }]);
    expect(parsePath("$['0']")).toEqual([{ key: '0' }]);
  });

  it('understands escapes in quoted keys', () => {
    expect(parsePath(String.raw`$['it\'s']`)).toEqual([{ key: "it's" }]);
    expect(parsePath(String.raw`$["say \"hi\""]`)).toEqual([{ key: 'say "hi"' }]);
    expect(parsePath(String.raw`$['a\\b']`)).toEqual([{ key: 'a\\b' }]);
    expect(parsePath(String.raw`$['line\nbreak\té\/']`)).toEqual([{ key: 'line\nbreak\té/' }]);
    expect(parsePath(`$["it's"]`)).toEqual([{ key: "it's" }]);
    expect(parsePath(`$['a.b[0]']`)).toEqual([{ key: 'a.b[0]' }]);
  });

  it('throws readable errors', () => {
    const bad: [string, RegExp][] = [
      ['', /empty path/],
      ['avatar_url', /starts with "\$"/],
      ['$.', /expected a name after "\."/],
      ['$..a', /recursive descent/],
      ['$.a[', /unclosed "\["/],
      ['$.a[0', /unclosed "\["/],
      ["$['a]", /unterminated quoted key/],
      ["$['a'", /unclosed "\["/],
      ['$[-1]', /negative indexes/],
      ['$[?(@.a)]', /filter expressions/],
      ['$[0:2]', /slices/],
      ['$[:2]', /slices/],
      ['$[0,1]', /unions/],
      ['$[a]', /expected a quoted key, an index or "\*"/],
      ["$['a\\x']", /unknown escape/],
      ["$['\\u12']", /bad \\u escape/],
      ['$.a b', /unexpected " "/],
      ['$a', /unexpected "a"; expected "\." or "\["/],
      ['$.a*', /"\*" inside a name/],
      ['$[99999999999999999999]', /index too large/],
    ];
    for (const [path, re] of bad) {
      expect(() => parsePath(path), path).toThrow(re);
      expect(() => parsePath(path), path).toThrow(/^Invalid JSON path .*\(at position \d+\)$/);
    }
    expect(() => parsePath(undefined as unknown as string)).toThrow(/expected a string/);
  });
});

describe('formatPath', () => {
  it('writes the canonical form and round-trips', () => {
    expect(formatPath([])).toBe('$');
    expect(formatPath([{ key: 'a' }, { index: 0 }, { key: 'b c' }])).toBe("$.a[0]['b c']");
    expect(formatPath([{ key: 'avatar-url' }, { wildcard: true }])).toBe("$['avatar-url'][*]");
    expect(formatPath([{ key: "it's" }, { key: 'a\\b' }, { key: '' }, { key: '0' }])).toBe(String.raw`$['it\'s']['a\\b']['']['0']`);
    expect(formatPath([{ key: 'x\ny\u0001' }])).toBe(String.raw`$['x\ny\u0001']`);
    const samples: PathSegment[][] = [
      [{ key: 'a' }, { index: 3 }, { wildcard: true }, { key: 'with space' }],
      [{ key: "q'uo\"te" }, { key: '\\' }, { key: 'tab\there' }, { key: '\ud800' }, { key: '😀' }],
      [{ key: '$' }, { key: '_' }, { key: '1abc' }],
    ];
    for (const segs of samples) expect(parsePath(formatPath(segs))).toEqual(segs);
    expect(formatPath(parsePath('$.items.*'))).toBe('$.items[*]');
  });

  it('rejects invalid segments', () => {
    expect(() => formatPath([{ index: -1 }])).toThrow(/invalid index/);
    expect(() => formatPath([{ index: 1.5 }])).toThrow(/invalid index/);
  });
});

const user = () => ({
  login: 'octo',
  avatar_url: 'https://x/a.png',
  items: [
    { id: 1, price: 2.5, tags: ['a'] },
    { id: 2, price: 3, tags: [] },
    { id: 3, price: null },
  ],
  meta: { 'odd key': true, n: 0 },
});

describe('selectPath', () => {
  it('selects with concrete paths, wildcards expanded in order', () => {
    const u = user();
    expect(selectPath(u, '$')).toEqual([{ path: '$', value: u }]);
    expect(selectPath(u, '$.avatar_url')).toEqual([{ path: '$.avatar_url', value: 'https://x/a.png' }]);
    expect(selectPath(u, '$.items[*].id')).toEqual([
      { path: '$.items[0].id', value: 1 },
      { path: '$.items[1].id', value: 2 },
      { path: '$.items[2].id', value: 3 },
    ]);
    expect(selectPath(u, '$.items[*].price')).toEqual([
      { path: '$.items[0].price', value: 2.5 },
      { path: '$.items[1].price', value: 3 },
      { path: '$.items[2].price', value: null },
    ]);
    expect(selectPath(u, '$.items[*].tags[*]')).toEqual([{ path: '$.items[0].tags[0]', value: 'a' }]);
    expect(selectPath(u, '$.meta[*]')).toEqual([
      { path: "$.meta['odd key']", value: true },
      { path: '$.meta.n', value: 0 },
    ]);
    expect(selectPath(u, "$.meta['odd key']")).toEqual([{ path: "$.meta['odd key']", value: true }]);
  });

  it('paths that lead nowhere select nothing', () => {
    const u = user();
    for (const p of ['$.nope', '$.items[9]', '$.items.id', '$.login.length', '$.items[0][0]', '$.meta[0]', '$.login[*]', '$.items[2].price.x']) {
      expect(selectPath(u, p), p).toEqual([]);
    }
    expect(selectPath(null, '$.a')).toEqual([]);
    expect(selectPath(42, '$[*]')).toEqual([]);
    expect(selectPath({ '0': 'x' }, '$[0]')).toEqual([]); // [n] is for arrays
    expect(selectPath({ '0': 'x' }, "$['0']")).toEqual([{ path: "$['0']", value: 'x' }]);
  });

  it('never follows the prototype or class instances', () => {
    expect(selectPath({}, '$.__proto__')).toEqual([]);
    expect(selectPath({}, '$.constructor')).toEqual([]);
    expect(selectPath({}, '$.toString')).toEqual([]);
    expect(selectPath({ n: new RawNumber('1.0') }, '$.n.source')).toEqual([]);
    const own = JSON.parse('{"__proto__": {"x": 1}}');
    expect(selectPath(own, '$.__proto__.x')).toEqual([{ path: '$.__proto__.x', value: 1 }]);
  });

  it('throws on a bad path', () => {
    expect(() => selectPath({}, '$[')).toThrow(/Invalid JSON path/);
  });
});

describe('applyOps', () => {
  it('the classic: $.avatar_url → null, without touching the input', () => {
    const u = user();
    const before = JSON.stringify(u);
    const { value, changed } = applyOps(u, [{ path: '$.avatar_url', op: 'null' }]);
    expect(changed).toEqual([1]);
    expect((value as { avatar_url: unknown }).avatar_url).toBeNull();
    expect(JSON.stringify(u)).toBe(before);
    expect(value).not.toBe(u);
    expect((value as ReturnType<typeof user>).items).not.toBe(u.items);
  });

  it('null / delete / set, in order; later ops see earlier results', () => {
    const { value, changed } = applyOps(user(), [
      { path: '$.items[*].price', op: 'set', value: '42' },
      { path: '$.login', op: 'delete' },
      { path: '$.meta.n', op: 'null' },
      { path: '$.items[0].price', op: 'set', value: { nested: [1] } },
      { path: '$.missing', op: 'null' },
      { path: '$.missing', op: 'delete' },
    ]);
    expect(changed).toEqual([3, 1, 1, 1, 0, 0]);
    expect(value).toEqual({
      avatar_url: 'https://x/a.png',
      items: [
        { id: 1, price: { nested: [1] }, tags: ['a'] },
        { id: 2, price: '42', tags: [] },
        { id: 3, price: '42' },
      ],
      meta: { 'odd key': true, n: null },
    });
  });

  it('set creates a missing object key (not array elements); null / delete never create', () => {
    const { value, changed } = applyOps({ a: {}, list: [1] }, [
      { path: '$.a.added', op: 'set', value: 1 },
      { path: '$.list[5]', op: 'set', value: 1 },
      { path: '$.a.other', op: 'null' },
      { path: '$.nothere.x', op: 'set', value: 1 },
    ]);
    expect(changed).toEqual([1, 0, 0, 0]);
    expect(value).toEqual({ a: { added: 1 }, list: [1] });
  });

  it('set values are deep-copied per place (no shared structure with the op or each other)', () => {
    const v = { deep: [1] };
    const op = { path: '$[*]', op: 'set' as const, value: v };
    const { value } = applyOps([0, 0], [op]);
    const arr = value as { deep: number[] }[];
    expect(arr).toEqual([v, v]);
    arr[0].deep.push(2);
    expect(arr[1].deep).toEqual([1]);
    expect(v.deep).toEqual([1]);
  });

  it('delete on array elements: wildcards and several indexes, removed from the end', () => {
    expect(applyOps([0, 1, 2, 3], [{ path: '$[*]', op: 'delete' }])).toEqual({ value: [], changed: [4] });
    expect(applyOps({ a: 1, b: 2 }, [{ path: '$[*]', op: 'delete' }])).toEqual({ value: {}, changed: [2] });
    // Two ops on one array: indexes refer to the array as each op sees it.
    expect(applyOps(['a', 'b', 'c', 'd'], [
      { path: '$[1]', op: 'delete' },
      { path: '$[1]', op: 'delete' },
    ])).toEqual({ value: ['a', 'd'], changed: [1, 1] });
    // Nested wildcards: every inner array loses the same element, outer stays.
    const rows = { rows: [[1, 2, 3], [4, 5, 6], [7]] };
    expect(applyOps(rows, [{ path: '$.rows[*][1]', op: 'delete' }])).toEqual({ value: { rows: [[1, 3], [4, 6], [7]] }, changed: [2] });
    expect(applyOps(rows, [{ path: '$.rows[*][*]', op: 'delete' }])).toEqual({ value: { rows: [[], [], []] }, changed: [7] });
    expect(rows.rows[0]).toEqual([1, 2, 3]);
    // Removing a key of every element (objects, not elements).
    expect(applyOps(user(), [{ path: '$.items[*].tags', op: 'delete' }]).value).toMatchObject({
      items: [{ id: 1, price: 2.5 }, { id: 2, price: 3 }, { id: 3, price: null }],
    });
  });

  it('the root: set and null replace it, delete is an error', () => {
    expect(applyOps({ a: 1 }, [{ path: '$', op: 'set', value: [1] }])).toEqual({ value: [1], changed: [1] });
    expect(applyOps({ a: 1 }, [{ path: '$', op: 'null' }])).toEqual({ value: null, changed: [1] });
    expect(() => applyOps({ a: 1 }, [{ path: '$', op: 'delete' }])).toThrow(/cannot delete the root/);
  });

  it('validates ops before changing anything, and throws on bad paths', () => {
    expect(() => applyOps({}, [{ path: '$.a', op: 'set' }])).toThrow(/needs a value/);
    expect(() => applyOps({}, [{ path: '$.a', op: 'nope' as 'set' }])).toThrow(/unknown kind/);
    expect(() => applyOps({}, [{ op: 'null' } as never])).toThrow(/has no path/);
    expect(() => applyOps({}, null as never)).toThrow(/must be an array/);
    expect(() => applyOps({}, [{ path: '$.a', op: 'null' }, { path: 'nope', op: 'null' }])).toThrow(/Invalid JSON path/);
    expect(applyOps({ a: 1 }, [])).toEqual({ value: { a: 1 }, changed: [] });
  });

  it('"__proto__" is an ordinary key: no prototype pollution, own keys are copied and set', () => {
    const input = JSON.parse('{"__proto__": {"polluted": 1}, "a": {}}');
    const { value, changed } = applyOps(input, [
      { path: "$['__proto__'].polluted", op: 'set', value: 2 },
      { path: '$.a.__proto__', op: 'set', value: { polluted: 3 } },
    ]);
    expect(changed).toEqual([1, 1]);
    const out = value as Record<string, any>;
    expect(Object.getPrototypeOf(out)).toBe(Object.prototype);
    expect(Object.getPrototypeOf(out.a)).toBe(Object.prototype);
    expect(JSON.stringify(out)).toBe('{"__proto__":{"polluted":2},"a":{"__proto__":{"polluted":3}}}');
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(input.__proto__.polluted).toBe(1);
  });

  it('valueJson: parsed with JSON.parse, wins over value; invalid or non-string → throws', () => {
    expect(applyOps({ a: 0 }, [{ path: '$.a', op: 'set', value: 'ignored', valueJson: '{"x":[1,null]}' }])).toEqual({ value: { a: { x: [1, null] } }, changed: [1] });
    expect(applyOps({ a: 0 }, [{ path: '$.a', op: 'set', valueJson: 'null' }])).toEqual({ value: { a: null }, changed: [1] });
    expect(applyOps({ a: 0 }, [{ path: '$.a', op: 'set', valueJson: ' 1.0 ' }]).value).toEqual({ a: 1 }); // not byte-exact here
    expect(() => applyOps({ a: 0 }, [{ path: '$.a', op: 'set', valueJson: '{oops' }])).toThrow(/invalid valueJson/);
    expect(() => applyOps({ a: 0 }, [{ path: '$.a', op: 'set', valueJson: 1 as unknown as string }])).toThrow(/not a string/);
    // ignored by null / delete
    expect(applyOps({ a: 0 }, [{ path: '$.a', op: 'null', valueJson: '{oops' }])).toEqual({ value: { a: null }, changed: [1] });
  });

  it('keeps non-plain values (RawNumber) as leaves', () => {
    const n = new RawNumber('1.0');
    const { value } = applyOps({ a: n, b: 1 }, [{ path: '$.b', op: 'null' }]);
    expect((value as { a: unknown }).a).toBe(n);
  });
});

describe('json-text (number-preserving JSON)', () => {
  it('round-trips numbers exactly as written', () => {
    const text = '{"a":1.0,"b":1e3,"c":-0,"d":12345678901234567890,"e":0.1,"f":42,"g":-1.50,"h":[1.0,2],"i":1E+2}';
    expect(stringifyJsonText(parseJsonText(text))).toBe(text);
    const v = parseJsonText(text) as Record<string, unknown>;
    expect(v.a).toBeInstanceOf(RawNumber);
    expect(v.e).toBe(0.1);
    expect(v.f).toBe(42);
    expect(Number(v.d)).toBe(12345678901234567890);
  });

  it('matches JSON.parse on everything else', () => {
    const samples = [
      '{"s":"x\\"y\\\\z\\n\\u00e9\\ud83d\\ude00","t":true,"f":false,"n":null,"arr":[],"o":{},"nested":[{"a":[[]]}]}',
      ' \n\t[ 1 , "two" , { "3" : 3 , "b": 2 } ]\r\n',
      '"just a string"',
      'null',
      '{"dup":1,"dup":2}',
      '{"2":"b","1":"a","x":"c"}',
      '"\\ud800"',
    ];
    for (const s of samples) {
      expect(parseJsonText(s), s).toEqual(JSON.parse(s));
      expect(stringifyJsonText(parseJsonText(s)), s).toBe(JSON.stringify(JSON.parse(s)));
    }
  });

  it('rejects what JSON.parse rejects, with a position', () => {
    for (const s of ['', '{', '{"a":}', '{"a" 1}', '[1,]', '{"a":1,}', '01', '1.', '.5', '+1', 'tru', "{'a':1}", '"\u0001"', '"a\\x"', '"abc', '{"a":1}x', 'NaN', '[1 2]', '-']) {
      expect(() => JSON.parse(s), s).toThrow();
      expect(() => parseJsonText(s), s).toThrow(/at position \d+/);
    }
  });

  it('"__proto__" stays an own key', () => {
    const v = parseJsonText('{"__proto__":{"x":1}}') as Record<string, unknown>;
    expect(Object.getPrototypeOf(v)).toBe(Object.prototype);
    expect(Object.keys(v)).toEqual(['__proto__']);
    expect(stringifyJsonText(v)).toBe('{"__proto__":{"x":1}}');
  });

  it('bounds nesting', () => {
    const ok = '['.repeat(MAX_JSON_DEPTH - 1) + ']'.repeat(MAX_JSON_DEPTH - 1);
    expect(stringifyJsonText(parseJsonText(ok))).toBe(ok);
    const deep = '['.repeat(MAX_JSON_DEPTH + 1) + ']'.repeat(MAX_JSON_DEPTH + 1);
    expect(() => parseJsonText(deep)).toThrow(/nested more than 1000 levels deep/);
  });

  it('writes set values like JSON.stringify (undefined dropped / null in arrays, NaN → null)', () => {
    expect(stringifyJsonText({ a: undefined, b: [undefined, NaN, Infinity], c: 'x' })).toBe('{"b":[null,null,null],"c":"x"}');
    expect(stringifyJsonText(undefined)).toBe('null');
  });
});

describe('REVIEW-4 bounds', () => {
  it('#8: selectPath with a 300-segment [*] path over a 300-deep body: fast, small, capped', () => {
    // 0.4 MB-ish: depth 300, the innermost array has 20 000 leaves.
    let body: unknown = Array(20_000).fill(1);
    for (let d = 1; d < 300; d++) body = [body];
    const path = '$' + '[*]'.repeat(300);
    const t0 = performance.now();
    expect(() => selectPath(body, path)).toThrow(/selects 20000 values, more than the limit of 10000/);
    const few = selectPath(body, path, { limit: 20_000 });
    expect(few.length).toBe(20_000);
    expect(few[19_999].path).toBe('$' + '[0]'.repeat(299) + '[19999]');
    expect(performance.now() - t0).toBeLessThan(1000); // was 4.3 s / 4.3 GB
    expect(SELECT_LIMIT).toBe(10_000);
  });

  it('#4: applyOps refuses fan-out × value size past the budget, before writing (input untouched)', () => {
    const arr = Array.from({ length: 100_000 }, () => ({ d: 'x' }));
    const big = 'y'.repeat(1024);
    expect(() => applyOps(arr, [{ path: '$[*].d', op: 'set', value: big }])).toThrow(/100000 places × 1026 bytes would exceed 64 MB/);
    expect(() => applyOps(arr, [{ path: '$[*].d', op: 'set', valueJson: JSON.stringify(big) }])).toThrow(/would exceed 64 MB/);
    expect(arr[0].d).toBe('x');
    expect(() => applyOps(arr, [{ path: '$[*].d', op: 'null' }], { maxTargets: 99_999 })).toThrow(/more than 99999 places/);
    // cumulative across ops
    expect(() => applyOps(arr, [{ path: '$[*].d', op: 'null' }, { path: '$[*].d', op: 'null' }], { maxTargets: 150_000 })).toThrow(/op 1 .*more than 150000/);
    expect(applyOps(arr, [{ path: '$[*].d', op: 'null' }]).changed).toEqual([100_000]);
  });

  it('#4: inPlace changes the given value; the default copies', () => {
    const v = { a: 1 };
    expect(applyOps(v, [{ path: '$.a', op: 'null' }]).value).not.toBe(v);
    expect(v.a).toBe(1);
    expect(applyOps(v, [{ path: '$.a', op: 'null' }], { inPlace: true }).value).toBe(v);
    expect(v.a).toBeNull();
  });

  it('#4: parser value cap and writer output cap', () => {
    expect(() => parseJsonText('[{},{},{},{}]', 4)).toThrow(RangeError);
    expect(parseJsonText('[{},{},{}]', 4)).toEqual([{}, {}, {}]);
    expect(() => stringifyJsonText({ a: 'x'.repeat(100) }, 50)).toThrow(/longer than 50 characters/);
    expect(stringifyJsonText({ a: 'x'.repeat(100) }, 200)).toBe(JSON.stringify({ a: 'x'.repeat(100) }));
  });
});

describe('mutateLabel', () => {
  it('short, lists up to 3 ops', () => {
    expect(mutateLabel([{ path: '$.avatar_url', op: 'null' }])).toBe('Mutated: $.avatar_url → null');
    expect(
      mutateLabel([
        { path: '$.a', op: 'delete' },
        { path: '$.b', op: 'set', value: '42' },
        { path: '$.c', op: 'set', value: { long: 'x'.repeat(50) } },
        { path: '$.d', op: 'null' },
        { path: '$.e', op: 'null' },
      ]),
    ).toBe('Mutated: $.a removed, $.b → "42", $.c → {"long":"xxxxxxxxxxxxxx… (+2 more)');
  });
});
