// v0.8.0 pure helpers (CONTRACTS §14): TLS passthrough tunnels, client certificates, upstream proxy source, upload
// throttling, WebSocket / SSE recordings.
import { describe, expect, it } from 'vitest';
import {
  clientCertSummary, clientCertTitle, compactBytes, fromVsCodeProxy, hostGlobMatch, isTunnel, matchingPassthrough, passthroughSummary,
  tunnelBytesShort, tunnelBytesText, tunnelTarget, tunnelTitle, upstreamLabel, upstreamTitle,
} from '../src/connection';
import { matchesFilter, parseFilter } from '../src/filter';
import { KIND_BADGE, kindTitle, hasFrames } from '../src/frames';
import { isExportable } from '../src/exporting';
import { interceptOff } from '../src/components/actions';
import { isRecordable, isStream, recordingCountText, recordingCounts, streamCountText } from '../src/scenarios';
import {
  checkThrottle, customProfile, describeAction, describeThrottle, newStep, profileDetails, profileLabel, throttleFieldsOf, validateActionFields,
} from '../src/state';
import type { Exchange, Frame } from '../src/protocol';
import { ex } from './fixtures';

const tunnel = (over: Partial<Exchange> = {}) => ex({
  method: 'CONNECT', url: 'https://pay.bank.example:443/', kind: 'tunnel', status: undefined, requestHeaders: {},
  responseHeaders: undefined, responseBody: undefined, tunnelBytes: { sent: 1229, received: 46_080 }, ...over,
});

describe('TLS passthrough tunnels (CONTRACTS §14.2)', () => {
  it('recognises tunnels and reads host:port', () => {
    expect(isTunnel(tunnel())).toBe(true);
    expect(isTunnel(ex())).toBe(false);
    expect(tunnelTarget(tunnel())).toEqual({ host: 'pay.bank.example', port: '443' });
    expect(tunnelTarget(tunnel({ url: 'https://pay.bank.example:8443/' }))).toEqual({ host: 'pay.bank.example', port: '8443' });
    expect(tunnelTarget({ url: 'pay.bank.example:9443' })).toEqual({ host: 'pay.bank.example', port: '9443' });
  });

  it('formats bytes sent / received', () => {
    expect(compactBytes(512)).toBe('512');
    expect(compactBytes(1229)).toBe('1.2k');
    expect(compactBytes(46_080)).toBe('45k');
    expect(compactBytes(3.4 * 1024 * 1024)).toBe('3.4M');
    expect(compactBytes(42 * 1024 * 1024)).toBe('42M');
    expect(tunnelBytesShort(tunnel())).toBe('↑1.2k ↓45k');
    expect(tunnelBytesShort(tunnel({ tunnelBytes: undefined }))).toBe('—');
    expect(tunnelBytesText(tunnel())).toBe('1.2 kB sent by the app · 45.0 kB received from the server (encrypted)');
    expect(tunnelBytesText(tunnel({ tunnelBytes: undefined, state: 'pending' }))).toMatch(/not.*yet|No bytes counted yet/);
  });

  it('badge and tooltip say "not decrypted" and name the setting', () => {
    expect(KIND_BADGE.tunnel).toBe('TLS');
    const t = kindTitle(tunnel({ state: 'pending' }));
    expect(t).toContain('TLS passthrough — not decrypted');
    expect(t).toContain('pay.bank.example:443');
    expect(t).toContain('flutterIntercept.tlsPassthrough');
    expect(t).toContain('open');
    expect(tunnelTitle(tunnel())).toContain('1.2 kB sent by the app');
    expect(hasFrames(tunnel())).toBe(false);
  });

  it('host globs: * spans any characters, case-insensitive, optional :port', () => {
    expect(hostGlobMatch('*.bank.example', 'pay.bank.example')).toBe(true);
    expect(hostGlobMatch('*.bank.example', 'bank.example')).toBe(false);
    expect(hostGlobMatch('PAY.bank.example', 'pay.BANK.example')).toBe(true);
    expect(hostGlobMatch('pay.bank.example:8443', 'pay.bank.example', '443')).toBe(false);
    expect(hostGlobMatch('pay.bank.example:8443', 'pay.bank.example', '8443')).toBe(true);
    expect(hostGlobMatch('a+b.example', 'aab.example')).toBe(false); // regex characters are literal
    expect(hostGlobMatch('', 'x')).toBe(false);
    expect(matchingPassthrough(tunnel(), ['api.example.com', '*.bank.example'])).toBe('*.bank.example');
    expect(matchingPassthrough(tunnel(), ['api.example.com'])).toBeUndefined();
    expect(matchingPassthrough(tunnel(), undefined)).toBeUndefined();
  });

  it('filter kind:tunnel (prefix, alias, negation); kind:http excludes tunnels', () => {
    const list = [tunnel({ id: 't' }), ex({ id: 'h' }), ex({ id: 'w', kind: 'websocket' })];
    const ids = (q: string) => list.filter((e) => matchesFilter(e, parseFilter(q))).map((e) => e.id);
    expect(ids('kind:tunnel')).toEqual(['t']);
    expect(ids('kind:tun')).toEqual(['t']);
    expect(ids('kind:passthrough')).toEqual(['t']);
    expect(ids('-kind:tunnel')).toEqual(['h', 'w']);
    expect(ids('kind:http')).toEqual(['h']);
    expect(ids('kind:ws,tunnel')).toEqual(['t', 'w']);
    expect(parseFilter('kind:nope').errors[0]).toMatch(/tunnel/);
  });

  it('only Block is allowed; tunnels are never exported or recorded', () => {
    const off = interceptOff(tunnel());
    expect(off.block).toBeUndefined();
    for (const k of ['mock', 'breakpoint', 'edit', 'generate', 'copy', 'expire'] as const) expect(off[k]).toMatch(/not decrypted/);
    expect(interceptOff(ex()).copy).toBeUndefined();
    expect(isExportable(tunnel())).toBe(false);
    expect(isRecordable(tunnel())).toBe(false);
  });

  it('status summary lists the passthrough hosts', () => {
    expect(passthroughSummary(undefined)).toBeUndefined();
    expect(passthroughSummary([])).toBeUndefined();
    const s = passthroughSummary(['*.bank.example', 'pinned.example.com'])!;
    expect(s.text).toBe('TLS passthrough: 2 hosts');
    expect(s.title).toContain('• *.bank.example\n• pinned.example.com');
    expect(s.title).toContain('flutterIntercept.tlsPassthrough');
    expect(passthroughSummary(['a.example'])!.text).toBe('TLS passthrough: 1 host');
  });
});

