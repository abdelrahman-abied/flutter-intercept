// CONTRACTS §23.5 (v0.16.0 part 2) agent side: mock_from_traffic (write; dry run allowed read-only; sanitising always
// on whatever agent.redactSecrets says) and update_collection_example (read: the diff only, the team file is never
// written); list_collections / get_collection carry drift (≤ 20, paths and kinds). The host is the real core over a
// fake fs and the fixture session; planted values never come out of a tool.
import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as path from 'path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Exchange, Rule } from '@flutter-intercept/proxy';
import { createAgentApi, type AgentApiDeps } from '../../../src/agent/api';
import { AGENT_SECTION } from '../../../src/agent/instructions';
import { confirmationText, invocationMessage } from '../../../src/agent/lmTools';
import { ALL_TOOLS, parseToolInput, TOOL_DOCS } from '../../../src/agent/schema';
import { READ_TOOLS, WRITE_TOOLS, type AppLauncher } from '../../../src/agent/types';
import { MockCollectionsCore } from '../../../src/mocks/core';
import { collectionParsers } from '../../../src/mocks/parsers';
import { SharedRulesCore } from '../../../src/rules/core';
import { validateRules } from '../../../src/ui/controller';
import { FakeFs, FakeMemento, fakeValidateRule, ROOT } from '../rules.fakes';

vi.mock('vscode', () => ({}));

const SESSION = path.join(__dirname, '..', '..', 'fixtures', 'traffic', 'session.json');
const A = 'https://api.shop.example';
const DIR = `${ROOT}/.vscode/flutter-intercept/collections`;
const NAME = 'api-shop-example-recorded';
const USER = 'GET {{baseUrl}}/users/:userId';
const PLANTED = [
  'SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c',
  'Zm9vYmFyYmF6cXV4MTIzNDU2Nzg5MGFiY2RlZg',
  's3cr3tCookieValue42',
  'rt_9f8e7d6c5b4a39281706f5e4d3c2b1a0ZZqq',
  'Hunter2!PlantedPw',
  'deadbeefcafef00d1234567890abcdef0042',
  'AKIAPLANTEDCRED',
  'qTok3nPlantedValue99',
  'ada@lovelace.dev',
  '7946 0958',
  '12 Analytical Way',
  'req-abc-123-trace',
  'grace@hopper.dev',
  'sk_live_PlantedKey0001',
  'PlantedNewJwtSignature0000',
  'PlantedNewSig777',
];
const clean = (v: unknown) => {
  const s = JSON.stringify(v);
  for (const p of PLANTED) expect(s, `holds ${p}`).not.toContain(p);
};

class FakeHost extends EventEmitter {
  running = true;
  port: number | undefined = 8899;
  exchanges: Exchange[] = [];
  rules: Rule[] = [];
  getExchanges() {
    return this.exchanges;
  }
  getRules() {
    return this.rules;
  }
  resume() {}
  abort() {}
}

let files: FakeFs;
let core: MockCollectionsCore;
let host: FakeHost;
let seq = 0;

async function setup(opts: { access?: 'readWrite' | 'readOnly'; redact?: boolean } = {}) {
  files = new FakeFs();
  files.put(`${ROOT}/pubspec.yaml`, 'name: app');
  const memento = new FakeMemento();
  const shared = new SharedRulesCore({ folders: () => [{ name: 'app', path: ROOT }], fs: files, validateRule: fakeValidateRule, memento });
  host = new FakeHost();
  host.exchanges = (JSON.parse(fs.readFileSync(SESSION, 'utf8')) as { exchanges: Exchange[] }).exchanges;
  core = new MockCollectionsCore({
    links: () => shared.collectionLinks(),
    saveLinks: (folder, links) => shared.saveCollections(folder, links),
    primaryFolderPath: () => shared.primaryFolderPath(),
    writeWorkspaceFile: (folder, rel, text) => shared.writeWorkspaceFile(folder, rel, text),
    workspaceRoots: () => [ROOT],
    fs: files,
    memento,
    parsers: collectionParsers,
    newRuleId: () => 'rule_new',
    exchanges: () => host.exchanges,
    isThrottleOnlyRule: (id) => id === 'throttle-only',
    now: () => Date.UTC(2026, 10, 20),
  });
  await shared.reload();
  await core.reload();
  const collections: NonNullable<AgentApiDeps['collections']> = {
    state: () => core.state(),
    endpoints: (id) => core.endpoints(id),
    example: (id, endpoint, name) => core.example(id, endpoint, name),
    update: (id, patch) => core.update(id, patch),
    importFile: (pick) => core.addLink(pick),
    describeRule: (ruleId) => core.describeRule(ruleId),
    endpointForRequest: (id, ex) => core.endpointForRequest(id, ex),
    mockFromTraffic: (req) => core.mockFromTraffic(req),
    previewExampleUpdate: (id, endpoint, status, mode) => core.exampleUpdate(id, endpoint, status, mode),
    drift: (id) => core.driftOf(id),
  };
  const deps: AgentApiDeps = {
    host: host as unknown as AgentApiDeps['host'],
    applyRules: (rules) => {
      host.rules = validateRules(rules);
    },
    clear: () => undefined,
    getSettings: () => ({ access: opts.access ?? 'readWrite', redactSecrets: opts.redact ?? true, interceptEnabled: true }),
    launcher: { launch: vi.fn(), stop: vi.fn(), hotRestart: vi.fn(), sessions: () => [] } as unknown as AppLauncher,
    projectRoot: () => ROOT,
    now: () => 50_000,
    collections,
  };
  return createAgentApi(deps);
}

