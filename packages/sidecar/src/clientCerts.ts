/**
 * CONTRACTS §20.3 in the sidecar: the `ClientCertPlatform` behind the shared `createClientCertUi`
 * (packages/extension/src/ui/clientCertUi.ts). The IDE does what the sidecar can't (types.ts `SidecarRequest`):
 *
 *   ui.chooseClientCertificateFile   {role: 'pfx' | 'cert' | 'key'}                → absolute path | null (cancelled)
 *   settings.writeClientCertificates {entries: {host, pfx?, cert?, key?}[]}         → null (user level; the plugin then
 *                                                                                      sends `settings` as for any change)
 *   secrets.setClientCertPassphrase  {host, passphrase?}  (absent / '' = delete)   → null
 *
 * The entries are read from the settings the plugin sent (`SidecarSettings.clientCertificates`). Both sides check what
 * they receive. The passphrase only travels in that one request: never logged, never in an error message.
 */
import * as path from 'path';
import type { ClientCertEntry } from '../../extension/src/ui/clientCerts';
import { certHostProblem, MAX_CLIENT_CERTS } from '../../extension/src/ui/clientCerts';
import type { ClientCertFileRole, ClientCertPlatform } from '../../extension/src/ui/clientCertUi';
import { RpcFailure } from './rpc';

export const CERT_FILE_METHOD = 'ui.chooseClientCertificateFile';
export const CERT_ENTRIES_METHOD = 'settings.writeClientCertificates';
export const CERT_PASSPHRASE_SET_METHOD = 'secrets.setClientCertPassphrase';

const ROLES: readonly ClientCertFileRole[] = ['pfx', 'cert', 'key'];
const MAX_PATH = 4096;

export interface SidecarClientCertDeps {
  /** A request to the plugin (waits for the user: no timeout for the file chooser). */
  request(method: string, params: unknown): Promise<unknown>;
  /** The user-level entries as the plugin last sent them. */
  entries(): SidecarClientCertEntry[];
  /** The plugin stored these: use them before its `settings` call arrives. */
  entriesWritten(entries: SidecarClientCertEntry[]): void;
  /** Re-load the certificates into the proxy (serialised by the host). */
  reload(): Promise<void>;
  log?(line: string): void;
}

export type SidecarClientCertEntry = { host: string; pfx?: string; cert?: string; key?: string };

/** A path the IDE answered with: absolute, one line, bounded. Undefined when it isn't. */
export function usableCertPath(v: unknown): string | undefined {
  if (typeof v !== 'string' || !v || v.length > MAX_PATH || /[\0\r\n]/.test(v) || !path.isAbsolute(v)) return undefined;
  return v;
}

const optPath = (v: unknown, n: number, field: string): string | undefined => {
  if (v === undefined || v === null || v === '') return undefined;
  if (typeof v !== 'string' || v.length > MAX_PATH || /[\0\r\n]/.test(v)) throw new Error(`entry ${n}: its ${field} path is not a valid path`);
  return v;
};

/**
 * The entries to send to the plugin, checked: a list of at most MAX_CLIENT_CERTS objects with a host and string
 * paths. Hosts are checked with the proxy's pattern rules unless the entry is one the plugin already stores (a pattern
 * typed on the settings page stays as it is; the loader reports it).
 */
export function entriesForPlugin(entries: unknown, stored: readonly SidecarClientCertEntry[]): SidecarClientCertEntry[] {
  if (!Array.isArray(entries)) throw new Error('the client certificate entries must be a list');
  if (entries.length > MAX_CLIENT_CERTS) throw new Error(`at most ${MAX_CLIENT_CERTS} client certificates can be stored`);
  const known = new Set(stored.map((e) => JSON.stringify([e.host.trim().toLowerCase(), e.pfx ?? '', e.cert ?? '', e.key ?? ''])));
  return entries.map((raw, i) => {
    const n = i + 1;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error(`entry ${n} must be an object`);
    const e = raw as Record<string, unknown>;
    if (typeof e.host !== 'string') throw new Error(`entry ${n} has no host`);
    const out: SidecarClientCertEntry = {
      host: e.host,
      ...(optPath(e.pfx, n, 'pfx') ? { pfx: e.pfx as string } : {}),
      ...(optPath(e.cert, n, 'cert') ? { cert: e.cert as string } : {}),
      ...(optPath(e.key, n, 'key') ? { key: e.key as string } : {}),
    };
    const isKnown = known.has(JSON.stringify([out.host.trim().toLowerCase(), out.pfx ?? '', out.cert ?? '', out.key ?? '']));
    if (!isKnown) {
      const problem = certHostProblem(out.host);
      if (problem !== undefined) throw new Error(`entry ${n}: ${problem}`);
    }
    return out;
  });
}

/** An IDE refusal as a sentence the panel can show (the IDE's own messages are readable and never carry secrets). */
function ideError(e: unknown, what: string): Error {
  const f = e as RpcFailure;
  if (f?.code === 'unknown_method') return new Error(`This IDE plugin can't ${what}: update Flutter Intercept.`);
  if (f?.code === 'closed') return new Error('The IDE connection closed.');
  const msg = e instanceof Error ? e.message.replace(/[\r\n]+/g, ' ').slice(0, 300) : '';
  return new Error(msg || `The IDE couldn't ${what}.`);
}

export function createSidecarClientCertPlatform(deps: SidecarClientCertDeps): ClientCertPlatform {
  return {
    async pickFile(role) {
      if (!ROLES.includes(role)) throw new Error('Unknown certificate file kind.');
      let v: unknown;
      try {
        v = await deps.request(CERT_FILE_METHOD, { role });
      } catch (e) {
        throw ideError(e, 'choose certificate files');
      }
      if (v === null || v === undefined) return undefined;
      const file = usableCertPath(v);
      if (!file) throw new Error("That file can't be used: choose a file on this computer.");
      return file;
    },
    readEntries: () => deps.entries().map((e) => ({ ...e })),
    async writeEntries(entries: ClientCertEntry[]) {
      const checked = entriesForPlugin(entries, deps.entries());
      try {
        await deps.request(CERT_ENTRIES_METHOD, { entries: checked });
      } catch (e) {
        throw ideError(e, 'save client certificates');
      }
      deps.entriesWritten(checked);
    },
    async setPassphrase(host, passphrase) {
      if (certHostProblem(host) !== undefined) throw new Error('The host is not a valid host pattern.');
      const value = typeof passphrase === 'string' && passphrase.length > 0 ? passphrase : undefined;
      try {
        await deps.request(CERT_PASSPHRASE_SET_METHOD, { host: host.trim().toLowerCase(), ...(value !== undefined ? { passphrase: value } : {}) });
      } catch (e) {
        throw ideError(e, 'store the passphrase');
      }
    },
    reload: () => deps.reload(),
    ...(deps.log ? { log: deps.log } : {}),
  };
}
