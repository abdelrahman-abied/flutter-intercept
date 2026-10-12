import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { beforeAll, describe, expect, it } from 'vitest';
import { mockttpCaGenerator } from '../../src/ca';
import {
  caFingerprint,
  coreSimulatorDataPath,
  type Exec,
  jsonFileStore,
  scrubPaths,
  IosSimTrust,
  type IosSimTrustOptions,
  parseSimulators,
  readTrustRow,
  SQLITE3,
  type SimTrustFs,
  type SimTrustRecord,
  trustStorePath,
  validDataPath,
  XCRUN,
} from '../../src/iosSimTrust';

const UDID = '0F0F0F0F-1111-4222-8333-444455556666'; // made up (never a real device id)
const OTHER = '11111111-2222-3333-4444-555555555555';
const PHYSICAL = '00008110-0000000000000000'; // made up, physical-iPhone shaped
const HOME = path.join(path.sep, 'Users', 'dev');
const devicesRoot = path.join(HOME, 'Library', 'Developer', 'CoreSimulator', 'Devices');
const dataPathOf = (udid: string) => path.join(devicesRoot, udid, 'data');
const USER_ROW = 'A'.repeat(64); // a certificate the user added themselves

let caA: string;
let caB: string;
let shaA: string;
let shaB: string;
beforeAll(async () => {
  caA = (await mockttpCaGenerator('Flutter Intercept CA test-a')).cert;
  caB = (await mockttpCaGenerator('Flutter Intercept CA test-b')).cert;
  shaA = (caFingerprint(caA) as { sha256: string }).sha256;
  shaB = (caFingerprint(caB) as { sha256: string }).sha256;
}, 60_000);

interface Sim {
  udid: string;
  name: string;
  state: 'Booted' | 'Shutdown';
  runtime?: string;
  rows: Set<string>;
  /** false: the trust store file is missing (unknown layout). */
  hasStore?: boolean;
  /** false: the store has no `tsettings` table. */
  schema?: boolean;
  /** false: on disk but not in `simctl list` (another device set, or simctl can't see it). */
  listed?: boolean;
  /** `simctl list` reports this dataPath instead of the standard one. */
  reportedDataPath?: string;
}

/**
 * A fake Mac: `xcrun simctl list / keychain add-root-cert` and `/usr/bin/sqlite3` over in-memory trust stores, and an
 * in-memory file system. Only the commands the module may run are understood; anything else fails the test.
 */
