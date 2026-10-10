import { beforeEach, describe, expect, it } from 'vitest';
import type { Rule } from '@flutter-intercept/proxy';
import { APPROVALS_KEY, mergeRules, SharedRulesCore, toPersonalRule, WorkspaceFolderInfo } from '../../src/rules/core';
import { FakeFs, FakeMemento, FILE, fakeValidateRule, mock, ROOT } from './rules.fakes';

const JWT = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U';

const mapRemote = (id: string, to = 'https://staging.example.com'): Rule => ({ id, enabled: true, match: { url: 'https://api.example.com/*' }, action: { kind: 'mapRemote', to } });
const fileJson = (rules: unknown[], extra: Record<string, unknown> = {}) => JSON.stringify({ version: 1, rules, ...extra }, null, 2);
const strip = (r: Rule) => {
  const { shared: _s, ...rest } = r;
  return { ...rest, id: r.id.replace(/^shared(@[^:]*)?:/, '') };
};

let fs: FakeFs;
let memento: FakeMemento;
let folders: WorkspaceFolderInfo[];
let watched: string[];
let core: SharedRulesCore;

beforeEach(() => {
  fs = new FakeFs();
  memento = new FakeMemento();
  folders = [{ name: 'app', path: ROOT }];
  watched = [];
  fs.put(`${ROOT}/pubspec.yaml`, 'name: app\n');
  core = new SharedRulesCore({ folders: () => folders, fs, validateRule: fakeValidateRule, memento, watchBodyFile: (f, rel) => watched.push(`${f}|${rel}`) });
});

describe('loading', () => {
  it('no file: empty state, no status', async () => {
    await core.reload();
    expect(core.state()).toEqual({ rules: [], problems: [], pendingApproval: [] });
    expect(core.status()).toBeUndefined();
  });

  it('loads, namespaces and marks rules; status counts them', async () => {
    fs.put(FILE, fileJson([mock('a'), mock('b', { enabled: false })]));
    expect(await core.reload()).toBe(true);
    expect(core.state().file).toBe('.vscode/flutter-intercept.json');
    expect(core.state().rules.map((r) => [r.id, r.shared, r.enabled])).toEqual([
      ['shared:a', true, true],
      ['shared:b', true, false],
    ]);
    expect(core.status()).toEqual({ file: '.vscode/flutter-intercept.json', count: 2, problems: [], pendingApproval: 0 });
    expect(await core.reload()).toBe(false); // unchanged
  });

  it('a broken file keeps the last good rules and shows the problem', async () => {
    fs.put(FILE, fileJson([mock('a')]));
    await core.reload();
    fs.put(FILE, '{\n  "rules": [\n    {"id": "a",,}\n  ]\n}');
    expect(await core.reload()).toBe(true);
    expect(core.state().rules.map((r) => r.id)).toEqual(['shared:a']);
    expect(core.state().problems).toEqual([".vscode/flutter-intercept.json line 3, column 17: expected a property name in double quotes, found '}'" + ' — using the last good version of the file']);
    fs.put(FILE, fileJson([mock('b')]));
    await core.reload();
    expect(core.state().rules.map((r) => r.id)).toEqual(['shared:b']);
    expect(core.state().problems).toEqual([]);
  });

  it('a broken file without a good version: no rules, problem', async () => {
    fs.put(FILE, 'nope');
    await core.reload();
    expect(core.state()).toMatchObject({ rules: [], file: '.vscode/flutter-intercept.json', problems: [".vscode/flutter-intercept.json line 1, column 1: unexpected 'n'"] });
  });

  it('a deleted file removes its rules', async () => {
    fs.put(FILE, fileJson([mock('a')]));
    await core.reload();
    fs.files.delete(FILE);
    await core.reload();
    expect(core.state()).toEqual({ rules: [], problems: [], pendingApproval: [] });
  });

  it('refuses huge and non-UTF-8 files', async () => {
    fs.put(FILE, new Uint8Array(5 * 1024 * 1024 + 1));
    await core.reload();
    expect(core.state().problems).toEqual(['.vscode/flutter-intercept.json: larger than 5 MB; ignored']);
    fs.put(FILE, new Uint8Array([0x7b, 0xff, 0x7d]));
    await core.reload();
    expect(core.state().problems).toEqual(['.vscode/flutter-intercept.json: is not UTF-8 text']);
  });

  it('multi-root: one file per Flutter folder, merged in folder order, namespaced per folder', async () => {
    folders = [
      { name: 'app', path: ROOT },
      { name: 'docs', path: '/ws/docs' },
      { name: 'api', path: '/ws/api' },
    ];
    fs.put('/ws/docs/.vscode/flutter-intercept.json', fileJson([mock('ignored')])); // no pubspec: not a Flutter folder
    fs.put('/ws/api/client/pubspec.yaml', 'name: client\n'); // one level down counts
    fs.put('/ws/api/.vscode/flutter-intercept.json', fileJson([mock('x')]));
    fs.put(FILE, fileJson([mock('x')]));
    await core.reload();
    expect(core.state().rules.map((r) => r.id)).toEqual(['shared:x', 'shared@api:x']);
    expect(core.state().file).toBe('app/.vscode/flutter-intercept.json, api/.vscode/flutter-intercept.json');
    expect(core.files().map((f) => f.folder)).toEqual([ROOT, '/ws/api']);
  });

  it('no Flutter folder: the first workspace folder', async () => {
    fs.files.delete(`${ROOT}/pubspec.yaml`);
    fs.put(FILE, fileJson([mock('a')]));
    await core.reload();
    expect(core.state().rules.map((r) => r.id)).toEqual(['shared:a']);
  });
});

