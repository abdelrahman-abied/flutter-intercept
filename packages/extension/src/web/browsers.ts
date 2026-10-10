/**
 * Finding the debug Chrome/Edge flutter_tools started for a web session, without trusting a port number we chose
 * (REVIEW-8 #10). flutter_tools launches it with `--user-data-dir=<systemTemp>/flutter_tools.XXXX/flutter_tools_chrome_device.XXXX`
 * and `--remote-debugging-port=<its own findFreePort()>` plus our browser flags (`chrome.dart` `launch`). Chrome writes
 * no `DevToolsActivePort` for a fixed port (measured: only with port 0), so:
 *
 * 1. the process list: browser (not `--type=` child) processes owned by this user whose command line has a flutter_tools
 *    profile, a remote-debugging port and every browser flag this session was given (`flutterInterceptWebFlags`);
 * 2. the listener on 127.0.0.1:<port> must belong to that very process (macOS `lsof`, Linux `/proc`, Windows `netstat`):
 *    a process that grabbed the port first is never talked to. When this can't be checked, the browser is not used.
 *
 * vscode-free: commands run through the injected `exec` (argument arrays, no shell).
 */
import * as fs from 'fs';

export type Exec = (cmd: string, args: string[], opts?: { timeoutMs?: number; maxBuffer?: number }) => Promise<{ stdout: Buffer; stderr: string }>;

export interface BrowserProcess {
  pid: number;
  port: number;
}

export interface BrowserDiscoveryDeps {
  exec: Exec;
  platform?: NodeJS.Platform;
  /** Owner the browser process must have (default `process.getuid()`; not checked on Windows). */
  uid?: number | null;
  /** Linux `/proc` root (tests). */
  procRoot?: string;
}

const TOOL_TIMEOUT_MS = 10_000;
const PROFILE = /--user-data-dir=\S*flutter_tools_chrome_device\.\S*/;

/** Our recorded `--web-browser-flag=X` entries → the `X` values the browser command line must contain. */
export function browserFlagValues(webFlags: unknown): string[] {
  return (Array.isArray(webFlags) ? webFlags : [])
    .map(String)
    .filter((f) => f.startsWith('--web-browser-flag='))
    .map((f) => f.slice('--web-browser-flag='.length))
    .filter((v) => /^--[\w-]+=\S+$/.test(v));
}

function hasArg(cmdline: string, arg: string): boolean {
  const i = cmdline.indexOf(arg);
  if (i < 0) return false;
  const before = i === 0 ? ' ' : cmdline[i - 1];
  const after = cmdline[i + arg.length] ?? ' ';
  return /\s|"/.test(before) && /\s|"/.test(after);
}

/** The debug browser described by one command line, if it is one (the browser process, not a child). */
export function parseBrowserCommandLine(cmdline: string, flags: string[]): number | undefined {
  if (/\s--type=/.test(cmdline) || !PROFILE.test(cmdline)) return undefined;
  const m = /\s--remote-debugging-port=(\d{1,5})(?=\s|"|$)/.exec(cmdline);
  const port = m ? Number(m[1]) : 0;
  if (!port || port > 65535) return undefined;
  if (!flags.length || !flags.every((f) => hasArg(cmdline, f))) return undefined;
  return port;
}

/** Browser processes (owned by this user) started by flutter_tools with this session's flags. */
export async function listDebugBrowsers(flags: string[], deps: BrowserDiscoveryDeps): Promise<BrowserProcess[]> {
  const platform = deps.platform ?? process.platform;
  const out: BrowserProcess[] = [];
  if (!flags.length) return out;
  if (platform === 'win32') {
    const script =
      "Get-CimInstance Win32_Process -Filter \"Name='chrome.exe' or Name='msedge.exe'\" | " +
      'Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress';
    const { stdout } = await deps.exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { timeoutMs: TOOL_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024 });
    let rows: unknown;
    try {
      rows = JSON.parse(stdout.toString('utf8') || '[]');
    } catch {
      return out;
    }
    for (const r of Array.isArray(rows) ? rows : [rows]) {
      const pid = Number((r as { ProcessId?: unknown })?.ProcessId);
      const cmd = (r as { CommandLine?: unknown })?.CommandLine;
      if (!Number.isInteger(pid) || pid <= 0 || typeof cmd !== 'string') continue;
      const port = parseBrowserCommandLine(` ${cmd}`, flags);
      if (port) out.push({ pid, port });
    }
    return out;
  }
  const uid = 'uid' in deps ? deps.uid : process.getuid?.();
  const { stdout } = await deps.exec('ps', ['-A', '-ww', '-o', 'pid=,uid=,args='], { timeoutMs: TOOL_TIMEOUT_MS, maxBuffer: 32 * 1024 * 1024 });
  for (const line of stdout.toString('utf8').split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    if (!m) continue;
    if (uid !== null && uid !== undefined && Number(m[2]) !== uid) continue;
    const port = parseBrowserCommandLine(` ${m[3]}`, flags);
    if (port) out.push({ pid: Number(m[1]), port });
  }
  return out;
}