function fakeMac(sims: Sim[]) {
  const files = new Map<string, { data: string; mode: number }>();
  const dirs = new Set<string>();
  const calls: string[][] = [];
  const sqliteStores: string[] = [];
  const failNext: { add?: string; del?: string; list?: string } = {};
  const sim = (udid: string) => sims.find((s) => s.udid === udid);
  const byStore = (p: string) => sims.find((s) => trustStorePath(dataPathOf(s.udid)) === p);
  const exec: Exec = async (file, args) => {
    calls.push([file, ...args]);
    if (file === XCRUN && args.join(' ') === 'simctl list devices -j') {
      if (failNext.list) throw Object.assign(new Error('xcrun failed'), { stderr: failNext.list });
      const devices: Record<string, unknown[]> = {};
      for (const s of sims) {
        if (s.listed === false) continue;
        const rt = s.runtime ?? 'com.apple.CoreSimulator.SimRuntime.iOS-26-5';
        (devices[rt] ??= []).push({ udid: s.udid, name: s.name, state: s.state, dataPath: s.reportedDataPath ?? dataPathOf(s.udid), isAvailable: true });
      }
      return { stdout: JSON.stringify({ devices }), stderr: '' };
    }
    if (file === XCRUN && args[0] === 'simctl' && args[1] === 'keychain') {
      expect(args[3]).toBe('add-root-cert'); // never reset / add-cert
      expect(args).toHaveLength(5);
      const s = sim(args[2]);
      if (!s || s.state !== 'Booted') throw Object.assign(new Error('simctl'), { stderr: 'Unable to lookup in current state: Shutdown' });
      if (failNext.add) {
        const m = failNext.add;
        failNext.add = undefined;
        throw Object.assign(new Error('simctl'), { stderr: m });
      }
      const f = files.get(args[4]);
      expect(f, 'certificate file exists during the add').toBeDefined();
      expect(f!.mode).toBe(0o600);
      expect(f!.data).not.toMatch(/PRIVATE KEY/);
      s.rows.add(new crypto.X509Certificate(f!.data).fingerprint256.replace(/:/g, ''));
      return { stdout: '', stderr: '' };
    }
    if (file === SQLITE3) {
      const sql = args[args.length - 1];
      const store = args[args.length - 2];
      expect(args).toContain('-bail');
      expect(args.slice(args.indexOf('-cmd'), args.indexOf('-cmd') + 2)).toEqual(['-cmd', '.timeout 5000']);
      sqliteStores.push(store);
      const s = byStore(store);
      if (!s || s.hasStore === false) throw Object.assign(new Error('sqlite3'), { stderr: `Error: unable to open database "${store}": unable to open database file` });
      if (s.schema === false) throw Object.assign(new Error('sqlite3'), { stderr: `Parse error in ${store}: no such table: tsettings` });
      let m = /^SELECT COUNT\(\*\) FROM pragma_table_info\('tsettings'\) WHERE name IN \('sha256','data','uuid'\); SELECT COUNT\(\*\) FROM tsettings WHERE sha256 = x'([0-9A-F]{64})';$/.exec(sql);
      if (m) {
        expect(args[0]).toBe('-readonly');
        return { stdout: `3\n${s.rows.has(m[1]) ? 1 : 0}\n`, stderr: '' };
      }
      m = /^DELETE FROM tsettings WHERE sha256 = x'([0-9A-F]{64})';$/.exec(sql);
      if (m) {
        expect(args).not.toContain('-readonly');
        if (failNext.del) {
          const msg = failNext.del;
          failNext.del = undefined;
          throw Object.assign(new Error('sqlite3'), { stderr: msg });
        }
        s.rows.delete(m[1]);
        return { stdout: '', stderr: '' };
      }
      throw new Error(`unexpected SQL ${sql}`);
    }
    throw new Error(`unexpected command ${file} ${args.join(' ')}`);
  };
  let tmp = 0;
  const fs: SimTrustFs = {
    exists: async (p) => {
      if (dirs.has(p) || files.has(p)) return true;
      for (const s of sims) {
        if (p === dataPathOf(s.udid)) return true;
        if (p === trustStorePath(dataPathOf(s.udid))) return s.hasStore !== false;
      }
      return false;
    },
    mkdtemp: async (prefix) => {
      const d = `${prefix}${++tmp}`;
      dirs.add(d);
      return d;
    },
    writeFile: async (p, data, mode) => {
      if (files.has(p)) throw new Error('EEXIST');
      expect(dirs.has(path.dirname(p))).toBe(true);
      files.set(p, { data, mode });
    },
    rm: async (p) => {
      dirs.delete(p);
      for (const k of [...files.keys()]) if (k === p || k.startsWith(p + path.sep)) files.delete(k);
    },
  };
  return { exec, fs, calls, files, dirs, failNext, sims, sqliteStores };
}

function memStore(init: SimTrustRecord[] = []) {
  let records = init;
  return {
    get: () => records,
    set: (r: SimTrustRecord[]) => {
      records = JSON.parse(JSON.stringify(r)) as SimTrustRecord[];
    },
    get records() {
      return records;
    },
  };
}

function make(mac: ReturnType<typeof fakeMac>, store = memStore(), extra: Partial<IosSimTrustOptions> = {}) {
  const logs: string[] = [];
  const trust = new IosSimTrust({
    caCertPem: () => caA,
    exec: mac.exec,
    fs: mac.fs,
    store,
    ownerId: 'me',
    pid: 100,
    pidAlive: (p) => p === 100 || p === 200,
    now: () => 1_000_000,
    heartbeatMs: 0,
    tmpDir: path.join(path.sep, 'tmp'),
    homeDir: HOME,
    platform: 'darwin',
    log: (m) => logs.push(m),
    ...extra,
  });
  return { trust, logs, store };
}

const booted = (udid = UDID, rows: string[] = []): Sim => ({ udid, name: 'iPhone 17', state: 'Booted', rows: new Set(rows) });
const writes = (mac: ReturnType<typeof fakeMac>) =>
  mac.calls.filter((c) => (c[0] === XCRUN && c[2] === 'keychain') || (c[0] === SQLITE3 && !c.includes('-readonly')));

