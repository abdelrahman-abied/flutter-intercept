// Host patterns for TLS passthrough (CONTRACTS §14.2) and client certificates (CONTRACTS §14.3). Dependency-free: the
// extension host validates its settings with the same code (`@flutter-intercept/proxy/hosts`), so the two can never
// disagree (REVIEW-8 #4).
//
// A pattern is a host name, optionally with `:port` (`[v6]:port` for IPv6), case-insensitive:
// - `api.example.com` — exactly that host; IP literals (`10.0.0.7`, `[::1]`) exactly that address;
// - `*` inside a label matches within that ONE label (`api-*.example.com` matches `api-eu.example.com`, not
//   `api-eu.evil.example.com`);
// - a leading `*.` matches any subdomain depth (`*.bank.example` matches `a.bank.example` and `a.b.bank.example`, not
//   `bank.example`).
// Refused (REVIEW-8 #4: they also match names an attacker can register): `*`, `*.*`, a wildcard in the last label
// (`api.corp.*`), fewer than two literal labels next to a wildcard (`*.com`, `*-*.local`), and wildcards in IP
// addresses (`10.0.0.*` — list the addresses).

export interface HostPattern {
  /** The pattern as configured (trimmed). */
  pattern: string;
  host: RegExp;
  port?: number;
}

export interface HostPatternProblem {
  /** The entry as given (text, cut to 200 characters). */
  host: string;
  problem: string;
}

const LABEL = /^[a-z0-9*_-]+$/;
const IPV4ISH = /^[0-9.*]+$/;
const IPV6_CHARS = /^[0-9a-f:.*]+$/;

/** Lower-case, no brackets, no trailing dot(s). */
export function normalizeHostname(h: string): string {
  return String(h ?? '').trim().toLowerCase().replace(/^\[|\]$/g, '').replace(/\.+$/, '');
}

const esc = (s: string) => s.replace(/[.\\^$+?()[\]{}|-]/g, '\\$&');

/** Parse one pattern; throws an Error whose message says why it is refused. */
export function parseHostPattern(input: unknown): HostPattern {
  if (typeof input !== 'string' || !input.trim()) throw new Error('expected a host name or pattern such as api.example.com or *.example.com');
  const pattern = input.trim();
  const shown = `"${pattern.slice(0, 100)}"`;
  let host = pattern.toLowerCase();
  let port: number | undefined;
  let v6 = false;
  if (host.startsWith('[')) {
    const m = /^\[([^\]]+)\](?::(\d+))?$/.exec(host);
    if (!m) throw new Error(`${shown} is not a valid [IPv6]:port pattern`);
    host = m[1];
    if (m[2] !== undefined) port = Number(m[2]);
    v6 = true;
  } else if ((host.match(/:/g) ?? []).length === 1) {
    const i = host.indexOf(':');
    const p = host.slice(i + 1);
    if (!/^\d+$/.test(p)) throw new Error(`${shown}: the port must be a number`);
    port = Number(p);
    host = host.slice(0, i);
  } else if (host.includes(':')) {
    v6 = true; // bare IPv6 address (no port)
  }
  if (port !== undefined && (!Number.isInteger(port) || port < 1 || port > 65535)) throw new Error(`${shown}: port out of range`);
  host = host.replace(/\.+$/, '');
  if (!host) throw new Error(`${shown} has no host name`);
  const wild = host.includes('*');
  if (v6) {
    if (!IPV6_CHARS.test(host)) throw new Error(`${shown} is not an IPv6 address`);
    if (wild) throw new Error(`${shown}: wildcards are not allowed in IP addresses; list the addresses`);
    return { pattern, host: new RegExp(`^${esc(host)}$`), ...(port !== undefined ? { port } : {}) };
  }
  if (IPV4ISH.test(host) && /\d/.test(host) && (wild || /^\d+(\.\d+){3}$/.test(host))) {
    if (wild) throw new Error(`${shown}: wildcards are not allowed in IP addresses; list the addresses`);
    return { pattern, host: new RegExp(`^${esc(host)}$`), ...(port !== undefined ? { port } : {}) };
  }
  if (host === '*') throw new Error(`${shown} matches every host; list the hosts instead`);
  const anyDepth = host.startsWith('*.');
  const labels = (anyDepth ? host.slice(2) : host).split('.');
  for (const l of labels) {
    if (!l || !LABEL.test(l)) throw new Error(`${shown} is not a host name pattern (letters, digits, "-", "_" and "*" in dot-separated labels, optional ":port")`);
  }
  if (wild) {
    if (labels[labels.length - 1].includes('*')) throw new Error(`${shown}: the last label can't be a wildcard (it would match other top-level domains)`);
    if (labels.filter((l) => !l.includes('*')).length < 2) {
      throw new Error(`${shown} is too broad (a wildcard needs at least two fixed labels, e.g. *.example.com)`);
    }
  }
  const body = labels.map((l) => l.split('*').map(esc).join('[^.]*')).join('\\.');
  const re = new RegExp(`^${anyDepth ? '(?:[^.]+\\.)+' : ''}${body}$`);
  return { pattern, host: re, ...(port !== undefined ? { port } : {}) };
}

/** Parse a list: the good entries, and each refused one with its reason (one bad entry never drops the rest). */
export function parseHostPatterns(list: unknown): { patterns: HostPattern[]; problems: HostPatternProblem[] } {
  const patterns: HostPattern[] = [];
  const problems: HostPatternProblem[] = [];
  if (list === undefined || list === null) return { patterns, problems };
  if (!Array.isArray(list)) return { patterns, problems: [{ host: String(list).slice(0, 200), problem: 'expected a list of host names' }] };
  for (const entry of list) {
    try {
      patterns.push(parseHostPattern(entry));
    } catch (e) {
      problems.push({ host: String(entry ?? '').slice(0, 200), problem: (e as Error).message });
    }
  }
  return { patterns, problems };
}

/** Why a pattern is refused, or undefined when it is fine (for settings validators). */
export function hostPatternProblem(input: unknown): string | undefined {
  try {
    parseHostPattern(input);
    return undefined;
  } catch (e) {
    return (e as Error).message;
  }
}

export function matchesHostPattern(p: HostPattern, hostname: string, port: number): boolean {
  if (p.port !== undefined && p.port !== port) return false;
  return p.host.test(normalizeHostname(hostname));
}

/** Split `host:port` / `[v6]:port` (a CONNECT target). */
export function splitHostPort(target: string, defaultPort = 443): { host: string; port: number } | undefined {
  const m = /^\[([^\]]+)\](?::(\d+))?$/.exec(target) ?? /^([^:[\]]+)(?::(\d+))?$/.exec(target);
  if (!m) return undefined;
  const port = m[2] !== undefined ? Number(m[2]) : defaultPort;
  if (!Number.isInteger(port) || port < 1 || port > 65535) return undefined;
  return { host: m[1], port };
}
