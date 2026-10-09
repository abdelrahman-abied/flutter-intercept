// @vitest-environment happy-dom
import { render } from 'preact';
import { act } from 'preact/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../src/components/App';
import type { Host } from '../src/host';
import type { HostMsg, ViewMsg } from '../src/protocol';
import { ex, pausedRequest, pausedResponse, rule, status } from './fixtures';

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

const tick = () => new Promise((r) => setTimeout(r, 0));

async function mount(persisted?: unknown) {
  await act(() => { render(<App host={host(persisted)} />, root); });
}

/** Deliver host messages and let the 0 ms batch flush + Preact re-render. */
async function emit(...msgs: HostMsg[]) {
  await act(async () => {
    for (const m of msgs) listener!(m);
    await tick();
  });
}

const $ = <T extends Element = HTMLElement>(sel: string) => root.querySelector(sel) as T | null;
const $$ = (sel: string) => Array.from(root.querySelectorAll(sel));
const button = (label: string | RegExp) => {
  const b = $$('button').find((x) => (typeof label === 'string' ? x.textContent?.trim() === label : label.test(x.textContent ?? '')));
  if (!b) throw new Error(`button ${label} not found`);
  return b as HTMLButtonElement;
};
async function click(el: Element) {
  await act(() => { (el as HTMLElement).click(); });
}
async function type(el: Element, value: string) {
  await act(() => {
    (el as HTMLInputElement).value = value;
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
async function key(el: Element, k: string, init: KeyboardEventInit = {}) {
  await act(() => { el.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, ...init })); });
}

beforeEach(() => {
  posted = [];
  root = document.createElement('div');
  document.body.appendChild(root);
});
afterEach(() => {
  render(null, root);
  root.remove();
});

describe('App shell', () => {
  it('sends ready on load and shows the empty state', async () => {
    await mount();
    expect(posted).toEqual([{ type: 'ready' }]);
    await emit({ type: 'snapshot', exchanges: [], rules: [], status });
    expect(root.textContent).toContain('Press F5 to run your Flutter app — traffic appears here.');
    expect(root.textContent).toContain('Proxy listening on port 8899 · 1 debug session');
  });

  it('renders traffic and status line from snapshot / exchange / status / cleared', async () => {
    await mount();
    await emit({ type: 'snapshot', exchanges: [ex({ url: 'https://api.example.com/users' })], rules: [], status });
    expect($$('.row')).toHaveLength(1);
    expect($('.row .c-host')!.textContent).toBe('api.example.com');
    expect($('.row .c-path')!.textContent).toBe('/users');
    await emit({ type: 'exchange', exchange: ex({ status: 503 }) });
    expect($$('.row')).toHaveLength(2);
    expect($$('.row .status')[1].className).toContain('sc-5xx');
    await emit({ type: 'status', status: { ...status, interceptEnabled: false } });
    expect($('.statusline')!.textContent).toContain('Intercept off');
    expect($('.intercept-toggle')!.textContent).toContain('Intercept off');
    await emit({ type: 'cleared' });
    expect($$('.row')).toHaveLength(0);
  });

  it('toolbar posts intercept toggle and clear', async () => {
    await mount();
    await emit({ type: 'snapshot', exchanges: [ex()], rules: [], status });
    await click($('.intercept-toggle')!);
    await click($('[aria-label="Clear traffic"]')!);
    expect(posted.slice(1)).toEqual([{ type: 'setInterceptEnabled', enabled: false }, { type: 'clear' }]);
  });

  it('paused count draws attention and jumps to the paused exchange', async () => {
    await mount();
    const p = pausedRequest();
    await emit({ type: 'snapshot', exchanges: [ex(), ex()], rules: [], status });
    await emit({ type: 'exchange', exchange: p });
    expect($('.paused-alert')!.textContent).toContain('1 paused');
    expect($(`#ex-${p.id}`)!.getAttribute('aria-selected')).toBe('true');
  });
});

