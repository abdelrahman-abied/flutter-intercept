// CONTRACTS §20.3: createClientCertUi — tokens (random, one use on a successful save, 10 min, per role), the §14.3 file
// rules, a real `tls.createSecureContext` check with the passphrase (PEM pairs generated at run time; a PKCS#12 file
// when openssl is available), user-level writes (replace same host, new first, cap), passphrase set / delete, and
// replies / logs that never carry a path or the passphrase.
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as tls from 'tls';
import { execFileSync } from 'child_process';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MAX_CLIENT_CERT_FILE_BYTES, MAX_CLIENT_CERTS, type ClientCertEntry } from '../../src/ui/clientCerts';
import { CERT_CHOOSER_OPEN, CERT_TOKEN_EXPIRED, CERT_TOKEN_RE, CERT_TOKEN_TTL_MS, createClientCertUi, MAX_CERT_TOKENS, type ClientCertFileRole, type ClientCertPlatform } from '../../src/ui/clientCertUi';

let dir: string;
let pair: { key: string; cert: string };
const PASS = ['pass', 'phrase', String(Date.now())].join('-'); // built at run time
const WRONG = ['wrong', String(process.pid)].join('-');
let hasPfx = false;

const F = (f: string) => path.join(dir, f);

beforeAll(async () => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fi-certui-')));
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { generateCACertificate } = require('mockttp/dist/util/certificates') as { generateCACertificate(o: { subject?: Record<string, string>; bits?: number }): Promise<{ key: string; cert: string }> };
  pair = await generateCACertificate({ subject: { commonName: 'fi test client' }, bits: 2048 });
  const other = await generateCACertificate({ subject: { commonName: 'fi other' }, bits: 2048 });
  fs.writeFileSync(F('client.crt'), pair.cert);
  fs.writeFileSync(F('client.key'), pair.key);
  fs.writeFileSync(F('other.key'), other.key);
  fs.writeFileSync(F('client.enc.key'), crypto.createPrivateKey(pair.key).export({ type: 'pkcs8', format: 'pem', cipher: 'aes-256-cbc', passphrase: PASS }) as string);
  fs.writeFileSync(F('notpem.crt'), 'hello');
  fs.writeFileSync(F('big.p12'), Buffer.alloc(MAX_CLIENT_CERT_FILE_BYTES + 1));
  fs.writeFileSync(F('garbage.p12'), Buffer.from([0x30, 0x82, 0x01, 0x00, 1, 2, 3]));
  fs.mkdirSync(F('folder.p12'));
  try {
    const args = ['pkcs12', '-export', '-in', F('client.crt'), '-inkey', F('client.key'), '-passout', `pass:${PASS}`];
    execFileSync('openssl', [...args, '-out', F('client.p12'), '-certpbe', 'AES-256-CBC', '-keypbe', 'AES-256-CBC', '-macalg', 'sha256'], { stdio: 'ignore' });
    // openssl's legacy default (RC2 / 3DES on LibreSSL): Node's OpenSSL 3 can't read RC2
    execFileSync('openssl', [...args, '-out', F('legacy.p12')], { stdio: 'ignore' });
    hasPfx = fs.existsSync(F('client.p12'));
  } catch {
    hasPfx = false;
  }
});

