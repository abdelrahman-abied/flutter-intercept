/**
 * The sidecar's host composition (CONTRACTS §15.1): what packages/extension/src/extension.ts does for VS Code, with
 * the vscode-only pieces replaced by `SidecarRequest`s to the plugin (`ui.*`), the plugin's settings instead of VS
 * Code's configuration, a JSON state file in `dataDir` instead of globalState / workspaceState, Node file watching,
 * a direct VM-service WebSocket instead of Dart-Code's debug adapter, and the traffic UI served over loopback HTTP +
 * WebSocket (uiServer.ts) instead of a webview.
 *
 * Plugin → sidecar methods: those of types.ts `PluginRequest`, plus three optional additions (see EXTRA_METHODS).
 * Sidecar → plugin: types.ts `SidecarRequest`s, including `secrets.clientCertPassphrase` (an error answer means "no
 * passphrase") and `secrets.get` / `secrets.set` for the MCP token (`unavailable` → private file in dataDir); events `ready`, `status`, `log`, plus `settingsChanged`.
 */
import { execFile } from 'child_process';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { Exchange, InterceptProxy, Rule } from '@flutter-intercept/proxy';
import { AndroidGlobalProxy, ReverseTracker, type Exec as AdbExec } from '../../extension/src/adb';
import { createAgentApi } from '../../extension/src/agent/api';
import { connectSnippet, type AgentClient } from '../../extension/src/agent/mcp/connect';
import { DEFAULT_MCP_PORT, generateToken, startMcpServer, type RunningMcpServer } from '../../extension/src/agent/mcp/server';
import { toolDescriptions, toolSchemas } from '../../extension/src/agent/schema';
import { AgentToolError, type AgentAccess, type AppLauncher } from '../../extension/src/agent/types';
import { analyzeAuth } from '../../extension/src/analysis/auth';
import { CaStore, type CaGenerator } from '../../extension/src/ca';
import { createCodegenService } from '../../extension/src/codegen/service';
import type { GeneratedFile } from '../../extension/src/codegen/types';
import { cleanupLanDefines, removeLanDefines } from '../../extension/src/debug/lanPrepare';
import { PacServer } from '../../extension/src/debug/pacServer';
import { createWebServerNotice } from '../../extension/src/debug/webServerNotice';
import { toOpenApi, toPostman } from '../../extension/src/export';
import { lanAddressForIphone, type LanAddress } from '../../extension/src/lanAddress';
import { LanLifecycle } from '../../extension/src/lanLifecycle';
import { LanNetworkWatcher, netFingerprint } from '../../extension/src/lanWatch';
import { registerNotifications, type Notifications } from '../../extension/src/notify';
import { InterceptProxyHost, type ProxyFactory } from '../../extension/src/proxyHost';
import { grpcCodec } from '../../extension/src/grpc/index';
import { createGrpcSchemaService, grpcMockEncoder, type GrpcSchemaService } from '../../extension/src/grpc/service';
import { diffText } from '../../extension/src/recordings/diff';
import { createRecordingService } from '../../extension/src/recordings/store';
import { takeScreenshot } from '../../extension/src/screenshot';
import { checkSourcePath, packageRootsFor, resolveFrames } from '../../extension/src/source/resolve';
import { loadClientCertificates } from '../../extension/src/ui/clientCerts';
import { InterceptController, validateRule, validateRules } from '../../extension/src/ui/controller';
import { matchesProxyExchange } from '../../extension/src/vm/profile';
import type { WebSocketCtor } from '../../extension/src/vm/transport';
import { webScreenshot } from '../../extension/src/web/screenshot';
import { createPathDecision } from '../../extension/src/rules/createPolicy';
import { createNodeContractService, DONT_CHECK, type NodeContractService } from './contract';
import { prepareLaunch, type LaunchRecord } from './launch';
import { RpcFailure } from './rpc';
import { normalizeSettings, normalizeTheme } from './settings';
import { createNodeSharedRules, type NodeSharedRules } from './sharedRules';
import { JsonStateStore } from './state';
import type { InitParams, InitResult, PrepareLaunchParams, SessionEndedParams, SessionStartedParams, SidecarSettings } from './types';
import { UiServer } from './uiServer';
import { createSidecarVm, type SidecarVm } from './vm';

export const RULES_KEY = 'rules';
export const LAN_NOTICE_KEY = 'lanNoticeDismissed';
export const EMULATOR_PROXIES_KEY = 'emulatorProxies';
export const MCP_TOKEN_FILE = 'mcp-token';
export const PASSPHRASE_METHOD = 'secrets.clientCertPassphrase';

/** Plugin → sidecar methods added to types.ts `PluginRequest` (all optional for the plugin). */
export const EXTRA_METHODS = ['workspaceFolders', 'uiVisible', 'fileSaved'] as const;

export const LAN_NOTICE =
  "Flutter Intercept: your iPhone reaches the proxy over Wi-Fi, on this computer's LAN address. " +
  'macOS may ask whether Node may accept incoming network connections, and iOS asks your app for ' +
  "Local Network access on its first run: allow both, or the iPhone's traffic bypasses Flutter Intercept. " +
  'Use this on a trusted Wi-Fi: on shared or public Wi-Fi, others may be able to observe the session token.';

/** What the host needs from the stdio link. */
export interface PluginLink {
  request<T = unknown>(method: string, params?: unknown): Promise<T>;
  event(event: string, data?: unknown): void;
}

export interface SidecarHostOptions {
  link: PluginLink;
  /** Raw log sink (stderr). The host redacts its own secrets before calling it. */
  log(line: string): void;
  version: string;
  /** Folder with webview.js / webview.css. */
  webviewDir: string;
  // ---- test seams
  proxyFactory?: ProxyFactory;
  caGenerate?: CaGenerator;
  adbExec?: AdbExec;
  /** null = no adb. */
  adbPath?: string | null;
  lanAddress?(): Promise<LanAddress>;
  webSocket?: WebSocketCtor | null;
  uiToken?: string;
}

type SessionInfo = { record: LaunchRecord; deviceId?: string; vmServiceUri?: string; webLaunchUrl?: string };

const AGENT_CLIENTS: readonly AgentClient[] = ['claude', 'cursor', 'gemini', 'windsurf', 'other'];
const MAX_LAUNCHES = 50;

function asObject(v: unknown, what: string): Record<string, unknown> {
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new RpcFailure(`${what}: params must be an object`, 'invalid');
  return v as Record<string, unknown>;
}
/**
 * A project folder we may scan and watch: absolute, an existing directory, not a file-system root (the IDE can report
 * virtual or root content roots such as `/` or `/src`; watching those fails or walks the whole disk).
 */
