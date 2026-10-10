import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import type { SessionWarning } from '../../src/ui/protocol';
import {
  connectWsTransport,
  createDapTransport,
  isLoopbackWsUri,
  toWsUri,
  type VmTransportEvent,
  type WebSocketLike,
} from '../../src/vm/transport';
import { createSessionWatcher } from '../../src/vm/watcher';

const fixture = <T>(name: string): T => JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'vm', name), 'utf8')) as T;

/** In-memory VM service speaking JSON-RPC over a fake WebSocket. */
class FakeWs implements WebSocketLike {
  static last: FakeWs | undefined;
  static refuse = false;
  static answers: Record<string, unknown> = {};
  readyState = 0;
  sent: { id: string; method: string; params: Record<string, unknown> }[] = [];
  onopen: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  onclose: ((ev: unknown) => void) | null = null;
  constructor(public url: string) {
    FakeWs.last = this;
    setTimeout(() => (FakeWs.refuse ? this.onerror?.({}) : ((this.readyState = 1), this.onopen?.({}))), 0);
  }
  send(data: string): void {
    const msg = JSON.parse(data) as { id: string; method: string; params: Record<string, unknown> };
    this.sent.push(msg);
    const a = FakeWs.answers[msg.method];
    const reply = a instanceof Error ? { jsonrpc: '2.0', id: msg.id, error: { code: 113, message: a.message } } : { jsonrpc: '2.0', id: msg.id, result: a ?? { type: 'Success' } };
    setTimeout(() => this.onmessage?.({ data: JSON.stringify(reply) }), 0);
  }
  push(event: unknown): void {
    this.onmessage?.({ data: JSON.stringify({ jsonrpc: '2.0', method: 'streamNotify', params: { streamId: 'Isolate', event } }) });
  }
  close(): void {
    this.readyState = 3;
    this.onclose?.({});
  }
}

beforeEach(() => {
  vi.useFakeTimers();
  FakeWs.last = undefined;
  FakeWs.refuse = false;
  FakeWs.answers = {};
});
afterEach(() => vi.useRealTimers());

describe('DAP transport', () => {
  it("calls Dart-Code's callService and maps dart.serviceExtensionAdded", async () => {
    const reqs: unknown[] = [];
    const t = createDapTransport(async (cmd, args) => {
      reqs.push([cmd, args]);
      return { type: 'VM', isolates: [] };
    });
    const events: VmTransportEvent[] = [];
    t.onEvent((e) => events.push(e));
    expect(await t.call('getVM')).toEqual({ type: 'VM', isolates: [] });
    await t.call('ext.dart.io.getHttpProfile', { isolateId: 'isolates/1' });
    expect(reqs).toEqual([
      ['callService', { method: 'getVM', params: {} }],
      ['callService', { method: 'ext.dart.io.getHttpProfile', params: { isolateId: 'isolates/1' } }],
    ]);
    t.handleCustomEvent('dart.serviceExtensionAdded', { extensionRPC: 'ext.dart.io.getVersion', isolateId: 'isolates/2' });
    t.handleCustomEvent('dart.serviceExtensionAdded', { extensionRPC: 3 });
    t.handleCustomEvent('dart.debuggerUris', { vmServiceUri: 'ws://127.0.0.1:1/x=/ws' });
    expect(events).toEqual([{ kind: 'extension-added', isolateId: 'isolates/2', rpc: 'ext.dart.io.getVersion' }]);
    t.close();
    expect(events.at(-1)).toEqual({ kind: 'closed' });
    await expect(t.call('getVM')).rejects.toThrow(/closed/);
  });
});

