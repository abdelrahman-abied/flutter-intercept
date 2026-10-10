// Host patterns for TLS passthrough (CONTRACTS §14.2) and client certificates (CONTRACTS §14.3): a hostname glob
// (`api.example.com`, `*.bank.example`, `10.0.0.*`), optionally with `:port` (`[::1]:8443` for IPv6). Case-insensitive;
// `*` matches any characters, dots included (`*.bank.example` matches `a.b.bank.example`, not `bank.example`).

export interface HostPattern {
  /** The pattern as configured (trimmed). */
  pattern: string;
  host: RegExp;
  port?: number;
}

const HOST_CHARS = /^[a-z0-9*._-]+$/;
const IPV6_CHARS = /^[0-9a-f:.*]+$/;

/** Lower-case, no brackets, no trailing dot(s). */
export function normalizeHostname(h: string): string {
  return String(h ?? '').trim().toLowerCase().replace(/^\[|\]$/g, '').replace(/\.+$/, '');
}

/** Parse one pattern; throws a readable Error. */
export function parseHostPattern(input: unknown): HostPattern {
  if (typeof input !== 'string' || !input.trim()) throw new Error('expected a host name or pattern such as api.example.com or *.example.com');
  const pattern = input.trim();
  let host = pattern.toLowerCase();
  let port: number | undefined;
  let v6 = false;
  if (host.startsWith('[')) {
    const m = /^\[([^\]]+)\](?::(\d+))?$/.exec(host);
    if (!m) throw new Error(`"${pattern.slice(0, 100)}" is not a valid [IPv6]:port pattern`);
    host = m[1];
    if (m[2] !== undefined) port = Number(m[2]);
    v6 = true;
  } else if ((host.match(/:/g) ?? []).length === 1) {
    const i = host.indexOf(':');
    const p = host.slice(i + 1);
    if (!/^\d+$/.test(p)) throw new Error(`"${pattern.slice(0, 100)}": the port must be a number`);
    port = Number(p);
    host = host.slice(0, i);
  } else if (host.includes(':')) {
    v6 = true; // bare IPv6 address (no port)
  }
  host = host.replace(/\.+$/, '');
  if (port !== undefined && (!Number.isInteger(port) || port < 1 || port > 65535)) throw new Error(`"${pattern.slice(0, 100)}": port out of range`);
  if (!host || !(v6 ? IPV6_CHARS : HOST_CHARS).test(host)) {
    throw new Error(`"${pattern.slice(0, 100)}" is not a host name pattern (letters, digits, ".", "-", "_" and "*" only, optional ":port")`);
  }
  if (!host.replace(/\*/g, '')) throw new Error(`"${pattern.slice(0, 100)}" matches every host; list the hosts instead`);
  const re = new RegExp(`^${host.split('*').map((s) => s.replace(/[.\\^$+?()[\]{}|-]/g, '\\$&')).join('.*')}$`);
  return { pattern, host: re, ...(port !== undefined ? { port } : {}) };
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