export function usableFolder(p: string): boolean {
  if (!path.isAbsolute(p)) return false;
  const r = path.resolve(p);
  if (path.parse(r).root === r) return false;
  try {
    return fs.statSync(r).isDirectory();
  } catch {
    return false;
  }
}
const absPaths = (v: unknown): string[] =>
  Array.isArray(v) ? [...new Set(v.filter((p): p is string => typeof p === 'string' && usableFolder(p)).map((p) => path.resolve(p)))].slice(0, 100) : [];

/** Folders with a pubspec.yaml, or their direct children that have one (same rule as the VS Code host). */
export function flutterProjectRoots(folders: string[]): string[] {
  const roots: string[] = [];
  for (const root of folders) {
    if (fs.existsSync(path.join(root, 'pubspec.yaml'))) roots.push(root);
    try {
      for (const child of fs.readdirSync(root, { withFileTypes: true })) {
        if (child.isDirectory() && fs.existsSync(path.join(root, child.name, 'pubspec.yaml'))) roots.push(path.join(root, child.name));
      }
    } catch {
      // unreadable folder
    }
  }
  return [...new Set(roots)];
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

/** REVIEW-9 #7: the MCP token lives in the IDE's password store under this key (`secrets.get` / `secrets.set`). */
export const MCP_TOKEN_KEY = 'flutterIntercept.mcpToken';
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;

/** The legacy / fallback token file (0600) in `dataDir`, if it holds a valid token. */
async function readTokenFile(file: string): Promise<string | undefined> {
  try {
    const t = (await fs.promises.readFile(file, 'utf8')).trim();
    return TOKEN_RE.test(t) ? t : undefined;
  } catch {
    return undefined;
  }
}

/** Fallback only (the plugin has no password store): loads or creates the 0600 token file. */
export async function loadMcpTokenFile(dataDir: string): Promise<string> {
  const file = path.join(dataDir, MCP_TOKEN_FILE);
  const existing = await readTokenFile(file);
  if (existing) {
    if (process.platform !== 'win32' && ((await fs.promises.stat(file)).mode & 0o077) !== 0) await fs.promises.chmod(file, 0o600);
    return existing;
  }
  const token = generateToken();
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  await fs.promises.mkdir(dataDir, { recursive: true, mode: 0o700 });
  await fs.promises.writeFile(tmp, token, { mode: 0o600, flag: 'wx' });
  await fs.promises.rename(tmp, file);
  return token;
}

const isUnavailable = (e: unknown) => {
  const code = (e as RpcFailure)?.code;
  return code === 'unavailable' || code === 'unknown_method';
};

/**
 * The MCP token: from the plugin's password store (`secrets.get`); else migrated once from the legacy file (then
 * deleted) or newly generated, and stored with `secrets.set`. Only when the plugin answers `unavailable` (or doesn't
 * know the methods) is the 0600 file in `dataDir` used. Other errors propagate (the MCP server doesn't start).
 */
export async function loadMcpToken(dataDir: string, link: Pick<PluginLink, 'request'>, log: (m: string) => void = () => undefined): Promise<string> {
  const file = path.join(dataDir, MCP_TOKEN_FILE);
  let stored: unknown;
  try {
    stored = await link.request('secrets.get', { key: MCP_TOKEN_KEY });
  } catch (e) {
    if (isUnavailable(e)) {
      log('MCP: the IDE has no password store available; keeping the token in a private file');
      return loadMcpTokenFile(dataDir);
    }
    throw e;
  }
  if (typeof stored === 'string' && TOKEN_RE.test(stored)) {
    await fs.promises.unlink(file).catch(() => undefined); // a leftover legacy file
    return stored;
  }
  const token = (await readTokenFile(file)) ?? generateToken();
  try {
    await link.request('secrets.set', { key: MCP_TOKEN_KEY, value: token });
  } catch (e) {
    if (isUnavailable(e)) return loadMcpTokenFile(dataDir);
    throw e;
  }
  await fs.promises.unlink(file).catch(() => undefined);
  return token;
}

export class SidecarHost {
  private initialized = false;
  private settings: SidecarSettings = normalizeSettings({});
  private theme: InitParams['theme'] = 'dark';
  private folders: string[] = [];
  private dataDir = '';
  private ide = { name: '', version: '', pluginVersion: '' };
  private uiVisible = false;
  private readonly secrets = new Set<string>();
  private readonly disposers: (() => unknown)[] = [];
  private readonly launches = new Map<string, LaunchRecord>();
  private readonly sessions = new Map<string, SessionInfo>();
  private readonly webSessions = new Set<string>();
  private revealed = false;
  private lastStatus = '';
  private passphraseUnsupported = false;
  private shuttingDown?: Promise<void>;

  // composed in init()
  private state!: JsonStateStore;
  private proxyHost!: InterceptProxyHost;
  private controller!: InterceptController;
  private shared!: NodeSharedRules;
  private grpc!: GrpcSchemaService;
  private contract!: NodeContractService;
  private vm!: SidecarVm;
  private ui!: UiServer;
  private reverses!: ReverseTracker;
  private nativeRoutes!: AndroidGlobalProxy;
  private lanLife!: LanLifecycle;
  private lanWatcher!: LanNetworkWatcher;
  private webPac!: PacServer;
  private notifications!: Notifications;
  private ca!: CaStore;
  private agentApi!: ReturnType<typeof createAgentApi>;
  private webSkipped!: (message: string) => void;
  private mcp?: RunningMcpServer;
  private mcpPort?: number;
  private mcpToken?: string;
  private mcpReconciling: Promise<void> = Promise.resolve();
  private lastAgentCall?: { tool: string; at: number };
  private upstreamProblemShown?: string;
  private lanNoticeShown = false;

  constructor(private readonly o: SidecarHostOptions) {}

  /** Log line with this run's secrets (UI token, MCP token) blanked out. */
  log = (line: string): void => {
    let out = line;
    for (const s of this.secrets) if (s && out.includes(s)) out = out.split(s).join('…');
    this.o.log(out);
  };

  // ------------------------------------------------------------------ dispatch

  async handle(method: string, params: unknown): Promise<unknown> {
    if (method === 'init') return this.init(params);
    if (method === 'shutdown') {
      await this.shutdown();
      return null;
    }
    if (!this.initialized) throw new RpcFailure('not initialized: send init first', 'not_initialized');
    switch (method) {
      case 'settings':
        await this.applySettings(normalizeSettings(asObject(params, 'settings').settings));
        return null;
      case 'theme':
        this.theme = normalizeTheme(asObject(params, 'theme').theme);
        return null;
      case 'prepareLaunch':
        return this.prepareLaunch(asObject(params, 'prepareLaunch') as unknown as PrepareLaunchParams);
      case 'sessionStarted':
        return this.sessionStarted(asObject(params, 'sessionStarted') as unknown as SessionStartedParams);
      case 'sessionEnded':
        this.sessionEnded(asObject(params, 'sessionEnded') as unknown as SessionEndedParams);
        return null;
      case 'uiUrl':
        return { url: this.ui.issueUrl() };
      case 'connectAgent':
        return this.connectAgent(asObject(params, 'connectAgent').client);
      case 'command':
        return this.command(asObject(params, 'command').name);
      // ---- additions (optional for the plugin)
      case 'workspaceFolders':
        this.setFolders(absPaths(asObject(params, 'workspaceFolders').workspaceFolders));
        return null;
      case 'uiVisible':
        this.uiVisible = asObject(params, 'uiVisible').visible === true;
        return null;
      case 'fileSaved': {
        const p = asObject(params, 'fileSaved').path;
        if (typeof p !== 'string' || !path.isAbsolute(p)) throw new RpcFailure('fileSaved: path must be absolute', 'invalid');
        return { approved: await this.shared.noteScriptFileSaved(p) };
      }
      default:
        throw new RpcFailure(`unknown method ${method.slice(0, 60)}`, 'unknown_method');
    }
  }

  // ------------------------------------------------------------------ UI requests to the plugin

  private ask<T>(method: string, params: unknown): Promise<T> {
    return this.o.link.request<T>(method, params);
  }

  /** Fire-and-forget notification; resolves with the clicked button. */
  private notify(level: 'info' | 'warning' | 'error', message: string, buttons?: string[]): Promise<string | undefined> {
    return this.ask<string | null>('ui.notify', { level, message, ...(buttons?.length ? { buttons } : {}) }).then(
      (b) => (typeof b === 'string' ? b : undefined),
      (e: unknown) => {
        this.log(`ui.notify failed: ${(e as Error)?.message ?? e}`);
        return undefined;
      },
    );
  }

  private async openFile(file: string, line?: number, column?: number): Promise<void> {
    await this.ask('ui.openFile', { path: file, ...(line ? { line } : {}), ...(column ? { column } : {}) });
  }

  private async pick(items: { label: string; description?: string; value: string }[], opts: { title?: string; placeholder?: string } = {}): Promise<string | undefined> {
    const v = await this.ask<string | null>('ui.pick', { ...opts, items });
    return typeof v === 'string' ? v : undefined;
  }

  // ------------------------------------------------------------------ init

  private async init(raw: unknown): Promise<InitResult> {
    if (this.initialized) throw new RpcFailure('already initialized', 'invalid');
    const p = asObject(raw, 'init');
    if (typeof p.dataDir !== 'string' || !path.isAbsolute(p.dataDir)) throw new RpcFailure('init: dataDir must be an absolute path', 'invalid');
    this.dataDir = path.resolve(p.dataDir);
    this.folders = absPaths(p.workspaceFolders);
    this.settings = normalizeSettings(p.settings);
    this.theme = normalizeTheme(p.theme);
    const ide = p.ide && typeof p.ide === 'object' ? (p.ide as Record<string, unknown>) : {};
    this.ide = { name: String(ide.name ?? '').slice(0, 100), version: String(ide.version ?? '').slice(0, 100), pluginVersion: String(ide.pluginVersion ?? '').slice(0, 100) };
    this.initialized = true;
    this.compose();
    const uiUrl = await this.ui.start();
    await this.reconcileMcp();
    const result: InitResult = { uiUrl, ...(this.mcp ? { mcpUrl: this.mcp.url } : {}), version: this.o.version };
    this.log(`Flutter Intercept sidecar ${this.o.version} for ${this.ide.name || 'IDE'} ${this.ide.version} (plugin ${this.ide.pluginVersion || '?'}), ${this.folders.length} project folder(s)`);
    this.o.link.event('ready', result);
    this.emitStatus(true);
    return result;
  }

  private compose(): void {
    const log = this.log;
    this.state = new JsonStateStore(this.dataDir, log);
    void cleanupLanDefines(this.dataDir).then((n) => n && log(`removed ${n} stale LAN define file(s)`));
    this.disposers.push(() => cleanupLanDefines(this.dataDir));
    this.ca = new CaStore(this.dataDir, { log, ...(this.o.caGenerate ? { generate: this.o.caGenerate } : {}) });
    const adbOpts = { log, ...(this.o.adbExec ? { exec: this.o.adbExec } : {}), ...(this.o.adbPath !== undefined ? { adbPath: this.o.adbPath } : {}) };
    this.reverses = new ReverseTracker(adbOpts);
    this.nativeRoutes = new AndroidGlobalProxy({
      ...adbOpts,
      store: { get: () => this.state.get(EMULATOR_PROXIES_KEY, []), set: (r) => this.state.update(EMULATOR_PROXIES_KEY, r) },
    });
    void this.nativeRoutes.recover().catch((e: unknown) => log(`emulator proxy recovery failed: ${String(e)}`));
    this.disposers.push(() => this.nativeRoutes.releaseAll());

    this.proxyHost = new InterceptProxyHost({
      getPort: () => this.settings.port,
      getCa: () => this.ca.get(),
      factory:
        this.o.proxyFactory ??
        ((opts) => {
          // eslint-disable-next-line @typescript-eslint/no-require-imports
          const { InterceptProxy: Proxy } = require('@flutter-intercept/proxy') as { InterceptProxy: typeof InterceptProxy };
          return new Proxy(opts);
        }),
      onStop: async () => {
        await this.nativeRoutes.releaseAll().catch((e: unknown) => log(`emulator proxy release failed: ${String(e)}`));
        await this.reverses.removeAll();
      },
      // CONTRACTS §14.6: the IDE's own HTTP proxy is the default upstream when ours is empty.
      vscodeHttpProxy: () => this.settings.ideHttpProxy,
      rewriteLocalhost: () => this.settings.rewriteLocalhost,
      canRestart: () => this.sessions.size === 0,
      canReopenLan: () => this.lanLife.liveSessions === 0,
      onLanTokenRotatedWhileLive: () =>
        void this.notify('warning', 'Flutter Intercept: the iPhone proxy credentials changed while an iPhone session is running. Stop and relaunch that session, or its plain-http requests will fail.'),
      log,
    });
    this.lanLife = new LanLifecycle({ closeLan: () => this.proxyHost.closeLan().catch((e: unknown) => log(`closeLan failed: ${String(e)}`)), log });
    this.lanWatcher = new LanNetworkWatcher({
      snapshot: (iface) => netFingerprint(iface),
      onTick: () => this.proxyHost.refreshLanPeer(),
      onChange: (reason) => {
        log(`network changed while the LAN listener was open: ${reason}; closing it`);
        void this.proxyHost.closeLan({ forgetToken: true }).catch((e: unknown) => log(`closeLan failed: ${String(e)}`));
        void this.notify('warning', `Flutter Intercept: your computer's network changed (${reason}), so the iPhone listener was closed. Relaunch the iPhone session.`);
      },
    });
    this.disposers.push(() => this.lanLife.dispose(), () => this.lanWatcher.stop());
    this.webPac = new PacServer({ currentPort: () => this.proxyHost.port, log });
    this.disposers.push(() => this.webPac.dispose());
    this.webSkipped = createWebServerNotice({
      show: (m, ...a) => this.notify('info', m, a),
      copy: (t) => this.ask('ui.clipboard', { text: t }).then(() => undefined),
      proxy: async () => ({ port: await this.proxyHost.start(), caCertPem: (await this.ca.get()).cert }),
      log,
    });

    let saved: Rule[] = [];
    try {
      saved = validateRules(this.state.get<unknown>(RULES_KEY) ?? []);
    } catch (e) {
      log(`ignoring invalid saved rules: ${(e as Error).message}`);
    }
    this.proxyHost.setRules(saved);

    // CONTRACTS §10 / §12: contract checks, codegen, shared rules, recordings.
    this.contract = createNodeContractService({ roots: () => this.folders, memento: this.state, log });
    this.disposers.push(() => this.contract.dispose());
    const codegen = createCodegenService();
    this.shared = createNodeSharedRules({ roots: () => this.folders, memento: this.state, validateRule, log });
    this.disposers.push(() => this.shared.dispose());
    this.proxyHost.setBodyFileResolver((p, id) => this.shared.resolveBodyFile(p, id));
    this.proxyHost.setScriptFileResolver((p, id) => this.shared.resolveScriptFile(p, id));
    this.shared.onDidChangeBodyFile((p) => this.proxyHost.refreshBodyFiles(p));
    const recordings = createRecordingService({ root: () => this.projectRoot() });
    this.applyUpstreamProxy();
    this.proxyHost.setTlsPassthrough(this.settings.tlsPassthrough);
    void this.applyClientCertificates();
    // CONTRACTS §16.4: gRPC decrypt hosts and the schema from the app's generated `*.pb*.dart`.
    this.proxyHost.setGrpcDecryptHosts(this.settings.grpc?.decryptHosts ?? []);
    const grpc = (this.grpc = createGrpcSchemaService({
      codec: grpcCodec,
      roots: () => this.folders,
      enabled: () => this.settings.grpc?.enabled !== false,
      log,
    }));
    this.disposers.push(() => grpc.dispose());
    this.proxyHost.setGrpcMessageEncoder(grpcMockEncoder(grpc));
    const grpcSub = grpc.onDidChange(() => this.proxyHost.refreshGrpcMocks());
    this.disposers.push(() => grpcSub.dispose());
    void grpc.ready();

    const exporters = { openapi: toOpenApi, postman: toPostman };
    const shared = this.shared;
    const sharedDeps = {
      state: () => shared.state(),
      save: (rules: Rule[]) => shared.save(rules),
      removeShared: (id: string) => shared.removeShared(id),
      pendingReasons: () => shared.pendingReasons(),
      approvePending: () => this.approvePending(),
    };
    this.controller = new InterceptController({
      host: this.proxyHost,
      grpc,
      saveRules: (rules) => {
        void shared.setPersonalRules(rules).catch((e: unknown) => log(`personal rules → shared service: ${String(e)}`));
        return this.state.update(RULES_KEY, rules);
      },
      getEnabled: () => this.settings.enabled,
      setEnabled: (enabled) => this.setEnabled(enabled),
      log,
      getAgentStatus: () => this.agentStatus(),
      openSource: async (ex, frameIndex) => {
        const frame = ex.source?.frames[frameIndex];
        if (!frame) throw new Error('No source location was recorded for this request.');
        const roots = this.projectRoots();
        const [resolved] = resolveFrames([frame], roots);
        if (!resolved?.path) throw new Error(`No source file for ${frame.fn ? `${frame.fn} (${frame.uri})` : frame.uri}: it is not in this project's packages.`);
        // REVIEW-3 #3: trace frames are app-controlled; open only project and package files.
        const real = checkSourcePath(resolved.path, [...this.folders, ...packageRootsFor(roots)]);
        await this.openFile(real, resolved.line, resolved.column);
      },
      copyToClipboard: (text) => this.ask('ui.clipboard', { text }),
      contract: this.contract,
      contractCheckEnabled: () => this.settings.contractCheck,
      onContractRemoved: (ids) => this.contract.forget(ids),
      pickModel: (ex) => this.pickModel(ex),
      openLocation: async (file, line) => {
        const safe = checkSourcePath(file, [...this.folders, ...packageRootsFor(this.projectRoots())]);
        await this.openFile(safe, Math.max(1, line));
      },
      codegen,
      openUntitled: (files) => this.openUntitled(files),
      projectRoot: () => this.projectRoot(),
      appPackageName: () => appPackageNames(this.projectRoots())[0],
      shared: sharedDeps,
      openSharedRules: async () => {
        const file = shared.files()[0];
        if (!file) throw new Error('No Flutter project folder is open.');
        if (!fs.existsSync(file.path)) await shared.save(shared.fileRules());
        await this.openFile(file.path);
      },
      openBodyFile: (bodyFile, create, ruleId) => this.openWorkspaceFile('body file', bodyFile, create, (c) => shared.checkBodyFileContent(c), ruleId),
      openScriptFile: async (scriptFile, create, ruleId) => {
        if (await this.openWorkspaceFile('script file', scriptFile, create, (c) => shared.checkScriptFileContent(c), ruleId)) await shared.approveScriptFile(scriptFile, ruleId);
      },
      exporters,
      pickOne: (items, placeholder) => this.pick(items.map((l) => ({ label: l, value: l })), { placeholder }),
      showSaveDialog: async (defaultPath, format) => {
        const filters = format === 'har' ? { 'HTTP Archive': ['har'] } : { JSON: ['json'] };
        const v = await this.ask<string | null>('ui.save', { defaultPath, filters });
        return typeof v === 'string' && path.isAbsolute(v) ? v : undefined;
      },
      confirmWarning: async (message, button) => (await this.ask<string | null>('ui.confirm', { message, buttons: [button], modal: true })) === button,
      version: this.o.version,
      recordings,
      openDiff: async (a, b) => {
        await this.ask('ui.diff', { title: `Recordings: ${a.name} ↔ ${b.name}`, left: { name: `${a.name}.txt`, content: diffText(a) }, right: { name: `${b.name}.txt`, content: diffText(b) } });
      },
      analyzeAuth: (ex) => analyzeAuth(ex),
    });
    this.disposers.push(() => this.controller.dispose());
    void shared.ready.then(async () => {
      await shared.setPersonalRules(this.controller.personalRules());
      this.controller.setSharedRules(shared.state().rules);
    });
    shared.onDidChange((st) => {
      this.controller.setSharedRules(st.rules);
      this.proxyHost.refreshBodyFiles();
    });

    // CONTRACTS §11.4 / §13.3 / §14.7 over the VM service WebSocket.
    this.vm = createSidecarVm({
      ...this.proxyHost.vmHostDeps(log),
      nativeClients: () => this.settings.nativeClients,
      nativeRouted: (sid) => this.nativeRoutes.isRouted(sid),
      nativeRouteFailed: (sid) => void this.nativeRoutes.release(sid),
      proxySaw: (q) => this.proxyHost.getExchanges().some((x) => matchesProxyExchange(x, q)),
      backgroundIsolates: () => this.settings.backgroundIsolates,
      isOurProxy: (_host, port) => port === this.proxyHost.port || port === this.proxyHost.lan?.port,
      ...(this.o.webSocket !== undefined ? { webSocket: this.o.webSocket } : {}),
    });
    this.disposers.push(() => this.vm.dispose());

    // AI agents (CONTRACTS §8): the AgentApi behind the MCP server (no Copilot tools outside VS Code).
    this.agentApi = createAgentApi({
      host: this.proxyHost,
      grpc: this.grpc,
      applyRules: (rules) => this.controller.applyRules(rules),
      clear: () => this.controller.clear(),
      getSettings: () => this.agentSettings(),
      launcher: this.launcher(),
      projectRoot: () => this.projectRoot(),
      resolveFrames: (frames) => resolveFrames(frames, this.projectRoots()),
      recordings,
      recordingsChanged: () => void this.controller.refreshRecordings(),
      analyzeAuth: (ex) => analyzeAuth(ex),
      contract: this.contract,
      contractResult: (id) => this.controller.contractResult(id),
      codegen,
      appPackageName: () => appPackageNames(this.projectRoots())[0],
      version: this.o.version,
      exporters,
      takeScreenshot: (target) => {
        const s = this.sessions.get(target.sessionId);
        if (s?.record.web) {
          return webScreenshot(target, { appUrl: () => s.webLaunchUrl, webFlags: () => s.record.webFlags, exec: execTool, log });
        }
        return takeScreenshot(target, { callService: (sid, method, params) => this.vm.callService(sid, method, params), exec: execTool, log });
      },
    });
    this.agentApi.onDidCall((e) => {
      this.lastAgentCall = { tool: e.tool, at: e.at };
      this.controller.broadcastStatus();
    });
    this.refreshAppPackages();

    // CONTRACTS §13.6: failed requests while the traffic view isn't on screen → IDE notifications.
    this.notifications = registerNotifications({
      showMessage: (text, ...buttons) => this.notify('warning', `Flutter Intercept: ${text}`, buttons),
      reveal: async (id) => {
        await this.ask('ui.reveal', { exchangeId: id }).catch(() => undefined);
        this.controller.select(id);
      },
      turnOff: () => {
        this.settings = { ...this.settings, notifications: 'off' };
        this.o.link.event('settingsChanged', { notifications: 'off' });
        this.notifications.refreshLevel();
      },
      getLevel: () => this.settings.notifications,
      isPanelVisible: () => this.uiVisible && this.ui.clientCount > 0,
      onError: (e) => log(`notification failed: ${String(e)}`),
    });
    this.disposers.push(() => this.notifications.dispose());
    this.proxyHost.on('exchange', (e: Exchange) => this.notifications.onExchange(e));

    // Status events for the plugin's status bar widget.
    this.proxyHost.on('state', () => this.emitStatus());
    this.proxyHost.on('lan', (l: unknown) => {
      if (!l) {
        this.lanWatcher.stop();
        void cleanupLanDefines(this.dataDir); // REVIEW-9: no LAN token file outlives the listener
      }
      this.emitStatus();
      this.controller.broadcastStatus();
    });
    this.controller.onPausedCount(() => this.emitStatus());
    const poll = setInterval(() => {
      const n = this.mcp?.sessions ?? 0;
      if (n !== this.lastMcpClients) {
        this.lastMcpClients = n;
        this.controller.broadcastStatus();
      }
    }, 2000);
    poll.unref();
    this.disposers.push(() => clearInterval(poll));

    this.ui = new UiServer({ controller: this.controller, webviewDir: this.o.webviewDir, theme: () => this.theme, log, ...(this.o.uiToken ? { token: this.o.uiToken } : {}) });
    this.disposers.push(() => this.ui.close());
  }

  private lastMcpClients = 0;

  // ------------------------------------------------------------------ helpers

  private projectRoots(): string[] {
    return flutterProjectRoots(this.folders);
  }

  private projectRoot(): string | undefined {
    return this.projectRoots()[0] ?? this.folders[0];
  }

  private refreshAppPackages(): void {
    this.proxyHost.setAppPackages(appPackageNames(this.projectRoots()));
  }

  private setFolders(folders: string[]): void {
    if (JSON.stringify(folders) === JSON.stringify(this.folders)) return;
    this.folders = folders;
    this.shared.rootsChanged();
    this.contract.rootsChanged();
    this.grpc.rootsChanged();
    this.refreshAppPackages();
  }

  private agentSettings(): { access: AgentAccess; redactSecrets: boolean; interceptEnabled: boolean; screenshots: boolean } {
    const a = this.settings.agent;
    return { access: a.access, redactSecrets: a.redactSecrets, interceptEnabled: this.settings.enabled, screenshots: a.screenshots };
  }

  private agentStatus() {
    return {
      access: this.settings.agent.access,
      ...(this.mcp?.url ? { mcpUrl: this.mcp.url } : {}),
      clients: this.mcp?.sessions ?? 0,
      ...(this.lastAgentCall ? { lastCall: this.lastAgentCall } : {}),
    };
  }

  /** launch_app / stop_app / hot_restart belong to the IDE's run configurations; the session list is ours. */
  private launcher(): AppLauncher {
    const unavailable = (what: string) => Promise.reject(new AgentToolError(`${what} is not available in ${this.ide.name || 'this IDE'} yet: use the IDE's Run / Stop buttons (sessions it starts are intercepted automatically)`, 'state'));
    return {
      launch: () => unavailable('launch_app'),
      stop: () => unavailable('stop_app'),
      hotRestart: () => unavailable('hot_restart'),
      sessions: () =>
        [...this.sessions.entries()].map(([id, s]) => ({
          id,
          ...(s.deviceId ?? s.record.deviceId ? { deviceId: s.deviceId ?? s.record.deviceId } : {}),
          program: s.record.program,
          mode: s.record.flutterMode,
          ...(s.record.lan ? { lan: true } : {}),
        })),
    };
  }

  private emitStatus(force = false): void {
    if (!this.initialized || !this.proxyHost) return;
    const data = {
      proxyRunning: this.proxyHost.running,
      ...(this.proxyHost.port !== undefined ? { port: this.proxyHost.port } : {}),
      enabled: this.settings.enabled,
      sessions: this.sessions.size,
      paused: this.controller?.pausedCount ?? 0,
      ...(this.proxyHost.lan ? { lan: true } : {}),
    };
    const text = JSON.stringify(data);
    if (!force && text === this.lastStatus) return;
    this.lastStatus = text;
    this.o.link.event('status', data);
  }

  private async setEnabled(enabled: boolean): Promise<void> {
    if (this.settings.enabled === enabled) return;
    this.settings = { ...this.settings, enabled };
    // The plugin owns the stored settings: it persists this (status.enabled reflects it too).
    this.o.link.event('settingsChanged', { enabled });
    this.emitStatus();
  }

  private applyUpstreamProxy(): void {
    try {
      const r = this.proxyHost.applyUpstreamSettings({ url: this.settings.upstreamProxy, ignoreCertErrors: this.settings.upstreamProxyIgnoreCertErrors });
      if (r.problem && r.problem !== this.upstreamProblemShown) {
        this.upstreamProblemShown = r.problem;
        this.log(`upstream proxy: ${r.problem}`);
        void this.notify('warning', `Flutter Intercept: ${r.problem}`);
      }
    } catch (e) {
      const msg = `Flutter Intercept: ignoring the upstream proxy setting: ${(e as Error).message}`;
      this.log(msg);
      void this.notify('warning', msg);
    }
  }

  /** CONTRACTS §14.3: passphrases live in the IDE's password safe and are asked for per host, never in settings. */
  private async getPassphrase(host: string): Promise<string | undefined> {
    if (this.passphraseUnsupported) return undefined;
    try {
      const v = await this.ask<string | null>(PASSPHRASE_METHOD, { host });
      return typeof v === 'string' && v ? v : undefined;
    } catch (e) {
      const code = (e as RpcFailure).code;
      if (code === 'unknown_method' || code === 'not_found') this.passphraseUnsupported = true;
      return undefined;
    }
  }

  private async applyClientCertificates(): Promise<void> {
    try {
      const r = await loadClientCertificates(this.settings.clientCertificates, { getPassphrase: (h) => this.getPassphrase(h), log: this.log });
      this.proxyHost.setClientCertificates(r.certs, r.status);
    } catch (e) {
      this.log(`client certificates: ${String(e)}`);
    }
  }

  private async applySettings(next: SidecarSettings): Promise<void> {
    const prev = this.settings;
    this.settings = next;
    const changed = (k: keyof SidecarSettings) => JSON.stringify(prev[k]) !== JSON.stringify(next[k]);
    if (changed('upstreamProxy') || changed('upstreamProxyIgnoreCertErrors') || changed('ideHttpProxy')) {
      this.upstreamProblemShown = undefined;
      this.applyUpstreamProxy();
    }
    if (changed('tlsPassthrough')) this.proxyHost.setTlsPassthrough(next.tlsPassthrough);
    if (changed('grpc')) {
      this.proxyHost.setGrpcDecryptHosts(next.grpc?.decryptHosts ?? []);
      if (prev.grpc?.enabled !== next.grpc?.enabled) this.grpc.enabledChanged();
    }
    // Always re-load: a passphrase changed in the IDE's password store arrives as a `settings` call (REVIEW-9 #7).
    await this.applyClientCertificates();
    if (changed('contractCheck')) this.controller.recheckContracts();
    if (changed('notifications')) this.notifications.refreshLevel();
    if (changed('agent')) await this.reconcileMcp();
    this.emitStatus();
    this.controller.broadcastStatus();
  }

  private reconcileMcp(): Promise<void> {
    this.mcpReconciling = this.mcpReconciling.then(async () => {
      const want = this.settings.agent.access !== 'off';
      const port = this.settings.agent.mcpPort;
      if (this.mcp && (!want || this.mcpPort !== port)) {
        const s = this.mcp;
        this.mcp = undefined;
        this.mcpPort = undefined;
        await s.close();
      }
      if (want && !this.mcp) {
        try {
          this.mcpToken ??= await loadMcpToken(this.dataDir, { request: (m, p) => withTimeout(this.o.link.request(m, p), 10_000, m) }, this.log);
          this.secrets.add(this.mcpToken);
          this.mcp = await startMcpServer({
            port: Number.isInteger(port) ? port : DEFAULT_MCP_PORT,
            token: this.mcpToken,
            tools: this.agentApi,
            schemas: toolSchemas,
            descriptions: toolDescriptions(),
            version: this.o.version,
            log: this.log,
          });
          this.mcpPort = port;
        } catch (e) {
          this.log(`MCP: not started: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
      this.controller.broadcastStatus();
    });
    return this.mcpReconciling;
  }

  private async connectAgent(client: unknown): Promise<{ text: string }> {
    if (typeof client !== 'string' || !(AGENT_CLIENTS as readonly string[]).includes(client)) throw new RpcFailure('connectAgent: unknown client', 'invalid');
    await this.mcpReconciling;
    if (!this.mcp || !this.mcpToken) {
      const why = this.settings.agent.access === 'off' ? 'Agent access is off (Settings → Tools → Flutter Intercept).' : 'The MCP server is not running (see the Flutter Intercept log).';
      throw new RpcFailure(why, 'unavailable');
    }
    return { text: connectSnippet(client as AgentClient, this.mcp.url, this.mcpToken).text };
  }

  private async command(name: unknown): Promise<unknown> {
    switch (name) {
      case 'clear':
        this.controller.clear();
        return null;
      case 'toggle':
        await this.setEnabled(!this.settings.enabled);
        this.controller.broadcastStatus();
        return { enabled: this.settings.enabled };
      case 'exportOpenApi':
      case 'exportPostman': {
        const format = name === 'exportOpenApi' ? 'openapi' : 'postman';
        try {
          const written = await this.controller.exportTraffic(format);
          if (written) void this.notify('info', `Flutter Intercept: exported ${format === 'openapi' ? 'OpenAPI' : 'Postman collection'} to ${written}`);
          return { path: written ?? null };
        } catch (e) {
          void this.notify('error', `Flutter Intercept: ${(e as Error).message}`);
          return { path: null };
        }
      }
      case 'saveCaCertificate': {
        const root = this.projectRoot();
        const target = await this.ask<string | null>('ui.save', { defaultPath: path.join(root ?? os.homedir(), 'flutter_intercept_ca.pem'), filters: { 'PEM certificate': ['pem', 'crt'] } });
        if (typeof target !== 'string' || !path.isAbsolute(target)) return { path: null };
        await fs.promises.writeFile(target, (await this.ca.get()).cert, { encoding: 'utf8' });
        void this.notify('info', `Flutter Intercept: saved the CA certificate (public part only) to ${target}. Only debug builds should trust it.`);
        return { path: target };
      }
      default:
        throw new RpcFailure(`unknown command ${String(name).slice(0, 60)}`, 'invalid');
    }
  }

  private async pickModel(ex: Exchange): Promise<string | undefined | null> {
    const models = await this.contract.models();
    const rel = (f: string) => {
      const root = this.folders.find((r) => f.startsWith(r + path.sep));
      return root ? path.relative(root, f) : f;
    };
    const items = [
      ...models.map((m) => ({ label: m.name, description: rel(m.file), value: `model:${m.name}` })),
      ...models.map((m) => ({ label: `List<${m.name}>`, description: 'a JSON array of these', value: `model:List<${m.name}>` })),
      { label: "Don't check this route", value: 'dont-check' },
      { label: 'Forget my choice (map automatically)', value: 'forget' },
    ];
    const v = await this.pick(items, {
      title: `Check ${ex.method} ${ex.url.split('?')[0]} against…`,
      placeholder: models.length ? 'Model (from your *.g.dart files)' : 'No json_serializable / freezed models found in this project',
    });
    if (v === undefined) return null;
    if (v === 'dont-check') return DONT_CHECK;
    if (v === 'forget') return undefined;
    return v.startsWith('model:') ? v.slice('model:'.length) : null;
  }

  private async openUntitled(files: GeneratedFile[]): Promise<void> {
    if (!files.length) return;
    await this.ask('ui.openUntitled', { files: files.map((f) => ({ name: f.path, content: f.content, language: f.path.endsWith('.json') ? 'json' : 'dart' })) });
    void this.notify('info', `Flutter Intercept: generated ${files.map((f) => f.path).join(', ')} — save them where you want them.`);
  }

  /** CONTRACTS §12.1: the same approval modal content as VS Code, via `ui.confirm`. */
  private async approvePending(): Promise<void> {
    const snap = this.shared.pendingSnapshot();
    if (!snap.items.length) return;
    const shown = snap.items.slice(0, 20).map((i) => `• ${i.name} (${i.match}) in ${i.folder}: ${i.reason}`);
    if (snap.items.length > shown.length) shown.push(`…and ${snap.items.length - shown.length} more (open the file to review them).`);
    const scripts = snap.items.filter((i) => i.script);
    const REVIEW = 'Review scripts…';
    const warning = scripts.length
      ? "Only approve rules from people you trust: scripts run on every matching request and can read, change and redirect it, credentials included; other rules can send your app's requests to another server or change what it receives."
      : "Only approve rules from people you trust: they can send your app's requests, with its credentials, to another server or change what it receives.";
    const ok = await this.ask<string | null>('ui.confirm', {
      message: `Approve ${snap.items.length} Flutter Intercept rule${snap.items.length === 1 ? '' : 's'}?`,
      detail: `${shown.join('\n')}\n\n${warning}`,
      buttons: ['Approve', ...(scripts.length ? [REVIEW] : [])],
      modal: true,
    });
    if (ok === 'Approve') await this.shared.approvePending(snap.hash);
    if (ok === REVIEW) {
      const untitled: { name: string; content: string; language: string }[] = [];
      for (const item of scripts) {
        const sc = item.script!;
        if (sc.path && !sc.error) await this.openFile(sc.path);
        else {
          const header = `// ${item.name} — ${item.reason}${sc.truncated ? '\n// (shown cut at 64 KB)' : ''}${sc.error ? `\n// ${sc.error}` : ''}\n`;
          untitled.push({ name: `${item.name.replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 60) || 'script'}.js`, content: header + sc.code, language: 'javascript' });
        }
      }
      if (untitled.length) await this.ask('ui.openUntitled', { files: untitled });
      void this.notify('info', 'Flutter Intercept: approve the rules from the panel banner once you have reviewed the scripts.');
    }
  }

  /** Opens a project file a rule refers to, creating it only if missing (REVIEW-6 #5/#7, REVIEW-7 #1 guards). */
  private async openWorkspaceFile(what: string, rel: string, create: { content: string } | undefined, secretProblem: (content: string) => string | undefined, ruleId?: string): Promise<boolean> {
    const abs = this.shared.bodyFilePath(rel, ruleId);
    if (!abs) throw new Error(`Not a valid ${what} path: ${rel}`);
    const roots = this.folders.flatMap((f) => {
      try {
        return [fs.realpathSync(f)];
      } catch {
        return [];
      }
    });
    const inside = (p: string) => roots.some((r) => p === r || p.startsWith(r + path.sep));
    let created = false;
    if (create && fs.existsSync(abs) && what === 'script file') {
      throw new Error(`A file already exists at ${rel}. "Create file" never reuses one: pick another name, or use "Open file" to review it first.`);
    }
    if (create && !fs.existsSync(abs)) {
      const secret = secretProblem(create.content);
      if (secret) throw new Error(secret);
      const root = roots.find((r) => abs.startsWith(r + path.sep));
      if (!root) throw new Error(`The ${what} must be inside the project.`);
      // REVIEW-9 #2: silently only under .vscode/flutter-intercept/; never build / VCS / IDE / tool config; else ask.
      const decisions = [createPathDecision(rel), createPathDecision(path.relative(root, abs))];
      const refused = decisions.find((d) => d.kind === 'refuse');
      if (refused && refused.kind === 'refuse') throw new Error(`Refusing to create ${rel}: ${refused.reason}.`);
      if (decisions.some((d) => d.kind === 'confirm')) {
        const CREATE = 'Create';
        const ok = await this.ask<string | null>('ui.confirm', {
          message: `Create ${abs}?`,
          detail: `The Flutter Intercept traffic view wants to create this new ${what} in ${root}. Only continue if you started this yourself.`,
          buttons: [CREATE],
          modal: true,
        });
        if (ok !== CREATE) throw new Error(`Not created: ${rel}.`);
      }
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
    const real = checkSourcePath(abs, roots);
    if (!inside(real)) throw new Error(`The ${what} must be inside the project.`);
    await this.openFile(real);
    return created;
  }

  // ------------------------------------------------------------------ launches and sessions

  private async prepareLaunch(p: PrepareLaunchParams) {
    if (typeof p.launchId !== 'string' || !p.launchId || p.launchId.length > 200) throw new RpcFailure('prepareLaunch: launchId is required', 'invalid');
    if (typeof p.projectRoot !== 'string' || !path.isAbsolute(p.projectRoot)) throw new RpcFailure('prepareLaunch: projectRoot must be absolute', 'invalid');
    if (!Array.isArray(p.additionalArgs) || !p.additionalArgs.every((a) => typeof a === 'string')) throw new RpcFailure('prepareLaunch: additionalArgs must be a list of strings', 'invalid');
    const root = path.resolve(p.projectRoot);
    if (usableFolder(root) && !this.folders.some((f) => root === f || root.startsWith(f + path.sep))) this.setFolders([...this.folders, root]);
    const { result, record } = await prepareLaunch(
      {
        settings: () => this.settings,
        workspaceFolders: () => this.folders,
        proxy: this.proxyHost,
        getCaCertPem: async () => (await this.ca.get()).cert,
        reverses: this.reverses,
        lan: {
          address: () => (this.o.lanAddress ?? (() => lanAddressForIphone()))(),
          open: (host) => this.proxyHost.openLan(host),
          opened: (opened) => {
            this.lanLife.opened();
            void this.lanWatcher.start(opened.host, opened.iface).catch((e: unknown) => this.log(`network watch failed: ${String(e)}`));
            this.showLanNotice();
          },
          unavailable: (message) => void this.notify('warning', message),
        },
        webPac: this.webPac,
        lanDefinesDir: this.dataDir,
        webSkipped: (m) => this.webSkipped(m),
        log: this.log,
      },
      { ...p, projectRoot: root },
    );
    if (record) {
      this.launches.set(record.launchId, record);
      while (this.launches.size > MAX_LAUNCHES) this.launches.delete(this.launches.keys().next().value as string);
    }
    this.emitStatus();
    return result;
  }

  private showLanNotice(): void {
    if (this.lanNoticeShown || this.state.get<boolean>(LAN_NOTICE_KEY)) return;
    this.lanNoticeShown = true;
    void this.notify('info', LAN_NOTICE, ['OK', "Don't show again"]).then((choice) => {
      if (choice === "Don't show again") void this.state.update(LAN_NOTICE_KEY, true);
    });
  }

  private sessionStarted(p: SessionStartedParams): { intercepted: boolean } {
    if (typeof p.sessionId !== 'string' || !p.sessionId || p.sessionId.length > 200) throw new RpcFailure('sessionStarted: sessionId is required', 'invalid');
    const record = typeof p.launchId === 'string' ? this.launches.get(p.launchId) : undefined;
    if (!record) {
      this.log(`session started without a prepared launch: not intercepted`);
      return { intercepted: false };
    }
    this.launches.delete(record.launchId);
    void this.grpc.load();
    const deviceId = typeof p.deviceId === 'string' && p.deviceId ? p.deviceId : record.deviceId;
    const vmServiceUri = typeof p.vmServiceUri === 'string' && p.vmServiceUri ? p.vmServiceUri : undefined;
    const web = (p as { webLaunchUrl?: unknown }).webLaunchUrl;
    const webLaunchUrl = typeof web === 'string' && /^https?:\/\//.test(web) && web.length <= 2048 ? web : undefined;
    this.sessions.set(p.sessionId, { record, deviceId, vmServiceUri, ...(webLaunchUrl ? { webLaunchUrl } : {}) });
    this.refreshAppPackages();
    this.controller.setSessions(this.sessions.size);
    this.emitStatus();
    if (!this.revealed) {
      this.revealed = true;
      void this.ask('ui.reveal', {}).catch(() => undefined);
    }
    if (record.web) {
      this.webSessions.add(p.sessionId);
      this.proxyHost.setWebSessionActive(true);
      this.log(`web session started: device=${deviceId ?? '-'}`);
      return { intercepted: true };
    }
    if (vmServiceUri) void this.vm.attach({ sessionId: p.sessionId, vmServiceUri }).catch((e: unknown) => this.log(`vm attach failed: ${String(e)}`));
    else this.log('session started without a VM service URI: background isolates, native clients and screenshots via the VM are off for it');
    this.log(`session started: ${record.deviceKind} device=${deviceId ?? '-'} proxyHost=${record.lan ? 'LAN' : record.host}`);
    if (this.settings.nativeClients === 'proxy' && record.deviceKind === 'android-emulator' && deviceId && record.flutterMode === 'debug') {
      void this.nativeRoutes.apply(p.sessionId, deviceId, record.port).catch((e: unknown) => this.log(`emulator proxy failed: ${String(e)}`));
    }
    if (record.lan) {
      this.lanLife.started(p.sessionId);
      if (!this.proxyHost.lan) {
        const msg = 'Flutter Intercept: the iPhone listener was closed before this session started, so its traffic is not intercepted. Relaunch the iPhone session.';
        this.log(msg);
        void this.notify('warning', msg);
      }
      return { intercepted: true };
    }
    if (record.host === 'localhost' && (record.deviceKind === 'android-device' || record.deviceKind === 'other')) void this.reverses.reverse(record.port, deviceId);
    return { intercepted: true };
  }

  private sessionEnded(p: SessionEndedParams): void {
    const id = p.sessionId;
    if (typeof id !== 'string') return;
    void this.nativeRoutes.release(id).catch((e: unknown) => this.log(`emulator proxy release failed: ${String(e)}`));
    this.lanLife.ended(id);
    void removeLanDefines(this.sessions.get(id)?.record.lanDefinesFile);
    if (this.webSessions.delete(id) && this.webSessions.size === 0) this.proxyHost.setWebSessionActive(false);
    this.vm.detach(id);
    this.proxyHost.setWarnings(id, []);
    if (!this.sessions.delete(id)) return;
    this.controller.setSessions(this.sessions.size);
    this.emitStatus();
    if (this.sessions.size === 0 && this.reverses.size > 0) {
      this.log('last intercepted session ended: removing adb reverses');
      void this.reverses.removeAll();
    }
  }

  // ------------------------------------------------------------------ shutdown

  /** Stops everything (proxy, servers, adb reverses, emulator proxies). Idempotent. */
  shutdown(): Promise<void> {
    this.shuttingDown ??= (async () => {
      if (!this.initialized) return;
      const steps = [
        ...this.disposers.splice(0).reverse(),
        () => this.mcp?.close(),
        () => this.proxyHost?.stop(),
        () => this.reverses?.removeAll(),
        () => this.state?.flush(),
      ];
      for (const s of steps) {
        try {
          await s();
        } catch (e) {
          this.log(`shutdown: ${(e as Error)?.message ?? e}`);
        }
      }
    })();
    return this.shuttingDown;
  }
}

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new RpcFailure(`${what}: no answer from the IDE within ${ms} ms`, 'timeout')), ms);
    p.then(
      (v) => (clearTimeout(t), resolve(v)),
      (e: unknown) => (clearTimeout(t), reject(e)),
    );
  });
}

/** Runs a tool with an argument array (no shell), stdout as bytes. */
function execTool(cmd: string, args: string[], opts?: { timeoutMs?: number; maxBuffer?: number }): Promise<{ stdout: Buffer; stderr: string }> {
  return new Promise((resolve, reject) =>
    execFile(cmd, args, { encoding: 'buffer', timeout: opts?.timeoutMs ?? 15_000, maxBuffer: opts?.maxBuffer ?? 32 * 1024 * 1024 }, (err, stdout, stderr) =>
      err ? reject(err) : resolve({ stdout, stderr: stderr.toString('utf8') }),
    ),
  );
}
