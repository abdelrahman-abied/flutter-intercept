/**
 * VS Code side of the MCP server (CONTRACTS §8): token in SecretStorage, lifecycle tied to the
 * `flutterIntercept.agent.*` settings, registration for VS Code's own MCP client, and the
 * `flutterIntercept.connectAgent` command.
 */
import * as vscode from 'vscode';
import type { AgentTools, ToolName } from '../types';
import { randomBytes } from 'crypto';
import { runConnectAgent } from './connectFlow';
import { CursorRegistrar, detectCursorMcp } from './cursor';
import { DEFAULT_MCP_PORT, generateToken, startMcpServer, type RunningMcpServer, type ToolSchema } from './server';

export const MCP_PROVIDER_ID = 'flutterIntercept.mcp';
export const CONNECT_AGENT_COMMAND = 'flutterIntercept.connectAgent';
export const TOKEN_KEY = 'flutterIntercept.agent.mcpToken';

export interface McpDeps {
  tools: AgentTools;
  schemas: Partial<Record<ToolName, ToolSchema>>;
  descriptions?: Partial<Record<ToolName, string>>;
  log: (message: string) => void;
  /** Extension version, reported to MCP clients. */
  version?: string;
}

export interface McpRegistration extends vscode.Disposable {
  /** `http://127.0.0.1:<port>/mcp` while the server runs (never contains the token). */
  readonly url: string | undefined;
  /** Live MCP client sessions. */
  readonly clients: number;
  /** Server started, stopped, moved, or a client session opened/closed. */
  readonly onDidChange: vscode.Event<void>;
}

// --- Typed shim for the MCP provider API (VS Code ≥ 1.101). engines stays ^1.90, so feature-detect.
interface McpHttpServerDefinitionShim {
  label: string;
  uri: vscode.Uri;
  headers: Record<string, string>;
  version?: string;
}
interface McpServerDefinitionProviderShim {
  onDidChangeMcpServerDefinitions?: vscode.Event<void>;
  provideMcpServerDefinitions(token: vscode.CancellationToken): McpHttpServerDefinitionShim[];
  resolveMcpServerDefinition?(server: McpHttpServerDefinitionShim, token: vscode.CancellationToken): Promise<McpHttpServerDefinitionShim | undefined>;
}
interface VscodeMcpShim {
  lm?: { registerMcpServerDefinitionProvider?(id: string, provider: McpServerDefinitionProviderShim): vscode.Disposable };
  McpHttpServerDefinition?: new (label: string, uri: vscode.Uri, headers?: Record<string, string>, version?: string) => McpHttpServerDefinitionShim;
}

async function getOrCreateToken(secrets: vscode.SecretStorage): Promise<string> {
  const existing = await secrets.get(TOKEN_KEY);
  if (existing && /^[A-Za-z0-9_-]{43}$/.test(existing)) return existing;
  const token = generateToken();
  await secrets.store(TOKEN_KEY, token);
  return token;
}

function agentConfig() {
  const c = vscode.workspace.getConfiguration('flutterIntercept.agent');
  const port = c.get<number>('mcpPort', DEFAULT_MCP_PORT);
  return {
    access: c.get<string>('access', 'readWrite'),
    port: Number.isInteger(port) && port > 0 && port < 65536 ? port : DEFAULT_MCP_PORT,
  };
}

