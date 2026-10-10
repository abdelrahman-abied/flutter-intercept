import { execFileSync } from 'child_process';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterAll, describe, expect, it } from 'vitest';
import { CA_FILE, caProblem, CaStore, loadOrCreateCa, mockttpCaGenerator, spkiPin } from '../../src/ca';

const dirs: string[] = [];
const tmp = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'fi-ca-'));
  dirs.push(d);
  return path.join(d, 'globalStorage', 'ext');
};
afterAll(() => dirs.forEach((d) => fs.rmSync(d, { recursive: true, force: true })));

describe('per-install CA', () => {
  it('creates a CA with a random subject, key file 0600, and reuses it', async () => {
    const dir = tmp();
    const a = await loadOrCreateCa(dir);
    expect(a.created).toBe(true);
    expect(caProblem(a)).toBeUndefined();
    const x = new crypto.X509Certificate(a.cert);
    expect(x.ca).toBe(true);
    expect(x.subject).toMatch(/CN=Flutter Intercept CA [0-9a-f]{16}/);
    if (process.platform !== 'win32') {
      expect(fs.statSync(path.join(dir, CA_FILE)).mode & 0o777).toBe(0o600);
      expect(fs.statSync(dir).mode & 0o077).toBe(0);
    }
    const b = await loadOrCreateCa(dir);
    expect(b.created).toBe(false);
    expect(b.cert).toBe(a.cert);
    // A different install gets a different CA.
    const other = await loadOrCreateCa(tmp());
    expect(new crypto.X509Certificate(other.cert).subject).not.toBe(x.subject);
  }, 60_000);

  it('repairs a world-readable file and replaces an invalid one', async () => {
    const dir = tmp();
    const a = await loadOrCreateCa(dir);
    const file = path.join(dir, CA_FILE);
    if (process.platform !== 'win32') {
      fs.chmodSync(file, 0o644);
      await loadOrCreateCa(dir);
      expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    }
    // Key that does not match the certificate -> regenerated.
    const foreign = await mockttpCaGenerator('foreign');
    fs.writeFileSync(file, JSON.stringify({ key: foreign.key, cert: a.cert }));
    expect(caProblem({ key: foreign.key, cert: a.cert })).toMatch(/does not match/);
    const c = await loadOrCreateCa(dir);
    expect(c.created).toBe(true);
    expect(c.cert).not.toBe(a.cert);
    fs.writeFileSync(file, 'garbage');
    expect((await loadOrCreateCa(dir)).created).toBe(true);
  }, 60_000);

  it('flags CAs that expire soon', async () => {
    const a = await mockttpCaGenerator('x');
    const in20years = new Date(Date.now() + 20 * 365 * 24 * 3600_000);
    expect(caProblem(a, in20years)).toMatch(/expires soon/);
  }, 30_000);

  it('concurrent creators converge on one CA', async () => {
    const dir = tmp();
    const [a, b, c] = await Promise.all([loadOrCreateCa(dir), loadOrCreateCa(dir), loadOrCreateCa(dir)]);
    const onDisk = JSON.parse(fs.readFileSync(path.join(dir, CA_FILE), 'utf8')).cert;
    expect([a.cert, b.cert, c.cert]).toEqual([onDisk, onDisk, onDisk]);
    expect(fs.readdirSync(dir).filter((f) => f.endsWith('.tmp'))).toEqual([]);
  }, 60_000);

  it('CaStore memoizes and retries after a failure', async () => {
    let calls = 0;
    const store = new CaStore(tmp(), {
      generate: async (cn) => {
        calls++;
        if (calls === 1) throw new Error('boom');
        return mockttpCaGenerator(cn);
      },
    });
    await expect(store.get()).rejects.toThrow('boom');
    const a = await store.get();
    expect(await store.get()).toBe(a);
    expect(calls).toBe(2);
  }, 60_000);
});

/** openssl's SPKI pin of a PEM certificate, or undefined when openssl is not installed. */
function opensslPin(certPem: string): string | undefined {
  try {
    const pub = execFileSync('openssl', ['x509', '-pubkey', '-noout'], { input: certPem });
    const der = execFileSync('openssl', ['pkey', '-pubin', '-outform', 'der'], { input: pub });
    const digest = execFileSync('openssl', ['dgst', '-sha256', '-binary'], { input: der });
    return Buffer.from(digest).toString('base64');
  } catch {
    return undefined;
  }
}

describe('spkiPin (CONTRACTS §11.3, Chrome --ignore-certificate-errors-spki-list)', () => {
  it('equals openssl\'s base64(sha256(SPKI DER)) for the install CA', async () => {
    const a = await mockttpCaGenerator('pin-a');
    const pin = spkiPin(a.cert);
    expect(pin).toMatch(/^[A-Za-z0-9+/]{43}=$/); // 32 bytes, no comma (flutter splits --web-browser-flag on commas)
    const ref = opensslPin(a.cert);
    if (ref === undefined) console.warn('openssl not found: SPKI pin not cross-checked');
    else expect(pin).toBe(ref);
    // Pins the key, not the certificate: another CA (other key) differs, the same cert is stable.
    expect(spkiPin(a.cert)).toBe(pin);
    expect(spkiPin((await mockttpCaGenerator('pin-b')).cert)).not.toBe(pin);
  }, 60_000);

  it('throws on garbage', () => {
    expect(() => spkiPin('not a certificate')).toThrow();
  });
});
