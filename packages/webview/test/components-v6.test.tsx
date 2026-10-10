// @vitest-environment happy-dom
// v0.6.0 UI (CONTRACTS §12.7): rule editor (sequence, map remote, rewrite, body from a file), shared rules (badge,
// share / unshare, read-only editor, approval banner, problems), recordings (save, replay + stop, diff, delete),
// the replay indicator, auth flows, and "Expire token" on a request.
import { render } from 'preact';
import { act } from 'preact/test-utils';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { App } from '../src/components/App';
import type { Host } from '../src/host';
import type { AuthFlowSummary, Exchange, HostMsg, RecordingSummary, Rule, Status, ViewMsg } from '../src/protocol';
import { ex, rule, status } from './fixtures';

let root: HTMLElement;
let posted: ViewMsg[];
let listener: ((m: HostMsg) => void) | undefined;

function host(persisted?: unknown): Host {
  return {
    post: (m) => { posted.push(m); },
    getState: <T,>() => persisted as T | undefined,
    setState: () => {},
    onMessage: (l) => { listener = l; return () => { listener = undefined; }; },
  };
}
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));
async function mount(persisted?: unknown) { await act(() => { render(<App host={host(persisted)} />, root); }); }
async function emit(...msgs: HostMsg[]) {
  await act(async () => { for (const m of msgs) listener!(m); await tick(); });
}
const $ = <T extends Element = HTMLElement>(sel: string, scope: ParentNode = root) => scope.querySelector(sel) as T | null;
const $$ = (sel: string, scope: ParentNode = root) => Array.from(scope.querySelectorAll(sel));
const button = (label: string | RegExp, scope: ParentNode = root) => {
  const b = Array.from(scope.querySelectorAll('button')).find((x) => (typeof label === 'string' ? x.textContent?.trim() === label : label.test(x.textContent ?? '')));
  if (!b) throw new Error(`button ${label} not found`);
  return b as HTMLButtonElement;
};
async function click(el: Element) { await act(() => { (el as HTMLElement).click(); }); }
async function type(el: Element, value: string) {
  await act(() => { (el as HTMLInputElement).value = value; el.dispatchEvent(new Event('input', { bubbles: true })); });
}
async function choose(el: Element, value: string) {
  await act(() => { (el as HTMLSelectElement).value = value; el.dispatchEvent(new Event('change', { bubbles: true })); });
}
const radio = (label: string, scope: ParentNode = root) =>
  ($$('label.radio', scope).find((l) => l.textContent?.trim() === label)?.querySelector('input') ?? null) as HTMLInputElement | null;
const check = (text: RegExp, scope: ParentNode = root) =>
  ($$('label.check', scope).find((l) => text.test(l.textContent ?? ''))?.querySelector('input') ?? null) as HTMLInputElement | null;
const byPlaceholder = (start: string, scope: ParentNode = root) =>
  $$('input', scope).find((i) => (i as HTMLInputElement).placeholder.startsWith(start)) as HTMLInputElement | undefined;
const byLabel = (label: string, scope: ParentNode = root) => $<HTMLInputElement>(`[aria-label="${label}"]`, scope);
const byTitle = (title: string, scope: ParentNode = root) => {
  const b = $$('button', scope).find((x) => (x as HTMLButtonElement).title === title);
  if (!b) throw new Error(`button titled ${title} not found`);
  return b as HTMLButtonElement;
};
const sent = () => posted.filter((m) => m.type !== 'ready');
const lastOf = <T extends ViewMsg['type']>(t: T) => sent().filter((m) => m.type === t).at(-1) as Extract<ViewMsg, { type: T }> | undefined;

beforeEach(() => {
  posted = [];
  root = document.createElement('div');
  document.body.appendChild(root);
});
afterEach(() => {
  render(null, root);
  root.remove();
});

async function newRule(rules: Rule[] = [], st: Status = status) {
  await mount({ view: 'rules' });
  await emit({ type: 'snapshot', exchanges: [], rules, status: st });
  await click(button(/Add rule/));
  await type(byPlaceholder('https://api.example.com/users')!, 'https://api.example.com/*');
}
const saveBtn = () => button('Add rule', $('.re-actions')!);
const savedAction = () => lastOf('setRules')!.rules.at(-1)!.action;

// ---------------------------------------------------------------- rule editor