afterAll(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

class FakePlatform implements ClientCertPlatform {
  picks: (string | undefined)[] = [];
  entries: unknown = undefined;
  writes: ClientCertEntry[][] = [];
  secrets = new Map<string, string>();
  secretCalls: [string, string | undefined][] = [];
  logs: string[] = [];
  reloads = 0;
  t = 1_000_000;
  failWrite = false;
  confirms: string[] = [];
  async pickFile(_role: ClientCertFileRole) {
    return this.picks.shift();
  }
  readEntries() {
    return this.entries;
  }
  async writeEntries(entries: ClientCertEntry[]) {
    if (this.failWrite) throw new Error('settings are read-only');
    this.writes.push(entries);
    this.entries = entries;
  }
  async setPassphrase(host: string, value: string | undefined) {
    this.secretCalls.push([host, value]);
    if (value) this.secrets.set(host, value);
    else this.secrets.delete(host);
  }
  reload() {
    this.reloads++;
  }
  log(m: string) {
    this.logs.push(m);
  }
  now() {
    return this.t;
  }
}

function setup(opts: { getPassphrase?: boolean; confirm?: boolean[] } = {}) {
  const p = new FakePlatform();
  const order: string[] = [];
  const platform: ClientCertPlatform = {
    pickFile: (r) => p.pickFile(r),
    readEntries: () => p.readEntries(),
    writeEntries: (e) => {
      order.push('write');
      return p.writeEntries(e);
    },
    setPassphrase: (h, v) => {
      order.push(v ? 'store' : 'delete');
      return p.setPassphrase(h, v);
    },
    reload: () => p.reload(),
    log: (m) => p.log(m),
    now: () => p.now(),
    ...(opts.getPassphrase ? { getPassphrase: (h: string) => p.secrets.get(h) } : {}),
    ...(opts.confirm ? { confirmRemove: async (h: string) => (p.confirms.push(h), opts.confirm!.shift() ?? false) } : {}),
  };
  return { p, ui: createClientCertUi(platform), order };
}

async function choose(p: FakePlatform, ui: ReturnType<typeof createClientCertUi>, role: ClientCertFileRole, file: string) {
  p.picks.push(file);
  const r = await ui.choose(role);
  if (!r) throw new Error('cancelled');
  return r;
}

describe('choose', () => {
  it('gives a random token and the base name only; cancel → undefined', async () => {
    const { p, ui } = setup();
    const a = await choose(p, ui, 'cert', F('client.crt'));
    const b = await choose(p, ui, 'cert', F('client.crt'));
    expect(a.name).toBe('client.crt');
    expect(a.token).toMatch(CERT_TOKEN_RE);
    expect(a.token).not.toBe(b.token);
    expect(JSON.stringify(a)).not.toContain(dir);
    p.picks.push(undefined);
    expect(await ui.choose('pfx')).toBeUndefined();
  });

  it('checks the file with the loader rules at once (problems without paths)', async () => {
    const { p, ui } = setup();
    const cases: [ClientCertFileRole, string, RegExp][] = [
      ['pfx', F('big.p12'), /^The pfx file is larger than 1 MB\.$/],
      ['pfx', F('nope.p12'), /^The pfx file was not found\.$/],
      ['pfx', F('folder.p12'), /^The pfx path is not a regular file\.$/],
      ['cert', F('notpem.crt'), /isn't a PEM certificate/],
      ['key', F('client.crt'), /isn't a PEM private key/],
      ['pfx', 'relative/client.p12', /choose a file on this computer/],
    ];
    for (const [role, file, re] of cases) {
      p.picks.push(file);
      const err = await ui.choose(role).then(() => undefined, (e: Error) => e);
      expect(err?.message, file).toMatch(re);
      expect(err?.message).not.toContain(dir);
    }
  });

  it('a FIFO never blocks the choice', async () => {
    if (process.platform === 'win32') return;
    const fifo = F('pipe.p12');
    execFileSync('mkfifo', [fifo]);
    const { p, ui } = setup();
    p.picks.push(fifo);
    await expect(ui.choose('pfx')).rejects.toThrow(/not a regular file/);
  });

  it('keeps at most MAX_CERT_TOKENS (the oldest go)', async () => {
    const { p, ui } = setup();
    const first = await choose(p, ui, 'cert', F('client.crt'));
    for (let i = 0; i < MAX_CERT_TOKENS; i++) await choose(p, ui, 'key', F('client.key'));
    const key = await choose(p, ui, 'key', F('client.key'));
    expect((await ui.add({ host: 'a.example', cert: first.token, key: key.token })).problem).toBe(CERT_TOKEN_EXPIRED);
  });
});

describe('add', () => {
  it('PEM pair: checked, written to the user entries (new first), passphrase deleted when empty, tokens used up', async () => {
    const { p, ui } = setup();
    p.entries = [{ host: '*.corp.example', pfx: '/elsewhere/x.p12' }];
    const c = await choose(p, ui, 'cert', F('client.crt'));
    const k = await choose(p, ui, 'key', F('client.key'));
    expect(await ui.add({ host: ' API.Example.com:8443 ', cert: c.token, key: k.token })).toEqual({});
    expect(p.writes.at(-1)).toEqual([{ host: 'api.example.com:8443', cert: F('client.crt'), key: F('client.key') }, { host: '*.corp.example', pfx: '/elsewhere/x.p12' }]);
    expect(p.secretCalls).toEqual([['api.example.com:8443', undefined]]);
    expect(p.reloads).toBe(1);
    // one use
    const again = await ui.add({ host: 'api.example.com:8443', cert: c.token, key: k.token });
    expect(again.problem).toBe(CERT_TOKEN_EXPIRED);
  });

  it('replaces an entry with the same host (case-insensitive) where it is, drops duplicates', async () => {
    const { p, ui } = setup();
    p.entries = [{ host: 'first.example', pfx: '/a.p12' }, { host: 'API.example.com', pfx: '/old.p12' }, { host: 'api.example.com', pfx: '/dup.p12' }, 'junk'];
    const c = await choose(p, ui, 'cert', F('client.crt'));
    const k = await choose(p, ui, 'key', F('client.key'));
    expect(await ui.add({ host: 'api.example.com', cert: c.token, key: k.token })).toEqual({});
    expect(p.writes.at(-1)).toEqual([{ host: 'first.example', pfx: '/a.p12' }, { host: 'api.example.com', cert: F('client.crt'), key: F('client.key') }, 'junk']);
  });

  it('encrypted key: needs the passphrase, a wrong one is refused, the right one is stored; never echoed or logged', async () => {
    const { p, ui } = setup();
    const c = await choose(p, ui, 'cert', F('client.crt'));
    const k = await choose(p, ui, 'key', F('client.enc.key'));
    const none = await ui.add({ host: 'mtls.example', cert: c.token, key: k.token });
    expect(none.problem).toMatch(/needs a passphrase \(enter it in the Passphrase field\)/);
    const wrong = await ui.add({ host: 'mtls.example', cert: c.token, key: k.token, passphrase: WRONG });
    expect(wrong.problem).toBe('The passphrase is wrong.');
    expect(p.writes).toEqual([]); // nothing saved, tokens kept
    expect(await ui.add({ host: 'mtls.example', cert: c.token, key: k.token, passphrase: PASS })).toEqual({});
    expect(p.secrets.get('mtls.example')).toBe(PASS);
    // the passphrase is stored before the entry is written (the reload the write triggers sees it)
    expect(p.secretCalls).toEqual([['mtls.example', PASS]]);
    const all = JSON.stringify([none, wrong, p.logs, p.writes]);
    expect(all).not.toContain(PASS);
    expect(all).not.toContain(WRONG);
    expect(JSON.stringify([none, wrong])).not.toContain(dir);
  });

  it('a key that does not belong to the certificate', async () => {
    const { p, ui } = setup();
    const c = await choose(p, ui, 'cert', F('client.crt'));
    const k = await choose(p, ui, 'key', F('other.key'));
    expect((await ui.add({ host: 'a.example', cert: c.token, key: k.token })).problem).toBe("The key doesn't belong to the certificate.");
  });

  it('PKCS#12 with its passphrase (real file from openssl, when it is installed)', async () => {
    if (!hasPfx) return;
    const { p, ui } = setup();
    const x = await choose(p, ui, 'pfx', F('client.p12'));
    expect(x.name).toBe('client.p12');
    expect((await ui.add({ host: 'p12.example', pfx: x.token, passphrase: WRONG })).problem).toBe('The passphrase is wrong.');
    expect(await ui.add({ host: 'p12.example', pfx: x.token, passphrase: PASS })).toEqual({});
    expect(p.writes.at(-1)).toEqual([{ host: 'p12.example', pfx: F('client.p12') }]);
    // a legacy-encrypted file: say so (when this openssl writes one Node can't read)
    let legacyReadable = true;
    try {
      tls.createSecureContext({ pfx: fs.readFileSync(F('legacy.p12')), passphrase: PASS });
    } catch {
      legacyReadable = false;
    }
    if (!legacyReadable) {
      const l = await choose(p, ui, 'pfx', F('legacy.p12'));
      expect((await ui.add({ host: 'p12.example', pfx: l.token, passphrase: PASS })).problem).toMatch(/^The PKCS#12 file uses an old encryption .* export it again with AES/);
    }
  });

  it('garbage PKCS#12 → a format problem', async () => {
    const { p, ui } = setup();
    const x = await choose(p, ui, 'pfx', F('garbage.p12'));
    expect((await ui.add({ host: 'p12.example', pfx: x.token })).problem).toMatch(/isn't a valid certificate|can't be used|needs a passphrase/);
    expect(p.writes).toEqual([]);
  });

  it('host, files and tokens are checked', async () => {
    const { p, ui } = setup();
    const c = await choose(p, ui, 'cert', F('client.crt'));
    const k = await choose(p, ui, 'key', F('client.key'));
    const x = await choose(p, ui, 'pfx', F('garbage.p12'));
    expect((await ui.add({ host: '', cert: c.token, key: k.token })).problem).toMatch(/^The host can't be used: host must be a host name pattern/);
    expect((await ui.add({ host: '*', cert: c.token, key: k.token })).problem).toMatch(/^The host can't be used/);
    expect((await ui.add({ host: 'a.example' })).problem).toMatch(/Choose a PKCS#12 file/);
    expect((await ui.add({ host: 'a.example', pfx: x.token, cert: c.token, key: k.token })).problem).toMatch(/Choose a PKCS#12 file/);
    expect((await ui.add({ host: 'a.example', cert: c.token })).problem).toMatch(/private key file too/);
    expect((await ui.add({ host: 'a.example', key: k.token })).problem).toMatch(/certificate file too/);
    // a token of another role, an unknown token
    expect((await ui.add({ host: 'a.example', cert: k.token, key: c.token })).problem).toBe(CERT_TOKEN_EXPIRED);
    expect((await ui.add({ host: 'a.example', pfx: 'A'.repeat(32) })).problem).toBe(CERT_TOKEN_EXPIRED);
    expect((await ui.add({ host: 'a.example', cert: c.token, key: k.token, passphrase: 'x'.repeat(1025) })).problem).toMatch(/too long/);
    expect(p.writes).toEqual([]);
  });

  it('tokens expire after 10 minutes', async () => {
    const { p, ui } = setup();
    const c = await choose(p, ui, 'cert', F('client.crt'));
    const k = await choose(p, ui, 'key', F('client.key'));
    p.t += CERT_TOKEN_TTL_MS;
    expect((await ui.add({ host: 'a.example', cert: c.token, key: k.token })).problem).toBe(CERT_TOKEN_EXPIRED);
  });

  it('the file is read again on save (deleted meanwhile → problem)', async () => {
    const { p, ui } = setup();
    fs.copyFileSync(F('client.key'), F('gone.key'));
    const c = await choose(p, ui, 'cert', F('client.crt'));
    const k = await choose(p, ui, 'key', F('gone.key'));
    fs.rmSync(F('gone.key'));
    expect((await ui.add({ host: 'a.example', cert: c.token, key: k.token })).problem).toBe('The key file was not found.');
  });

  it('at most MAX_CLIENT_CERTS entries; a malformed setting is not overwritten', async () => {
    const { p, ui } = setup();
    p.entries = Array.from({ length: MAX_CLIENT_CERTS }, (_, i) => ({ host: `h${i}.example`, pfx: `/c${i}.p12` }));
    const c = await choose(p, ui, 'cert', F('client.crt'));
    const k = await choose(p, ui, 'key', F('client.key'));
    expect((await ui.add({ host: 'new.example', cert: c.token, key: k.token })).problem).toMatch(/already have 50 client certificates/);
    // replacing one at the cap is fine
    expect(await ui.add({ host: 'h3.example', cert: c.token, key: k.token })).toEqual({});
    const c2 = await choose(p, ui, 'cert', F('client.crt'));
    const k2 = await choose(p, ui, 'key', F('client.key'));
    p.entries = { host: 'x' };
    expect((await ui.add({ host: 'new.example', cert: c2.token, key: k2.token })).problem).toMatch(/isn't a list/);
  });

  it('a failing settings write → a plain problem, details only in the log', async () => {
    const { p, ui } = setup();
    p.failWrite = true;
    const c = await choose(p, ui, 'cert', F('client.crt'));
    const k = await choose(p, ui, 'key', F('client.key'));
    const r = await ui.add({ host: 'a.example', cert: c.token, key: k.token });
    expect(r.problem).toMatch(/^Couldn't save the certificate in your user settings/);
    expect(p.logs.join('\n')).toMatch(/read-only/);
  });

  it('saves run one at a time (no lost entry)', async () => {
    const { p, ui } = setup();
    p.entries = [];
    const a = [await choose(p, ui, 'cert', F('client.crt')), await choose(p, ui, 'key', F('client.key'))];
    const b = [await choose(p, ui, 'cert', F('client.crt')), await choose(p, ui, 'key', F('client.key'))];
    await Promise.all([ui.add({ host: 'a.example', cert: a[0].token, key: a[1].token }), ui.add({ host: 'b.example', cert: b[0].token, key: b[1].token })]);
    expect((p.entries as ClientCertEntry[]).map((e) => e.host).sort()).toEqual(['a.example', 'b.example']);
  });
});

describe('REVIEW-14 #4: passphrase order and rollback', () => {
  async function pemTokens(p: FakePlatform, ui: ReturnType<typeof createClientCertUi>, key = 'client.enc.key') {
    return { cert: (await choose(p, ui, 'cert', F('client.crt'))).token, key: (await choose(p, ui, 'key', F(key))).token };
  }

  it('a failed write puts the previous passphrase back (getPassphrase)', async () => {
    const { p, ui, order } = setup({ getPassphrase: true });
    const OLD = ['old', String(Date.now())].join('-');
    p.entries = [{ host: 'mtls.example', pfx: '/old.p12' }];
    p.secrets.set('mtls.example', OLD);
    p.failWrite = true;
    const r = await ui.add({ host: 'mtls.example', ...(await pemTokens(p, ui)), passphrase: PASS });
    expect(r.problem).toMatch(/Couldn't save/);
    expect(order).toEqual(['store', 'write', 'store']);
    expect(p.secrets.get('mtls.example')).toBe(OLD);
    expect(p.logs.join('\n')).not.toContain(OLD);
  });

  it('nothing was stored before → the new one is deleted again', async () => {
    const { p, ui } = setup({ getPassphrase: true });
    p.failWrite = true;
    await ui.add({ host: 'mtls.example', ...(await pemTokens(p, ui)), passphrase: PASS });
    expect(p.secrets.has('mtls.example')).toBe(false);
  });

  it('without getPassphrase: the new one stays (no rollback possible), nothing is deleted', async () => {
    const { p, ui, order } = setup();
    p.failWrite = true;
    await ui.add({ host: 'mtls.example', ...(await pemTokens(p, ui)), passphrase: PASS });
    expect(order).toEqual(['store', 'write']);
    expect(p.secrets.get('mtls.example')).toBe(PASS);
  });

  it('an empty passphrase deletes the stored one only after the write succeeded', async () => {
    const OLD = ['old', String(Date.now())].join('-');
    for (const failWrite of [true, false]) {
      const { p, ui, order } = setup({ getPassphrase: true });
      p.secrets.set('plain.example', OLD);
      p.failWrite = failWrite;
      await ui.add({ host: 'plain.example', ...(await pemTokens(p, ui, 'client.key')) });
      if (failWrite) {
        expect(order).toEqual(['write']);
        expect(p.secrets.get('plain.example')).toBe(OLD);
      } else {
        expect(order).toEqual(['write', 'delete']);
        expect(p.secrets.has('plain.example')).toBe(false);
      }
    }
  });
});

describe('REVIEW-14 #4: Remove is confirmed by the IDE', () => {
  it('cancelled → nothing changes; confirmed → removed', async () => {
    const { p, ui } = setup({ confirm: [false, true] });
    p.entries = [{ host: 'a.example', pfx: '/a.p12' }];
    p.secrets.set('a.example', 'x');
    expect(await ui.remove('a.example')).toEqual({ cancelled: true });
    expect(p.writes).toEqual([]);
    expect(p.secrets.get('a.example')).toBe('x');
    expect(await ui.remove('A.example')).toEqual({});
    expect(p.confirms).toEqual(['a.example', 'a.example']);
    expect(p.writes.at(-1)).toEqual([]);
    expect(p.secrets.has('a.example')).toBe(false);
  });

  it('no question for a host that has no entry', async () => {
    const { p, ui } = setup({ confirm: [true] });
    p.entries = [];
    await expect(ui.remove('a.example')).rejects.toThrow(/No client certificate/);
    expect(p.confirms).toEqual([]);
  });
});

describe('REVIEW-14 #6: one file chooser at a time', () => {
  it('a second choose while one is open → a problem; after it closes, fine', async () => {
    const p = new FakePlatform();
    let release: (v: string | undefined) => void = () => undefined;
    const ui = createClientCertUi({ ...p, pickFile: () => new Promise((r) => (release = r)), readEntries: () => [], writeEntries: async () => undefined, setPassphrase: async () => undefined });
    const first = ui.choose('cert');
    await expect(ui.choose('key')).rejects.toThrow(CERT_CHOOSER_OPEN);
    release(F('client.crt'));
    expect((await first)?.name).toBe('client.crt');
    const again = ui.choose('key');
    release(undefined);
    expect(await again).toBeUndefined();
  });
});

describe('remove', () => {
  it('removes the user entry with that host and its passphrase', async () => {
    const { p, ui } = setup();
    p.entries = [{ host: 'A.example', pfx: '/a.p12' }, { host: 'b.example', pfx: '/b.p12' }];
    p.secrets.set('a.example', 'x');
    await ui.remove('a.EXAMPLE');
    expect(p.writes.at(-1)).toEqual([{ host: 'b.example', pfx: '/b.p12' }]);
    expect(p.secretCalls).toEqual([['a.example', undefined]]);
    expect(p.reloads).toBe(1);
    await expect(ui.remove('a.example')).rejects.toThrow(/No client certificate for a\.example/);
    await expect(ui.remove('')).rejects.toThrow(/host is missing/);
  });
});