describe('traffic list', () => {
  it('renders 1000 rows quickly and only keeps the visible window in the DOM', async () => {
    await mount();
    const many = Array.from({ length: 1000 }, (_, i) => ex({ url: `https://api.example.com/n/${i}` }));
    const t0 = performance.now();
    await emit({ type: 'snapshot', exchanges: many, rules: [], status });
    const elapsed = performance.now() - t0;
    expect(elapsed).toBeLessThan(1000);
    const rows = $$('.row');
    expect(rows.length).toBeGreaterThan(10);
    expect(rows.length).toBeLessThan(100);
    expect($<HTMLElement>('.list-spacer')!.style.height).toBe(`${1000 * 22}px`);
    expect(root.textContent).toContain('1000 exchanges');

    // scrolling moves the window
    const scroller = $<HTMLElement>('.list-scroll')!;
    await act(() => {
      scroller.scrollTop = 500 * 22;
      scroller.dispatchEvent(new Event('scroll'));
    });
    expect($(`#ex-${many[500].id}`)).not.toBeNull();
    expect($(`#ex-${many[0].id}`)).toBeNull();
  });

  it('keyboard: arrows select, Enter opens details, Escape closes', async () => {
    await mount();
    const [a, b] = [ex(), ex({ method: 'DELETE' })];
    await emit({ type: 'snapshot', exchanges: [a, b], rules: [], status });
    const list = $('.list-scroll')!;
    await key(list, 'ArrowDown');
    expect($(`#ex-${a.id}`)!.getAttribute('aria-selected')).toBe('true');
    expect(list.getAttribute('aria-activedescendant')).toBe(`ex-${a.id}`);
    await key(list, 'ArrowDown');
    expect($('.detail-title .method')!.textContent).toBe('DELETE');
    await key(list, 'Enter');
    expect(document.activeElement).toBe($('.detail'));
    await key(list, 'Escape');
    expect($('.detail')).toBeNull();
  });

  it('filters by text and status class, with a clear-filters escape hatch', async () => {
    await mount();
    await emit({ type: 'snapshot', exchanges: [ex({ url: 'https://a.dev/cart' }), ex({ url: 'https://a.dev/me', status: 401 })], rules: [], status });
    await type($('.filter-text')!, 'cart');
    expect($$('.row')).toHaveLength(1);
    await type($('.filter-text')!, '');
    await click(button('4xx'));
    expect($$('.row')).toHaveLength(1);
    expect($('.row .c-path')!.textContent).toBe('/me');
    await click(button('5xx'));
    await click(button('4xx'));
    expect(root.textContent).toContain('No exchanges match the filters.');
    await click(button('Clear filters'));
    expect($$('.row')).toHaveLength(2);
  });
});

describe('detail pane', () => {
  it('pretty-prints JSON with collapsible nodes and labels binary bodies', async () => {
    await mount();
    const j = ex({ responseBody: { text: '{"user":{"name":"Ada","tags":["a","b"]},"n":1}', encoding: 'utf8' } });
    const bin = ex({ responseHeaders: { 'content-type': 'application/octet-stream' }, responseBody: { text: 'AAECAw==', encoding: 'base64', truncated: true } });
    await emit({ type: 'snapshot', exchanges: [j, bin], rules: [], status });
    await click($(`#ex-${j.id}`)!);
    await click(button('Response'));
    expect($('.json-tree')).not.toBeNull();
    expect(root.textContent).toContain('"name"');
    const toggle = $<HTMLButtonElement>('.j-tw[aria-expanded="true"]')!;
    await click(toggle);
    expect(root.textContent).toContain('2 keys');
    await click($(`#ex-${bin.id}`)!);
    expect(root.textContent).toContain('binary (4 bytes)');
    expect($('.badge.warn')!.textContent).toBe('truncated');
  });

  it('Mock / Block / Break on this post createRuleFromExchange', async () => {
    await mount();
    const a = ex();
    await emit({ type: 'snapshot', exchanges: [a], rules: [], status });
    await click($(`#ex-${a.id}`)!);
    await click(button('Mock this'));
    await click(button('Block this'));
    await click(button('Break on this'));
    expect(posted.slice(1)).toEqual([
      { type: 'createRuleFromExchange', id: a.id, action: 'mock' },
      { type: 'createRuleFromExchange', id: a.id, action: 'block' },
      { type: 'createRuleFromExchange', id: a.id, action: 'breakpoint' },
    ]);
  });
});

