// @vitest-environment happy-dom
// v0.7.0 UI (CONTRACTS §13): timing waterfall column + Timing tab, script rules (editor, file, log), the Export menu,
// `select` from a notification, and "Open in new window".
import { render } from 'preact';
import { act } from 'preact/test-utils';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { App } from '../src/components/App';
import type { Host } from '../src/host';
import type { HostMsg, Rule, ViewMsg } from '../src/protocol';
import { SCRIPT_TEMPLATE } from '../src/scripts';
import { ex, rule, status } from './fixtures';

let root: HTMLElement;
let posted: ViewMsg[];
let listener: ((m: HostMsg) => void) | undefined;
let saved: unknown;

function host(persisted?: unknown): Host {
  return {
    post: (m) => { posted.push(m); },
    getState: <T,>() => persisted as T | undefined,
    setState: (s) => { saved = s; },
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
const radio = (label: string, scope: ParentNode = root) =>
  ($$('label.radio', scope).find((l) => l.textContent?.trim() === label)?.querySelector('input') ?? null) as HTMLInputElement | null;
const byPlaceholder = (start: string, scope: ParentNode = root) =>
  $$('input', scope).find((i) => (i as HTMLInputElement).placeholder.startsWith(start)) as HTMLInputElement | undefined;
const sent = () => posted.filter((m) => m.type !== 'ready');
const lastOf = <T extends ViewMsg['type']>(t: T) => sent().filter((m) => m.type === t).at(-1) as Extract<ViewMsg, { type: T }> | undefined;
const menuItem = (label: RegExp) => $$('[role="menuitem"]').find((b) => label.test(b.textContent ?? '')) as HTMLButtonElement;

beforeEach(() => {
  posted = [];
  saved = undefined;
  root = document.createElement('div');
  document.body.appendChild(root);
});
afterEach(() => {
  render(null, root);
  root.remove();
  document.body.classList.remove('fi-panel');
});

const T0 = 1_700_000_100_000;

// ---------------------------------------------------------------- waterfall

describe('waterfall column (CONTRACTS §13.2)', () => {
  const timed = ex({
    startedAt: T0, durationMs: 200,
    timings: { requestMs: 10, dnsMs: 20, connectMs: 30, tlsMs: 40, sendMs: 0, waitMs: 80, receiveMs: 20 },
  });
  const plain = ex({ startedAt: T0 + 100, durationMs: 100 });

  it('renders one bar per row, split by phase, with a tooltip', async () => {
    await mount();
    await emit({ type: 'snapshot', exchanges: [timed, plain], rules: [], status });
    expect($('.list')!.classList.contains('wf')).toBe(true);
    expect($('.list-head .c-wf')!.textContent).toMatch(/Waterfall · 200 ms/);
    const rows = $$('.row');
    const first = rows[0].querySelector('.c-wf') as HTMLElement;
    expect($$('.wf-seg', first).map((s) => s.className.replace('wf-seg ', ''))).toEqual(['ph-request', 'ph-dns', 'ph-connect', 'ph-tls', 'ph-wait', 'ph-receive']);
    expect(first.title).toMatch(/DNS lookup: 20 ms/);
    expect(first.title).toMatch(/Total: 200 ms/);
    const bar = (rows[1].querySelector('.wf-bar') as HTMLElement).style;
    expect(bar.left).toBe('50%');
    expect(bar.width).toBe('50%');
    expect($$('.wf-seg', rows[1]).map((s) => s.className)).toEqual(['wf-seg ph-total']);
  });

  it('can be hidden from the toolbar; the choice is remembered', async () => {
    await mount();
    await emit({ type: 'snapshot', exchanges: [timed], rules: [], status });
    await click(button(/Waterfall/, $('.toolbar')!));
    expect($('.list')!.classList.contains('wf')).toBe(false);
    expect($$('.c-wf')).toHaveLength(0);
    await act(async () => { await tick(350); });
    expect((saved as { showWaterfall?: boolean }).showWaterfall).toBe(false);
    expect(sent()).toEqual([]);
  });

  it('starts hidden when the webview state says so', async () => {
    await mount({ showWaterfall: false });
    await emit({ type: 'snapshot', exchanges: [timed], rules: [], status });
    expect($$('.c-wf')).toHaveLength(0);
    expect(button(/Waterfall/, $('.toolbar')!).getAttribute('aria-pressed')).toBe('false');
  });

  it('stays light with 1000 rows (virtualised: only the rows in view get bars)', async () => {
    const many = Array.from({ length: 1000 }, (_, i) => ex({ startedAt: T0 + i * 10, durationMs: 50, timings: { waitMs: 40, receiveMs: 10 } }));
    await mount();
    await emit({ type: 'snapshot', exchanges: many, rules: [], status });
    expect($$('.wf-bar').length).toBeLessThan(80);
  });
});

// ---------------------------------------------------------------- timing tab

describe('Timing tab', () => {
  it('shows phase rows with bars and ms, paused / delay as added time, reused connection and the total', async () => {
    const e = ex({ durationMs: 1300, timings: { requestMs: 5, pausedMs: 1000, delayMs: 200, reused: true, sendMs: 1, waitMs: 80, receiveMs: 14 } });
    await mount({ selectedId: e.id, detailTab: 'timing' });
    await emit({ type: 'snapshot', exchanges: [e], rules: [], status });
    const t = $('.timing')!;
    const rows = $$('.timing-row', t);
    expect(rows.map((r) => r.querySelector('th')!.textContent)).toEqual([
      'Request from the app', 'Paused at a breakpoint — by you', 'Added delay — simulated', 'Send', 'Waiting (TTFB)', 'Content download', 'Connection',
    ]);
    expect(rows.map((r) => r.querySelector('.timing-ms')?.textContent)).toEqual(['5 ms', '1.00 s', '200 ms', '1 ms', '80 ms', '14 ms', undefined]);
    expect(rows[1].classList.contains('added')).toBe(true);
    expect(rows[2].classList.contains('added')).toBe(true);
    expect(rows[6].textContent).toMatch(/reused from the pool/);
    expect($('.reused-badge', t)).not.toBeNull();
    const paused = rows[1].querySelector('.timing-bar') as HTMLElement;
    expect(paused.style.left).toBe(`${Math.round((5 / 1300) * 10000) / 100}%`);
    expect($('.timing-total', t)!.textContent).toMatch(/Total.*1\.30 s/);
  });

  it('adds an "Other" row for time the phases do not cover', async () => {
    const e = ex({ durationMs: 100, timings: { requestMs: 10, waitMs: 60 } });
    await mount({ selectedId: e.id, detailTab: 'timing' });
    await emit({ type: 'snapshot', exchanges: [e], rules: [], status });
    expect($('.timing-row.other')!.textContent).toMatch(/Other.*30 ms/);
  });

  it('without timings: the total only', async () => {
    const e = ex({ durationMs: 42 });
    await mount({ selectedId: e.id });
    await emit({ type: 'snapshot', exchanges: [e], rules: [], status });
    await click(button('Timing'));
    expect($('.timing-table')).toBeNull();
    expect($('.timing-none')!.textContent).toMatch(/Total 42 ms/);
    expect($('.timing-none')!.textContent).toMatch(/No phase timings/);
  });
});

// ---------------------------------------------------------------- script rules

describe('script rules (CONTRACTS §13.4)', () => {
  async function newScriptRule(rules: Rule[] = []) {
    await mount({ view: 'rules' });
    await emit({ type: 'snapshot', exchanges: [], rules, status });
    await click(button(/Add rule/));
    await type(byPlaceholder('https://api.example.com/users')!, 'https://api.example.com/users/*');
    await click(radio('Script (JS)')!);
  }

  it('inline: a monospace editor with the template as placeholder; saves code', async () => {
    await newScriptRule();
    const ta = $<HTMLTextAreaElement>('textarea.script-code')!;
    expect(ta.placeholder).toBe(SCRIPT_TEMPLATE);
    expect(ta.classList.contains('code-input')).toBe(true);
    expect(button('Add rule', $('.re-actions')!).disabled).toBe(true);
    await click(button('Start from the template'));
    expect($<HTMLTextAreaElement>('textarea.script-code')!.value).toBe(SCRIPT_TEMPLATE);
    await type($('textarea.script-code')!, 'function onRequest(request) { return request; }');
    await click(button('Add rule', $('.re-actions')!));
    expect(lastOf('setRules')!.rules.at(-1)!.action).toEqual({ kind: 'script', code: 'function onRequest(request) { return request; }' });
  });

  it('a script that defines no hook can\'t be saved', async () => {
    await newScriptRule();
    await type($('textarea.script-code')!, 'const x = 1;');
    expect($('.script-editor .msg.error')!.textContent).toMatch(/onRequest/);
    expect(button('Add rule', $('.re-actions')!).disabled).toBe(true);
  });

  it('file: suggests a path, Create sends the inline script (empty = the host\'s template), Open sends just the path', async () => {
    await newScriptRule();
    await click(radio('Edit script in a file')!);
    const path = byPlaceholder('.vscode/flutter-intercept/scripts')!;
    expect(path.value).toBe('.vscode/flutter-intercept/scripts/users.js');
    await click(button('Create file'));
    // Empty inline script: empty content, the host writes its own template.
    expect(lastOf('openScriptFile')).toEqual({ type: 'openScriptFile', path: '.vscode/flutter-intercept/scripts/users.js', create: { content: '' } });
    await click(button('Open file'));
    expect(lastOf('openScriptFile')).toEqual({ type: 'openScriptFile', path: '.vscode/flutter-intercept/scripts/users.js' });
    // Inline code written first travels into the new file.
    await click(radio('Inline')!);
    await type($('textarea.script-code')!, 'function onResponse(r) { return r; }');
    await click(radio('Edit script in a file')!);
    await click(button('Create file'));
    expect(lastOf('openScriptFile')!.create).toEqual({ content: 'function onResponse(r) { return r; }' });
    await click(button('Add rule', $('.re-actions')!));
    expect(lastOf('setRules')!.rules.at(-1)!.action).toEqual({
      kind: 'script', code: 'function onResponse(r) { return r; }', file: '.vscode/flutter-intercept/scripts/users.js',
    });
  });

  it('shows the host\'s error for a refused file, and rejects non-.js paths', async () => {
    await newScriptRule();
    await click(radio('Edit script in a file')!);
    await click(button('Open file'));
    await emit({ type: 'error', message: 'The script file must be inside the workspace.' });
    expect($('.script-file-error')!.textContent).toBe('The script file must be inside the workspace.');
    await type(byPlaceholder('.vscode/flutter-intercept/scripts')!, 'scripts/x.ts');
    expect($('.script-file-error')).toBeNull();
    expect(button('Open file').disabled).toBe(true);
    expect($('.script-editor')!.textContent).toMatch(/ending in \.js/);
  });

  it('a file-backed rule shows its path, an Open button and the current content; the list says where the script lives', async () => {
    const r = rule({ name: 'Auth header', action: { kind: 'script', code: 'function onRequest(r){return r}', file: '.vscode/flutter-intercept/scripts/auth.js' } });
    const inline = rule({ name: 'Inline one', action: { kind: 'script', code: 'function onRequest(r){return r}' } });
    await mount({ view: 'rules', editingRuleId: r.id });
    await emit({ type: 'snapshot', exchanges: [], rules: [r, inline], status });
    expect(byPlaceholder('.vscode/flutter-intercept/scripts')!.value).toBe('.vscode/flutter-intercept/scripts/auth.js');
    expect($('.script-editor .file-content pre')!.textContent).toBe('function onRequest(r){return r}');
    await click(button('Open file'));
    // REVIEW-7 #6: a saved rule's id goes along (the host resolves the path in that rule's folder).
    expect(lastOf('openScriptFile')).toEqual({ type: 'openScriptFile', path: '.vscode/flutter-intercept/scripts/auth.js', ruleId: r.id });
    expect(root.textContent).toMatch(/Script: \.vscode\/flutter-intercept\/scripts\/auth\.js/);
    expect(root.textContent).toMatch(/Script: inline/);
  });

  it('REVIEW-7 #1: Create file on an existing file fails clearly and offers the next free name', async () => {
    await newScriptRule();
    await type($('textarea.script-code')!, 'function onRequest(r) { return r; }');
    await click(radio('Edit script in a file')!);
    await click(button('Create file'));
    expect(lastOf('openScriptFile')).toEqual({
      type: 'openScriptFile', path: '.vscode/flutter-intercept/scripts/users.js', create: { content: 'function onRequest(r) { return r; }' },
    });
    expect(lastOf('openScriptFile')!.ruleId).toBeUndefined(); // a new rule: the host doesn't know it yet
    await emit({ type: 'error', message: '.vscode/flutter-intercept/scripts/users.js already exists — not overwritten.' });
    const err = $('.script-file-error')!;
    expect(err.textContent).toMatch(/already exists/);
    expect(err.textContent).toMatch(/never reuses an existing file/);
    await click(button('Use .vscode/flutter-intercept/scripts/users-2.js', err));
    expect(byPlaceholder('.vscode/flutter-intercept/scripts')!.value).toBe('.vscode/flutter-intercept/scripts/users-2.js');
    expect($('.script-file-error')).toBeNull();
    await click(button('Create file'));
    expect(lastOf('openScriptFile')!.path).toBe('.vscode/flutter-intercept/scripts/users-2.js');
    expect(lastOf('openScriptFile')!.create).toEqual({ content: 'function onRequest(r) { return r; }' });
    // An error after "Open file" is shown without the rename offer.
    await click(button('Open file'));
    await emit({ type: 'error', message: 'No such file.' });
    expect($('.script-file-error')!.textContent).toBe('No such file.');
  });

  it('REVIEW-7 #6: Open / Create for a saved mock rule carry its id', async () => {
    const r = rule({ action: { kind: 'mock', status: 200, body: '{}', bodyFile: '.vscode/flutter-intercept/mocks/a.json' } });
    await mount({ view: 'rules', editingRuleId: r.id });
    await emit({ type: 'snapshot', exchanges: [], rules: [r], status });
    await click(button('Open file'));
    expect(lastOf('openBodyFile')).toEqual({ type: 'openBodyFile', path: '.vscode/flutter-intercept/mocks/a.json', ruleId: r.id });
  });

  it('a personal script rule held for approval shows in the banner without "shared"-only wording', async () => {
    await mount();
    await emit({ type: 'snapshot', exchanges: [], rules: [], status: { ...status, sharedRules: { count: 0, problems: [], pendingApproval: 1, pending: [
      { name: 'Auth header', reason: 'its script file changed outside the editor' },
    ] } } });
    const banner = $('.approval-banner')!;
    expect(banner.getAttribute('aria-label')).toBe('Rules awaiting approval');
    expect(banner.textContent).toMatch(/^.?1 rule waits for your approval/);
    expect(banner.textContent).toMatch(/script rules whose file content you haven't approved/);
    expect($$('.approval-list li').map((l) => l.textContent)).toEqual(['Auth header — its script file changed outside the editor']);
  });

  it('is not offered as a sequence step', async () => {
    await newScriptRule();
    await click(radio('Sequence')!);
    const opts = $$('.seq-step select option').map((o) => (o as HTMLOptionElement).value);
    expect(opts.length).toBeGreaterThan(0);
    expect(opts).not.toContain('script');
  });

  it('the detail pane shows the script log with the error line highlighted', async () => {
    const e = ex({ state: 'error', status: 502, error: 'Script Auth: TypeError: boom', scriptLog: ['token present', 'TypeError: boom'] });
    await mount({ selectedId: e.id });
    await emit({ type: 'snapshot', exchanges: [e], rules: [], status });
    const log = $<HTMLDetailsElement>('.script-log')!;
    expect(log.open).toBe(true);
    const lines = $$('.script-lines li', log);
    expect(lines.map((l) => l.textContent)).toEqual(['token present', 'TypeError: boom']);
    expect(lines[1].classList.contains('script-error')).toBe(true);
    expect(lines[0].classList.contains('script-error')).toBe(false);
  });
});

// ---------------------------------------------------------------- export

describe('Export menu (CONTRACTS §13.5)', () => {
  const a = ex({ url: 'https://api.example.com/users/1' });
  const b = ex({ url: 'https://api.example.com/orders/1' });
  const ws = ex({ url: 'wss://api.example.com/users/live', kind: 'websocket' });

  it('without a filter: export {format} (the host exports every HTTP exchange shown)', async () => {
    await mount();
    await emit({ type: 'snapshot', exchanges: [a, b, ws], rules: [], status });
    await click(button(/^\s*Export…/));
    expect($$('[role="menuitem"]').map((m) => m.textContent)).toEqual(['OpenAPI 3.1…', 'Postman collection…', 'HAR…']);
    await click(menuItem(/HAR/));
    expect(lastOf('export')).toEqual({ type: 'export', format: 'har' });
  });

  it('with a filter: the ids of the filtered HTTP exchanges (no WebSocket)', async () => {
    await mount();
    await emit({ type: 'snapshot', exchanges: [a, b, ws], rules: [], status });
    await type($('.filter-text')!, 'users');
    await click(button(/^\s*Export \(1\)…/));
    await click(menuItem(/OpenAPI/));
    expect(lastOf('export')).toEqual({ type: 'export', format: 'openapi', ids: [a.id] });
  });

  it('disabled items when there is nothing to export; a notice on exported', async () => {
    await mount();
    await emit({ type: 'snapshot', exchanges: [ws], rules: [], status });
    await click(button(/^\s*Export…/));
    expect(menuItem(/Postman/).disabled).toBe(true);
    await emit({ type: 'exported', format: 'postman', path: '/proj/app.postman_collection.json' });
    expect($('.notice')!.textContent).toMatch(/Exported Postman collection to \/proj\/app\.postman_collection\.json/);
  });
});

// ---------------------------------------------------------------- select + own window

describe('select from a notification (CONTRACTS §13.6)', () => {
  it('opens the traffic view on the exchange, clearing filters that hide it', async () => {
    const a = ex({ url: 'https://api.example.com/ok' });
    const bad = ex({ url: 'https://api.example.com/broken', status: 500 });
    await mount({ view: 'rules' });
    await emit({ type: 'snapshot', exchanges: [a, bad], rules: [], status });
    await emit({ type: 'status', status });
    // A filter that hides the failed request, set before switching away.
    await click(button('Traffic'));
    await type($('.filter-text')!, '/ok');
    await click(button(/^Rules/));
    await emit({ type: 'select', id: bad.id });
    expect($('.detail .url')!.textContent).toBe('https://api.example.com/broken');
    expect($<HTMLInputElement>('.filter-text')!.value).toBe('');
    expect($(`#ex-${bad.id}`)!.getAttribute('aria-selected')).toBe('true');
    expect($('.notice')!.textContent).toMatch(/Filters cleared/);
  });

  it('notes an exchange that is no longer listed', async () => {
    await mount();
    await emit({ type: 'snapshot', exchanges: [ex()], rules: [], status });
    await emit({ type: 'select', id: 'gone' });
    expect($('.notice')!.textContent).toMatch(/no longer listed/);
    expect($('.detail')).toBeNull();
  });
});

describe('own window (CONTRACTS §13.1)', () => {
  it('the toolbar button posts openInNewWindow', async () => {
    document.body.classList.add('fi-panel');
    await mount();
    await emit({ type: 'snapshot', exchanges: [], rules: [], status });
    const b = $$('button').find((x) => /own window/.test((x as HTMLButtonElement).title)) as HTMLButtonElement;
    expect(b.title).toMatch(/^Open Flutter Intercept in its own window/);
    await click(b);
    expect(lastOf('openInNewWindow')).toEqual({ type: 'openInNewWindow' });
  });

  it('in an editor tab (no fi-panel class) the button moves it to a new window', async () => {
    await mount();
    await emit({ type: 'snapshot', exchanges: [], rules: [], status });
    expect($$('button').some((x) => (x as HTMLButtonElement).title === 'Move Flutter Intercept to its own window')).toBe(true);
  });
});
