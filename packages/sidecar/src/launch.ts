/**
 * `prepareLaunch` (CONTRACTS §15.1 run integration): the same decisions as the VS Code debug provider
 * (packages/extension/src/debug/provider.ts + rewrite.ts), for an IntelliJ Flutter run configuration. The run
 * configuration is described as a Dart-Code style launch config (`debuggerType: Flutter`, `toolArgs` = the run
 * configuration's additional args) and fed to `rewriteDebugConfig`, so entry generation, defines, the Android
 * emulator host (10.0.2.2), LAN mode for physical iPhones and the Flutter Web browser flags + PAC are byte-identical
 * to what VS Code produces.
 *
 * The result's `additionalArgs` REPLACE the run configuration's args for this launch only: the user's own args with
 * our previous defines / browser flags removed, then ours.
 */
import * as path from 'path';
import { withSoftTimeout, type ReverseTracker } from '../../extension/src/adb';
import { isGeneratedEntry, writeEntry } from '../../extension/src/entry/generator';
import type { LanOpening } from '../../extension/src/proxyHost';
import { prepareLan, type LanDeps } from '../../extension/src/debug/lanPrepare';
import type { WebPacSource } from '../../extension/src/debug/pacServer';
import {
  HOST_KEY,
  LAN_KEY,
  MARKER_KEY,
  ORIGINAL_PROGRAM_KEY,
  rewriteDebugConfig,
  WEB_FLAGS_KEY,
  type DebugConfig,
  type RewriteResult,
} from '../../extension/src/debug/rewrite';
import type { DeviceKind, PrepareLaunchParams, PrepareLaunchResult } from './types';

/** What the sidecar remembers about a launch it rewrote, until its session starts. */
export interface LaunchRecord {
  launchId: string;
  projectRoot: string;
  program: string;
  deviceId?: string;
  deviceKind: DeviceKind;
  flutterMode: 'debug' | 'profile';
  /** The proxy port the app was given, and the host it reaches it on. */
  port: number;
  host: string;
  lan: boolean;
  web: boolean;
  /** Browser flags we added (web screenshots find the debug browser by them). */
  webFlags?: string[];
}

export interface LaunchDeps {
  settings(): { enabled: boolean; port: number; webEnabled: boolean; captureSource: boolean };
  workspaceFolders(): string[];
  proxy: { start(): Promise<number> };
  getCaCertPem(): Promise<string>;
  reverses: Pick<ReverseTracker, 'reverse'>;
  /** LAN mode for physical iPhones: address + listener + notices. `classify` is supplied here from `deviceKind`. */
  lan?: Omit<LanDeps, 'classify'>;
  webPac?: WebPacSource;
  /** The web-server device / own browser profile was not intercepted: shown once by the host. */
  webSkipped?(message: string): void;
  log(msg: string): void;
  /** Max wait for adb (the reverse continues in the background). Default 3000 ms. */
  adbBudgetMs?: number;
}

const ANDROID_EMULATOR_HOST = '10.0.2.2';

function skip(reason: string): PrepareLaunchResult {
  return { kind: 'skip', reason };
}

/** The launch config `rewriteDebugConfig` expects, from the run configuration. */
export function launchConfigFor(p: PrepareLaunchParams): DebugConfig {
  const deviceId = p.deviceId ?? (p.deviceKind === 'web' ? 'chrome' : undefined);
  return {
    type: 'dart',
    request: 'launch',
    name: 'Flutter (IDE)',
    program: p.program,
    cwd: p.projectRoot,
    debuggerType: 'Flutter', // an IntelliJ Flutter run configuration always runs `flutter run`
    flutterMode: p.flutterMode,
    toolArgs: [...p.additionalArgs],
    ...(deviceId ? { deviceId } : {}),
  };
}

export async function prepareLaunch(deps: LaunchDeps, p: PrepareLaunchParams): Promise<{ result: PrepareLaunchResult; record?: LaunchRecord }> {
  try {
    return await prepare(deps, p);
  } catch (e) {
    const reason = `internal error, launching unmodified: ${(e as Error)?.message ?? e}`;
    deps.log(`[prepareLaunch] ${reason}`);
    return { result: skip(reason) };
  }
}

