import { execFile } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import type { Exchange, InterceptProxy, Rule } from '@flutter-intercept/proxy';
import { ReverseTracker } from './adb';
import { createAgentApi } from './agent/api';
import { registerInstructionsCommand } from './agent/instructions';
import { createAppLauncher } from './agent/launch';
import { registerLmTools } from './agent/lmTools';
import { registerMcp, type McpRegistration } from './agent/mcp';
import { TOKEN_KEY as MCP_TOKEN_KEY } from './agent/mcp/register';
import { mcpTestAccess, type McpTestAccess } from './agent/testExposure';
import { languageModelToolsContribution, toolDescriptions, toolSchemas } from './agent/schema';
import type { AgentAccess } from './agent/types';
import { CaStore } from './ca';
import { InterceptDebugConfigurationProvider, InterceptEvent, prepareLaunch, PrepareDeps, readSettings } from './debug/provider';
import { DebugConfig, debuggerTypeName, HOST_KEY, LAN_KEY, MARKER_KEY, ORIGINAL_PROGRAM_KEY, proxyHostFor } from './debug/rewrite';
import { IosDeviceClassifier } from './iosDevices';
import { IosUsbToolingChecker, needsRosettaWarning, resolveFlutterSdk, ROSETTA_INSTALL_COMMAND, rosettaWarningText } from './iosUsbTooling';
import { lanAddressForIphone } from './lanAddress';
import { LanNetworkWatcher, netFingerprint } from './lanWatch';
import { LanLifecycle } from './lanLifecycle';
import { InterceptProxyHost } from './proxyHost';
import { openFrame } from './source/open';
import { packageRootsFor, resolveFrames } from './source/resolve';
import { InterceptController, validateRules } from './ui/controller';
import { TrafficViewProvider, VIEW_ID } from './ui/view';

export const RULES_KEY = 'flutterIntercept.rules';
export const LAN_NOTICE_KEY = 'flutterIntercept.lanNoticeDismissed';
export const ROSETTA_NOTICE_KEY = 'flutterIntercept.rosettaNoticeDismissed';

export const LAN_NOTICE =
  'Flutter Intercept: your iPhone reaches the proxy over Wi-Fi, on this Mac\'s LAN address. ' +
  'macOS may ask whether VS Code may accept incoming network connections, and iOS asks your app for ' +
  'Local Network access on its first run: allow both, or the iPhone\'s traffic bypasses Flutter Intercept. ' +
  'Use this on a trusted Wi-Fi: on shared or public Wi-Fi, others may be able to observe the session token.';

export const NETWORK_CHANGED_MESSAGE = (reason: string) =>
  `Flutter Intercept: your Mac's network changed (${reason}), so the iPhone listener was closed. Relaunch the iPhone session.`;

/** Public API returned from `activate` (integration tests; also handy for other extensions). */
export interface FlutterInterceptApi {
  /** Every decision taken by the provider/command, in order. */
  readonly events: InterceptEvent[];
  /** Eagerly rewrites a launch config (same code path as "Debug with Intercept"). */
  prepare(folder: vscode.WorkspaceFolder | undefined, config: vscode.DebugConfiguration): Promise<vscode.DebugConfiguration>;
  readonly proxyHost: InterceptProxyHost;
  readonly controller: InterceptController;
  readonly view: TrafficViewProvider;
  getExchanges(): Exchange[];
  /** Same path as the webview's `setRules` (persists to workspaceState, broadcasts `rules`). */
  setRules(rules: Rule[]): void;
  getRules(): Rule[];
  /** TEST ONLY (FI_TEST_EXPOSE_MCP_TOKEN=1, integration agent suite): MCP URL + token. Absent otherwise. */
  readonly mcp?: McpTestAccess;
}

let deactivateHooks: (() => Promise<unknown>)[] = [];

