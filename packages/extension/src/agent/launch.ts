/**
 * AppLauncher (CONTRACTS §8: launch_app / stop_app / hot_restart): starts a normal Dart-Code debug
 * session exactly like F5, so our DebugConfigurationProvider intercepts it (and still refuses release
 * builds). Tracks live intercepted Dart sessions for `sessions()`.
 *
 * `vscode` is injected (tests pass a fake); at runtime the real module is loaded lazily.
 */
import type * as vscodeTypes from 'vscode';
import * as path from 'path';
import { debuggerTypeName, LAN_KEY, ORIGINAL_PROGRAM_KEY } from '../debug/rewrite';
import { findPubspecRoot, FsLike, isWithin, readPubspec } from '../entry/generator';
import { AgentToolError, AppLauncher } from './types';

export const AGENT_SESSION_NAME = 'Flutter Intercept (agent)';
export const DART_CODE_ID = 'Dart-Code.dart-code';
/** Launch config field carrying a per-launch nonce: identifies the started session (Dart-Code renames it to "<name> (<device>)"). */
export const AGENT_LAUNCH_KEY = 'flutterInterceptAgentLaunch';
let launchCounter = 0;

type Session = Pick<vscodeTypes.DebugSession, 'id' | 'type' | 'name' | 'configuration' | 'customRequest'>;
type Disposable = { dispose(): unknown };

/** The slice of the `vscode` API the launcher uses. */
export interface LauncherVscode {
  debug: {
    startDebugging(folder: { uri: { fsPath: string } } | undefined, config: Record<string, unknown>): Thenable<boolean>;
    stopDebugging(session?: Session): Thenable<void>;
    onDidStartDebugSession(l: (s: Session) => void): Disposable;
    onDidTerminateDebugSession(l: (s: Session) => void): Disposable;
  };
  workspace: { workspaceFolders?: readonly { uri: { fsPath: string }; name: string }[] };
  extensions: { getExtension(id: string): unknown };
  commands: { executeCommand<T>(cmd: string, ...args: unknown[]): Thenable<T> };
}

export interface LauncherDeps {
  vscode?: LauncherVscode;
  /** Max wait for VS Code to report the session started (not the app build). Default 120 s. */
  startTimeoutMs?: number;
  /** Max wait for a stopped session to terminate. Default 15 s. */
  stopTimeoutMs?: number;
  fs?: FsLike;
  log?: (msg: string) => void;
}

export interface SessionInfo {
  id: string;
  deviceId?: string;
  program: string;
  mode: string;
  lan?: boolean;
}

