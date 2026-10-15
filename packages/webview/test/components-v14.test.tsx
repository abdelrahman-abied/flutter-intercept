// @vitest-environment happy-dom
// v0.14.0 (CONTRACTS §20): servers that need the app's own certificate. The banner on a request / tunnel the proxy
// passed through (Add client certificate…, Try decrypting again), the "Add client certificate" popup (file tokens only,
// passphrase never kept, inline problems, accessible modal), the certificates + learned hosts list, and the host
// message filter knowing every HostMsg type.
import { render } from 'preact';
import { act } from 'preact/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../src/components/App';
import { isHostMsg, type Host } from '../src/host';
import type { Exchange, HostMsg, Status, ViewMsg } from '../src/protocol';
import { certCovering, certHostFor, certSaveBlocker, certStaysText, CERT_WHY, isLearnedLive, learnedUntilText, liveLearned, nextLearnedExpiry } from '../src/certificates';
import { tunnelTitle } from '../src/connection';
import { initialState, reducer, toPersisted } from '../src/state';
import { ex, status } from './fixtures';

let root: HTMLElement;
let posted: ViewMsg[];
let saved: unknown[];
let listener: ((m: HostMsg) => void) | undefined;

function host(): Host {
  return {
    post: (m) => { posted.push(m); },
    getState: () => undefined,
    setState: (s) => { saved.push(s); },
    onMessage: (l) => { listener = l; return () => { listener = undefined; }; },
  };
}
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));
async function mount() { await act(() => { render(<App host={host()} />, root); }); }
async function emit(...msgs: HostMsg[]) {
  await act(async () => { for (const m of msgs) listener!(m); await tick(); });
}
const $ = <T extends Element = HTMLElement>(sel: string, scope: ParentNode = document) => scope.querySelector(sel) as T | null;
const $$ = (sel: string, scope: ParentNode = document) => Array.from(scope.querySelectorAll(sel));
const button = (label: string | RegExp, scope: ParentNode = document) => {
  const b = Array.from(scope.querySelectorAll('button')).find((x) => (typeof label === 'string' ? x.textContent?.trim() === label : label.test(x.textContent ?? '')));
  if (!b) throw new Error(`button ${label} not found`);
  return b as HTMLButtonElement;
};
const maybeButton = (label: string, scope: ParentNode = document) =>
  Array.from(scope.querySelectorAll('button')).find((x) => x.textContent?.trim() === label);
async function click(el: Element) { await act(() => { (el as HTMLElement).click(); }); }
async function type(el: HTMLInputElement, value: string) {
  await act(() => { el.value = value; el.dispatchEvent(new Event('input', { bubbles: true })); });
}
async function key(el: Element, k: string, shift = false) {
  await act(() => { el.dispatchEvent(new KeyboardEvent('keydown', { key: k, shiftKey: shift, bubbles: true, cancelable: true })); });
}
const sent = () => posted.filter((m) => m.type !== 'ready');
const lastOf = <T extends ViewMsg['type']>(t: T) => sent().filter((m) => m.type === t).at(-1) as Extract<ViewMsg, { type: T }> | undefined;

beforeEach(() => {
  posted = [];
  saved = [];
  root = document.createElement('div');
  document.body.appendChild(root);
});
afterEach(() => {
  render(null, root);
  root.remove();
  document.body.classList.remove('fi-ide');
});

const CC_ERROR = 'This server needs the app\'s own client certificate (TLS alert certificate_required). From now on mtls.example.com is ' +
  'passed through without decryption, so the app talks to it directly with its own certificate. To see these requests, add the ' +
  'certificate in the Flutter Intercept panel (Add client certificate…).';
const failed = (over: Partial<Exchange> = {}): Exchange => ex({
  id: 'f1', url: 'https://mtls.example.com/api/me', state: 'error', status: undefined, responseHeaders: undefined, responseBody: undefined,
  error: CC_ERROR, learnedPassthrough: { reason: 'client-certificate', host: 'mtls.example.com', port: 443 }, ...over,
});
const tunnel = (over: Partial<Exchange> = {}): Exchange => ex({
  id: 't1', method: 'CONNECT', url: 'https://mtls.example.com:8443/', kind: 'tunnel', status: undefined, responseHeaders: undefined,
  responseBody: undefined, requestHeaders: {}, tunnelBytes: { sent: 1200, received: 4500 },
  notes: ['This server needs the app\'s own certificate: passed through without decryption.'],
  learnedPassthrough: { reason: 'client-certificate', host: 'mtls.example.com', port: 8443 }, ...over,
});
const learnedStatus = (over: Partial<Status> = {}): Status => ({
  ...status,
  learnedPassthrough: [{ host: 'mtls.example.com', port: 443, reason: 'client-certificate' }],
  ...over,
});
async function openDetail(e: Exchange, st: Status = learnedStatus()) {
  await mount();
  await emit({ type: 'snapshot', exchanges: [e], rules: [], status: st });
  await click($('.row')!);
}
const dialog = () => $('[role="dialog"][aria-modal="true"]');

