import { describe, expect, it } from 'vitest';
import { blankJsonc, lineLocator, parseJsonc } from '../../src/rules/jsonc';
import {
  canonicalJson,
  contentHash,
  isSharedRuleId,
  namespaceId,
  parseSharedFile,
  serializeSharedFile,
  splitSharedId,
  toFileRule,
} from '../../src/rules/file';
import { validateRule } from '../../src/ui/controller';
import { fakeValidateRule, mock } from './rules.fakes';

const LABEL = '.vscode/flutter-intercept.json';
const parse = (text: string, folderKey = '', validate = fakeValidateRule) => parseSharedFile(text, { label: LABEL, folderKey, validateRule: validate });

describe('jsonc', () => {
  it('blanks comments and trailing commas without moving offsets', () => {
    const src = '{\n  // note\n  "a": "x // not a comment", /* b */\n  "c": [1, 2,],\n}';
    const { text, hadComments } = blankJsonc(src);
    expect(hadComments).toBe(true);
    expect(text.length).toBe(src.length);
    expect(JSON.parse(text)).toEqual({ a: 'x // not a comment', c: [1, 2] });
  });

  it('reports line and column for every kind of syntax error', () => {
    expect(parseJsonc('{\n  "a": 1\n  "b": 2\n}').error).toBe("line 3, column 3: expected ',' or '}' after a property value, found '\"'");
    expect(parseJsonc('{\n  "a": tru\n}').error).toBe("line 2, column 8: unexpected 't'");
    expect(parseJsonc('{"a": "x').error).toBe('line 1, column 7: unterminated string');
    expect(parseJsonc('').error).toBe('line 1, column 1: unexpected end of file');
    expect(parseJsonc('{} x').error).toMatch(/^line 1, column 4: unexpected 'x' after the end/);
    expect(parseJsonc('{"a": "\\q"}').error).toMatch(/^line 1, column 8: invalid escape/);
    expect(parseJsonc('{a: 1}').error).toMatch(/^line 1, column 2: expected a property name in double quotes/);
  });

  it('records where each top-level rules element starts', () => {
    const text = '{\n  "x": [9],\n  "rules": [\n    {"id": "a"},\n\n    {"id": "b", "n": [1]}\n  ]\n}';
    const r = parseJsonc(text);
    const at = lineLocator(text);
    expect(r.ruleOffsets.map((o) => at(o).line)).toEqual([4, 6]);
  });

  it('lineLocator handles the first and last lines', () => {
    const at = lineLocator('ab\ncd\n');
    expect(at(0)).toEqual({ line: 1, column: 1 });
    expect(at(4)).toEqual({ line: 2, column: 2 });
    expect(at(6)).toEqual({ line: 3, column: 1 });
  });
});

describe('ids', () => {
  it('namespaces and splits', () => {
    expect(namespaceId('a', '')).toBe('shared:a');
    expect(namespaceId('a:b', 'api')).toBe('shared@api:a:b');
    expect(splitSharedId('shared:a:b', ['api'])).toEqual({ folderKey: '', fileId: 'a:b' });
    expect(splitSharedId('shared@api:x', ['api', 'api:2'])).toEqual({ folderKey: 'api', fileId: 'x' });
    expect(splitSharedId('shared@api:2:x', ['api', 'api:2'])).toEqual({ folderKey: 'api:2', fileId: 'x' });
    expect(splitSharedId('shared@gone:x', ['api'])).toBeUndefined();
    expect(splitSharedId('r-1', [])).toBeUndefined();
    expect(isSharedRuleId('shared:x')).toBe(true);
    expect(isSharedRuleId('shared@a:x')).toBe(true);
    expect(isSharedRuleId('r-1')).toBe(false);
  });
});

