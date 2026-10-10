/**
 * Pure, order-independent rewrite of a Dart-Code launch configuration (no `vscode` import).
 *
 * VS Code runs every `resolveDebugConfiguration` of every provider registered for 'dart' (in
 * registration order), then substitutes variables, then every
 * `resolveDebugConfigurationWithSubstitutedVariables` (same order). Dart-Code does all its real
 * work (program/cwd inference, debugger-type selection, device selection) in its
 * *WithSubstitutedVariables* hook, and its registration order relative to ours is not stable
 * (Dart-Code re-registers its provider on its in-process "silent restart"). So this function
 * must produce a correct result in both situations:
 *
 *  - "after": Dart-Code already resolved the config (absolute program, cwd, numeric
 *    `debuggerType`, `toolEnv`, maybe `deviceId`). We only swap `program`.
 *  - "before": Dart-Code has not seen the config yet. We resolve program/cwd the way Dart-Code
 *    would and pin `debuggerType` explicitly, because Dart-Code classifies any program under
 *    `.dart_tool/` as a plain Dart (VM) program — which would launch a Flutter app with
 *    `dart` instead of `flutter run`.
 */
import * as fs from 'fs';
import * as path from 'path';
import { spkiPin } from '../ca';
import { EntryPlan, findPubspecRoot, FsLike, isGeneratedEntry, isWithin, planEntry, PROXY_DEFINE, readPubspec } from '../entry/generator';

export const ORIGINAL_PROGRAM_KEY = 'flutterInterceptOriginalProgram';
export const MARKER_KEY = 'flutterInterceptPort';
export const HOST_KEY = 'flutterInterceptProxyHost';
/** `true` when the session uses the LAN listener (physical iOS, CONTRACTS §7). Never holds the token. */
export const LAN_KEY = 'flutterInterceptLan';
export const LAN_PROXY_USER = 'flutter-intercept';
/** `true` on a Flutter Web session we intercept through browser flags (CONTRACTS §11.3): program untouched. */
export const WEB_KEY = 'flutterInterceptWeb';
/** The exact `toolArgs` entries we added for a web session: removed (only those) on re-resolve / restore. */
export const WEB_FLAGS_KEY = 'flutterInterceptWebFlags';
/** The browser reaches the proxy on loopback; Chrome keeps loopback DIRECT (dev server, DWDS, DevTools). */
export const WEB_PROXY_HOST = '127.0.0.1';

/** `flutter-intercept:<token>@<host>:<port>`: the FLUTTER_INTERCEPT_PROXY value for LAN sessions. */
export function lanProxyAddress(lan: { host: string; port: number; token: string }): string {
  return `${LAN_PROXY_USER}:${lan.token}@${lan.host}:${lan.port}`;
}
export const SHA_DEFINE = 'FLUTTER_INTERCEPT_ENTRY_SHA';

/** CONTRACTS §2: Android emulators reach the host at 10.0.2.2; everything else uses localhost. */
export function isAndroidEmulator(deviceId: unknown): boolean {
  return typeof deviceId === 'string' && /^emulator-\d+$/.test(deviceId);
}

/**
 * PROXY_HOST for a device. Unknown device -> 'localhost' (the provider then adb-reverses every
 * connected Android device, which makes localhost correct on emulators too).
 * iOS physical devices (LAN IP) are not handled yet: `override` is the hook for it.
 */
export function proxyHostFor(deviceId: string | undefined, override?: string): string {
  if (override) return override;
  return isAndroidEmulator(deviceId) ? '10.0.2.2' : 'localhost';
}

export { PROXY_DEFINE };
/** CONTRACTS §9.1: `FLUTTER_INTERCEPT_TRACE=0` turns the entry's request → source traces off. */
export const TRACE_DEFINE = 'FLUTTER_INTERCEPT_TRACE';
/** Every dart-define we own. */
export const OUR_DEFINES = [SHA_DEFINE, PROXY_DEFINE, TRACE_DEFINE] as const;