describe('WebSocket transport', () => {
  it('only loopback ws URIs', () => {
    expect(isLoopbackWsUri('ws://127.0.0.1:5000/abc=/ws')).toBe(true);
    expect(isLoopbackWsUri('ws://localhost:5000/ws')).toBe(true);
    expect(isLoopbackWsUri('ws://[::1]:5000/ws')).toBe(true);
    expect(isLoopbackWsUri('ws://10.0.0.5:5000/ws')).toBe(false);
    expect(isLoopbackWsUri('http://127.0.0.1:5000/')).toBe(false);
    expect(isLoopbackWsUri('not a uri')).toBe(false);
    expect(toWsUri('http://127.0.0.1:5000/tok=/')).toBe('ws://127.0.0.1:5000/tok=/ws');
    expect(toWsUri('ws://127.0.0.1:5000/tok=/ws')).toBe('ws://127.0.0.1:5000/tok=/ws');
  });

  it('subscribes to Isolate events and maps them (recorded events); JSON-RPC calls and errors', async () => {
    const p = connectWsTransport('ws://127.0.0.1:5000/tok=/ws', FakeWs);
    await vi.advanceTimersByTimeAsync(5);
    const t = await p;
    expect(FakeWs.last!.sent.map((m) => [m.method, m.params])).toEqual([['streamListen', { streamId: 'Isolate' }]]);
    const events: VmTransportEvent[] = [];
    t.onEvent((e) => events.push(e));
    for (const e of fixture<unknown[]>('ws-isolate-events.json')) FakeWs.last!.push(e);
    expect(events.filter((e) => e.kind === 'isolate-start').map((e) => (e as { name: string }).name)).toEqual(['demo_worker', 'demo_compute', 'demo_worker', 'demo_compute']);
    expect(events.some((e) => e.kind === 'extension-added' && e.rpc === 'ext.dart.io.httpEnableTimelineLogging')).toBe(true);
    expect(events.some((e) => e.kind === 'isolate-exit')).toBe(true);

    FakeWs.answers.getVM = { type: 'VM', isolates: [] };
    FakeWs.answers['ext.dart.io.getHttpProfile'] = new Error('Unrecognized isolate');
    const vm = expect(t.call('getVM')).resolves.toEqual({ type: 'VM', isolates: [] });
    const bad = expect(t.call('ext.dart.io.getHttpProfile', { isolateId: 'x' })).rejects.toThrow('Unrecognized isolate');
    await vi.advanceTimersByTimeAsync(5);
    await vm;
    await bad;

    const pending = expect(t.call('getVM')).rejects.toThrow(/closed/);
    FakeWs.last!.close();
    await pending;
    expect(events.at(-1)).toEqual({ kind: 'closed' });
  });

  it('rejects when the connection fails', async () => {
    FakeWs.refuse = true;
    const p = connectWsTransport('ws://127.0.0.1:5000/tok=/ws', FakeWs);
    const check = expect(p).rejects.toThrow(/connection failed/);
    await vi.advanceTimersByTimeAsync(5);
    await check;
  });
});

