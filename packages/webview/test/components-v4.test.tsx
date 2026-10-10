// @vitest-environment happy-dom
// v0.4.0 UI (CONTRACTS §10.5): model-check results (row badge, filter, detail section), JSON tree field menu →
// mutateField, mutate rules in the editor and list, Generate actions.
import { render } from 'preact';
import { act } from 'preact/test-utils';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { App } from '../src/components/App';
import type { Host } from '../src/host';
import type { ContractSummary, Exchange, HostMsg, ViewMsg } from '../src/protocol';
import { ex, rule, status } from './fixtures';

let root: HTMLElement;
let posted: ViewMsg[];
let listener: ((m: HostMsg) => void) | undefined;

function host(): Host {
  return {
    post: (m) => { posted.push(m); },
    getState: () => undefined,
    setState: () => {},
    onMessage: (l) => { listener = l; return () => { listener = undefined; }; },
  };
}
const tick = () => new Promise((r) => setTimeout(r, 0));
async function mount() { await act(() => { render(<App host={host()} />, root); }); }
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
async function key(el: Element, k: string, init: KeyboardEventInit = {}) {
  await act(() => { el.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, ...init })); });
}
async function contextMenu(el: Element) {
  await act(() => { el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 30, clientY: 40 })); });
}
const sent = () => posted.filter((m) => m.type !== 'ready');
const menuItems = () => $$('.menu [role="menuitem"]').map((b) => b.textContent);
const row = (path: string) => {
  const r = $$('.j-row[data-path]').find((x) => (x as HTMLElement).dataset.path === path);
  if (!r) throw new Error(`row ${path} not found`);
  return r as HTMLElement;
};

beforeEach(() => {
  posted = [];
  root = document.createElement('div');
  document.body.appendChild(root);
});
afterEach(() => {
  render(null, root);
  root.remove();
});

const USER = '{"id":42,"user":{"name":"Ada","avatar_url":null},"odd key":1,"items":[{"id":1,"price":2.5},{"id":2,"price":3}]}';
const user = (over: Partial<Exchange> = {}) => ex({
  id: 'u1', url: 'https://api.example.com/users/42?full=1',
  responseBody: { text: USER, encoding: 'utf8' }, ...over,
});
const result = (over: Partial<ContractSummary> = {}): ContractSummary => ({
  id: 'u1', checked: true, model: 'User', via: 'retrofit',
  violations: [
    { path: '$.user.avatar_url', field: 'avatarUrl', expected: 'String', actual: 'null', severity: 'error', message: 'Null is not a subtype of String' },
    { path: '$.items[1].price', field: 'price', expected: 'double', actual: 'int', severity: 'warning', message: 'int where a double is declared' },
  ],
  ...over,
});

/** Mount, load `exchanges`, select the first and show its response tab. */
async function openResponse(exchanges: Exchange[] = [user()], results: ContractSummary[] = []) {
  await mount();
  await emit({ type: 'snapshot', exchanges, rules: [], status });
  if (results.length) await emit({ type: 'contract', results });
  await click($$('.row')[0]);
  await click(button('Response'));
  if ($('.json-tools')) await click(button('Expand all'));
}

