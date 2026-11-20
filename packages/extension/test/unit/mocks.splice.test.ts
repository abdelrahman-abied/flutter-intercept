// CONTRACTS §23.4: Update example — splice one value of the team's file, every other byte unchanged; merge mode.
import { describe, expect, it } from 'vitest';
import { JWT_PLACEHOLDER } from '../../src/mocks/fromTraffic';
import { detectStyle, insertBefore, locate, mergeExample, parseJsonTree, postmanExamplePath, spliceValue, type JsonPath } from '../../src/mocks/splice';

/** The value at `path` was replaced: every byte before and after its span is identical. Returns old and new text. */
function changedSpan(before: string, after: string, path: JsonPath): { old: string; next: string } {
  const at = locate(parseJsonTree(before).root!, path)!;
  const tail = before.length - at.node.end;
  expect(after.slice(0, at.node.start)).toBe(before.slice(0, at.node.start));
  expect(after.slice(after.length - tail)).toBe(before.slice(at.node.end));
  return { old: before.slice(at.node.start, at.node.end), next: after.slice(at.node.start, after.length - tail) };
}

/** Text was inserted at `at` and nothing else changed. Returns the inserted text. */
function inserted(before: string, after: string, at: number): string {
  expect(after.slice(0, at)).toBe(before.slice(0, at));
  expect(after.slice(after.length - (before.length - at))).toBe(before.slice(at));
  return after.slice(at, after.length - (before.length - at));
}

const POSTMAN_CRLF_TABS = [
  '{',
  '\t"info": {"name": "Caf\\u00e9 API", "schema": "https://schema.getpostman.com/json/collection/v2.1.0/collection.json"},',
  '\t"item": [',
  '\t\t{',
  '\t\t\t"name": "Users",',
  '\t\t\t"item": [',
  '\t\t\t\t{',
  '\t\t\t\t\t"name": "Get user",',
  '\t\t\t\t\t"request": {"method": "GET", "url": {"raw": "{{baseUrl}}/users/:id?x=1", "host": ["{{baseUrl}}"], "path": ["users", ":id"]}},',
  '\t\t\t\t\t"response": [',
  '\t\t\t\t\t\t{"name": "Old", "code": 200, "body": "{\\"id\\": 1, \\"note\\": \\"\\u00e9t\\u00e9\\"}"},',
  '\t\t\t\t\t\t{"name": "Not found", "code": 404, "body": "{}"}',
  '\t\t\t\t\t]',
  '\t\t\t\t},',
  '\t\t\t\t{"name": "Get user again", "request": {"method": "GET", "url": "{{baseUrl}}/users/:id"}, "response": [{"name": "Old", "code": 200, "body": "x"}]}',
  '\t\t\t]',
  '\t\t}',
  '\t]',
  '}',
  '',
].join('\r\n');

const OPENAPI = `{
    "openapi": "3.0.3",
    "paths": {
        "/users/{id}": {
            "get": {
                "responses": {
                    "200": {
                        "content": {
                            "application/json": {
                                "example": {"id": 1, "price": 2.50},
                                "examples": {
                                    "plain": { "value": { "id": 1 } },
                                    "other": { "value": [] }
                                }
                            }
                        }
                    }
                }
            }
        }
    }
}
`;

