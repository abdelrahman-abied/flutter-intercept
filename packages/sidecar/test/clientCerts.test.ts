// CONTRACTS §20.3: the sidecar's ClientCertPlatform (IDE requests for the panel's "Add client certificate…").
import { describe, expect, it } from 'vitest';
import {
  CERT_ENTRIES_METHOD,
  CERT_FILE_METHOD,
  CERT_PASSPHRASE_SET_METHOD,
  createSidecarClientCertPlatform,
  entriesForPlugin,
  usableCertPath,
  type SidecarClientCertEntry,
} from '../src/clientCerts';
import { RpcFailure } from '../src/rpc';

function fake(answers: Record<string, (params: any) => unknown> = {}, stored: SidecarClientCertEntry[] = []) {
  const requests: { method: string; params: any }[] = [];
  const written: SidecarClientCertEntry[][] = [];
  let reloads = 0;
  const logs: string[] = [];
  let entries = stored;
  const platform = createSidecarClientCertPlatform({
    async request(method, params) {
      requests.push({ method, params });
      const a = answers[method];
      if (!a) throw new RpcFailure(`unknown method ${method}`, 'unknown_method');
      return a(params);
    },
    entries: () => entries,
    entriesWritten: (e) => {
      written.push(e);
      entries = e;
    },
    reload: async () => {
      reloads++;
    },
    log: (l) => logs.push(l),
  });
  return { platform, requests, written, logs, reloads: () => reloads };
}

describe('sidecar client certificate platform', () => {
  it('pickFile asks the IDE per role and accepts only an absolute path; null = cancelled', async () => {
    const f = fake({ [CERT_FILE_METHOD]: (p) => (p.role === 'key' ? null : p.role === 'cert' ? 'relative/cert.pem' : '/certs/client.p12') });
    expect(await f.platform.pickFile('pfx')).toBe('/certs/client.p12');
    expect(await f.platform.pickFile('key')).toBeUndefined();
    await expect(f.platform.pickFile('cert')).rejects.toThrow(/choose a file on this computer/);
    await expect(f.platform.pickFile('ca' as never)).rejects.toThrow(/Unknown certificate file kind/);
    expect(f.requests.map((r) => r.params.role)).toEqual(['pfx', 'key', 'cert']);
  });

  it('IDE refusals become readable errors; an old plugin says so', async () => {
    const f = fake({ [CERT_FILE_METHOD]: () => { throw new RpcFailure("Flutter Intercept can't store a file path that contains a comma; rename the file or its folder.", 'invalid'); } });
    await expect(f.platform.pickFile('pfx')).rejects.toThrow(/contains a comma/);
    const old = fake();
    await expect(old.platform.pickFile('pfx')).rejects.toThrow(/update Flutter Intercept/);
    await expect(old.platform.setPassphrase('api.example.com', 'x')).rejects.toThrow(/update Flutter Intercept/);
  });

  it('readEntries returns copies of the settings the plugin sent', () => {
    const stored = [{ host: 'api.example.com', pfx: '/certs/client.p12' }];
    const f = fake({}, stored);
    const read = f.platform.readEntries() as SidecarClientCertEntry[];
    expect(read).toEqual(stored);
    read[0].host = 'changed.example';
    expect(stored[0].host).toBe('api.example.com');
  });

  it('writeEntries sends the checked list, remembers it and does not reload by itself', async () => {
    const f = fake({ [CERT_ENTRIES_METHOD]: () => null });
    const entries = [{ host: 'api.example.com', pfx: '/certs/client.p12' }, { host: '*.corp.example:8443', cert: '/c.pem', key: '/k.pem' }];
    await f.platform.writeEntries(entries);
    expect(f.requests).toEqual([{ method: CERT_ENTRIES_METHOD, params: { entries } }]);
    expect(f.written).toEqual([entries]);
    expect(f.reloads()).toBe(0);
    await f.platform.reload?.();
    expect(f.reloads()).toBe(1);
  });

  it('writeEntries: an IDE failure keeps the remembered list', async () => {
    const f = fake({ [CERT_ENTRIES_METHOD]: () => { throw new RpcFailure('Entry 1: The file path must be absolute.', 'invalid'); } });
    await expect(f.platform.writeEntries([{ host: 'a.example', pfx: '/a.p12' }])).rejects.toThrow(/must be absolute/);
    expect(f.written).toEqual([]);
  });

  it('setPassphrase sends the lower-cased host; empty deletes; the value never reaches a log or an error', async () => {
    const f = fake({ [CERT_PASSPHRASE_SET_METHOD]: () => null });
    await f.platform.setPassphrase('API.example.com', 'very-secret-passphrase');
    await f.platform.setPassphrase('api.example.com', '');
    await f.platform.setPassphrase('api.example.com', undefined);
    expect(f.requests.map((r) => r.params)).toEqual([
      { host: 'api.example.com', passphrase: 'very-secret-passphrase' },
      { host: 'api.example.com' },
      { host: 'api.example.com' },
    ]);
    await expect(f.platform.setPassphrase('not a host', 'very-secret-passphrase')).rejects.toThrow(/host/);
    const failing = fake({ [CERT_PASSPHRASE_SET_METHOD]: () => { throw new Error('password safe locked'); } });
    const err = await failing.platform.setPassphrase('api.example.com', 'very-secret-passphrase').catch((e: Error) => e);
    expect(String(err)).not.toContain('very-secret-passphrase');
    expect([...f.logs, ...failing.logs].join('\n')).not.toContain('very-secret-passphrase');
  });

  it('entriesForPlugin: bounded list of objects with string paths; new hosts follow the proxy rules, stored ones stay', () => {
    expect(entriesForPlugin([], [])).toEqual([]);
    expect(() => entriesForPlugin('x', [])).toThrow(/list/);
    expect(() => entriesForPlugin([null], [])).toThrow(/entry 1/);
    expect(() => entriesForPlugin([{ pfx: '/a.p12' }], [])).toThrow(/no host/);
    expect(() => entriesForPlugin([{ host: 'a.example', pfx: 5 }], [])).toThrow(/pfx path/);
    expect(() => entriesForPlugin([{ host: 'a.example', pfx: '/a\n.p12' }], [])).toThrow(/pfx path/);
    expect(() => entriesForPlugin([{ host: '*', pfx: '/a.p12' }], [])).toThrow(/entry 1/);
    expect(() => entriesForPlugin(Array.from({ length: 51 }, (_, i) => ({ host: `h${i}.example`, pfx: '/a.p12' })), [])).toThrow(/at most 50/);
    // A pattern typed on the settings page that the proxy refuses is kept as it is (the loader reports it).
    const stored = [{ host: 'Bad Host', pfx: 'relative.p12' }];
    expect(entriesForPlugin([{ host: 'new.example', pfx: '/n.p12' }, ...stored], stored)).toEqual([{ host: 'new.example', pfx: '/n.p12' }, ...stored]);
    expect(entriesForPlugin([{ host: 'a.example', pfx: '/a.p12', cert: '', extra: 1 }], [])).toEqual([{ host: 'a.example', pfx: '/a.p12' }]);
  });

  it('usableCertPath', () => {
    expect(usableCertPath('/certs/a.p12')).toBe('/certs/a.p12');
    for (const bad of [undefined, null, 1, '', 'a.p12', '/a\0b', '/a\nb', `/${'a'.repeat(4096)}`]) expect(usableCertPath(bad)).toBeUndefined();
  });
});