describe('approval gate', () => {
  it('holds non-loopback mapRemote until approved; approval is remembered by content hash', async () => {
    fs.put(FILE, fileJson([mock('a'), mapRemote('m'), mapRemote('local', 'http://localhost:8080')]));
    await core.reload();
    expect(core.state().rules.map((r) => r.id)).toEqual(['shared:a', 'shared:local']);
    expect(core.state().pendingApproval.map((r) => r.id)).toEqual(['shared:m']);
    expect(core.status()?.pendingApproval).toBe(1);
    expect(core.pendingReasons()).toEqual([`Rule "m" (any method https://api.example.com/*): sends the app's requests to https://staging.example.com instead of the real server`]);

    expect(await core.approvePending()).toBe(true);
    expect(core.state().rules.map((r) => r.id)).toEqual(['shared:a', 'shared:m', 'shared:local']);
    expect(core.state().pendingApproval).toEqual([]);
    expect(Object.keys(memento.get<Record<string, string>>(APPROVALS_KEY)!)).toEqual([ROOT]);

    // a fresh session (same workspaceState) keeps the approval; reformatting doesn't revoke it
    fs.put(FILE, JSON.stringify(JSON.parse(fs.text(FILE)!)));
    const again = new SharedRulesCore({ folders: () => folders, fs, validateRule: fakeValidateRule, memento });
    await again.reload();
    expect(again.state().pendingApproval).toEqual([]);
  });

  it('a content change revokes the approval (also when changed back)', async () => {
    const original = fileJson([mapRemote('m')]);
    fs.put(FILE, original);
    await core.reload();
    await core.approvePending();
    fs.put(FILE, fileJson([mapRemote('m', 'https://evil.example')]));
    await core.reload();
    expect(core.state().pendingApproval.map((r) => r.id)).toEqual(['shared:m']);
    expect(memento.get(APPROVALS_KEY)).toEqual({});
    fs.put(FILE, original);
    await core.reload();
    expect(core.state().pendingApproval.map((r) => r.id)).toEqual(['shared:m']);
  });

  it('a broken intermediate file does not revoke', async () => {
    fs.put(FILE, fileJson([mapRemote('m')]));
    await core.reload();
    await core.approvePending();
    fs.put(FILE, '{');
    await core.reload();
    expect(core.state().rules.map((r) => r.id)).toEqual(['shared:m']);
    expect(Object.keys(memento.get<object>(APPROVALS_KEY)!)).toEqual([ROOT]);
  });

  it('gates rewrite setting request headers and sequences with gated steps', async () => {
    fs.put(
      FILE,
      fileJson([
        { id: 'rw', match: { url: '*' }, action: { kind: 'rewrite', request: { setHeaders: { 'X-User': 'admin' } } } },
        { id: 'rw-resp', match: { url: '*' }, action: { kind: 'rewrite', response: { setHeaders: { 'X-A': '1' } } } },
        { id: 'seq', match: { url: '*' }, action: { kind: 'sequence', steps: [{ action: { kind: 'mapRemote', to: 'https://x.example' } }] } },
      ]),
    );
    await core.reload();
    expect(core.state().rules.map((r) => r.id)).toEqual(['shared:rw-resp']);
    expect(core.pendingReasons()).toEqual([
      'Rule "rw" (any method *): changes request headers sent to the server: X-User: "admin"',
      `Rule "seq" (any method *): step 1 sends the app's requests to https://x.example instead of the real server`,
    ]);
  });
});