/** toolArgs without the given defines (both `--dart-define=K=V` and `--dart-define K=V`). */
export function stripDefines(toolArgs: unknown, names: readonly string[] = OUR_DEFINES): string[] {
  const args = Array.isArray(toolArgs) ? (toolArgs as unknown[]).map(String) : [];
  const isOurs = (a: string | undefined) => typeof a === 'string' && names.some((n) => a.startsWith(`${n}=`));
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--dart-define' && isOurs(args[i + 1])) { i++; continue; }
    if (args[i].startsWith('--dart-define=') && isOurs(args[i].slice('--dart-define='.length))) continue;
    out.push(args[i]);
  }
  return out;
}

/** toolArgs without any FLUTTER_INTERCEPT_ENTRY_SHA define. */
export function stripShaDefine(toolArgs: unknown): string[] {
  return stripDefines(toolArgs, [SHA_DEFINE]);
}

/** Replaces (never duplicates) the entry-hash define. */
export function withShaDefine(toolArgs: unknown, sha: string): string[] {
  return [...stripShaDefine(toolArgs), `--dart-define=${SHA_DEFINE}=${sha}`];
}

/** Replaces (never duplicates) both of our defines: the entry hash and the proxy address. */
export function withInterceptDefines(toolArgs: unknown, sha: string, proxyAddress: string, captureSource = true): string[] {
  return [
    ...stripDefines(toolArgs),
    `--dart-define=${SHA_DEFINE}=${sha}`,
    `--dart-define=${PROXY_DEFINE}=${proxyAddress}`,
    ...(captureSource ? [] : [`--dart-define=${TRACE_DEFINE}=0`]),
  ];
}

const WEB_BROWSER_FLAG = '--web-browser-flag';

/** Every browser flag in `args` (both `--web-browser-flag=X` and `--web-browser-flag X`). */
export function webBrowserFlags(args: unknown): string[] {
  const list = Array.isArray(args) ? (args as unknown[]).map(String) : [];
  const out: string[] = [];
  for (let i = 0; i < list.length; i++) {
    if (list[i] === WEB_BROWSER_FLAG && i + 1 < list.length) out.push(list[++i]);
    else if (list[i].startsWith(`${WEB_BROWSER_FLAG}=`)) out.push(list[i].slice(WEB_BROWSER_FLAG.length + 1));
  }
  return out;
}

/** A browser flag that already decides the browser's proxy (the user's own proxy setup wins). */
export function isBrowserProxyFlag(flag: string): boolean {
  return /^--(proxy-server|proxy-pac-url)(=|$)|^--(no-proxy-server|proxy-auto-detect)$/.test(flag);
}

/**
 * A browser flag that points the browser at a profile directory of the user's own choosing (REVIEW-5 #10).
 * flutter_tools then launches Chrome on that directory instead of a fresh temp profile, so our proxy and CA pin
 * would apply to a real, persistent profile (logins, mail, banking). `--profile-directory` only picks a profile
 * *inside* the user-data-dir, which stays flutter's temp one without `--user-data-dir`: harmless on its own.
 */
export function isUserProfileFlag(flag: string): boolean {
  return /^--user-data-dir(=|$)/.test(flag);
}

/** flutter run's own option for the browser's remote-debugging port (flutter_tools picks a free one without it). */
export const WEB_DEBUG_PORT_FLAG = '--web-browser-debug-port';

/** A PAC URL we accept for the browser: our loopback PAC server, nothing flutter_tools would split (no comma). */
export function isOurPacUrl(url: unknown): url is string {
  return typeof url === 'string' && /^http:\/\/127\.0\.0\.1:\d{1,5}\/[A-Za-z0-9._~-]{1,100}\.pac$/.test(url);
}

export interface WebFlagOptions {
  /**
   * PAC URL from our loopback PAC server (src/debug/pacServer.ts): `PROXY 127.0.0.1:<port>; DIRECT`, so the page keeps
   * its network when the proxy stops mid-session. Absent = `--proxy-server` (no fallback).
   */
  pacUrl?: string;
  /** Remote-debugging port to give the browser (`--web-browser-debug-port`), so web screenshots can find it. */
  debugPort?: number;
}

