// CONTRACTS §17.6 (v0.11.0) agent side: grpcPause in list_paused / get_request (decoded, redacted), resume_request grpc
// (messageJson with redacted values restored, message, drop, status + trailers; refusals keep the call paused),
// save_recording / list_recordings with gRPC calls, confirmation texts.
import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Exchange, Rule } from '@flutter-intercept/proxy';
import { createAgentApi, type AgentApiDeps } from '../../../src/agent/api';
import { confirmationText } from '../../../src/agent/lmTools';
import { AgentToolError, type AppLauncher } from '../../../src/agent/types';
import { createRecordingService } from '../../../src/recordings/store';
import { validateRules } from '../../../src/ui/controller';
import { fakeGrpc, grpcCall, pb64 } from '../grpc.fakes';

class FakeHost extends EventEmitter {
  running = true;
  port: number | undefined = 8899;
  exchanges: Exchange[] = [];
  rules: Rule[] = [];
  resumed: unknown[][] = [];
  getExchanges() {
    return this.exchanges.map((e) => ({ ...e }));
  }
  getRules() {
    return this.rules;
  }
  resume(id: string, edit?: unknown) {
    this.resumed.push([id, edit]);
  }
  abort() {}
}

const roots: string[] = [];
afterEach(() => {
  for (const r of roots.splice(0)) fs.rmSync(r, { recursive: true, force: true });
});

function setup(o: { redact?: boolean; recordings?: boolean } = {}) {
  const host = new FakeHost();
  const launcher = { launch: vi.fn(), stop: vi.fn(), hotRestart: vi.fn(), sessions: () => [] } as unknown as AppLauncher;
  const grpc = fakeGrpc();
  let root = '/ws/app';
  if (o.recordings) {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fi-arec-')));
    roots.push(root);
  }
  const deps: AgentApiDeps = {
    host: host as unknown as AgentApiDeps['host'],
    applyRules: (rules) => {
      host.rules = validateRules(rules);
    },
    clear: () => undefined,
    getSettings: () => ({ access: 'readWrite', redactSecrets: o.redact ?? true, interceptEnabled: true }),
    launcher,
    projectRoot: () => root,
    newRuleId: () => 'agent_1',
    now: () => 50_000,
    grpc,
    ...(o.recordings ? { recordings: createRecordingService({ root: () => root, grpc }) } : {}),
  };
  return { api: createAgentApi(deps), host, root };
}

const rejectsWith = async (p: Promise<unknown>, re: RegExp, code?: AgentToolError['code']) => {
  const e = await p.then(
    () => undefined,
    (err: unknown) => err,
  );
  expect(e).toBeInstanceOf(AgentToolError);
  expect((e as Error).message).toMatch(re);
  if (code) expect((e as AgentToolError).code).toBe(code);
};

const held = (over: Partial<Exchange> = {}) =>
  grpcCall({
    id: 'p',
    state: 'paused-response',
    pausedAt: 6000,
    pauseDeadline: 9000,
    grpcPause: { kind: 'message', dir: 'receive', index: 0, base64: pb64({ total: '1', sessionToken: 'tok-777' }), size: 40 },
    ...over,
  });

describe('grpcPause for agents (CONTRACTS §17.6)', () => {
  it('list_paused and get_request show the held message decoded and redacted, never its bytes', async () => {
    const { api, host } = setup();
    host.exchanges = [held()];
    const items = ((await api.call('list_paused', {})) as any).items;
    expect(items[0]).toMatchObject({ id: 'p', phase: 'response', grpcPause: { kind: 'message', dir: 'receive', index: 0, size: 40, via: 'schema', json: { total: '1', sessionToken: '[redacted]' } } });
    const text = JSON.stringify(await api.call('get_request', { id: 'p' }));
    expect(text).not.toContain('tok-777');
    expect(text).not.toContain(pb64({ total: '1', sessionToken: 'tok-777' }));
    expect(JSON.parse(text).grpcPause.kind).toBe('message');
  });

  it('a held status shows its code name and redacted trailers', async () => {
    const { api, host } = setup();
    host.exchanges = [held({ grpcPause: { kind: 'status', code: 16, message: 'token eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.sig bad', trailers: { 'set-cookie': 'sid=1', 'x-a': '1' } } })];
    const items = ((await api.call('list_paused', {})) as any).items;
    expect(items[0].grpcPause).toEqual({ kind: 'status', code: 16, status: 'UNAUTHENTICATED', message: 'token [redacted] bad', trailers: { 'set-cookie': '[redacted]', 'x-a': '1' } });
  });
});