describe('model check results', () => {
  it('row badge: loud for errors, quiet for warnings, none when ok or unchecked', async () => {
    await mount();
    const a = user({ id: 'a' });
    const b = ex({ id: 'b' });
    const c = ex({ id: 'c' });
    const d = ex({ id: 'd' });
    await emit({ type: 'snapshot', exchanges: [a, b, c, d], rules: [], status });
    expect($$('.contract-badge')).toHaveLength(0);
    await emit({ type: 'contract', results: [
      result({ id: 'a' }),
      result({ id: 'b', violations: [result().violations[1]] }),
      result({ id: 'c', violations: [] }),
    ] });
    const badges = $$('.row').map((r) => r.querySelector('.contract-badge')?.className ?? '');
    expect(badges[0]).toContain('cb-error');
    expect(badges[1]).toContain('cb-warning');
    expect(badges[2]).toBe('');
    expect(badges[3]).toBe('');
    expect($('.row .contract-badge')!.getAttribute('title')).toBe('Model check (User): 1 error, 1 warning\n$.user.avatar_url: Null is not a subtype of String');
  });

  it('contract: filter token narrows the list', async () => {
    await mount();
    await emit({ type: 'snapshot', exchanges: [user({ id: 'a' }), ex({ id: 'b' })], rules: [], status });
    await emit({ type: 'contract', results: [result({ id: 'a' })] });
    await type($('input[type="search"], .filter-input, input[aria-label*="ilter"]')!, 'contract:error');
    expect($$('.row').map((r) => r.id)).toEqual(['ex-a']);
    await type($('input[type="search"], .filter-input, input[aria-label*="ilter"]')!, 'contract:unchecked');
    expect($$('.row').map((r) => r.id)).toEqual(['ex-b']);
  });

  it('detail: model, how it was mapped, each violation opens the model field; re-pick the model', async () => {
    await openResponse([user()], [result()]);
    const sec = $('.contract')!;
    expect(sec.className).toContain('contract-error');
    expect(sec.textContent).toContain('Model check');
    expect(sec.textContent).toContain('1 error, 1 warning');
    expect($('.contract-model', sec)!.textContent).toBe('User');
    expect(sec.textContent).toContain('matched by its Retrofit declaration');
    const vs = $$('.viol', sec);
    expect(vs).toHaveLength(2);
    expect(vs[0].textContent).toContain('$.user.avatar_url');
    expect(vs[0].textContent).toContain('Null is not a subtype of String');
    expect(vs[0].textContent).toContain('expected String, got null');
    await click($('.viol-btn', vs[1] as HTMLElement)!);
    expect(sent()).toEqual([{ type: 'openViolation', id: 'u1', index: 1 }]);
    await click(button('Check against a different model…'));
    expect(sent()[1]).toEqual({ type: 'pickModel', id: 'u1' });
  });

  it('violations are marked on the JSON tree rows', async () => {
    await openResponse([user()], [result()]);
    expect(row('$.user.avatar_url').className).toContain('j-mark-error');
    expect(row('$.user.avatar_url').getAttribute('title')).toBe('Model check error: Null is not a subtype of String');
    expect(row('$.items[1].price').className).toContain('j-mark-warning');
    expect(row('$.id').className).not.toContain('j-mark');
  });

  it('a clean result says it matches and how; via user / source labels', async () => {
    await openResponse([user()], [result({ violations: [], via: 'user' })]);
    expect($('.contract')!.className).toContain('contract-ok');
    expect($('.contract')!.textContent).toContain('matches the model');
    expect($('.contract')!.textContent).toContain('chosen by you');
    expect($$('.viol')).toHaveLength(0);
    await emit({ type: 'contract', results: [result({ violations: [], via: 'source' })] });
    expect($('.contract')!.textContent).toContain('from the call site in the stack trace');
  });

  it('unchecked: shows the reason and "Check against a model…"; JSON without a result offers the same', async () => {
    await openResponse([user()], [result({ checked: false, model: undefined, via: 'none', violations: [], reason: 'No Retrofit or Chopper method matches GET /users/{id}' })]);
    expect($('.contract')!.textContent).toContain('No Retrofit or Chopper method matches GET /users/{id}');
    await click(button('Check against a model…'));
    expect(sent()).toEqual([{ type: 'pickModel', id: 'u1' }]);
    await emit({ type: 'cleared' }, { type: 'snapshot', exchanges: [user()], rules: [], status });
    await click($$('.row')[0]);
    expect($('.contract')!.textContent).toContain('Not checked.');
    expect(button('Check against a model…')).toBeTruthy();
  });

  it('no section for non-JSON responses without a result', async () => {
    await openResponse([ex({ responseHeaders: { 'content-type': 'text/html' }, responseBody: { text: '<p>hi</p>', encoding: 'utf8' } })]);
    expect($('.contract')).toBeNull();
  });
});

