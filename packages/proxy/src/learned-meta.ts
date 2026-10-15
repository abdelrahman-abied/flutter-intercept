// CONTRACTS §20.1 / §20.5: the learned passthrough map's key format, caps and labels, shared by the proxy and the
// extension host (`@flutter-intercept/proxy/learned-meta`) so a `[v6]:port` key is written and read by the same code
// (REVIEW-14 #5). Imports only Node's `net` and ./hosts: activation can load it without the proxy or mockttp (PERF-1 #1).

import * as net from 'net';
import { normalizeHostname } from './hosts';

/** At most this many learned entries in all (when full: expired ones go, then the oldest pin; then nothing new is learned). */
export const LEARNED_MAX = 1000;
/** At most this many learned entries per client (CONTRACTS §20.5: a client at its limit loses its oldest entry). */
export const LEARNED_PER_CLIENT = 250;
/** CONTRACTS §20.2: Status and the agents list at most this many learned hosts. */
export const LEARNED_SHOWN_MAX = 200;

/** An IPv6 literal in brackets (`[2001:db8::1]`), any other host as it is. */
export function bracketHost(host: string): string {
  return net.isIPv6(host) ? `[${host}]` : host;
}

/** The learned map's key (and the 0.13 gRPC pin key): bare host (IPv6 without brackets), port. */
export const learnedKey = (host: string, port: number): string => `${host}:${port}`;

/** REVIEW-14 #2: the per-client key of pins, pin strikes and "accepted" marks: `client|host:port` (client: clientKeyOf). */
export const pinKey = (client: string, host: string, port: number): string => `${client}|${learnedKey(host, port)}`;

/** The `host:port` part of a pinKey. */
export const pinKeyTarget = (key: string): string => key.slice(key.indexOf('|') + 1);

/** `host` for 443, else `host:port` (IPv6 in brackets): how messages name a learned host. */
export function hostLabel(host: string, port: number): string {
  const h = bracketHost(host);
  return port === 443 ? h : `${h}:${port}`;
}

/** `host:port` / `[v6]:port` / `host` (any port) → the host and the port, if given. */
export function parseLearnedKey(key: string): { host: string; port?: number } | undefined {
  const s = String(key ?? '').trim();
  const m = /^\[([^\]]+)\](?::(\d+))?$/.exec(s) ?? (net.isIPv6(s) ? [s, s, undefined] : /^([^:[\]]+)(?::(\d+))?$/.exec(s));
  if (!m) return undefined;
  const host = normalizeHostname(m[1]);
  const port = m[2] !== undefined ? Number(m[2]) : undefined;
  if (!host || (port !== undefined && !(Number.isInteger(port) && port >= 1 && port <= 65535))) return undefined;
  return port === undefined ? { host } : { host, port };
}

/**
 * REVIEW-14 #5: the key `forgetLearnedPassthrough` takes for a host (bracketed or not, any case) and a port, as
 * parseLearnedKey reads it: `[v6]:port`, `host:port`, or the bare host (every port; a bare IPv6 address too).
 */
export function learnedKeyOf(rawHost: string, port?: number): string {
  const bracketed = /^\[(.+)\]$/.exec(rawHost);
  const host = (bracketed ? bracketed[1] : rawHost).toLowerCase();
  if (port === undefined) return host;
  return `${bracketHost(host)}:${port}`;
}
