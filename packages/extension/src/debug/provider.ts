import * as vscode from 'vscode';
import { ReverseTracker, withSoftTimeout } from '../adb';
import { writeEntry } from '../entry/generator';
import type { LanOpening, ProxyHost } from '../proxyHost';
import { LanDeps, prepareLan } from './lanPrepare';
import { DebugConfig, rewriteDebugConfig, RewriteResult } from './rewrite';

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
}

export function readSettings(folder?: vscode.WorkspaceFolder): { enabled: boolean; port: number } {
  const c = vscode.workspace.getConfiguration('flutterIntercept', folder?.uri);
  return { enabled: c.get<boolean>('enabled', true), port: c.get<number>('port', 8899) };
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
  enabled: boolean,
  port: number,
  selected: string | undefined,
  caCertPem: string,
  lan: { physicalIos?: boolean; lan?: LanOpening } = {},
): RewriteResult {
  const active = vscode.window.activeTextEditor?.document.uri;
  return rewriteDebugConfig(config, {
    enabled,
    caCertPem,
    proxyPort: port,
    selectedDeviceId: selected,
    physicalIos: lan.physicalIos,
    lan: lan.lan,
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
    const { enabled, port: configuredPort } = readSettings(folder);
    // First pass decides whether this launch is intercepted (no CA yet: nothing is written from it).
    let result = rewriteFor(folder, config, enabled, configuredPort, undefined, '');
    if (result.kind === 'rewrite') {
      const port = await deps.proxyHost.start();
      const caCertPem = await deps.getCaCertPem();
      // Before Dart-Code (no deviceId yet) the host depends on the device Dart-Code will pick.
      const selected = result.debuggerType === 'Flutter' && typeof config.deviceId !== 'string' ? await selectedDeviceId() : undefined;
      // Physical iOS (CONTRACTS §7): LAN listener + token, or no interception when there is no LAN.
      let lanInfo: Awaited<ReturnType<typeof prepareLan>> = { physicalIos: false };
      if (result.debuggerType === 'Flutter') {
        const sdkHint = typeof config.flutterSdkPath === 'string' ? config.flutterSdkPath : vscode.workspace.getConfiguration('dart', folder?.uri).get<string>('flutterSdkPath');
        lanInfo = await prepareLan(deps.lan, typeof config.deviceId === 'string' ? config.deviceId : selected, deps.log, sdkHint || undefined);
      }
      result = rewriteFor(folder, config, enabled, port, selected, caCertPem, lanInfo);
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