describe('paused exchange editor', () => {
  it('renders the paused-response editor with status, headers and body', async () => {
    await mount();
    const p = pausedResponse();
    await emit({ type: 'snapshot', exchanges: [ex(), p], rules: [], status });
    expect($('.pause-banner')!.textContent).toContain('Paused before the app receives the response');
    expect($<HTMLInputElement>('input[aria-label="Status"]')!.value).toBe('200');
    const names = $$('.he-name').map((i) => (i as HTMLInputElement).value);
    expect(names).toEqual(['content-type', 'set-cookie', 'set-cookie']);
    expect($<HTMLTextAreaElement>('textarea[aria-label="Response body"]')!.value).toBe('{"name":"Ada"}');
    expect(root.textContent).toContain('Valid JSON');
    expect(button(/Resume with edits/).disabled).toBe(true); // nothing changed yet
    await click(button('Resume unchanged'));
    expect(posted.at(-1)).toEqual({ type: 'resume', id: p.id });
  });

  it('sends only the changed fields', async () => {
    await mount();
    const p = pausedResponse();
    await emit({ type: 'snapshot', exchanges: [p], rules: [], status });
    await type($('input[aria-label="Status"]')!, '418');
    await type($('textarea[aria-label="Response body"]')!, '{"name":"Grace"}');
    expect(root.textContent).toContain('Edited: status, body');
    await click(button(/Resume with edits/));
    expect(posted.at(-1)).toEqual({ type: 'resume', id: p.id, edit: { status: 418, body: '{"name":"Grace"}' } });
    // buttons lock until the host reports the new state
    expect(button('Resume unchanged').disabled).toBe(true);
    await emit({ type: 'exchange', exchange: { ...p, state: 'completed', status: 418 } });
    expect($('.pause-editor')).toBeNull();
  });

  it('invalid JSON blocks "Resume with edits" until the user confirms', async () => {
    await mount();
    const p = pausedResponse();
    await emit({ type: 'snapshot', exchanges: [p], rules: [], status });
    await type($('textarea[aria-label="Response body"]')!, '{\n  "name": "Ada",\n}');
    expect($('.body-editor .msg.error')!.textContent).toContain('Invalid JSON — line 3, column 1');
    const before = posted.length;
    await click(button(/Resume with edits/));
    expect(posted.length).toBe(before); // blocked
    expect($('.confirm')!.textContent).toContain('not valid JSON (line 3, column 1)');
    await click(button('Keep editing'));
    expect($('.confirm')).toBeNull();
    await click(button(/Resume with edits/));
    await click(button('Send anyway'));
    expect(posted.at(-1)).toEqual({ type: 'resume', id: p.id, edit: { body: '{\n  "name": "Ada",\n}' } });
  });

  it('paused-request editor edits method/url/headers and can abort', async () => {
    await mount();
    const p = pausedRequest();
    await emit({ type: 'snapshot', exchanges: [p], rules: [], status });
    await type($('input[aria-label="Method"]')!, 'put');
    await click(button('+ Add header'));
    const names = $$('.he-name');
    await type(names[names.length - 1], 'x-debug');
    const values = $$('.he-value');
    await type(values[values.length - 1], 'on');
    await key($('.pause-editor')!, 'Enter', { metaKey: true });
    expect(posted.at(-1)).toEqual({
      type: 'resume', id: p.id,
      edit: { method: 'PUT', headers: { 'content-type': 'application/json', authorization: 'Bearer x', 'x-debug': 'on' } },
    });

    const q = pausedRequest();
    await emit({ type: 'exchange', exchange: q });
    await click($(`#ex-${q.id}`)!);
    await type($('input[aria-label="URL"]')!, 'not a url');
    expect(root.textContent).toContain('URL must be absolute');
    expect(button(/Resume with edits/).disabled).toBe(true);
    await click(button(/Abort/));
    expect(posted.at(-1)).toEqual({ type: 'abort', id: q.id });
  });
});

