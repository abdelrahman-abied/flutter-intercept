/**
 * v0.8.0 connection helpers (CONTRACTS §14): TLS passthrough tunnels (§14.2), client certificates (§14.3) and the
 * upstream proxy source (§14.6). Pure: no DOM.
 */
import type { Exchange, Status } from './protocol';
import { UPSTREAM_TITLE } from './scenarios';
import { formatBytes } from './util';

// ---------------------------------------------------------------- TLS passthrough tunnels (§14.2)

export const TLS_PASSTHROUGH_SETTING = 'flutterIntercept.tlsPassthrough';

/** A TLS connection passed through undecrypted: no headers, no bodies, rules never apply (only Block). */
export function isTunnel(ex: Pick<Exchange, 'kind'>): boolean {
  return ex.kind === 'tunnel';
}

/** Why every action except Block can't be used on a tunnel. */
export const TUNNEL_NO_ACTION =
  'TLS passthrough — not decrypted: there is no request or response to mock, pause, copy or resend. Only Block applies.';

/** Short line for the list badge, the detail header and the agent-style explanation. */
export const TUNNEL_LABEL = 'TLS passthrough — not decrypted';

/** "api.bank.example:443" of a tunnel (its url is `https://host:port/`). */
export function tunnelTarget(ex: Pick<Exchange, 'url'>): { host: string; port: string } {
  try {
    const u = new URL(ex.url);
    if (u.hostname) return { host: u.hostname, port: u.port || '443' };
  } catch { /* "host:port" without a scheme */ }
  const m = /^(?:[a-z]+:\/\/)?([^/:]+)(?::(\d+))?/i.exec(ex.url);
  return { host: m?.[1] ?? ex.url, port: m?.[2] ?? '443' };
}

/** Compact byte count for the list column: "512", "1.2k", "45k", "3.4M". */
export function compactBytes(n: number): string {
  if (n < 1024) return String(n);
  const k = n / 1024;
  if (k < 1024) return `${k < 10 ? k.toFixed(1) : Math.round(k)}k`;
  const m = k / 1024;
  return `${m < 10 ? m.toFixed(1) : Math.round(m)}M`;
}

/** List size column of a tunnel: "↑1.2k ↓45k" (sent by the app, received from the server). */
export function tunnelBytesShort(ex: Pick<Exchange, 'tunnelBytes'>): string {
  const b = ex.tunnelBytes;
  if (!b) return '—';
  return `↑${compactBytes(b.sent)} ↓${compactBytes(b.received)}`;
}

/** "1.2 kB sent by the app · 45.0 kB received from the server (encrypted)". */
export function tunnelBytesText(ex: Pick<Exchange, 'tunnelBytes' | 'state'>): string {
  const b = ex.tunnelBytes;
  if (!b) return ex.state === 'pending' ? 'No bytes counted yet' : 'Byte counts not reported';
  return `${formatBytes(b.sent)} sent by the app · ${formatBytes(b.received)} received from the server (encrypted)`;
}

/** Tooltip of the list badge / row. */
export function tunnelTitle(ex: Pick<Exchange, 'tunnelBytes' | 'state' | 'url'>): string {
  const { host, port } = tunnelTarget(ex);
  const live = ex.state === 'pending' ? ' · open' : '';
  return `${TUNNEL_LABEL}: ${host}:${port} matches ${TLS_PASSTHROUGH_SETTING}${live}\n${tunnelBytesText(ex)}`;
}

/**
 * Hostname glob as the settings use it: `*` = any run of characters, case-insensitive, whole name. A pattern with
 * `:port` only matches that port (when `port` is given).
 */
export function hostGlobMatch(pattern: string, host: string, port?: string): boolean {
  let p = pattern.trim().toLowerCase();
  if (!p) return false;
  const m = /^(.*):(\d+)$/.exec(p);
  if (m) {
    if (port !== undefined && m[2] !== port) return false;
    p = m[1];
  }
  const re = new RegExp(`^${p.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`);
  return re.test(host.toLowerCase());
}