/** Linux: does process `pid` own a socket listening on TCP `port` (loopback or any)? */
async function linuxListens(pid: number, port: number, procRoot: string): Promise<boolean> {
  const inodes = new Set<string>();
  const hexPort = port.toString(16).toUpperCase().padStart(4, '0');
  for (const table of ['net/tcp', 'net/tcp6']) {
    let text = '';
    try {
      text = await fs.promises.readFile(`${procRoot}/${table}`, 'utf8');
    } catch {
      continue;
    }
    for (const line of text.split('\n').slice(1)) {
      const cols = line.trim().split(/\s+/);
      // sl local_address rem_address st tx:rx tr:tm retrnsmt uid timeout inode
      if (cols.length < 10 || cols[3] !== '0A') continue; // LISTEN
      if (cols[1].split(':')[1]?.toUpperCase() === hexPort) inodes.add(cols[9]);
    }
  }
  if (!inodes.size) return false;
  let fds: string[];
  try {
    fds = await fs.promises.readdir(`${procRoot}/${pid}/fd`);
  } catch {
    return false;
  }
  for (const fd of fds) {
    try {
      const m = /^socket:\[(\d+)\]$/.exec(await fs.promises.readlink(`${procRoot}/${pid}/fd/${fd}`));
      if (m && inodes.has(m[1])) return true;
    } catch {
      /* closed meanwhile */
    }
  }
  return false;
}

/**
 * True only when the TCP listener on `port` belongs to process `pid`. Throws when the platform tool needed to check it
 * is missing (the caller then refuses to use the browser).
 */
export async function listenerBelongsTo(pid: number, port: number, deps: BrowserDiscoveryDeps): Promise<boolean> {
  const platform = deps.platform ?? process.platform;
  if (platform === 'linux') return linuxListens(pid, port, deps.procRoot ?? '/proc');
  if (platform === 'win32') {
    const { stdout } = await deps.exec('netstat', ['-ano', '-p', 'TCP'], { timeoutMs: TOOL_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024 });
    return stdout
      .toString('utf8')
      .split('\n')
      .some((l) => {
        const c = l.trim().split(/\s+/);
        return c.length >= 5 && c[0] === 'TCP' && /^(127\.0\.0\.1|0\.0\.0\.0|\[::1\]|\[::\]):(\d+)$/.test(c[1]) && c[1].endsWith(`:${port}`) && c[3] === 'LISTENING' && Number(c[4]) === pid;
      });
  }
  // macOS / BSD: lsof prints the pid when that process listens on the port; exit 1 (rejects) when it doesn't.
  try {
    const { stdout } = await deps.exec('lsof', ['-nP', '-a', '-p', String(pid), `-iTCP:${port}`, '-sTCP:LISTEN', '-t'], { timeoutMs: TOOL_TIMEOUT_MS });
    return stdout.toString('utf8').split(/\s+/).includes(String(pid));
  } catch (e) {
    if ((e as NodeJS.ErrnoException)?.code === 'ENOENT') throw new Error('lsof is not available to verify the browser');
    return false;
  }
}