describe('rules view', () => {
  it('shows evaluation order, toggles, reorders and deletes via setRules', async () => {
    await mount();
    const [a, b] = [rule({ id: 'a', name: 'First' }), rule({ id: 'b', name: 'Second' })];
    await emit({ type: 'snapshot', exchanges: [], rules: [a, b], status });
    await click(button(/Rules/));
    expect(root.textContent).toContain('first enabled rule that matches wins');
    expect($$('.rule-order').map((e) => e.textContent)).toEqual(['1', '2']);

    await click($('input[aria-label="Enable rule First"]')!);
    expect(posted.at(-1)).toEqual({ type: 'setRules', rules: [{ ...a, enabled: false }, b] });

    await click($$('[aria-label="Move up"]')[1]);
    expect((posted.at(-1) as { rules: { id: string }[] }).rules.map((r) => r.id)).toEqual(['b', 'a']);
    expect($$('.rule-name').map((e) => e.textContent)).toEqual(['breakpointSecond', 'breakpointFirst']);

    await click($$('[aria-label="Delete"]')[0]);
    expect((posted.at(-1) as { rules: { id: string }[] }).rules.map((r) => r.id)).toEqual(['a']);
    await click(button('Undo'));
    expect((posted.at(-1) as { rules: { id: string }[] }).rules.map((r) => r.id)).toEqual(['b', 'a']);
  });

  it('rule editor validates the matcher and saves a mock', async () => {
    await mount();
    await emit({ type: 'snapshot', exchanges: [ex({ url: 'https://api.example.com/users/7' })], rules: [], status });
    await click(button(/Rules/));
    await click(button(/Add rule/));
    const url = $('input[placeholder^="https://api.example.com/users"]')!;
    await type(url, '/[/');
    expect(root.textContent).toContain('Invalid regular expression');
    const submit = () => $<HTMLButtonElement>('.re-actions button[type="submit"]')!;
    expect(submit().disabled).toBe(true);
    await type(url, '/users\\/\\d+$/');
    expect(root.textContent).toContain('Matches 1 of the 1 exchanges');
    await type($('textarea[aria-label="Mock body"]')!, '{"id":7}');
    await click(submit());
    const msg = posted.at(-1) as Extract<ViewMsg, { type: 'setRules' }>;
    expect(msg.type).toBe('setRules');
    expect(msg.rules).toHaveLength(1);
    expect(msg.rules[0]).toMatchObject({
      enabled: true, match: { url: '/users\\/\\d+$/' },
      action: { kind: 'mock', status: 200, headers: { 'content-type': 'application/json' }, body: '{"id":7}' },
    });
    expect($('.rule-editor')).toBeNull();
  });

  it('restored UI state reopens the rule editor once rules arrive', async () => {
    await mount({ view: 'rules', editingRuleId: 'a', filters: { text: 'x' } });
    expect($('.rule-editor')).toBeNull(); // rules not known yet
    await emit({ type: 'snapshot', exchanges: [], rules: [rule({ id: 'a', name: 'Saved', action: { kind: 'block', mode: 'status', status: 451 } })], status });
    expect($('.re-head h3')!.textContent).toBe('Edit rule');
    expect($<HTMLInputElement>('.rule-editor input[placeholder="e.g. Empty cart"]')!.value).toBe('Saved');
    await click(button('Traffic'));
    expect($<HTMLInputElement>('.filter-text')!.value).toBe('x');
  });

  it('a created mock rule opens in the editor', async () => {
    await mount();
    const a = ex();
    await emit({ type: 'snapshot', exchanges: [a], rules: [], status });
    await click($(`#ex-${a.id}`)!);
    await click(button('Mock this'));
    await emit({ type: 'rules', rules: [rule({ id: 'm1', name: 'Mock GET /items', action: { kind: 'mock', status: 200, body: '{"ok":true}' } })] });
    expect($('.rule-editor')).not.toBeNull();
    expect($<HTMLTextAreaElement>('textarea[aria-label="Mock body"]')!.value).toBe('{"ok":true}');
  });
});

