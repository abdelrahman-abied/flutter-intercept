import { describe, expect, it, vi } from 'vitest';

const { listeners, disposed, on } = vi.hoisted(() => {
  const listeners: Record<string, ((e: unknown) => void)[]> = { start: [], custom: [], end: [] };
  const disposed: string[] = [];
  const on = (kind: string) => (l: (e: unknown) => void) => {
    listeners[kind].push(l);
    return { dispose: () => disposed.push(kind) };
  };
  return { listeners, disposed, on };
});

vi.mock('vscode', () => ({
  debug: {
    onDidStartDebugSession: on('start'),
    onDidReceiveDebugSessionCustomEvent: on('custom'),
    onDidTerminateDebugSession: on('end'),
  },
}));

import { createVmWatcher } from '../../src/vm/index';

describe('createVmWatcher (vscode wiring)', () => {
  it('feeds Dart sessions and their custom events to the watcher; disposes its listeners', async () => {
    const warnings: unknown[] = [];
    const w = createVmWatcher({
      record: () => [],
      update: () => undefined,
      setWarnings: (sid, ws) => warnings.push([sid, ws]),
      log: () => undefined,
      nativeClients: () => 'off',
      webSocket: null,
    });
    const calls: unknown[] = [];
    const session = {
      id: 'S',
      type: 'dart',
      customRequest: async (cmd: string, args: { method: string }) => {
        calls.push([cmd, args.method]);
        if (args.method === 'getVM') return { isolates: [{ id: 'isolates/1', name: 'main' }] };
        return { name: args.method === 'getIsolate' ? 'worker' : undefined };
      },
    };
    const other = { id: 'N', type: 'node', customRequest: vi.fn() };
    listeners.start.forEach((l) => l(other));
    listeners.start.forEach((l) => l(session));
    await w.attach({ sessionId: 'S' });
    expect(calls).toEqual([]);
    listeners.custom.forEach((l) => l({ session, event: 'dart.debuggerUris', body: { vmServiceUri: 'ws://127.0.0.1:1/t=/ws' } }));
    await new Promise((r) => setTimeout(r, 10));
    expect(calls[0]).toEqual(['callService', 'getVM']);
    listeners.custom.forEach((l) => l({ session, event: 'dart.serviceExtensionAdded', body: { extensionRPC: 'ext.dart.io.httpEnableTimelineLogging', isolateId: 'isolates/2' } }));
    await new Promise((r) => setTimeout(r, 10));
    expect(warnings.at(-1)).toEqual(['S', [expect.objectContaining({ kind: 'background-isolate', id: 'isolate:S:worker' })]]);
    listeners.end.forEach((l) => l(session));
    expect(warnings.at(-1)).toEqual(['S', []]);
    w.dispose();
    expect(disposed.sort()).toEqual(['custom', 'end', 'start']);
    expect(other.customRequest).not.toHaveBeenCalled();
  });
});