/**
 * The `toolArgs` entries for a web session (CONTRACTS §11.3, §14.7): Chrome/Edge proxy everything except loopback
 * (dev server, DWDS and DevTools run on localhost: bypassed by the PAC script, or Chrome's default bypass with
 * `--proxy-server`) through us, and accept certificates that chain to this install's CA (pinned by SPKI; applies only
 * to this temp-profile browser). flutter_tools splits `--web-browser-flag` values on commas: no value contains one.
 */
export function webInterceptFlags(proxyPort: number, caPin: string, opts: WebFlagOptions = {}): string[] {
  if (!Number.isInteger(proxyPort) || proxyPort <= 0 || proxyPort > 65535) throw new Error(`bad proxy port ${proxyPort}`);
  if (!/^[A-Za-z0-9+/]{43}=$/.test(caPin)) throw new Error('bad SPKI pin');
  if (opts.pacUrl !== undefined && !isOurPacUrl(opts.pacUrl)) throw new Error('bad PAC URL');
  const d = opts.debugPort;
  if (d !== undefined && (!Number.isInteger(d) || d <= 0 || d > 65535)) throw new Error(`bad debug port ${d}`);
  return [
    opts.pacUrl ? `${WEB_BROWSER_FLAG}=--proxy-pac-url=${opts.pacUrl}` : `${WEB_BROWSER_FLAG}=--proxy-server=http://${WEB_PROXY_HOST}:${proxyPort}`,
    `${WEB_BROWSER_FLAG}=--ignore-certificate-errors-spki-list=${caPin}`,
    ...(d !== undefined ? [`${WEB_DEBUG_PORT_FLAG}=${d}`] : []),
  ];
}

/** The `--web-browser-debug-port` value in `args` (`=N` or `N` as the next arg), if valid. The last one wins. */
export function webDebugPortArg(args: unknown): number | undefined {
  const list = Array.isArray(args) ? (args as unknown[]).map(String) : [];
  let found: number | undefined;
  for (let i = 0; i < list.length; i++) {
    let v: string | undefined;
    if (list[i] === WEB_DEBUG_PORT_FLAG) v = list[i + 1];
    else if (list[i].startsWith(`${WEB_DEBUG_PORT_FLAG}=`)) v = list[i].slice(WEB_DEBUG_PORT_FLAG.length + 1);
    if (v !== undefined && /^\d{1,5}$/.test(v) && Number(v) > 0 && Number(v) <= 65535) found = Number(v);
  }
  return found;
}

/**
 * The debug Chrome's remote-debugging port of a (resolved) web session configuration — what web screenshots connect to
 * on 127.0.0.1 (src/web/screenshot.ts). Ours or the user's own `--web-browser-debug-port`; undefined for other sessions.
 */
export function webBrowserDebugPortOf(config: unknown): number | undefined {
  const c = config as DebugConfig | undefined;
  if (!c || typeof c !== 'object' || (!isFlutterLaunchedBrowser(c.deviceId) && c[WEB_KEY] !== true)) return undefined;
  return webDebugPortArg(c.toolArgs);
}

/** toolArgs without the exact entries in `ours` (what a previous web resolve recorded in WEB_FLAGS_KEY). */
export function stripWebFlags(toolArgs: unknown, ours: unknown): string[] {
  const args = Array.isArray(toolArgs) ? (toolArgs as unknown[]).map(String) : [];
  const remove = new Set((Array.isArray(ours) ? (ours as unknown[]) : []).map(String));
  if (!remove.size) return args;
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (remove.has(args[i])) continue;
    if (args[i] === WEB_BROWSER_FLAG && i + 1 < args.length && remove.has(`${WEB_BROWSER_FLAG}=${args[i + 1]}`)) { i++; continue; }
    out.push(args[i]);
  }
  return out;
}

/** Chromium devices flutter_tools launches itself (so it passes our --web-browser-flag). */
export function isFlutterLaunchedBrowser(deviceId: unknown): deviceId is 'chrome' | 'edge' {
  return deviceId === 'chrome' || deviceId === 'edge';
}

