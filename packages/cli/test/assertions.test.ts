import { describe, expect, it } from 'vitest';
import type { Exchange } from '@flutter-intercept/proxy';
import { evaluateExpectations, parseExpectations } from '../src/assertions';

let n = 0;
function ex(method: string, url: string, status: number, body?: unknown, extra: Partial<Exchange> = {}): Exchange {
  n++;
  return {
    id: `e${n}`,
    startedAt: 1_000 + n,
    durationMs: 20,
    method,
    url,
    requestHeaders: {},
    status,
    responseHeaders: { 'content-type': 'application/json' },
    ...(body !== undefined ? { responseBody: { text: JSON.stringify(body), encoding: 'utf8' as const } } : {}),
    state: 'completed',
    ...extra,
  };
}

const traffic = [
  ex('POST', 'https://api.example.com/login', 200, { token: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2lnbmF0dXJl', user: { id: 7 } }),
  ex('GET', 'https://api.example.com/users/7', 200, { id: 7, name: 'Ada', tags: ['a'] }),
  ex('GET', 'https://api.example.com/users/8', 404, { error: 'not found' }),
  ex('GET', 'https://api.example.com/slow', 200, {}, { durationMs: 900 }),
  ex('GET', 'https://api.example.com/pending', 200, undefined, { state: 'pending', status: undefined }),
];

describe('parseExpectations', () => {
  it('accepts an array (or {assertions}) with optional names and forces withinMs to 0', () => {
    const notes: string[] = [];
    const xs = parseExpectations(JSON.stringify([{ name: 'login', url: '*/login', method: 'POST', withinMs: 5000, expect: { status: 200 } }, { url: '*/users/*', expect: {} }]), 'f.json', notes);
    expect(xs.map((x) => x.name)).toEqual(['login', '#2 */users/*']);
    expect(xs[0].input).toEqual({ url: '*/login', method: 'POST', withinMs: 0, expect: { status: 200 } });
    expect(notes).toEqual(['f.json item 1: withinMs ignored (the run is over when assertions are checked)']);
    expect(parseExpectations(JSON.stringify({ assertions: [{ url: '*', expect: {} }] }))).toHaveLength(1);
  });

  it('names every invalid item before anything runs', () => {
    expect(() => parseExpectations('[{"url": "*"}, 3, {"url": "*", "expect": {"count": {"min": "x"}}}, {"name": "", "url": "*", "expect": {}}]', 'f.json')).toThrow(
      /^f\.json: item 1: expect: .*; item 2: expected an object; item 3: expect\.count\.min: .*; item 4: name must be a non-empty string/,
    );
    expect(() => parseExpectations('{', 'f.json')).toThrow(/f\.json: not valid JSON/);
    expect(() => parseExpectations('{"a": 1}', 'f.json')).toThrow(/expected a JSON array/);
    expect(() => parseExpectations('[{"url": "*", "expect": {}, "extra": 1}]')).toThrow(/item 1:/);
  });
});

describe('evaluateExpectations (the agent API assert_traffic, reused)', () => {
  it('passes and fails like assert_traffic', async () => {
    const xs = parseExpectations(
      JSON.stringify([
        { name: 'user loads', url: 'https://api.example.com/users/7', expect: { status: 200, count: { exact: 1 }, json: [{ path: '$.name', equals: 'Ada' }, { path: '$.tags', type: 'array' }] } },
        { name: 'all users ok', url: 'https://api.example.com/users/*', expect: { status: '2xx' } },
        { name: 'login then user', url: 'https://api.example.com/*', expect: { order: ['*/login', '*/users/7'] } },
        { name: 'wrong order', url: 'https://api.example.com/*', expect: { order: ['*/users/7', '*/login'] } },
        { name: 'fast', url: 'https://api.example.com/slow', expect: { maxDurationMs: 500 } },
        { name: 'missing', url: 'https://api.example.com/orders*', expect: {} },
        { name: 'none', url: 'https://api.example.com/orders*', expect: { count: { exact: 0 } } },
        { name: 'pending not counted', url: 'https://api.example.com/pending', expect: { count: { exact: 0 } } },
      ]),
    );
    const r = await evaluateExpectations(xs, traffic, { redact: true });
    expect(r.map((x) => [x.name, x.pass, x.matched])).toEqual([
      ['user loads', true, 1],
      ['all users ok', false, 2],
      ['login then user', true, 4],
      ['wrong order', false, 4],
      ['fast', false, 1],
      ['missing', false, 0],
      ['none', true, 0],
      ['pending not counted', true, 0],
    ]);
    expect(r[1].failures[0]).toMatch(/status 404, expected 2xx/);
    expect(r[4].failures[0]).toMatch(/took 900 ms, expected at most 500 ms/);
    expect(r[5].failures[0]).toMatch(/no finished request matched/);
  });

  it('redacts secrets unless told not to', async () => {
    const xs = parseExpectations(JSON.stringify([{ url: '*/login', expect: { json: [{ path: '$.token', equals: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2lnbmF0dXJl' }] } }]));
    const redacted = await evaluateExpectations(xs, traffic, { redact: true });
    expect(redacted[0].pass).toBe(false);
    expect(redacted[0].failures.join(' ')).not.toContain('eyJhbGci');
    const raw = await evaluateExpectations(xs, traffic, { redact: false });
    expect(raw[0].pass).toBe(true);
  });

  it('an empty run fails presence checks', async () => {
    const r = await evaluateExpectations(parseExpectations('[{"url": "*", "expect": {}}]'), [], { redact: true });
    expect(r[0]).toMatchObject({ pass: false, matched: 0 });
  });
});