describe('rule editor: sequence', () => {
  it('step list with action editors, count, then-choice and a live preview; saves the steps', async () => {
    await newRule();
    await click(radio('Sequence')!);
    const steps = () => $$('.seq-step');
    expect(steps()).toHaveLength(2);
    expect($('.seq-preview')!.textContent).toBe('Requests get: 500 ×1 → real server from then on');
    // Step 1 reuses the mock editor (status field).
    const status1 = $$('.seq-step')[0].querySelector('.field.small-field input') as HTMLInputElement;
    expect(status1.value).toBe('500');
    // Step 2 → mock 200 × 2; add a third step (real server); then = real server.
    await choose(byLabel('Step 2 action')!, 'mock');
    await type($$('.seq-step')[1].querySelector('.field.small-field input')!, '200');
    await type(byLabel('Step 2 count')!, '2');
    expect($$('.seq-step')[1].textContent).toContain('requests');
    await click(button('+ Add step'));
    expect(steps()).toHaveLength(3);
    await click(radio('Go to the real server')!);
    expect($('.seq-preview')!.textContent).toBe('Requests get: 500 ×1 → 200 ×2 → real server ×1 → real server');
    await click(byTitle('Remove step 3'));
    expect($('.seq-preview')!.textContent).toBe('Requests get: 500 ×1 → 200 ×2 → real server');
    await click(radio('Start again from step 1')!);
    expect($('.seq-preview')!.textContent).toContain('↻ again');
    await click(radio('Go to the real server')!);
    // Reorder: step 2 up.
    await click(byTitle('Move step 2 up'));
    expect($('.seq-preview')!.textContent).toBe('Requests get: 200 ×2 → 500 ×1 → real server');
    await click(byTitle('Move step 1 down'));
    await click(saveBtn());
    expect(savedAction()).toEqual({
      kind: 'sequence', then: 'passthrough',
      steps: [
        { action: { kind: 'mock', status: 500, headers: { 'content-type': 'application/json' }, body: '{"error":"server_error"}' }, count: 1 },
        { action: { kind: 'mock', status: 200, headers: { 'content-type': 'application/json' }, body: '{\n  \n}' }, count: 2 },
      ],
    });
    expect($('.rule-item')!.textContent).toContain('Sequence: 500 ×1 → 200 ×2 → real server');
    expect($('.rule-item .kind-sequence')).not.toBeNull();
  });

  it('a step error blocks saving and names the step; other kinds get their own editors', async () => {
    await newRule();
    await click(radio('Sequence')!);
    await type(byLabel('Step 1 count')!, '0');
    expect($('.sequence')!.textContent).toContain('Step 1: Count: whole number 1–1000');
    expect(saveBtn().disabled).toBe(true);
    await type(byLabel('Step 1 count')!, '1');
    await choose(byLabel('Step 2 action')!, 'fault');
    expect(radio('DNS failure (host lookup)', $$('.seq-step')[1])).not.toBeNull();
    await choose(byLabel('Step 2 action')!, 'mapRemote');
    expect(saveBtn().disabled).toBe(true);
    await type(byPlaceholder('http://localhost:8080', $$('.seq-step')[1])!, 'http://localhost:9000');
    expect(saveBtn().disabled).toBe(false);
    // The remove button is disabled for the last remaining step.
    await click(byTitle('Remove step 2'));
    expect(byTitle('Remove step 1').disabled).toBe(true);
    // Step kinds offered: no breakpoint, no nested sequence.
    const opts = $$('option', byLabel('Step 1 action')!).map((o) => (o as HTMLOptionElement).value);
    expect(opts).not.toContain('breakpoint');
    expect(opts).not.toContain('sequence');
    expect(opts).toContain('passthrough');
  });
});

describe('rule editor: map remote', () => {
  it('validates the target; warns that credentials go to a non-loopback host; saves', async () => {
    await newRule();
    await click(radio('Map remote')!);
    const to = () => byPlaceholder('http://localhost:8080')!;
    expect(saveBtn().disabled).toBe(true);
    await type(to(), 'staging.example.com');
    expect($('.rule-editor')!.textContent).toContain('Not a URL');
    await type(to(), 'https://staging.example.com');
    expect($('.map-warning')!.textContent).toMatch(/credentials .* https:\/\/staging\.example\.com/);
    await type(to(), 'http://localhost:8080');
    expect($('.map-warning')).toBeNull();
    await click(check(/Keep the original Host/)!);
    await click(saveBtn());
    expect(savedAction()).toEqual({ kind: 'mapRemote', to: 'http://localhost:8080', preserveHost: true });
    expect($('.rule-item')!.textContent).toContain('Map to http://localhost:8080 (keep Host)');
  });
});