describe('parseSharedFile', () => {
  it('validates, namespaces, marks shared, fills defaults', () => {
    const p = parse(JSON.stringify({ version: 1, rules: [{ id: 'a', match: { url: '*' }, action: { kind: 'block', mode: 'reset' } }] }));
    expect(p.ok).toBe(true);
    if (!p.ok) return;
    expect(p.entries[0].rule).toEqual({ id: 'shared:a', enabled: true, match: { url: '*' }, action: { kind: 'block', mode: 'reset' }, shared: true });
    expect(p.problems).toEqual([]);
  });

  it('namespaces ids of further folders', () => {
    const p = parse('{"rules":[{"id":"a","enabled":true,"match":{"url":"*"},"action":{"kind":"block","mode":"reset"}}]}', 'api');
    expect(p.ok && p.entries[0].rule?.id).toBe('shared@api:a');
  });

  it('skips invalid rules with their line, keeps the valid ones', () => {
    const text = [
      '{',
      '  "version": 1,',
      '  "rules": [',
      '    { "id": "ok", "match": { "url": "*" }, "action": { "kind": "block", "mode": "reset" } },',
      '    { "id": "nomatch", "action": { "kind": "block", "mode": "reset" } },',
      '    { "match": { "url": "*" }, "action": { "kind": "block", "mode": "reset" } },',
      '    { "id": "ok", "match": { "url": "*" }, "action": { "kind": "block", "mode": "reset" } },',
      '    "x"',
      '  ]',
      '}',
    ].join('\n');
    const p = parse(text);
    expect(p.ok).toBe(true);
    if (!p.ok) return;
    expect(p.entries.filter((e) => e.rule).map((e) => e.rule!.id)).toEqual(['shared:ok']);
    expect(p.problems).toEqual([
      `${LABEL} line 5: rule 2 "nomatch": match is required (a rule without match would match everything) (skipped)`,
      `${LABEL} line 6: rule 3 needs an "id" (a stable name such as "login-500") (skipped)`,
      `${LABEL} line 7: rule 4 "ok": duplicate id (skipped)`,
      `${LABEL} line 8: rule 5 must be an object (skipped)`,
    ]);
  });

  it('never turns a rule without match into match-all (real validator)', () => {
    const p = parse('{"rules":[{"id":"x","enabled":true,"action":{"kind":"block","mode":"reset"}}]}', '', validateRule);
    expect(p.ok && p.entries[0].rule).toBeUndefined();
    expect(p.ok && p.problems[0]).toMatch(/match is required/);
  });

  it('accepts a valid file with the real validator', () => {
    const p = parse(
      JSON.stringify({ version: 1, rules: [mock('a'), { id: 'b', enabled: false, shared: true, used: 3, match: { url: '*' }, action: { kind: 'fault', fault: 'timeout' } }] }),
      '',
      validateRule,
    );
    expect(p.ok && p.problems).toEqual([]);
    expect(p.ok && p.entries.map((e) => e.rule?.id)).toEqual(['shared:a', 'shared:b']);
    expect(p.ok && p.entries[1].rule).not.toHaveProperty('used');
  });

  it('fills an empty body for a mock that uses bodyFile', () => {
    const p = parse(JSON.stringify({ rules: [{ id: 'a', match: { url: '*' }, action: { kind: 'mock', status: 200, bodyFile: 'm.json' } }] }));
    expect(p.ok && p.entries[0].rule?.action).toEqual({ kind: 'mock', status: 200, bodyFile: 'm.json', body: '' });
  });

  it('broken files: syntax, shape, version', () => {
    expect(parse('{\n  "rules": [\n}')).toEqual({ ok: false, problem: `${LABEL} line 3, column 1: unexpected '}'` });
    expect(parse('[]')).toMatchObject({ ok: false, problem: expect.stringMatching(/must contain a JSON object/) });
    expect(parse('{"rules": {}}')).toMatchObject({ ok: false, problem: expect.stringMatching(/"rules" must be an array/) });
    expect(parse('{"version": 2, "rules": []}')).toMatchObject({ ok: false, problem: expect.stringMatching(/newer Flutter Intercept \(version 2\)/) });
    expect(parse('{"version": "1", "rules": []}')).toMatchObject({ ok: false, problem: expect.stringMatching(/"version" must be 1/) });
  });

  it('accepts comments, trailing commas and a BOM', () => {
    const p = parse('\ufeff{\n  // team mocks\n  "rules": [\n    {"id": "a", "match": {"url": "*"}, "action": {"kind": "block", "mode": "reset"},},\n  ],\n}');
    expect(p.ok && p.entries[0].rule?.id).toBe('shared:a');
    expect(p.ok && p.hadComments).toBe(true);
  });

  it('hash ignores formatting and key order but not content', () => {
    const a = parse('{"version":1,"rules":[{"id":"a","match":{"url":"*"},"action":{"kind":"block","mode":"reset"}}]}');
    const b = parse('{\n  "rules": [ { "action": { "mode": "reset", "kind": "block" }, "match": { "url": "*" }, "id": "a" } ],\n  "version": 1\n}');
    const c = parse('{"version":1,"rules":[{"id":"a","match":{"url":"**"},"action":{"kind":"block","mode":"reset"}}]}');
    expect(a.ok && b.ok && a.hash === b.hash).toBe(true);
    expect(a.ok && c.ok && a.hash !== c.hash).toBe(true);
    expect(contentHash({ b: 1, a: [1, { d: 2, c: 3 }] })).toBe(contentHash({ a: [1, { c: 3, d: 2 }], b: 1 }));
    expect(canonicalJson({ b: 1, a: undefined })).toBe('{"b":1}');
  });
});

