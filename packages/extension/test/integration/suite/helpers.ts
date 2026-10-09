import * as http from 'http';
import * as net from 'net';
import { AddressInfo } from 'net';
import * as vscode from 'vscode';
import type { FlutterInterceptApi } from '../../../src/extension';

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function listen(server: http.Server): Promise<number> {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port)));
}

/** Origin server the fixture talks to; counts hits per path. */
export async function startOrigin(): Promise<{ server: http.Server; port: number; hits: (path: string) => number }> {
  const counts = new Map<string, number>();
  const server = http.createServer((req, res) => {
    const p = (req.url ?? '').split('?')[0];
    counts.set(p, (counts.get(p) ?? 0) + 1);
    res.setHeader('content-type', 'text/plain');
    res.end(`hello-from-origin ${req.url}`);
  });
  return { server, port: await listen(server), hits: (p) => counts.get(p) ?? 0 };
}

/** A free TCP port on 127.0.0.1 (released before returning). */
export function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => {
      const p = (s.address() as AddressInfo).port;
      s.close(() => resolve(p));
    });
  });
}

/** Polls `fn` until it returns a value other than undefined/false. */
export async function waitFor<T>(fn: () => T | undefined | false, timeoutMs: number, everyMs = 50): Promise<T> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const v = fn();
    if (v !== undefined && v !== false) return v as T;
    if (Date.now() > end) throw new Error('timed out');
    await sleep(everyMs);
  }
}

const outputs = new Map<string, string>();
let trackerRegistered = false;

/** Collects DAP `output` events per session. */
export function registerOutputTracker(): void {
  if (trackerRegistered) return;
  trackerRegistered = true;
  vscode.debug.registerDebugAdapterTrackerFactory('dart', {
    createDebugAdapterTracker(session) {
      return {
        onDidSendMessage(m: any) {
          if (m?.type === 'event' && m.event === 'output' && m.body?.category !== 'telemetry') {
            outputs.set(session.id, (outputs.get(session.id) ?? '') + (m.body?.output ?? ''));
          }
        },
      };
    },
  });
}

export interface SessionRun {
  session: vscode.DebugSession;
  output: string;
}

/**
 * Starts a session and waits for it to end (or, with `stopAfterStart`, stops it right after
 * it started). Matches sessions by name prefix because Dart-Code appends " (<device>)" to
 * Flutter session names.
 */
export async function runSession(
  folder: vscode.WorkspaceFolder,
  config: vscode.DebugConfiguration,
  opts: { timeoutMs?: number; stopAfterStart?: boolean } = {},
): Promise<SessionRun> {
  const timeoutMs = opts.timeoutMs ?? 90_000;
  const name = config.name as string;
  const matches = (s: vscode.DebugSession) => s.name === name || s.name.startsWith(name + ' (');
  const startedP = new Promise<vscode.DebugSession>((resolve) => {
    const d = vscode.debug.onDidStartDebugSession((s) => {
      if (matches(s)) {
        d.dispose();
        resolve(s);
      }
    });
  });
  const endedP = new Promise<void>((resolve) => {
    const d = vscode.debug.onDidTerminateDebugSession((s) => {
      if (matches(s)) {
        d.dispose();
        resolve();
      }
    });
  });
  const ok = await vscode.debug.startDebugging(folder, config);
  if (!ok) throw new Error(`startDebugging returned false for ${name}`);
  const started = await Promise.race([startedP, sleep(timeoutMs).then(() => undefined)]);
  if (!started) throw new Error(`session ${name} did not start`);
  if (opts.stopAfterStart) {
    await vscode.debug.stopDebugging(started);
    await Promise.race([endedP, sleep(15_000)]);
    return { session: started, output: outputs.get(started.id) ?? '' };
  }
  const ended = await Promise.race([endedP.then(() => true), sleep(timeoutMs).then(() => false)]);
  if (!ended) {
    await vscode.debug.stopDebugging(started);
    throw new Error(`session ${name} did not terminate within ${timeoutMs} ms; output: ${JSON.stringify((outputs.get(started.id) ?? '').slice(-800))}`);
  }
  await sleep(300); // trailing output events
  return { session: started, output: outputs.get(started.id) ?? '' };
}

export async function activateBoth(): Promise<{ api: FlutterInterceptApi; dartCode: vscode.Extension<unknown> }> {
  const dartCode = vscode.extensions.getExtension('Dart-Code.dart-code');
  if (!dartCode) throw new Error('Dart-Code is not installed in the test profile');
  await dartCode.activate();
  const ours = vscode.extensions.all.find((e) => e.packageJSON?.name === 'flutter-intercept');
  if (!ours) throw new Error('flutter-intercept extension not loaded');
  const api = (await ours.activate()) as FlutterInterceptApi;
  console.log(`[suite] Dart-Code ${dartCode.packageJSON.version} active=${dartCode.isActive}; ours active=${ours.isActive}`);
  return { api, dartCode };
}

export interface RunOutcome {
  name: string;
  finalProgram?: string;
  originalProgram?: string;
  debuggerType?: unknown;
  output: string;
  proxyHits: string[];
  dartCodeRanFirst?: boolean;
  mode?: string;
  failures: string[];
  ms: number;
}

/** Everything the debug adapter printed for this session so far. */
export function outputOf(session: vscode.DebugSession): string {
  return outputs.get(session.id) ?? '';
}

/** Starts a session and resolves when it has started (it keeps running). */
export async function startSession(folder: vscode.WorkspaceFolder, config: vscode.DebugConfiguration, timeoutMs = 120_000): Promise<vscode.DebugSession> {
  const name = config.name as string;
  const matches = (s: vscode.DebugSession) => s.name === name || s.name.startsWith(name + ' (');
  const startedP = new Promise<vscode.DebugSession>((resolve) => {
    const d = vscode.debug.onDidStartDebugSession((s) => {
      if (matches(s)) {
        d.dispose();
        resolve(s);
      }
    });
  });
  const ok = await vscode.debug.startDebugging(folder, config);
  if (!ok) throw new Error(`startDebugging returned false for ${name}`);
  const s = await Promise.race([startedP, sleep(timeoutMs).then(() => undefined)]);
  if (!s) throw new Error(`session ${name} did not start`);
  return s;
}

/** Stops a session and waits for it to terminate. */
export async function stopSession(session: vscode.DebugSession, timeoutMs = 30_000): Promise<boolean> {
  const ended = new Promise<void>((resolve) => {
    const d = vscode.debug.onDidTerminateDebugSession((s) => {
      if (s.id === session.id) {
        d.dispose();
        resolve();
      }
    });
  });
  await vscode.debug.stopDebugging(session);
  return Promise.race([ended.then(() => true), sleep(timeoutMs).then(() => false)]);
}
