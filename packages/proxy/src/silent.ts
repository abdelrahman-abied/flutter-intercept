import * as http2 from 'http2';
import type * as net from 'net';
import { CallbackStep } from 'mockttp/dist/rules/requests/request-step-definitions';
import { StepLookup } from 'mockttp/dist/rules/requests/request-step-impls';

/*
 * Silent tunnels into mockttp (CONTRACTS §16.2, docs/spikes/grpc.md). A silent CONNECT gets no reply; its socket is
 * handed to mockttp exactly the way mockttp's own handleH1Connect does after writing "200" (http-combo-server.js):
 * the socket-extension Symbols set (same module instance as mockttp's), the bytes already read put back, then
 * `connection` emitted on the combo server, whose protocol sniffing sees the h2c preface or the TLS ClientHello.
 *
 * Everything here leans on mockttp internals (pinned ~4.6.3), so a startup self-check verifies them; when it fails,
 * silent tunnels become plain passthrough tunnels and the problem is reported (grpcSupport()).
 */

export interface GrpcSupport {
  ok: boolean;
  problem?: string;
}

/** Test seam: pretend the self-check failed with this problem. Never set outside tests. */
export const grpcTesting: { forceProblem?: string } = {};

interface SocketExtensions {
  SocketTimingInfo: symbol;
  LastTunnelAddress: symbol;
  LastHopEncrypted: symbol;
}

let ext: SocketExtensions | undefined | null;
function extensions(): SocketExtensions | undefined {
  if (ext === undefined) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const m = require('mockttp/dist/util/socket-extensions') as Partial<SocketExtensions>;
      ext = typeof m.SocketTimingInfo === 'symbol' && typeof m.LastTunnelAddress === 'symbol' && typeof m.LastHopEncrypted === 'symbol' ? (m as SocketExtensions) : null;
    } catch {
      ext = null;
    }
  }
  return ext ?? undefined;
}

/** A step definition whose own `handle` mockttp keeps when it builds the step (the replayStreamStep trick). */
function ownHandleKept(): boolean {
  try {
    const marker = async () => undefined;
    const def = Object.assign(new CallbackStep(() => ({ statusCode: 500 })), { handle: marker });
    const lookup = StepLookup as unknown as Record<string, { fromDefinition(d: unknown): { handle?: unknown } }>;
    const impl = lookup[(def as unknown as { type: string }).type]?.fromDefinition(def);
    return impl?.handle === marker;
  } catch {
    return false;
  }
}

/** The mockttp / node internals the gRPC relay and silent tunnels use. `connectHook`: our CONNECT takeover is installed. */
export function grpcSelfCheck(state: { connectHook?: boolean; server?: unknown } = {}): GrpcSupport {
  if (grpcTesting.forceProblem) return { ok: false, problem: grpcTesting.forceProblem };
  const missing: string[] = [];
  if (!extensions()) missing.push('socket extensions');
  if (!ownHandleKept()) missing.push('custom request steps');
  const res = (http2 as unknown as { Http2ServerResponse?: { prototype: object } }).Http2ServerResponse?.prototype;
  if (!res || !Object.getOwnPropertyDescriptor(res, 'stream')) missing.push('HTTP/2 compatibility response');
  if (state.server !== undefined && !state.server) missing.push('combo server');
  if (state.connectHook === false) missing.push('CONNECT hook');
  if (!missing.length) return { ok: true };
  return {
    ok: false,
    problem: `gRPC interception is unavailable with this mockttp version (missing: ${missing.join(', ')}); gRPC connections are passed through undecrypted.`,
  };
}

/**
 * Hand a silent tunnel's socket to mockttp as if it had answered the CONNECT itself. `address` is the CONNECT target
 * (`host:port`), `head` bytes that came with the CONNECT head and are not yet back in the socket.
 */
export function injectSilentTunnel(server: net.Server, socket: net.Socket, address: string, head?: Buffer): boolean {
  const x = extensions();
  if (!x) return false;
  const s = socket as unknown as Record<symbol, unknown>;
  const timing = (s[x.SocketTimingInfo] ??= { initialSocket: Date.now(), initialSocketTimestamp: performance.now() }) as Record<string, number>;
  timing.tunnelSetupTimestamp = performance.now();
  s[x.LastTunnelAddress] = address;
  s[x.LastHopEncrypted] = false;
  if (head?.length) socket.unshift(head);
  server.emit('connection', socket);
  return true;
}
