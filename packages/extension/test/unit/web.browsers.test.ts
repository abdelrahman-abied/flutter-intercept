/**
 * REVIEW-8 #10: the debug browser is identified by its process (this session's flags, a flutter_tools profile) and
 * its DevTools port is used only when that process owns the listener (macOS lsof, Linux /proc, Windows netstat).
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import { browserFlagValues, Exec, listDebugBrowsers, listenerBelongsTo, parseBrowserCommandLine } from '../../src/web/browsers';

const PAC = '--proxy-pac-url=http://127.0.0.1:7000/flutter-intercept-9123.pac';
const PIN = '--ignore-certificate-errors-spki-list=M5zrAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAqQxw=';
const CMD = ` chrome --user-data-dir=/tmp/flutter_tools.A/flutter_tools_chrome_device.B --remote-debugging-port=9333 ${PAC} ${PIN} http://localhost:5000`;
const out = (s: string): Awaited<ReturnType<Exec>> => ({ stdout: Buffer.from(s), stderr: '' });

describe('parseBrowserCommandLine / browserFlagValues', () => {
  it('needs the flutter_tools profile, a port, every session flag as a whole argument, and no --type=', () => {
    const flags = browserFlagValues(['--web-browser-flag=' + PAC, '--web-browser-flag=' + PIN, '--web-port=5000']);
    expect(flags).toEqual([PAC, PIN]);
    expect(parseBrowserCommandLine(CMD, flags)).toBe(9333);
    expect(parseBrowserCommandLine(CMD + ' --type=renderer', flags)).toBeUndefined();
    expect(parseBrowserCommandLine(CMD.replace('flutter_tools_chrome_device', 'profile'), flags)).toBeUndefined();
    expect(parseBrowserCommandLine(CMD.replace('--remote-debugging-port=9333', ''), flags)).toBeUndefined();
    expect(parseBrowserCommandLine(CMD.replace(PAC, PAC + 'x'), flags)).toBeUndefined(); // prefix of another argument
    expect(parseBrowserCommandLine(CMD, [])).toBeUndefined();
  });
});

describe('listDebugBrowsers', () => {
  it('ps (POSIX): this user only', async () => {
    const exec: Exec = async (cmd, args) => {
      expect([cmd, ...args]).toEqual(['ps', '-A', '-ww', '-o', 'pid=,uid=,args=']);
      return out(`  10 501${CMD}\n  11 502${CMD}\n  12 501 /bin/zsh\n`);
    };
    expect(await listDebugBrowsers([PAC, PIN], { exec, platform: 'darwin', uid: 501 })).toEqual([{ pid: 10, port: 9333 }]);
  });
  it('Windows: PowerShell CIM JSON (object or array)', async () => {
    const exec: Exec = async (cmd) => {
      expect(cmd).toBe('powershell.exe');
      return out(JSON.stringify({ ProcessId: 77, CommandLine: `"C:\\Program Files\\Google\\Chrome\\chrome.exe"${CMD}` }));
    };
    expect(await listDebugBrowsers([PAC, PIN], { exec, platform: 'win32' })).toEqual([{ pid: 77, port: 9333 }]);
  });
});

describe('listenerBelongsTo', () => {
  it('Linux /proc: the LISTEN socket inode must be one of the process fds', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fi-proc-'));
    try {
      fs.mkdirSync(path.join(root, 'net'));
      const hdr = '  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode\n';
      fs.writeFileSync(path.join(root, 'net', 'tcp'), hdr + `   0: 0100007F:2475 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 55555 1\n`);
      fs.mkdirSync(path.join(root, '10', 'fd'), { recursive: true });
      fs.symlinkSync('socket:[55555]', path.join(root, '10', 'fd', '7'));
      fs.mkdirSync(path.join(root, '11', 'fd'), { recursive: true });
      fs.symlinkSync('socket:[1]', path.join(root, '11', 'fd', '7'));
      const exec: Exec = async () => { throw new Error('no exec on linux'); };
      expect(await listenerBelongsTo(10, 9333, { exec, platform: 'linux', procRoot: root })).toBe(true); // 0x2475 = 9333
      expect(await listenerBelongsTo(11, 9333, { exec, platform: 'linux', procRoot: root })).toBe(false);
      expect(await listenerBelongsTo(10, 9334, { exec, platform: 'linux', procRoot: root })).toBe(false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
  it('Windows netstat: LISTENING on loopback by that pid', async () => {
    const exec: Exec = async () => out('  TCP    127.0.0.1:9333   0.0.0.0:0   LISTENING   77\r\n  TCP    127.0.0.1:9334   0.0.0.0:0   LISTENING   78\r\n');
    expect(await listenerBelongsTo(77, 9333, { exec, platform: 'win32' })).toBe(true);
    expect(await listenerBelongsTo(78, 9333, { exec, platform: 'win32' })).toBe(false);
  });
  it('macOS lsof: pid printed = yes; exit 1 = no; missing lsof = error', async () => {
    expect(await listenerBelongsTo(10, 9333, { exec: async () => out('10\n'), platform: 'darwin' })).toBe(true);
    expect(await listenerBelongsTo(10, 9333, { exec: async () => Promise.reject(Object.assign(new Error('x'), { code: 1 })), platform: 'darwin' })).toBe(false);
    await expect(listenerBelongsTo(10, 9333, { exec: async () => Promise.reject(Object.assign(new Error('x'), { code: 'ENOENT' })), platform: 'darwin' })).rejects.toThrow(/lsof/);
  });
});
