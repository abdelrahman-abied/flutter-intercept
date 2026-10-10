/**
 * VS Code Language Model Tools front door (CONTRACTS §8): registers `flutter_intercept_<tool>` for every
 * Agent API tool and only translates — `AgentTools.call` does the work.
 *
 * Engines stay ^1.90, whose typings predate the LM tools API: the API is feature-detected at runtime
 * (`vscode.lm.registerTool`) and typed with the minimal shim below.
 */
import { corsPolicyText } from './corsPolicy';
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
  readonly name: string;
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
const target = (i: Record<string, unknown>) => `${methodOf(i)} ${code(i.url ?? '*')}${str(i.graphqlOperation) ? ` (GraphQL operation ${code(i.graphqlOperation)})` : ''}`;

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
    case 'get_request_source':
      return `Finding the code that sent request ${plain(i.id)}`;
    case 'get_body_shape':
      return `Reading the ${i.which === 'request' ? 'request' : 'response'} body structure of ${plain(i.id)}`;
    case 'simulate_network':
      return i.url
        ? `Simulating ${i.fault ? `a ${plain(i.fault)} fault` : plain(i.profile)} for ${m}${plain(i.url)}`
        : `Setting the network profile to ${plain(i.profile)}`;
    case 'resend_request':
      return `Resending request ${plain(i.id)}`;
    case 'check_contract':
      return i.id ? `Checking request ${plain(i.id)} against the Dart models` : `Checking ${i.url ? `${m}${plain(i.url)}` : 'recent JSON responses'} against the Dart models`;
    case 'generate_model':
      return `Generating Dart models from ${i.id ? `request ${plain(i.id)}` : `${m}${plain(i.url)}`} and its route's samples`;
    case 'generate_fixture_test':
      return `Generating a fixture test from ${Array.isArray(i.ids) ? `${i.ids.length} request(s)` : plain(i.url)}`;
    case 'assert_traffic':
      return `Checking traffic for ${m}${plain(i.url)}${Number(i.withinMs) > 0 ? ` (waiting up to ${Math.round(Math.min(Number(i.withinMs), 120_000) / 1000)} s)` : ''}`;
    case 'add_mutation':
      return `Adding response mutation for ${m}${plain(i.url)}`;
    case 'get_frames':
      return `Reading the frames of ${plain(i.id)}${typeof i.since === 'number' ? ` from #${i.since}` : ''}`;
    case 'add_cors_rule':
      return `Adding a development-only CORS rule for ${m}${plain(i.url)}`;
    // CONTRACTS §12.7
    case 'list_recordings':
      return 'Listing traffic recordings';
    case 'diff_recordings':
      return `Comparing recordings ${plain(i.a)} and ${plain(i.b)}`;
    case 'get_auth_flows':
      return 'Analysing token refresh flows';
    case 'save_recording':
      return `Saving ${i.url ? `${plain(i.url)} traffic` : 'the recorded traffic'} as "${plain(i.name)}"`;
    case 'replay_recording':
      return i.id ? `Replaying recording ${plain(i.id)}` : 'Stopping replay';
    case 'add_sequence':
      return `Adding a ${Array.isArray(i.steps) ? `${i.steps.length}-step ` : ''}scenario for ${m}${plain(i.url)}`;
    case 'expire_token':
      return `Expiring the token for ${plain(i.url)}`;
    case 'add_map_remote':
      return `Mapping ${m}${plain(i.url)} to ${plain(i.to)}`;
    case 'add_rewrite':
      return `Adding a rewrite rule for ${m}${plain(i.url)}`;
  }
}

/** "500 ×2, then the real server" for add_sequence's steps. */
function stepsText(steps: unknown, then: unknown): string {
  if (!Array.isArray(steps) || !steps.length) return 'no steps';
  const one = (raw: unknown): string => {
    const st = obj(raw);
    const n = typeof st.count === 'number' && st.count > 1 ? ` ×${st.count}` : '';
    switch (st.kind) {
      case 'mock':
        return `mock **${st.status ?? 200}**${n}`;
      case 'block':
        return `${st.mode === 'reset' ? 'connection reset' : `block **${st.status ?? 403}**`}${n}`;
      case 'fault':
        return `${code(st.fault ?? '?')} fault${n}`;
      case 'throttle':
        return `throttled${n}`;
      case 'passthrough':
        return `the real server${n}`;
      default:
        return code(st.kind ?? '?');
    }
  };
  const parts = steps.slice(0, 8).map(one);
  const more = steps.length > 8 ? `, and ${steps.length - 8} more step(s)` : '';
  const after = then === 'loop' ? '; then it starts over' : then === 'passthrough' ? '; then the real server answers' : '; the last step keeps answering';
  return `${parts.join(', then ')}${more}${after}`;
}