describe('per-rule approval (REVIEW-6 #2)', () => {
  const attacker = (id: string) => mapRemote(id, 'https://collector.attacker.example');

  it('probe 1: a duplicate-id gated entry stays pending after the benign one is deleted or unshared', async () => {
    for (const action of ['remove', 'unshare'] as const) {
      fs.put(FILE, fileJson([mock('a'), attacker('a')]));
      await core.reload();
      expect(core.state()).toMatchObject({ rules: [{ id: 'shared:a' }], pendingApproval: [] });
      expect(core.state().problems).toHaveLength(1);
      if (action === 'remove') await core.removeShared('shared:a');
      else await core.unshare('shared:a');
      expect(core.state().rules).toEqual([]);
      expect(core.state().pendingApproval.map((r) => [r.id, r.action.kind])).toEqual([['shared:a', 'mapRemote']]);
    }
  });

  it('probe 2: a gated rule past the 1000-rule limit stays pending after any rule is deleted', async () => {
    const many = Array.from({ length: 1000 }, (_, i) => ({ id: `m${i}`, match: { url: `https://api.example.com/${i}` }, action: { kind: 'block', mode: 'reset' } }));
    fs.put(FILE, fileJson([...many, attacker('z')]));
    await core.reload();
    expect(core.state().rules).toHaveLength(1000);
    expect(core.state().pendingApproval).toEqual([]);
    await core.removeShared('shared:m5');
    expect(core.state().rules).toHaveLength(999);
    expect(core.state().pendingApproval.map((r) => r.id)).toEqual(['shared:z']);
  });

  it('probe 3: an entry unknown to this version, saved along, is still gated once a newer version understands it', async () => {
    const future = { id: 'f', match: { url: '*' }, action: { kind: 'mapRemote', to: 'https://collector.attacker.example', viaTunnel: true } };
    const oldValidator = (raw: unknown, where?: string) => {
      if ((raw as { action?: { viaTunnel?: unknown } }).action?.viaTunnel !== undefined) throw new Error(`${where}: action: unknown field "viaTunnel"`);
      return fakeValidateRule(raw, where);
    };
    const old = new SharedRulesCore({ folders: () => folders, fs, validateRule: oldValidator, memento });
    fs.put(FILE, fileJson([mock('a'), future]));
    await old.reload();
    expect(old.state().rules.map((r) => r.id)).toEqual(['shared:a']);
    await old.save([{ ...old.state().rules[0], enabled: false }]); // toggle in the panel
    expect(JSON.parse(fs.text(FILE)!).rules.map((r: { id: string }) => r.id)).toEqual(['a', 'f']);
    const upgraded = new SharedRulesCore({ folders: () => folders, fs, validateRule: fakeValidateRule, memento });
    await upgraded.reload();
    expect(upgraded.state().pendingApproval.map((r) => r.id)).toEqual(['shared:f']);
  });

  it('approves only the rules shown (snapshot) and refuses when the held set changed (REVIEW-6 #6)', async () => {
    fs.put(FILE, fileJson([{ ...mapRemote('m'), name: 'Staging\u202e\nVerified' }]));
    await core.reload();
    const snap = core.pendingSnapshot();
    expect(snap.items).toEqual([
      { id: 'shared:m', folder: '.vscode/flutter-intercept.json', name: '"Staging Verified"', match: 'any method https://api.example.com/*', reason: "sends the app's requests to https://staging.example.com instead of the real server" },
    ]);
    // the file changes while the modal is open
    fs.put(FILE, fileJson([{ ...mapRemote('m'), name: 'Staging\u202e\nVerified' }, attacker('x')]));
    await core.reload();
    await expect(core.approvePending(snap.hash)).rejects.toThrow('The shared rules changed while you were deciding. Nothing was approved; review them again.');
    expect(core.state().pendingApproval).toHaveLength(2);
    const snap2 = core.pendingSnapshot();
    expect(snap2.hash).not.toBe(snap.hash);
    await core.approvePending(snap2.hash);
    expect(core.state().pendingApproval).toEqual([]);
    expect(core.state().rules.map((r) => r.id)).toEqual(['shared:m', 'shared:x']);
  });

  it('changing one approved rule revokes only that rule', async () => {
    fs.put(FILE, fileJson([mapRemote('m'), mapRemote('n', 'https://n.example')]));
    await core.reload();
    await core.approvePending();
    fs.put(FILE, fileJson([mapRemote('m'), mapRemote('n', 'https://changed.example')]));
    await core.reload();
    expect(core.state().rules.map((r) => r.id)).toEqual(['shared:m']);
    expect(core.state().pendingApproval.map((r) => r.id)).toEqual(['shared:n']);
    expect(memento.get<Record<string, string[]>>(APPROVALS_KEY)![ROOT]).toHaveLength(1);
  });
});

