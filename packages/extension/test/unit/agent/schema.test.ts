import * as fs from 'fs';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import { ALL_TOOLS, languageModelToolsContribution, LM_TOOL_PREFIX, parseToolInput, TOOL_DOCS, toolInputJsonSchema, toolSchemas } from '../../../src/agent/schema';
import { READ_TOOLS, WRITE_TOOLS } from '../../../src/agent/types';

describe('tool schemas', () => {
  it('cover exactly the tools in types.ts, each with docs', () => {
    expect(Object.keys(toolSchemas).sort()).toEqual([...READ_TOOLS, ...WRITE_TOOLS].sort());
    expect(Object.keys(TOOL_DOCS).sort()).toEqual([...ALL_TOOLS].sort());
    for (const t of ALL_TOOLS) {
      expect(TOOL_DOCS[t].model.length).toBeGreaterThan(40);
      expect(TOOL_DOCS[t].user.length).toBeGreaterThan(5);
    }
  });

  it('apply §8 defaults', () => {
    expect(parseToolInput('list_requests', {})).toEqual({ limit: 50 });
    expect(parseToolInput('get_request', { id: 'x' })).toEqual({ id: 'x', includeBodies: true, maxBodyChars: 20000 });
    expect(parseToolInput('wait_for_request', { url: '*' })).toEqual({ url: '*', timeoutMs: 30000, includeBodies: false }); // sinceMs default is decided by the API (latest launch/restart or now)
    expect(parseToolInput('add_mock', { url: '*', body: { a: 1 } })).toMatchObject({ status: 200, body: { a: 1 } });
    expect(parseToolInput('add_block', { url: '*' })).toEqual({ url: '*', mode: 'status', status: 403 });
    expect(parseToolInput('add_breakpoint', { url: '*' })).toEqual({ url: '*', phase: 'response' });
    expect(parseToolInput('launch_app', {})).toEqual({ flutterMode: 'debug' });
    expect(parseToolInput('get_status', undefined)).toEqual({});
    // CONTRACTS §9.5
    expect(parseToolInput('get_request_source', { id: 'x' })).toEqual({ id: 'x', maxFrames: 20 });
    expect(parseToolInput('get_body_shape', { id: 'x' })).toEqual({ id: 'x', which: 'response', maxDepth: 6 });
    expect(parseToolInput('simulate_network', { profile: 'slow-3g' })).toEqual({ profile: 'slow-3g' });
    expect(parseToolInput('resend_request', { id: 'x' })).toEqual({ id: 'x' });
    expect(parseToolInput('add_block', { url: '*', times: 2, ttlMs: 5000 })).toMatchObject({ times: 2, ttlMs: 5000 });
    // CONTRACTS §10.6
    expect(parseToolInput('check_contract', {})).toEqual({ limit: 20 });
    expect(parseToolInput('generate_model', { id: 'x' })).toEqual({ id: 'x' });
    expect(parseToolInput('generate_fixture_test', { ids: ['x'] })).toEqual({ ids: ['x'] });
    expect(parseToolInput('assert_traffic', { url: '*', expect: {} })).toEqual({ url: '*', withinMs: 0, expect: {} });
    expect(parseToolInput('assert_traffic', { url: '*', expect: { json: [{ path: '$.a', equals: null }] } }).expect.json).toEqual([{ path: '$.a', equals: null }]);
    expect(parseToolInput('add_mutation', { url: '*', ops: [{ path: '$.a', op: 'set', value: { b: 1 } }] })).toEqual({ url: '*', ops: [{ path: '$.a', op: 'set', value: { b: 1 } }] });
  });

  it.each<[Parameters<typeof parseToolInput>[0], unknown, RegExp]>([
    ['list_requests', { limit: 201 }, /limit/],
    ['list_requests', { limit: 0 }, /limit/],
    ['list_requests', { status: '6xx' }, /status/],
    ['list_requests', { state: 'done' }, /state/],
    ['list_requests', { bogus: 1 }, /bogus|Unrecognized/i],
    ['get_request', {}, /id/],
    ['wait_for_request', { url: '*', timeoutMs: 120001 }, /timeoutMs/],
    ['wait_for_request', {}, /url/],
    ['wait_for_request', { url: '*', sinceMs: 'later' }, /sinceMs/],
    ['add_mock', { url: '*' }, /body/],
    ['add_mock', { url: '*', body: 'x', status: 99 }, /status/],
    ['add_mock', { url: '', body: 'x' }, /url/],
    ['add_mock', { url: '*', body: 'x', method: 'GE T' }, /method/],
    ['add_block', { url: '*', mode: 'drop' }, /mode/],
    ['add_breakpoint', { url: '*', phase: 'later' }, /phase/],
    ['resume_request', { id: 'x', edit: { foo: 1 } }, /edit/],
    ['launch_app', { flutterMode: 'release' }, /flutterMode/],
    ['get_request', { id: 'x', snippet: 'wget' }, /snippet/],
    ['get_request_source', { id: 'x', maxFrames: 31 }, /maxFrames/],
    ['get_body_shape', { id: 'x', which: 'both' }, /which/],
    ['get_body_shape', { id: 'x', maxDepth: 0 }, /maxDepth/],
    ['simulate_network', { profile: '2g' }, /profile/],
    ['simulate_network', { profile: 'custom', kbps: 0 }, /kbps/],
    ['simulate_network', { profile: 'custom', latencyMs: 600_001 }, /latencyMs/],
    ['simulate_network', { url: '*', fault: 'slow' }, /fault/],
    ['resend_request', { id: 'x', edit: { status: 200 } }, /edit/],
    ['add_mock', { url: '*', body: 'x', times: 1001 }, /times/],
    ['add_breakpoint', { url: '*', ttlMs: 86_400_001 }, /ttlMs/],
    ['check_contract', { limit: 51 }, /limit/],
    ['check_contract', { model: 'not a class' }, /model/],
    ['generate_model', { style: 'built_value' }, /style/],
    ['generate_fixture_test', { ids: [] }, /ids/],
    ['generate_fixture_test', { url: '*', name: 'Get User' }, /name/],
    ['assert_traffic', { url: '*' }, /expect/],
    ['assert_traffic', { url: '*', withinMs: 120_001, expect: {} }, /withinMs/],
    ['assert_traffic', { url: '*', expect: { count: { min: -1 } } }, /min/],
    ['assert_traffic', { url: '*', expect: { order: ['*'] } }, /order/],
    ['assert_traffic', { url: '*', expect: { json: [{ path: '$.a', type: 'date' }] } }, /type/],
    ['assert_traffic', { url: '*', expect: { bogus: 1 } }, /bogus|Unrecognized/i],
    ['add_mutation', { url: '*', ops: [] }, /ops/],
    ['add_mutation', { url: '*', ops: [{ path: '$.a', op: 'rename' }] }, /op/],
    ['add_mutation', { url: '*', ops: [{ path: '', op: 'null' }] }, /path/],
    ['add_mutation', { url: '*', ops: Array.from({ length: 21 }, () => ({ path: '$.a', op: 'null' })) }, /ops/],
  ])('%s rejects %j', (tool, input, re) => {
    expect(() => parseToolInput(tool, input)).toThrow(re);
  });

  it('JSON Schemas: object, no $schema, no additional properties, defaulted fields optional', () => {
    for (const t of ALL_TOOLS) {
      const s = toolInputJsonSchema(t);
      expect(s.type).toBe('object');
      expect(s.$schema).toBeUndefined();
      expect(s.additionalProperties).toBe(false);
    }
    expect(toolInputJsonSchema('wait_for_request').required).toEqual(['url']);
    expect(toolInputJsonSchema('add_mock').required).toEqual(['url', 'body']);
    expect(toolInputJsonSchema('get_status').required).toBeUndefined();
  });
});