describe('phase 2 contract: countdown, removed, error, gave up, edits', () => {
  afterEach(() => { vi.useRealTimers(); });

  it('paused rows and the editor count down to pauseDeadline', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'Date'] });
    const now = Date.now();
    await mount();
    const p = pausedResponse({ pausedAt: now - 28_000, pauseDeadline: now + 272_000 });
    await emit({ type: 'snapshot', exchanges: [ex(), p], rules: [], status });
    expect($(`#ex-${p.id} .c-dur .countdown`)!.textContent).toBe('4:32');
    expect($('.pause-banner')!.textContent).toContain('auto-resumes in 4:32');
    await act(() => { vi.advanceTimersByTime(250_000); });
    expect($(`#ex-${p.id} .c-dur .countdown`)!.textContent).toBe('0:22');
    expect($(`#ex-${p.id} .countdown`)!.classList.contains('urgent')).toBe(true);
    await act(() => { vi.advanceTimersByTime(30_000); });
    expect($('.pause-banner')!.textContent).toContain('auto-resuming unedited…');
  });

  it('removed drops rows and closes the detail of a removed exchange', async () => {
    await mount();
    const [a, b] = [ex(), ex()];
    await emit({ type: 'snapshot', exchanges: [a, b], rules: [], status });
    await click($(`#ex-${a.id}`)!);
    expect($('.detail')).not.toBeNull();
    await emit({ type: 'removed', ids: [a.id] });
    expect($$('.row').map((r) => r.id)).toEqual([`ex-${b.id}`]);
    expect($('.detail')).toBeNull();
  });

  it('host error shows a non-blocking banner and unlocks the paused editor', async () => {
    await mount();
    const p = pausedResponse();
    await emit({ type: 'snapshot', exchanges: [p], rules: [], status });
    await type($('input[aria-label="Status"]')!, '418');
    await click(button(/Resume with edits/));
    expect(button('Resume unchanged').disabled).toBe(true);
    await emit({ type: 'error', message: 'Resume rejected: upstream gone' });
    expect($('.host-error')!.textContent).toContain('Resume rejected: upstream gone');
    expect(button('Resume unchanged').disabled).toBe(false); // unlocked
    expect($<HTMLInputElement>('input[aria-label="Status"]')!.value).toBe('418'); // edit kept
    await emit({ type: 'error', message: 'second' });
    expect($('.host-error')!.textContent).toContain('(+1 earlier)');
    await click($('[aria-label="Dismiss errors"]')!);
    expect($('.host-error')).toBeNull();
  });

  it('a client that gave up while paused is shown clearly and cannot be resumed', async () => {
    await mount();
    const p = pausedRequest({ pausedAt: Date.now(), pauseDeadline: Date.now() + 300_000 });
    await emit({ type: 'snapshot', exchanges: [p], rules: [], status });
    expect($('.pause-editor')).not.toBeNull();
    await emit({ type: 'exchange', exchange: { ...p, state: 'error', pausedAt: undefined, pauseDeadline: undefined, error: 'Client closed the connection while the request was paused (client timeout?)' } });
    expect($('.pause-editor')).toBeNull();
    expect($('.gave-up')!.textContent).toContain('The app gave up while this exchange was paused');
    expect($('.gave-up')!.textContent).toContain('can no longer be resumed');
    expect($(`#ex-${p.id} .state`)!.textContent).toBe('gave up');
    expect($$('button').some((b) => /Resume/.test(b.textContent ?? ''))).toBe(false);
  });

  it('binary bodies are read-only and never sent; repeated headers are sent as arrays', async () => {
    await mount();
    const p = pausedResponse({
      responseHeaders: { 'content-type': 'image/png', 'set-cookie': ['a=1', 'b=2'] },
      responseBody: { text: 'AAECAw==', encoding: 'base64' },
    });
    await emit({ type: 'snapshot', exchanges: [p], rules: [], status });
    expect($('textarea[aria-label="Response body"]')).toBeNull();
    expect($('.body-readonly')!.textContent).toContain('binary (4 bytes) — read-only');
    await click(button('+ Add header'));
    const names = $$('.he-name');
    await type(names[names.length - 1], 'Set-Cookie');
    const values = $$('.he-value');
    await type(values[values.length - 1], 'c=3');
    await click(button(/Resume with edits/));
    expect(posted.at(-1)).toEqual({
      type: 'resume', id: p.id,
      edit: { headers: { 'content-type': 'image/png', 'set-cookie': ['a=1', 'b=2', 'c=3'] } },
    });
  });
});

describe('lossless JSON (no 2^53 rounding)', () => {
  const body = '{"id":12345678901234567890,"z":-0,"f":1.0,"big":1e400,"s":"caf\\u00e9"}';

  it('the JSON tree shows the original number and string tokens', async () => {
    await mount();
    const e = ex({ responseBody: { text: body, encoding: 'utf8' } });
    await emit({ type: 'snapshot', exchanges: [e], rules: [], status });
    await click($(`#ex-${e.id}`)!);
    await click(button('Response'));
    const nums = $$('.json-tree .j-num').map((n) => n.textContent);
    expect(nums).toEqual(['12345678901234567890', '-0', '1.0', '1e400']);
    expect($('.json-tree .j-str')!.textContent).toBe('"caf\\u00e9"');
    expect(root.textContent).not.toContain('12345678901234567000');
  });

  it('Format in the paused editor re-indents without changing tokens, and that exact text is sent', async () => {
    await mount();
    const p = pausedResponse({ responseBody: { text: body, encoding: 'utf8' } });
    await emit({ type: 'snapshot', exchanges: [p], rules: [], status });
    await click(button('Format'));
    const ta = $<HTMLTextAreaElement>('textarea[aria-label="Response body"]')!;
    expect(ta.value).toBe('{\n  "id": 12345678901234567890,\n  "z": -0,\n  "f": 1.0,\n  "big": 1e400,\n  "s": "caf\\u00e9"\n}');
    await click(button(/Resume with edits/));
    expect(posted.at(-1)).toEqual({ type: 'resume', id: p.id, edit: { body: ta.value } });
  });
});