describe('save', () => {
  it('creates the file atomically with stable 2-space JSON and no personal-only fields', async () => {
    await core.reload();
    await core.save([{ ...mock('a', { times: 3 }), used: 2, expiresAt: Date.now() + 1000 }]);
    expect(fs.renames).toHaveLength(1);
    expect(fs.renames[0][0]).toMatch(/flutter-intercept\.json\.\d+\.[a-z0-9]+\.tmp$/);
    expect(fs.renames[0][1]).toBe(FILE);
    expect(fs.text(FILE)).toBe(
      '{\n  "version": 1,\n  "rules": [\n    {\n      "id": "a",\n      "enabled": true,\n      "match": {\n        "url": "https://api.example.com/a"\n      },\n      "action": {\n        "kind": "mock",\n        "status": 200,\n        "body": "{}"\n      },\n      "times": 3\n    }\n  ]\n}\n',
    );
    expect(core.state().rules.map((r) => r.id)).toEqual(['shared:a']);
  });

  it('round-trips shared ids, keeps unknown keys and invalid entries in place', async () => {
    fs.put(FILE, fileJson([mock('a'), { id: 'future', match: { url: '*' }, action: { kind: 'teleport' } }, mock('b')], { $comment: 'team' }));
    await core.reload();
    expect(core.state().problems).toHaveLength(1);
    const [a, b] = core.state().rules;
    await core.save([{ ...b, name: 'B!' }, a]);
    const json = JSON.parse(fs.text(FILE)!);
    expect(Object.keys(json)).toEqual(['version', 'rules', '$comment']);
    expect(json.rules.map((r: { id: string }) => r.id)).toEqual(['b', 'future', 'a']);
    expect(json.rules[0]).not.toHaveProperty('shared');
    expect(json.rules[0].name).toBe('B!');
  });

  it('does not rewrite a file whose content is unchanged (keeps the user formatting)', async () => {
    fs.put(FILE, `{"rules": [${JSON.stringify(mock('a'))}], "version": 1}`);
    await core.reload();
    await core.save(core.state().rules);
    expect(fs.renames).toHaveLength(0);
  });

  it('refuses to overwrite a broken file', async () => {
    fs.put(FILE, fileJson([mock('a')]));
    await core.reload();
    fs.put(FILE, '{ "rules": [ oops');
    await expect(core.save([mock('b')])).rejects.toThrow(/^Fix \.vscode\/flutter-intercept\.json first: line 1, column 14: unexpected 'o'/);
    expect(fs.text(FILE)).toBe('{ "rules": [ oops');
  });

  it('refuses secrets with a clear message and writes nothing', async () => {
    await core.reload();
    await expect(core.save([mock('login', { name: 'Login', body: `{"access_token":"${JWT}"}` })])).rejects.toThrow(
      'Not shared: rule "Login" — the mock body contains what looks like a JWT. Shared rules are committed with the code, so a real credential would end up in the repository. Replace it with a placeholder (for example "test-token"), or keep this rule personal.',
    );
    expect(fs.files.has(FILE)).toBe(false);
  });

  it('refuses invalid rules and duplicate ids', async () => {
    await core.reload();
    await expect(core.save([{ ...mock('a'), match: undefined } as unknown as Rule])).rejects.toThrow(/^Not saved: rule 1 "a": match is required/);
    await expect(core.save([mock('a'), mock('a')])).rejects.toThrow('Not saved: two shared rules have the id "a"');
  });

  it('own saves of personal gated rules are approved; others stay pending; edits of shared rules are not self-approved', async () => {
    await core.reload();
    await core.save([mapRemote('m')]); // the user's own personal rule, shared now
    expect(core.state().pendingApproval).toEqual([]);
    expect(core.state().rules.map((r) => r.id)).toEqual(['shared:m']);
    // a teammate's rule arrives: per-rule approval keeps "m" approved, "t" is held; saving it back doesn't approve it
    fs.put(FILE, fileJson([mapRemote('m'), mapRemote('t', 'https://teammate.example')]));
    await core.reload();
    expect(core.state().pendingApproval.map((r) => r.id)).toEqual(['shared:t']);
    expect(core.fileRules().map((r) => r.id)).toEqual(['shared:m', 'shared:t']);
    await core.save([...core.fileRules(), mock('new')]);
    expect(core.state().pendingApproval.map((r) => r.id)).toEqual(['shared:t']);
    // editing the approved shared rule from the panel → new content → held again
    const m = core.state().rules.find((r) => r.id === 'shared:m')!;
    await core.save([{ ...m, action: { kind: 'mapRemote', to: 'https://other.example' } }, ...core.state().rules.filter((r) => r !== m)]);
    expect(core.state().pendingApproval.map((r) => r.id)).toEqual(['shared:m', 'shared:t']);
    // toggling `enabled` of an approved rule doesn't need a new approval
    await core.approvePending();
    const m2 = core.state().rules.find((r) => r.id === 'shared:m')!;
    await core.save(core.state().rules.map((r) => (r === m2 ? { ...r, enabled: false } : r)));
    expect(core.state().pendingApproval).toEqual([]);
  });

  it('keeps rules awaiting approval in place when the caller omits, reorders or edits them', async () => {
    fs.put(FILE, fileJson([mock('a'), mapRemote('p1'), mock('b'), mapRemote('p2'), { id: 'future', match: { url: '*' }, action: { kind: 'teleport' } }]));
    await core.reload();
    expect(core.state().pendingApproval.map((r) => r.id)).toEqual(['shared:p1', 'shared:p2']);
    const [a, b] = core.state().rules;
    // panel save: only the visible rules, reordered, one new; plus an edited copy of a pending one (ignored)
    await core.save([{ ...b, name: 'B' }, a, mock('c'), { ...core.state().pendingApproval[0], action: { kind: 'mapRemote', to: 'https://evil.example' } }]);
    const json = JSON.parse(fs.text(FILE)!);
    expect(json.rules.map((r: { id: string }) => r.id)).toEqual(['b', 'p1', 'a', 'p2', 'future', 'c']);
    expect(json.rules[1].action).toEqual({ kind: 'mapRemote', to: 'https://staging.example.com' });
    expect(core.state().pendingApproval.map((r) => r.id)).toEqual(['shared:p1', 'shared:p2']); // still not approved
    // an empty save keeps them too
    await core.save([]);
    expect(JSON.parse(fs.text(FILE)!).rules.map((r: { id: string }) => r.id)).toEqual(['p1', 'p2', 'future']);
    // a personal rule can't take a pending rule's id
    await expect(core.save([mock('p1')])).rejects.toThrow('Not saved: two shared rules have the id "p1"');
  });

  it('after approval the same rules are ordinary: a save can reorder or drop them', async () => {
    fs.put(FILE, fileJson([mapRemote('p1'), mock('a')]));
    await core.reload();
    await core.approvePending();
    await core.save([core.state().rules[1]]);
    expect(JSON.parse(fs.text(FILE)!).rules.map((r: { id: string }) => r.id)).toEqual(['a']);
    expect(core.state().pendingApproval).toEqual([]);
  });

  it('removeShared deletes a rule awaiting approval; the rest stays pending until approved', async () => {
    fs.put(FILE, fileJson([mapRemote('p1'), mock('a'), mapRemote('p2')]));
    await core.reload();
    await core.removeShared('shared:p1');
    expect(JSON.parse(fs.text(FILE)!).rules.map((r: { id: string }) => r.id)).toEqual(['a', 'p2']);
    expect(core.state().pendingApproval.map((r) => r.id)).toEqual(['shared:p2']);
    await core.removeShared('shared:p2');
    expect(core.state()).toMatchObject({ rules: [{ id: 'shared:a' }], pendingApproval: [] });
    await core.removeShared('shared:a');
    expect(JSON.parse(fs.text(FILE)!).rules).toEqual([]);
    await expect(core.removeShared('shared:gone')).rejects.toThrow(/no longer in/);
    await expect(core.removeShared('r-1')).rejects.toThrow('Not a shared rule');
  });

  it('multi-root: rules go back to their folder; new ones to the primary folder', async () => {
    folders = [
      { name: 'app', path: ROOT },
      { name: 'api', path: '/ws/api' },
    ];
    fs.put('/ws/api/pubspec.yaml', 'name: api\n');
    fs.put('/ws/api/.vscode/flutter-intercept.json', fileJson([mock('x')]));
    await core.reload();
    await core.save([...core.state().rules, mock('new')]);
    expect(JSON.parse(fs.text('/ws/api/.vscode/flutter-intercept.json')!).rules.map((r: Rule) => r.id)).toEqual(['x']);
    expect(JSON.parse(fs.text(FILE)!).rules.map((r: Rule) => r.id)).toEqual(['new']);
    expect(core.state().rules.map((r) => r.id)).toEqual(['shared:new', 'shared@api:x']);
  });
});

