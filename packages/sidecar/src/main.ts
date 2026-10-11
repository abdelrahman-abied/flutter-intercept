/**
 * `node sidecar.js`: the Flutter Intercept host for Android Studio / IntelliJ (CONTRACTS §15). Speaks newline-delimited
 * JSON on stdin/stdout (types.ts), logs to stderr (never secrets), exits when stdin closes (the IDE went away) or
 * after `shutdown`, always stopping the proxy and undoing adb reverses / emulator proxies first.
 */
import * as fs from 'fs';
import * as path from 'path';
import { SidecarHost } from './host';
import { RpcPeer } from './rpc';

declare const __FI_SIDECAR_VERSION__: string | undefined;

export function sidecarVersion(): string {
  if (typeof __FI_SIDECAR_VERSION__ === 'string') return __FI_SIDECAR_VERSION__;
  try {
    return (JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8')) as { version?: string }).version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

/** The webview bundle: next to the sidecar bundle (dist/webview, plugin sidecar/webview), else the source tree. */
export function defaultWebviewDir(): string {
  const candidates = [path.join(__dirname, 'webview'), path.join(__dirname, '..', '..', 'webview', 'dist')];
  return candidates.find((d) => fs.existsSync(path.join(d, 'webview.js'))) ?? candidates[0];
}

export function main(): void {
  const writeLog = (line: string) => process.stderr.write(`${new Date().toISOString()} ${line.replace(/[\r\n]+/g, ' ')}\n`);
  // stdout carries the protocol only: anything a bundled module prints goes to stderr instead.
  const show = (a: unknown): string => {
    if (typeof a === 'string') return a;
    try {
      return JSON.stringify(a);
    } catch {
      return String(a);
    }
  };
  for (const k of ['log', 'info', 'debug', 'warn', 'trace'] as const) console[k] = (...args: unknown[]) => writeLog(args.map(show).join(' '));
  let host: SidecarHost | undefined;
  let exiting = false;
  const exit = (code: number) => {
    if (exiting) return;
    exiting = true;
    const force = setTimeout(() => process.exit(code), 5000);
    force.unref();
    void (host?.shutdown() ?? Promise.resolve()).finally(() => process.exit(code));
  };
  const peer = new RpcPeer({
    input: process.stdin,
    output: process.stdout,
    log: (l) => host?.log(l) ?? writeLog(l),
    onRequest: async (method, params) => {
      const result = await host!.handle(method, params);
      if (method === 'shutdown') setImmediate(() => exit(0));
      return result;
    },
    onClose: () => exit(0),
  });
  host = new SidecarHost({
    link: { request: (m, p) => peer.request(m, p), event: (e, d) => peer.event(e, d) },
    log: (line) => {
      writeLog(line);
      peer.event('log', { line });
    },
    version: sidecarVersion(),
    webviewDir: defaultWebviewDir(),
  });
  process.on('unhandledRejection', (e) => host?.log(`unhandled rejection: ${(e as Error)?.stack ?? e}`));
  process.on('uncaughtException', (e) => host?.log(`uncaught exception: ${e?.stack ?? e}`));
  for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP'] as const) process.on(sig, () => exit(0));
}

if (require.main === module) main();