describe('serialise', () => {
  it('writes stable key order and drops personal-only fields', () => {
    const rule = { action: { body: 'x', status: 201, kind: 'mock' }, used: 4, expiresAt: 99, shared: true, times: 2, match: { url: 'u', method: 'GET' }, enabled: true, id: 'shared:a', name: 'n' };
    expect(Object.keys(toFileRule(rule as never, 'a'))).toEqual(['id', 'enabled', 'name', 'match', 'action', 'times']);
    expect(toFileRule(rule as never, 'a')).toEqual({ id: 'a', enabled: true, name: 'n', match: { method: 'GET', url: 'u' }, action: { kind: 'mock', body: 'x', status: 201 }, times: 2 });
  });

  it('writes bodyFile instead of the resolved body, also in sequence steps', () => {
    const r = mock('a', { bodyFile: 'm.json', body: '{"resolved":1}' });
    expect(toFileRule(r, 'a').action).toEqual({ kind: 'mock', status: 200, bodyFile: 'm.json' });
    const seq = { id: 's', enabled: true, match: { url: '*' }, action: { kind: 'sequence', steps: [{ action: { kind: 'mock', status: 500, body: 'R', bodyFile: 'e.json' }, count: 2 }, { action: { kind: 'passthrough' } }] } };
    expect(toFileRule(seq as never, 's').action).toEqual({ kind: 'sequence', steps: [{ action: { kind: 'mock', status: 500, bodyFile: 'e.json' }, count: 2 }, { action: { kind: 'passthrough' } }] });
  });

  it('new file: version + rules, 2-space, trailing newline', () => {
    expect(serializeSharedFile([{ id: 'a' }])).toBe('{\n  "version": 1,\n  "rules": [\n    {\n      "id": "a"\n    }\n  ]\n}\n');
  });

  it('keeps unknown top-level keys in their order, the indentation and CRLF line endings', () => {
    const p = parse('{\r\n    "$comment": "team mocks",\r\n    "rules": [],\r\n    "x-extra": {"k": 1}\r\n}');
    if (!p.ok) throw new Error('parse');
    const text = serializeSharedFile([{ id: 'a' }], p);
    expect(text).toBe(
      '{\r\n    "version": 1,\r\n    "$comment": "team mocks",\r\n    "rules": [\r\n        {\r\n            "id": "a"\r\n        }\r\n    ],\r\n    "x-extra": {\r\n        "k": 1\r\n    }\r\n}\r\n',
    );
  });
});