describe('languageModelToolsContribution()', () => {
  const c = languageModelToolsContribution();

  it('one entry per tool with the package.json shape', () => {
    expect(c.map((x) => x.name)).toEqual(ALL_TOOLS.map((t) => `${LM_TOOL_PREFIX}${t}`));
    for (const x of c) {
      expect(Object.keys(x).sort()).toEqual(['canBeReferencedInPrompt', 'displayName', 'inputSchema', 'modelDescription', 'name', 'tags', 'toolReferenceName', 'userDescription']);
      expect(x.canBeReferencedInPrompt).toBe(true);
      expect(x.toolReferenceName).toMatch(/^intercept[A-Z][A-Za-z]+$/);
      expect(x.displayName.startsWith('Flutter Intercept: ')).toBe(true);
    }
    expect(new Set(c.map((x) => x.toolReferenceName)).size).toBe(c.length);
    expect(c.find((x) => x.name === 'flutter_intercept_wait_for_request')?.toolReferenceName).toBe('interceptWaitForRequest');
  });

  it('is JSON-serialisable and stable', () => {
    expect(JSON.parse(JSON.stringify(c))).toEqual(c);
    expect(languageModelToolsContribution()).toEqual(c);
  });

  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', '..', 'package.json'), 'utf8')) as { contributes?: { languageModelTools?: unknown } };
  it.skipIf(!pkg.contributes?.languageModelTools)('package.json languageModelTools equals the schema export', () => {
    expect(pkg.contributes!.languageModelTools).toEqual(c);
  });
});

describe('front-door helpers', () => {
  it('toolDescriptions / toolJsonSchemas cover every tool', async () => {
    const { toolDescriptions, toolJsonSchemas } = await import('../../../src/agent/schema');
    expect(Object.keys(toolDescriptions()).sort()).toEqual([...ALL_TOOLS].sort());
    expect(toolJsonSchemas().add_mock).toEqual(toolInputJsonSchema('add_mock'));
  });
});