export function activate(context: vscode.ExtensionContext): FlutterInterceptApi {
  const output = vscode.window.createOutputChannel('Flutter Intercept');
  // TEST ONLY (FI_TEST_EXPOSE_MCP_TOKEN=1): keep the output-channel lines for the integration suites.
  const testLogs: string[] | undefined = process.env.FI_TEST_EXPOSE_MCP_TOKEN === '1' ? [] : undefined;
  const log = (msg: string) => {
    output.appendLine(`${new Date().toISOString()} ${msg}`);
    testLogs?.push(msg);
  };
  const events: InterceptEvent[] = [];
  const reverses = new ReverseTracker({ log });
  const intercepted = new Set<string>(); // ids of live debug sessions running our entry
  // Per-install CA (key file 0600 in global storage), created on the first intercepted launch.
  const ca = new CaStore(context.globalStorageUri.fsPath, { log });
  const proxyHost: InterceptProxyHost = new InterceptProxyHost({
    getPort: () => readSettings().port,
    getCa: () => ca.get(),
    // Lazy: mockttp & co. (~150 ms to initialise) load on the first intercepted launch, not on activation.
    factory: (opts) => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { InterceptProxy: Proxy } = require('@flutter-intercept/proxy') as { InterceptProxy: typeof InterceptProxy };
      return new Proxy(opts);
    },
    onStop: () => reverses.removeAll(),
    rewriteLocalhost: () => vscode.workspace.getConfiguration('flutterIntercept').get<boolean>('rewriteLocalhost', true),
    // A changed flutterIntercept.port takes effect on the next launch when no intercepted session is live.
    canRestart: () => intercepted.size === 0,
    canReopenLan: (): boolean => lanLife.liveSessions === 0,
    onLanTokenRotatedWhileLive: () =>
      void vscode.window.showWarningMessage('Flutter Intercept: the iPhone proxy credentials changed while an iPhone session is running. Stop and relaunch that session, or its plain-http requests will fail.'),
    log,
  });
  // LAN mode for physical iOS (CONTRACTS §7).
  const lanLife: LanLifecycle = new LanLifecycle({ closeLan: (): Promise<unknown> => proxyHost.closeLan().catch((e: unknown) => log(`closeLan failed: ${String(e)}`)), log });
  const classifier = new IosDeviceClassifier({ log });
  // Review 2 #5: the LAN listener must not outlive the network it was opened on.
  const lanWatcher = new LanNetworkWatcher({
    snapshot: (iface) => netFingerprint(iface),
    onTick: () => proxyHost.refreshLanPeer(), // surfaces "LAN locked to <peer>"
    onChange: (reason) => {
      log(`network changed while the LAN listener was open: ${reason}; closing it`);
      void proxyHost.closeLan({ forgetToken: true }).catch((e: unknown) => log(`closeLan failed: ${String(e)}`));
      void vscode.window.showWarningMessage(NETWORK_CHANGED_MESSAGE(reason));
    },
  });
  // Apple Silicon + USB iPhone + no Rosetta: Flutter's x86_64-only iproxy makes `flutter run` hang.
  const usbChecker = new IosUsbToolingChecker();
  let rosettaNoticeShown = false;
  const beforePhysicalLaunch = async (deviceId: string, sdkHint: string | undefined) => {
    if (rosettaNoticeShown || context.globalState.get<boolean>(ROSETTA_NOTICE_KEY)) return;
    const facts = await usbChecker.check(deviceId, await resolveFlutterSdk([sdkHint]));
    if (facts) log(`iPhone tooling: rosetta=${facts.rosetta} iproxy=${facts.iproxyArchs?.join('+') ?? '?'} transport=${facts.transport}`);
    if (!facts || !needsRosettaWarning(facts)) return;
    rosettaNoticeShown = true;
    const copy = 'Copy install command';
    const xcode = 'Open Xcode';
    const never = "Don't show again";
    // Shown before the launch continues; not awaited, so it never blocks it.
    void vscode.window.showWarningMessage(`Flutter Intercept: ${rosettaWarningText(facts)}`, copy, xcode, never).then((choice) => {
      if (choice === copy) void vscode.env.clipboard.writeText(ROSETTA_INSTALL_COMMAND);
      else if (choice === xcode) execFile('open', ['-a', 'Xcode'], () => undefined); // then Window → Devices and Simulators
      else if (choice === never) void context.globalState.update(ROSETTA_NOTICE_KEY, true);
    });
  };
  let lanNoticeShown = false;
  const showLanNotice = () => {
    if (lanNoticeShown || context.globalState.get<boolean>(LAN_NOTICE_KEY)) return;
    lanNoticeShown = true;
    void vscode.window.showInformationMessage(LAN_NOTICE, 'OK', "Don't show again").then((choice) => {
      if (choice === "Don't show again") void context.globalState.update(LAN_NOTICE_KEY, true);
    });
  };
  let saved: Rule[] = [];
  try {
    saved = validateRules(context.workspaceState.get<unknown>(RULES_KEY) ?? []);
  } catch (e) {
    log(`ignoring invalid saved rules: ${(e as Error).message}`);
  }
  proxyHost.setRules(saved);
  deactivateHooks = [() => proxyHost.stop()];
  const deps: PrepareDeps = {
    proxyHost,
    log,
    events,
    reverses,
    getCaCertPem: async () => (await ca.get()).cert,
    lan: {
      classify: (id) => classifier.classify(id),
      address: () => lanAddressForIphone(), // RFC 1918 only
      open: (host) => proxyHost.openLan(host),
      opened: (opened) => {
        lanLife.opened();
        void lanWatcher.start(opened.host, opened.iface).catch((e: unknown) => log(`network watch failed: ${String(e)}`));
        showLanNotice(); // not awaited: never blocks the launch
      },
      unavailable: (message) => void vscode.window.showWarningMessage(message),
      beforePhysicalLaunch,
    },
  };
  context.subscriptions.push({ dispose: () => lanLife.dispose() }, { dispose: () => lanWatcher.stop() });
  context.subscriptions.push(output);

  const setEnabled = async (enabled: boolean) => {
    const cfg = vscode.workspace.getConfiguration('flutterIntercept');
    const inspect = cfg.inspect<boolean>('enabled');
    const target =
      inspect?.workspaceFolderValue !== undefined
        ? vscode.ConfigurationTarget.WorkspaceFolder
        : inspect?.workspaceValue !== undefined
          ? vscode.ConfigurationTarget.Workspace
          : vscode.ConfigurationTarget.Global;
    await cfg.update('enabled', enabled, target);
  };

  const controller = new InterceptController({
    host: proxyHost,
    saveRules: (rules) => context.workspaceState.update(RULES_KEY, rules),
    getEnabled: () => readSettings().enabled,
    setEnabled,
    log,
    getAgentStatus: () => agentStatus(),
    // CONTRACTS §9.3/9.4: request → source and Copy as … (the user's own clipboard: unredacted).
    openSource: async (ex, frameIndex) => {
      const frame = ex.source?.frames[frameIndex];
      if (!frame) throw new Error('No source location was recorded for this request.');
      const roots = flutterProjectRoots();
      const [resolved] = resolveFrames([frame], roots);
      // REVIEW-3 #3: trace frames are app-controlled; open only workspace and package files.
      const workspace = (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath);
      await openFrame(resolved, { allowedRoots: [...workspace, ...packageRootsFor(roots)] });
    },
    copyToClipboard: (text) => Promise.resolve(vscode.env.clipboard.writeText(text)),
  });
  const view = new TrafficViewProvider(context.extensionUri, controller);

  // AI agents (CONTRACTS §8): one AgentApi behind two front doors, Copilot tools and a local MCP server.
  const agentSettings = (): { access: AgentAccess; redactSecrets: boolean; interceptEnabled: boolean } => {
    const cfg = vscode.workspace.getConfiguration('flutterIntercept');
    const access = cfg.get<string>('agent.access', 'readWrite');
    return {
      access: access === 'readOnly' || access === 'off' ? access : 'readWrite',
      redactSecrets: cfg.get<boolean>('agent.redactSecrets', true),
      interceptEnabled: readSettings().enabled,
    };
  };
  const version = String((context.extension?.packageJSON as { version?: string } | undefined)?.version ?? '');
  const launcher = createAppLauncher({});
  context.subscriptions.push({ dispose: () => launcher.dispose() });
  const agentApi = createAgentApi({
    host: proxyHost,
    applyRules: (rules) => controller.applyRules(rules),
    clear: () => controller.clear(),
    getSettings: agentSettings,
    launcher,
    projectRoot: () => flutterProjectRoot(),
    resolveFrames: (frames) => resolveFrames(frames, flutterProjectRoots()),
    version,
  });
  // CONTRACTS §9.2: the app's own packages decide which stack frame is the call site.
  const refreshAppPackages = () => proxyHost.setAppPackages(appPackageNames(flutterProjectRoots()));
  refreshAppPackages();
  context.subscriptions.push(vscode.workspace.onDidChangeWorkspaceFolders(refreshAppPackages));
  let lastAgentCall: { tool: string; at: number } | undefined;
  // TEST ONLY (FI_TEST_EXPOSE_MCP_TOKEN=1): record agent tool calls for the integration suites.
  const testAgentCalls: { tool: string; at: number; ok: boolean }[] | undefined = process.env.FI_TEST_EXPOSE_MCP_TOKEN === '1' ? [] : undefined;
  context.subscriptions.push(
    agentApi.onDidCall((e) => {
      if (testAgentCalls) testAgentCalls.push(e);
      lastAgentCall = { tool: e.tool, at: e.at };
      controller.broadcastStatus();
    }),
  );
  registerLmTools(context, { tools: agentApi, contribution: languageModelToolsContribution(), log });
  let mcp: McpRegistration | undefined;
  void registerMcp(context, { tools: agentApi, schemas: toolSchemas, descriptions: toolDescriptions(), log, version })
    .then((registration) => {
      mcp = registration;
      context.subscriptions.push(registration.onDidChange(() => controller.broadcastStatus()));
      controller.broadcastStatus();
    })
    .catch((e: unknown) => log(`MCP server for AI agents failed to start: ${String(e)}`));
  registerInstructionsCommand(context);
  function agentStatus() {
    return {
      access: agentSettings().access,
      ...(mcp?.url ? { mcpUrl: mcp.url } : {}),
      clients: mcp?.clients ?? 0,
      ...(lastAgentCall ? { lastCall: lastAgentCall } : {}),
    };
  }
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(VIEW_ID, view, { webviewOptions: { retainContextWhenHidden: true } }),
    { dispose: () => controller.dispose() },
  );

  context.subscriptions.push(vscode.debug.registerDebugConfigurationProvider('dart', new InterceptDebugConfigurationProvider(deps)));

  // Status bar: toggle + paused count (focuses the panel).
  const status = vscode.window.createStatusBarItem('flutterIntercept.status', vscode.StatusBarAlignment.Left, 100);
  status.name = 'Flutter Intercept';
  status.command = 'flutterIntercept.toggle';
  const pausedItem = vscode.window.createStatusBarItem('flutterIntercept.paused', vscode.StatusBarAlignment.Left, 99);
  pausedItem.name = 'Flutter Intercept: paused requests';
  pausedItem.command = 'flutterIntercept.openPanel';
  pausedItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
  const refreshStatus = () => {
    const { enabled, port } = readSettings();
    const lan = proxyHost.lan;
    status.text = `$(radio-tower) Intercept: ${enabled ? 'on' : 'off'}${lan ? ' · LAN' : ''}`;
    status.tooltip =
      (enabled
        ? `Flutter Intercept routes Dart/Flutter debug sessions through port ${proxyHost.port ?? port}${proxyHost.running ? '' : ' (proxy starts with the first session)'}. Click to turn off.`
        : 'Flutter Intercept is off: debug sessions launch untouched. Click to turn on.') +
      (lan
        ? `\nLAN open for iPhone on ${lan.host}:${lan.port} (token-protected${lan.peer ? `, locked to ${lan.peer}` : ''}; closes when the last iPhone session ends).`
        : '');
    status.show();
    const paused = controller.pausedCount;
    pausedItem.text = `$(debug-pause) ${paused}`;
    pausedItem.tooltip = `${paused} paused request${paused === 1 ? '' : 's'}: open the traffic panel`;
    if (paused > 0) pausedItem.show();
    else pausedItem.hide();
  };
  refreshStatus();
  controller.onPausedCount(() => refreshStatus());
  proxyHost.on('state', () => refreshStatus());
  proxyHost.on('lan', (l: unknown) => {
    if (!l) lanWatcher.stop();
    refreshStatus();
    controller.broadcastStatus();
  });
  context.subscriptions.push(
    status,
    pausedItem,
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('flutterIntercept')) {
        refreshStatus();
        controller.broadcastStatus();
      }
    }),
  );

  const openPanel = () => view.reveal(false);
  context.subscriptions.push(
    vscode.commands.registerCommand('flutterIntercept.toggle', async () => {
      await setEnabled(!readSettings().enabled);
      refreshStatus();
    }),
    vscode.commands.registerCommand('flutterIntercept.openPanel', openPanel),
    vscode.commands.registerCommand('flutterIntercept.clear', () => controller.clear()),
    vscode.commands.registerCommand('flutterIntercept.debugWithIntercept', () => debugWithIntercept(deps)),
  );

  // Session tracking: reveal the panel on the first intercepted session, repair adb reverse once
  // Dart-Code has picked the device, remove our reverses when the last intercepted session ends.
  let revealed = false;
  context.subscriptions.push(
    vscode.debug.onDidStartDebugSession((session) => {
      const conf = session.configuration as DebugConfig;
      if (session.type !== 'dart' || !conf[ORIGINAL_PROGRAM_KEY]) return;
      intercepted.add(session.id);
      refreshAppPackages(); // pubspec names may have changed since activation
      controller.setSessions(intercepted.size);
      if (!revealed) {
        revealed = true;
        void Promise.resolve(view.reveal(true)).catch((e) => log(`reveal failed: ${String(e)}`));
      }
      if (debuggerTypeName(conf.debuggerType) !== 'Flutter') return; // host VM program: nothing to reverse
      const port = typeof conf[MARKER_KEY] === 'number' ? conf[MARKER_KEY] : readSettings(session.workspaceFolder).port;
      const deviceId = typeof conf.deviceId === 'string' ? conf.deviceId : undefined;
      const host = typeof conf[HOST_KEY] === 'string' ? conf[HOST_KEY] : 'localhost';
      log(`session started: ${session.name} program=${conf.program} deviceId=${deviceId ?? '-'} proxyHost=${host}${conf[LAN_KEY] ? ' (LAN)' : ''}`);
      if (conf[LAN_KEY] === true) {
        lanLife.started(session.id);
        // Closed meanwhile (grace timer during a >15 min build, or the network changed): never reopen
        // silently — the network may not be the one the listener was opened for (review 2 #5).
        if (!proxyHost.lan) {
          const msg = 'Flutter Intercept: the iPhone listener was closed before this session started, so its traffic is not intercepted. Relaunch the iPhone session.';
          log(msg);
          void vscode.window.showWarningMessage(msg);
        }
        return;
      }
      // Prepared for another device (device picked after resolution): an iPhone can't reach it.
      void classifier.classify(deviceId).then((kind) => {
        if (kind !== 'ios-physical') return;
        const msg = `Flutter Intercept: this session was prepared before the iPhone was chosen, so its traffic is not intercepted. Select the iPhone as the device and start again.`;
        log(msg);
        void vscode.window.showWarningMessage(msg);
      });
      if (host === 'localhost') {
        // Physical device, or an emulator the entry was generated for before the device was known.
        void reverses.reverse(port, deviceId);
      } else if (host !== proxyHostFor(deviceId)) {
        // 10.0.2.2 is right only on an emulator.
        log(`warning: entry was generated for PROXY ${host} but the session runs on ${deviceId}; traffic falls back to DIRECT`);
      }
    }),
    vscode.debug.onDidTerminateDebugSession((session) => {
      lanLife.ended(session.id); // also on crash / app killed: closes the LAN listener after the last iPhone session
      if (!intercepted.delete(session.id)) return;
      controller.setSessions(intercepted.size);
      if (intercepted.size === 0 && reverses.size > 0) {
        log('last intercepted session ended: removing adb reverses');
        void reverses.removeAll();
      }
    }),
  );

  return {
    events,
    proxyHost,
    controller,
    view,
    getExchanges: () => proxyHost.getExchanges(),
    setRules: (rules) => controller.applyRules(rules),
    getRules: () => proxyHost.getRules(),
    prepare: (folder, config) => prepareLaunch(deps, folder, substituteCommonVariables(config, folder), 'command'),
    ...(() => {
      const access = mcpTestAccess(process.env, () => mcp?.url, () => context.secrets.get(MCP_TOKEN_KEY), testAgentCalls, testLogs);
      return access ? { mcp: access } : {};
    })(),
  };
}