describe('rule editor: rewrite', () => {
  it('needs a change; request/response headers, response status and body replacements', async () => {
    await newRule();
    await click(radio('Rewrite')!);
    expect($('.rewrite-editor')!.textContent).toContain('Set or remove a header');
    expect(saveBtn().disabled).toBe(true);
    await type(byLabel('Response status')!, '503');
    expect(saveBtn().disabled).toBe(false);
    await type(byLabel('Remove response headers')!, 'etag, vary');
    const req = $('[aria-label="Request changes"]')!;
    await click(button('+ Add header', req));
    await type($('.he-name', req)!, 'x-debug');
    await type($('.he-value', req)!, '1');
    const res = $('[aria-label="Response changes"]')!;
    await click(button('+ Add replacement', res));
    await type(byLabel('Find in response body (1)')!, '"premium":false');
    await type(byLabel('Replace in response body (1)')!, '"premium":true');
    await click(check(/all/, res)!);
    await click(saveBtn());
    expect(savedAction()).toEqual({
      kind: 'rewrite',
      request: { setHeaders: { 'x-debug': '1' } },
      response: { removeHeaders: ['etag', 'vary'], replaceBody: [{ find: '"premium":false', replace: '"premium":true', all: true }], status: 503 },
    });
    expect($('.rule-item')!.textContent).toContain('Rewrite: request headers (1), status → 503, response headers (2), response body (1 replacement)');
  });

  it('an empty find with a replacement is an error', async () => {
    await newRule();
    await click(radio('Rewrite')!);
    await click(button('+ Add replacement', $('[aria-label="Request changes"]')!));
    await type(byLabel('Replace in request body (1)')!, 'x');
    expect($('.rewrite-editor')!.textContent).toContain("Request body: “Find” can't be empty");
  });
});

describe('rule editor: mock body from a file', () => {
  it('switching to a file suggests a path, validates it and saves bodyFile', async () => {
    await newRule();
    await type(byPlaceholder('e.g. Empty cart')!, 'Empty cart');
    await click(radio('From a file in the workspace')!);
    const path = byPlaceholder('.vscode/flutter-intercept/mocks/cart.json')!;
    expect(path.value).toBe('.vscode/flutter-intercept/mocks/empty-cart.json');
    expect($('textarea')).toBeNull();
    expect($('.rule-editor')!.textContent).toContain('re-reads it whenever it changes');
    await type(path, '../secrets.json');
    expect($('.rule-editor')!.textContent).toContain('inside the workspace');
    expect(saveBtn().disabled).toBe(true);
    expect(button('Open file').disabled).toBe(true);
    await type(path, '.vscode/flutter-intercept/mocks/cart.json');
    await click(button('Open file'));
    expect(lastOf('openBodyFile')).toEqual({ type: 'openBodyFile', path: '.vscode/flutter-intercept/mocks/cart.json' });
    posted = [];
    await click(button('Create file…'));
    const c = $('.body-file-confirm')!;
    expect(c.textContent).toContain('.vscode/flutter-intercept/mocks/cart.json');
    expect(c.textContent).toContain('live tokens');
    expect(lastOf('openBodyFile')).toBeUndefined();
    await click(button('Cancel', c));
    expect($('.body-file-confirm')).toBeNull();
    await click(button('Create file…'));
    await click(button('Create file', $('.body-file-confirm')!));
    expect(lastOf('openBodyFile')).toEqual({ type: 'openBodyFile', path: '.vscode/flutter-intercept/mocks/cart.json', create: { content: '{\n  \n}' } });
    await click(saveBtn());
    expect(savedAction()).toMatchObject({ kind: 'mock', status: 200, bodyFile: '.vscode/flutter-intercept/mocks/cart.json' });
    expect($('.rule-item')!.textContent).toContain('Mock 200 from .vscode/flutter-intercept/mocks/cart.json');
  });

  it('editing a file-backed mock shows the file content read by the host; inline brings the editor back', async () => {
    const r = rule({ id: 'f1', action: { kind: 'mock', status: 200, body: '{"items":[]}', bodyFile: 'mocks/cart.json' } });
    await mount({ view: 'rules' });
    await emit({ type: 'snapshot', exchanges: [], rules: [r], status });
    await click(byTitle('Edit', $('.rule-item')!));
    expect(radio('From a file in the workspace')!.checked).toBe(true);
    expect($('.file-content pre')!.textContent).toBe('{"items":[]}');
    await type(byPlaceholder('.vscode/flutter-intercept/mocks/cart.json')!, 'mocks/other.json');
    expect($('.file-content')).toBeNull();
    await click(radio('Inline')!);
    expect($('textarea')).not.toBeNull();
    await click(button('Save'));
    expect(lastOf('setRules')!.rules[0].action).toEqual({ kind: 'mock', status: 200, body: '{"items":[]}' });
  });
});