/** The configured passthrough pattern a tunnel matches (display only; the proxy decided). */
export function matchingPassthrough(ex: Pick<Exchange, 'url'>, patterns: readonly string[] | undefined): string | undefined {
  if (!patterns?.length) return undefined;
  const { host, port } = tunnelTarget(ex);
  return patterns.find((p) => hostGlobMatch(p, host, port));
}

/** Status line item for `Status.tlsPassthrough` (undefined = none configured). */
export function passthroughSummary(hosts: readonly string[] | undefined): { text: string; title: string } | undefined {
  if (!hosts?.length) return undefined;
  const n = hosts.length;
  return {
    text: `TLS passthrough: ${n} host${n === 1 ? '' : 's'}`,
    title:
      `Connections to these hosts are tunnelled to the server without decryption (${TLS_PASSTHROUGH_SETTING}):\n` +
      hosts.map((h) => `• ${h}`).join('\n') +
      '\n\nUse it for hosts whose certificate the app pins itself. Their requests show as one “tunnel” row each: ' +
      'no headers or bodies, and no rule applies except Block.',
  };
}

// ---------------------------------------------------------------- client certificates (§14.3)

export const CLIENT_CERT_SETTING = 'flutterIntercept.clientCertificates';

/** Status line item for `Status.clientCertificates` (never key material: only host patterns and problems). */
export function clientCertSummary(certs: Status['clientCertificates']):
  { text: string; title: string; problems: number } | undefined {
  if (!certs?.length) return undefined;
  const problems = certs.filter((c) => c.problem).length;
  const n = certs.length;
  const text = problems
    ? `Client certificates: ${problems} problem${problems === 1 ? '' : 's'}`
    : `Client certificate${n === 1 ? '' : 's'}: ${n}`;
  const lines = certs.map((c) => (c.problem ? `✕ ${c.host} — ${c.problem}` : `• ${c.host}`));
  return {
    text,
    problems,
    title:
      `Presented to matching servers that ask for one (mTLS), from ${CLIENT_CERT_SETTING} in your user settings:\n` +
      lines.join('\n') +
      (problems ? '\n\nA certificate with a problem is not presented — fix the file path or set its passphrase with ' +
        '“Flutter Intercept: Set Client Certificate Passphrase…”.' : ''),
  };
}

/** Tooltip of the detail pane's client certificate badge. */
export function clientCertTitle(pattern: string): string {
  return `The proxy presented the client certificate configured for “${pattern}” (${CLIENT_CERT_SETTING}) when the ` +
    'server asked for one. The key never leaves the proxy.';
}

// ---------------------------------------------------------------- upstream proxy source (§14.6)

/** True when the upstream proxy comes from VS Code's `http.proxy` (flutterIntercept.upstreamProxy is empty). */
export function fromVsCodeProxy(status: Pick<Status, 'upstreamProxySource'>): boolean {
  return status.upstreamProxySource === 'http.proxy';
}

/** "via VS Code proxy host:port" / "via upstream proxy host:port". */
export function upstreamLabel(status: Pick<Status, 'upstreamProxy' | 'upstreamProxySource'>): string {
  return `${fromVsCodeProxy(status) ? 'via VS Code proxy' : 'via upstream proxy'} ${status.upstreamProxy ?? ''}`.trim();
}

export function upstreamTitle(status: Pick<Status, 'upstreamProxy' | 'upstreamProxySource'>): string {
  const hp = status.upstreamProxy ?? '';
  if (!fromVsCodeProxy(status)) return UPSTREAM_TITLE(hp);
  return `All pass-through traffic (every request a rule doesn't answer, HTTPS included) is sent through ${hp}, the proxy ` +
    'from VS Code\'s http.proxy user setting (flutterIntercept.upstreamProxy is empty). Hosts in http.noProxy go direct. ' +
    'Certificate checks stay on (http.proxyStrictSSL doesn\'t turn them off). Set flutterIntercept.upstreamProxy to use ' +
    'another proxy.';
}
