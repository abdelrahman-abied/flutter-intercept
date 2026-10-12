// QUALITY-1 Q1: the mockttp internals the proxy relies on, typed in one place (mockttp 4.6). The startup self-checks
// (grpcSelfCheck, the preprocessing hook, the bind check) fail closed when one of them changes shape.

import type * as net from 'net';
import type * as mockttp from 'mockttp';
import type { OngoingRequest } from 'mockttp';
import type { RequestMatcher } from 'mockttp/dist/rules/matchers';
import type { HeaderBag } from './body';
import type { RequestTimingEvents } from './flow-types';

/** Request fields mockttp has but its public types don't show (or show read-only). */
export interface RequestInternals {
  url: string;
  protocol: string;
  path: string;
  destination: { hostname: string; port: number };
  rawHeaders: Array<[string, string]>;
  headers: HeaderBag;
  httpVersion?: string;
  /** The downstream socket (a LAN gate's socket carries its marker, see lan.ts). */
  socket?: net.Socket;
  timingEvents?: RequestTimingEvents;
  body?: { asDecodedBuffer(): Promise<Buffer> };
}

export const requestInternals = (req: object): RequestInternals => req as unknown as RequestInternals;

/** MockttpServer members the proxy uses that are not in the Mockttp interface. */
export interface ServerInternals {
  /** The combo server (HTTP/1, HTTP/2, CONNECT and TLS on one port), after start(). */
  server?: net.Server;
  /** Called for every request before the rules (the LAN check and the internal-header strip hook it). */
  preprocessRequest?: (req: any, type: string, emitter: unknown) => unknown; // eslint-disable-line @typescript-eslint/no-explicit-any
  addWebSocketRules(...rules: unknown[]): Promise<unknown>;
}

export const serverInternals = (server: mockttp.Mockttp): ServerInternals => server as unknown as ServerInternals;

/** A request matcher from a function (mockttp's own matchers must be serialisable; ours never leave the process). */
export function callbackMatcher(type: string, matches: (req: OngoingRequest) => unknown, explain: () => string): RequestMatcher {
  return {
    type,
    matches,
    explain,
    dispose: () => undefined,
    serialize: () => {
      throw new Error('not serializable');
    },
  } as unknown as RequestMatcher;
}