describe('REVIEW-6 #5: body files and secrets', () => {
  const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiI0MiJ9.c2lnbmF0dXJlXzEyMw';
  async function fileMode(body: string) {
    const r = rule({ id: 'm1', action: { kind: 'mock', status: 200, body, headers: { 'content-type': 'application/json' } } });
    await mount({ view: 'rules' });
    await emit({ type: 'snapshot', exchanges: [], rules: [r], status });
    await click(byTitle('Edit', $('.rule-item')!));
    await click(radio('From a file in the workspace')!);
  }

  it('a secret-looking body is flagged inline and in the confirm (danger button)', async () => {
    await fileMode(`{"access_token":"${jwt}"}`);
    expect($('.body-secret')!.textContent).toContain('what looks like a JWT');
    await click(button('Create file…'));
    const c = $('.body-file-confirm')!;
    expect(c.textContent).toContain('It contains what looks like a JWT.');
    expect(button('Create file', c).className).toContain('btn-danger');
    expect($('.body-secret')).toBeNull();
  });

  it("the host's refusal is shown in the editor; changing the path clears it", async () => {
    await fileMode('{"ok":true}');
    expect($('.body-secret')).toBeNull();
    await emit({ type: 'error', message: 'an earlier, unrelated error' });
    await click(button('Create file…'));
    await click(button('Create file', $('.body-file-confirm')!));
    expect($('.body-file-error')).toBeNull();
    await emit({ type: 'error', message: 'Not written: the body contains a "password" value.' });
    expect($('.body-file-error')!.textContent).toBe('Not written: the body contains a "password" value.');
    expect($('.host-error')).not.toBeNull();
    await type(byPlaceholder('.vscode/flutter-intercept/mocks/cart.json')!, 'mocks/other.json');
    expect($('.body-file-error')).toBeNull();
  });
});

describe('REVIEW-6 #1: upstream proxy', () => {
  it('shown in the toolbar and the status line while in use', async () => {
    await mount();
    await emit({ type: 'snapshot', exchanges: [], rules: [], status });
    expect($('.upstream-chip')).toBeNull();
    expect($('.upstream-status')).toBeNull();
    await emit({ type: 'status', status: { ...status, upstreamProxy: '127.0.0.1:8888' } });
    expect($('.upstream-chip')!.textContent).toBe('via upstream proxy 127.0.0.1:8888');
    expect($('.upstream-chip')!.title).toContain('HTTPS included');
    expect($('.statusline .upstream-status')!.textContent).toBe('via upstream proxy 127.0.0.1:8888');
    expect($('.upstream-chip.insecure')).toBeNull();
    await emit({ type: 'status', status: { ...status, upstreamProxy: '127.0.0.1:8888', upstreamProxyInsecure: true } });
    expect($('.upstream-chip.insecure')!.textContent).toBe('via upstream proxy 127.0.0.1:8888 · certificate checks OFF');
    expect($('.upstream-chip')!.title).toContain('flutterIntercept.upstreamProxyIgnoreCertErrors');
    expect($('.statusline .upstream-status .insecure')!.title).toContain('flutterIntercept.upstreamProxyIgnoreCertErrors');
    expect($('.statusline .upstream-status')!.textContent).toBe('via upstream proxy 127.0.0.1:8888 · certificate checks OFF');
  });
});

// ---------------------------------------------------------------- shared rules

