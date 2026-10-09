// What a REAL dart:io HttpClient sees for each fault / the offline profile (docs/spikes/faults.md), and
// that none of them makes Dart fall back to DIRECT. The client is configured like the generated entry:
// findProxy 'PROXY 127.0.0.1:<port>; DIRECT'. A DIRECT fallback would reach the upstream without the
// proxy, so the upstream's hit count detects it (the control row proves the detection works).
import { execFile, execFileSync } from 'child_process';
import * as fs from 'fs';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { InterceptProxy, NetworkProfile, Rule } from '../src';
import { settled, startProxy, startUpstream, type Upstream } from './helpers';

const FIXTURE = path.join(__dirname, 'fixtures', 'fault_client.dart');
let exe: string;
let tmp: string;
let up: Upstream;
let proxy: InterceptProxy;

interface Seen {
  phase: string;
  type: string;
  message: string;
  status: number | null;
  bytes: number;
  ms: number;
}

function dart(port: number, url: string, timeoutMs = 10_000): Promise<Seen> {
  return new Promise((resolve, reject) => {
    execFile(exe, [String(port), url, String(timeoutMs)], { timeout: 60_000 }, (err, stdout) => {
      try {
        resolve(JSON.parse(String(stdout).trim().split('\n').pop()!));
      } catch {
        reject(err ?? new Error(`bad output: ${stdout}`));
      }
    });
  });
}

const table: string[] = [];
function row(name: string, scheme: string, s: Seen, hits: number, state: string): void {
  const msg = s.message.replace(/, uri = \S+/, '').replace(/https?:\/\/127\.0\.0\.1:\d+/, '<url>');
  table.push(`| ${name} | ${scheme} | ${s.phase} | ${s.status ?? '–'} | \`${s.type}\` | ${msg || '–'} | ${s.bytes} | ${hits} | ${state} |`);
}

beforeAll(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fi-faults-'));
  exe = path.join(tmp, process.platform === 'win32' ? 'fault_client.exe' : 'fault_client');
  execFileSync('dart', ['compile', 'exe', FIXTURE, '-o', exe], { stdio: 'pipe' });
  up = await startUpstream();
});
afterAll(async () => {
  await up?.close();
  fs.rmSync(tmp, { recursive: true, force: true });
  // The measured table (docs/spikes/faults.md).
  console.log(['| case | scheme | ends in | status | Dart type | message | body bytes | upstream hits | exchange |', ...table].join('\n'));
});
beforeEach(async () => {
  proxy = await startProxy({ breakpointTimeoutMs: 3000 });
  up.hits.length = 0;
});
afterEach(async () => {
  await proxy.stop();
});

const faultRule = (fault: 'reset' | 'timeout' | 'truncate' | 'dns'): Rule => ({
  id: fault,
  enabled: true,
  match: { url: '*' },
  action: { kind: 'fault', fault },
});

interface Case {
  name: string;
  rule?: Rule;
  profile?: NetworkProfile;
  timeoutMs?: number;
  expect: { phase: string; type: RegExp; hits: number; state: string };
}

const cases: Case[] = [
  { name: 'fault reset', rule: faultRule('reset'), expect: { phase: 'close', type: /HttpException/, hits: 0, state: 'blocked' } },
  { name: 'fault dns', rule: faultRule('dns'), expect: { phase: 'close', type: /HttpException/, hits: 0, state: 'blocked' } },
  { name: 'offline profile', profile: { kind: 'offline' }, expect: { phase: 'close', type: /HttpException/, hits: 0, state: 'blocked' } },
  {
    name: 'fault timeout (app timeout 1.5 s)',
    rule: faultRule('timeout'),
    timeoutMs: 1500,
    expect: { phase: 'close', type: /TimeoutException/, hits: 0, state: 'blocked' },
  },
  {
    name: 'fault timeout (no app timeout; hold 3 s)',
    rule: faultRule('timeout'),
    expect: { phase: 'close', type: /HttpException/, hits: 0, state: 'blocked' },
  },
  { name: 'fault truncate', rule: faultRule('truncate'), expect: { phase: 'body', type: /HttpException/, hits: 1, state: 'blocked' } },
  { name: 'Slow 3G profile (+400 ms, 400 kbps)', profile: { kind: 'throttle', preset: 'slow-3g', latencyMs: 400, kbps: 400 }, expect: { phase: 'done', type: /ok/, hits: 1, state: 'completed' } },
  {
    name: 'throttle dropRate 1',
    rule: { id: 'd', enabled: true, match: { url: '*' }, action: { kind: 'throttle', dropRate: 1 } },
    expect: { phase: 'close', type: /HttpException/, hits: 0, state: 'blocked' },
  },
];

describe('faults as seen by a real dart:io HttpClient (PROXY …; DIRECT)', () => {
  for (const c of cases) {
    for (const scheme of ['http', 'https'] as const) {
      it(`${c.name} — ${scheme}: ${c.expect.type.source} at "${c.expect.phase}", no DIRECT fallback`, async () => {
        if (c.rule) proxy.setRules([c.rule]);
        if (c.profile) proxy.setNetworkProfile(c.profile);
        const base = scheme === 'http' ? up.httpUrl : up.httpsUrl;
        const s = await dart(proxy.port, `${base}/big?size=10000`, c.timeoutMs);
        const [ex] = await settled(proxy, 5000);
        row(c.name, scheme, s, up.hits.length, ex?.state ?? '–');
        expect(s.phase).toBe(c.expect.phase);
        expect(s.type).toMatch(c.expect.type);
        expect(up.hits.length).toBe(c.expect.hits); // > expected = Dart went DIRECT
        expect(ex?.state).toBe(c.expect.state);
        if (c.name === 'fault truncate') expect(s.bytes).toBeLessThan(10_000);
        if (c.profile?.kind === 'throttle') expect(s).toMatchObject({ status: 200, bytes: 10_000 });
        if (c.profile?.kind === 'throttle') expect(s.ms).toBeGreaterThanOrEqual(550); // 400 ms + 10 KB at 50 KB/s
      }, 30_000);
    }
  }

  it('reference: a real lookup failure behind the proxy is a 502 (the proxy did the lookup)', async () => {
    const s = await dart(proxy.port, 'http://does-not-exist.invalid/x');
    row('reference: real DNS failure via proxy', 'http', s, up.hits.length, (await settled(proxy))[0]?.state ?? '–');
    expect(s).toMatchObject({ phase: 'done', status: 502 });
  });

  it('control: an unreachable proxy DOES make Dart go DIRECT (the detection works)', async () => {
    const closed = await new Promise<number>((resolve) => {
      const srv = net.createServer().listen(0, '127.0.0.1', () => {
        const p = (srv.address() as net.AddressInfo).port;
        srv.close(() => resolve(p));
      });
    });
    const s = await dart(closed, `${up.httpUrl}/json`);
    row('control: proxy port closed', 'http', s, up.hits.length, '–');
    expect(s).toMatchObject({ phase: 'done', status: 200 });
    expect(up.hits.length).toBe(1);
  });
});