/** Dart-Code's DebuggerType enum (out/dist/extension.js, `var DebuggerType`). */
export const DebuggerType = { Dart: 0, DartTest: 1, Flutter: 2, FlutterTest: 3, Web: 4, WebTest: 5 } as const;
const debuggerTypeNames = Object.keys(DebuggerType) as (keyof typeof DebuggerType)[];

export type DebugConfig = Record<string, any> & { type?: string; request?: string; program?: string; cwd?: string };

export interface RewriteContext {
  enabled: boolean;
  /** PEM certificate of this install's CA, embedded (and trusted) in the entry. */
  caCertPem: string;
  /** Forces PROXY_HOST (otherwise derived from the device, CONTRACTS §2). */
  proxyHost?: string;
  proxyPort: number;
  /** Device Dart-Code will use when the config has no deviceId (its selected device), if known. */
  selectedDeviceId?: string;
  /** The session's device is a physical iOS device (CONTRACTS §7): it needs the LAN listener. */
  physicalIos?: boolean;
  /** The open LAN listener for a physical-iOS session; undefined = no LAN address (do not intercept). */
  lan?: { host: string; port: number; token: string };
  /** fsPath of the folder VS Code passed to the provider (may be undefined). */
  folder?: string;
  /** fsPaths of all workspace folders. */
  workspaceFolders: string[];
  /**
   * Tool args VS Code/Dart-Code settings add to `flutter run` (`dart.flutterAdditionalArgs`,
   * `dart.flutterRunAdditionalArgs`). Only consulted for `--release`: in "after" mode Dart-Code
   * has already merged them into `toolArgs`, in "before" mode it hasn't yet.
   */
  settingsToolArgs?: string[];
  /** Setting `flutterIntercept.captureSource` (default true); false adds `FLUTTER_INTERCEPT_TRACE=0` (Flutter only). */
  captureSource?: boolean;
  /**
   * Setting `flutterIntercept.web.enabled` (CONTRACTS §11.3). false/absent = web devices are not intercepted.
   * Web sessions need `caCertPem` (its SPKI pin goes into the browser flags).
   */
  webEnabled?: boolean;
  /** Loopback PAC URL for web sessions (DIRECT fallback, CONTRACTS §14.7); absent = `--proxy-server`. */
  webPacUrl?: string;
  /** Free loopback port for the browser's remote debugging (web screenshots); ignored when the launch sets its own. */
  webDebugPort?: number;
  /** fsPath of the active editor's file (only used in "before" mode when program is missing). */
  activeFile?: string;
  fs?: FsLike;
}

export type RewriteResult =
  | {
      kind: 'skip';
      reason: string;
      noLan?: boolean;
      /** The `web-server` device (or another browser flutter does not launch): show the reason once. */
      webServer?: boolean;
      /** The launch starts the browser on the user's own profile (`--user-data-dir`): show the reason once. */
      webUserProfile?: boolean;
      /** A web session would be intercepted but `caCertPem` is not loaded yet: load it and resolve again. */
      needsCa?: boolean;
    }
  /** Flutter Web (CONTRACTS §11.3): program untouched (no dart:io), only browser flags in `toolArgs`. */
  | {
      kind: 'web';
      config: DebugConfig;
      mode: 'after' | 'before' | 'already';
      proxyHost: typeof WEB_PROXY_HOST;
      deviceId: 'chrome' | 'edge';
      /** The toolArgs entries added (also recorded in the config under WEB_FLAGS_KEY). */
      flags: string[];
    }
  /** Interception does not apply but the config points at our entry (e.g. Dart-Code's "rerun last session"): put the original back. */
  | { kind: 'restore'; reason: string; config: DebugConfig }
  | {
      kind: 'rewrite';
      config: DebugConfig;
      plan: EntryPlan;
      mode: 'after' | 'before' | 'already';
      /** Debugger Dart-Code will use: 'Flutter' (device app) or 'Dart' (VM on the host). */
      debuggerType: 'Dart' | 'Flutter';
      /** Proxy host for this session (Flutter: passed as --dart-define=FLUTTER_INTERCEPT_PROXY=<host>:<port>). */
      proxyHost: string;
      /** Device the host was chosen for (undefined = not known yet). */
      deviceId?: string;
      /** Flutter + localhost: `adb reverse` needed on `deviceId` (or on every Android device when unknown). */
      needsAdbReverse: boolean;
      /** Physical iOS: the session goes through the LAN listener. */
      lan: boolean;
    };

