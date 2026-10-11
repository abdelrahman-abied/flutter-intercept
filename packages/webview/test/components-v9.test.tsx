// @vitest-environment happy-dom
// v0.9.0 UI (CONTRACTS §15.1): the App over the WebSocket host (snapshot, persistence, the "Reconnecting…" bar),
// the IDE layout under body.fi-ide (no VS Code-only "own window" button, IDE wording), the VS Code layout unchanged,
// and theme variable coverage (THEME_VARS = every --vscode-* variable styles.css uses; dev/ide-theme.css defines them).
import { render } from 'preact';
import { act } from 'preact/test-utils';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { App } from '../src/components/App';
import { createWebSocketHost, WS_STATE_KEY, type Host } from '../src/host';
import type { HostMsg, ViewMsg } from '../src/protocol';
import { THEME_VARS } from '../src/themeVars';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ex, status } from './fixtures';

class FakeSocket {
  static all: FakeSocket[] = [];
  static get last() { return FakeSocket.all[FakeSocket.all.length - 1]; }
  readyState = 0;
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  constructor(public url: string) { FakeSocket.all.push(this); }
  send(data: string) { this.sent.push(data); }
  close() { if (this.readyState !== 3) { this.readyState = 3; this.onclose?.(); } }
  open() { this.readyState = 1; this.onopen?.(); }
  drop() { this.readyState = 3; this.onclose?.(); }
  receive(m: HostMsg) { this.onmessage?.({ data: JSON.stringify(m) }); }
  get msgs(): ViewMsg[] { return this.sent.map((s) => JSON.parse(s)); }
}

const here = dirname(fileURLToPath(import.meta.url));
const stylesCss = readFileSync(join(here, '../src/styles.css'), 'utf8');
const ideThemeCss = readFileSync(join(here, '../dev/ide-theme.css'), 'utf8');

let root: HTMLElement;
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));
const $ = <T extends Element = HTMLElement>(sel: string) => root.querySelector(sel) as T | null;
const $$ = (sel: string) => Array.from(root.querySelectorAll(sel));
const windowButton = () => $$('button').find((b) => /own window/.test((b as HTMLButtonElement).title));
const storage = () => {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => { m.set(k, v); }, m };
};
const wsHost = (st = storage()) =>
  createWebSocketHost('ws://127.0.0.1:1/ws?t=x', { WebSocket: FakeSocket as unknown as new (u: string) => WebSocket, storage: st });
const plainHost = (posted: ViewMsg[] = []): Host => ({
  post: (m) => { posted.push(m); }, getState: () => undefined, setState: () => {}, onMessage: () => () => {},
});
async function mount(host: Host) { await act(() => { render(<App host={host} />, root); }); }

beforeEach(() => {
  FakeSocket.all = [];
  root = document.createElement('div');
  document.body.appendChild(root);
});
afterEach(() => {
  render(null, root);
  root.remove();
  document.body.classList.remove('fi-ide', 'fi-panel');
});