describe('shared rules', () => {
  const shared = rule({ id: 's1', name: 'Team mock', shared: true, action: { kind: 'mock', status: 200, body: '{}' } });
  const mine = rule({ id: 'p1', name: 'Mine', action: { kind: 'mapRemote', to: 'https://staging.example.com' } });
  const mine2 = rule({ id: 'p2', name: 'Mine too' });
  const st: Status = { ...status, sharedRules: { file: '.vscode/flutter-intercept.json', count: 1, problems: ['Rule 3 skipped: match.url is required.'], pendingApproval: 0 } };
  const items = () => $$('.rule-item');

  async function rulesView(s: Status = st, rules: Rule[] = [shared, mine, mine2]) {
    await mount({ view: 'rules' });
    await emit({ type: 'snapshot', exchanges: [], rules, status: s });
  }

  it('badge, read-only controls in the list, file + problems shown', async () => {
    await rulesView();
    const s = items()[0];
    expect($('.shared-badge', s)!.title).toContain('.vscode/flutter-intercept.json');
    expect(($('input[type="checkbox"]', s) as HTMLInputElement).disabled).toBe(true);
    expect(byTitle('Shared rule: Unshare it first, or remove it from the file', s).disabled).toBe(true);
    expect(byTitle('Move down', s).disabled).toBe(true);
    expect(byTitle('Move up', items()[1]).disabled).toBe(true); // personal rules can't go above shared ones
    expect(byTitle('Move down', items()[1]).disabled).toBe(false);
    expect(items()[0].getAttribute('draggable')).not.toBe('true');
    expect(items()[1].getAttribute('draggable')).toBe('true');
    expect($('.shared-info')!.textContent).toContain('1 shared rule from .vscode/flutter-intercept.json run first.');
    expect($('.shared-problems')!.textContent).toContain('Rule 3 skipped');
  });

  it('setRules carries the shared rules unchanged (the host rewrites the file only when they differ)', async () => {
    await rulesView();
    await click($('input[type="checkbox"]', items()[2])!);
    const msg = lastOf('setRules')!;
    expect(msg.rules.map((r) => r.id)).toEqual(['s1', 'p1', 'p2']);
    expect(msg.rules[0]).toBe(shared);
    expect(msg.rules[2].enabled).toBe(false);
    await click(byTitle('Move down', items()[1]));
    expect(lastOf('setRules')!.rules.map((r) => r.id)).toEqual(['s1', 'p2', 'p1']);
  });

  it('Unshare posts shareRule false; Share asks first (secrets, approval for remote targets)', async () => {
    await rulesView();
    await click(button('Unshare', items()[0]));
    expect(lastOf('shareRule')).toEqual({ type: 'shareRule', id: 's1', shared: false });
    expect($('.notice')!.textContent).toContain('back to your personal rules');
    await click(button('Share', items()[1]));
    const c = $('.share-confirm')!;
    expect(c.textContent).toContain('.vscode/flutter-intercept.json');
    expect(c.textContent).toContain('no tokens or personal data');
    expect(c.textContent).toContain("Teammates will have to approve it before it runs: it sends the app's traffic to staging.example.com.");
    await click(button('Cancel', c));
    expect($('.share-confirm')).toBeNull();
    expect(lastOf('shareRule')!.shared).toBe(false);
    await click(button('Share', items()[2]));
    expect($('.share-confirm')!.textContent).not.toContain('approve');
    await click(button('Share', $('.share-confirm')!));
    expect(lastOf('shareRule')).toEqual({ type: 'shareRule', id: 'p2', shared: true });
  });

  it('a shared rule opens read-only: a note naming the file, disabled fields, Close only', async () => {
    await rulesView();
    await click(byTitle('View', items()[0]));
    const form = $('.rule-editor')!;
    expect(form.getAttribute('aria-label')).toBe('Shared rule');
    expect($('.shared-note', form)!.textContent).toContain('.vscode/flutter-intercept.json');
    expect(($('fieldset.re-body', form) as HTMLFieldSetElement).disabled).toBe(true);
    expect(() => button('Save', form)).toThrow();
    await click(button('Close', form));
    expect($('.rule-editor')).toBeNull();
  });

  it('approval banner: explains what is held back, lists the rules with reasons; Review file; Approve (host confirms)', async () => {
    await mount();
    await emit({ type: 'snapshot', exchanges: [], rules: [], status: { ...status, sharedRules: { count: 2, problems: [], pendingApproval: 1 } } });
    const banner = $('.approval-banner')!;
    expect(banner.textContent).toContain('1 rule waits for your approval');
    expect(banner.textContent).toContain('.vscode/flutter-intercept.json');
    expect(banner.textContent).toContain('authenticated traffic');
    expect($('.approval-list')).toBeNull();
    await click(button('Review file', banner));
    expect(lastOf('openSharedRules')).toEqual({ type: 'openSharedRules' });
    await click(button('Approve…', banner));
    expect(lastOf('approveSharedRules')).toEqual({ type: 'approveSharedRules' });
    await emit({ type: 'status', status: { ...status, sharedRules: { count: 2, problems: [], pendingApproval: 2, pending: [
      { name: 'Search → staging', reason: "it sends the app's traffic to staging.example.com" },
      { name: 'Debug header', reason: 'it sets request headers' },
    ] } } });
    expect($$('.approval-list li').map((l) => l.textContent)).toEqual([
      "Search → staging — it sends the app's traffic to staging.example.com", 'Debug header — it sets request headers',
    ]);
    await emit({ type: 'status', status: { ...status, sharedRules: { count: 3, problems: [], pendingApproval: 0 } } });
    expect($('.approval-banner')).toBeNull();
  });

  it('delete + Undo keep the shared rules in the list sent', async () => {
    await rulesView();
    await click(byTitle('Delete', items()[2]));
    expect(lastOf('setRules')!.rules.map((r) => r.id)).toEqual(['s1', 'p1']);
    await click(button('Undo'));
    expect(lastOf('setRules')!.rules.map((r) => r.id)).toEqual(['s1', 'p1', 'p2']);
  });
});

