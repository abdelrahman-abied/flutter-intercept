/**
 * CONTRACTS §20.3: adding / removing client certificates from the traffic panel. vscode-free: the extension and the
 * sidecar (Android Studio plugin) each pass a small `ClientCertPlatform`; `createClientCertUi` holds the file tokens and
 * the checks. The webview only ever sees a token and a file's base name — never a path — and the passphrase is never
 * logged, echoed back or kept.
 */
import type { ClientCertEntry } from './clientCerts';
import type { ClientCertFileRole } from './protocol';

export type { ClientCertFileRole } from './protocol';

/** What one IDE provides. */
export interface ClientCertPlatform {
  /** The IDE's native file picker for this role; the chosen absolute path, or undefined when cancelled. */
  pickFile(role: ClientCertFileRole): Promise<string | undefined>;
  /** The user-level `flutterIntercept.clientCertificates` entries as stored (paths, never contents). */
  readEntries(): Promise<unknown> | unknown;
  /** Write the user-level entries (VS Code: ConfigurationTarget.Global; plugin: InterceptSettings). */
  writeEntries(entries: ClientCertEntry[]): Promise<void>;
  /** Store (or with undefined / '' delete) the passphrase for a host pattern in the IDE's secret store. */
  setPassphrase(host: string, passphrase: string | undefined): Promise<void>;
  /** Log lines (may name paths; never contents or passphrases). */
  log?(msg: string): void;
  /** Default `Date.now`. */
  now?(): number;
}

/** What the controller calls (ControllerDeps.clientCertUi). */
export interface ClientCertUi {
  /** Native picker → a one-use token (10 min) + the file's base name; undefined = cancelled. Throws a user-readable Error. */
  choose(role: ClientCertFileRole): Promise<{ token: string; name: string } | undefined>;
  /** Check, then save the entry (user level) and the passphrase. `problem` = nothing saved, the popup stays open. */
  add(req: { host: string; pfx?: string; cert?: string; key?: string; passphrase?: string }): Promise<{ problem?: string }>;
  /** Remove the user-level entry with this host (case-insensitive) and its passphrase. */
  remove(host: string): Promise<void>;
}
