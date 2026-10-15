/**
 * CONTRACTS §20.3: adding / removing client certificates from the traffic panel. vscode-free: the extension and the
 * sidecar (Android Studio plugin) each pass a small `ClientCertPlatform`; `createClientCertUi` holds the file tokens and
 * the checks. The webview only ever sees a token and a file's base name — never a path — and the passphrase is never
 * logged, echoed back or kept.
 *
 * - Tokens: random, valid CERT_TOKEN_TTL_MS (10 min), for one role (`pfx` / `cert` / `key`); used up by a successful
 *   save (a failed save keeps them, so the popup can be fixed and saved again). Unknown / expired → a problem. At most
 *   MAX_CERT_TOKENS outstanding (the oldest go first). Binding a token to the panel it was issued to is the
 *   controller's job (InterceptController.certTokens).
 * - Files: the §14.3 loader rules (src/ui/clientCerts.ts `readCertFile`: absolute, a regular file ≤ 1 MB, opened
 *   non-blocking, re-checked on the descriptor), checked when chosen and again when saved; then
 *   `tls.createSecureContext` with the passphrase.
 * - Writes: the **user-level** entries only (`platform.readEntries` / `writeEntries`): an entry with the same host
 *   (case-insensitive) is replaced where it is, a new one goes first (the proxy presents the first match, and the user
 *   just asked for this one); at most MAX_CLIENT_CERTS. A new passphrase is stored before the entry is written (so the
 *   reload the write triggers already sees it) and, REVIEW-14 #4, put back as it was when the write fails (the previous
 *   one read through `getPassphrase`; without it the new one stays). An empty passphrase deletes the stored one only
 *   after the write succeeded. Saves and removals run one at a time.
 * - Remove: REVIEW-14 #4 — the IDE confirms natively (`confirmRemove`) before anything is changed; the webview's own
 *   confirmation isn't enough (it is the least trusted part). Cancelled → nothing changes, `{cancelled: true}`.
 * - REVIEW-14 #6: one file chooser at a time (a second `choose` while one is open → CERT_CHOOSER_OPEN).
 * - Problems are plain sentences without paths, file contents or the passphrase (the loader's texts).
 */
import * as crypto from 'crypto';
import * as path from 'path';
import type { ClientCertificate } from '@flutter-intercept/proxy';
import { CertProblem, certHostProblem, defaultValidate, MAX_CLIENT_CERTS, pemText, readCertFile, reasonOf, type ClientCertEntry } from './clientCerts';
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
  /**
   * REVIEW-14 #4, optional: the stored passphrase for a host pattern (undefined = none), read before a save replaces it
   * so it can be put back when writing the entries fails. Without it a failed write leaves the new passphrase stored.
   */
  getPassphrase?(host: string): Promise<string | undefined> | string | undefined;
  /**
   * REVIEW-14 #4, optional: ask the user in the IDE (a native modal) before removing the certificate for `host`;
   * resolves true to go ahead. Without it, removal isn't confirmed by the host (only by the panel).
   */
  confirmRemove?(host: string): Promise<boolean>;
  /**
   * Optional: reload the certificates into the proxy after a save / removal (which also forgets the host's learned
   * passthrough, §20.1). Leave it out when writing the entries already triggers a reload (VS Code's config listener).
   */
  reload?(): Promise<void> | void;
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
  /**
   * Remove the user-level entry with this host (case-insensitive) and its passphrase, after the IDE's confirmation
   * (`platform.confirmRemove`); `cancelled` = the user said no, nothing changed. Throws a user-readable Error.
   */
  remove(host: string): Promise<{ cancelled?: true }>;
}

/** CONTRACTS §20.3: the controller's answer when no `clientCertUi` is wired. */
export const CLIENT_CERT_UI_MISSING = "Adding client certificates isn't available here.";
export const CERT_TOKEN_TTL_MS = 10 * 60_000;
export const MAX_CERT_TOKENS = 50;
export const MAX_CERT_PASSPHRASE_CHARS = 1024;
/** What a token looks like (the controller checks message fields against it). */
export const CERT_TOKEN_RE = /^[A-Za-z0-9_-]{16,64}$/;
const ROLES: readonly ClientCertFileRole[] = ['pfx', 'cert', 'key'];

export const CERT_TOKEN_EXPIRED = 'The chosen file is no longer valid (choices last 10 minutes): choose it again.';
export const CERT_CHOOSER_OPEN = 'A file chooser is already open.';
export const CERT_GIVE_FILES = 'Choose a PKCS#12 file (.p12 / .pfx), or a PEM certificate and its private key.';

export interface ClientCertUiOptions {
  /** Default: `tls.createSecureContext` (src/ui/clientCerts.ts `defaultValidate`). */
  validate?: (cert: ClientCertificate) => void;
}

interface Chosen {
  role: ClientCertFileRole;
  file: string;
  expires: number;
}

