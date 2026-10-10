// REVIEW-6 (host + agent parts): #1 upstream proxy shown (host:port) + agent settings from user settings only,
// #3 rewrite text caps, #9 HAR exports only into real folders inside the project.
import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { InterceptProxyOptions, Rule } from '@flutter-intercept/proxy';
import { ensureDirInside, EXPORT_DIR, writeHar } from '../../src/agent/har';
import { InterceptProxyHost, upstreamDisplay } from '../../src/proxyHost';
import { ControllerHost, InterceptController, MAX_REWRITE_REPLACE, validateRule } from '../../src/ui/controller';
import type { HostMsg } from '../../src/ui/protocol';

vi.mock('vscode', () => ({}));

const tmp: string[] = [];
afterEach(() => {
  for (const d of tmp.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});
const mkTmp = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'fi-r6-'));
  tmp.push(d);
  return d;
};

describe('#1 upstream proxy display', () => {
  it('upstreamDisplay keeps host:port only', () => {
    expect(upstreamDisplay('http://user:pw@proxy.corp:3128/')).toBe('proxy.corp:3128');
    expect(upstreamDisplay('http://[::1]:8888')).toBe('[::1]:8888');
    expect(upstreamDisplay('http://proxy.corp')).toBe('proxy.corp:80');
    expect(upstreamDisplay('nope')).toBeUndefined();
    expect(upstreamDisplay(undefined)).toBeUndefined();
  });

  it('proxyHost: info from the running proxy, else the stored setting; emits upstream', async () => {
    let live: { url: string; ignoreCertErrors: boolean } | undefined;
    const factory = (o: InterceptProxyOptions) => {
      const ee = new EventEmitter();
      return {
        port: o.port ?? 0,
        start: async () => undefined,
        stop: async () => undefined,
        setRules: () => undefined,
        getExchanges: () => [],
        clear: () => undefined,
        resume: () => undefined,
        abort: () => undefined,
        on: (ev: string, l: (...a: any[]) => void) => ee.on(ev, l),
        setUpstreamProxy: (c: { url: string; ignoreCertErrors?: boolean } | undefined) => {
          live = c ? { url: 'http://normalised.corp:3128', ignoreCertErrors: c.ignoreCertErrors === true } : undefined;
        },
        get upstreamProxy() {
          return live;
        },
      };
    };
    const host = new InterceptProxyHost({ getPort: () => 7700, factory });
    const events: unknown[] = [];
    host.on('upstream', (i) => events.push(i));
    host.setUpstreamProxy({ url: 'http://127.0.0.1:8888', ignoreCertErrors: true });
    expect(host.upstreamProxyInfo).toEqual({ display: '127.0.0.1:8888', ignoreCertErrors: true });
    await host.start();
    host.setUpstreamProxy({ url: 'http://proxy.corp:3128' });
    expect(host.upstreamProxyDisplay).toBe('normalised.corp:3128');
    host.setUpstreamProxy(undefined);
    expect(host.upstreamProxyInfo).toBeUndefined();
    expect(events).toEqual([{ display: '127.0.0.1:8888', ignoreCertErrors: true }, { display: 'normalised.corp:3128', ignoreCertErrors: false }, undefined]);
    await host.stop();
  });

  it('controller: Status.upstreamProxy / upstreamProxyInsecure, re-broadcast on change', () => {
    class Host extends EventEmitter implements ControllerHost {
      running = true;
      port = 1;
      upstreamProxyInfo?: { display: string; ignoreCertErrors: boolean };
      getExchanges() {
        return [];
      }
      getRules(): Rule[] {
        return [];
      }
      setRules() {}
      clear() {}
      resume() {}
      abort() {}
    }
    const host = new Host();
    const c = new InterceptController({ host, saveRules: () => undefined, getEnabled: () => true, setEnabled: async () => undefined });
    const msgs: HostMsg[] = [];
    c.attach((m) => msgs.push(m));
    expect(c.status()).not.toHaveProperty('upstreamProxy');
    host.upstreamProxyInfo = { display: 'proxy.corp:3128', ignoreCertErrors: true };
    host.emit('upstream', host.upstreamProxyInfo);
    const st = msgs.filter((m): m is Extract<HostMsg, { type: 'status' }> => m.type === 'status').pop()!.status;
    expect(st.upstreamProxy).toBe('proxy.corp:3128');
    expect(st.upstreamProxyInsecure).toBe(true);
    host.upstreamProxyInfo = { display: 'proxy.corp:3128', ignoreCertErrors: false };
    expect(c.status()).not.toHaveProperty('upstreamProxyInsecure');
    c.dispose();
  });

  it('agent settings are read from user settings only', async () => {
    const { userAgentSetting } = await import('../../src/agent/mcp/register');
    const cfg = (v: { globalValue?: unknown; workspaceValue?: unknown }) => ({ inspect: () => ({ key: 'k', ...v }) }) as any;
    expect(userAgentSetting(cfg({ workspaceValue: 'readWrite', globalValue: 'readOnly' }), 'access', 'readWrite')).toBe('readOnly');
    expect(userAgentSetting(cfg({ workspaceValue: 9999 }), 'mcpPort', 1234)).toBe(1234);
    expect(userAgentSetting({ inspect: () => undefined } as any, 'access', 'readWrite')).toBe('readWrite');
  });
});

