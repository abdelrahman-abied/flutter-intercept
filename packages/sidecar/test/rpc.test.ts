import { PassThrough } from 'stream';
import { describe, expect, it } from 'vitest';
import { RpcFailure, RpcPeer } from '../src/rpc';

function setup(onRequest: (m: string, p: unknown) => unknown = () => null, opts: { maxLineBytes?: number; requestTimeoutMs?: number } = {}) {
  const input = new PassThrough();
  const output = new PassThrough();
  const out: unknown[] = [];
  let pending = '';
  output.on('data', (c: Buffer) => {
    pending += c.toString('utf8');
    let nl: number;
    while ((nl = pending.indexOf('\n')) >= 0) {
      out.push(JSON.parse(pending.slice(0, nl)));
      pending = pending.slice(nl + 1);
    }
  });
  const logs: string[] = [];
  let closed = 0;
  const peer = new RpcPeer({ input, output, onRequest, log: (l) => logs.push(l), onClose: () => closed++, ...opts });
  const tick = () => new Promise((r) => setTimeout(r, 10));
  return { input, output, out, logs, peer, tick, closed: () => closed };
}

describe('RpcPeer framing', () => {
  it('answers requests split across chunks, with CRLF and blank lines', async () => {
    const t = setup((m, p) => ({ echo: m, p }));
    t.input.write('\n{"id":1,"meth');
    t.input.write('od":"ping","params":{"a":1}}\r\n\n{"id":2,"method":"pong"}\n');
    await t.tick();
    expect(t.out).toEqual([
      { id: 1, result: { echo: 'ping', p: { a: 1 } } },
      { id: 2, result: { echo: 'pong' } },
    ]);
  });

  it('turns handler errors into error responses, keeping RpcFailure codes', async () => {
    const t = setup((m) => {
      if (m === 'a') throw new RpcFailure('nope', 'invalid');
      throw new Error('boom');
    });
    t.input.write('{"id":1,"method":"a"}\n{"id":2,"method":"b"}\n');
    await t.tick();
    expect(t.out).toEqual([
      { id: 1, error: { message: 'nope', code: 'invalid' } },
      { id: 2, error: { message: 'boom' } },
    ]);
  });

  it('ignores non-JSON lines, non-objects and requests without an id, without logging their content', async () => {
    const t = setup(() => 'ok');
    t.input.write('not json secret-token-123\n[1,2]\n{"method":"x"}\n{"id":5,"method":"y"}\n');
    await t.tick();
    expect(t.out).toEqual([{ id: 5, result: 'ok' }]);
    expect(t.logs.join('\n')).not.toContain('secret-token-123');
    expect(t.logs).toHaveLength(3);
  });

  it('drops over-long lines (also across chunks) and recovers at the next newline', async () => {
    const t = setup(() => 'ok', { maxLineBytes: 64 });
    t.input.write(`{"id":1,"method":"x","params":"${'a'.repeat(40)}`);
    t.input.write(`${'b'.repeat(40)}"}\n{"id":2,"method":"y"}\n`);
    t.input.write(`${'c'.repeat(100)}\n{"id":3,"method":"z"}\n`);
    await t.tick();
    expect(t.out).toEqual([
      { id: 2, result: 'ok' },
      { id: 3, result: 'ok' },
    ]);
    expect(t.logs.filter((l) => l.includes('longer than'))).toHaveLength(2);
  });

  it('sends requests with negative ids and resolves / rejects on the answers', async () => {
    const t = setup();
    const a = t.peer.request('ui.pick', { items: [] });
    const b = t.peer.request('ui.save', { defaultPath: '/x' });
    await t.tick();
    expect(t.out).toEqual([
      { id: -1, method: 'ui.pick', params: { items: [] } },
      { id: -2, method: 'ui.save', params: { defaultPath: '/x' } },
    ]);
    t.input.write('{"id":-2,"error":{"message":"cancelled","code":"x"}}\n{"id":-99,"result":1}\n{"id":-1,"result":"v"}\n');
    await expect(a).resolves.toBe('v');
    await expect(b).rejects.toMatchObject({ message: 'cancelled', code: 'x' });
  });

  it('times out requests when asked to', async () => {
    const t = setup(undefined, { requestTimeoutMs: 20 });
    await expect(t.peer.request('ui.confirm')).rejects.toMatchObject({ code: 'timeout' });
  });

  it('emits events and closes once when stdin ends, rejecting pending requests', async () => {
    const t = setup();
    t.peer.event('status', { enabled: true });
    const p = t.peer.request('ui.notify', {});
    await t.tick();
    t.input.end();
    await expect(p).rejects.toMatchObject({ code: 'closed' });
    await t.tick();
    expect(t.closed()).toBe(1);
    expect(t.out[0]).toEqual({ event: 'status', data: { enabled: true } });
    await expect(t.peer.request('x')).rejects.toMatchObject({ code: 'closed' });
  });
});