describe('helpers', () => {
  it('parses iOS simulators only, upper-cases udids', () => {
    const json = JSON.stringify({
      devices: {
        'com.apple.CoreSimulator.SimRuntime.iOS-26-5': [{ udid: UDID.toLowerCase(), name: 'iPhone 17', state: 'Booted', dataPath: '/x' }],
        'com.apple.CoreSimulator.SimRuntime.watchOS-11-0': [{ udid: OTHER, name: 'Watch', state: 'Booted' }],
      },
    });
    expect(parseSimulators(json)).toEqual([{ udid: UDID, name: 'iPhone 17', state: 'Booted', dataPath: '/x', runtime: 'com.apple.CoreSimulator.SimRuntime.iOS-26-5' }]);
    expect(parseSimulators('not json')).toEqual([]);
  });

  it('accepts only normalized absolute data paths of that device', () => {
    expect(validDataPath(dataPathOf(UDID), UDID)).toBe(true);
    expect(validDataPath(dataPathOf(UDID), OTHER)).toBe(false);
    expect(validDataPath(`relative/${UDID}/data`, UDID)).toBe(false);
    expect(validDataPath([devicesRoot, 'x', '..', UDID, 'data'].join(path.sep), UDID)).toBe(false);
    expect(validDataPath(undefined, UDID)).toBe(false);
  });

  it('fingerprints the CA DER and keeps only the certificate', async () => {
    const pair = await mockttpCaGenerator('fp');
    const fp = caFingerprint(`${pair.key}\n${pair.cert}`) as { sha256: string; certPem: string };
    expect(fp.sha256).toBe(new crypto.X509Certificate(pair.cert).fingerprint256.replace(/:/g, ''));
    expect(fp.certPem).toMatch(/^-----BEGIN CERTIFICATE-----/);
    expect(fp.certPem).not.toMatch(/PRIVATE KEY/);
    expect(caFingerprint(undefined)).toHaveProperty('problem');
    expect(caFingerprint('garbage')).toHaveProperty('problem');
  });

  it('readTrustRow is read-only and refuses unknown layouts', async () => {
    const mac = fakeMac([booted(UDID, [shaA]), { ...booted(OTHER), schema: false }]);
    expect(await readTrustRow(mac.exec, mac.fs, trustStorePath(dataPathOf(UDID)), shaA)).toEqual({ present: true });
    expect(await readTrustRow(mac.exec, mac.fs, trustStorePath(dataPathOf(UDID)), shaB)).toEqual({ present: false });
    expect(await readTrustRow(mac.exec, mac.fs, trustStorePath(dataPathOf(OTHER)), shaA)).toHaveProperty('problem');
    expect(await readTrustRow(mac.exec, mac.fs, '/nowhere/TrustStore.sqlite3', shaA)).toHaveProperty('problem');
    expect(await readTrustRow(mac.exec, mac.fs, trustStorePath(dataPathOf(UDID)), "x'; DROP TABLE tsettings; --")).toHaveProperty('problem');
    expect(writes(mac)).toEqual([]);
  });
});