function answer(url: string, status: number, body: unknown): Exchange {
  seq++;
  return {
    id: `n${seq}`,
    startedAt: 1_800_000_000_000 + seq,
    method: 'GET',
    url,
    requestHeaders: {},
    status,
    responseHeaders: { 'content-type': 'application/json' },
    responseBody: { text: JSON.stringify(body), encoding: 'utf8' },
    state: 'completed',
  };
}

/** Three newer answers with a new field (and planted values) after the collection was turned off for this user. */
async function drift(id: string): Promise<void> {
  await core.update(id, { enabled: false });
  for (let k = 0; k < 3; k++) {
    const x = answer(`${A}/users/42`, 200, {
      id: 42,
      name: 'Grace',
      email: 'grace@hopper.dev',
      phone: '+1 415 555 0199',
      rating: 4.5,
      seen: 3,
      address: { street: 'a', city: 'b', zip: 'c' },
      lat: 1,
      lng: 2,
      avatarUrl: 'https://cdn.example/a.png?X-Amz-Signature=PlantedNewSig777',
      bio: 'grace@hopper.dev',
      big: 1,
      tier: 'gold',
      apiKey: 'sk_live_PlantedKey0001',
      session: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJncmFjZSJ9.PlantedNewJwtSignature0000',
    });
    host.exchanges.push(x);
    core.observeExchange(x);
  }
  core.flushDrift();
}

beforeEach(() => {
  seq = 0;
});

describe('registration, schemas, texts', () => {
  it('52 tools: mock_from_traffic writes, update_collection_example reads; docs and instructions', () => {
    expect(ALL_TOOLS).toHaveLength(52);
    expect(WRITE_TOOLS).toContain('mock_from_traffic');
    expect(READ_TOOLS).toContain('update_collection_example');
    for (const t of ['mock_from_traffic', 'update_collection_example'] as const) expect(TOOL_DOCS[t].model.length).toBeGreaterThan(40);
    expect(parseToolInput('mock_from_traffic', {})).toEqual({ unmatched: 'passthrough', replacePersonalData: true });
    expect(parseToolInput('update_collection_example', { id: 'shop', endpoint: 'GET /x', status: 200 })).toEqual({ id: 'shop', endpoint: 'GET /x', status: 200, mode: 'merge' });
    expect(() => parseToolInput('update_collection_example', { id: 'shop', endpoint: 'GET /x', status: 99 })).toThrow(/status/);
    expect(() => parseToolInput('mock_from_traffic', { unmatched: 'never' })).toThrow(/unmatched/);
    const lines = AGENT_SECTION.split('\n');
    expect(lines.length).toBeLessThanOrEqual(64);
    expect(AGENT_SECTION).toContain('`mock_from_traffic`');
    expect(AGENT_SECTION).toContain('`update_collection_example`');
  });

  it('the Copilot confirmation names the file it writes; a dry run says nothing is written', () => {
    const c = confirmationText('mock_from_traffic', { name: 'Shop API (recorded)', unmatched: 'fail' });
    expect(c.message).toContain('`.vscode/flutter-intercept/collections/shop-api-recorded.json`');
    expect(c.message).toContain('fail like offline');
    expect(c.message).toMatch(/review the file before committing/);
    expect(confirmationText('mock_from_traffic', { dryRun: true }).message).toMatch(/Nothing is written/);
    expect(confirmationText('mock_from_traffic', {}).message).toContain('<server>-recorded.json');
    expect(invocationMessage('update_collection_example', { id: 'shop', endpoint: 'GET /x', status: 200 })).toMatch(/Previewing/);
  });
});

