/**
 * CONTRACTS §14.3: loads the `flutterIntercept.clientCertificates` setting (user settings only) into the
 * `ClientCertificate`s the proxy presents on upstream TLS (mTLS). No `vscode` import: the passphrase comes from an
 * injected getter (VS Code secret storage), the workspace folders are passed in.
 *
 * - Entries: `{host, pfx}` (PKCS#12) or `{host, cert, key}` (PEM); `host` is a hostname glob with an optional `:port`.
 * - Paths: absolute, `~/…`, or relative to a workspace folder (the first folder where the file exists). A relative
 *   path must stay inside its folder after resolving symlinks (a repo can't point it elsewhere); every path must end
 *   at a regular file of at most MAX_CLIENT_CERT_FILE_BYTES. Opened non-blocking (a FIFO can't hang the host) and
 *   re-checked on the open descriptor (no swap between check and read).
 * - Each certificate is tried with `tls.createSecureContext` (wrong / missing passphrase, mismatched key, garbage)
 *   so problems show before the first request.
 * - Problems are one sentence naming the host pattern and the field (`pfx` / `cert` / `key`), never a path, file
 *   contents or passphrase: they reach Status, the panel and agents. Only `log` lines name paths.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as tls from 'tls';
import type { ClientCertificate } from '@flutter-intercept/proxy';

export const MAX_CLIENT_CERT_FILE_BYTES = 1024 * 1024;
export const MAX_CLIENT_CERTS = 50;
/** Secret-storage key for one entry's passphrase (keyed by its host pattern). */
export const PASSPHRASE_SECRET_PREFIX = 'flutterIntercept.clientCertificatePassphrase:';

export function passphraseSecretKey(host: string): string {
  return `${PASSPHRASE_SECRET_PREFIX}${host.trim().toLowerCase()}`;
}

/** One entry of the setting as the user wrote it (paths, never contents). */
export interface ClientCertEntry {
  host: string;
  pfx?: string;
  cert?: string;
  key?: string;
}

export interface ClientCertStatus {
  host: string;
  problem?: string;
}

export interface ClientCertLoadDeps {
  /** Absolute paths of the workspace folders, in order (relative paths resolve against them). */
  workspaceFolders: () => readonly string[];
  /** The stored passphrase for an entry (by host pattern), or undefined. Never logged. */
  getPassphrase: (host: string) => Promise<string | undefined> | string | undefined;
  /** Default: `tls.createSecureContext(cert)`; throws when the certificate can't be used. */
  validate?: (cert: ClientCertificate) => void;
  /** Default: `os.homedir()` (for `~/` paths). */
  homeDir?: () => string;
  /** Log lines (may name paths; never contents or passphrases). */
  log?: (msg: string) => void;
}

export interface ClientCertLoadResult {
  /** Certificates that loaded, in setting order (the proxy presents the first match). */
  certs: ClientCertificate[];
  /** Entries that did not load (host pattern + one-sentence reason). */
  problems: ClientCertStatus[];
  /** Every entry with a host, in order, for `Status.clientCertificates`. */
  status: ClientCertStatus[];
}

const HOST = /^(\*\.)?[a-z0-9_*]([a-z0-9_*.-]{0,251}[a-z0-9_*])?(:\d{1,5})?$/;

/** A hostname glob with optional `:port`, lower-cased; undefined when invalid. */
export function normalizeCertHost(v: unknown): string | undefined {
  if (typeof v !== 'string') return undefined;
  const h = v.trim().toLowerCase();
  if (!h || h.length > 260 || !HOST.test(h) || h.includes('..')) return undefined;
  const port = /:(\d+)$/.exec(h)?.[1];
  if (port !== undefined && (Number(port) < 1 || Number(port) > 65535)) return undefined;
  return h;
}

class CertProblem extends Error {}

function defaultValidate(cert: ClientCertificate): void {
  tls.createSecureContext({
    ...(cert.pfx ? { pfx: cert.pfx } : {}),
    ...(cert.cert ? { cert: cert.cert } : {}),
    ...(cert.key ? { key: cert.key } : {}),
    ...(cert.passphrase !== undefined ? { passphrase: cert.passphrase } : {}),
  });
}

