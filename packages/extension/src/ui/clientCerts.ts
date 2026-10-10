/**
 * CONTRACTS §14.3: loads the `flutterIntercept.clientCertificates` setting (user settings only) into the
 * `ClientCertificate`s the proxy presents on upstream TLS (mTLS). No `vscode` import: the passphrase comes from an
 * injected getter (VS Code secret storage), the workspace folders are passed in.
 *
 * - Entries: `{host, pfx}` (PKCS#12) or `{host, cert, key}` (PEM); `host` is a hostname glob with an optional `:port`.
 * - Paths: absolute or `~/…` only (REVIEW-8 #9: a relative path would resolve inside whatever repository is open, so a
 *   cloned repo could supply the certificate). Every path must end at a regular file of at most
 *   MAX_CLIENT_CERT_FILE_BYTES. Opened non-blocking (a FIFO can't hang the host) and re-checked on the open descriptor
 *   (no swap between check and read).
 * - Host patterns are checked with the proxy's own `parseHostPattern` (REVIEW-8 #4), so host and proxy agree.
 * - Each certificate is tried with `tls.createSecureContext` (wrong / missing passphrase, mismatched key, garbage)
 *   so problems show before the first request.
 * - Problems are one sentence naming the host pattern and the field (`pfx` / `cert` / `key`), never a path, file
 *   contents or passphrase: they reach Status, the panel and agents. Only `log` lines name paths.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as tls from 'tls';
import { parseHostPattern, type ClientCertificate } from '@flutter-intercept/proxy';

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
  /** Unused since REVIEW-8 #9 (relative paths are refused); accepted so existing callers keep compiling. */
  workspaceFolders?: () => readonly string[];
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

/** Why a host pattern is refused (the proxy's `parseHostPattern` message), or undefined when it is fine. */
export function certHostProblem(v: unknown): string | undefined {
  if (typeof v !== 'string' || !v.trim()) return 'host must be a host name pattern such as api.example.com or *.corp.example:8443';
  if (v.trim().length > 260) return 'host is too long';
  try {
    parseHostPattern(v.trim().toLowerCase());
    return undefined;
  } catch (e) {
    return (e instanceof Error ? e.message : String(e)).replace(/[\r\n]+/g, ' ').slice(0, 300);
  }
}

/** A host pattern with optional `:port`, lower-cased, as the proxy accepts it (REVIEW-8 #4); undefined when refused. */
export function normalizeCertHost(v: unknown): string | undefined {
  return certHostProblem(v) === undefined ? (v as string).trim().toLowerCase() : undefined;
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

/** Absolute or `~/` paths only (REVIEW-8 #9); undefined for anything relative. */
function expandPath(p: string, deps: ClientCertLoadDeps): string | undefined {
  if (p === '~' || p.startsWith('~/') || p.startsWith('~\\')) return path.join((deps.homeDir ?? os.homedir)(), p.slice(1));
  if (path.isAbsolute(p)) return path.normalize(p);
  return undefined;
}

/**
 * Reads one certificate file safely: absolute / `~/` only, realpath, a regular file ≤ 1 MB, opened non-blocking and
 * re-checked on the descriptor. Throws CertProblem with a path-free reason.
 */
async function readCertFile(field: 'pfx' | 'cert' | 'key', raw: unknown, deps: ClientCertLoadDeps): Promise<Buffer> {
  if (typeof raw !== 'string' || !raw.trim()) throw new CertProblem(`its ${field} path is empty`);
  const p = raw.trim();
  if (p.length > 4096 || p.includes('\0')) throw new CertProblem(`its ${field} path is not a valid path`);
  const abs = expandPath(p, deps);
  if (!abs) throw new CertProblem(`its ${field} path is relative; use an absolute path (or ~/…): a relative path could pick up a file from a cloned repository`);
  let real: string;
  try {
    real = await fs.promises.realpath(abs);
  } catch {
    throw new CertProblem(`its ${field} file was not found`);
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
    const hostProblem = certHostProblem(e.host);
    if (hostProblem !== undefined) {
      add(`(entry ${i + 1})`, `its host can't be used: ${hostProblem}`);
      continue;
    }
    const host = (e.host as string).trim().toLowerCase();
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
