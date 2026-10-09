import { describe, expect, it } from 'vitest';
import { bodyShape, shapeOf } from '../../../src/agent/shape';

describe('shapeOf', () => {
  it('primitives, objects, integer vs number', () => {
    expect(shapeOf('x').shape).toBe('string');
    expect(shapeOf(null).shape).toBe('null');
    expect(shapeOf({ id: 1, price: 1.5, ok: true, name: 'a', none: null }).shape).toEqual({
      id: 'integer',
      price: 'number',
      ok: 'boolean',
      name: 'string',
      none: 'null',
    });
  });

  it('merges array elements: unions, optional keys, length', () => {
    const r = shapeOf({
      items: [
        { id: 1, email: 'a@b', score: 1 },
        { id: 2, email: null, score: 2.5, extra: true },
        { id: 3, email: 'c@d', score: 3 },
      ],
    });
    expect(r.shape).toEqual({ items: { '[]': { id: 'integer', email: 'string|null', score: 'number', 'extra?': 'boolean' }, length: 3 } });
    expect(r.truncated).toBe(false);
  });

  it('nested arrays merge their lengths into a range; empty arrays', () => {
    expect(shapeOf([{ tags: ['a'] }, { tags: ['b', 'c', 'd'] }, { tags: [] }]).shape).toEqual({
      '[]': { tags: { '[]': 'string', length: '0-3' } },
      length: 3,
    });
    expect(shapeOf({ list: [] }).shape).toEqual({ list: { '[]': 'empty', length: 0 } });
  });

  it('mixed object/primitive unions use {"|": [...]}', () => {
    expect(shapeOf([{ a: { x: 1 } }, { a: null }]).shape).toEqual({ '[]': { a: { '|': ['null', { x: 'integer' }] } }, length: 2 });
    expect(shapeOf([1, 'a', [true]]).shape).toEqual({ '[]': { '|': ['string|integer', { '[]': 'boolean', length: 1 }] }, length: 3 });
  });

  it('depth cap marks deeper structure', () => {
    const r = shapeOf({ a: { b: { c: { d: 1 } } }, l: [[[1]]] }, { maxDepth: 2 });
    expect(r.shape).toEqual({ a: { b: '{…}' }, l: { '[]': '[…]', length: 1 } });
    expect(r.truncated).toBe(true);
  });

  it('never contains values', () => {
    const json = JSON.stringify(shapeOf({ token: 'SECRET', users: [{ name: 'Alice', id: 42 }] }).shape);
    expect(json).not.toMatch(/SECRET|Alice|42/);
  });
});

describe('size budget', () => {
  it('a ~1 MB realistic response stays under 4000 characters', () => {
    const users = Array.from({ length: 2500 }, (_, i) => ({
      id: i,
      uuid: `u-${i}-${'x'.repeat(60)}`,
      name: `User ${i}`,
      email: i % 7 ? `user${i}@example.com` : null,
      address: { street: 'Main St', city: 'Town', geo: { lat: 1.5, lng: -2.25 }, zip: i % 3 ? '12345' : undefined },
      roles: i % 2 ? ['admin', 'user'] : ['user'],
      orders: Array.from({ length: i % 4 }, (_, j) => ({ id: j, total: j * 1.1, items: [{ sku: 'a', qty: 1 }] })),
      meta: { createdAt: '2024-01-01T00:00:00Z', tags: Object.fromEntries(Array.from({ length: 3 }, (_, k) => [`t${k}`, k])) },
    }));
    const text = JSON.stringify({ data: { users, page: 1, total: 2500 }, links: { next: 'x' } });
    expect(text.length).toBeGreaterThan(1_000_000);
    const t0 = Date.now();
    const r = bodyShape(text);
    expect(Date.now() - t0).toBeLessThan(2000);
    const out = JSON.stringify(r.shape);
    expect(out.length).toBeLessThan(4000);
    expect(r.shape).toMatchObject({ data: { users: { length: 2500, '[]': { id: 'integer', email: 'string|null', orders: { length: '0-3' } } } } });
  });

  it('a 1 MB map-like object (thousands of distinct keys) is capped', () => {
    const big = Object.fromEntries(Array.from({ length: 20_000 }, (_, i) => [`key_${i}`, { v: i, label: 'abcdefghij' }]));
    const text = JSON.stringify(big);
    expect(text.length).toBeGreaterThan(500_000);
    const r = bodyShape(text);
    expect(JSON.stringify(r.shape).length).toBeLessThan(4000);
    expect(r.truncated).toBe(true);
    expect(JSON.stringify(r.shape)).toMatch(/more keys/);
  });

  it('wide and deep documents fall back to a smaller depth', () => {
    const level = (d: number): unknown => (d === 0 ? 1 : Object.fromEntries(Array.from({ length: 7 }, (_, i) => [`field_number_${i}`, level(d - 1)])));
    const text = JSON.stringify(level(6));
    expect(text.length).toBeGreaterThan(1_000_000);
    const t0 = Date.now();
    const r = shapeOf(JSON.parse(text));
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(JSON.stringify(r.shape).length).toBeLessThanOrEqual(4000);
    expect(r.truncated).toBe(true);
    expect(r.depth).toBeLessThan(6);
  });
});

describe('bodyShape', () => {
  it('non-JSON, empty and truncated bodies explain why', () => {
    expect(bodyShape('<html></html>')).toEqual({ shape: null, reason: 'the body is not JSON' });
    expect(bodyShape('  ')).toEqual({ shape: null, reason: 'the body is empty' });
    expect(bodyShape('{"a":', { bodyTruncated: true }).reason).toMatch(/truncated/);
  });
});