export async function registerMcp(context: vscode.ExtensionContext, deps: McpDeps): Promise<McpRegistration> {
  const { log } = deps;
  const changed = new vscode.EventEmitter<void>();
  const definitionsChanged = new vscode.EventEmitter<void>();
  let server: RunningMcpServer | undefined;
  let serverPort: number | undefined; // the configured port the running server was started for
  let lastClients = 0;
  let disposed = false;
  let reconciling: Promise<void> = Promise.resolve();
  // Cursor zero-config (no-op in VS Code, where `vscode.cursor` doesn't exist).
  const cursorApi = detectCursorMcp(vscode);
  const cursor = new CursorRegistrar(cursorApi, log);
  const syncCursor = async () => {
    const s = server;
    if (!s) return cursor.sync(undefined);
    const token = await getOrCreateToken(context.secrets);
    await cursor.sync({
      token,
      issueUrl: () => s.issuePathToken(randomBytes(32).toString('base64url'))!,
      revoke: () => void s.issuePathToken(undefined),
    });
  };

  const stop = async () => {
    const s = server;
    server = undefined;
    serverPort = undefined;
    if (s) await s.close();
  };

  const reconcile = () =>
    (reconciling = reconciling.then(async () => {
      if (disposed) return;
      const cfg = agentConfig();
      const want = cfg.access !== 'off';
      if (server && (!want || serverPort !== cfg.port)) await stop();
      if (want && !server) {
        try {
          const token = await getOrCreateToken(context.secrets);
          server = await startMcpServer({
            port: cfg.port,
            token,
            tools: deps.tools,
            schemas: deps.schemas,
            descriptions: deps.descriptions,
            version: deps.version,
            log,
          });
          serverPort = cfg.port;
        } catch (e) {
          log(`MCP: not started: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
      await syncCursor();
      definitionsChanged.fire();
      changed.fire();
    }));

  // Client count changes are polled cheaply (sessions are tracked by the server).
  const poll = setInterval(() => {
    const n = server?.sessions ?? 0;
    if (n !== lastClients) {
      lastClients = n;
      changed.fire();
    }
  }, 2000);

  const disposables: vscode.Disposable[] = [changed, definitionsChanged, { dispose: () => clearInterval(poll) }];

  disposables.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('flutterIntercept.agent.access') || e.affectsConfiguration('flutterIntercept.agent.mcpPort')) {
        void reconcile();
      }
    }),
  );

  // VS Code's built-in MCP client (Copilot agent mode etc.). The token goes in only at resolve time,
  // so it never sits in VS Code's list of server definitions.
  const api = vscode as unknown as VscodeMcpShim;
  const Def = api.McpHttpServerDefinition;
  if (cursorApi) {
    // Inside Cursor its own registration API is used (above); don't list the server twice.
  } else if (api.lm?.registerMcpServerDefinitionProvider && Def) {
    try {
      disposables.push(
        api.lm.registerMcpServerDefinitionProvider(MCP_PROVIDER_ID, {
          onDidChangeMcpServerDefinitions: definitionsChanged.event,
          provideMcpServerDefinitions: () => (server ? [new Def('Flutter Intercept', vscode.Uri.parse(server.url), {}, deps.version)] : []),
          resolveMcpServerDefinition: async (def) => {
            if (!server) return undefined;
            const token = await getOrCreateToken(context.secrets);
            def.headers = { ...(def.headers ?? {}), Authorization: `Bearer ${token}` };
            return def;
          },
        }),
      );
    } catch (e) {
      log(`MCP: VS Code MCP registration unavailable: ${e instanceof Error ? e.message : String(e)}`);
    }
  } else {
    log('MCP: this VS Code has no MCP server provider API; connect clients with "Flutter Intercept: Connect AI Agent"');
  }

  disposables.push(
    vscode.commands.registerCommand(CONNECT_AGENT_COMMAND, async () => {
      await reconciling;
      if (!server) {
        const why = agentConfig().access === 'off' ? 'Agent access is off (setting flutterIntercept.agent.access).' : 'The MCP server is not running (see the Flutter Intercept output).';
        void vscode.window.showWarningMessage(`Flutter Intercept: ${why}`);
        return;
      }
      const token = await getOrCreateToken(context.secrets);
      await runConnectAgent(
        {
          pick: async (items) =>
            (await vscode.window.showQuickPick(items, { title: 'Connect an AI agent to Flutter Intercept', placeHolder: 'Which client?' }))?.client,
          copy: (text) => Promise.resolve(vscode.env.clipboard.writeText(text)),
          info: (message, ...buttons) => Promise.resolve(vscode.window.showInformationMessage(message, ...buttons)),
          error: async (message) => void (await vscode.window.showErrorMessage(message)),
        },
        { url: server.url, token, cursorAutoRegistered: cursor.isRegistered },
      );
    }),
  );

  await reconcile();

  const registration: McpRegistration = {
    get url() {
      return server?.url;
    },
    get clients() {
      return server?.sessions ?? 0;
    },
    onDidChange: changed.event,
    dispose() {
      disposed = true;
      void cursor.unregister().finally(() => stop());
      for (const d of disposables) d.dispose();
    },
  };
  context.subscriptions.push(registration);
  return registration;
}
