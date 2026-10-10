/**
 * Starting flutter and showing its command line (REVIEW-7 #10, #11).
 * - `maskArgs`: what may be printed — user dart-define values become `***` (CI passes API keys that way and Flutter
 *   itself never prints them); our own defines are shown without credentials (the LAN token, §14.1); other
 *   secret-looking values are redacted.
 * - `spawnPlan`: never `shell: true`. A `.bat` / `.cmd` (Windows `flutter.bat`) runs through `cmd.exe /d /s /c` with
 *   every argument quoted and caret-escaped (the cross-spawn rules), so `& | < > ^ %` and spaces stay data.
 */
import { redactText } from '../../extension/src/agent/redact';
import { ENTRY_SHA_DEFINE_NAME, PROXY_DEFINE_NAME } from './names';

const OWN = new Set([PROXY_DEFINE_NAME, ENTRY_SHA_DEFINE_NAME]);

/**
 * `user:secret@host:port` → `user:***@host:port`. The physical-iPhone proxy define carries the run's LAN token
 * (CONTRACTS §7, §14.1): ours are shown, but never their credentials.
 */
export function maskProxyCredentials(value: string): string {
  return value.replace(/^([^:@/\s]*):[^@]*@/, '$1:***@');
}

function maskDefine(def: string): string {
  const eq = def.indexOf('=');
  if (eq < 0) return def;
  const name = def.slice(0, eq);
  return OWN.has(name) ? `${name}=${maskProxyCredentials(def.slice(eq + 1))}` : `${name}=***`;
}

/** Arguments safe to print: `--dart-define=NAME=***` (ours shown), other values passed through `redactText`. */
export function maskArgs(args: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith('--dart-define=')) {
      out.push(`--dart-define=${maskDefine(a.slice('--dart-define='.length))}`);
    } else if ((a === '--dart-define' || a === '-D') && i + 1 < args.length) {
      out.push(a, maskDefine(args[++i]));
    } else if (/^-D.+=/.test(a)) {
      out.push(`-D${maskDefine(a.slice(2))}`);
    } else out.push(redactText(a));
  }
  return out;
}

/** POSIX-shell-style quoting for display only. */
export function displayQuote(arg: string): string {
  return /^[\w@%+=:,./*-]+$/.test(arg) ? arg : `'${arg.replace(/'/g, `'\\''`)}'`;
}

export function displayCommand(cmd: string, args: string[]): string {
  return [cmd, ...maskArgs(args)].map(displayQuote).join(' ');
}

const CMD_META = /([()\][%!^"`<>&|;, *?])/g;

/**
 * One argument for `cmd.exe /d /s /c` running a batch file (cross-spawn's escapeArgument): backslashes before a
 * quote doubled, quotes backslash-escaped, the whole wrapped in quotes, then every cmd metacharacter caret-escaped —
 * twice for a batch file, which parses its arguments again. Newlines can't be passed safely and are refused.
 */
export function quoteCmdArg(arg: string, batch = true): string {
  if (/[\r\n\0]/.test(arg)) throw new Error('arguments with line breaks cannot be passed to flutter.bat');
  let a = arg.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\*)$/, '$1$1');
  a = `"${a}"`.replace(CMD_META, '^$1');
  return batch ? a.replace(CMD_META, '^$1') : a;
}

/** The program path: metacharacters (spaces included) caret-escaped once, not quoted (cross-spawn's escapeCommand). */
export function quoteCmdCommand(cmd: string): string {
  if (/[\r\n\0]/.test(cmd)) throw new Error('the flutter path cannot contain line breaks');
  return cmd.replace(CMD_META, '^$1');
}

export interface SpawnPlan {
  file: string;
  args: string[];
  windowsVerbatimArguments: boolean;
}

/** How to start `cmd` with `args` on `platform` without a shell interpreting the arguments. */
export function spawnPlan(cmd: string, args: string[], platform: NodeJS.Platform = process.platform, comspec = process.env.ComSpec): SpawnPlan {
  if (platform === 'win32' && /\.(bat|cmd)$/i.test(cmd)) {
    const line = [quoteCmdCommand(cmd), ...args.map((a) => quoteCmdArg(a))].join(' ');
    return { file: comspec || 'cmd.exe', args: ['/d', '/s', '/c', `"${line}"`], windowsVerbatimArguments: true };
  }
  return { file: cmd, args, windowsVerbatimArguments: false };
}
