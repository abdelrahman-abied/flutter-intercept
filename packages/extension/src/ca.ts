/**
 * Per-install CA (CONTRACTS §1/§6): generated once with a random subject, persisted in the
 * extension's global storage, private key file mode 0600. The proxy signs per-host leaf
 * certificates with it; generated entries embed only its certificate and *trust* it, so the app
 * verifies proxy certificates normally and never accepts arbitrary certificates.
 *
 * No `vscode` import: unit-tested with vitest.
 */
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

export interface CaPair {
  /** PEM private key. Never leaves the development machine. */
  key: string;
  /** PEM CA certificate (embedded in generated entries). */
  cert: string;
}

/** Creates a CA certificate + key for the given subject common name. */
export type CaGenerator = (commonName: string) => Promise<CaPair>;

export const CA_FILE = 'flutter-intercept-ca.json';
/** Regenerate when the CA expires within this many days. */
export const CA_MIN_REMAINING_DAYS = 30;

/** mockttp's CA generator (already bundled for the proxy), loaded lazily. */
export const mockttpCaGenerator: CaGenerator = async (commonName) => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { generateCACertificate } = require('mockttp/dist/util/certificates') as {
    generateCACertificate(o: { subject?: Record<string, string>; bits?: number }): Promise<CaPair>;
  };
  const ca = await generateCACertificate({
    subject: { commonName, organizationName: 'Flutter Intercept (local development only)' },
    bits: 2048,
  });
  return { key: ca.key, cert: ca.cert };
};

export function randomCommonName(): string {
  return `Flutter Intercept CA ${crypto.randomBytes(8).toString('hex')}`;
}

/** Why `pair` is unusable as our CA at `now`, or undefined when it is fine. */
export function caProblem(pair: Partial<CaPair> | undefined, now: Date = new Date()): string | undefined {
  if (!pair || typeof pair.key !== 'string' || typeof pair.cert !== 'string') return 'missing key or certificate';
  try {
    const x = new crypto.X509Certificate(pair.cert);
    if (!x.ca) return 'certificate is not a CA';
    if (new Date(x.validFrom).getTime() > now.getTime() + 24 * 3600_000) return 'certificate is not valid yet';
    if (new Date(x.validTo).getTime() < now.getTime() + CA_MIN_REMAINING_DAYS * 24 * 3600_000) return 'certificate expires soon';
    if (!x.checkPrivateKey(crypto.createPrivateKey(pair.key))) return 'key does not match certificate';
  } catch (e) {
    return `unreadable: ${(e as Error).message}`;
  }
  return undefined;
}

async function readPair(file: string): Promise<CaPair | undefined> {
  try {
    return JSON.parse(await fs.promises.readFile(file, 'utf8')) as CaPair;
  } catch {
    return undefined;
  }
}

export interface LoadCaOptions {
  generate?: CaGenerator;
  now?: Date;
  log?: (msg: string) => void;
}

/**
 * Loads the CA from `<dir>/flutter-intercept-ca.json`, creating (or replacing an invalid/expiring)
 * one. Creation is atomic (`link` of a 0600 temp file): concurrent windows converge on one CA.
 */
export async function loadOrCreateCa(dir: string, opts: LoadCaOptions = {}): Promise<CaPair & { created: boolean }> {
  const log = opts.log ?? (() => undefined);
  const file = path.join(dir, CA_FILE);
  await fs.promises.mkdir(dir, { recursive: true, mode: 0o700 });
  const existing = await readPair(file);
  const problem = existing ? caProblem(existing, opts.now) : 'not created yet';
  if (existing && !problem) {
    await tightenMode(file, log);
    return { key: existing.key, cert: existing.cert, created: false };
  }
  const fresh = await (opts.generate ?? mockttpCaGenerator)(randomCommonName());
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  await fs.promises.writeFile(tmp, JSON.stringify({ key: fresh.key, cert: fresh.cert }), { mode: 0o600, flag: 'wx' });
  try {
    if (existing) {
      // Invalid or expiring: replace it.
      await fs.promises.rename(tmp, file);
      log(`CA ${problem}: generated a new one in ${file}`);
      return { ...fresh, created: true };
    }
    try {
      await fs.promises.link(tmp, file);
      log(`generated this install's CA in ${file}`);
      return { ...fresh, created: true };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      // Another window created it first: use theirs.
      const theirs = await readPair(file);
      if (theirs && !caProblem(theirs, opts.now)) return { key: theirs.key, cert: theirs.cert, created: false };
      await fs.promises.rename(tmp, file);
      return { ...fresh, created: true };
    }
  } finally {
    await fs.promises.unlink(tmp).catch(() => undefined);
  }
}

async function tightenMode(file: string, log: (msg: string) => void): Promise<void> {
  if (process.platform === 'win32') return;
  try {
    const st = await fs.promises.stat(file);
    if ((st.mode & 0o077) !== 0) {
      await fs.promises.chmod(file, 0o600);
      log(`CA file was readable by others: reset to 0600 (${file})`);
    }
  } catch {
    // ignore
  }
}

/** Memoizing accessor used by the extension (the CA is loaded/created on first use only). */
export class CaStore {
  private pending?: Promise<CaPair>;
  constructor(private readonly dir: string, private readonly opts: LoadCaOptions = {}) {}

  get(): Promise<CaPair> {
    this.pending ??= loadOrCreateCa(this.dir, this.opts)
      .then(({ key, cert }) => ({ key, cert }))
      .catch((e) => {
        this.pending = undefined; // retry on the next launch
        throw e;
      });
    return this.pending;
  }
}
