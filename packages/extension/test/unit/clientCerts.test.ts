// CONTRACTS §14.3: loading `flutterIntercept.clientCertificates` — real temp files, real `tls.createSecureContext` for
// PEM pairs (generated at run time), path rules (relative inside the workspace, symlinks, regular files ≤ 1 MB,
// FIFOs never block), passphrases from the injected getter, and problems that never carry paths, contents or
// passphrases.
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { clientCertHosts, loadClientCertificates, MAX_CLIENT_CERT_FILE_BYTES, normalizeCertHost, passphraseSecretKey, type ClientCertLoadDeps } from '../../src/ui/clientCerts';

let dir: string;
let ws: string;
let outside: string;
let pair: { key: string; cert: string };
let other: { key: string; cert: string };
const PASS = ['pass', 'phrase', String(Date.now())].join('-'); // built at run time

beforeAll(async () => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fi-certs-')));
  ws = path.join(dir, 'ws');
  outside = path.join(dir, 'outside');
  fs.mkdirSync(path.join(ws, 'certs'), { recursive: true });
  fs.mkdirSync(outside);
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { generateCACertificate } = require('mockttp/dist/util/certificates') as { generateCACertificate(o: { subject?: Record<string, string>; bits?: number }): Promise<{ key: string; cert: string }> };
  pair = await generateCACertificate({ subject: { commonName: 'fi test client' }, bits: 2048 });
  other = await generateCACertificate({ subject: { commonName: 'fi other' }, bits: 2048 });
  fs.writeFileSync(path.join(ws, 'certs', 'client.crt'), pair.cert);
  fs.writeFileSync(path.join(ws, 'certs', 'client.key'), pair.key);
  fs.writeFileSync(path.join(ws, 'certs', 'other.key'), other.key);
  const encrypted = crypto.createPrivateKey(pair.key).export({ type: 'pkcs8', format: 'pem', cipher: 'aes-256-cbc', passphrase: PASS }) as string;
  fs.writeFileSync(path.join(ws, 'certs', 'client.enc.key'), encrypted);
  fs.writeFileSync(path.join(outside, 'secret.key'), pair.key);
  fs.writeFileSync(path.join(ws, 'certs', 'client.p12'), Buffer.from([0x30, 0x82, 0x01, 0x00, 1, 2, 3]));
  fs.writeFileSync(path.join(ws, 'certs', 'empty.crt'), '');
  fs.writeFileSync(path.join(ws, 'certs', 'notpem.crt'), 'hello');
  fs.writeFileSync(path.join(ws, 'certs', 'big.p12'), Buffer.alloc(MAX_CLIENT_CERT_FILE_BYTES + 1));
  fs.symlinkSync(path.join(outside, 'secret.key'), path.join(ws, 'certs', 'escape.key'));
  fs.symlinkSync(outside, path.join(ws, 'certs', 'dirlink'));
  fs.symlinkSync(path.join(ws, 'certs', 'client.crt'), path.join(ws, 'certs', 'inside-link.crt'));
});