describe('share / unshare', () => {
  it('share moves a personal rule in (new id when taken), unshare moves it back', async () => {
    fs.put(FILE, fileJson([mock('a')]));
    await core.reload();
    const shared = await core.share({ ...mock('a', { name: 'Mine' }), used: 1 });
    expect(shared.id).toBe('shared:a-2');
    expect(shared.shared).toBe(true);
    expect(core.state().rules.map((r) => r.id)).toEqual(['shared:a', 'shared:a-2']);
    await expect(core.share(shared)).rejects.toThrow(/already shared/);

    const personal = await core.unshare('shared:a-2');
    expect(personal).toEqual({ ...mock('a-2', { name: 'Mine' }), match: { url: 'https://api.example.com/a' } });
    expect(core.state().rules.map((r) => r.id)).toEqual(['shared:a']);
  });

  it('unshare refuses a rule awaiting approval', async () => {
    fs.put(FILE, fileJson([mapRemote('m')]));
    await core.reload();
    await expect(core.unshare('shared:m')).rejects.toThrow(/waits for approval/);
  });

  it('sharing into an approved file keeps it approved', async () => {
    fs.put(FILE, fileJson([mapRemote('m')]));
    await core.reload();
    await core.approvePending();
    await core.share(mapRemote('mine', 'https://other.example'));
    expect(core.state().pendingApproval).toEqual([]);
    expect(core.state().rules.map((r) => r.id)).toEqual(['shared:m', 'shared:mine']);
  });
});

