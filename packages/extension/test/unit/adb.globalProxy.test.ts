import { describe, expect, it } from 'vitest';
import { AndroidGlobalProxy, type Exec, type GlobalProxyRecord, parseSettingValue } from '../../src/adb';

/** A fake emulator: `settings get/put/delete global <key>` over a map, like Android's settings provider. */
function fakeAdb(init: Record<string, string> = {}, connected = ['emulator-5554']) {
  const settings = new Map<string, Map<string, string>>();
  const calls: string[] = [];
  let fail: ((args: string[]) => boolean) | undefined;
  const exec: Exec = async (_file, args) => {
    calls.push(args.join(' '));
    if (fail?.(args)) throw Object.assign(new Error('boom'), { stderr: 'error: device offline' });
    if (args[0] === 'devices') return { stdout: `List of devices attached\n${connected.map((s) => `${s}\tdevice`).join('\n')}\n`, stderr: '' };
    const [, serial, , cmd, verb, ns, key, value] = args;
    expect(cmd).toBe('settings');
    expect(ns).toBe('global');
    let m = settings.get(serial);
    if (!m) settings.set(serial, (m = new Map(Object.entries(init))));
    if (verb === 'get') return { stdout: `${m.get(key) ?? 'null'}\n`, stderr: '' };
    if (verb === 'put') {
      m.set(key, value);
      // ConnectivityService: a valid http_proxy sets the global proxy keys; ":0" clears them; delete changes nothing.
      if (key === 'http_proxy') {
        const [h, p] = value.split(':');
        m.set('global_http_proxy_host', h);
        m.set('global_http_proxy_port', p || '0');
      }
      return { stdout: '', stderr: '' };
    }
    if (verb === 'delete') {
      m.delete(key);
      return { stdout: 'Deleted 1 rows\n', stderr: '' };
    }
    throw new Error(`unexpected ${args.join(' ')}`);
  };
  const of = (serial = 'emulator-5554') => {
    if (!settings.has(serial)) settings.set(serial, new Map(Object.entries(init)));
    return settings.get(serial)!;
  };
  return { exec, calls, of, setFail: (f: typeof fail) => (fail = f) };
}

function memStore(init: GlobalProxyRecord[] = []) {
  let v = init;
  return { get: () => v, set: (r: GlobalProxyRecord[]) => void (v = r), value: () => v };
}

