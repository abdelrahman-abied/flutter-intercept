/**
 * VS Code Language Model Tools front door (CONTRACTS §8): registers `flutter_intercept_<tool>` for every
 * Agent API tool and only translates — `AgentTools.call` does the work.
 *
 * Engines stay ^1.90, whose typings predate the LM tools API: the API is feature-detected at runtime
 * (`vscode.lm.registerTool`) and typed with the minimal shim below.
 */
import { AgentToolError, AgentTools, isWriteTool, READ_TOOLS, ToolName, ToolResult, WRITE_TOOLS } from './types';

export const LM_TOOL_PREFIX = 'flutter_intercept_';
export const ALL_TOOLS: readonly ToolName[] = [...READ_TOOLS, ...WRITE_TOOLS];
export const lmToolName = (tool: ToolName) => `${LM_TOOL_PREFIX}${tool}`;

// ---- minimal typed shim of the LM tools API (VS Code ≥ 1.95) ----
interface CancellationTokenLike {
  isCancellationRequested: boolean;
  onCancellationRequested(l: () => void): { dispose(): unknown };
}
export interface ToolInvocationOptions {
  input: unknown;
}
export interface PreparedInvocation {
  invocationMessage?: string;
  confirmationMessages?: { title: string; message: unknown };
}
export interface LmTool {
  invoke(options: ToolInvocationOptions, token: CancellationTokenLike): Promise<unknown>;
  prepareInvocation(options: ToolInvocationOptions, token: CancellationTokenLike): Promise<PreparedInvocation | undefined>;
}
export interface LmVscode {
  lm?: { registerTool?: (name: string, tool: LmTool) => { dispose(): unknown } };
  LanguageModelToolResult?: new (content: unknown[]) => unknown;
  LanguageModelTextPart?: new (value: string) => unknown;
  MarkdownString: new (value?: string) => unknown;
}

/** One entry of package.json `contributes.languageModelTools` (only `name` matters here). */
export interface LmToolContribution {
  name: string;
  [k: string]: unknown;
}

export interface LmToolsDeps {
  tools: AgentTools;
  /** The package.json `languageModelTools` entries (B's `languageModelToolsContribution()`); VS Code only accepts declared tools. */
  contribution?: readonly LmToolContribution[];
  vscode?: LmVscode;
  log?: (msg: string) => void;
}

export interface LmToolsRegistration {
  /** LM tool names actually registered (empty when the host has no LM tools API). */
  registered: string[];
  dispose(): void;
}

/** Compact but readable JSON: indented when small, single-line when large. */
export function formatResult(result: unknown): string {
  const pretty = JSON.stringify(result, null, 2) ?? 'null';
  return pretty.length <= 4000 ? pretty : JSON.stringify(result);
}

function toAbortSignal(token: CancellationTokenLike | undefined): { signal: AbortSignal; dispose(): void } {
  const ctl = new AbortController();
  if (!token) return { signal: ctl.signal, dispose: () => undefined };
  if (token.isCancellationRequested) ctl.abort();
  const sub = token.onCancellationRequested(() => ctl.abort());
  return { signal: ctl.signal, dispose: () => sub.dispose() };
}