describe('spliceValue', () => {
  it('changes only the Postman example body (CRLF, tabs, \\u escapes elsewhere untouched)', () => {
    const path = postmanExamplePath(POSTMAN_CRLF_TABS, 'GET {{baseUrl}}/users/:id', 'Old')!;
    expect(path).toEqual(['item', 0, 'item', 0, 'response', 0]);
    const out = spliceValue(POSTMAN_CRLF_TABS, [...path, 'body'], { string: '{\n  "id": 1,\n  "note": "été",\n  "avatar": "a.png"\n}' });
    expect(out.problem).toBeUndefined();
    const { old, next } = changedSpan(POSTMAN_CRLF_TABS, out.text!, [...path, 'body']);
    expect(old).toBe('"{\\"id\\": 1, \\"note\\": \\"\\u00e9t\\u00e9\\"}"');
    expect(next).toBe('"{\\n  \\"id\\": 1,\\n  \\"note\\": \\"\\u00e9t\\u00e9\\",\\n  \\"avatar\\": \\"a.png\\"\\n}"');
    // the old literal escaped non-ASCII: the new one does too
    expect(next).toContain('\\u00e9t\\u00e9');
    expect(out.text!.split('\r\n')).toHaveLength(POSTMAN_CRLF_TABS.split('\r\n').length);
    const doc = JSON.parse(out.text!) as { item: { item: { response: { body: string }[] }[] }[] };
    expect(JSON.parse(doc.item[0].item[0].response[0].body)).toEqual({ id: 1, note: 'été', avatar: 'a.png' });
  });

  it('finds repeated keys (#2) and reports what is missing', () => {
    expect(postmanExamplePath(POSTMAN_CRLF_TABS, 'GET {{baseUrl}}/users/:id #2', 'Old')).toEqual(['item', 0, 'item', 1, 'response', 0]);
    expect(postmanExamplePath(POSTMAN_CRLF_TABS, 'GET {{baseUrl}}/users/:id', 'Nope')).toBeUndefined();
    expect(postmanExamplePath(POSTMAN_CRLF_TABS, 'POST {{baseUrl}}/users/:id', 'Old')).toBeUndefined();
    expect(spliceValue(POSTMAN_CRLF_TABS, ['item', 0, 'item', 0, 'response', 7, 'body'], { string: 'x' }).problem).toBe('Not found in the file: item[0].item[0].response[7].body.');
    expect(spliceValue(POSTMAN_CRLF_TABS, ['item', 0, 'name', 'x'], { string: 'x' }).problem).toMatch(/^Not found/);
    expect(spliceValue(POSTMAN_CRLF_TABS, ['item', 0, 'item'], { string: 'x' }).problem).toBe('Not a text value in the file: item[0].item.');
  });

  it('refuses files that are not plain JSON, without quoting them', () => {
    const withComment = '{\n  // team note\n  "a": "secret-value"\n}';
    const p = spliceValue(withComment, ['a'], { string: 'b' }).problem!;
    expect(p).toMatch(/^The file isn't plain JSON \(.* at line 2, column 3\)\.$/);
    expect(p).not.toContain('secret-value');
    expect(spliceValue('{"a": "x",}', ['a'], { string: 'b' }).problem).toMatch(/plain JSON/);
    expect(spliceValue('', [], { string: 'b' }).problem).toMatch(/plain JSON/);
  });

  it('replaces an OpenAPI example object, re-indented where it sits', () => {
    const p = ['paths', '/users/{id}', 'get', 'responses', '200', 'content', 'application/json', 'example'];
    // a short value written on one line stays on one line, in the same spacing
    const short = spliceValue(OPENAPI, p, { json: '{"id":1,"price":2.50,"tags":["a"],"owner":{}}' });
    expect(changedSpan(OPENAPI, short.text!, p)).toEqual({ old: '{"id": 1, "price": 2.50}', next: '{"id": 1, "price": 2.50, "tags": ["a"], "owner": {}}' });
    // a long one is indented from its line, in the file's indentation
    const long = spliceValue(OPENAPI, p, { json: JSON.stringify({ id: 1, description: 'd'.repeat(100), tags: ['a'] }) });
    expect(changedSpan(OPENAPI, long.text!, p).next).toBe(
      '{\n' +
        '                                    "id": 1,\n' +
        `                                    "description": "${'d'.repeat(100)}",\n` +
        '                                    "tags": [\n' +
        '                                        "a"\n' +
        '                                    ]\n' +
        '                                }',
    );
    const vp = ['paths', '/users/{id}', 'get', 'responses', '200', 'content', 'application/json', 'examples', 'plain', 'value'];
    const named = spliceValue(OPENAPI, vp, { json: '{"id":2}' });
    expect(changedSpan(OPENAPI, named.text!, vp)).toEqual({ old: '{ "id": 1 }', next: '{"id": 2}' });
    expect(spliceValue(OPENAPI, p, { json: 'not json' }).problem).toBe('The new example is not JSON.');
  });

  it('uses the last of repeated keys (the one JSON.parse keeps)', () => {
    const t = '{"a": "first", "a": "second"}';
    expect(spliceValue(t, ['a'], { string: 'x' }).text).toBe('{"a": "first", "a": "x"}');
  });
});

describe('insertBefore (mode add)', () => {
  it('inserts a Postman response before the old one with the same separator', () => {
    const path = postmanExamplePath(POSTMAN_CRLF_TABS, 'GET {{baseUrl}}/users/:id', 'Old')!;
    const out = insertBefore(POSTMAN_CRLF_TABS, path, { json: '{"name":"200 (from the server, 2026-11-20)","code":200,"body":"{}"}' });
    const at = locate(parseJsonTree(POSTMAN_CRLF_TABS).root!, path)!.node.start;
    expect(inserted(POSTMAN_CRLF_TABS, out.text!, at)).toBe('{"name": "200 (from the server, 2026-11-20)", "code": 200, "body": "{}"},\r\n\t\t\t\t\t\t');
    const doc = JSON.parse(out.text!) as { item: { item: { response: { name: string }[] }[] }[] };
    expect(doc.item[0].item[0].response.map((r) => r.name)).toEqual(['200 (from the server, 2026-11-20)', 'Old', 'Not found']);
  });

  it('inserts a named OpenAPI example before another, and refuses a taken name', () => {
    const p = ['paths', '/users/{id}', 'get', 'responses', '200', 'content', 'application/json', 'examples', 'plain'];
    const out = insertBefore(OPENAPI, p, { key: 'fromServer', json: '{"value":{"id":3}}' });
    const at = OPENAPI.indexOf('"plain"');
    expect(inserted(OPENAPI, out.text!, at)).toBe('"fromServer": {"value": {"id": 3}},\n                                    ');
    const big = insertBefore(OPENAPI, p, { key: 'big', json: JSON.stringify({ value: { text: 't'.repeat(120) } }) });
    expect(inserted(OPENAPI, big.text!, at)).toBe(
      '"big": {\n' +
        '                                        "value": {\n' +
        `                                            "text": "${'t'.repeat(120)}"\n` +
        '                                        }\n' +
        '                                    },\n' +
        '                                    ',
    );
    expect(Object.keys((JSON.parse(out.text!) as { paths: Record<string, { get: { responses: Record<string, { content: Record<string, { examples: object }> }> } }> }).paths['/users/{id}'].get.responses['200'].content['application/json'].examples)).toEqual(['fromServer', 'plain', 'other']);
    expect(insertBefore(OPENAPI, p, { key: 'other', json: '{}' }).problem).toMatch(/already there/);
    expect(insertBefore(OPENAPI, p, { json: '{}' }).problem).toMatch(/name is needed/);
  });

  it('works in a minified file', () => {
    expect(insertBefore('{"r":[{"a":1}]}', ['r', 0], { json: '{ "b" : 2 }' }).text).toBe('{"r":[{"b":2},{"a":1}]}');
  });
});

describe('mergeExample', () => {
  const exampleBody = '{\n    "id": 7,\n    "name": "Team value",\n    "price": 3,\n    "legacy": true,\n    "items": [\n        {"sku": "a"},\n        {"sku": "b"}\n    ]\n}';
  const sample = JSON.stringify({
    id: 'u-9',
    name: 'Server value',
    price: 3.5,
    avatar: 'https://cdn.example.net/a.png?sig=PlantedSig&w=1',
    contact: 'real.person@company.dev',
    token: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2lnbmF0dXJlMTIz',
    items: [{ sku: 's1', qty: 4 }, { sku: 's2', qty: 5 }],
  });

  it('adds new fields (sanitised, every array element), drops removed ones, converts types, keeps the team values', () => {
    const out = mergeExample(exampleBody, sample, [
      { kind: 'added', path: 'avatar', to: 'string' },
      { kind: 'added', path: 'contact', to: 'string' },
      { kind: 'added', path: 'token', to: 'string' },
      { kind: 'added', path: 'items[].qty', to: 'int' },
      { kind: 'removed', path: 'legacy', from: 'bool' },
      { kind: 'type', path: 'price', from: 'int', to: 'double' },
      { kind: 'type', path: 'id', from: 'int', to: 'string' },
      { kind: 'nullable', path: 'name', from: 'string', to: 'null' },
    ]);
    expect(out).toBe(
      [
        '{',
        '    "id": "u-9",',
        '    "name": "Team value",',
        '    "price": 3.0,',
        '    "items": [',
        '        {',
        '            "sku": "a",',
        '            "qty": 4',
        '        },',
        '        {',
        '            "sku": "b",',
        '            "qty": 5',
        '        }',
        '    ],',
        '    "avatar": "https://cdn.example.net/a.png?sig=&w=1",',
        '    "contact": "user1@example.com",',
        `    "token": "${JWT_PLACEHOLDER}"`,
        '}',
      ].join('\n'),
    );
    expect(out).not.toContain('PlantedSig');
    expect(out).not.toContain('real.person');
  });

  it('keeps a minified example minified, and leaves non-JSON alone', () => {
    expect(mergeExample('{"a":1}', '{"a":1,"b":[1]}', [{ kind: 'added', path: 'b', to: 'list' }])).toBe('{"a":1,"b":[1]}');
    expect(mergeExample('not json', '{}', [])).toBe('not json');
    expect(mergeExample('{"a":1}', 'nope', [{ kind: 'added', path: 'b' }])).toBe('{"a":1}');
  });

  it('pairs array elements by index, falling back to the first answer element', () => {
    const out = mergeExample('[{"a":1},{"a":2},{"a":3}]', '[{"a":1,"b":"x"},{"a":2,"b":"y"}]', [{ kind: 'added', path: '[].b', to: 'string' }]);
    expect(JSON.parse(out)).toEqual([{ a: 1, b: 'x' }, { a: 2, b: 'y' }, { a: 3, b: 'x' }]);
  });
});

describe('tree and style', () => {
  it('keeps literals and spans', () => {
    const t = '﻿{"n": 1.50, "s": "\\u00e9", "b": 12345678901234567890}';
    const r = parseJsonTree(t).root!;
    expect(r.type).toBe('object');
    if (r.type !== 'object') return;
    expect(r.members.map((m) => (m.value.type === 'number' || m.value.type === 'string' ? m.value.raw : ''))).toEqual(['1.50', '"\\u00e9"', '12345678901234567890']);
    expect(t.slice(r.members[1].value.start, r.members[1].value.end)).toBe('"\\u00e9"');
  });

  it('detects indentation, line ends and the colon', () => {
    expect(detectStyle('{\r\n\t"a": 1\r\n}')).toEqual({ indent: '\t', eol: '\r\n', colon: ': ' });
    expect(detectStyle('{"a":1}')).toEqual({ indent: '', eol: '\n', colon: ':' });
    expect(detectStyle('{\n  "a" : 1\n}')).toEqual({ indent: '  ', eol: '\n', colon: ' : ' });
  });
});