// ---------------------------------------------------------------- recordings + replay

describe('recordings', () => {
  const recs: RecordingSummary[] = [
    { id: 'old', name: 'Before', createdAt: new Date(2026, 9, 1, 9, 0).getTime(), exchanges: 10, redacted: false },
    { id: 'new', name: 'After', createdAt: new Date(2026, 9, 9, 18, 30).getTime(), exchanges: 1, redacted: true },
  ];
  async function view(exchanges: Exchange[] = [], st: Status = status, persisted: object = {}) {
    await mount({ view: 'recordings', ...persisted });
    await emit({ type: 'snapshot', exchanges, rules: [], status: st }, { type: 'recordings', recordings: recs });
  }
  const rows = () => $$('.rec-item');

  it('lists newest first with date, count and a redacted badge; tab shows the count', async () => {
    await view();
    expect(rows().map((r) => $('.rec-title', r)!.textContent)).toEqual(['After', 'Before']);
    expect(rows()[0].textContent).toContain('9 Oct 18:30 · 1 exchange');
    expect($('.redacted-badge', rows()[0])).not.toBeNull();
    expect($('.redacted-badge', rows()[1])).toBeNull();
    expect(button(/^Recordings/).textContent).toBe('Recordings2');
  });

  it('empty state explains where recordings live', async () => {
    await mount({ view: 'recordings' });
    await emit({ type: 'snapshot', exchanges: [], rules: [], status });
    expect($('.recordings-view')!.textContent).toContain('No recordings yet.');
    expect($('.recordings-view')!.textContent).toContain('.dart_tool/flutter_intercept/recordings/');
  });

  it('save current traffic: name, redact option, counts finished exchanges only', async () => {
    // v0.8.0 (CONTRACTS §14.5): an open WebSocket is not saved (a closed one is), a TLS tunnel never is.
    const list = [ex({ id: 'a' }), ex({ id: 'b', state: 'pending' }), ex({ id: 'c', kind: 'websocket', state: 'pending' }), ex({ id: 'd', state: 'mocked' }),
      ex({ id: 't', kind: 'tunnel', method: 'CONNECT', url: 'https://bank.example:443/', status: undefined })];
    await view(list);
    await click(button(/Save current traffic/));
    const form = $('.rec-save')!;
    const name = $('input', form) as HTMLInputElement;
    expect(name.value).toMatch(/^Session \d+ \w{3} \d\d:\d\d$/);
    expect(button(/^Save 2 exchanges$/, form)).not.toBeNull();
    await type(name, '  ');
    expect(form.textContent).toContain('Give the recording a name');
    expect(button(/^Save 2/, form).disabled).toBe(true);
    await type(name, 'Checkout bug');
    expect(form.textContent).toContain('secrets included');
    await click(check(/Redact secrets/, form)!);
    expect(form.textContent).toContain('[redacted]');
    await click(button(/^Save 2/, form));
    expect(lastOf('saveRecording')).toEqual({ type: 'saveRecording', name: 'Checkout bug', redact: true });
    expect($('.rec-save')).toBeNull();
    expect($('.notice')!.textContent).toContain('Saving “Checkout bug” (2 exchanges)');
  });

  it('with a Traffic filter active, saves only the shown exchanges (ids) unless unticked', async () => {
    const list = [ex({ id: 'a', url: 'https://api.example.com/cart' }), ex({ id: 'b', url: 'https://api.example.com/me' })];
    await view(list, status, { filters: { text: 'cart', method: '', statusClasses: [], pausedOnly: false, showBrowser: false } });
    await click(button(/Save current traffic/));
    const form = $('.rec-save')!;
    expect(form.textContent).toContain('Only the 1 exchange the Traffic filter shows (of 2)');
    await click(button(/^Save 1 exchange$/, form));
    expect(lastOf('saveRecording')).toMatchObject({ ids: ['a'] });
    await click(button(/Save current traffic/));
    await click(check(/Only the 1/)!);
    await click(button(/^Save 2 exchanges$/));
    expect(lastOf('saveRecording')).not.toHaveProperty('ids');
  });

  it('replay with a fallback choice; the replaying row offers Stop; the bar and status line show it', async () => {
    await view();
    await click(button(/Replay…/, rows()[1]));
    const g = $('.rec-replay')!;
    expect(radio('Go to the real server', g)!.checked).toBe(true);
    await click(radio('Fail like offline', g)!);
    expect(g.textContent).toContain('Demo mode');
    await click(button(/Start replay/, g));
    expect(lastOf('replayRecording')).toEqual({ type: 'replayRecording', id: 'old', fallback: 'fail' });
    await emit({ type: 'status', status: { ...status, replay: { recording: 'Before', fallback: 'fail' } } });
    expect($('.replay-badge', rows()[1])).not.toBeNull();
    expect($('.replay-bar')!.textContent).toContain('Replaying “Before”');
    expect($('.replay-bar')!.textContent).toContain('unmatched requests fail like offline');
    expect($('.statusline')!.textContent).toContain('Replaying Before');
    expect(button(/^Recordings/).textContent).toContain('▶');
    await click(button(/Stop/, rows()[1]));
    expect(lastOf('replayRecording')).toEqual({ type: 'replayRecording' });
    posted = [];
    await click(button(/Stop replay/, $('.replay-bar')!));
    expect(lastOf('replayRecording')).toEqual({ type: 'replayRecording' });
    await emit({ type: 'status', status });
    expect($('.replay-bar')).toBeNull();
  });

  it('the replay bar shows in every view', async () => {
    await mount();
    await emit({ type: 'snapshot', exchanges: [], rules: [], status: { ...status, replay: { recording: 'X', fallback: 'passthrough' } } });
    expect($('.replay-bar')!.textContent).toContain('unmatched requests go to the real server');
  });

  it('diff: tick two → older vs newer; a third tick replaces the oldest pick', async () => {
    await view();
    const tickRow = (i: number) => click($('input[type="checkbox"]', rows()[i])!);
    expect(button('Diff selected').disabled).toBe(true);
    await tickRow(0);
    expect($('.rec-toolbar')!.textContent).toContain('Tick one more');
    await tickRow(1);
    expect($('.rec-toolbar')!.textContent).toContain('Compare “Before” (older) with “After”');
    await click(button('Diff selected'));
    expect(lastOf('diffRecordings')).toEqual({ type: 'diffRecordings', a: 'old', b: 'new' });
    expect($('.notice')!.textContent).toContain('Opening the diff');
    await click(button('Clear selection'));
    expect(button('Diff selected').disabled).toBe(true);
  });

  it('delete asks first', async () => {
    await view();
    await click(byTitle('Delete “Before”', rows()[1]));
    const c = $('.confirm', rows()[1])!;
    expect(c.textContent).toContain("can't be undone");
    await click(button('Cancel', c));
    expect(lastOf('deleteRecording')).toBeUndefined();
    await click(byTitle('Delete “Before”', rows()[1]));
    await click(button('Delete', $('.confirm', rows()[1])!));
    expect(lastOf('deleteRecording')).toEqual({ type: 'deleteRecording', id: 'old' });
  });
});