describe('session watcher (transport selection)', () => {
  const vmWithMain = { type: 'VM', isolates: [{ id: 'isolates/1', name: 'main', isSystemIsolate: false }] };
  function deps() {
    const warnings: [string, SessionWarning[]][] = [];
    const logs: string[] = [];
    return {
      warnings,
      logs,
      d: {
        record: () => ['x'],
        update: () => undefined,
        setWarnings: (sid: string, w: SessionWarning[]) => warnings.push([sid, w]),
        log: (m: string) => logs.push(m),
        nativeClients: () => 'off' as const,
        webSocket: FakeWs,
      },
    };
  }

  it("waits for dart.debuggerUris, then uses Dart-Code's callService (debug)", async () => {
    const { d, logs } = deps();
    const w = createSessionWatcher(d);
    const reqs: string[] = [];
    const request = async (_cmd: string, args: unknown) => {
      const m = (args as { method: string }).method;
      reqs.push(m);
      return m === 'getVM' ? vmWithMain : { name: 'main', extensionRPCs: [] };
    };
    w.sessionStarted('s1', request);
    await w.attach({ sessionId: 's1' });
    expect(reqs).toEqual([]);
    w.customEvent('s1', 'dart.debuggerUris', { vmServiceUri: 'ws://127.0.0.1:5000/tok=/ws' }, request);
    await vi.advanceTimersByTimeAsync(5);
    expect(reqs[0]).toBe('getVM');
    expect(FakeWs.last).toBeUndefined();
    expect(logs.join('\n')).toContain("watching via Dart-Code's debug adapter");
    expect(logs.join('\n')).not.toContain('tok=');
    w.dispose();
  });

  it('falls back to the VM service WebSocket when callService gives nothing (profile mode)', async () => {
    const { d, logs } = deps();
    const w = createSessionWatcher(d);
    const request = async () => undefined; // the Flutter DAP has no VM connection in profile mode
    w.sessionStarted('s2', request);
    w.customEvent('s2', 'dart.debuggerUris', { vmServiceUri: 'ws://127.0.0.1:5000/tok=/ws' }, request);
    FakeWs.answers.getVM = vmWithMain;
    FakeWs.answers.getIsolate = { name: 'main', extensionRPCs: [] };
    const attached = w.attach({ sessionId: 's2' });
    await vi.advanceTimersByTimeAsync(20);
    await attached;
    expect(FakeWs.last?.url).toBe('ws://127.0.0.1:5000/tok=/ws');
    expect(logs.join('\n')).toContain('watching via the VM service WebSocket');
    expect(logs.join('\n')).not.toContain('tok=');
    w.detach('s2');
    expect(FakeWs.last!.readyState).toBe(3);
  });

  it('never connects to a non-loopback VM service; degrades with one log line', async () => {
    const { d, logs } = deps();
    const w = createSessionWatcher(d);
    const request = async () => {
      throw new Error('unrecognized request');
    };
    w.customEvent('s3', 'dart.debuggerUris', { vmServiceUri: 'ws://192.0.2.10:5000/tok=/ws' }, request);
    const attached = w.attach({ sessionId: 's3' });
    await vi.advanceTimersByTimeAsync(20);
    await attached;
    expect(FakeWs.last).toBeUndefined();
    expect(logs.join('\n')).toContain('no VM service access');
    expect(logs.join('\n')).not.toContain('192.0.2.10');
  });

  it('starts on the first dart.serviceExtensionAdded when debuggerUris never came; clears warnings on detach / end', async () => {
    const { d, warnings } = deps();
    const w = createSessionWatcher(d);
    const request = async (_c: string, args: unknown) => {
      const m = (args as { method: string; params: { isolateId?: string } }).method;
      if (m === 'getVM') return vmWithMain;
      if (m === 'getIsolate') return (args as { params: { isolateId: string } }).params.isolateId === 'isolates/1' ? { name: 'main' } : { name: 'bg' };
      return {};
    };
    await w.attach({ sessionId: 's4' });
    w.customEvent('s4', 'dart.serviceExtensionAdded', { extensionRPC: 'ext.flutter.debugPaint', isolateId: 'isolates/1' }, request);
    await vi.advanceTimersByTimeAsync(5);
    w.customEvent('s4', 'dart.serviceExtensionAdded', { extensionRPC: 'ext.dart.io.httpEnableTimelineLogging', isolateId: 'isolates/2' }, request);
    await vi.advanceTimersByTimeAsync(5);
    expect(warnings.at(-1)).toEqual(['s4', [expect.objectContaining({ id: 'isolate:s4:bg', kind: 'background-isolate' })]]);
    w.sessionEnded('s4');
    expect(warnings.at(-1)).toEqual(['s4', []]);
  });

  it('a session that is never attached is never touched', async () => {
    const { d, warnings } = deps();
    const w = createSessionWatcher(d);
    const request = vi.fn(async () => vmWithMain);
    w.sessionStarted('s5', request);
    w.customEvent('s5', 'dart.debuggerUris', { vmServiceUri: 'ws://127.0.0.1:1/ws' }, request);
    await vi.advanceTimersByTimeAsync(5);
    expect(request).not.toHaveBeenCalled();
    w.sessionEnded('s5');
    expect(warnings).toEqual([]);
  });
});