describe('IosSimTrust', () => {
  it('adds the CA to a booted simulator, records it first, and removes exactly its row on release', async () => {
    const mac = fakeMac([booted(UDID, [USER_ROW])]);
    const store = memStore();
    let recordedBeforeAdd = false;
    const exec: Exec = async (f, a, t) => {
      if (a[1] === 'keychain') recordedBeforeAdd = store.records.some((r) => r.udid === UDID && r.sha256 === shaA && r.owner === 'me');
      return mac.exec(f, a, t);
    };
    const { trust } = make({ ...mac, exec }, store);
    const r = await trust.ensure(UDID.toLowerCase(), { sessionId: 's1' });
    expect(r).toEqual({ udid: UDID, name: 'iPhone 17', state: 'trusted' });
    expect(recordedBeforeAdd).toBe(true);
    expect([...mac.sims[0].rows].sort()).toEqual([USER_ROW, shaA].sort());
    expect(store.records).toEqual([{ udid: UDID, dataPath: dataPathOf(UDID), sha256: shaA, owner: 'me', pid: 100, heartbeat: 1_000_000 }]);
    expect(mac.files.size).toBe(0); // temp certificate deleted
    expect(mac.dirs.size).toBe(0);
    expect(trust.state()).toEqual([{ udid: UDID, name: 'iPhone 17', state: 'trusted' }]);
    expect(await trust.isTrusted(UDID)).toBe(true);

    await trust.release(UDID, 's1');
    expect([...mac.sims[0].rows]).toEqual([USER_ROW]); // the user's certificate is untouched
    expect(store.records).toEqual([]);
    expect(trust.state()).toEqual([]);
    for (const c of mac.calls) expect(c.join(' ')).not.toMatch(/\breset\b|\berase\b/);
  });

  it('reference-counts sessions on one simulator', async () => {
    const mac = fakeMac([booted()]);
    const { trust } = make(mac);
    await trust.ensure(UDID, { sessionId: 's1' });
    await trust.ensure(UDID, { sessionId: 's2' });
    expect(mac.calls.filter((c) => c[2] === 'keychain')).toHaveLength(1);
    await trust.release(UDID, 's1');
    expect(mac.sims[0].rows.has(shaA)).toBe(true);
    await trust.releaseSession('s2');
    expect(mac.sims[0].rows.has(shaA)).toBe(false);
  });

  it('release without a session id drops every hold (the Remove command)', async () => {
    const mac = fakeMac([booted()]);
    const { trust } = make(mac);
    await trust.ensure(UDID, { sessionId: 's1' });
    await trust.ensure(UDID, { sessionId: 's2' });
    await trust.release(UDID);
    expect(mac.sims[0].rows.size).toBe(0);
  });

  it('never touches a row that was there before (pre-existing)', async () => {
    const mac = fakeMac([booted(UDID, [shaA])]);
    const { trust, store } = make(mac);
    expect(await trust.ensure(UDID, { sessionId: 's1' })).toMatchObject({ state: 'pre-existing' });
    expect(store.records).toEqual([]);
    await trust.release(UDID, 's1');
    await trust.releaseAll();
    expect(await trust.recover()).toBe(0);
    expect(mac.sims[0].rows.has(shaA)).toBe(true);
    expect(writes(mac)).toEqual([]);
  });

  it('refuses shut-down simulators, physical devices, unknown ids and other platforms without changing anything', async () => {
    const mac = fakeMac([{ ...booted(), state: 'Shutdown' }]);
    const { trust } = make(mac);
    expect(await trust.ensure(UDID)).toMatchObject({ state: 'not-simulator' });
    expect(await trust.ensure(PHYSICAL)).toMatchObject({ state: 'not-simulator' });
    expect(await trust.ensure('emulator-5554')).toMatchObject({ state: 'not-simulator' });
    expect(await trust.isSimulator(UDID)).toBe(false);
    expect(await trust.isSimulator(PHYSICAL)).toBe(false);
    const linux = make(fakeMac([booted()]), memStore(), { platform: 'linux' });
    expect(await linux.trust.ensure(UDID)).toMatchObject({ state: 'not-simulator' });
    expect(writes(mac)).toEqual([]);
    expect(trust.state()).toEqual([]);
  });

  it('refuses an unknown trust store layout (nothing recorded, nothing added)', async () => {
    for (const odd of [{ hasStore: false }, { schema: false }]) {
      const mac = fakeMac([{ ...booted(), ...odd }]);
      const { trust, store } = make(mac);
      const r = await trust.ensure(UDID, { sessionId: 's' });
      expect(r).toMatchObject({ state: 'failed' });
      expect((r as { problem: string }).problem).toMatch(/layout|Nothing was changed/);
      expect(store.records).toEqual([]);
      expect(writes(mac)).toEqual([]);
      expect(trust.state()).toEqual([expect.objectContaining({ udid: UDID, state: 'failed' })]);
      await trust.release(UDID, 's');
      expect(trust.state()).toEqual([]);
    }
  });

  it('reports a failed add in plain words and drops its record', async () => {
    const mac = fakeMac([booted()]);
    mac.failNext.add = 'An error was encountered processing the command';
    const { trust, store } = make(mac);
    const r = await trust.ensure(UDID);
    expect(r).toMatchObject({ state: 'failed' });
    expect((r as { problem: string }).problem).toMatch(/couldn't add the Flutter Intercept CA/);
    expect(store.records).toEqual([]);
    expect(mac.files.size + mac.dirs.size).toBe(0);
    // A later ensure retries.
    expect(await trust.ensure(UDID)).toMatchObject({ state: 'trusted' });
  });

  it('refuses when the record cannot be saved first', async () => {
    const mac = fakeMac([booted()]);
    const store = { get: () => [] as SimTrustRecord[], set: () => Promise.reject(new Error('disk full')) };
    const { trust } = make(mac, store as never);
    expect(await trust.ensure(UDID)).toMatchObject({ state: 'failed' });
    expect(writes(mac)).toEqual([]);
  });

  it('keeps the record when the delete fails, and recover() finishes it on the next start', async () => {
    const mac = fakeMac([booted()]);
    const store = memStore();
    const { trust } = make(mac, store);
    await trust.ensure(UDID, { sessionId: 's' });
    mac.failNext.del = 'database is locked';
    await trust.release(UDID, 's');
    expect(mac.sims[0].rows.has(shaA)).toBe(true);
    expect(store.records).toHaveLength(1);
    // Next activation: a new instance (new owner; the old process is gone) repairs it.
    const next = make(mac, store, { ownerId: 'me-2', pid: 300, pidAlive: (p) => p === 300 });
    expect(await next.trust.recover()).toBe(1);
    expect(mac.sims[0].rows.has(shaA)).toBe(false);
    expect(store.records).toEqual([]);
  });

  it('the same instance retries a failed removal on recover()', async () => {
    const mac = fakeMac([booted()]);
    const { trust, store } = make(mac);
    await trust.ensure(UDID, { sessionId: 's' });
    mac.failNext.del = 'database is locked';
    await trust.release(UDID, 's');
    expect(await trust.recover()).toBe(1);
    expect(mac.sims[0].rows.size).toBe(0);
    expect(store.records).toEqual([]);
  });

  it('recover() removes rows of dead owners, booted or shut down, and keeps live ones', async () => {
    const mac = fakeMac([{ ...booted(UDID, [shaA]), state: 'Shutdown' }, booted(OTHER, [shaA])]);
    const store = memStore([
      { udid: UDID, dataPath: dataPathOf(UDID), sha256: shaA, owner: 'crashed', pid: 999, heartbeat: 1_000_000 }, // dead pid
      { udid: OTHER, dataPath: dataPathOf(OTHER), sha256: shaA, owner: 'window-2', pid: 200, heartbeat: 1_000_000 - 10_000 }, // live
    ]);
    const { trust } = make(mac, store);
    expect(await trust.recover()).toBe(1);
    expect(mac.sims[0].rows.has(shaA)).toBe(false);
    expect(mac.sims[1].rows.has(shaA)).toBe(true);
    expect(store.records.map((r) => r.owner)).toEqual(['window-2']);
  });

  it('recover() treats a stale heartbeat as gone and drops records of deleted simulators', async () => {
    const mac = fakeMac([booted(UDID, [shaA])]);
    const store = memStore([
      { udid: UDID, dataPath: dataPathOf(UDID), sha256: shaA, owner: 'old', pid: 200, heartbeat: 1_000_000 - 10 * 60_000 },
      { udid: OTHER, dataPath: dataPathOf(OTHER), sha256: shaA, owner: 'old', pid: 999, heartbeat: 0 }, // no such simulator any more
    ]);
    const { trust } = make(mac, store);
    expect(await trust.recover()).toBe(1); // the deleted simulator's record is dropped, but no row was removed there
    expect(mac.sims[0].rows.size).toBe(0);
    expect(store.records).toEqual([]);
  });

  it('ignores invalid stored records', async () => {
    const mac = fakeMac([booted(UDID, [shaA])]);
    const store = memStore([
      { udid: UDID, dataPath: dataPathOf(UDID), sha256: "x'; DROP", owner: 'x', pid: 999, heartbeat: 0 },
      { udid: 'not-a-udid', dataPath: dataPathOf(UDID), sha256: shaA, owner: 'x', pid: 999, heartbeat: 0 },
      { udid: UDID.toLowerCase(), sha256: shaA, owner: 'x', pid: 999, heartbeat: 0 },
      { udid: UDID, sha256: shaA, owner: 'x', pid: 0, heartbeat: 0 },
    ] as SimTrustRecord[]);
    const { trust } = make(mac, store);
    expect(await trust.recover()).toBe(0);
    expect(writes(mac)).toEqual([]);
  });

  it("never uses a record's dataPath: the store path comes from simctl, else the fixed CoreSimulator layout", async () => {
    const planted = path.join(path.sep, 'tmp', 'evil', UDID, 'data');
    const mac = fakeMac([booted(UDID, [shaA])]);
    const store = memStore([{ udid: UDID, dataPath: planted, sha256: shaA, owner: 'gone', pid: 999, heartbeat: 0 }]);
    const { trust } = make(mac, store);
    expect(await trust.recover()).toBe(1);
    expect(mac.sims[0].rows.size).toBe(0);
    expect(new Set(mac.sqliteStores)).toEqual(new Set([trustStorePath(dataPathOf(UDID))]));
    expect(mac.sqliteStores.some((p) => p.startsWith(planted))).toBe(false);
  });

  it('refuses a simctl dataPath that is not <UDID>/data (record kept, nothing written)', async () => {
    const mac = fakeMac([{ ...booted(UDID, [shaA]), reportedDataPath: path.join(path.sep, 'Volumes', 'x', 'data') }]);
    const store = memStore([{ udid: UDID, sha256: shaA, owner: 'gone', pid: 999, heartbeat: 0 }]);
    const { trust } = make(mac, store);
    expect(await trust.recover()).toBe(0);
    expect(mac.sims[0].rows.has(shaA)).toBe(true);
    expect(store.records).toHaveLength(1);
    expect(writes(mac)).toEqual([]);
  });

  it('a simulator simctl does not list: the fixed layout when it exists; kept when simctl failed', async () => {
    const mac = fakeMac([{ ...booted(UDID, [shaA]), state: 'Shutdown', listed: false }]);
    const store = memStore([{ udid: UDID, sha256: shaA, owner: 'gone', pid: 999, heartbeat: 0 }]);
    const { trust } = make(mac, store);
    expect(coreSimulatorDataPath(UDID, HOME)).toBe(dataPathOf(UDID));
    expect(coreSimulatorDataPath('not-a-udid', HOME)).toBeUndefined();
    expect(await trust.recover()).toBe(1);
    expect(mac.sims[0].rows.size).toBe(0);

    // simctl failing and no directory at the fixed path: can't tell → the record stays.
    const mac2 = fakeMac([]);
    mac2.failNext.list = 'xcrun: error';
    const store2 = memStore([{ udid: OTHER, sha256: shaA, owner: 'gone', pid: 999, heartbeat: 0 }]);
    const t2 = make(mac2, store2);
    expect(await t2.trust.recover()).toBe(0);
    expect(store2.records).toHaveLength(1);
  });

  it('a heartbeat more than a minute in the future does not keep a record alive', async () => {
    const mac = fakeMac([booted(UDID, [shaA])]);
    const store = memStore([{ udid: UDID, sha256: shaA, owner: 'planted', pid: 200, heartbeat: 1_000_000 + 10 * 60_000 }]);
    const { trust } = make(mac, store);
    expect(await trust.recover()).toBe(1);
    // …while one slightly ahead (clock skew) still counts as live.
    const mac2 = fakeMac([booted(UDID, [shaA])]);
    const store2 = memStore([{ udid: UDID, sha256: shaA, owner: 'w2', pid: 200, heartbeat: 1_000_000 + 30_000 }]);
    expect(await make(mac2, store2).trust.recover()).toBe(0);
  });

  it('shares a row with another live window: only the last one out removes it', async () => {
    const mac = fakeMac([booted()]);
    const store = memStore();
    const w1 = make(mac, store, { ownerId: 'w1', pid: 100 });
    const w2 = make(mac, store, { ownerId: 'w2', pid: 200 });
    expect(await w1.trust.ensure(UDID, { sessionId: 'a' })).toMatchObject({ state: 'trusted' });
    expect(await w2.trust.ensure(UDID, { sessionId: 'b' })).toMatchObject({ state: 'trusted' });
    expect(mac.calls.filter((c) => c[2] === 'keychain')).toHaveLength(1);
    expect(store.records.map((r) => r.owner).sort()).toEqual(['w1', 'w2']);
    await w1.trust.release(UDID, 'a');
    expect(mac.sims[0].rows.has(shaA)).toBe(true);
    expect(store.records.map((r) => r.owner)).toEqual(['w2']);
    expect(await w1.trust.recover()).toBe(0); // w2 is alive
    await w2.trust.release(UDID, 'b');
    expect(mac.sims[0].rows.has(shaA)).toBe(false);
    expect(store.records).toEqual([]);
  });

  it("adopts a row left by a crashed run instead of calling it the user's", async () => {
    const mac = fakeMac([booted(UDID, [shaA])]);
    const store = memStore([{ udid: UDID, dataPath: dataPathOf(UDID), sha256: shaA, owner: 'crashed', pid: 999, heartbeat: 0 }]);
    const { trust } = make(mac, store);
    expect(await trust.ensure(UDID, { sessionId: 's' })).toMatchObject({ state: 'trusted' });
    expect(store.records.map((r) => r.owner)).toEqual(['me']);
    await trust.release(UDID, 's');
    expect(mac.sims[0].rows.has(shaA)).toBe(false);
  });

  it('a regenerated CA: the old row is removed, the new one added', async () => {
    const mac = fakeMac([booted()]);
    let ca = caA;
    const { trust, store } = make(mac, memStore(), { caCertPem: () => ca });
    await trust.ensure(UDID, { sessionId: 's1' });
    ca = caB;
    expect(await trust.ensure(UDID, { sessionId: 's2' })).toMatchObject({ state: 'trusted' });
    expect([...mac.sims[0].rows]).toEqual([shaB]);
    expect(store.records.map((r) => r.sha256)).toEqual([shaB]);
    await trust.releaseAll();
    expect(mac.sims[0].rows.size).toBe(0);
  });

  it('releaseAll and a removal on a shut-down simulator', async () => {
    const mac = fakeMac([booted(), booted(OTHER)]);
    const { trust, store } = make(mac);
    await trust.ensure(UDID, { sessionId: 'a' });
    await trust.ensure(OTHER, { sessionId: 'b' });
    mac.sims[1].state = 'Shutdown';
    await trust.releaseAll();
    expect(mac.sims.map((s) => s.rows.size)).toEqual([0, 0]);
    expect(store.records).toEqual([]);
    expect(trust.state()).toEqual([]);
  });

  it('tick() refreshes only its own held records', async () => {
    const mac = fakeMac([booted()]);
    let t = 1_000_000;
    const store = memStore([{ udid: OTHER, dataPath: dataPathOf(OTHER), sha256: shaA, owner: 'w2', pid: 200, heartbeat: 5 }]);
    const { trust } = make(mac, store, { now: () => t });
    await trust.ensure(UDID, { sessionId: 's' });
    t += 30_000;
    await trust.tick();
    expect(store.records.find((r) => r.owner === 'me')!.heartbeat).toBe(t);
    expect(store.records.find((r) => r.owner === 'w2')!.heartbeat).toBe(5);
  });

  it('isSimulator: booted iOS simulators only', async () => {
    const mac = fakeMac([booted(), { ...booted(OTHER), runtime: 'com.apple.CoreSimulator.SimRuntime.watchOS-11-0' }]);
    const { trust } = make(mac);
    expect(await trust.isSimulator(UDID)).toBe(true);
    expect(await trust.isSimulator(OTHER)).toBe(false);
    expect(await trust.isSimulator(undefined)).toBe(false);
    mac.failNext.list = 'xcrun: error';
    expect(await trust.isSimulator(UDID)).toBe(false);
  });

  it('never throws on a broken store or exec', async () => {
    const broken = new IosSimTrust({
      caCertPem: () => {
        throw new Error('no CA');
      },
      exec: async () => {
        throw new Error('spawn failed');
      },
      fs: fakeMac([]).fs,
      store: {
        get: () => {
          throw new Error('bad');
        },
        set: () => undefined,
      },
      platform: 'darwin',
      heartbeatMs: 0,
    });
    expect(await broken.ensure(UDID)).toMatchObject({ state: 'not-simulator' });
    await expect(broken.release(UDID)).resolves.toBe(false);
    await expect(broken.recover()).resolves.toBe(0);
    await expect(broken.releaseAll()).resolves.toBe(0);
  });
});

describe('REVIEW-13 hardening', () => {
  it('scrubPaths keeps only the last segment of absolute paths', () => {
    expect(scrubPaths('Error: unable to open database "/Users/dev/Library/Developer/CoreSimulator/Devices/X/data/private/var/protected/trustd/private/TrustStore.sqlite3": no')).toBe(
      'Error: unable to open database "TrustStore.sqlite3": no',
    );
    expect(scrubPaths('cert at /private/tmp/fi-simtrust-1/flutter-intercept-ca.pem (x)')).toBe('cert at flutter-intercept-ca.pem (x)');
    expect(scrubPaths("iPhone 17 isn't a booted iOS Simulator. Nothing was changed.")).toBe("iPhone 17 isn't a booted iOS Simulator. Nothing was changed.");
  });

  it('problems in state() and results carry no absolute paths', async () => {
    const mac = fakeMac([{ ...booted(), schema: false }]);
    const { trust } = make(mac);
    const r = await trust.ensure(UDID, { sessionId: 's' });
    const problem = (r as { problem: string }).problem;
    expect(problem).toMatch(/TrustStore\.sqlite3/);
    expect(problem).not.toContain(HOME);
    expect(JSON.stringify(trust.state())).not.toContain(HOME);

    const mac2 = fakeMac([booted()]);
    mac2.failNext.add = `An error was encountered: could not read ${path.join(path.sep, 'private', 'tmp', 'fi-simtrust-9', 'flutter-intercept-ca.pem')}`;
    const t2 = make(mac2);
    await t2.trust.ensure(UDID);
    expect(t2.trust.state()[0].problem).toMatch(/flutter-intercept-ca\.pem/);
    expect(t2.trust.state()[0].problem).not.toMatch(/\/private\/tmp/);
  });

  it('release / releaseSession / releaseAll report whether rows were actually removed', async () => {
    const mac = fakeMac([booted(), booted(OTHER, [shaA])]);
    const { trust } = make(mac);
    await trust.ensure(UDID, { sessionId: 's1' });
    await trust.ensure(UDID, { sessionId: 's2' });
    expect(await trust.release(UDID, 's1')).toBe(false); // s2 still holds it
    expect(await trust.release(UDID, 's2')).toBe(true);
    expect(await trust.release(UDID, 's2')).toBe(false); // nothing held any more
    expect(await trust.ensure(OTHER, { sessionId: 'p' })).toMatchObject({ state: 'pre-existing' });
    expect(await trust.releaseSession('p')).toBe(false); // pre-existing: never removed
    await trust.ensure(UDID, { sessionId: 'a' });
    mac.sims[0].rows.clear(); // removed by someone else meanwhile
    expect(await trust.releaseSession('a')).toBe(false);
    await trust.ensure(UDID, { sessionId: 'b' });
    expect(await trust.releaseAll()).toBe(1);
  });

  describe('jsonFileStore', () => {
    let dir: string;
    const rec: SimTrustRecord = { udid: UDID, sha256: 'B'.repeat(64), owner: 'me', pid: 1, heartbeat: 1 };
    const mk = () => (dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fi-simtrust-store-')));
    const cleanup = () => fs.rmSync(dir, { recursive: true, force: true });

    it('round-trips through a 0600 file written by rename, leaving no temp files', async () => {
      mk();
      try {
        const file = path.join(dir, 'sub', 'sim-trust.json');
        const store = jsonFileStore(file);
        expect(store.get()).toEqual([]);
        await store.set([rec]);
        expect(store.get()).toEqual([rec]);
        expect(fs.statSync(file).mode & 0o777).toBe(0o600);
        expect(fs.statSync(path.dirname(file)).mode & 0o077).toBe(0);
        expect(fs.readdirSync(path.dirname(file))).toEqual(['sim-trust.json']);
      } finally {
        cleanup();
      }
    });

    it('never reads or writes through a symlinked file', async () => {
      mk();
      try {
        const victim = path.join(dir, 'victim.txt');
        fs.writeFileSync(victim, JSON.stringify([rec]));
        const file = path.join(dir, 'sim-trust.json');
        fs.symlinkSync(victim, file);
        const logs: string[] = [];
        const store = jsonFileStore(file, (m) => logs.push(m));
        expect(store.get()).toEqual([]);
        await expect(store.set([])).rejects.toThrow(/symbolic link/);
        expect(fs.readFileSync(victim, 'utf8')).toBe(JSON.stringify([rec]));
        expect(logs.join('\n')).not.toContain(dir);
      } finally {
        cleanup();
      }
    });

    it('refuses a symlinked directory', async () => {
      mk();
      try {
        const real = path.join(dir, 'real');
        fs.mkdirSync(real);
        fs.symlinkSync(real, path.join(dir, 'link'));
        const store = jsonFileStore(path.join(dir, 'link', 'sim-trust.json'));
        await expect(store.set([rec])).rejects.toThrow(/not a plain directory/);
        expect(fs.readdirSync(real)).toEqual([]);
      } finally {
        cleanup();
      }
    });

    it('ignores non-files and oversized or malformed content', async () => {
      mk();
      try {
        const asDir = path.join(dir, 'd.json');
        fs.mkdirSync(asDir);
        expect(jsonFileStore(asDir).get()).toEqual([]);
        const big = path.join(dir, 'big.json');
        fs.writeFileSync(big, `[${'0,'.repeat(40_000)}0]`);
        expect(jsonFileStore(big).get()).toEqual([]);
        const bad = path.join(dir, 'bad.json');
        fs.writeFileSync(bad, '{"not":"an array"}');
        expect(jsonFileStore(bad).get()).toEqual([]);
      } finally {
        cleanup();
      }
    });
  });
});
