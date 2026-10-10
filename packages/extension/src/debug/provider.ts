import * as net from 'net';
import * as vscode from 'vscode';
import { ReverseTracker, withSoftTimeout } from '../adb';
import { writeEntry } from '../entry/generator';
import type { LanOpening, ProxyHost } from '../proxyHost';
import { LanDeps, prepareLan } from './lanPrepare';
import { PacServer, WebPacSource } from './pacServer';
import { DebugConfig, isWebDevice, MARKER_KEY, ORIGINAL_PROGRAM_KEY, rewriteDebugConfig, RewriteResult } from './rewrite';

export interface InterceptEvent {
  time: number;
  hook: 'resolveDebugConfiguration' | 'resolveDebugConfigurationWithSubstitutedVariables' | 'command';
  result: 'skip' | 'rewrite' | 'error';
  mode?: string;
  reason?: string;
  program?: string;
  originalProgram?: string;
  /** Whether Dart-Code had already resolved the config when our hook ran. */
  dartCodeRanFirst?: boolean;
}

export interface PrepareDeps {
  proxyHost: ProxyHost;
  /** PEM certificate of this install's CA (created on first use; the proxy signs with its key). */
  getCaCertPem: () => Promise<string>;
  log: (msg: string) => void;
  events: InterceptEvent[];
  /** Max time the launch waits for adb (the reverse keeps going in the background). */
  adbBudgetMs?: number;
  reverses: ReverseTracker;
  /** LAN mode (CONTRACTS §7). All optional: without them physical iOS is not special-cased. */
  lan?: LanDeps;
  /**
   * A Flutter Web launch on the `web-server` device was not intercepted (CONTRACTS §11.3): `message` says why.
   * Called on every such launch; the host shows it once.
   */
  webServerSkipped?: (message: string) => void;
  /**
   * A Flutter Web launch on the user's own browser profile (`--user-data-dir`) was not intercepted (REVIEW-5 #10).
   * Called on every such launch; the host shows it once. Falls back to `webServerSkipped` when absent.
   */
  webUserProfileSkipped?: (message: string) => void;
  /**
   * PAC URLs for Flutter Web sessions (DIRECT fallback, CONTRACTS §14.7). Default: one lazily started loopback
   * `PacServer` per deps object, serving only the port `proxyHost.start()` last returned while it runs. A source that
   * resolves undefined (or fails) falls back to `--proxy-server` (no fallback when the proxy stops).
   */
  webPac?: WebPacSource;
  /** Free loopback TCP port for the web browser's remote debugging (web screenshots). Default: the OS picks one. */
  freePort?: () => Promise<number>;
}

const defaultPac = new WeakMap<PrepareDeps, { pac: PacServer; port?: number }>();

/** The PAC source for `deps` (see `PrepareDeps.webPac`); the default one records `proxyPort` as the port it may serve. */
function pacFor(deps: PrepareDeps, proxyPort: number): WebPacSource {
  if (deps.webPac) return deps.webPac;
  let entry = defaultPac.get(deps);
  if (!entry) {
    const e: { pac: PacServer; port?: number } = {
      pac: new PacServer({ currentPort: () => (deps.proxyHost.running ? e.port : undefined), log: deps.log }),
    };
    entry = e;
    defaultPac.set(deps, e);
  }
  entry.port = proxyPort;
  return entry.pac;
}

/** A port the OS reports free on 127.0.0.1 (what flutter_tools does itself when it picks the browser's debug port). */
export function freeLoopbackPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const port = (srv.address() as net.AddressInfo).port;
      srv.close(() => resolve(port));
    });
  });
}

/** PAC URL + browser debug port for a web launch; each falls back to undefined (logged) when it can't be had. */
async function webExtras(deps: PrepareDeps, proxyPort: number): Promise<{ webPacUrl?: string; webDebugPort?: number }> {
  const out: { webPacUrl?: string; webDebugPort?: number } = {};
  try {
    out.webPacUrl = await withSoftTimeout(pacFor(deps, proxyPort).urlFor(proxyPort), 2000);
    if (!out.webPacUrl) deps.log('Flutter Web: no PAC URL, using --proxy-server (no DIRECT fallback)');
  } catch (e) {
    deps.log(`Flutter Web: PAC server unavailable (${(e as Error)?.message ?? e}), using --proxy-server (no DIRECT fallback)`);
  }
  try {
    out.webDebugPort = await withSoftTimeout((deps.freePort ?? freeLoopbackPort)(), 2000);
  } catch (e) {
    deps.log(`Flutter Web: no free debug port (${(e as Error)?.message ?? e}); web screenshots won't find the browser`);
  }
  return out;
}

export function readSettings(folder?: vscode.WorkspaceFolder): { enabled: boolean; port: number; webEnabled: boolean } {
  const c = vscode.workspace.getConfiguration('flutterIntercept', folder?.uri);
  return { enabled: c.get<boolean>('enabled', true), port: c.get<number>('port', 8899), webEnabled: c.get<boolean>('web.enabled', true) };
}