// ---------------------------------------------------------------- auth flows

describe('auth flows', () => {
  const u = ex({ id: 'u1', url: 'https://api.example.com/v1/orders', status: 401, startedAt: 1_000 });
  const r1 = ex({ id: 'r1', method: 'POST', url: 'https://api.example.com/auth/refresh', startedAt: 1_030 });
  const r2 = ex({ id: 'r2', method: 'POST', url: 'https://api.example.com/auth/refresh', startedAt: 1_060 });
  const t1 = ex({ id: 't1', url: 'https://api.example.com/v1/orders', startedAt: 1_400 });
  const stampede: AuthFlowSummary = {
    steps: [{ exchangeId: 'u1', role: 'unauthorized' }, { exchangeId: 'r1', role: 'refresh' }, { exchangeId: 'r2', role: 'refresh' }, { exchangeId: 't1', role: 'retry' }],
    stampede: { refreshCalls: 2, windowMs: 2000 },
  };
  const broken: AuthFlowSummary = { steps: [{ exchangeId: 'gone', role: 'unauthorized' }], problem: 'The retry never happened.' };

  it('timeline rows, stampede warning, problem; a row opens the exchange in Traffic; tab shows the alert count', async () => {
    await mount({ view: 'auth' });
    await emit({ type: 'snapshot', exchanges: [u, r1, r2, t1], rules: [], status }, { type: 'authFlows', flows: [stampede, broken] });
    expect(button(/^Auth/).textContent).toBe('Auth2');
    const cards = $$('.auth-flow');
    expect(cards).toHaveLength(2);
    expect(cards[0].textContent).toContain('exchange no longer listed'); // newest first
    expect($('.af-problem', cards[0])!.textContent).toBe('The retry never happened.');
    const c = cards[1];
    expect($('.af-head', c)!.textContent).toContain('GET /v1/orders');
    expect($('.stampede', c)!.textContent).toContain('2 refresh calls for one expiry (within 2 s)');
    expect($('.stampede', c)!.textContent).toContain('QueuedInterceptor');
    expect($$('.af-role', c).map((b) => b.textContent)).toEqual(['Unauthorized', 'Refresh', 'Refresh', 'Retry']);
    expect($$('.af-time', c).map((t) => t.textContent)).toEqual(['0', '+30 ms', '+60 ms', '+400 ms']);
    await click($$('.af-link', c)[3]);
    expect($('.traffic')).not.toBeNull();
    expect($('.row.selected')!.id).toBe('ex-t1');
  });

  it('empty state points at Expire token; a clean flow gets an ok badge and no alert count', async () => {
    await mount({ view: 'auth' });
    await emit({ type: 'snapshot', exchanges: [u, r1, t1], rules: [], status });
    expect($('.auth-view')!.textContent).toContain('Expire token');
    await emit({ type: 'authFlows', flows: [{ steps: [{ exchangeId: 'u1', role: 'unauthorized' }, { exchangeId: 'r1', role: 'refresh' }, { exchangeId: 't1', role: 'retry' }] }] });
    expect($('.ok-badge')).not.toBeNull();
    expect(button(/^Auth/).textContent).toBe('Auth1');
    expect($('.warn-count')).toBeNull();
  });
});