/** Normalizes Dart-Code's `debuggerType` (number or case-insensitive name) to a name. */
export function debuggerTypeName(v: unknown): keyof typeof DebuggerType | undefined {
  if (typeof v === 'number') return debuggerTypeNames.find((k) => DebuggerType[k] === v);
  if (typeof v === 'string') return debuggerTypeNames.find((k) => k.toLowerCase() === v.toLowerCase());
  return undefined;
}

/** `flutterMode: "release"`, or `--release` in toolArgs or in the Dart-Code settings' extra flutter args. */
export function isReleaseLaunch(config: DebugConfig, settingsToolArgs: string[] = []): boolean {
  if (typeof config.flutterMode === 'string' && config.flutterMode.toLowerCase() === 'release') return true;
  const args = ([] as unknown[]).concat(Array.isArray(config.toolArgs) ? config.toolArgs : [], settingsToolArgs);
  return args.some((a) => a === '--release');
}

/** Same rule as Dart-Code's `isWebDevice`. */
export function isWebDevice(deviceId: unknown): boolean {
  return typeof deviceId === 'string' && (deviceId.startsWith('web') || deviceId === 'chrome' || deviceId === 'edge');
}

/** True when Dart-Code's `resolveDebugConfigurationWithSubstitutedVariables` already ran on this config. */
export function isResolvedByDartCode(config: DebugConfig): boolean {
  return typeof config.debuggerType === 'number' && config.toolEnv !== undefined && typeof config.program === 'string' && path.isAbsolute(config.program);
}

function segmentsUnder(root: string | undefined, file: string): string[] {
  const base = root && isWithin(file, root) ? path.relative(root, file) : file;
  return base.split(/[\\/]/).filter(Boolean).map((s) => s.toLowerCase());
}

/** Test entry points / folders (Dart-Code: isTestFileOrFolder, plus test_driver). */
export function isTestProgram(program: string, workspaceRoots: string[], f: FsLike = fs as FsLike): boolean {
  // Dart-Code checks path segments relative to the workspace folder; outside any folder we use the package root.
  const root = workspaceRoots.find((w) => isWithin(program, w)) ?? findPubspecRoot(program, f);
  const segs = segmentsUnder(root, program);
  if (segs.includes('test') || segs.includes('integration_test') || segs.includes('test_driver')) return true;
  return program.toLowerCase().endsWith('_test.dart');
}

function hasTestFilter(config: DebugConfig): boolean {
  const all = ([] as unknown[]).concat(config.toolArgs ?? [], config.args ?? []);
  return all.includes('--name') || all.includes('--pname') || all.includes('--plain-name');
}

/** Dart-Code `guessBestEntryPoint` without the open-file branch for non-entry files. */
export function guessEntryPoint(projectRoot: string, f: FsLike): string | undefined {
  const candidates = [
    path.join(projectRoot, 'lib', 'main.dart'),
    path.join(projectRoot, 'bin', 'main.dart'),
    path.join(projectRoot, 'bin', `${path.basename(projectRoot)}.dart`),
  ];
  return candidates.find((c) => f.existsSync(c));
}

function isValidEntryFile(file: string | undefined, roots: string[]): boolean {
  if (!file || !file.toLowerCase().endsWith('.dart')) return false;
  const root = roots.find((w) => isWithin(file, w));
  const segs = segmentsUnder(root, file);
  return segs.includes('bin') || segs.includes('tool') || file.endsWith(`lib${path.sep}main.dart`);
}

/**
 * Program + cwd as Dart-Code would compute them (configureProgramAndCwd), for "before" mode.
 */
