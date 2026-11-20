// CONTRACTS §21.1: format detection for Postman and OpenAPI collections.
import * as fs from 'fs';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import { detectFormat } from '../../src/mocks/detect';

const fixtures = path.join(__dirname, '..', 'fixtures', 'collections');
const readJson = (name: string): unknown => JSON.parse(fs.readFileSync(path.join(fixtures, name), 'utf8'));

describe('detectFormat', () => {
  it('detects the fixture Postman and OpenAPI collections and rejects the environment file', () => {
    expect(detectFormat(readJson('shop.postman_collection.json'))).toEqual({ format: 'postman' });
    expect(detectFormat(readJson('shop.openapi.json'))).toEqual({ format: 'openapi' });
    const envRes = detectFormat(readJson('shop.postman_environment.json'));
    expect(envRes.format).toBeUndefined();
    expect(envRes.problem).toMatch(/environment/i);
  });

  it('detects Postman v2.0, v2.1, and info + item[] without schema', () => {
    expect(
      detectFormat({
        info: { name: 'V2', schema: 'https://schema.getpostman.com/json/collection/v2.0.0/collection.json' },
        item: [],
      }),
    ).toEqual({ format: 'postman' });

    expect(
      detectFormat({
        info: { name: 'V2.1', schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json' },
      }),
    ).toEqual({ format: 'postman' });

    expect(detectFormat({ info: { name: 'No schema' }, item: [] })).toEqual({ format: 'postman' });
  });

  it('detects OpenAPI 3.0 and 3.1', () => {
    expect(detectFormat({ openapi: '3.0.0', info: {}, paths: {} })).toEqual({ format: 'openapi' });
    expect(detectFormat({ openapi: '3.0.3' })).toEqual({ format: 'openapi' });
    expect(detectFormat({ openapi: '3.1.0' })).toEqual({ format: 'openapi' });
  });

  it('returns a clear problem for Swagger 2.0 and Postman v1', () => {
    const swagger = detectFormat({ swagger: '2.0', info: { title: 'Old', version: '1' }, paths: {} });
    expect(swagger.format).toBeUndefined();
    expect(swagger.problem).toBe("Swagger 2.0 isn't supported yet: convert it to OpenAPI 3.");

    const v1Schema = detectFormat({
      info: { name: 'Old', schema: 'https://schema.getpostman.com/json/collection/v1.0.0/collection.json' },
    });
    expect(v1Schema.format).toBeUndefined();
    expect(v1Schema.problem).toMatch(/Postman v1/i);

    const v1Shape = detectFormat({ id: '123', name: 'Old', order: [], requests: [] });
    expect(v1Shape.format).toBeUndefined();
    expect(v1Shape.problem).toMatch(/Postman v1/i);
  });

  it('returns a problem and never throws on invalid or hostile inputs', () => {
    for (const bad of [null, undefined, 42, 'postman', true, [], {}, { openapi: '4.0.0' }, { openapi: 3 }, { info: {}, item: 'nope' }]) {
      const res = detectFormat(bad);
      expect(res.format).toBeUndefined();
      expect(typeof res.problem).toBe('string');
      expect(res.problem!.length).toBeGreaterThan(0);
    }

    const protoObj = JSON.parse('{"__proto__":{"openapi":"3.1.0"},"constructor":{"info":{},"item":[]}}');
    expect(detectFormat(protoObj).format).toBeUndefined();
    expect(({} as Record<string, unknown>).openapi).toBeUndefined();
  });

  it('bounds problem lines to 300 chars and strips newlines, bidi controls and URL credentials (REVIEW-15 #7)', () => {
    const schema = `https://ci:ghp_SecretToken123456@raw.example/s.json\nInjected\t\u202E${'x'.repeat(500)}`;
    const res = detectFormat({ info: { schema } });
    expect(res.format).toBeUndefined();
    expect(res.problem).toBeDefined();
    expect(res.problem!.length).toBeLessThanOrEqual(300);
    expect(res.problem).not.toMatch(/[\r\n\t\u202A-\u202E\u2066-\u2069]/);
    expect(res.problem).not.toContain('ghp_SecretToken123456');
  });
});