describe('LAN listener status (physical iPhone)', () => {
  it('shows host:port while open, explains the token in the tooltip, never shows a token', async () => {
    await mount();
    await emit({ type: 'snapshot', exchanges: [], rules: [], status });
    expect($('.lan-open')).toBeNull();
    await emit({ type: 'status', status: { ...status, lan: { host: '192.168.1.20', port: 8899 } } });
    const lan = $('.lan-open')!;
    expect(lan.textContent).toBe('LAN open for iPhone · 192.168.1.20:8899');
    expect(lan.getAttribute('title')).toMatch(/only accepts the app that holds this session's secret token/);
    expect(lan.getAttribute('title')).toMatch(/closes when the last iPhone session ends/);
    expect($('.statusline')!.textContent).not.toMatch(/token=|flutter-intercept:/);
    await emit({ type: 'status', status });
    expect($('.lan-open')).toBeNull();
  });
});

describe('Agent API indicators (CONTRACTS §8)', () => {
  it('status line shows agent connection and last call, never a token', async () => {
    await mount();
    await emit({ type: 'snapshot', exchanges: [], rules: [], status });
    expect($('.agent-status')).toBeNull();
    const agent = { access: 'readWrite', mcpUrl: 'http://127.0.0.1:47823/mcp', clients: 1, lastCall: { tool: 'wait_for_request', at: Date.now() - 3000 } };
    await emit({ type: 'status', status: { ...status, agent } });
    const el = $('.agent-status')!;
    expect(el.textContent).toBe('Agent: connected · last: wait_for_request 3s ago');
    expect(el.getAttribute('title')).toContain('http://127.0.0.1:47823/mcp');
    expect($('.statusline')!.textContent + el.getAttribute('title')).not.toMatch(/bearer|token/i);
    await emit({ type: 'status', status: { ...status, agent: { access: 'readOnly', clients: 0 } } });
    expect($('.agent-status')!.textContent).toBe('Agent (read-only): idle');
    await emit({ type: 'status', status: { ...status, agent: { access: 'off', clients: 0 } } });
    expect($('.agent-status')!.textContent).toBe('Agent access: off');
  });

  it('agent rules get a badge in the rules list, the traffic row and the detail pane', async () => {
    await mount();
    const agentRule = rule({ id: 'ag1', name: '[agent] Products 500', match: { url: 'https://api.example.com/products*' },
      action: { kind: 'mock', status: 500, body: '{}' } });
    const mine = rule({ id: 'me1', name: 'Mine' });
    const hit = ex({ url: 'https://api.example.com/products', state: 'mocked', status: 500, matchedRuleId: 'ag1' });
    const other = ex({ matchedRuleId: 'me1' });
    await emit({ type: 'snapshot', exchanges: [hit, other], rules: [agentRule, mine], status });
    expect($(`#ex-${hit.id} .agent-badge`)).not.toBeNull();
    expect($(`#ex-${hit.id} .agent-badge`)!.getAttribute('title')).toBe('Matched agent rule “Products 500”');
    expect($(`#ex-${other.id} .agent-badge`)).toBeNull();
    await click($(`#ex-${hit.id}`)!);
    expect($('.detail-facts .agent-badge')).not.toBeNull();
    expect($('.detail-facts')!.textContent).toContain('rule #1 “Products 500”');
    await click(button(/Rules/));
    const names = $$('.rule-name');
    expect(names[0].querySelector('.agent-badge')!.textContent).toBe('agent');
    expect(names[0].textContent).toBe('mockagentProducts 500');
    expect(names[1].querySelector('.agent-badge')).toBeNull();
  });
});