/** What a rewrite changes, for the confirmation (header names, never values beyond 60 chars). */
function rewriteText(side: string, spec: unknown): string | undefined {
  const r = obj(spec);
  const parts: string[] = [];
  if (r.status !== undefined) parts.push(`status → **${r.status}**`);
  const set = obj(r.setHeaders);
  const names = Object.keys(set);
  if (names.length) parts.push(`set ${names.slice(0, 6).map((k) => `${code(k)}: ${code(String(set[k]).length > 60 ? `${String(set[k]).slice(0, 60)}…` : set[k])}`).join(', ')}${names.length > 6 ? ` and ${names.length - 6} more` : ''}`);
  if (Array.isArray(r.removeHeaders) && r.removeHeaders.length) parts.push(`remove ${r.removeHeaders.slice(0, 6).map(code).join(', ')}${r.removeHeaders.length > 6 ? ' …' : ''}`);
  if (Array.isArray(r.replaceBody) && r.replaceBody.length) parts.push(`${r.replaceBody.length} body text replacement(s)`);
  return parts.length ? `${side}: ${parts.join('; ')}` : undefined;
}

/** "null `$.a`, set `$.b`" for a mutation's ops. */
function opsText(ops: unknown): string {
  if (!Array.isArray(ops) || !ops.length) return 'no changes';
  const parts = ops.slice(0, 5).map((o) => {
    const op = obj(o);
    const p = code(op.path ?? '?');
    if (op.op === 'null') return `set ${p} to **null**`;
    if (op.op === 'delete') return `**remove** ${p}`;
    if (op.op === 'set') {
      const v = typeof op.valueJson === 'string' ? op.valueJson : (JSON.stringify(op.value) ?? 'undefined');
      return `set ${p} to ${code(v.length > 60 ? `${v.slice(0, 60)}…` : v)}`;
    }
    return code(op.op ?? '?');
  });
  return parts.join(', ') + (ops.length > 5 ? ` and ${ops.length - 5} more` : '');
}

/** Human text for a simulate_network profile / fault. */
function simulationText(i: Record<string, unknown>): string {
  if (i.fault) {
    const f = String(i.fault);
    return f === 'reset' ? 'a connection reset' : f === 'timeout' ? 'a timeout (no answer)' : f === 'truncate' ? 'a truncated response' : f === 'dns' ? 'a DNS failure' : code(f);
  }
  switch (i.profile) {
    case 'slow-3g':
      return '**Slow 3G** (+400 ms, 400 kbps)';
    case 'fast-3g':
      return '**Fast 3G** (+150 ms, 1600 kbps)';
    case 'flaky':
      return '**Flaky** (+200 ms, 20% of requests fail)';
    case 'offline':
      return '**offline** (every request fails)';
    case 'none':
      return '**normal** speed (no throttling)';
    case 'custom': {
      const parts = [i.latencyMs !== undefined && `+${Number(i.latencyMs)} ms`, i.kbps !== undefined && `${Number(i.kbps)} kbps`, i.dropRate !== undefined && `${Math.round(Number(i.dropRate) * 100)}% fail`].filter(Boolean);
      return `**custom** (${parts.join(', ') || 'no change'})`;
    }
    default:
      return code(i.profile ?? '?');
  }
}

/** ", only the next N requests" / ", for N s" suffix for rules with times / ttlMs. */
function spendText(i: Record<string, unknown>): string {
  const parts: string[] = [];
  if (typeof i.times === 'number') parts.push(i.times === 1 ? 'only the next matching request' : `the next ${i.times} matching requests`);
  if (typeof i.ttlMs === 'number') parts.push(`for ${Math.round(i.ttlMs / 1000)} s`);
  return parts.length ? ` (${parts.join(', ')}; then removed automatically)` : '';
}

function bodySummary(body: unknown): string {
  if (body === undefined) return 'empty body';
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  return `body ${text.length} chars${typeof body === 'string' ? '' : ' (JSON)'}`;
}