export function resolveProgramAndCwd(config: DebugConfig, ctx: RewriteContext, f: FsLike): { program?: string; cwd?: string } {
  const folder = ctx.folder ?? (ctx.workspaceFolders.length === 1 ? ctx.workspaceFolders[0] : undefined);
  let cwd: string | undefined = config.cwd;
  if (cwd && !path.isAbsolute(cwd) && folder) cwd = path.join(folder, cwd);
  let program: string | undefined = typeof config.program === 'string' ? config.program.split('?')[0] : undefined;
  if (program && !path.isAbsolute(program)) {
    const base = cwd ?? folder;
    program = base ? path.join(base, program) : undefined;
  }
  if (!program) {
    const preferred = cwd ?? folder;
    const active = ctx.activeFile && (!preferred || isWithin(ctx.activeFile, preferred)) ? ctx.activeFile : undefined;
    if (active && isValidEntryFile(active, ctx.workspaceFolders) && f.existsSync(active)) {
      program = active;
    } else {
      const root = (active && findPubspecRoot(active, f)) || preferred;
      if (root) program = guessEntryPoint(root, f);
    }
  }
  if (!cwd && program) {
    const pub = findPubspecRoot(program, f);
    const wf = ctx.workspaceFolders.find((w) => isWithin(program!, w));
    cwd = pub && (!wf || isWithin(pub, wf)) ? pub : wf ?? folder;
  }
  return { program, cwd };
}

/** Dart-Code `selectDebuggerType` for a non-test program. */
export function selectDebuggerType(program: string, projectRoot: string | undefined, isFlutterProject: boolean): keyof typeof DebuggerType {
  const first = projectRoot && isWithin(program, projectRoot) ? path.relative(projectRoot, program).split(/[\\/]/)[0] : undefined;
  if (first === 'bin' || first === 'tool' || first === '.dart_tool') return 'Dart';
  if (isFlutterProject) return 'Flutter';
  if (first === 'web') return 'Web';
  return 'Dart';
}

export function rewriteDebugConfig(input: DebugConfig, ctx: RewriteContext): RewriteResult {
  const result = rewriteOrSkip(input, ctx);
  if (result.kind !== 'skip' || !input) return result;
  const ourEntry = isGeneratedEntry(input.program) && typeof input[ORIGINAL_PROGRAM_KEY] === 'string';
  const ourWeb = input[WEB_KEY] === true || Array.isArray(input[WEB_FLAGS_KEY]);
  // A web launch that only waits for the CA keeps everything: it is resolved again right away.
  if ((ourEntry || ourWeb) && !result.needsCa) return { kind: 'restore', reason: result.reason, config: withoutInterception(input) };
  return result;
}

/** `config` as it was before we touched it: original program, none of our keys, defines or browser flags. */
export function withoutInterception(input: DebugConfig): DebugConfig {
  const config: DebugConfig = { ...input };
  if (isGeneratedEntry(config.program) && typeof config[ORIGINAL_PROGRAM_KEY] === 'string') config.program = config[ORIGINAL_PROGRAM_KEY];
  if (Array.isArray(config.toolArgs)) config.toolArgs = stripDefines(stripWebFlags(config.toolArgs, config[WEB_FLAGS_KEY]));
  for (const k of [ORIGINAL_PROGRAM_KEY, MARKER_KEY, HOST_KEY, LAN_KEY, WEB_KEY, WEB_FLAGS_KEY]) delete config[k];
  return config;
}

