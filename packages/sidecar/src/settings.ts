/**
 * `SidecarSettings` as received from the plugin, normalised: every field present, wrong types replaced by the
 * default (never thrown), lists bounded. The plugin stores them application-level (user scope only, CONTRACTS §15.2).
 */
import type { InitParams, SidecarSettings } from './types';

export const DEFAULT_PORT = 8899;
export const DEFAULT_MCP_PORT = 47823;

export const DEFAULT_SETTINGS: SidecarSettings = {
  enabled: true,
  port: DEFAULT_PORT,
  captureSource: true,
  webEnabled: true,
  nativeClients: 'profile',
  backgroundIsolates: 'intercept',
  notifications: 'errors',
  contractCheck: true,
  rewriteLocalhost: true,
  upstreamProxyIgnoreCertErrors: false,
  tlsPassthrough: [],
  clientCertificates: [],
  agent: { access: 'readWrite', redactSecrets: true, screenshots: true, mcpPort: DEFAULT_MCP_PORT },
  grpc: { enabled: true, decryptHosts: [] },
};

const bool = (v: unknown, d: boolean): boolean => (typeof v === 'boolean' ? v : d);
/** 0 = any free port (tests); otherwise 1–65535. */
const port = (v: unknown, d: number): number => (typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= 65535 ? v : d);
const oneOf = <T extends string>(v: unknown, allowed: readonly T[], d: T): T => (typeof v === 'string' && (allowed as readonly string[]).includes(v) ? (v as T) : d);
const str = (v: unknown, max = 2048): string | undefined => (typeof v === 'string' && v.trim() && v.length <= max ? v.trim() : undefined);
const strList = (v: unknown, maxItems = 200, maxLen = 300): string[] =>
  Array.isArray(v) ? v.filter((s): s is string => typeof s === 'string' && s.length > 0 && s.length <= maxLen).slice(0, maxItems) : [];

export function normalizeSettings(raw: unknown): SidecarSettings {
  const s = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const a = s.agent && typeof s.agent === 'object' ? (s.agent as Record<string, unknown>) : {};
  const d = DEFAULT_SETTINGS;
  const certs = Array.isArray(s.clientCertificates)
    ? s.clientCertificates
        .filter((c): c is Record<string, unknown> => !!c && typeof c === 'object')
        .slice(0, 50)
        .map((c) => ({
          host: typeof c.host === 'string' ? c.host : '',
          ...(str(c.pfx, 4096) ? { pfx: str(c.pfx, 4096) } : {}),
          ...(str(c.cert, 4096) ? { cert: str(c.cert, 4096) } : {}),
          ...(str(c.key, 4096) ? { key: str(c.key, 4096) } : {}),
        }))
    : [];
  const ideRaw = s.ideHttpProxy && typeof s.ideHttpProxy === 'object' ? (s.ideHttpProxy as Record<string, unknown>) : undefined;
  const ideUrl = str(ideRaw?.url);
  const ideNoProxy = strList(ideRaw?.noProxy);
  const upstream = str(s.upstreamProxy);
  const g = s.grpc && typeof s.grpc === 'object' ? (s.grpc as Record<string, unknown>) : {};
  return {
    enabled: bool(s.enabled, d.enabled),
    port: port(s.port, d.port),
    captureSource: bool(s.captureSource, d.captureSource),
    webEnabled: bool(s.webEnabled, d.webEnabled),
    nativeClients: oneOf(s.nativeClients, ['profile', 'proxy', 'off'] as const, d.nativeClients),
    backgroundIsolates: oneOf(s.backgroundIsolates, ['intercept', 'warn'] as const, d.backgroundIsolates),
    notifications: oneOf(s.notifications, ['errors', 'all', 'off'] as const, d.notifications),
    contractCheck: bool(s.contractCheck, d.contractCheck),
    rewriteLocalhost: bool(s.rewriteLocalhost, d.rewriteLocalhost),
    ...(upstream ? { upstreamProxy: upstream } : {}),
    upstreamProxyIgnoreCertErrors: bool(s.upstreamProxyIgnoreCertErrors, d.upstreamProxyIgnoreCertErrors),
    tlsPassthrough: strList(s.tlsPassthrough),
    clientCertificates: certs,
    agent: {
      access: oneOf(a.access, ['readWrite', 'readOnly', 'off'] as const, d.agent.access),
      redactSecrets: bool(a.redactSecrets, d.agent.redactSecrets),
      screenshots: bool(a.screenshots, d.agent.screenshots),
      mcpPort: port(a.mcpPort, d.agent.mcpPort),
    },
    grpc: { enabled: bool(g.enabled, true), decryptHosts: strList(g.decryptHosts) },
    ...(ideUrl || ideNoProxy.length ? { ideHttpProxy: { ...(ideUrl ? { url: ideUrl } : {}), ...(ideNoProxy.length ? { noProxy: ideNoProxy } : {}) } } : {}),
  };
}

export function normalizeTheme(v: unknown): InitParams['theme'] {
  return v === 'light' || v === 'high-contrast' ? v : 'dark';
}
