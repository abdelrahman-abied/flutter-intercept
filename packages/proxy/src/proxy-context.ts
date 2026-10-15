// The proxy as its flow modules see it.

import * as net from 'net';
import type * as mockttp from 'mockttp';
import { type HeaderBag } from './body';
import { ReplayStore, type BodyKey } from './replay';
import { type UpstreamProxySpec } from './upstream-proxy';
import { type HostPattern } from './hosts';
import { GrpcSessionPool } from './grpc-upstream';
import { type GrpcSupport } from './silent';
import { LanGate } from './lan';
import { type NetworkProfile } from './network';
import { TraceJoin } from './trace';
import { ScriptRunner } from './script';
import type { Exchange, InterceptProxyOptions, Rule } from './types';
import type { ExchangeStore } from './exchange-store';
import type { GrpcRelay } from './grpc-relay';
import type { GrpcLocal } from './grpc-local';
import type { GrpcHooks } from './grpc-hooks';
import type { GrpcWebFlow } from './grpc-web-flow';
import type { HttpEdits } from './http-edits';
import type { HttpTaps } from './http-taps';
import type { LearnFlow } from './learn-flow';
import type { Decision, SendMeta, Flow, MatchOptions, MatchResult, ReqMeta, Paused, LoadedCert } from './flow-types';

/**
 * QUALITY-1 Q1: what the flow modules see of the proxy. The proxy builds one (getters and delegates over its private
 * members); the modules never import the proxy class.
 */
export interface ProxyContext {
  addressIsSelf(ip: string, port: number): boolean;
  readonly appPackages: string[];
  readonly book: ExchangeStore;
  readonly breakpointTimeoutMs: number;
  certFor(hostname: string, port: number): LoadedCert | undefined;
  certRefusal(url: string, headers: HeaderBag): string | undefined;
  connectHook: boolean;
  readonly connRequest: WeakMap<object, string>;
  readonly edits: HttpEdits;
  emit(event: string | symbol, ...args: unknown[]): boolean;
  readonly grpc: GrpcRelay;
  readonly grpcCheck: GrpcSupport;
  readonly grpcDecrypt: HostPattern[];
  readonly grpcDecryptAllOn: boolean;
  readonly grpcLocal: GrpcLocal;
  readonly grpcPool: GrpcSessionPool | undefined;
  readonly grpcWeb: GrpcWebFlow;
  readonly holds: Map<string, (appLeft: boolean) => void>;
  readonly hooks: GrpcHooks;
  readonly hopNonce: string;
  readonly host: string;
  readonly lanGate: LanGate | undefined;
  /** CONTRACTS §20.1: learned passthrough hosts. */
  readonly learn: LearnFlow;
  matchRule(method: string, url: string, o: MatchOptions): MatchResult;
  readonly opts: InterceptProxyOptions;
  readonly passthrough: HostPattern[];
  pause(ex: Exchange, phase: 'request' | 'response'): Promise<Decision>;
  readonly paused: Map<string, Paused>;
  /** Actual port after start() (0 before). */
  readonly port: number;
  readonly profile: NetworkProfile;
  readonly rawServer: net.Server | undefined;
  replayFlow(method: string, url: string, headers: HeaderBag, body: BodyKey, note?: string): Flow;
  readonly replayStore: ReplayStore | undefined;
  readonly reqMeta: WeakMap<object, ReqMeta>;
  /** CONTRACTS §20.1: an enabled, unspent rule whose URL pattern names this host (patternNamesHost). */
  ruleNamingHost(host: string, port: number): Rule | undefined;
  readonly scripts: ScriptRunner;
  readonly sends: Map<string, SendMeta>;
  readonly server: mockttp.Mockttp | undefined;
  readonly taps: HttpTaps;
  targetsSelf(hostIn: string, port: number): boolean;
  readonly traceJoin: TraceJoin;
  readonly upstreamSpec: UpstreamProxySpec | undefined;
  readonly webSession: boolean;
}