describe('AndroidGlobalProxy (CONTRACTS §14.7)', () => {
  it('parses settings values', () => {
    expect(parseSettingValue('null\n')).toBeNull();
    expect(parseSettingValue('\n')).toBeNull();
    expect(parseSettingValue('10.0.2.2:9000\r\n')).toBe('10.0.2.2:9000');
  });

  it('routes an emulator for the session and restores the unset key exactly (put :0, then delete)', async () => {
    const adb = fakeAdb();
    const store = memStore();
    const gp = new AndroidGlobalProxy({ exec: adb.exec, adbPath: '/adb', store });
    const r = await gp.apply('s1', 'emulator-5554', 9123);
    expect(r).toEqual({ applied: true, serial: 'emulator-5554', value: '10.0.2.2:9123' });
    expect(adb.of().get('http_proxy')).toBe('10.0.2.2:9123');
    expect(gp.isRouted('s1')).toBe(true);
    expect(store.value()).toMatchObject([{ serial: 'emulator-5554', value: '10.0.2.2:9123', previous: null, owner: expect.any(String), pid: process.pid }]);
    await gp.release('s1');
    expect(adb.of().has('http_proxy')).toBe(false);
    expect(adb.of().get('global_http_proxy_host')).toBe(''); // the ConnectivityService proxy is cleared too
    expect(gp.isRouted('s1')).toBe(false);
    expect(store.value()).toEqual([]);
    const i = adb.calls.indexOf('-s emulator-5554 shell settings put global http_proxy :0');
    expect(i).toBeGreaterThan(0);
    expect(adb.calls[i + 1]).toBe('-s emulator-5554 shell settings delete global http_proxy');
  });

  it('restores a previous ":0" without deleting it', async () => {
    const adb = fakeAdb({ http_proxy: ':0', global_http_proxy_host: '', global_http_proxy_port: '0' });
    const gp = new AndroidGlobalProxy({ exec: adb.exec, adbPath: '/adb' });
    expect((await gp.apply('s1', 'emulator-5554', 9123)).applied).toBe(true);
    await gp.release('s1');
    expect(adb.of().get('http_proxy')).toBe(':0');
    expect(adb.calls.some((c) => c.includes('delete'))).toBe(false);
  });

  it('never touches a proxy someone else set (http_proxy or a device-policy global proxy)', async () => {
    const a = fakeAdb({ http_proxy: '192.0.2.10:8888' });
    const gp = new AndroidGlobalProxy({ exec: a.exec, adbPath: '/adb' });
    expect(await gp.apply('s1', 'emulator-5554', 9123)).toEqual({ applied: false, reason: 'user-proxy' });
    expect(a.of().get('http_proxy')).toBe('192.0.2.10:8888');
    const b = fakeAdb({ global_http_proxy_host: 'proxy.corp.example', global_http_proxy_port: '3128' });
    const gp2 = new AndroidGlobalProxy({ exec: b.exec, adbPath: '/adb' });
    expect(await gp2.apply('s1', 'emulator-5554', 9123)).toEqual({ applied: false, reason: 'user-proxy' });
    expect(b.calls.some((c) => c.includes(' put '))).toBe(false);
  });

  it('only emulators, connected, with adb and a valid port', async () => {
    const adb = fakeAdb();
    const gp = new AndroidGlobalProxy({ exec: adb.exec, adbPath: '/adb' });
    expect(await gp.apply('s', 'R58M123', 9123)).toEqual({ applied: false, reason: 'not-emulator' });
    expect(await gp.apply('s', '-s', 9123)).toEqual({ applied: false, reason: 'not-emulator' });
    expect(await gp.apply('s', undefined, 9123)).toEqual({ applied: false, reason: 'not-emulator' });
    expect(await gp.apply('s', 'emulator-5556', 9123)).toEqual({ applied: false, reason: 'not-connected' });
    expect((await gp.apply('s', 'emulator-5554', 0)).applied).toBe(false);
    expect(await new AndroidGlobalProxy({ adbPath: null }).apply('s', 'emulator-5554', 9123)).toEqual({ applied: false, reason: 'adb-missing' });
    expect(adb.calls.some((c) => c.includes(' put '))).toBe(false);
  });

  it('is reference-counted per emulator', async () => {
    const adb = fakeAdb();
    const gp = new AndroidGlobalProxy({ exec: adb.exec, adbPath: '/adb' });
    await gp.apply('s1', 'emulator-5554', 9123);
    expect((await gp.apply('s2', 'emulator-5554', 9123)).applied).toBe(true);
    await gp.release('s1');
    expect(adb.of().get('http_proxy')).toBe('10.0.2.2:9123');
    expect(gp.isRouted('s2')).toBe(true);
    await gp.release('s2');
    expect(adb.of().has('http_proxy')).toBe(false);
  });

  it('leaves a value that changed meanwhile alone on release', async () => {
    const adb = fakeAdb();
    const store = memStore();
    const gp = new AndroidGlobalProxy({ exec: adb.exec, adbPath: '/adb', store });
    await gp.apply('s1', 'emulator-5554', 9123);
    adb.of().set('http_proxy', '192.0.2.10:8888');
    await gp.release('s1');
    expect(adb.of().get('http_proxy')).toBe('192.0.2.10:8888');
    expect(store.value()).toEqual([]);
  });

  it('releaseAll reverts every emulator (deactivate)', async () => {
    const adb = fakeAdb({}, ['emulator-5554', 'emulator-5556']);
    const gp = new AndroidGlobalProxy({ exec: adb.exec, adbPath: '/adb' });
    await gp.apply('s1', 'emulator-5554', 9123);
    await gp.apply('s2', 'emulator-5556', 9123);
    expect(gp.routed.sort()).toEqual(['emulator-5554', 'emulator-5556']);
    await gp.releaseAll();
    expect(adb.of('emulator-5554').has('http_proxy')).toBe(false);
    expect(adb.of('emulator-5556').has('http_proxy')).toBe(false);
    expect(gp.routed).toEqual([]);
  });

  it('recover() repairs what a crashed run left behind, keeping offline emulators for later', async () => {
    const adb = fakeAdb({ http_proxy: '10.0.2.2:9001', global_http_proxy_host: '10.0.2.2', global_http_proxy_port: '9001' });
    const store = memStore([
      { serial: 'emulator-5554', value: '10.0.2.2:9001', previous: null },
      { serial: 'emulator-5560', value: '10.0.2.2:9001', previous: null },
    ]);
    const gp = new AndroidGlobalProxy({ exec: adb.exec, adbPath: '/adb', store });
    expect(await gp.recover()).toBe(1);
    expect(adb.of().has('http_proxy')).toBe(false);
    expect(adb.of().get('global_http_proxy_host')).toBe('');
    expect(store.value()).toEqual([{ serial: 'emulator-5560', value: '10.0.2.2:9001', previous: null }]);
  });

  it('a new apply over a stale record of a crashed run keeps the real previous value', async () => {
    const adb = fakeAdb({ http_proxy: '10.0.2.2:9001' });
    const store = memStore([{ serial: 'emulator-5554', value: '10.0.2.2:9001', previous: null }]);
    const gp = new AndroidGlobalProxy({ exec: adb.exec, adbPath: '/adb', store });
    expect((await gp.apply('s1', 'emulator-5554', 9123)).applied).toBe(true);
    expect(store.value()).toMatchObject([{ serial: 'emulator-5554', value: '10.0.2.2:9123', previous: null, owner: expect.any(String), pid: process.pid }]);
    await gp.release('s1');
    expect(adb.of().has('http_proxy')).toBe(false);
  });

  it('ignores malformed stored records', async () => {
    const adb = fakeAdb({ http_proxy: 'evil;rm -rf' });
    const store = { get: () => [{ serial: '-s', value: 'x', previous: null }, { serial: 'emulator-5554', value: 'evil;rm -rf', previous: null }] as GlobalProxyRecord[], set: () => undefined };
    const gp = new AndroidGlobalProxy({ exec: adb.exec, adbPath: '/adb', store });
    expect(await gp.recover()).toBe(0);
    expect(adb.calls.filter((c) => c.includes(' put ') || c.includes('delete'))).toEqual([]);
  });

  it('a failure to restore keeps the record for the next start, and apply failures never throw', async () => {
    const adb = fakeAdb();
    const store = memStore();
    const gp = new AndroidGlobalProxy({ exec: adb.exec, adbPath: '/adb', store, log: () => undefined });
    await gp.apply('s1', 'emulator-5554', 9123);
    adb.setFail((args) => args.includes('get'));
    await gp.release('s1');
    expect(store.value()).toHaveLength(1);
    expect(await gp.apply('s2', 'emulator-5554', 9123)).toMatchObject({ applied: false, reason: 'failed' });
    adb.setFail(undefined);
    expect(await gp.recover()).toBe(1);
    expect(adb.of().has('http_proxy')).toBe(false);
  });

  describe('REVIEW-8 #7: shared store between VS Code windows', () => {
    it("a second window's recover() leaves the first window's live record alone", async () => {
      let t = 1_000_000;
      const adb = fakeAdb();
      const store = memStore();
      const alive = new Set([111, 222]);
      const common = { exec: adb.exec, adbPath: '/adb', store, now: () => t, heartbeatMs: 0, pidAlive: (p: number) => alive.has(p) };
      const a = new AndroidGlobalProxy({ ...common, ownerId: 'win-a', pid: 111 });
      const b = new AndroidGlobalProxy({ ...common, ownerId: 'win-b', pid: 222 });
      expect((await a.apply('s1', 'emulator-5554', 9123)).applied).toBe(true);
      expect(store.value()[0]).toMatchObject({ owner: 'win-a', pid: 111, heartbeat: t });
      t += 90_000;
      expect(await b.recover()).toBe(0);
      expect(adb.of().get('http_proxy')).toBe('10.0.2.2:9123');
      // B's own session on that emulator doesn't take it over either.
      expect(await b.apply('s2', 'emulator-5554', 9200)).toEqual({ applied: false, reason: 'user-proxy' });
      // The heartbeat keeps it alive past the stale limit.
      await a.tick();
      t += 90_000;
      expect(await b.recover()).toBe(0);
      expect(a.isRouted('s1')).toBe(true);
    });

    it('a record whose owner is gone (pid dead, or heartbeat older than 2 min) is recovered', async () => {
      let t = 1_000_000;
      const adb = fakeAdb();
      const store = memStore();
      const alive = new Set([111, 222]);
      const common = { exec: adb.exec, adbPath: '/adb', store, now: () => t, heartbeatMs: 0, pidAlive: (p: number) => alive.has(p) };
      const a = new AndroidGlobalProxy({ ...common, ownerId: 'win-a', pid: 111 });
      await a.apply('s1', 'emulator-5554', 9123);
      const b = new AndroidGlobalProxy({ ...common, ownerId: 'win-b', pid: 222 });
      alive.delete(111); // window A crashed
      expect(await b.recover()).toBe(1);
      expect(adb.of().has('http_proxy')).toBe(false);
      // Hung owner: pid alive, heartbeat stale.
      alive.add(111);
      const c = new AndroidGlobalProxy({ ...common, ownerId: 'win-c', pid: 111 });
      await c.apply('s3', 'emulator-5554', 9300);
      t += 121_000;
      expect(await b.recover()).toBe(1);
      expect(adb.of().has('http_proxy')).toBe(false);
    });

    it('isRouted() notices a route that was reverted or replaced behind its back (re-read ≤ every 10 s)', async () => {
      let t = 1_000_000;
      const adb = fakeAdb();
      const store = memStore();
      const gp = new AndroidGlobalProxy({ exec: adb.exec, adbPath: '/adb', store, now: () => t, heartbeatMs: 0, ownerId: 'win-a', pid: 111 });
      await gp.apply('s1', 'emulator-5554', 9123);
      adb.of().set('http_proxy', ':0'); // another tool reverted it
      expect(gp.isRouted('s1')).toBe(true); // checked less than 10 s ago
      t += 11_000;
      gp.isRouted('s1'); // kicks off the re-read
      await gp.tick();
      expect(gp.isRouted('s1')).toBe(false);
      expect(store.value()).toEqual([]);
      await gp.release('s1');
      expect(adb.of().get('http_proxy')).toBe(':0'); // not touched again
    });
  });
});