describe('client certificates (CONTRACTS §14.3)', () => {
  it('summarises host patterns and highlights problems', () => {
    expect(clientCertSummary(undefined)).toBeUndefined();
    const ok = clientCertSummary([{ host: 'api.corp.example' }])!;
    expect(ok).toMatchObject({ text: 'Client certificate: 1', problems: 0 });
    expect(ok.title).toContain('• api.corp.example');
    expect(ok.title).not.toMatch(/passphrase/i);
    const bad = clientCertSummary([{ host: 'api.corp.example' }, { host: '*.bank.example:8443', problem: 'wrong passphrase' }])!;
    expect(bad).toMatchObject({ text: 'Client certificates: 1 problem', problems: 1 });
    expect(bad.title).toContain('✕ *.bank.example:8443 — wrong passphrase');
    expect(bad.title).toContain('Set Client Certificate Passphrase');
    expect(clientCertTitle('api.corp.example')).toContain('“api.corp.example”');
    expect(clientCertTitle('api.corp.example')).toContain('never leaves the proxy');
  });
});

describe('upstream proxy source (CONTRACTS §14.6)', () => {
  it('names VS Code\'s http.proxy when that is the source', () => {
    expect(fromVsCodeProxy({ upstreamProxySource: 'http.proxy' })).toBe(true);
    expect(fromVsCodeProxy({})).toBe(false);
    expect(upstreamLabel({ upstreamProxy: 'proxy.corp:3128', upstreamProxySource: 'http.proxy' })).toBe('via VS Code proxy proxy.corp:3128');
    expect(upstreamLabel({ upstreamProxy: '127.0.0.1:8888', upstreamProxySource: 'flutterIntercept' })).toBe('via upstream proxy 127.0.0.1:8888');
    expect(upstreamLabel({ upstreamProxy: '127.0.0.1:8888' })).toBe('via upstream proxy 127.0.0.1:8888');
    expect(upstreamTitle({ upstreamProxy: 'proxy.corp:3128', upstreamProxySource: 'http.proxy' })).toMatch(/http\.proxy.*http\.noProxy/s);
    expect(upstreamTitle({ upstreamProxy: '127.0.0.1:8888' })).toContain('flutterIntercept.upstreamProxy');
  });
});