async function prepare(deps: LaunchDeps, p: PrepareLaunchParams): Promise<{ result: PrepareLaunchResult; record?: LaunchRecord }> {
  if (p.flutterMode === 'release') return { result: skip('release build: never intercepted') };
  if (typeof p.program !== 'string' || !path.isAbsolute(p.program)) return { result: skip('the run configuration has no absolute Dart entry file') };
  const settings = deps.settings();
  if (!settings.enabled) return { result: skip('Flutter Intercept is turned off') };
  const config = launchConfigFor(p);
  if (isGeneratedEntry(config.program)) return { result: skip('the program is already a generated Flutter Intercept entry') };
  const physicalIosKind = p.deviceKind === 'ios-device';
  const ctxBase = {
    enabled: settings.enabled,
    webEnabled: settings.webEnabled,
    captureSource: settings.captureSource,
    folder: p.projectRoot,
    workspaceFolders: [...new Set([p.projectRoot, ...deps.workspaceFolders()])],
    settingsToolArgs: [],
    // The plugin knows the device kind even when the id doesn't look like `emulator-5554` (e.g. a named AVD).
    proxyHost: p.deviceKind === 'android-emulator' ? ANDROID_EMULATOR_HOST : undefined,
  };

  // First pass: is this launch intercepted at all (no CA yet, nothing written)?
  let result: RewriteResult = rewriteDebugConfig(config, { ...ctxBase, proxyPort: settings.port || 1, caCertPem: '' });
  let lanInfo: { physicalIos: boolean; lan?: LanOpening; problem?: string } = { physicalIos: false };
  if (result.kind === 'rewrite' || (result.kind === 'skip' && result.needsCa)) {
    const port = await deps.proxy.start();
    const caCertPem = await deps.getCaCertPem();
    if (result.kind === 'rewrite' && physicalIosKind) {
      lanInfo = deps.lan
        ? await prepareLan({ ...deps.lan, classify: async () => 'ios-physical' }, p.deviceId ?? 'ios-device', deps.log)
        : { physicalIos: true, problem: 'LAN mode is not available' };
    }
    let webPacUrl: string | undefined;
    if (result.kind === 'skip' && result.needsCa && deps.webPac) {
      try {
        webPacUrl = await withSoftTimeout(deps.webPac.urlFor(port), 2000);
      } catch (e) {
        deps.log(`Flutter Web: PAC server unavailable (${(e as Error)?.message ?? e}), using --proxy-server (no DIRECT fallback)`);
      }
      if (!webPacUrl) deps.log('Flutter Web: no PAC URL, using --proxy-server (no DIRECT fallback)');
    }
    result = rewriteDebugConfig(config, { ...ctxBase, proxyPort: port, caCertPem, physicalIos: lanInfo.physicalIos, lan: lanInfo.lan, webPacUrl });
    if (result.kind === 'skip' && result.noLan) {
      const message = `Flutter Intercept: ${lanInfo.problem ?? result.reason}, so this iPhone session runs without interception.`;
      deps.log(message);
      deps.lan?.unavailable?.(message);
      return { result: skip(lanInfo.problem ?? result.reason) };
    }
  }
  if (result.kind === 'restore') return { result: skip(result.reason) };
  if (result.kind === 'skip') {
    deps.log(`[prepareLaunch] not intercepting: ${result.reason}`);
    if (result.webServer || result.webUserProfile) deps.webSkipped?.(`Flutter Intercept: ${result.reason}.`);
    return { result: skip(result.reason) };
  }
  const base = { launchId: p.launchId, projectRoot: p.projectRoot, deviceId: p.deviceId, deviceKind: p.deviceKind, flutterMode: p.flutterMode as 'debug' | 'profile' };
  if (result.kind === 'web') {
    const flags = result.flags;
    deps.log(`[prepareLaunch] Flutter Web device=${result.deviceId} program unchanged, browser proxy ${result.proxyHost}:${result.config[MARKER_KEY]}${flags.some((f) => f.includes('--proxy-pac-url=')) ? ' (PAC, DIRECT fallback)' : ''}`);
    return {
      result: { kind: 'rewrite', program: p.program, additionalArgs: (result.config.toolArgs as string[]) ?? [], note: 'Flutter Web: the browser is started with the Flutter Intercept proxy' },
      record: { ...base, program: result.config[ORIGINAL_PROGRAM_KEY], port: result.config[MARKER_KEY], host: result.config[HOST_KEY], lan: false, web: true, webFlags: result.config[WEB_FLAGS_KEY] },
    };
  }
  if (result.kind !== 'rewrite') return { result: skip('unexpected rewrite result') };
  await writeEntry(result.plan);
  const port = result.config[MARKER_KEY] as number;
  deps.log(
    `[prepareLaunch] ${p.deviceKind} device=${p.deviceId ?? '(unknown)'} program ${path.basename(result.plan.program)} -> ${path.relative(p.projectRoot, result.plan.entryPath)} ` +
      `(proxy ${result.lan ? 'LAN' : result.proxyHost}:${port}, sha ${result.plan.sha.slice(0, 12)})`,
  );
  // Physical Android (or an Android device the plugin couldn't classify): localhost:<port> on the device → host.
  const reverseKinds: DeviceKind[] = ['android-device', 'other'];
  if (result.needsAdbReverse && reverseKinds.includes(p.deviceKind)) {
    await withSoftTimeout(deps.reverses.reverse(port, p.deviceId, { physicalOnly: !p.deviceId }), deps.adbBudgetMs ?? 3000);
  }
  return {
    result: {
      kind: 'rewrite',
      program: result.plan.entryPath,
      additionalArgs: (result.config.toolArgs as string[]) ?? [],
      ...(result.lan ? { note: 'Physical iPhone: the app reaches the proxy over Wi-Fi (LAN mode, token-protected)' } : {}),
    },
    record: { ...base, program: result.plan.program, port, host: result.config[HOST_KEY], lan: result.config[LAN_KEY] === true, web: false },
  };
}