describe('mock_from_traffic', () => {
  it('makes, links and mocks; the outputs and the file hold no planted value even with redaction off', async () => {
    const api = await setup({ redact: false });
    const r = await api.call('mock_from_traffic', {});
    expect(r).toMatchObject({ id: NAME, file: `.vscode/flutter-intercept/collections/${NAME}.json`, endpoints: 11, examples: 12, resources: ['users'] });
    expect(r.note).toMatch(/review .* before committing/);
    clean(r);
    clean(files.text(`${DIR}/${NAME}.json`));
    const list = await api.call('list_collections', {});
    expect((list.collections as { id: string }[]).map((c) => c.id)).toEqual([NAME]);
    clean(list);
  });

  it('dry run: allowed with read-only access, nothing written; a real run is refused read-only', async () => {
    const api = await setup({ access: 'readOnly' });
    const before = [...files.files.keys()];
    const r = await api.call('mock_from_traffic', { dryRun: true, name: 'Shop' });
    expect(r).toMatchObject({ id: 'shop', file: '.vscode/flutter-intercept/collections/shop.json', dryRun: true });
    expect(r.note).toMatch(/nothing was written/);
    clean(r);
    expect([...files.files.keys()]).toEqual(before);
    await expect(api.call('mock_from_traffic', {})).rejects.toMatchObject({ code: 'access' });
    await expect(api.call('mock_from_traffic', { dryRun: false })).rejects.toMatchObject({ code: 'access' });
  });

  it('readable errors: nothing recorded, recording with session filters, unknown origin', async () => {
    const api = await setup();
    await expect(api.call('mock_from_traffic', { recording: 'r1', url: '*' })).rejects.toThrow(/leave them out with recording/);
    await expect(api.call('mock_from_traffic', { origins: ['https://nope.example'] })).rejects.toThrow(/didn't answer in this traffic/);
    host.exchanges = [];
    await expect(api.call('mock_from_traffic', {})).rejects.toMatchObject({ code: 'state', message: expect.stringMatching(/Run the app against the real server first/) });
  });
});

describe('drift and update_collection_example', () => {
  it('list_collections / get_collection carry drift (paths and kinds, ≤ 20)', async () => {
    const api = await setup();
    const { id } = (await api.call('mock_from_traffic', {})) as { id: string };
    await drift(id);
    const list = (await api.call('list_collections', {})) as { collections: { drift?: unknown[] }[] };
    expect(list.collections[0].drift).toEqual([expect.objectContaining({ endpoint: USER, status: 200, samples: 3 })]);
    const changes = (list.collections[0].drift![0] as { changes: { kind: string; path: string }[] }).changes;
    expect(changes.map((c) => c.path).sort()).toEqual(['apiKey', 'session', 'tier']);
    const one = (await api.call('get_collection', { id })) as { drift: unknown[]; endpoints: { key: string; drift?: unknown[] }[] };
    expect(one.drift).toHaveLength(1);
    expect(one.endpoints.find((e) => e.key === USER)?.drift).toHaveLength(1);
    clean([list, one]);
  });

  it('the diff only (read-only access is enough); the team file is never written', async () => {
    const api = await setup();
    const { id } = (await api.call('mock_from_traffic', {})) as { id: string };
    await drift(id);
    const file = `${DIR}/${NAME}.json`;
    const before = files.text(file);
    const writes = files.writes.length;
    const r = (await api.call('update_collection_example', { id, endpoint: USER, status: 200 })) as { diff: string; note: string };
    expect(r.diff).toContain('+  "tier": "gold"');
    expect(r.diff.split('\n')[0]).toMatch(/^--- \.vscode\/flutter-intercept\/collections\/api-shop-example-recorded\.json · GET \{\{baseUrl\}\}\/users\/:userId · example "200 OK"/);
    expect(r.note).toMatch(/nothing was written/);
    clean(r);
    // by a traffic request id, and as add
    const add = (await api.call('update_collection_example', { id, request: 'e29', status: 200, mode: 'add' })) as { diff: string };
    expect(add.diff).toContain('new example "200 (from the server, 2026-11-20)"');
    clean(add);
    expect(files.text(file)).toBe(before);
    expect(files.writes.length).toBe(writes);
    // read-only agents can preview too
    const ro = await setup({ access: 'readOnly' });
    await expect(ro.call('update_collection_example', { id: 'nope', endpoint: USER, status: 200 })).rejects.toMatchObject({ code: 'not_found' });
  });

  it('merge on a status without an example is refused; nothing to merge says so', async () => {
    const api = await setup();
    const { id } = (await api.call('mock_from_traffic', {})) as { id: string };
    await expect(api.call('update_collection_example', { id, endpoint: USER, status: 409 })).rejects.toThrow(/No answer of the server/);
    // the server answers like the example: nothing to merge
    const same = { ...host.exchanges.find((e) => e.id === 'e29')!, id: 'same' };
    host.exchanges.push(same);
    core.observeExchange(same);
    core.flushDrift();
    await expect(api.call('update_collection_example', { id, endpoint: USER, status: 200 })).rejects.toMatchObject({ code: 'state', message: expect.stringMatching(/Nothing to update/) });
  });
});