describe('upload throttling (CONTRACTS §14.4)', () => {
  it('validates and builds uploadKbps', () => {
    expect(checkThrottle({ latencyMs: '', kbps: '', dropPct: '', uploadKbps: '200' })).toEqual({ errors: {}, value: { uploadKbps: 200 } });
    expect(checkThrottle({ latencyMs: '', kbps: '', dropPct: '', uploadKbps: '0' }).errors.uploadKbps).toMatch(/1–1000000/);
    expect(checkThrottle({ latencyMs: '', kbps: '', dropPct: '', uploadKbps: 'x' }).errors.uploadKbps).toBeDefined();
    // Drafts from before 0.8.0 have no uploadKbps.
    expect(checkThrottle({ latencyMs: '100', kbps: '', dropPct: '' })).toEqual({ errors: {}, value: { latencyMs: 100 } });
    expect(customProfile({ latencyMs: '300', kbps: '800', dropPct: '', uploadKbps: '200' }))
      .toEqual({ kind: 'throttle', latencyMs: 300, kbps: 800, uploadKbps: 200 });
    expect(throttleFieldsOf({ kbps: 800, uploadKbps: 200 })).toEqual({ latencyMs: '', kbps: '800', dropPct: '', uploadKbps: '200' });
    expect(throttleFieldsOf({ kbps: 800 })).toEqual({ latencyMs: '', kbps: '800', dropPct: '' });
  });

  it('shows upload in descriptions', () => {
    expect(describeThrottle({ latencyMs: 300, kbps: 800, uploadKbps: 200, dropRate: 0.05 })).toBe('+300 ms, 800 kbps down / 200 up, 5% fail');
    expect(describeThrottle({ uploadKbps: 200 })).toBe('200 kbps up');
    expect(describeThrottle({ kbps: 800 })).toBe('800 kbps');
    expect(describeThrottle({})).toBe('No throttling');
    expect(profileLabel({ kind: 'throttle', latencyMs: 300, kbps: 800, uploadKbps: 200 })).toBe('+300 ms, 800 kbps down / 200 up');
    // Presets keep their name; the details carry the numbers (upload once the preset has one).
    expect(profileLabel({ kind: 'throttle', preset: 'slow-3g', latencyMs: 400, kbps: 400, uploadKbps: 400 })).toBe('Slow 3G');
    expect(profileDetails({ kind: 'throttle', preset: 'fast-3g', latencyMs: 150, kbps: 1600, uploadKbps: 750 })).toBe('+150 ms, 1600 kbps down / 750 up');
    expect(profileDetails({ kind: 'offline' })).toBe('Offline');
    expect(describeAction({ kind: 'throttle', latencyMs: 400, kbps: 400, uploadKbps: 100 })).toBe('Throttle (+400 ms, 400 kbps down / 100 up)');
  });

  it('rule form reports an invalid upload field', () => {
    const f = newStep('throttle');
    const v = validateActionFields('throttle', { ...f, throttle: { latencyMs: '', kbps: '', dropPct: '', uploadKbps: '-1' } });
    expect(v.errors.uploadKbps).toMatch(/Upload/);
  });
});

describe('WebSocket / SSE recordings (CONTRACTS §14.5)', () => {
  const frames = (n: number): Frame[] => Array.from({ length: n }, (_, i) => ({ dir: 'receive', at: i, kind: 'text', text: 'x', size: 1 }));
  it('counts streams and their frames', () => {
    expect(isStream({ kind: 'websocket' })).toBe(true);
    expect(isStream({ kind: 'sse' })).toBe(true);
    expect(isStream({ kind: 'tunnel' })).toBe(false);
    expect(isStream({})).toBe(false);
    const c = recordingCounts([ex(), ex({ kind: 'websocket', frames: frames(12) }), ex({ kind: 'sse', frames: frames(3), framesDropped: 10 })]);
    expect(c).toEqual({ exchanges: 3, streams: 2, frames: 15 });
    expect(streamCountText(c)).toBe('2 WebSocket / SSE · 15 frames');
    expect(streamCountText({ streams: 0 })).toBe('');
    expect(streamCountText({ streams: 1 })).toBe('1 WebSocket / SSE');
  });

  it('recording rows show stream counts when the host reports them', () => {
    const base = { id: 'r', name: 'R', createdAt: 0, exchanges: 42, redacted: false };
    expect(recordingCountText(base)).toBe('42 exchanges');
    expect(recordingCountText({ ...base, streams: 2, frames: 134 })).toBe('42 exchanges · 2 WebSocket / SSE · 134 frames');
    expect(recordingCountText({ ...base, exchanges: 1, streams: 1, frames: 1 })).toBe('1 exchange · 1 WebSocket / SSE · 1 frame');
  });
});