afterAll(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function deps(over: Partial<ClientCertLoadDeps> = {}, logs: string[] = []): ClientCertLoadDeps {
  return { workspaceFolders: () => [ws], getPassphrase: () => undefined, log: (m) => logs.push(m), ...over };
}

describe('normalizeCertHost / clientCertHosts / passphraseSecretKey', () => {
  it('accepts hostname globs with an optional port', () => {
    expect(normalizeCertHost(' API.Corp.example ')).toBe('api.corp.example');
    expect(normalizeCertHost('*.corp.example:8443')).toBe('*.corp.example:8443');
    expect(normalizeCertHost('x:0')).toBeUndefined();
    expect(normalizeCertHost('x:70000')).toBeUndefined();
    expect(normalizeCertHost('https://x')).toBeUndefined();
    expect(normalizeCertHost(5)).toBeUndefined();
    expect(clientCertHosts([{ host: 'A.example' }, { host: 'a.example' }, { host: 'bad host' }, null, { host: 'b.example:443' }])).toEqual(['a.example', 'b.example:443']);
    expect(clientCertHosts('x')).toEqual([]);
    expect(passphraseSecretKey(' A.Example ')).toBe('flutterIntercept.clientCertificatePassphrase:a.example');
  });
});

describe('loadClientCertificates (CONTRACTS §14.3)', () => {
  it('loads a PEM pair by workspace-relative paths (real TLS context) and an absolute one', async () => {
    const logs: string[] = [];
    const r = await loadClientCertificates(
      [
        { host: 'api.corp.example', cert: 'certs/client.crt', key: 'certs/client.key' },
        { host: '*.corp.example:8443', cert: path.join(ws, 'certs', 'inside-link.crt'), key: path.join(ws, 'certs', 'client.key') },
      ],
      deps({}, logs),
    );
    expect(r.problems).toEqual([]);
    expect(r.status).toEqual([{ host: 'api.corp.example' }, { host: '*.corp.example:8443' }]);
    expect(r.certs).toHaveLength(2);
    expect(r.certs[0]).toEqual({ host: 'api.corp.example', cert: pair.cert, key: pair.key });
    expect(logs.join('\n')).not.toContain('PRIVATE KEY');
  });

  it('home-relative paths', async () => {
    const r = await loadClientCertificates([{ host: 'a.example', cert: '~/certs/client.crt', key: '~/certs/client.key' }], deps({ homeDir: () => ws }));
    expect(r.certs).toHaveLength(1);
  });

  it('encrypted key: passphrase from the getter; missing / wrong passphrase → problem naming the command, never the passphrase', async () => {
    const entry = [{ host: 'secure.example', cert: 'certs/client.crt', key: 'certs/client.enc.key' }];
    const asked: string[] = [];
    const ok = await loadClientCertificates(entry, deps({ getPassphrase: (h) => (asked.push(h), PASS) }));
    expect(asked).toEqual(['secure.example']);
    expect(ok.problems).toEqual([]);
    expect(ok.certs[0].passphrase).toBe(PASS);

    const missing = await loadClientCertificates(entry, deps());
    expect(missing.certs).toEqual([]);
    expect(missing.problems[0].problem).toMatch(/needs a passphrase.*Set Client Certificate Passphrase/);

    const logs: string[] = [];
    const wrong = await loadClientCertificates(entry, deps({ getPassphrase: async () => 'nope-wrong-value' }, logs));
    expect(wrong.problems[0].problem).toMatch(/stored passphrase is wrong/);
    expect(JSON.stringify([wrong, logs])).not.toContain('nope-wrong-value');

    const throwing = await loadClientCertificates(entry, deps({ getPassphrase: () => Promise.reject(new Error('secret storage down')) }));
    expect(throwing.problems[0].problem).toMatch(/needs a passphrase/);
  });

  it('a key that does not belong to the certificate', async () => {
    const r = await loadClientCertificates([{ host: 'a.example', cert: 'certs/client.crt', key: 'certs/other.key' }], deps());
    expect(r.problems[0].problem).toMatch(/key doesn't belong to the certificate/);
  });

  it('pfx: read as bytes and validated (injected validator sees bytes + passphrase); garbage fails the real check', async () => {
    const seen: unknown[] = [];
    const r = await loadClientCertificates([{ host: 'p12.example', pfx: 'certs/client.p12' }], deps({ getPassphrase: () => PASS, validate: (c) => seen.push(c) }));
    expect(r.problems).toEqual([]);
    expect(Buffer.isBuffer(r.certs[0].pfx)).toBe(true);
    expect(r.certs[0].pfx).toHaveLength(7);
    expect(seen).toHaveLength(1);
    const real = await loadClientCertificates([{ host: 'p12.example', pfx: 'certs/client.p12' }], deps());
    expect(real.certs).toEqual([]);
    expect(real.problems[0].problem).toMatch(/^Client certificate for p12\.example: /);
  });

  it('path rules: symlink out of the workspace, ".." out of it, directory, too big, empty, not PEM, missing, no workspace', async () => {
    const cases: [Record<string, unknown>, RegExp][] = [
      [{ host: 'a.example', cert: 'certs/client.crt', key: 'certs/escape.key' }, /key path leaves its workspace folder/],
      [{ host: 'a.example', cert: 'certs/client.crt', key: '../outside/secret.key' }, /key path leaves its workspace folder/],
      [{ host: 'a.example', pfx: 'certs/dirlink' }, /leaves its workspace folder/],
      [{ host: 'a.example', pfx: path.join(ws, 'certs', 'dirlink') }, /pfx path is not a regular file/],
      [{ host: 'a.example', pfx: 'certs/big.p12' }, /larger than 1 MB/],
      [{ host: 'a.example', cert: 'certs/empty.crt', key: 'certs/client.key' }, /cert file is empty/],
      [{ host: 'a.example', cert: 'certs/notpem.crt', key: 'certs/client.key' }, /isn't a PEM certificate/],
      [{ host: 'a.example', cert: 'certs/client.crt', key: 'certs/client.crt' }, /isn't a PEM private key/],
      [{ host: 'a.example', pfx: 'certs/nope.p12' }, /pfx file was not found/],
      [{ host: 'a.example', pfx: 'x\0y' }, /not a valid path/],
    ];
    for (const [entry, re] of cases) {
      const r = await loadClientCertificates([entry], deps());
      expect(r.certs, JSON.stringify(entry)).toEqual([]);
      expect(r.problems[0].problem, JSON.stringify(entry)).toMatch(re);
      // problems never name the path
      expect(r.problems[0].problem).not.toContain(dir);
      expect(r.problems[0].problem).not.toContain('certs/');
    }
    const noWs = await loadClientCertificates([{ host: 'a.example', pfx: 'certs/client.p12' }], deps({ workspaceFolders: () => [] }));
    expect(noWs.problems[0].problem).toMatch(/no workspace folder is open/);
  });

  it('a FIFO is refused without blocking', async () => {
    if (process.platform === 'win32') return;
    const fifo = path.join(ws, 'certs', 'pipe.p12');
    try {
      execFileSync('mkfifo', [fifo]);
    } catch {
      return; // no mkfifo: nothing to test
    }
    const r = await loadClientCertificates([{ host: 'a.example', pfx: 'certs/pipe.p12' }], deps());
    expect(r.problems[0].problem).toMatch(/not a regular file/);
  });

  it('relative paths try each workspace folder in order', async () => {
    const r = await loadClientCertificates([{ host: 'a.example', cert: 'certs/client.crt', key: 'certs/client.key' }], deps({ workspaceFolders: () => [outside, ws] }));
    expect(r.certs).toHaveLength(1);
  });

  it('entry shape problems; every entry gets a status; order kept; never throws', async () => {
    const r = await loadClientCertificates(
      [
        null,
        { host: 'bad host', pfx: 'x' },
        { host: 'a.example' },
        { host: 'b.example', pfx: 'certs/client.p12', cert: 'certs/client.crt' },
        { host: 'c.example', cert: 'certs/client.crt' },
        { host: 'd.example', key: 'certs/client.key' },
        { host: 'e.example', cert: 'certs/client.crt', key: 'certs/client.key' },
      ],
      deps(),
    );
    expect(r.status.map((s) => s.host)).toEqual(['(entry 1)', '(entry 2)', 'a.example', 'b.example', 'c.example', 'd.example', 'e.example']);
    expect(r.problems.map((p) => p.problem)).toEqual([
      expect.stringMatching(/must be an object/),
      expect.stringMatching(/host must be a host name glob/),
      expect.stringMatching(/either pfx .* or cert and key/),
      expect.stringMatching(/either pfx .* or cert and key/),
      expect.stringMatching(/cert but no key/),
      expect.stringMatching(/key but no cert/),
    ]);
    expect(r.certs.map((c) => c.host)).toEqual(['e.example']);
    expect(await loadClientCertificates(undefined, deps())).toEqual({ certs: [], problems: [], status: [] });
    expect((await loadClientCertificates({ host: 'x' }, deps())).problems[0].problem).toMatch(/must be a list/);
    const many = await loadClientCertificates(Array.from({ length: 60 }, (_, i) => ({ host: `h${i}.example` })), deps());
    expect(many.status).toHaveLength(51);
    expect(many.status.at(-1)?.problem).toMatch(/first 50/);
  });
});