/** Exactly what a write tool will change, for the confirmation dialog (markdown). */
export function confirmationText(tool: ToolName, input: unknown, ruleName?: string, request?: { method: string; url: string }): { title: string; message: string } {
  const i = obj(input);
  const named = str(i.name) ? ` named ${code('[agent] ' + String(i.name))}` : '';
  switch (tool) {
    case 'add_mock':
      return {
        title: 'Add a mock rule',
        message:
          `Mock ${target(i)} → **${i.status ?? 200}** (${bodySummary(i.body)}${i.headers ? ', custom headers' : ''}${i.delayMs ? `, ${i.delayMs} ms delay` : ''})${named}${spendText(i)}.\n\n` +
          'Inserted as the first rule: matching requests from the app get this response and never reach the server.',
      };
    case 'add_block':
      return {
        title: 'Add a block rule',
        message: `Block ${target(i)}: ${i.mode === 'reset' ? 'the connection is reset' : `the app gets **${i.status ?? 403}**`}${named}${spendText(i)}. The server is never contacted.`,
      };
    case 'add_breakpoint':
      return {
        title: 'Add a breakpoint rule',
        message: `Pause ${target(i)} at the **${i.phase ?? 'response'}** phase${named}${spendText(i)}. Matching requests wait (up to the breakpoint timeout) until resumed or aborted.`,
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
    case 'simulate_network':
      return i.url
        ? {
            title: 'Simulate network conditions',
            message: `Give ${target(i)} ${simulationText(i)}${named}${spendText(i)}. Inserted as the first rule.`,
          }
        : {
            title: 'Simulate network conditions',
            message: `Set **all** of the app's traffic to ${simulationText(i)} until changed.`,
          };
    case 'resend_request': {
      const e = obj(i.edit);
      const parts = [e.headers && 'headers replaced', e.body !== undefined && `body (${String(e.body).length} chars)`].filter(Boolean);
      const extra = parts.length ? ` Also edited: ${parts.join(', ')}.` : '';
      if (!request) {
        return { title: 'Resend a request', message: `Resend recorded request ${code(i.id)} to the real server with its original credentials (the request was not found, so the call will fail).${extra}` };
      }
      const method = (str(e.method) ?? request.method).toUpperCase();
      let target: string;
      let note = '';
      try {
        const orig = new URL(request.url);
        const u = new URL(str(e.url) ?? request.url);
        target = `${u.origin}${u.pathname}`;
        if (u.origin !== orig.origin) note = ` This changes the origin from ${code(orig.origin)}, so the call will be refused.`;
      } catch {
        target = String(e.url ?? request.url);
      }
      return {
        title: 'Resend a request',
        message: `Send **${method}** ${code(target)} (recorded request ${code(i.id)}) again to the real server, with the original request's credentials.${extra}${note}`,
      };
    }
    case 'add_mutation':
      return {
        title: 'Add a response mutation rule',
        message:
          `For ${target(i)}: forward to the real server, then ${opsText(i.ops)} in the JSON response before the app gets it${named}${spendText(i)}.\n\n` +
          'Inserted as the first rule.',
      };
    case 'add_cors_rule': {
      const origin = str(i.allowOrigin);
      return {
        title: 'Add a CORS rule (development only)',
        message:
          `For ${target(i)}: answer the browser's CORS preflight locally and add CORS headers to the real responses${named}${spendText(i)}.\n\n` +
          `${corsPolicyText(origin ? code(origin) : undefined, origin, i.allowCredentials === true)}\n\n` +
          "Development only: the real server's CORS policy is **not** changed, so the same requests still fail without Flutter Intercept. Inserted as the first rule.",
      };
    }
    // CONTRACTS §12.7: confirmations name the targets.
    case 'save_recording':
      return {
        title: 'Save a traffic recording',
        message:
          `Save ${i.url ? `the finished requests matching ${code(i.url)}` : 'every finished HTTP request'}${typeof i.sinceMs === 'number' ? ` since ${new Date(i.sinceMs).toISOString()}` : ''} as recording ${code(i.name ?? '?')} ` +
          `in the project's \`.dart_tool/flutter_intercept/recordings/\`${i.redact === false ? ', **with secrets unredacted** (real tokens and cookies are written to the file)' : ' (secrets redacted)'}.`,
      };
    case 'replay_recording':
      return i.id
        ? {
            title: 'Replay a recording',
            message: `Answer the app's requests from recording ${code(i.id)} instead of the real server. Requests it has no answer for ${i.fallback === 'fail' ? '**fail like offline**' : 'go to the real server'}. Until replay is stopped.`,
          }
        : { title: 'Stop replaying', message: 'Stop answering requests from a recording: the real server answers again.' };
    case 'add_sequence':
      return {
        title: 'Add a scenario rule',
        message: `For ${target(i)}, successive requests get: ${stepsText(i.steps, i.then)}${named}.\n\nInserted as the first rule.`,
      };
    case 'expire_token':
      return {
        title: 'Expire the auth token',
        message: `The next **${typeof i.count === 'number' ? i.count : 1}** request(s) matching ${code(i.url ?? '*')} get **401** \`{"error":"token_expired"}\`; then the real server answers again. Inserted as the first rule.`,
      };
    case 'add_map_remote':
      return {
        title: 'Map requests to a local server',
        message:
          `Send ${target(i)} to ${code(i.to ?? '?')} instead of the real server${named}. ` +
          'The requests keep their headers, **including credentials** (Authorization, cookies), so only map to a local server you trust. Inserted as the first rule.',
      };
    case 'add_rewrite': {
      const parts = [rewriteText('Request', i.request), rewriteText('Response', i.response)].filter(Boolean);
      return {
        title: 'Add a rewrite rule',
        message: `For ${target(i)}: forward to the real server, but change ${parts.length ? parts.join('. ') : 'nothing'}${named}${spendText(i)}.\n\nInserted as the first rule.`,
      };
    }
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
        let request: { method: string; url: string } | undefined;
        if (tool === 'resend_request') {
          try {
            const r = (await deps.tools.call('get_request', { id: obj(options?.input).id, includeBodies: false })) as { method?: unknown; url?: unknown };
            if (typeof r.method === 'string' && typeof r.url === 'string') request = { method: r.method, url: r.url };
          } catch {
            // describe by id only
          }
        }
        const { title, message } = confirmationText(tool, options?.input, ruleName, request);
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