describe('#3 rewrite text caps', () => {
  const rw = (response: unknown) => ({ id: 'r', enabled: true, match: { url: 'https://a.dev/*' }, action: { kind: 'rewrite', response } });
  it('each replace ≤ 64 KB', () => {
    expect(() => validateRule(rw({ replaceBody: [{ find: '"', replace: 'z'.repeat(MAX_REWRITE_REPLACE), all: true }] }))).not.toThrow();
    expect(() => validateRule(rw({ replaceBody: [{ find: '"', replace: 'z'.repeat(MAX_REWRITE_REPLACE + 1), all: true }] }))).toThrow(/at most 64 KB/);
  });
  it('all find + replace texts of a rule ≤ 256 KB (both sides together)', () => {
    const r = { find: 'x'.repeat(10 * 1024), replace: 'y'.repeat(60 * 1024) };
    expect(() => validateRule(rw({ replaceBody: [r, r, r] }))).not.toThrow(); // 210 KB
    expect(() => validateRule(rw({ replaceBody: [r, r, r, r] }))).toThrow(/total at most 256 KB/); // 280 KB
    const both = { ...rw({ replaceBody: [r, r] }), action: { kind: 'rewrite', request: { replaceBody: [r, r] }, response: { replaceBody: [r, r] } } };
    expect(() => validateRule(both)).toThrow(/total at most 256 KB/);
  });
});

describe('#9 HAR exports stay in real folders inside the project', () => {
  it('creates the folders and writes a new file (never over an existing entry)', async () => {
    const root = mkTmp();
    const now = new Date(Date.UTC(2026, 9, 10));
    const a = await writeHar(root, { log: {} }, now);
    const b = await writeHar(root, { log: {} }, now);
    expect(a).toBe(path.join(root, EXPORT_DIR, '2026-10-10T00-00-00-000Z.har'));
    expect(b).toBe(path.join(root, EXPORT_DIR, '2026-10-10T00-00-00-000Z-2.har'));
  });

  it('refuses a symlinked component (inside or outside the project)', async () => {
    const root = mkTmp();
    const outside = mkTmp();
    fs.mkdirSync(path.join(root, '.dart_tool'));
    fs.symlinkSync(outside, path.join(root, '.dart_tool', 'flutter_intercept'));
    await expect(writeHar(root, { log: {} })).rejects.toThrow(/symbolic link/);
    expect(fs.readdirSync(outside)).toEqual([]);
    const root2 = mkTmp();
    fs.mkdirSync(path.join(root2, 'docs'));
    fs.symlinkSync(path.join(root2, 'docs'), path.join(root2, '.dart_tool'));
    await expect(ensureDirInside(root2, EXPORT_DIR)).rejects.toThrow(/symbolic link/);
  });

  it('refuses a file where a folder should be, and a planted symlink as the target file name is not followed', async () => {
    const root = mkTmp();
    fs.writeFileSync(path.join(root, '.dart_tool'), 'x');
    await expect(ensureDirInside(root, EXPORT_DIR)).rejects.toThrow(/not a folder/);
    const root2 = mkTmp();
    const dir = await ensureDirInside(root2, EXPORT_DIR);
    const victim = path.join(mkTmp(), 'victim.txt');
    fs.writeFileSync(victim, 'keep');
    const now = new Date(Date.UTC(2026, 9, 10));
    fs.symlinkSync(victim, path.join(dir, '2026-10-10T00-00-00-000Z.har'));
    const written = await writeHar(root2, { log: {} }, now);
    expect(path.basename(written)).toBe('2026-10-10T00-00-00-000Z-2.har');
    expect(fs.readFileSync(victim, 'utf8')).toBe('keep');
  });
});