describe('helpers', () => {
  it('mergeRules: shared first, personal shared-looking ids dropped', () => {
    const merged = mergeRules([{ ...mock('shared:a'), shared: true }], [mock('p'), mock('shared:a'), mock('shared@x:b')]);
    expect(merged.map((r) => r.id)).toEqual(['shared:a', 'p']);
  });

  it('toPersonalRule strips the namespace and the flag', () => {
    expect(toPersonalRule({ ...mock('shared@api:x'), shared: true })).toEqual(strip({ ...mock('shared@api:x'), shared: true }));
  });
});

describe('body files', () => {
  beforeEach(async () => {
    await core.reload();
  });

  it('resolves bodyFile into body (also sequence steps) and watches it', async () => {
    fs.put(`${ROOT}/mocks/user.json`, '﻿{"name":"x"}');
    fs.put(`${ROOT}/mocks/err.json`, '{"error":1}');
    const seq: Rule = { id: 's', enabled: true, match: { url: '*' }, action: { kind: 'sequence', steps: [{ action: { kind: 'mock', status: 500, body: '', bodyFile: 'mocks/err.json' } }, { action: { kind: 'passthrough' } }] } };
    const { rules, problems } = await core.resolveBodies([mock('a', { bodyFile: 'mocks/user.json' }), seq, mock('plain')]);
    expect(problems).toEqual([]);
    expect(rules[0].action).toMatchObject({ body: '{"name":"x"}', bodyFile: 'mocks/user.json' });
    expect((rules[1].action as { steps: { action: { body: string } }[] }).steps[0].action.body).toBe('{"error":1}');
    expect(watched).toEqual([`${ROOT}|mocks/user.json`, `${ROOT}|mocks/err.json`]);
    expect(await core.readBodyFile('mocks/user.json')).toBe('{"name":"x"}');
  });

  it('skips rules whose body file is missing, outside, too big, not a file or not UTF-8', async () => {
    fs.put('/ws/secret.txt', 'x');
    fs.put(`${ROOT}/big.json`, new Uint8Array(5 * 1024 * 1024 + 1));
    fs.put(`${ROOT}/bin.dat`, new Uint8Array([0xc3, 0x28]));
    fs.dirs.add(`${ROOT}/dir`);
    const cases: [string, string][] = [
      ['missing.json', 'body file missing.json not found'],
      ['../secret.txt', 'body file ../secret.txt must be inside the workspace'],
      ['/etc/passwd', 'body file "/etc/passwd" must be relative to the workspace folder (not absolute)'],
      ['big.json', 'body file big.json is larger than 5 MB'],
      ['bin.dat', 'body file bin.dat is not UTF-8 text'],
      ['dir', 'body file dir is not a regular file'],
    ];
    for (const [rel, msg] of cases) {
      const { rules, problems } = await core.resolveBodies([mock('a', { name: 'A', bodyFile: rel })]);
      expect(rules, rel).toEqual([]);
      expect(problems, rel).toEqual([`Rule "A" is off: ${msg}`]);
    }
  });

  it('shared rules of another folder resolve relative to that folder', async () => {
    folders = [
      { name: 'app', path: ROOT },
      { name: 'api', path: '/ws/api' },
    ];
    fs.put('/ws/api/pubspec.yaml', 'name: api\n');
    fs.put('/ws/api/.vscode/flutter-intercept.json', fileJson([{ id: 'x', match: { url: '*' }, action: { kind: 'mock', status: 200, bodyFile: 'm.json' } }]));
    fs.put('/ws/api/m.json', 'API');
    await core.reload();
    const { rules } = await core.resolveBodies(core.state().rules);
    expect(rules[0].action).toMatchObject({ body: 'API' });
  });

  it('caches by size + mtime and re-reads on change', async () => {
    fs.put(`${ROOT}/m.json`, 'one');
    expect(await core.readBodyFile('m.json')).toBe('one');
    fs.put(`${ROOT}/m.json`, 'two');
    expect(await core.readBodyFile('m.json')).toBe('two');
  });

  it('createBodyFile writes under .vscode/flutter-intercept/mocks without overwriting', async () => {
    const r = mock('a', { name: 'User profile (ok)' });
    expect(await core.createBodyFile(r, '{"a":1}')).toBe('.vscode/flutter-intercept/mocks/user-profile-ok.json');
    expect(await core.createBodyFile(r, 'hello')).toBe('.vscode/flutter-intercept/mocks/user-profile-ok.txt');
    expect(await core.createBodyFile(r, '{}')).toBe('.vscode/flutter-intercept/mocks/user-profile-ok-2.json');
    expect(fs.text(`${ROOT}/.vscode/flutter-intercept/mocks/user-profile-ok.json`)).toBe('{"a":1}');
    expect(await core.createBodyFile({ ...mock('b'), match: { url: 'https://api.example.com/v1/users/*?x=1' } }, '{}')).toBe('.vscode/flutter-intercept/mocks/v1-users.json');
  });

  it('createBodyFile refuses bodies that look like credentials (REVIEW-6 #5)', async () => {
    await expect(core.createBodyFile(mock('a'), `{"access_token":"${JWT}"}`)).rejects.toThrow(/^Not written: the body contains what looks like a JWT\./);
    await expect(core.createBodyFile(mock('a'), '{"password":"hunter2"}')).rejects.toThrow(/credential \(in "password"\)/);
    expect([...fs.files.keys()].some((k) => k.includes('/mocks/'))).toBe(false);
    expect(core.checkBodyFileContent('{"password":"hunter2"}')).toMatch(/^Not written/);
    expect(core.checkBodyFileContent('{"password":"fake-password"}')).toBeUndefined();
  });

  it('save checks the body file content for secrets', async () => {
    fs.put(`${ROOT}/m.json`, `{"t":"${JWT}"}`);
    await expect(core.save([mock('a', { bodyFile: 'm.json' })])).rejects.toThrow(/the mock body file m\.json contains what looks like a JWT/);
  });
});