/** A loader problem ("its key file is larger than 1 MB") as a sentence of its own ("The key file is larger than 1 MB."). */
function sentence(reason: string): string {
  const r = reason.replace(/^its /, 'the ').replace(/^it /, 'this certificate ');
  return `${r.charAt(0).toUpperCase()}${r.slice(1)}${/[.!?]$/.test(r) ? '' : '.'}`;
}

function problemOf(e: unknown): string {
  return e instanceof CertProblem ? sentence(e.message) : "The file can't be read.";
}

/** The file's base name for the panel: no folders, no control characters, at most 200 characters. */
function displayName(file: string): string {
  const base = path.basename(file).replace(/[\u0000-\u001f\u007f]/g, '');
  return (base || 'file').slice(0, 200);
}

function sameHost(entry: unknown, host: string): boolean {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return false;
  const h = (entry as Record<string, unknown>).host;
  return typeof h === 'string' && h.trim().toLowerCase() === host;
}

export function createClientCertUi(platform: ClientCertPlatform, opts: ClientCertUiOptions = {}): ClientCertUi {
  const tokens = new Map<string, Chosen>();
  let picking = false;
  const now = () => platform.now?.() ?? Date.now();
  const validate = opts.validate ?? defaultValidate;
  // One save / removal at a time (each reads, changes and writes the whole user-level list).
  let queue: Promise<unknown> = Promise.resolve();
  const serial = <T>(fn: () => Promise<T>): Promise<T> => {
    const run = queue.then(fn, fn);
    queue = run.catch(() => undefined);
    return run;
  };
  const prune = () => {
    const t = now();
    for (const [k, c] of tokens) if (c.expires <= t) tokens.delete(k);
  };
  const lookup = (token: string | undefined, role: ClientCertFileRole): Chosen | undefined => {
    if (token === undefined) return undefined;
    const c = typeof token === 'string' ? tokens.get(token) : undefined;
    if (!c || c.role !== role || c.expires <= now()) throw new CertProblem(CERT_TOKEN_EXPIRED);
    return c;
  };
  const readEntries = async (): Promise<unknown[]> => {
    const raw = await platform.readEntries();
    if (raw === undefined || raw === null) return [];
    if (!Array.isArray(raw)) throw new CertProblem("flutterIntercept.clientCertificates in your user settings isn't a list: fix or remove it first.");
    return [...raw];
  };
  const reload = async () => {
    try {
      await platform.reload?.();
    } catch (e) {
      platform.log?.(`client certificates: reload failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  return {
    async choose(role) {
      if (!ROLES.includes(role)) throw new Error('Unknown certificate file kind.');
      // REVIEW-14 #6: one native chooser at a time (a compromised panel can't queue them)
      if (picking) throw new Error(CERT_CHOOSER_OPEN);
      let file: string | undefined;
      picking = true;
      try {
        file = await platform.pickFile(role);
      } finally {
        picking = false;
      }
      if (file === undefined || file === null) return undefined;
      if (typeof file !== 'string' || !path.isAbsolute(file)) throw new Error("That file can't be used: choose a file on this computer.");
      try {
        const buf = await readCertFile(role, file, {});
        if (role !== 'pfx') pemText(buf, role);
      } catch (e) {
        throw new Error(problemOf(e));
      }
      prune();
      while (tokens.size >= MAX_CERT_TOKENS) tokens.delete(tokens.keys().next().value as string);
      const token = crypto.randomBytes(24).toString('base64url');
      tokens.set(token, { role, file, expires: now() + CERT_TOKEN_TTL_MS });
      platform.log?.(`client certificate: ${role} file chosen: ${file}`);
      return { token, name: displayName(file) };
    },

    add(req) {
      return serial(async () => {
        const hostProblem = certHostProblem(req?.host);
        if (hostProblem !== undefined) return { problem: sentence(`the host can't be used: ${hostProblem}`) };
        const host = req.host.trim().toLowerCase();
        const passphrase = typeof req.passphrase === 'string' && req.passphrase.length > 0 ? req.passphrase : undefined;
        if (passphrase !== undefined && passphrase.length > MAX_CERT_PASSPHRASE_CHARS) return { problem: 'The passphrase is too long.' };
        try {
          const hasPfx = req.pfx !== undefined;
          const hasPem = req.cert !== undefined || req.key !== undefined;
          if (hasPfx === hasPem) throw new CertProblem(CERT_GIVE_FILES);
          let cert: ClientCertificate;
          let entry: ClientCertEntry;
          const used: string[] = [];
          if (hasPfx) {
            const pfx = lookup(req.pfx, 'pfx') as Chosen;
            used.push(req.pfx as string);
            cert = { host, pfx: await readCertFile('pfx', pfx.file, {}) };
            entry = { host, pfx: pfx.file };
          } else {
            if (req.cert === undefined) throw new CertProblem('Choose the certificate file too (PEM).');
            if (req.key === undefined) throw new CertProblem('Choose the private key file too (PEM).');
            const c = lookup(req.cert, 'cert') as Chosen;
            const k = lookup(req.key, 'key') as Chosen;
            used.push(req.cert, req.key);
            cert = { host, cert: pemText(await readCertFile('cert', c.file, {}), 'cert'), key: pemText(await readCertFile('key', k.file, {}), 'key') };
            entry = { host, cert: c.file, key: k.file };
          }
          if (passphrase !== undefined) cert.passphrase = passphrase;
          try {
            validate(cert);
          } catch (err) {
            throw new CertProblem(reasonOf(err, passphrase !== undefined, 'panel'));
          }
          const entries = await readEntries();
          const at = entries.findIndex((e) => sameHost(e, host));
          const next = at >= 0 ? entries.map((e, i) => (i === at ? entry : e)).filter((e, i) => i === at || !sameHost(e, host)) : [entry, ...entries];
          if (next.length > MAX_CLIENT_CERTS) throw new CertProblem(`You already have ${MAX_CLIENT_CERTS} client certificates: remove one first.`);
          // REVIEW-14 #4: a new passphrase goes first (the reload the write triggers sees it) and is put back as it was
          // when the write fails; an empty one deletes the stored one only once the entry is written.
          let previous: { value: string | undefined } | undefined;
          if (passphrase !== undefined) {
            if (platform.getPassphrase) {
              try {
                const p = await platform.getPassphrase(host);
                previous = { value: typeof p === 'string' && p.length > 0 ? p : undefined };
              } catch (e) {
                platform.log?.(`client certificate for ${host}: reading the stored passphrase failed: ${e instanceof Error ? e.message : String(e)}`);
              }
            }
            try {
              await platform.setPassphrase(host, passphrase);
            } catch (e) {
              platform.log?.(`client certificate for ${host}: storing the passphrase failed: ${e instanceof Error ? e.message : String(e)}`);
              throw new CertProblem("Couldn't store the passphrase in the IDE's secret storage.");
            }
          }
          try {
            await platform.writeEntries(next as ClientCertEntry[]);
          } catch (e) {
            platform.log?.(`client certificate for ${host}: writing the user settings failed: ${e instanceof Error ? e.message : String(e)}`);
            if (passphrase !== undefined && previous) {
              try {
                await platform.setPassphrase(host, previous.value);
              } catch (e2) {
                platform.log?.(`client certificate for ${host}: putting the previous passphrase back failed: ${e2 instanceof Error ? e2.message : String(e2)}`);
              }
            }
            throw new CertProblem("Couldn't save the certificate in your user settings (see the Flutter Intercept log).");
          }
          if (passphrase === undefined) {
            try {
              await platform.setPassphrase(host, undefined);
            } catch (e) {
              platform.log?.(`client certificate for ${host}: deleting the old passphrase failed: ${e instanceof Error ? e.message : String(e)}`);
            }
          }
          for (const t of used) tokens.delete(t);
          platform.log?.(`client certificate for ${host} saved to the user settings`);
          await reload();
          return {};
        } catch (e) {
          if (e instanceof CertProblem) return { problem: sentence(e.message) };
          platform.log?.(`client certificate for ${host}: ${e instanceof Error ? e.message : String(e)}`);
          return { problem: `The certificate for ${host} couldn't be saved.` };
        }
      });
    },

    remove(rawHost) {
      return serial(async () => {
        if (typeof rawHost !== 'string' || !rawHost.trim() || rawHost.length > 300) throw new Error('Which client certificate? The host is missing.');
        const host = rawHost.trim().toLowerCase();
        let entries: unknown[];
        try {
          entries = await readEntries();
        } catch (e) {
          throw new Error(e instanceof CertProblem ? e.message : "Couldn't read your user settings.");
        }
        const next = entries.filter((e) => !sameHost(e, host));
        if (next.length === entries.length) throw new Error(`No client certificate for ${host} is in your user settings.`);
        // REVIEW-14 #4: the IDE confirms before anything changes (the panel's own confirmation isn't enough)
        if (platform.confirmRemove) {
          let ok = false;
          try {
            ok = (await platform.confirmRemove(host)) === true;
          } catch (e) {
            platform.log?.(`client certificate for ${host}: the confirmation failed: ${e instanceof Error ? e.message : String(e)}`);
          }
          if (!ok) return { cancelled: true as const };
        }
        // the list may have changed while the question was open
        const latest = await readEntries().catch(() => entries);
        const after = latest.filter((e) => !sameHost(e, host));
        if (after.length === latest.length) return {};
        try {
          await platform.writeEntries(after as ClientCertEntry[]);
        } catch (e) {
          platform.log?.(`client certificate for ${host}: writing the user settings failed: ${e instanceof Error ? e.message : String(e)}`);
          throw new Error("Couldn't update your user settings (see the Flutter Intercept log).");
        }
        try {
          await platform.setPassphrase(host, undefined);
        } catch (e) {
          platform.log?.(`client certificate for ${host}: deleting the passphrase failed: ${e instanceof Error ? e.message : String(e)}`);
        }
        platform.log?.(`client certificate for ${host} removed from the user settings`);
        await reload();
        return {};
      });
    },
  };
}