describe('resume_request grpc (CONTRACTS §17.6)', () => {
  it('messageJson: "[redacted]" values keep the original; the rest is encoded as the held direction\'s type', async () => {
    const { api, host } = setup();
    host.exchanges = [held({ state: 'paused-request', grpcPause: { kind: 'message', dir: 'send', index: 0, base64: pb64({ sku: 'A1', sessionToken: 'tok-777' }), size: 40 } })];
    const r = await api.call('resume_request', { id: 'p', grpc: { messageJson: { sku: 'B2', sessionToken: '[redacted]' } } });
    expect(r).toEqual({ resumed: true, edited: true });
    expect(host.resumed).toEqual([['p', { message: pb64({ sku: 'B2', sessionToken: 'tok-777' }) }]]);
  });

  it('message / drop / status edits pass through validated', async () => {
    const { api, host } = setup();
    host.exchanges = [held()];
    expect(await api.call('resume_request', { id: 'p', grpc: { drop: true } })).toEqual({ resumed: true, dropped: true });
    expect(await api.call('resume_request', { id: 'p', grpc: { message: 'AA==' } })).toEqual({ resumed: true, edited: true });
    expect(await api.call('resume_request', { id: 'p' })).toEqual({ resumed: true });
    host.exchanges = [held({ grpcPause: { kind: 'status', code: 0, trailers: {} } })];
    expect(await api.call('resume_request', { id: 'p', grpc: { status: { code: 14, message: 'down' }, trailers: { 'x-b': '2' } } })).toEqual({ resumed: true, status: 14 });
    expect(host.resumed.map((x) => x[1])).toEqual([{ drop: true }, { message: 'AA==' }, undefined, { status: { code: 14, message: 'down' }, trailers: { 'x-b': '2' } }]);
  });

  it('refusals keep the call paused', async () => {
    const { api, host } = setup();
    host.exchanges = [held(), { id: 'h', startedAt: 1, method: 'GET', url: 'https://api.example.com/x', requestHeaders: {}, state: 'paused-response', status: 200 }];
    await rejectsWith(api.call('resume_request', { id: 'p', grpc: { messageJson: { nope: 1 } } }), /\$\.nope.*stays paused/, 'invalid');
    await rejectsWith(api.call('resume_request', { id: 'p', grpc: { drop: true, message: 'AA==' } }), /exactly one/, 'invalid');
    await rejectsWith(api.call('resume_request', { id: 'p', grpc: { status: { code: 3 } } }), /held at its end/, 'invalid');
    await rejectsWith(api.call('resume_request', { id: 'p', edit: { status: 500 } }), /paused gRPC call: pass grpc/, 'invalid');
    await rejectsWith(api.call('resume_request', { id: 'h', grpc: { drop: true } }), /not a paused gRPC call/, 'invalid');
    await rejectsWith(api.call('resume_request', { id: 'p', grpc: { status: { code: 99 } } }), /invalid input/, 'invalid');
    expect(host.resumed).toEqual([]);
  });

  it('the confirmation names the gRPC action', () => {
    expect(confirmationText('resume_request', { id: 'p', grpc: { drop: true } }).message).toMatch(/\*\*drop\*\* the held message/);
    expect(confirmationText('resume_request', { id: 'p', grpc: { status: { code: 14, message: 'x' } } }).message).toMatch(/status \*\*14 \(UNAVAILABLE\)\*\* and message `x`/);
    expect(confirmationText('resume_request', { id: 'p', grpc: { status: { code: '**x**' } } }).message).toMatch(/invalid code `\*\*x\*\*`/);
    expect(confirmationText('resume_request', { id: 'p', grpc: { messageJson: { a: 1 } } }).title).toBe('Resume a paused gRPC call');
  });
});

describe('recordings tools with gRPC (CONTRACTS §17.4)', () => {
  it('save_recording keeps gRPC calls (redacted by default), list_recordings counts them', async () => {
    const { api, host, root } = setup({ recordings: true });
    host.exchanges = [grpcCall({ id: 'g' }), grpcCall({ id: 'open', state: 'pending', grpc: { service: 's', method: 'm', messagesSent: 0, messagesReceived: 0 } })];
    const saved = (await api.call('save_recording', { name: 'cart' })) as any;
    expect(saved).toMatchObject({ exchanges: 1, grpc: 1, redacted: true });
    const file = fs.readFileSync(path.join(root, saved.path), 'utf8');
    expect(file).not.toContain('tok-123');
    expect(((await api.call('list_recordings', {})) as any).recordings[0]).toMatchObject({ grpc: 1 });
  });
});
