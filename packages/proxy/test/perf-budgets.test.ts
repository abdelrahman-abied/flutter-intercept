// PERF-1 §5: the machine-independent budgets (structural checks and ratios, no absolute times).
import type * as http2 from 'http2';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { Exchange, InterceptProxy } from '../src';
import { messageFrame } from '../src/grpc';
import { frameCost, materializeFrame, RAW_PAYLOAD } from '../src/frames';
import { nextExchange, startProxy } from './helpers';
import { grpcCall, h2cSession, startGrpcServer, type GrpcServer } from './grpc-helpers';
import { bestOfMs } from './timing';

/** Counts Buffer → base64 encodings while `fn` runs. */
async function countBase64<T>(fn: () => Promise<T>): Promise<{ result: T; encodes: number }> {
  const original = Buffer.prototype.toString;
  let encodes = 0;
  Buffer.prototype.toString = function (this: Buffer, ...args: unknown[]) {
    if (args[0] === 'base64') encodes++;
    return (original as (...a: unknown[]) => string).apply(this, args);
  } as typeof original;
  try {
    return { result: await fn(), encodes };
  } finally {
    Buffer.prototype.toString = original;
  }
}

describe('PERF-1 budgets', () => {
  it('#3 a lazy gRPC frame keeps the raw bytes, counts its base64 size, and encodes only when materialized', () => {
    const data = Buffer.from('hello gRPC');
    const eager = messageFrame('send', { compressed: false, size: data.length, kept: data, complete: true }, 1);
    const lazy = messageFrame('send', { compressed: false, size: data.length, kept: data, complete: true }, 1, true);
    expect(lazy.base64).toBeUndefined();
    expect((lazy as unknown as Record<symbol, unknown>)[RAW_PAYLOAD]).toBeDefined();
    expect(frameCost(lazy)).toBe(frameCost(eager));
    const out = materializeFrame(lazy);
    expect(out).toEqual(eager);
    expect((out as unknown as Record<symbol, unknown>)[RAW_PAYLOAD]).toBeUndefined();
  });

  describe('through the relay', () => {
    let up: GrpcServer;
    let proxy: InterceptProxy;
    let session: http2.ClientHttp2Session;
    beforeAll(async () => {
      up = await startGrpcServer();
    });
    afterAll(async () => {
      await up.close();
    });
    afterEach(async () => {
      session?.destroy();
      await proxy?.stop();
    });

    it('#3 / B2: streamed messages are not base64-encoded one by one (only the kept frames, at snapshot)', async () => {
      proxy = await startProxy({ maxFramesPerExchange: 20 });
      session = await h2cSession(proxy.port, `127.0.0.1:${up.port}`);
      const messages = Array.from({ length: 2000 }, (_, i) => `m${i}`);
      const done = nextExchange(proxy, (e: Exchange) => e.url.endsWith('/t.Echo/ClientStream') && e.state === 'completed', 10_000);
      const { result, encodes } = await countBase64(async () => {
        const r = await grpcCall(session, '/t.Echo/ClientStream', messages);
        await done;
        return r;
      });
      expect(result.messages.length).toBe(1);
      const ex = await done;
      expect(ex.grpc?.messagesSent).toBe(2000);
      expect(ex.frames?.length).toBeLessThanOrEqual(20);
      // Before PERF-1 #3: at least one encode per message (2000+). Now: the kept frames of each snapshot.
      expect(encodes).toBeLessThan(messages.length / 4);
    });
  });

  it('#2 / B4: a full store of 10 000 costs about the same per new exchange as one of 1000 (evict is O(1))', async () => {
    const perRecord = async (maxExchanges: number): Promise<number> => {
      const p = await startProxy({ maxExchanges });
      try {
        for (let i = 0; i < maxExchanges; i++) p.record({ method: 'GET', url: `https://fill.example/${i}` } as Omit<Exchange, 'id'>);
        let n = 0;
        return bestOfMs(() => {
          for (let i = 0; i < 2000; i++) p.record({ method: 'GET', url: `https://more.example/${n++}` } as Omit<Exchange, 'id'>);
        }, 5);
      } finally {
        await p.stop();
      }
    };
    const small = await perRecord(1000);
    const large = await perRecord(10_000);
    // Copying the keys on every eviction made this ~10x; noise stays well under 2.5x.
    expect(large / small).toBeLessThan(2.5);
  }, 60_000);
});