export async function deactivate(): Promise<void> {
  const hooks = deactivateHooks;
  deactivateHooks = [];
  await Promise.all(hooks.map((h) => h().catch(() => undefined)));
}

/**
 * Fallback path ("Debug with Intercept"): rewrite eagerly, then hand the config to VS Code.
 * Works whatever order the 'dart' providers run in, because the config reaching Dart-Code
 * already points at our entry and pins `debuggerType`.
 */
async function debugWithIntercept(deps: PrepareDeps): Promise<boolean> {
  const folders = vscode.workspace.workspaceFolders ?? [];
  const folder =
    (vscode.window.activeTextEditor && vscode.workspace.getWorkspaceFolder(vscode.window.activeTextEditor.document.uri)) || folders[0];
  const launches = (vscode.workspace.getConfiguration('launch', folder?.uri).get<vscode.DebugConfiguration[]>('configurations') ?? []).filter(
    (c) => c.type === 'dart' && (c.request ?? 'launch') === 'launch',
  );
  let chosen: vscode.DebugConfiguration | undefined;
  if (launches.length <= 1) {
    chosen = launches[0] ?? { type: 'dart', request: 'launch', name: 'Dart & Flutter' };
  } else {
    const pick = await vscode.window.showQuickPick(
      launches.map((c) => ({ label: c.name ?? c.program ?? 'dart', config: c })),
      { placeHolder: 'Launch configuration to debug with Intercept' },
    );
    if (!pick) return false;
    chosen = pick.config;
  }
  const config = await prepareLaunch(deps, folder, substituteCommonVariables({ ...chosen }, folder), 'command');
  return vscode.debug.startDebugging(folder, config);
}