export interface AgentAppLauncher extends AppLauncher {
  /** Stops tracking sessions (the debug sessions themselves keep running). */
  dispose(): void;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function isIntercepted(s: Session): boolean {
  return s.type === 'dart' && typeof s.configuration?.[ORIGINAL_PROGRAM_KEY] === 'string';
}

export function sessionInfo(s: Session): SessionInfo {
  const c = s.configuration ?? {};
  const flutter = debuggerTypeName(c.debuggerType) === 'Flutter';
  const mode = typeof c.flutterMode === 'string' && c.flutterMode ? c.flutterMode.toLowerCase() : flutter ? 'debug' : 'dart';
  const info: SessionInfo = {
    id: s.id,
    program: String(c[ORIGINAL_PROGRAM_KEY] ?? c.program ?? ''),
    mode,
  };
  if (typeof c.deviceId === 'string' && c.deviceId) info.deviceId = c.deviceId;
  if (c[LAN_KEY] === true) info.lan = true;
  return info;
}

export function createAppLauncher(deps: LauncherDeps = {}): AgentAppLauncher {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const vs: LauncherVscode = deps.vscode ?? (require('vscode') as LauncherVscode);
  const log = deps.log ?? (() => undefined);
  const live = new Map<string, Session>();
  const startWaiters = new Set<(s: Session) => void>();
  let queue: Promise<unknown> = Promise.resolve();

  const subs: Disposable[] = [
    vs.debug.onDidStartDebugSession((s) => {
      if (isIntercepted(s)) live.set(s.id, s);
      for (const w of [...startWaiters]) w(s);
    }),
    vs.debug.onDidTerminateDebugSession((s) => {
      live.delete(s.id);
    }),
  ];

  function folders() {
    return vs.workspace.workspaceFolders ?? [];
  }

  /** Workspace folder + project root for a launch. */
  function chooseProject(program?: string): { folder: { uri: { fsPath: string }; name: string }; root: string; isFlutter: boolean } {
    const fsx = deps.fs;
    const all = folders();
    if (!all.length) throw new AgentToolError('No folder is open in VS Code: open the Flutter project first.', 'state');
    if (program) {
      const candidates = path.isAbsolute(program) ? [program] : all.map((f) => path.join(f.uri.fsPath, program));
      for (const p of candidates) {
        const root = findPubspecRoot(p, fsx);
        const folder = all.find((f) => isWithin(p, f.uri.fsPath));
        if (root && folder) return { folder, root, isFlutter: readPubspec(root, fsx).isFlutter };
      }
      throw new AgentToolError(`program ${program} is not inside a Dart/Flutter project of the open workspace.`, 'invalid');
    }
    const projects = all
      .map((folder) => ({ folder, root: folder.uri.fsPath, info: readPubspec(folder.uri.fsPath, fsx) }))
      .filter((p) => p.info.name !== undefined || p.info.isFlutter);
    const pick = projects.find((p) => p.info.isFlutter) ?? projects[0];
    if (!pick) throw new AgentToolError('No Flutter project is open (no pubspec.yaml at the root of a workspace folder).', 'state');
    return { folder: pick.folder, root: pick.root, isFlutter: pick.info.isFlutter };
  }

  async function selectedDevice(): Promise<string | undefined> {
    try {
      const id = await Promise.race([
        Promise.resolve(vs.commands.executeCommand<string | undefined>('flutter.getSelectedDeviceId')),
        sleep(2000).then(() => undefined),
      ]);
      return typeof id === 'string' && id ? id : undefined;
    } catch {
      return undefined;
    }
  }

  async function doLaunch(opts: { deviceId?: string; program?: string; flutterMode?: string }) {
    if (!vs.extensions.getExtension(DART_CODE_ID)) {
      throw new AgentToolError('The Dart-Code extension (Dart-Code.dart-code) is not installed: Flutter Intercept launches apps through it.', 'state');
    }
    const mode = (opts.flutterMode ?? 'debug').toLowerCase();
    if (mode === 'release') throw new AgentToolError('Release builds are never intercepted; use flutterMode "debug" or "profile".', 'invalid');
    if (mode !== 'debug' && mode !== 'profile') throw new AgentToolError(`flutterMode must be "debug" or "profile", got "${opts.flutterMode}".`, 'invalid');
    const { folder, root, isFlutter } = chooseProject(opts.program);
    let deviceId = opts.deviceId;
    if (!deviceId && isFlutter) {
      deviceId = await selectedDevice();
      if (!deviceId) {
        throw new AgentToolError(
          'No device: pass deviceId (see `flutter devices`) or select a device in the VS Code status bar.',
          'state',
        );
      }
    }
    const nonce = `${Date.now().toString(36)}-${++launchCounter}`;
    const config: Record<string, unknown> = { type: 'dart', request: 'launch', name: AGENT_SESSION_NAME, cwd: root, [AGENT_LAUNCH_KEY]: nonce };
    if (deviceId) config.deviceId = deviceId;
    if (opts.program) config.program = opts.program;
    if (isFlutter) config.flutterMode = mode;

    const timeoutMs = deps.startTimeoutMs ?? 120_000;
    let onStart!: (s: Session) => void;
    const started = new Promise<Session>((resolve) => {
      onStart = (s) => {
        if (s.type === 'dart' && s.configuration?.[AGENT_LAUNCH_KEY] === nonce) resolve(s);
      };
      startWaiters.add(onStart);
    });
    try {
      log(`agent launch: ${JSON.stringify({ ...config, cwd: path.basename(root) })}`);
      const ok = await vs.debug.startDebugging(folder, config);
      if (!ok) {
        throw new AgentToolError('VS Code did not start the debug session (Dart-Code reported a problem: see the Debug Console / notifications).', 'state');
      }
      const s = await Promise.race([started, sleep(timeoutMs).then(() => undefined)]);
      if (!s) throw new AgentToolError(`The debug session did not start within ${Math.round(timeoutMs / 1000)} s.`, 'timeout');
      const intercepted = isIntercepted(s);
      if (intercepted) live.set(s.id, s);
      return { sessionId: s.id, intercepted, ...sessionInfo(s) };
    } finally {
      startWaiters.delete(onStart);
    }
  }

  function targets(sessionId?: string): Session[] {
    if (sessionId) {
      const s = live.get(sessionId);
      if (!s) throw new AgentToolError(`No running intercepted session ${sessionId} (see get_status).`, 'not_found');
      return [s];
    }
    return [...live.values()];
  }

  return {
    launch(opts) {
      // One launch at a time: the started session is matched by name.
      const run = queue.then(() => doLaunch(opts));
      queue = run.catch(() => undefined);
      return run;
    },

    async stop(sessionId) {
      const list = targets(sessionId);
      const timeout = deps.stopTimeoutMs ?? 15_000;
      let stopped = 0;
      await Promise.all(
        list.map(async (s) => {
          const ended = new Promise<boolean>((resolve) => {
            const d = vs.debug.onDidTerminateDebugSession((t) => {
              if (t.id === s.id) {
                d.dispose();
                resolve(true);
              }
            });
            void sleep(timeout).then(() => {
              d.dispose();
              resolve(false);
            });
          });
          await vs.debug.stopDebugging(s);
          if (await ended) stopped++;
          live.delete(s.id);
        }),
      );
      return { stopped };
    },

    async hotRestart(sessionId) {
      const list = targets(sessionId);
      if (!list.length) throw new AgentToolError('No running intercepted session to hot restart (launch_app first).', 'state');
      const errors: string[] = [];
      let restarted = 0;
      for (const s of list) {
        const info = sessionInfo(s);
        if (info.mode !== 'debug') {
          errors.push(`${s.id}: hot restart needs a debug-mode Flutter session (this one is ${info.mode})`);
          continue;
        }
        try {
          await s.customRequest('hotRestart');
          restarted++;
        } catch (e) {
          errors.push(`${s.id}: ${(e as Error)?.message ?? String(e)}`);
        }
      }
      if (!restarted && errors.length) throw new AgentToolError(`Hot restart failed: ${errors.join('; ')}`, 'state');
      return errors.length ? { restarted, errors } : { restarted };
    },

    sessions() {
      return [...live.values()].map(sessionInfo);
    },

    dispose() {
      for (const d of subs) d.dispose();
      live.clear();
    },
  };
}