describe('App over the WebSocket host', () => {
  it('sends ready when the socket opens and renders the snapshot it gets back', async () => {
    document.body.classList.add('fi-ide');
    await mount(wsHost());
    expect(FakeSocket.last.sent).toEqual([]);
    await act(async () => { FakeSocket.last.open(); await tick(); });
    expect(FakeSocket.last.msgs).toEqual([{ type: 'ready' }]);
    await act(async () => { FakeSocket.last.receive({ type: 'snapshot', exchanges: [ex()], rules: [], status }); await tick(); });
    expect($$('.row').length).toBe(1);
    expect($('.connection-bar')).toBeNull();
  });

  it('shows "Reconnecting to Flutter Intercept…" while the sidecar is gone; Retry now reconnects and resyncs', async () => {
    document.body.classList.add('fi-ide');
    const host = wsHost();
    await mount(host);
    await act(async () => { FakeSocket.last.open(); FakeSocket.last.receive({ type: 'snapshot', exchanges: [ex()], rules: [], status }); await tick(); });
    await act(async () => { FakeSocket.last.drop(); await tick(); });
    const bar = $('.connection-bar')!;
    expect(bar.getAttribute('role')).toBe('alert');
    expect(bar.textContent).toMatch(/Reconnecting to Flutter Intercept…/);
    expect($$('.row').length).toBe(1);             // the last traffic stays visible meanwhile
    const retry = Array.from(bar.querySelectorAll('button')).find((b) => b.textContent?.trim() === 'Retry now')!;
    const n = FakeSocket.all.length;
    await act(() => { retry.click(); });
    expect(FakeSocket.all.length).toBe(n + 1);
    await act(async () => { FakeSocket.last.open(); await tick(); });
    expect(FakeSocket.last.msgs).toEqual([{ type: 'ready' }]);
    expect($('.connection-bar')).toBeNull();
    host.close();
  });

  it('persists UI state in the given storage (sessionStorage in the IDE) and restores it', async () => {
    const st = storage();
    await mount(wsHost(st));
    await act(async () => { await tick(400); });
    expect(st.m.has(WS_STATE_KEY)).toBe(true);
    const saved = JSON.parse(st.m.get(WS_STATE_KEY)!);
    st.m.set(WS_STATE_KEY, JSON.stringify({ ...saved, view: 'rules' }));
    render(null, root);
    await mount(wsHost(st));
    expect($('.rules-view')).not.toBeNull();
  });
});

describe('IDE layout (body.fi-ide)', () => {
  it('has no "own window" button and IDE wording in the empty state', async () => {
    document.body.classList.add('fi-ide');
    await mount(plainHost());
    expect(windowButton()).toBeUndefined();
    expect($('.empty .lead')!.textContent).toMatch(/Run or debug your Flutter app from the IDE/);
    expect($('.empty')!.textContent).toMatch(/Connecting to Flutter Intercept…/);
    expect($('.empty')!.textContent).not.toMatch(/F5|extension/);
  });

  it('VS Code layout is unchanged: own-window button, F5, no connection bar for the VS Code host', async () => {
    await mount(plainHost());
    expect((windowButton() as HTMLButtonElement).title).toBe('Move Flutter Intercept to its own window');
    expect($('.empty .lead')!.textContent).toMatch(/Press F5 to run your Flutter app/);
    expect($('.empty')!.textContent).toMatch(/Connecting to the extension…/);
    expect($('.connection-bar')).toBeNull();
  });

  it('styles.css gives fi-ide the editor-tab background', () => {
    expect(stylesCss).toMatch(/body\.fi-ide\s*\{\s*--fi-bg:\s*var\(--vscode-editor-background\)/);
  });
});

describe('theme variables (THEME_VARS)', () => {
  const used = [...new Set(stylesCss.match(/--vscode-[A-Za-z0-9.-]+/g) ?? [])].sort();
  const block = (selector: string) => {
    const i = ideThemeCss.indexOf(`${selector} {`);
    expect(i).toBeGreaterThanOrEqual(0);
    return ideThemeCss.slice(i, ideThemeCss.indexOf('}', i));
  };
  const defined = (css: string) => new Set([...css.matchAll(/(--vscode-[A-Za-z0-9.-]+)\s*:/g)].map((m) => m[1]));

  it('lists exactly the variables styles.css uses (no gaps, nothing stale, no duplicates)', () => {
    expect(used.length).toBeGreaterThan(50);
    expect([...THEME_VARS].sort()).toEqual(used);
    expect(new Set(THEME_VARS).size).toBe(THEME_VARS.length);
  });

  it('the reference IDE theme defines every one for light and dark', () => {
    for (const sel of ['body.fi-ide', 'body.fi-ide.ide-dark']) {
      const d = defined(block(sel));
      expect(THEME_VARS.filter((v) => !d.has(v)), sel).toEqual([]);
    }
  });

  it('are full custom property names', () => {
    expect(THEME_VARS.every((v) => /^--vscode-[A-Za-z0-9.-]+$/.test(v))).toBe(true);
  });
});