function rewriteOrSkip(input: DebugConfig, ctx: RewriteContext): RewriteResult {
  const f = ctx.fs ?? (fs as FsLike);
  if (!ctx.enabled) return { kind: 'skip', reason: 'flutterIntercept.enabled is false' };
  if (!input || input.type !== 'dart') return { kind: 'skip', reason: 'not a dart debug configuration' };
  if (input.request === 'attach') return { kind: 'skip', reason: 'attach request' };
  if (isReleaseLaunch(input, ctx.settingsToolArgs)) {
    // Never silently intercept a release build: the entry trusts this machine's CA and ignores app findProxy.
    return { kind: 'skip', reason: 'release build (flutterMode "release" / --release): never intercepted' };
  }
  if (input.omitTargetFlag === true) return { kind: 'skip', reason: 'omitTargetFlag: program is not passed to the tool' };
  const explicitType = debuggerTypeName(input.debuggerType);
  if (explicitType && explicitType !== 'Dart' && explicitType !== 'Flutter') {
    return { kind: 'skip', reason: `debuggerType ${explicitType}` };
  }
  if (typeof input.program === 'string' && input.program.includes('?')) return { kind: 'skip', reason: 'program has a test query' };
  if (hasTestFilter(input)) return { kind: 'skip', reason: 'test name filter in args' };

  const config: DebugConfig = { ...input };
  let mode: 'after' | 'before' | 'already';
  let original: string | undefined;
  let cwd: string | undefined;

  if (isGeneratedEntry(config.program)) {
    // Idempotency: already ours (rerun, or a provider ran twice). Regenerate from the original.
    mode = 'already';
    original = config[ORIGINAL_PROGRAM_KEY];
    if (!original) return { kind: 'skip', reason: 'program is a generated entry but the original program is unknown' };
    cwd = config.cwd;
  } else if (isResolvedByDartCode(config)) {
    mode = 'after';
    original = config.program;
    cwd = config.cwd;
  } else {
    mode = 'before';
    const resolved = resolveProgramAndCwd(config, ctx, f);
    original = resolved.program;
    cwd = resolved.cwd;
  }

  if (!original) return { kind: 'skip', reason: 'no program could be determined (Dart-Code will report it)' };
  original = path.resolve(original);
  if (isTestProgram(original, ctx.workspaceFolders, f)) return { kind: 'skip', reason: 'test entry point' };
  try {
    if (!f.statSync(original).isFile()) return { kind: 'skip', reason: 'program is not a file' };
  } catch {
    return { kind: 'skip', reason: `program does not exist: ${original}` };
  }

  const root = findPubspecRoot(original, f) ?? cwd ?? ctx.folder;
  const isFlutter = root ? readPubspec(root, f).isFlutter : false;
  const effectiveType = explicitType ?? selectDebuggerType(original, root, isFlutter);
  if (effectiveType === 'Web') return { kind: 'skip', reason: 'Dart web program (no dart:io)' };
  const flutter = effectiveType === 'Flutter';

  // Host depends on the device (CONTRACTS §2). Plain Dart runs on the host VM: always localhost.
  const deviceId = flutter ? (typeof config.deviceId === 'string' ? config.deviceId : ctx.selectedDeviceId) : undefined;
  if (isWebDevice(deviceId)) return webSession(config, ctx, original, mode, deviceId!);
  const lan = flutter && ctx.physicalIos ? ctx.lan : undefined;
  if (flutter && ctx.physicalIos && !lan) {
    return { kind: 'skip', noLan: true, reason: 'physical iOS device, but this Mac has no LAN (Wi-Fi/Ethernet) IPv4 address the iPhone could reach' };
  }
  const proxyHost = lan ? lan.host : flutter ? proxyHostFor(deviceId, ctx.proxyHost) : ctx.proxyHost ?? 'localhost';
  const proxyPort = lan ? lan.port : ctx.proxyPort;

  const plan = planEntry({ program: original, fallbackRoot: cwd ?? ctx.folder, proxyPort: ctx.proxyPort, caCertPem: ctx.caCertPem }, f);
  if (!plan) return { kind: 'skip', reason: 'no project root' };

  if (config[WEB_KEY] !== undefined || config[WEB_FLAGS_KEY] !== undefined) {
    // Re-resolved for a non-web device after a web resolve: drop the browser flags.
    if (Array.isArray(config.toolArgs)) config.toolArgs = stripWebFlags(config.toolArgs, config[WEB_FLAGS_KEY]);
    delete config[WEB_KEY];
    delete config[WEB_FLAGS_KEY];
  }
  config.program = plan.entryPath;
  config[ORIGINAL_PROGRAM_KEY] = original;
  config[MARKER_KEY] = proxyPort;
  config[HOST_KEY] = proxyHost; // the LAN IP for physical iOS — never the token
  if (lan) config[LAN_KEY] = true;
  else delete config[LAN_KEY];
  // The entry is device independent; the device-specific proxy address travels as a dart-define.
  // flutter_tools keeps .dart_tool out of Gradle inputs: the SHA define forces a rebuild of a changed entry.
  // Flutter only: the Dart VM rejects --dart-define; plain Dart uses the entry's localhost:<port> default.
  // LAN (physical iOS): `flutter-intercept:<token>@<lanIp>:<port>`; the token lives only in this define.
  if (flutter) config.toolArgs = withInterceptDefines(config.toolArgs, plan.sha, lan ? lanProxyAddress(lan) : `${proxyHost}:${proxyPort}`, ctx.captureSource !== false);
  if (mode === 'before' || mode === 'already') {
    if (!config.cwd && cwd) config.cwd = cwd;
    // Pin the debugger type; otherwise Dart-Code treats a program under .dart_tool/ as plain Dart.
    if (config.debuggerType === undefined) config.debuggerType = effectiveType;
  }
  return {
    kind: 'rewrite',
    config,
    plan,
    mode,
    debuggerType: flutter ? 'Flutter' : 'Dart',
    proxyHost,
    deviceId,
    needsAdbReverse: flutter && !lan && proxyHost === 'localhost',
    lan: !!lan,
  };
}