const obj = (input: unknown): Record<string, unknown> => (input && typeof input === 'object' && !Array.isArray(input) ? (input as Record<string, unknown>) : {});
const str = (v: unknown) => (typeof v === 'string' && v ? v : undefined);
/** Inline code for MarkdownString (no backticks / newlines can break out). */
const code = (v: unknown) => '`' + String(v).replace(/[`\r\n]/g, ' ').slice(0, 300) + '`';
const methodOf = (i: Record<string, unknown>) => (str(i.method) ? String(i.method).toUpperCase() : 'any method');
const target = (i: Record<string, unknown>) => `${methodOf(i)} ${code(i.url ?? '*')}`;

/** Short status line shown while the tool runs. */
export function invocationMessage(tool: ToolName, input: unknown): string {
  const i = obj(input);
  const plain = (v: unknown) => String(v ?? '*').replace(/[\r\n]/g, ' ').slice(0, 200);
  const m = str(i.method) ? `${String(i.method).toUpperCase()} ` : '';
  switch (tool) {
    case 'get_status':
      return 'Reading Flutter Intercept status';
    case 'list_requests':
      return i.url || i.method || i.status ? `Listing captured requests matching ${m}${plain(i.url)}${i.status ? ` (${i.status})` : ''}` : 'Listing captured requests';
    case 'get_request':
      return `Reading request ${plain(i.id)}`;
    case 'wait_for_request': {
      const secs = Math.round(Math.min(Number(i.timeoutMs ?? 30_000) || 30_000, 120_000) / 1000);
      return `Waiting for ${m}${plain(i.url)}${i.status ? ` → ${i.status}` : ''} (up to ${secs} s)`;
    }
    case 'list_paused':
      return 'Listing paused requests';
    case 'list_rules':
      return 'Listing interception rules';
    case 'export_har':
      return `Exporting captured traffic as HAR${i.url ? ` (${m}${plain(i.url)})` : ''}`;
    case 'add_mock':
      return `Adding mock ${m}${plain(i.url)} → ${i.status ?? 200}`;
    case 'add_block':
      return `Adding block rule for ${m}${plain(i.url)}`;
    case 'add_breakpoint':
      return `Adding breakpoint on ${m}${plain(i.url)}`;
    case 'remove_rule':
      return `Removing rule ${plain(i.ruleId)}`;
    case 'resume_request':
      return `Resuming request ${plain(i.id)}`;
    case 'abort_request':
      return `Aborting request ${plain(i.id)}`;
    case 'clear_requests':
      return 'Clearing captured requests';
    case 'launch_app':
      return `Launching the app${i.deviceId ? ` on ${plain(i.deviceId)}` : ''} through Flutter Intercept`;
    case 'stop_app':
      return i.sessionId ? `Stopping session ${plain(i.sessionId)}` : 'Stopping intercepted debug sessions';
    case 'hot_restart':
      return i.sessionId ? `Hot restarting session ${plain(i.sessionId)}` : 'Hot restarting intercepted debug sessions';
  }
}

function bodySummary(body: unknown): string {
  if (body === undefined) return 'empty body';
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  return `body ${text.length} chars${typeof body === 'string' ? '' : ' (JSON)'}`;
}

/** Exactly what a write tool will change, for the confirmation dialog (markdown). */
export function confirmationText(tool: ToolName, input: unknown, ruleName?: string): { title: string; message: string } {
  const i = obj(input);
  const named = str(i.name) ? ` named ${code('[agent] ' + String(i.name))}` : '';
  switch (tool) {
    case 'add_mock':
      return {
        title: 'Add a mock rule',
        message:
          `Mock ${target(i)} → **${i.status ?? 200}** (${bodySummary(i.body)}${i.headers ? ', custom headers' : ''}${i.delayMs ? `, ${i.delayMs} ms delay` : ''})${named}.\n\n` +
          'Inserted as the first rule: matching requests from the app get this response and never reach the server.',
      };
    case 'add_block':
      return {
        title: 'Add a block rule',
        message: `Block ${target(i)}: ${i.mode === 'reset' ? 'the connection is reset' : `the app gets **${i.status ?? 403}**`}${named}. The server is never contacted.`,
      };
    case 'add_breakpoint':
      return {
        title: 'Add a breakpoint rule',
        message: `Pause ${target(i)} at the **${i.phase ?? 'response'}** phase${named}. Matching requests wait (up to the breakpoint timeout) until resumed or aborted.`,
      };
    case 'remove_rule':
      return { title: 'Remove a rule', message: `Remove rule ${code(i.ruleId)}${ruleName ? ` (${code(ruleName)})` : ''}.` };
    case 'resume_request': {
      const e = obj(i.edit);
      const parts = [
        e.method && `method ${code(e.method)}`,
        e.url && `URL ${code(e.url)}`,
        e.status !== undefined && `status **${e.status}**`,
        e.headers && 'headers replaced',
        e.body !== undefined && `body (${String(e.body).length} chars)`,
      ].filter(Boolean);
      return { title: 'Resume a paused request', message: `Resume paused request ${code(i.id)}${parts.length ? ` with edits: ${parts.join(', ')}` : ' unchanged'}.` };
    }
    case 'abort_request':
      return { title: 'Abort a paused request', message: `Abort paused request ${code(i.id)}: the app sees a connection reset.` };
    case 'clear_requests':
      return { title: 'Clear captured requests', message: 'Remove every captured request from the Flutter Intercept traffic list. Rules are kept.' };
    case 'launch_app':
      return {
        title: 'Launch the app',
        message:
          `Start a debug session for ${i.program ? code(i.program) : 'the Flutter project'} on ${i.deviceId ? code(i.deviceId) : 'the selected device'} ` +
          `in **${i.flutterMode ?? 'debug'}** mode, with its HTTP traffic routed through Flutter Intercept.`,
      };
    case 'stop_app':
      return { title: 'Stop the app', message: i.sessionId ? `Stop debug session ${code(i.sessionId)}.` : 'Stop **every** intercepted debug session.' };
    case 'hot_restart':
      return {
        title: 'Hot restart the app',
        message: `Hot restart ${i.sessionId ? `session ${code(i.sessionId)}` : '**every** intercepted debug session'}: the app restarts from \`main()\` and loses its state.`,
      };
    default:
      return { title: 'Flutter Intercept', message: invocationMessage(tool, input) };
  }
}

/** Builds the LM tool object for one Agent API tool. */
export function makeLmTool(tool: ToolName, deps: LmToolsDeps & { vscode: LmVscode }): LmTool {
  const vs = deps.vscode;
  const textResult = (text: string) =>
    vs.LanguageModelToolResult && vs.LanguageModelTextPart ? new vs.LanguageModelToolResult([new vs.LanguageModelTextPart(text)]) : { content: [{ value: text }] };
  return {
    async prepareInvocation(options) {
      const prepared: PreparedInvocation = { invocationMessage: invocationMessage(tool, options?.input) };
      if (isWriteTool(tool) && deps.tools.access === 'readWrite') {
        let ruleName: string | undefined;
        if (tool === 'remove_rule') {
          try {
            const rules = ((await deps.tools.call('list_rules', {})) as { rules?: { id: string; name?: string }[] }).rules ?? [];
            ruleName = rules.find((r) => r.id === obj(options?.input).ruleId)?.name;
          } catch {
            // describe by id only
          }
        }
        const { title, message } = confirmationText(tool, options?.input, ruleName);
        prepared.confirmationMessages = { title, message: new vs.MarkdownString(message) };
      }
      return prepared;
    },
    async invoke(options, token) {
      const abort = toAbortSignal(token);
      try {
        if (deps.tools.access === 'off') throw new AgentToolError('Flutter Intercept agent access is off (setting flutterIntercept.agent.access).', 'access');
        const result: ToolResult = await deps.tools.call(tool, obj(options?.input), abort.signal);
        return textResult(formatResult(result));
      } catch (e) {
        // A thrown Error is how VS Code reports a failed tool call to the model; never let a non-Error escape.
        const err = e instanceof AgentToolError ? e : new AgentToolError((e as Error)?.message ?? String(e), 'internal');
        deps.log?.(`lm tool ${tool} failed (${err.code}): ${err.message}`);
        throw new Error(`${err.code}: ${err.message}`);
      } finally {
        abort.dispose();
      }
    },
  };
}

/**
 * Registers every Agent API tool as `flutter_intercept_<tool>`. No-op (registered: []) on hosts without
 * `vscode.lm.registerTool`. With `contribution`, only declared names are registered (VS Code rejects
 * undeclared tools); mismatches are logged.
 */
export function registerLmTools(context: { subscriptions: { dispose(): unknown }[] }, deps: LmToolsDeps): LmToolsRegistration {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const vs: LmVscode = deps.vscode ?? (require('vscode') as LmVscode);
  const log = deps.log ?? (() => undefined);
  const disposables: { dispose(): unknown }[] = [];
  const registered: string[] = [];
  const register = vs.lm?.registerTool;
  if (typeof register !== 'function') {
    log('language model tools API not available in this VS Code: agent tools are only reachable over MCP');
    return { registered, dispose: () => undefined };
  }
  const declared = deps.contribution ? new Set(deps.contribution.map((c) => c.name)) : undefined;
  if (declared) {
    const ours = new Set(ALL_TOOLS.map(lmToolName));
    const extra = [...declared].filter((n) => n.startsWith(LM_TOOL_PREFIX) && !ours.has(n));
    if (extra.length) log(`languageModelTools declares unknown tools: ${extra.join(', ')}`);
  }
  for (const tool of ALL_TOOLS) {
    const name = lmToolName(tool);
    if (declared && !declared.has(name)) {
      log(`not registering ${name}: missing from package.json languageModelTools`);
      continue;
    }
    try {
      disposables.push(register.call(vs.lm, name, makeLmTool(tool, { ...deps, vscode: vs })));
      registered.push(name);
    } catch (e) {
      log(`registerTool(${name}) failed: ${(e as Error)?.message ?? e}`);
    }
  }
  const registration: LmToolsRegistration = {
    registered,
    dispose: () => {
      for (const d of disposables.splice(0)) d.dispose();
    },
  };
  context.subscriptions.push(registration);
  return registration;
}