// ---------------------------------------------------------------- expire token

describe('Expire token on a request', () => {
  const req = ex({ id: 'x1', url: 'https://api.example.com/v1/orders?page=2', requestHeaders: { authorization: 'Bearer t' } });

  it('form prefilled with the route glob and count 1; posts expireToken; the new rule is announced with Undo', async () => {
    await mount();
    await emit({ type: 'snapshot', exchanges: [req], rules: [], status });
    await click($$('.row')[0]);
    await click(button('Expire token…'));
    const form = $('.expire-token')!;
    const url = $('input', form) as HTMLInputElement;
    expect(url.value).toBe('https://api.example.com/v1/orders*');
    const count = byLabel('Number of requests that get 401', form)!;
    expect(count.value).toBe('1');
    expect(form.textContent).toContain('the next request to https://api.example.com/v1/orders* gets 401');
    await type(count, '0');
    expect(button('Expire token', form).disabled).toBe(true);
    await type(count, '3');
    await type(url, 'https://api.example.com/*');
    await click(button('Expire token', form));
    expect(lastOf('expireToken')).toEqual({ type: 'expireToken', url: 'https://api.example.com/*', count: 3 });
    expect($('.expire-token')).toBeNull();
    const created = rule({ id: 'exp1', name: 'Expire token: https://api.example.com/*', action: {
      kind: 'sequence', steps: [{ action: { kind: 'mock', status: 401, body: '{"error":"token_expired"}' }, count: 3 }, { action: { kind: 'passthrough' } }],
    } });
    await emit({ type: 'rules', rules: [created] });
    expect($('.notice')!.textContent).toContain('Rule added: the next 3 requests to https://api.example.com/* get 401');
    await click(button('Undo'));
    expect(lastOf('setRules')).toEqual({ type: 'setRules', rules: [] });
  });

  it('Escape / Cancel closes it; native (read-only) exchanges cannot use it', async () => {
    await mount();
    await emit({ type: 'snapshot', exchanges: [req, ex({ id: 'n1', captured: 'vm-profile' })], rules: [], status });
    await click($$('.row')[0]);
    await click(button('Expire token…'));
    await click(button('Cancel', $('.expire-token')!));
    expect($('.expire-token')).toBeNull();
    await click($$('.row')[1]);
    expect(button('Expire token…').disabled).toBe(true);
    expect(button('Expire token…').title).toMatch(/^Read-only/);
  });
});