/** Minimal `${...}` substitution for the eager path (VS Code substitutes again later). */
function substituteCommonVariables(config: vscode.DebugConfiguration, folder?: vscode.WorkspaceFolder): vscode.DebugConfiguration {
  const editor = vscode.window.activeTextEditor?.document.uri;
  const sub = (v: string) =>
    v
      .replace(/\$\{workspaceFolder\}/g, folder?.uri.fsPath ?? '${workspaceFolder}')
      .replace(/\$\{workspaceFolderBasename\}/g, folder?.name ?? '${workspaceFolderBasename}')
      .replace(/\$\{file\}/g, editor?.fsPath ?? '${file}')
      .replace(/\$\{env:([^}]+)\}/g, (_, name: string) => process.env[name] ?? '');
  const out: vscode.DebugConfiguration = { ...config };
  for (const key of ['program', 'cwd'] as const) if (typeof out[key] === 'string') out[key] = sub(out[key]);
  return out;
}

/** The workspace folder holding the Flutter project (pubspec.yaml at its root or one level down). */
/** Every Flutter/Dart project root in the workspace (folders with a pubspec.yaml, or their direct children). */
function flutterProjectRoots(): string[] {
  const roots: string[] = [];
  for (const f of vscode.workspace.workspaceFolders ?? []) {
    const root = f.uri.fsPath;
    if (fs.existsSync(path.join(root, 'pubspec.yaml'))) roots.push(root);
    try {
      for (const child of fs.readdirSync(root, { withFileTypes: true })) {
        if (child.isDirectory() && fs.existsSync(path.join(root, child.name, 'pubspec.yaml'))) roots.push(path.join(root, child.name));
      }
    } catch {
      // unreadable folder: skip it
    }
  }
  return roots;
}

function appPackageNames(roots: string[]): string[] {
  const names = new Set<string>();
  for (const root of roots) {
    try {
      const m = /^name:\s*["']?([A-Za-z0-9_]+)/m.exec(fs.readFileSync(path.join(root, 'pubspec.yaml'), 'utf8'));
      if (m) names.add(m[1]);
    } catch {
      // no readable pubspec
    }
  }
  return [...names];
}

function flutterProjectRoot(): string | undefined {
  const folders = vscode.workspace.workspaceFolders ?? [];
  for (const f of folders) {
    const root = f.uri.fsPath;
    if (fs.existsSync(path.join(root, 'pubspec.yaml'))) return root;
    try {
      for (const child of fs.readdirSync(root, { withFileTypes: true })) {
        if (child.isDirectory() && fs.existsSync(path.join(root, child.name, 'pubspec.yaml'))) return path.join(root, child.name);
      }
    } catch {
      // unreadable folder: try the next one
    }
  }
  return folders[0]?.uri.fsPath;
}