/** Turns an OpenSSL / Node error into a short reason without echoing anything the error might quote. */
function reasonOf(e: unknown, hasPassphrase: boolean): string {
  const msg = e instanceof Error ? e.message : String(e);
  if (/mac verify|bad decrypt|bad password|wrong password|passphrase|interrupted or cancelled|unable to decrypt|maybe wrong password/i.test(msg)) {
    return hasPassphrase
      ? 'the stored passphrase is wrong (run "Flutter Intercept: Set Client Certificate Passphrase…")'
      : 'it needs a passphrase (run "Flutter Intercept: Set Client Certificate Passphrase…")';
  }
  if (/key values mismatch/i.test(msg)) return "the key doesn't belong to the certificate";
  if (/no start line|bad base64|unsupported|asn1|not enough data|wrong tag|header too long|too long|decoder/i.test(msg)) return "the file isn't a valid certificate / key in the expected format";
  const code = (e as { code?: unknown })?.code;
  return typeof code === 'string' && /^[A-Z0-9_]{1,80}$/.test(code) ? `it can't be used (${code})` : "it can't be used";
}

function expandPath(p: string, deps: ClientCertLoadDeps): { abs?: string; folder?: string; candidates?: { abs: string; folder: string }[] } {
  if (p === '~' || p.startsWith('~/') || p.startsWith('~\\')) return { abs: path.join((deps.homeDir ?? os.homedir)(), p.slice(1)) };
  if (path.isAbsolute(p)) return { abs: path.normalize(p) };
  const folders = deps.workspaceFolders().filter((f) => typeof f === 'string' && path.isAbsolute(f));
  return { candidates: folders.map((f) => ({ abs: path.resolve(f, p), folder: f })) };
}

function inside(child: string, parent: string): boolean {
  const rel = path.relative(parent, child);
  return rel === '' ? false : !rel.startsWith('..') && !path.isAbsolute(rel);
}

/**
 * Reads one certificate file safely: realpath, inside its workspace folder for relative paths, a regular file ≤ 1 MB,
 * opened non-blocking and re-checked on the descriptor. Throws CertProblem with a path-free reason.
 */
async function readCertFile(field: 'pfx' | 'cert' | 'key', raw: unknown, deps: ClientCertLoadDeps): Promise<Buffer> {
  if (typeof raw !== 'string' || !raw.trim()) throw new CertProblem(`its ${field} path is empty`);
  const p = raw.trim();
  if (p.length > 4096 || p.includes('\0')) throw new CertProblem(`its ${field} path is not a valid path`);
  const where = expandPath(p, deps);
  let target: { abs: string; folder?: string } | undefined;
  if (where.abs) target = { abs: where.abs };
  else {
    if (!where.candidates?.length) throw new CertProblem(`its ${field} path is relative but no workspace folder is open (use an absolute path)`);
    for (const c of where.candidates) {
      try {
        await fs.promises.lstat(c.abs);
        target = c;
        break;
      } catch {
        // try the next folder
      }
    }
    if (!target) throw new CertProblem(`its ${field} file was not found`);
  }
  let real: string;
  try {
    real = await fs.promises.realpath(target.abs);
  } catch {
    throw new CertProblem(`its ${field} file was not found`);
  }
  if (target.folder) {
    let folderReal = target.folder;
    try {
      folderReal = await fs.promises.realpath(target.folder);
    } catch {
      // keep as given
    }
    if (!inside(real, folderReal)) throw new CertProblem(`its ${field} path leaves its workspace folder (directly or through a symbolic link); use an absolute path to a file you control`);
  }
  const st = await fs.promises.stat(real).catch(() => undefined);
  if (!st) throw new CertProblem(`its ${field} file was not found`);
  if (!st.isFile()) throw new CertProblem(`its ${field} path is not a regular file`);
  if (st.size > MAX_CLIENT_CERT_FILE_BYTES) throw new CertProblem(`its ${field} file is larger than 1 MB`);
  const flags = fs.constants.O_RDONLY | (fs.constants.O_NONBLOCK ?? 0) | (fs.constants.O_NOFOLLOW ?? 0);
  let fh: fs.promises.FileHandle;
  try {
    fh = await fs.promises.open(real, flags);
  } catch {
    throw new CertProblem(`its ${field} file can't be read`);
  }
  try {
    const fst = await fh.stat();
    if (!fst.isFile() || fst.dev !== st.dev || fst.ino !== st.ino) throw new CertProblem(`its ${field} file changed while it was being read`);
    if (fst.size > MAX_CLIENT_CERT_FILE_BYTES) throw new CertProblem(`its ${field} file is larger than 1 MB`);
    const buf = Buffer.alloc(MAX_CLIENT_CERT_FILE_BYTES + 1);
    let n = 0;
    for (;;) {
      const { bytesRead } = await fh.read(buf, n, buf.length - n, n);
      if (bytesRead === 0) break;
      n += bytesRead;
      if (n > MAX_CLIENT_CERT_FILE_BYTES) throw new CertProblem(`its ${field} file is larger than 1 MB`);
    }
    if (n === 0) throw new CertProblem(`its ${field} file is empty`);
    return buf.subarray(0, n);
  } catch (e) {
    if (e instanceof CertProblem) throw e;
    throw new CertProblem(`its ${field} file can't be read`);
  } finally {
    await fh.close().catch(() => undefined);
  }
}