// ---------------------------------------------------------------- pure helpers

describe('pure helpers (CONTRACTS §20)', () => {
  it('host prefill adds the port when it is not 443', () => {
    expect(certHostFor({ host: 'a.example', port: 443 })).toBe('a.example');
    expect(certHostFor({ host: 'a.example', port: 8443 })).toBe('a.example:8443');
  });

  it('Save is blocked until the host and the files the format needs are there', () => {
    expect(certSaveBlocker(' ', 'pfx', { pfx: {} })).toMatch(/host name/);
    expect(certSaveBlocker('a', 'pfx', {})).toBe('Choose the certificate file.');
    expect(certSaveBlocker('a', 'pfx', { pfx: {} })).toBeUndefined();
    expect(certSaveBlocker('a', 'pem', { pfx: {} })).toBe('Choose the certificate and its private key.');
    expect(certSaveBlocker('a', 'pem', { cert: {} })).toBe('Choose the private key.');
    expect(certSaveBlocker('a', 'pem', { key: {} })).toBe('Choose the certificate.');
    expect(certSaveBlocker('a', 'pem', { cert: {}, key: {} })).toBeUndefined();
  });

  it('learned hosts: live check, covering certificate, how long', () => {
    const e = { host: 'Mtls.example.com', port: 443 };
    expect(isLearnedLive(e, undefined)).toBe(true);
    expect(isLearnedLive(e, [{ host: 'mtls.example.com', port: 443, reason: 'client-certificate' }])).toBe(true);
    expect(isLearnedLive(e, [{ host: 'mtls.example.com', port: 8443, reason: 'client-certificate' }])).toBe(false);
    expect(certCovering({ host: 'api.bank.example', port: 443 }, [{ host: '*.bank.example' }])).toBe('*.bank.example');
    expect(certCovering({ host: 'api.bank.example', port: 443 }, [{ host: '*.bank.example:8443' }])).toBeUndefined();
    expect(learnedUntilText({}, 0)).toBe('until the proxy stops');
    const list = [{ until: undefined }, { until: 100 }, { until: 300 }, { until: 200 }];
    expect(liveLearned(list, 50)).toBe(list); // nothing expired: same array
    expect(liveLearned(list, 150)).toEqual([{ until: undefined }, { until: 300 }, { until: 200 }]);
    expect(liveLearned(undefined, 0)).toBeUndefined();
    expect(nextLearnedExpiry(list, 150)).toBe(200);
    expect(nextLearnedExpiry(list, 300)).toBeUndefined();
    expect(learnedUntilText({ until: 70_000 }, 0)).toBe('for 1m 10s more');
  });

  it('the popup explains why, and that it stays on this computer (IDE wording)', () => {
    expect(CERT_WHY).toMatch(/prove who it is with a certificate \(mutual TLS\)/);
    expect(CERT_WHY).toMatch(/passed through without decryption\.$/);
    expect(certStaysText(false)).toMatch(/never uploaded or sent anywhere except to this server/);
    expect(certStaysText(false)).toMatch(/VS Code's secret storage\.$/);
    expect(certStaysText(true)).toMatch(/the IDE's password safe\.$/);
    expect(certStaysText(true)).not.toMatch(/VS Code/);
  });

  it('tunnel tooltip says why a learned host is passed through', () => {
    expect(tunnelTitle(tunnel())).toMatch(/mtls\.example\.com:8443 passed through automatically \(needs the app's own certificate\)/);
    expect(tunnelTitle(tunnel({ learnedPassthrough: undefined }))).toMatch(/matches flutterIntercept\.tlsPassthrough/);
  });

  it('every HostMsg type passes the message filter (grpcDecoded and the §20.3 answers included)', () => {
    for (const type of ['grpcDecoded', 'clientCertificateFile', 'clientCertificateSaved', 'snapshot', 'exported']) {
      expect(isHostMsg({ type }), type).toBe(true);
    }
    expect(isHostMsg({ type: 'nope' })).toBe(false);
  });

  it('the popup state is never persisted', () => {
    let s = reducer(initialState(), { type: 'openCertDialog', host: 'a.example' });
    s = reducer(s, { type: 'certPicking', role: 'pfx' });
    s = reducer(s, { type: 'host', msgs: [{ type: 'clientCertificateFile', role: 'pfx', file: { token: 'tok-1', name: 'app.p12' } }] });
    expect(s.certDialog?.files.pfx?.name).toBe('app.p12');
    expect(JSON.stringify(toPersisted(s))).not.toContain('tok-1');
  });
});

// ---------------------------------------------------------------- banner

describe('banner on a request the proxy learned from', () => {
  it('client certificate: explains, Add client certificate… prefilled, Try decrypting again forgets', async () => {
    await openDetail(failed());
    const banner = $('.learned-banner')!;
    expect(banner.textContent).toContain('This server needs the app\'s own certificate…');
    expect($('.detail .msg.error')!.textContent).toBe(CC_ERROR);

    await click(button('Try decrypting again', banner));
    expect(lastOf('forgetLearnedPassthrough')).toEqual({ type: 'forgetLearnedPassthrough', host: 'mtls.example.com', port: 443 });
    expect($('.notice')!.textContent).toMatch(/New connections to mtls\.example\.com:443 are decrypted again/);

    await click(button('Add client certificate…', banner));
    expect(dialog()).not.toBeNull();
    expect($<HTMLInputElement>('.cert-dialog input:not([type])')!.value).toBe('mtls.example.com');
  });

  it('tunnel on another port: host:port prefill, learned explanation instead of the setting', async () => {
    await openDetail(tunnel(), learnedStatus({ learnedPassthrough: [{ host: 'mtls.example.com', port: 8443, reason: 'client-certificate' }] }));
    expect($('.tunnel')!.textContent).toMatch(/asks the app to prove who it is with a certificate/);
    expect($('.tunnel')!.textContent).not.toMatch(/flutterIntercept\.tlsPassthrough/);
    await click(button('Add client certificate…', $('.learned-banner')!));
    expect($<HTMLInputElement>('.cert-dialog input:not([type])')!.value).toBe('mtls.example.com:8443');
  });

  it('pinned: no add button; forgotten: says so, no buttons; covered by a certificate: says so', async () => {
    await openDetail(failed({ learnedPassthrough: { reason: 'pinned', host: 'mtls.example.com', port: 443 } }),
      learnedStatus({ learnedPassthrough: [{ host: 'mtls.example.com', port: 443, reason: 'pinned', until: Date.now() + 600_000 }] }));
    let banner = $('.learned-banner')!;
    expect(banner.textContent).toMatch(/doesn't accept the proxy's certificate/);
    expect(maybeButton('Add client certificate…', banner)).toBeUndefined();
    expect(maybeButton('Try decrypting again', banner)).toBeDefined();

    await emit({ type: 'status', status: learnedStatus({ learnedPassthrough: [] }) });
    banner = $('.learned-banner')!;
    expect(banner.textContent).toMatch(/no longer passed through/);
    expect(maybeButton('Try decrypting again', banner)).toBeUndefined();

    await emit({ type: 'exchange', exchange: failed() });
    await emit({ type: 'status', status: learnedStatus({ learnedPassthrough: [], clientCertificates: [{ host: '*.example.com' }] }) });
    banner = $('.learned-banner')!;
    expect(banner.textContent).toMatch(/A client certificate is set up for \*\.example\.com/);
    expect(maybeButton('Add client certificate…', banner)).toBeUndefined();
  });

  it('no banner without learnedPassthrough', async () => {
    await openDetail(ex({ state: 'error', error: 'ECONNRESET' }));
    expect($('.learned-banner')).toBeNull();
  });
});

// ---------------------------------------------------------------- popup

async function openDialog(hostPrefill = 'mtls.example.com') {
  await openDetail(failed({ learnedPassthrough: { reason: 'client-certificate', host: hostPrefill, port: 443 } }));
  const add = button('Add client certificate…', $('.learned-banner')!);
  add.focus(); // happy-dom's click() doesn't focus
  await click(add);
}

describe('Add client certificate popup', () => {
  it('is an accessible modal with the why / stays-on-your-computer text; Esc closes and focus returns', async () => {
    await openDialog();
    const d = dialog()!;
    const title = document.getElementById(d.getAttribute('aria-labelledby')!)!;
    expect(title.textContent).toBe('Add client certificate');
    expect(d.textContent).toContain(CERT_WHY);
    expect(d.textContent).toContain(certStaysText(false));
    // Host prefilled → focus starts at the file button.
    expect(document.activeElement?.textContent).toBe('Choose file…');
    // Labels: the host and passphrase inputs are inside <label>s.
    expect($('.cert-dialog input:not([type])')!.closest('label')!.textContent).toContain('Server');
    expect($('.cert-dialog input[type="password"]')!.closest('label')!.textContent).toContain('Passphrase (optional)');

    await key(d, 'Escape');
    expect(dialog()).toBeNull();
    expect(document.activeElement?.textContent).toBe('Add client certificate…');
  });

  it('traps Tab inside the popup', async () => {
    await openDialog();
    const d = dialog()!;
    const focusables = $$('button:not([disabled]), input:not([disabled])', d) as HTMLElement[];
    focusables.at(-1)!.focus();
    await key(d, 'Tab');
    expect(document.activeElement).toBe(focusables[0]);
    await key(d, 'Tab', true);
    expect(document.activeElement).toBe(focusables.at(-1));
  });

  it('empty host (Add… from the list) starts at the host field; the IDE says its password safe', async () => {
    document.body.classList.add('fi-ide');
    await mount();
    await emit({ type: 'snapshot', exchanges: [], rules: [], status });
    await click(button('Client certificates…'));
    await click(button(/Add…/, $('.certs-panel')!));
    expect($<HTMLInputElement>('.cert-dialog input:not([type])')!.value).toBe('');
    expect(document.activeElement).toBe($('.cert-dialog input:not([type])'));
    expect(dialog()!.textContent).toContain('The passphrase is kept in the IDE\'s password safe.');
    expect(dialog()!.textContent).not.toContain('VS Code');
  });

  it('PKCS#12: choose → file name shown, Save sends the token + passphrase, then forgets the passphrase', async () => {
    await openDialog();
    const save = () => button('Save', dialog()!);
    expect(save().disabled).toBe(true);
    expect($('.cert-blocker')!.textContent).toBe('Choose the certificate file.');

    await click(button('Choose file…', dialog()!));
    expect(lastOf('chooseClientCertificateFile')).toEqual({ type: 'chooseClientCertificateFile', role: 'pfx' });
    expect(button('Choosing…', dialog()!).disabled).toBe(true);
    await emit({ type: 'clientCertificateFile', role: 'pfx', file: { token: 'tok-pfx', name: 'client.p12' } });
    expect($('.cert-file-name')!.textContent).toBe('client.p12');
    expect(dialog()!.textContent).not.toContain('tok-pfx');
    expect(button('Change…', dialog()!)).toBeDefined();

    const pass = $<HTMLInputElement>('.cert-dialog input[type="password"]')!;
    await type(pass, 's3cret');
    await click(save());
    expect(lastOf('addClientCertificate')).toEqual({ type: 'addClientCertificate', host: 'mtls.example.com', pfx: 'tok-pfx', passphrase: 's3cret' });
    expect($<HTMLInputElement>('.cert-dialog input[type="password"]')!.value).toBe('');
    expect(button('Saving…', dialog()!).disabled).toBe(true);
    // Never persisted anywhere.
    await act(async () => { await tick(400); });
    expect(JSON.stringify(saved)).not.toMatch(/s3cret|tok-pfx/);

    // A problem keeps the popup open, inline.
    await emit({ type: 'clientCertificateSaved', host: 'MTLS.example.com', problem: 'Wrong passphrase for client.p12.' });
    expect(dialog()).not.toBeNull();
    expect($('.cert-problem-msg')!.textContent).toBe('Wrong passphrase for client.p12.');
    expect(save().disabled).toBe(false);

    // Saved: the popup closes, a notice says so.
    await type($<HTMLInputElement>('.cert-dialog input[type="password"]')!, 'right');
    await click(save());
    expect(lastOf('addClientCertificate')!.passphrase).toBe('right');
    await emit({ type: 'clientCertificateSaved', host: 'mtls.example.com' });
    expect(dialog()).toBeNull();
    expect($('.notice')!.textContent).toMatch(/Client certificate saved for mtls\.example\.com/);
  });

  it('PEM: certificate + key, no passphrase field sent when empty; an edited host is trimmed', async () => {
    await openDialog();
    await click($<HTMLInputElement>('.cert-dialog input[type="radio"]:not(:checked)')!);
    expect($$('.cert-file', dialog()!)).toHaveLength(2);
    expect($('.cert-blocker')!.textContent).toBe('Choose the certificate and its private key.');

    const [certBtn] = $$('.cert-file button', dialog()!) as HTMLButtonElement[];
    await click(certBtn);
    expect(lastOf('chooseClientCertificateFile')!.role).toBe('cert');
    await emit({ type: 'clientCertificateFile', role: 'cert', file: { token: 'tok-c', name: 'client.crt' } });
    await click(($$('.cert-file button', dialog()!) as HTMLButtonElement[])[1]);
    expect(lastOf('chooseClientCertificateFile')!.role).toBe('key');
    await emit({ type: 'clientCertificateFile', role: 'key', file: { token: 'tok-k', name: 'client.key' } });
    expect($$('.cert-file-name', dialog()!).map((e) => e.textContent)).toEqual(['client.crt', 'client.key']);

    await type($<HTMLInputElement>('.cert-dialog input:not([type])')!, '  *.example.com:8443 ');
    await click(button('Save', dialog()!));
    expect(lastOf('addClientCertificate')).toEqual({ type: 'addClientCertificate', host: '*.example.com:8443', cert: 'tok-c', key: 'tok-k' });
  });

  it('a cancelled pick changes nothing; a file problem shows inline; a late answer after Cancel is dropped', async () => {
    await openDialog();
    await click(button('Choose file…', dialog()!));
    await emit({ type: 'clientCertificateFile', role: 'pfx' });
    expect(button('Choose file…', dialog()!).disabled).toBe(false);
    expect($('.cert-problem-msg')).toBeNull();

    await click(button('Choose file…', dialog()!));
    await emit({ type: 'clientCertificateFile', role: 'pfx', problem: 'That file is larger than 1 MB.' });
    expect($('.cert-problem-msg')!.textContent).toBe('That file is larger than 1 MB.');

    await click(button('Choose file…', dialog()!));
    await click(button('Cancel', dialog()!));
    expect(dialog()).toBeNull();
    await emit({ type: 'clientCertificateFile', role: 'pfx', file: { token: 'late', name: 'late.p12' } });
    await click(button('Add client certificate…', $('.learned-banner')!));
    expect($('.cert-file-name')!.textContent).toBe('No file chosen');
  });

  it('a host that can\'t add certificates (error) unlocks the popup with the reason', async () => {
    await openDialog();
    await click(button('Choose file…', dialog()!));
    await emit({ type: 'error', message: 'Adding client certificates isn\'t available here.' });
    expect(button('Choose file…', dialog()!).disabled).toBe(false);
    expect($('.cert-problem-msg')!.textContent).toBe('Adding client certificates isn\'t available here.');
  });

  it('a save answered after the popup was closed becomes a notice', async () => {
    await openDialog();
    await click(button('Choose file…', dialog()!));
    await emit({ type: 'clientCertificateFile', role: 'pfx', file: { token: 't', name: 'c.p12' } });
    await click(button('Save', dialog()!));
    await click(button('Cancel', dialog()!));
    await emit({ type: 'clientCertificateSaved', host: 'mtls.example.com', problem: 'The key doesn\'t match the certificate.' });
    expect($('.notice')!.textContent).toMatch(/not saved: The key doesn't match the certificate\./);
  });
});

// ---------------------------------------------------------------- list

describe('client certificates + learned hosts list', () => {
  it('opens from the status line; Remove leaves the confirming to the IDE; Add… opens the popup with an empty host', async () => {
    await mount();
    await emit({ type: 'snapshot', exchanges: [], rules: [], status: { ...status, clientCertificates: [
      { host: 'api.corp.example' }, { host: '*.bank.example', problem: 'Could not read bank.p12: wrong passphrase' },
    ] } });
    const toggle = $('.statusline .cert-status')!;
    expect(toggle.tagName).toBe('BUTTON');
    await click(toggle);
    const panel = $('.certs-panel')!;
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    const items = $$('.certs-list li', panel);
    expect(items.map((li) => $('.certs-host', li)!.textContent)).toEqual(['api.corp.example', '*.bank.example']);
    expect(items[1].textContent).toContain('wrong passphrase');

    // REVIEW-14 #4: the host asks natively (no second, inline question); cancelled there = no Status change, nothing here.
    await click(button('Remove…', items[0]));
    expect($('[role="alertdialog"]', panel)).toBeNull();
    expect(lastOf('removeClientCertificate')).toEqual({ type: 'removeClientCertificate', host: 'api.corp.example' });
    expect($$('.certs-list li', $('.certs-panel')!)).toHaveLength(2);
    expect($('.host-error')).toBeNull();

    await click(button(/Add…/, panel));
    expect($<HTMLInputElement>('.cert-dialog input:not([type])')!.value).toBe('');

    await click(button('Cancel', dialog()!));
    await key($('.certs-panel')!, 'Escape');
    expect($('.certs-panel')).toBeNull();
    expect(document.activeElement).toBe($('.statusline .certs-toggle'));
  });

  it('learned hosts: host:port, reason in plain words, Forget / Add certificate… / Try all again', async () => {
    await mount();
    await emit({ type: 'snapshot', exchanges: [], rules: [], status: { ...status, learnedPassthrough: [
      { host: 'mtls.example.com', port: 8443, reason: 'client-certificate' },
      { host: 'pinned.example.com', port: 443, reason: 'pinned', until: Date.now() + 9 * 60_000 },
    ] } });
    const item = $('.statusline .learned-status')!;
    expect(item.textContent).toBe('Passed through: 2 hosts');
    await click(item);
    const rows = $$('.certs-list[aria-label="Passed through automatically"] li');
    expect(rows[0].textContent).toMatch(/mtls\.example\.com:8443needs the app's own certificate · until the proxy stops/);
    expect(rows[1].textContent).toMatch(/pinned\.example\.com:443the app doesn't accept the proxy's certificate · for (8m|9m)/);
    expect(maybeButton('Add certificate…', rows[1])).toBeUndefined();

    await click(button('Forget', rows[1]));
    expect(lastOf('forgetLearnedPassthrough')).toEqual({ type: 'forgetLearnedPassthrough', host: 'pinned.example.com', port: 443 });
    await click(button('Try all again'));
    expect(lastOf('forgetLearnedPassthrough')).toEqual({ type: 'forgetLearnedPassthrough' });

    await click(button('Add certificate…', rows[0]));
    expect($<HTMLInputElement>('.cert-dialog input:not([type])')!.value).toBe('mtls.example.com:8443');
  });

  it('expired pins are neither listed nor counted (the proxy sends no event when one expires)', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
    try {
      const t0 = Date.now();
      await mount();
      await act(() => {
        listener!({ type: 'snapshot', exchanges: [], rules: [], status: { ...status, learnedPassthrough: [
          { host: 'mtls.example.com', port: 443, reason: 'client-certificate' },
          { host: 'old.example.com', port: 443, reason: 'pinned', until: t0 - 1000 },
          { host: 'soon.example.com', port: 443, reason: 'pinned', until: t0 + 5000 },
        ] } });
        vi.advanceTimersByTime(1);
      });
      expect($('.statusline .learned-status')!.textContent).toBe('Passed through: 2 hosts');
      // The status line re-checks at the earliest end, with no message from the host.
      await act(() => { vi.advanceTimersByTime(5100); });
      expect($('.statusline .learned-status')!.textContent).toBe('Passed through: 1 host');
      await act(() => { $('.statusline .learned-status')!.click(); vi.advanceTimersByTime(1); });
      expect($$('.certs-list[aria-label="Passed through automatically"] li').map((li) => $('.certs-host', li)!.textContent))
        .toEqual(['mtls.example.com:443']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('the open list drops a pin when its time is up', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
    try {
      await mount();
      await act(() => {
        listener!({ type: 'snapshot', exchanges: [], rules: [], status: { ...status, learnedPassthrough: [
          { host: 'soon.example.com', port: 443, reason: 'pinned', until: Date.now() + 3000 },
        ] } });
        vi.advanceTimersByTime(1);
      });
      await act(() => { $('.statusline .learned-status')!.click(); vi.advanceTimersByTime(1); });
      expect($$('.certs-list[aria-label="Passed through automatically"] li')).toHaveLength(1);
      await act(() => { vi.advanceTimersByTime(3100); });
      expect($$('.certs-list[aria-label="Passed through automatically"] li')).toHaveLength(0);
      expect($('.statusline .learned-status')).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('nothing configured: a quiet entry point; the list says none yet', async () => {
    await mount();
    await emit({ type: 'snapshot', exchanges: [], rules: [], status });
    expect($('.statusline .learned-status')).toBeNull();
    await click(button('Client certificates…'));
    expect($('.certs-panel')!.textContent).toMatch(/None yet/);
  });
});