describe('JSON tree field menu → mutateField', () => {
  it('right click a field: make null, with the exact path; the notice comes with the new rule and can undo', async () => {
    await openResponse();
    expect($('.j-hint')!.textContent).toContain('Right-click a field');
    await contextMenu(row('$.user.avatar_url'));
    expect(menuItems()).toEqual(['Make null in next responses', 'Remove from next responses', 'Change value…', 'Copy JSON path']);
    expect(document.activeElement?.textContent).toBe('Make null in next responses');
    await click(button('Make null in next responses'));
    expect(sent()).toEqual([{ type: 'mutateField', id: 'u1', path: '$.user.avatar_url', op: 'null' }]);
    expect($('.menu')).toBeNull();
    const before = [rule({ id: 'old' })];
    const created = rule({ id: 'm1', action: { kind: 'mutate', ops: [{ path: '$.user.avatar_url', op: 'null' }] } });
    await emit({ type: 'rules', rules: [created, ...before] });
    expect($('.notice')!.textContent).toContain('Rule added: $.user.avatar_url → null in the next GET /users/42 responses.');
    await click(button('Undo'));
    expect(sent().at(-1)).toEqual({ type: 'setRules', rules: before });
  });

  it('remove an odd key and an array element; "every item" variants use [*]', async () => {
    await openResponse();
    await contextMenu(row("$['odd key']"));
    await click(button('Remove from next responses'));
    expect(sent()[0]).toEqual({ type: 'mutateField', id: 'u1', path: "$['odd key']", op: 'delete' });

    await contextMenu(row('$.items[0].price'));
    expect(menuItems()).toEqual([
      'Make null in next responses', 'Remove from next responses', 'Change value…',
      'Make null in every item', 'Remove from every item', 'Copy JSON path',
    ]);
    await click(button('Make null in every item'));
    expect(sent()[1]).toEqual({ type: 'mutateField', id: 'u1', path: '$.items[*].price', op: 'null' });

    await contextMenu(row('$.items[1]'));
    await click(button('Remove from next responses'));
    expect(sent()[2]).toEqual({ type: 'mutateField', id: 'u1', path: '$.items[1]', op: 'delete' });
  });

  it('Change value…: inline JSON input, validated; Enter applies a set op; Escape cancels', async () => {
    await openResponse();
    await contextMenu(row('$.id'));
    await click(button('Change value…'));
    const input = $<HTMLTextAreaElement>('.j-edit textarea')!;
    expect(input.value).toBe('42');
    expect(document.activeElement).toBe(input);
    await type(input, '"42');
    expect(button('Apply to next responses').disabled).toBe(true);
    expect($('.j-edit .msg.error')!.textContent).toMatch(/Not valid JSON/);
    await key(input, 'Enter');
    expect(sent()).toEqual([]);
    await type(input, '"42"');
    expect(button('Apply to next responses').disabled).toBe(false);
    await key(input, 'Enter');
    expect(sent()).toEqual([{ type: 'mutateField', id: 'u1', path: '$.id', op: 'set', value: '42', valueJson: '"42"' }]);
    expect($('.j-edit')).toBeNull();

    // Objects start as their compact text; Escape closes without posting.
    await contextMenu(row('$.user'));
    await click(button('Change value…'));
    const obj = $<HTMLTextAreaElement>('.j-edit textarea')!;
    expect(obj.value).toBe('{"name":"Ada","avatar_url":null}');
    await key(obj, 'Escape');
    expect($('.j-edit')).toBeNull();
    expect(sent()).toHaveLength(1);
  });

  it('sends the literal text as valueJson (1.0 stays 1.0, big ints exact) with value for older hosts; no warning', async () => {
    await openResponse();
    await contextMenu(row('$.items[0].price'));
    await click(button('Change value…'));
    await type($('.j-edit textarea')!, ' 1.0 ');
    expect($('.j-edit .msg')).toBeNull();
    await click(button('Apply to next responses'));
    expect(sent()[0]).toEqual({ type: 'mutateField', id: 'u1', path: '$.items[0].price', op: 'set', value: 1, valueJson: '1.0' });
    await emit({ type: 'rules', rules: [rule({ id: 'm9', action: { kind: 'mutate', ops: [{ path: '$.items[0].price', op: 'set', value: 1, valueJson: '1.0' }] } })] });
    expect($('.notice')!.textContent).toContain('Rule added: $.items[0].price = 1.0 in the next GET /users/42 responses.');
    await contextMenu(row('$.id'));
    await click(button('Change value…'));
    await type($('.j-edit textarea')!, '12345678901234567890');
    await key($('.j-edit textarea')!, 'Enter');
    expect((sent()[1] as Extract<ViewMsg, { type: 'mutateField' }>).valueJson).toBe('12345678901234567890');
  });

  it('keyboard: arrows move between fields, Shift+F10 / ContextMenu open the menu, Escape restores focus', async () => {
    await openResponse();
    const tree = $('.json-tree')!;
    expect(tree.getAttribute('tabindex')).toBe('0');
    tree.focus();
    await key(tree, 'ArrowDown');
    expect((document.activeElement as HTMLElement).dataset.path).toBe('$.id');
    await key(document.activeElement!, 'ArrowDown');
    expect((document.activeElement as HTMLElement).dataset.path).toBe('$.user');
    await key(document.activeElement!, 'ArrowUp');
    await key(document.activeElement!, 'End');
    const last = document.activeElement as HTMLElement;
    expect(last.dataset.path).toBe('$.items[1].price');
    await key(last, 'F10', { shiftKey: true });
    expect($('.menu')).not.toBeNull();
    expect($('.menu')!.getAttribute('aria-label')).toBe('Field $.items[1].price');
    await key($('.menu')!, 'Escape');
    expect($('.menu')).toBeNull();
    expect(document.activeElement).toBe(last);
    await key(last, 'ContextMenu');
    await click(button('Make null in next responses'));
    expect(sent()).toEqual([{ type: 'mutateField', id: 'u1', path: '$.items[1].price', op: 'null' }]);
  });

  it('mocked responses: items are disabled with the reason; the request body tree has no menu', async () => {
    await openResponse([user({ state: 'mocked' })]);
    await contextMenu(row('$.id'));
    const make = button('Make null in next responses');
    expect(make.disabled).toBe(true);
    expect(make.title).toMatch(/mock rule/);
    expect(button('Copy JSON path').disabled).toBe(false);
    await key($('.menu')!, 'Escape');
    await click(button('Request'));
    expect($$('.j-row[data-path]')).toHaveLength(0);
  });
});

