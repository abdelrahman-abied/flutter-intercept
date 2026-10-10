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
import { DebugConfig, debuggerTypeName, HOST_KEY, LAN_KEY, MARKER_KEY, ORIGINAL_PROGRAM_KEY, proxyHostFor, WEB_KEY } from './debug/rewrite';
import { IosDeviceClassifier } from './iosDevices';
import { IosUsbToolingChecker, needsRosettaWarning, resolveFlutterSdk, ROSETTA_INSTALL_COMMAND, rosettaWarningText } from './iosUsbTooling';
import { lanAddressForIphone } from './lanAddress';
import { LanNetworkWatcher, netFingerprint } from './lanWatch';
import { LanLifecycle } from './lanLifecycle';
import { InterceptProxyHost } from './proxyHost';
import { createCodegenService } from './codegen/service';
import type { GeneratedFile } from './codegen/types';
import { createContractService, DONT_CHECK } from './contract/service';
import { openFrame } from './source/open';
import { takeScreenshot } from './screenshot';
import { createVmWatcher } from './vm';
import { checkSourcePath, packageRootsFor, resolveFrames } from './source/resolve';
import { InterceptController, validateRule, validateRules } from './ui/controller';
import { analyzeAuth } from './analysis/auth';
import { createRecordingService } from './recordings/store';
import { disposeRecordingDiffs, openRecordingDiff } from './recordings/vscodeDiff';
import { createSharedRulesService } from './rules/service';
import { checkUpstreamProxy } from './proxyHost';
import { toOpenApi, toPostman } from './export';
import { registerNotifications } from './notify';
import { TrafficPanel } from './ui/panel';
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
  const webSessions = new Set<string>(); // the Flutter Web ones among them (CONTRACTS §11.3)
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
  let webServerNoticeShown = false;
  let webProfileNoticeShown = false;
  const deps: PrepareDeps = {
    proxyHost,
    log,
    webServerSkipped: (message) => {
      log(message);
      if (webServerNoticeShown) return;
      webServerNoticeShown = true;
      void vscode.window.showInformationMessage(message);
    },
    webUserProfileSkipped: (message) => {
      log(message);
      if (webProfileNoticeShown) return;
      webProfileNoticeShown = true;
      void vscode.window.showInformationMessage(message);
    },
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

  // CONTRACTS §10: models vs the real API. The controller runs the checks; the service owns diagnostics.
  const contract = createContractService({ workspaceState: context.workspaceState, log });
  context.subscriptions.push(contract);
  const codegen = createCodegenService();
  // CONTRACTS §12: shared rules in the repo, recordings, auth flows, upstream proxy.
  const shared = createSharedRulesService({ workspaceState: context.workspaceState, validateRule, log });
  context.subscriptions.push(shared);
  proxyHost.setBodyFileResolver((p, id) => shared.resolveBodyFile(p, id));
  proxyHost.setScriptFileResolver((p, id) => shared.resolveScriptFile(p, id));
  context.subscriptions.push(shared.onDidChangeBodyFile((p) => proxyHost.refreshBodyFiles(p)));
  const recordings = createRecordingService({ root: () => flutterProjectRoot() });
  context.subscriptions.push({ dispose: disposeRecordingDiffs });
  const applyUpstreamProxy = () => {
    // REVIEW-6 #1: user settings only — a cloned repo's .vscode/settings.json must not route the app's traffic.
    const url = (userSetting<string>('upstreamProxy') ?? '').trim();
    try {
      proxyHost.setUpstreamProxy(url ? checkUpstreamProxy({ url, ignoreCertErrors: userSetting<boolean>('upstreamProxyIgnoreCertErrors') === true }) : undefined);
    } catch (e) {
      const msg = `Flutter Intercept: ignoring flutterIntercept.upstreamProxy: ${(e as Error).message}`;
      log(msg);
      void vscode.window.showWarningMessage(msg);
    }
  };
  applyUpstreamProxy();
  // A cloned repo must not silently route the app's authenticated traffic elsewhere (CONTRACTS §12.1).
  const sharedDeps = {
    state: () => shared.state(),
    save: (rules: Rule[]) => shared.save(rules),
    removeShared: (id: string) => shared.removeShared(id),
    pendingReasons: () => shared.pendingReasons(),
    approvePending: async () => {
      // REVIEW-6 #6: approve exactly the rules shown (the service refuses if they changed meanwhile).
      const snap = shared.pendingSnapshot();
      if (!snap.items.length) return;
      const shown = snap.items.slice(0, 20).map((i) => `• ${i.name} (${i.match}) in ${i.folder}: ${i.reason}`);
      if (snap.items.length > shown.length) shown.push(`…and ${snap.items.length - shown.length} more (open the file to review them).`);
      const scripts = snap.items.filter((i) => i.script);
      const REVIEW = 'Review scripts…';
      const warning = scripts.length
        ? "Only approve rules from people you trust: scripts run on every matching request and can read, change and redirect it, credentials included; other rules can send your app's requests to another server or change what it receives."
        : "Only approve rules from people you trust: they can send your app's requests, with its credentials, to another server or change what it receives.";
      const ok = await vscode.window.showWarningMessage(
        `Approve ${snap.items.length} Flutter Intercept rule${snap.items.length === 1 ? '' : 's'}?`,
        { modal: true, detail: `${shown.join('\n')}\n\n${warning}` },
        'Approve',
        ...(scripts.length ? [REVIEW] : []),
      );
      if (ok === 'Approve') await shared.approvePending(snap.hash);
      // REVIEW-7 #5: show exactly the code that would be approved (the rule's own folder for files).
      if (ok === REVIEW) {
        for (const item of scripts) {
          const sc = item.script!;
          const header = `// ${item.name} — ${item.reason}${sc.truncated ? '\n// (shown cut at 64 KB)' : ''}${sc.error ? `\n// ${sc.error}` : ''}\n`;
          if (sc.path && !sc.error) await vscode.window.showTextDocument(vscode.Uri.file(sc.path), { preview: false });
          else {
            const doc = await vscode.workspace.openTextDocument({ content: header + sc.code, language: 'javascript' });
            await vscode.window.showTextDocument(doc, { preview: false });
          }
        }
        void vscode.window.showInformationMessage('Flutter Intercept: approve the rules from the panel banner once you have reviewed the scripts.');
      }
    },
  };
  // CONTRACTS §11.4: background-isolate warnings and read-only native-client traffic from the app's HTTP profile.
  const vm = createVmWatcher({
    ...proxyHost.vmHostDeps(log),
    nativeClients: () => (vscode.workspace.getConfiguration('flutterIntercept').get<string>('nativeClients', 'profile') === 'off' ? 'off' : 'profile'),
    // CONTRACTS §13.3: install the entry's overrides in new isolates (debug), or only warn.
    backgroundIsolates: () => (vscode.workspace.getConfiguration('flutterIntercept').get<string>('backgroundIsolates', 'intercept') === 'warn' ? 'warn' : 'intercept'),
    // dart:io entries whose proxyDetails name this proxy already are in the list.
    isOurProxy: (_host, port) => port === proxyHost.port || port === proxyHost.lan?.port,
  });
  context.subscriptions.push(vm);
  const contractCheckEnabled = () => vscode.workspace.getConfiguration('flutterIntercept').get<boolean>('contractCheck', true);

  /** Opens a workspace file a rule refers to, creating it only if missing (REVIEW-6 #5/#7 guards). */
  async function openWorkspaceFile(what: string, rel: string, create: { content: string } | undefined, secretProblem: (content: string) => string | undefined, ruleId?: string): Promise<boolean> {
    const abs = shared.bodyFilePath(rel, ruleId); // REVIEW-7 #6: the rule's own workspace folder
    if (!abs) throw new Error(`Not a valid ${what} path: ${rel}`);
    const roots = (vscode.workspace.workspaceFolders ?? []).map((f) => fs.realpathSync(f.uri.fsPath));
    const inside = (p: string) => roots.some((r) => p === r || p.startsWith(r + path.sep));
    let created = false;
    if (create && fs.existsSync(abs) && what === 'script file') {
      // REVIEW-7 #1: never adopt a file that's already there (it may come from the repo) as the user's new script.
      throw new Error(`A file already exists at ${rel}. "Create file" never reuses one: pick another name, or use "Open file" to review it first.`);
    }
    if (create && !fs.existsSync(abs)) {
      // REVIEW-6 #5: never write what looks like live credentials into the repo.
      const secret = secretProblem(create.content);
      if (secret) throw new Error(secret);
      // REVIEW-6 #7: never create anything outside the workspace or through a symlink, never overwrite.
      const root = roots.find((r) => abs.startsWith(r + path.sep));
      if (!root) throw new Error(`The ${what} must be inside the workspace.`);
      let dir = root;
      for (const seg of path.relative(root, path.dirname(abs)).split(path.sep).filter(Boolean)) {
        dir = path.join(dir, seg);
        if (fs.existsSync(dir)) {
          if (fs.lstatSync(dir).isSymbolicLink() || !fs.statSync(dir).isDirectory()) throw new Error(`Refusing to create the ${what} through ${path.relative(root, dir)} (not a plain folder).`);
        } else fs.mkdirSync(dir);
      }
      fs.writeFileSync(abs, create.content, { flag: 'wx' });
      created = true;
    }
    const real = checkSourcePath(abs, roots); // resolves symlinks; throws outside the workspace
    if (!inside(real)) throw new Error(`The ${what} must be inside the workspace.`);
    await vscode.window.showTextDocument(vscode.Uri.file(real), { preview: false });
    return created;
  }
  const exporters = { openapi: toOpenApi, postman: toPostman };
  const version = String((context.extension?.packageJSON as { version?: string } | undefined)?.version ?? '');
  const controller = new InterceptController({
    host: proxyHost,
    saveRules: (rules) => {
      void shared.setPersonalRules(rules).catch((e: unknown) => log(`personal rules → shared service: ${String(e)}`)); // REVIEW-7 #1
      return context.workspaceState.update(RULES_KEY, rules);
    },
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
    contract,
    contractCheckEnabled,
    onContractRemoved: (ids) => contract.forget(ids),
    pickModel: (ex) => pickModel(ex),
    openLocation: async (file, line) => {
      // REVIEW-4 #3: model files come from workspace scans that may follow `part of` paths; open only
      // workspace and package files (same guard as "Open source", REVIEW-3 #3).
      const workspace = (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath);
      const safe = checkSourcePath(file, [...workspace, ...packageRootsFor(flutterProjectRoots())]);
      const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(safe));
      const pos = new vscode.Position(Math.max(0, line - 1), 0);
      await vscode.window.showTextDocument(doc, { selection: new vscode.Range(pos, pos), preview: true });
    },
    codegen,
    openUntitled: (files) => openUntitled(files),
    projectRoot: () => flutterProjectRoot(),
    appPackageName: () => appPackageNames(flutterProjectRoots())[0],
    shared: sharedDeps,
    openSharedRules: async () => {
      const file = shared.files()[0];
      if (!file) throw new Error('No Flutter project folder is open.');
      if (!fs.existsSync(file.path)) await shared.save(shared.fileRules()); // creates an empty shared file
      await vscode.window.showTextDocument(vscode.Uri.file(file.path), { preview: false });
    },
    openBodyFile: (bodyFile, create, ruleId) => openWorkspaceFile('body file', bodyFile, create, (c) => shared.checkBodyFileContent(c), ruleId),
    // CONTRACTS §13.4: same rules as body files; the controller already checked `.js` and swapped in the template.
    // REVIEW-7 #1: a file the user creates here is approved; one merely opened is not.
    openScriptFile: async (scriptFile, create, ruleId) => {
      if (await openWorkspaceFile('script file', scriptFile, create, (c) => shared.checkScriptFileContent(c), ruleId)) await shared.approveScriptFile(scriptFile, ruleId);
    },
    exporters,
    pickOne: (items, placeHolder) => Promise.resolve(vscode.window.showQuickPick(items, { placeHolder })),
    showSaveDialog: async (defaultPath) => (await vscode.window.showSaveDialog({ defaultUri: vscode.Uri.file(defaultPath) }))?.fsPath,
    confirmWarning: async (message, button) => (await vscode.window.showWarningMessage(message, { modal: true }, button)) === button,
    version,
    openInNewWindow: (): Promise<void> => editorPanel.openInNewWindow(),
    recordings,
    openDiff: (a, b) => openRecordingDiff(a, b),
    analyzeAuth: (ex) => analyzeAuth(ex),
  });
  void shared.ready.then(async () => {
    await shared.setPersonalRules(controller.personalRules()); // REVIEW-7 #1: personal script files need approval too
    controller.setSharedRules(shared.state().rules);
  });
  context.subscriptions.push(
    shared.onDidChange((st) => {
      controller.setSharedRules(st.rules);
      proxyHost.refreshBodyFiles(); // an approved personal script reaches the proxy even when shared rules are unchanged
    }),
    // REVIEW-7 #1: saving a script file in VS Code approves that content.
    vscode.workspace.onDidSaveTextDocument((d) => {
      if (d.uri.scheme === 'file') void shared.noteScriptFileSaved(d.uri.fsPath).catch((e: unknown) => log(`script approval on save: ${String(e)}`));
    }),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('flutterIntercept.contractCheck')) controller.recheckContracts();
      if (e.affectsConfiguration('flutterIntercept.upstreamProxy') || e.affectsConfiguration('flutterIntercept.upstreamProxyIgnoreCertErrors')) applyUpstreamProxy();
    }),
  );
  async function pickModel(ex: Exchange): Promise<string | undefined | null> {
    const models = await contract.models();
    type Item = vscode.QuickPickItem & { value: string | undefined };
    const items: Item[] = [
      ...models.map((m) => ({ label: m.name, description: vscode.workspace.asRelativePath(m.file), value: m.name })),
      ...models.map((m) => ({ label: `List<${m.name}>`, description: 'a JSON array of these', value: `List<${m.name}>` })),
      { label: "$(circle-slash) Don't check this route", value: DONT_CHECK },
      { label: '$(discard) Forget my choice (map automatically)', value: undefined },
    ];
    const picked = await vscode.window.showQuickPick(items, {
      title: `Check ${ex.method} ${ex.url.split('?')[0]} against…`,
      placeHolder: models.length ? 'Model (from your *.g.dart files)' : 'No json_serializable / freezed models found in this workspace',
      matchOnDescription: true,
    });
    return picked ? picked.value : null;
  }
  async function openUntitled(files: GeneratedFile[]): Promise<void> {
    for (const f of files) {
      const doc = await vscode.workspace.openTextDocument({ content: f.content, language: f.path.endsWith('.json') ? 'json' : 'dart' });
      await vscode.window.showTextDocument(doc, { preview: false });
    }
    if (files.length) void vscode.window.showInformationMessage(`Flutter Intercept: generated ${files.map((f) => f.path).join(', ')} — save them where you want them.`);
  }
  const view = new TrafficViewProvider(context.extensionUri, controller);
  // CONTRACTS §13.1: the same UI as an editor tab, optionally in its own window.
  const editorPanel: TrafficPanel = new TrafficPanel(context.extensionUri, controller, log);
  context.subscriptions.push({ dispose: () => editorPanel.dispose() });

  // AI agents (CONTRACTS §8): one AgentApi behind two front doors, Copilot tools and a local MCP server.
  const agentSettings = (): { access: AgentAccess; redactSecrets: boolean; interceptEnabled: boolean; screenshots: boolean } => {
    // User settings only (REVIEW-6 #1): a workspace must not widen agent access or turn redaction off.
    const access = userSetting<string>('agent.access') ?? 'readWrite';
    return {
      access: access === 'readOnly' || access === 'off' ? access : 'readWrite',
      redactSecrets: userSetting<boolean>('agent.redactSecrets') !== false,
      interceptEnabled: readSettings().enabled,
      screenshots: userSetting<boolean>('agent.screenshots') !== false,
    };
  };
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
    recordings,
    recordingsChanged: () => void controller.refreshRecordings(),
    analyzeAuth: (ex) => analyzeAuth(ex),
    contract,
    contractResult: (id) => controller.contractResult(id),
    codegen,
    appPackageName: () => appPackageNames(flutterProjectRoots())[0],
    version,
    exporters,
    // CONTRACTS §13.8: VM-service screenshot first, adb / simctl as fallbacks (argument arrays, no shell).
    takeScreenshot: (target) =>
      takeScreenshot(target, {
        callService: (sessionId, method, params) => vm.callService(sessionId, method, params),
        exec: (cmd, args, opts) =>
          new Promise((resolve, reject) =>
            execFile(cmd, args, { encoding: 'buffer', timeout: opts?.timeoutMs ?? 15_000, maxBuffer: opts?.maxBuffer ?? 32 * 1024 * 1024 }, (err, stdout, stderr) =>
              err ? reject(err) : resolve({ stdout, stderr: stderr.toString('utf8') }),
            ),
          ),
        log,
      }),
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
  const exportCommand = async (format: 'openapi' | 'postman') => {
    try {
      const written = await controller.exportTraffic(format);
      if (written) void vscode.window.showInformationMessage(`Flutter Intercept: exported ${format === 'openapi' ? 'OpenAPI' : 'Postman collection'} to ${written}`);
    } catch (e) {
      void vscode.window.showErrorMessage(`Flutter Intercept: ${(e as Error).message}`);
    }
  };

  // CONTRACTS §13.6: failed requests while no traffic view is on screen.
  const notifications = registerNotifications({
    showMessage: (text, ...buttons) => vscode.window.showWarningMessage(`Flutter Intercept: ${text}`, ...buttons),
    reveal: async (id) => {
      if (!editorPanel.visible) await view.reveal(false);
      controller.select(id);
    },
    turnOff: () => vscode.workspace.getConfiguration('flutterIntercept').update('notifications', 'off', vscode.ConfigurationTarget.Global),
    // REVIEW-7 #7: user settings only, so a repository can't override "Turn off".
    getLevel: () => userSetting<string>('notifications'),
    isPanelVisible: () => (view.visible || editorPanel.visible) && vscode.window.state.focused,
    onError: (e) => log(`notification failed: ${String(e)}`),
  });
  proxyHost.on('exchange', (e: Exchange) => notifications.onExchange(e));
  context.subscriptions.push(
    notifications,
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('flutterIntercept.notifications')) notifications.refreshLevel();
    }),
  );
  context.subscriptions.push(
    vscode.commands.registerCommand('flutterIntercept.toggle', async () => {
      await setEnabled(!readSettings().enabled);
      refreshStatus();
    }),
    vscode.commands.registerCommand('flutterIntercept.openPanel', openPanel),
    vscode.commands.registerCommand('flutterIntercept.openInEditor', () => void editorPanel.open()),
    vscode.commands.registerCommand('flutterIntercept.openInNewWindow', () => editorPanel.openInNewWindow()),
    vscode.commands.registerCommand('flutterIntercept.exportOpenApi', () => exportCommand('openapi')),
    vscode.commands.registerCommand('flutterIntercept.exportPostman', () => exportCommand('postman')),
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
      // Flutter Web (CONTRACTS §11.3): Chrome is pointed at the proxy by flags; no adb reverse, LAN or DIRECT fallback.
      if (conf[WEB_KEY] === true) {
        log(`web session started: ${session.name} deviceId=${String(conf.deviceId ?? '-')}`);
        webSessions.add(session.id);
        proxyHost.setWebSessionActive(true); // tags the browser's own traffic (CONTRACTS §11.3)
        return;
      }
      // CONTRACTS §11.4 (dart:io sessions only): isolate warnings + native-client traffic from the HTTP profile.
      void vm.attach({ sessionId: session.id }).catch((e: unknown) => log(`vm attach failed: ${String(e)}`));
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
      if (webSessions.delete(session.id) && webSessions.size === 0) proxyHost.setWebSessionActive(false);
      vm.detach(session.id);
      proxyHost.setWarnings(session.id, []);
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
/** A flutterIntercept setting from the user's own settings only (never workspace / folder values). */
function userSetting<T>(key: string): T | undefined {
  return vscode.workspace.getConfiguration('flutterIntercept').inspect<T>(key)?.globalValue;
}

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