function pemText(buf: Buffer, field: 'cert' | 'key'): string {
  const text = buf.toString('utf8');
  if (field === 'cert' && !/-----BEGIN CERTIFICATE-----/.test(text)) throw new CertProblem("its cert file isn't a PEM certificate (-----BEGIN CERTIFICATE-----)");
  if (field === 'key' && !/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/.test(text)) throw new CertProblem("its key file isn't a PEM private key (-----BEGIN … PRIVATE KEY-----)");
  return text;
}

/**
 * Loads the setting. Never throws: every entry either loads or gets a problem. At most MAX_CLIENT_CERTS entries.
 */
export async function loadClientCertificates(setting: unknown, deps: ClientCertLoadDeps): Promise<ClientCertLoadResult> {
  const certs: ClientCertificate[] = [];
  const problems: ClientCertStatus[] = [];
  const status: ClientCertStatus[] = [];
  if (setting === undefined || setting === null) return { certs, problems, status };
  const add = (host: string, problem?: string) => {
    const s = problem ? { host, problem: `Client certificate for ${host}: ${problem}.` } : { host };
    status.push(s);
    if (problem) problems.push(s as ClientCertStatus);
  };
  if (!Array.isArray(setting)) {
    add('(setting)', 'flutterIntercept.clientCertificates must be a list of {host, pfx} or {host, cert, key}');
    return { certs, problems, status };
  }
  const validate = deps.validate ?? defaultValidate;
  for (const [i, entry] of setting.entries()) {
    if (i >= MAX_CLIENT_CERTS) {
      add('(setting)', `only the first ${MAX_CLIENT_CERTS} entries are used`);
      break;
    }
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      add(`(entry ${i + 1})`, 'each entry must be an object {host, pfx} or {host, cert, key}');
      continue;
    }
    const e = entry as Record<string, unknown>;
    const host = normalizeCertHost(e.host);
    if (!host) {
      add(`(entry ${i + 1})`, 'host must be a host name glob such as api.example.com or *.corp.example:8443');
      continue;
    }
    const hasPfx = e.pfx !== undefined && e.pfx !== '';
    const hasPem = (e.cert !== undefined && e.cert !== '') || (e.key !== undefined && e.key !== '');
    if (hasPfx === hasPem) {
      add(host, 'give either pfx (a .p12 / .pfx file) or cert and key (PEM files)');
      continue;
    }
    try {
      let cert: ClientCertificate;
      if (hasPfx) {
        cert = { host, pfx: await readCertFile('pfx', e.pfx, deps) };
      } else {
        if (e.cert === undefined || e.cert === '') throw new CertProblem('it has a key but no cert');
        if (e.key === undefined || e.key === '') throw new CertProblem('it has a cert but no key');
        cert = { host, cert: pemText(await readCertFile('cert', e.cert, deps), 'cert'), key: pemText(await readCertFile('key', e.key, deps), 'key') };
      }
      let passphrase: string | undefined;
      try {
        const p = await deps.getPassphrase(host);
        passphrase = typeof p === 'string' && p.length > 0 ? p : undefined;
      } catch {
        passphrase = undefined;
      }
      if (passphrase !== undefined) cert.passphrase = passphrase;
      try {
        validate(cert);
      } catch (err) {
        throw new CertProblem(reasonOf(err, passphrase !== undefined));
      }
      certs.push(cert);
      add(host);
      deps.log?.(`client certificate for ${host} loaded`);
    } catch (err) {
      const why = err instanceof CertProblem ? err.message : "it can't be used";
      add(host, why);
      deps.log?.(`client certificate for ${host} not loaded: ${why}`);
    }
  }
  return { certs, problems, status };
}

/** The entries' host patterns (for the "Set Client Certificate Passphrase…" quick pick), valid ones only, deduplicated. */
export function clientCertHosts(setting: unknown): string[] {
  if (!Array.isArray(setting)) return [];
  const out: string[] = [];
  for (const e of setting.slice(0, MAX_CLIENT_CERTS)) {
    const h = e && typeof e === 'object' ? normalizeCertHost((e as Record<string, unknown>).host) : undefined;
    if (h && !out.includes(h)) out.push(h);
  }
  return out;
}