describe('mutate rules in the rules view', () => {
  it('editor: ops list (path, op, JSON value), validation, save; the list describes it', async () => {
    await mount();
    await emit({ type: 'snapshot', exchanges: [ex()], rules: [], status });
    await click(button(/^Rules/));
    await click(button(/Add rule/));
    const form = $('.rule-editor')!;
    await type(form.querySelector('input.mono')!, 'https://api.example.com/users/*');
    await click(Array.from(form.querySelectorAll('label.radio')).find((l) => l.textContent === 'Mutate JSON')!.querySelector('input')!);
    expect(form.textContent).toContain('Changes to the response');
    expect($('.rule-editor .msg.error')!.textContent).toBe('Change 1: Path: Required, e.g. $.user.avatar_url');
    expect(button('Add rule', form).disabled).toBe(true);

    await type($('.mo-path', form)!, '$.user.avatar_url');
    await click(button('+ Add change', form));
    const paths = $$('.mo-path', form);
    await type(paths[1], '$.age');
    await choose($$('.mo-row select', form)[1], 'set');
    await type($('.mo-value', form)!, '{"n":');
    expect($('.rule-editor .msg.error')!.textContent).toMatch(/^Change 2: Value is not valid JSON/);
    expect($('.mo-value', form)!.getAttribute('aria-invalid')).toBe('true');
    await type($('.mo-value', form)!, '1.0');
    expect(form.textContent).not.toContain('will be');
    await click(button('Add rule', form));
    const msg = sent()[0] as Extract<ViewMsg, { type: 'setRules' }>;
    expect(msg.rules[0].action).toEqual({ kind: 'mutate', ops: [{ path: '$.user.avatar_url', op: 'null' }, { path: '$.age', op: 'set', value: 1, valueJson: '1.0' }] });
    expect($('.rule-item .kind')!.textContent).toBe('mutate');
    expect($('.rule-item .rule-sub')!.textContent).toContain('Mutate: $.user.avatar_url → null, $.age = 1.0');
  });

  it('editing an existing mutate rule shows its ops; removing a change', async () => {
    await mount();
    const r = rule({ id: 'm1', action: { kind: 'mutate', ops: [{ path: '$.a', op: 'delete' }, { path: '$.b', op: 'null' }] } });
    await emit({ type: 'snapshot', exchanges: [], rules: [r], status });
    await click(button(/^Rules/));
    await click($('button[title="Edit"]')!);
    const form = $('.rule-editor')!;
    expect($$('.mo-path', form).map((i) => (i as HTMLInputElement).value)).toEqual(['$.a', '$.b']);
    await click($('button[title="Remove change 1"]', form)!);
    await click(button('Save', form));
    expect((sent()[0] as Extract<ViewMsg, { type: 'setRules' }>).rules[0].action).toEqual({ kind: 'mutate', ops: [{ path: '$.b', op: 'null' }] });
  });
});

describe('Generate actions', () => {
  it('detail menu posts generateModel / generateFixture and shows a brief notice', async () => {
    await openResponse();
    await click(button(/Generate…/));
    expect(menuItems()).toEqual(['Generate Dart model', 'Generate test fixture']);
    await click(button('Generate Dart model'));
    expect(sent()).toEqual([{ type: 'generateModel', id: 'u1' }]);
    expect($('.notice')!.textContent).toContain('Generating a Dart model from the recorded GET /users/42 responses');
    await click(button(/Generate…/));
    await click(button('Generate test fixture'));
    expect(sent()[1]).toEqual({ type: 'generateFixture', id: 'u1' });
    expect($('.notice')!.textContent).toContain('test fixture');
  });

  it('row menu offers both; the model needs a JSON response, the fixture any response', async () => {
    await mount();
    const html = ex({ id: 'h1', responseHeaders: { 'content-type': 'text/html' }, responseBody: { text: '<p/>', encoding: 'utf8' } });
    const err = ex({ id: 'e1', state: 'error', status: undefined, responseHeaders: undefined, responseBody: undefined, error: 'refused' });
    await emit({ type: 'snapshot', exchanges: [html, err], rules: [], status });
    await contextMenu($$('.row')[0]);
    expect(button('Generate Dart model').disabled).toBe(true);
    expect(button('Generate Dart model').title).toBe('The response is not JSON');
    await click(button('Generate test fixture'));
    expect(sent()).toEqual([{ type: 'generateFixture', id: 'h1' }]);
    await contextMenu($$('.row')[1]);
    expect(button('Generate test fixture').disabled).toBe(true);
  });
});