/**
 * Dart-Code's selected device (status bar), which it launches on when the config has no
 * deviceId (extension.js 12387 `flutter.getSelectedDeviceId`, 16288 `prepareLaunchDevice`).
 */
async function selectedDeviceId(): Promise<string | undefined> {
  try {
    const id = await withSoftTimeout(Promise.resolve(vscode.commands.executeCommand<string | undefined>('flutter.getSelectedDeviceId')), 1000);
    return typeof id === 'string' && id ? id : undefined;
  } catch {
    return undefined;
  }
}

function dartSettingsToolArgs(folder: vscode.WorkspaceFolder | undefined): string[] {
  const dart = vscode.workspace.getConfiguration('dart', folder?.uri);
  const list = (k: string) => {
    const v = dart.get<unknown>(k);
    return Array.isArray(v) ? v.map(String) : [];
  };
  return [...list('flutterAdditionalArgs'), ...list('flutterRunAdditionalArgs')];
}

function rewriteFor(
  folder: vscode.WorkspaceFolder | undefined,
  config: DebugConfig,
  settings: { enabled: boolean; webEnabled: boolean },
  port: number,
  selected: string | undefined,
  caCertPem: string,
  lan: { physicalIos?: boolean; lan?: LanOpening } = {},
  web: { webPacUrl?: string; webDebugPort?: number } = {},
): RewriteResult {
  const active = vscode.window.activeTextEditor?.document.uri;
  return rewriteDebugConfig(config, {
    enabled: settings.enabled,
    webEnabled: settings.webEnabled,
    caCertPem,
    proxyPort: port,
    selectedDeviceId: selected,
    physicalIos: lan.physicalIos,
    lan: lan.lan,
    webPacUrl: web.webPacUrl,
    webDebugPort: web.webDebugPort,
    settingsToolArgs: dartSettingsToolArgs(folder),
    captureSource: vscode.workspace.getConfiguration('flutterIntercept', folder?.uri).get<boolean>('captureSource', true),
    folder: folder?.uri.fsPath,
    workspaceFolders: (vscode.workspace.workspaceFolders ?? []).map((w) => w.uri.fsPath),
    activeFile: active?.scheme === 'file' ? active.fsPath : undefined,
  });
}

/**
 * Rewrites `config` to launch our generated entry (or returns it untouched). Never throws:
 * any failure launches the app unmodified.
 */