/**
 * Flutter Web on a browser flutter_tools launches (CONTRACTS §11.3, docs/spikes/web.md): the app's fetch/XHR
 * go through the browser, so instead of an entry we start that browser with our proxy and the CA's SPKI pin.
 * `program` stays the app's own (restored if it was our entry); our dart-defines are removed.
 */
function webSession(config: DebugConfig, ctx: RewriteContext, original: string, mode: 'after' | 'before' | 'already', deviceId: string): RewriteResult {
  if (!isFlutterLaunchedBrowser(deviceId)) {
    return {
      kind: 'skip',
      webServer: true,
      reason: `${deviceId} device: Flutter does not start the browser, so its proxy can't be set. Use the Chrome (or Edge) device to intercept Flutter Web`,
    };
  }
  if (!ctx.webEnabled) return { kind: 'skip', reason: 'flutterIntercept.web.enabled is false' };
  const base = stripDefines(stripWebFlags(config.toolArgs, config[WEB_FLAGS_KEY]));
  const own = [...webBrowserFlags(base), ...webBrowserFlags(ctx.settingsToolArgs)].find(isBrowserProxyFlag);
  if (own) return { kind: 'skip', reason: `the launch already sets the browser's proxy (--web-browser-flag=${own})` };
  // REVIEW-5 #10: never put our proxy + CA pin into a real, persistent browser profile.
  if ([...webBrowserFlags(base), ...webBrowserFlags(ctx.settingsToolArgs)].some(isUserProfileFlag)) {
    return {
      kind: 'skip',
      webUserProfile: true,
      reason:
        'this web launch opens Chrome on your own profile (--web-browser-flag=--user-data-dir=…), so Flutter Intercept does not ' +
        'intercept it: everything browsed in that profile would go through the proxy. Remove --user-data-dir to intercept',
    };
  }
  if (!ctx.caCertPem) return { kind: 'skip', needsCa: true, reason: 'web session: the CA certificate is not loaded yet' };
  let pin: string;
  try {
    pin = spkiPin(ctx.caCertPem);
  } catch (e) {
    return { kind: 'skip', reason: `web session: unreadable CA certificate (${(e as Error).message})` };
  }
  const userDebugPort = webDebugPortArg(base) ?? webDebugPortArg(ctx.settingsToolArgs);
  const flags = webInterceptFlags(ctx.proxyPort, pin, {
    pacUrl: isOurPacUrl(ctx.webPacUrl) ? ctx.webPacUrl : undefined,
    debugPort: userDebugPort === undefined ? ctx.webDebugPort : undefined,
  });
  if (isGeneratedEntry(config.program)) config.program = original; // e.g. rerun of a mobile session on Chrome
  config.toolArgs = [...base, ...flags];
  config[ORIGINAL_PROGRAM_KEY] = original;
  config[MARKER_KEY] = ctx.proxyPort;
  config[HOST_KEY] = WEB_PROXY_HOST;
  config[WEB_KEY] = true;
  config[WEB_FLAGS_KEY] = flags;
  delete config[LAN_KEY];
  return { kind: 'web', config, mode, proxyHost: WEB_PROXY_HOST, deviceId, flags };
}