export async function prepareLaunch(
  deps: PrepareDeps,
  folder: vscode.WorkspaceFolder | undefined,
  config: vscode.DebugConfiguration,
  hook: InterceptEvent['hook'],
): Promise<vscode.DebugConfiguration> {
  const dartCodeRanFirst = typeof config.debuggerType === 'number' && config.toolEnv !== undefined;
  try {
    const settings = readSettings(folder);
    // First pass decides whether this launch is intercepted (no CA yet: nothing is written from it).
    let result = rewriteFor(folder, config, settings, settings.port, undefined, '');
    if (result.kind === 'rewrite' || (result.kind === 'skip' && result.needsCa)) {
      const port = await deps.proxyHost.start();
      const caCertPem = await deps.getCaCertPem();
      // Before Dart-Code (no deviceId yet) the host depends on the device Dart-Code will pick.
      const flutter = result.kind === 'rewrite' && result.debuggerType === 'Flutter';
      const selected = flutter && typeof config.deviceId !== 'string' ? await selectedDeviceId() : undefined;
      // Physical iOS (CONTRACTS §7): LAN listener + token, or no interception when there is no LAN.
      let lanInfo: Awaited<ReturnType<typeof prepareLan>> = { physicalIos: false };
      if (flutter && !isWebDevice(selected)) {
        const sdkHint = typeof config.flutterSdkPath === 'string' ? config.flutterSdkPath : vscode.workspace.getConfiguration('dart', folder?.uri).get<string>('flutterSdkPath');
        lanInfo = await prepareLan(deps.lan, typeof config.deviceId === 'string' ? config.deviceId : selected, deps.log, sdkHint || undefined);
      }
      // Flutter Web (CONTRACTS §14.7): a PAC URL with DIRECT fallback and a known browser debug port.
      const webLaunch = (result.kind === 'skip' && result.needsCa) || isWebDevice(selected);
      const web = webLaunch ? await webExtras(deps, port) : {};
      result = rewriteFor(folder, config, settings, port, selected, caCertPem, lanInfo, web);
      if ((result.kind === 'skip' && result.noLan) || (result.kind === 'restore' && lanInfo.physicalIos && !lanInfo.lan)) {
        const message = `Flutter Intercept: ${lanInfo.problem ?? result.reason}, so this iPhone session runs without interception.`;
        deps.log(message);
        deps.lan?.unavailable?.(message);
      }
    }
    if (result.kind === 'restore') {
      deps.events.push({ time: Date.now(), hook, result: 'skip', reason: `restored original program: ${result.reason}`, program: result.config.program, dartCodeRanFirst });
      deps.log(`[${hook}] not intercepting (${result.reason}); restored original program ${result.config.program}`);
      for (const k of Object.keys(config)) if (!(k in result.config)) delete config[k];
      Object.assign(config, result.config);
      return config;
    }
    if (result.kind === 'skip') {
      deps.events.push({ time: Date.now(), hook, result: 'skip', reason: result.reason, program: config.program, dartCodeRanFirst });
      deps.log(`[${hook}] not intercepting: ${result.reason}`);
      if (result.webServer) deps.webServerSkipped?.(`Flutter Intercept: ${result.reason}.`);
      if (result.webUserProfile) (deps.webUserProfileSkipped ?? deps.webServerSkipped)?.(`Flutter Intercept: ${result.reason}.`);
      return config;
    }
    if (result.kind === 'web') {
      // CONTRACTS §11.3: the program is not rewritten; Chrome/Edge get our proxy + CA pin as browser flags.
      deps.log(`[${hook}] mode=${result.mode} Flutter Web device=${result.deviceId} program ${result.config[ORIGINAL_PROGRAM_KEY]} (unchanged), browser proxy ${result.proxyHost}:${result.config[MARKER_KEY]}${result.flags.some((f) => f.includes('--proxy-pac-url=')) ? ' (PAC, DIRECT fallback)' : ''}`);
      deps.events.push({ time: Date.now(), hook, result: 'rewrite', mode: 'web', program: result.config.program, originalProgram: result.config[ORIGINAL_PROGRAM_KEY], dartCodeRanFirst });
      // Replace, not merge: the result may have dropped keys (an earlier entry rewrite, LAN marker).
      for (const k of Object.keys(config)) if (!(k in result.config)) delete config[k];
      Object.assign(config, result.config);
      return config;
    }
    if (result.kind !== 'rewrite') return config;
    await writeEntry(result.plan);
    const port = result.config.flutterInterceptPort as number;
    deps.log(
      `[${hook}] mode=${result.mode} ${result.debuggerType} device=${result.deviceId ?? '(unknown)'} program ${result.plan.program} -> ${result.plan.entryPath} ` +
        `(import ${result.plan.targetImport}, proxy ${result.proxyHost}:${port}${result.debuggerType === 'Flutter' ? ' via --dart-define' : ' (entry default)'}, sha ${result.plan.sha})`,
    );
    deps.events.push({
      time: Date.now(),
      hook,
      result: 'rewrite',
      mode: result.mode,
      program: result.config.program,
      originalProgram: result.plan.program,
      dartCodeRanFirst,
    });
    // Android physical devices (or any Android device while the device is unknown): make
    // localhost:<port> on the device reach the host. Emulators use 10.0.2.2 and need nothing.
    // Plain Dart programs run on the host VM: no device, no adb. Bounded wait, never fails the launch.
    if (result.needsAdbReverse) {
      // Device unknown: physical devices only; an emulator is repaired at session start (CONTRACTS §4b).
      await withSoftTimeout(deps.reverses.reverse(port, result.deviceId, { physicalOnly: !result.deviceId }), deps.adbBudgetMs ?? 3000);
    }
    // Mutate in place as well as returning: some callers keep the original object reference.
    Object.assign(config, result.config);
    return config;
  } catch (e) {
    deps.events.push({ time: Date.now(), hook, result: 'error', reason: String(e), program: config.program, dartCodeRanFirst });
    deps.log(`[${hook}] error, launching unmodified: ${(e as Error)?.stack ?? e}`);
    return config;
  }
}

export class InterceptDebugConfigurationProvider implements vscode.DebugConfigurationProvider {
  constructor(private readonly deps: PrepareDeps) {}

  /**
   * Runs before variable substitution and before Dart-Code has inferred program/cwd/device, so
   * nothing is rewritten here (a `${workspaceFolder}` program is still unresolved, and a missing
   * program is filled in later by Dart-Code). The real work is in the substituted hook.
   */
  resolveDebugConfiguration(
    _folder: vscode.WorkspaceFolder | undefined,
    config: vscode.DebugConfiguration,
  ): vscode.ProviderResult<vscode.DebugConfiguration> {
    return config;
  }

  resolveDebugConfigurationWithSubstitutedVariables(
    folder: vscode.WorkspaceFolder | undefined,
    config: vscode.DebugConfiguration,
  ): vscode.ProviderResult<vscode.DebugConfiguration> {
    return prepareLaunch(this.deps, folder, config, 'resolveDebugConfigurationWithSubstitutedVariables');
  }
}
