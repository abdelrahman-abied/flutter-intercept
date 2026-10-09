/**
 * Input schemas for every agent tool (CONTRACTS §8) — the ONE source for both front doors (MCP and
 * VS Code language model tools) and for package.json `languageModelTools` (unit-tested equal).
 */
import { z } from 'zod';
import { READ_TOOLS, ToolName, WRITE_TOOLS } from './types';

const url = z
  .string()
  .min(1)
  .max(8192)
  .describe('URL to match: a glob on the full URL where * matches any characters (e.g. "https://api.example.com/v1/users*"), or /regex/flags.');
const method = z
  .string()
  .regex(/^[A-Za-z]+$/, 'an HTTP method name such as GET or POST')
  .max(20)
  .describe('HTTP method (case-insensitive). Omit to match any method.');
const statusFilter = z
  .union([z.number().int().min(100).max(599), z.enum(['1xx', '2xx', '3xx', '4xx', '5xx', 'error'])])
  .describe('An exact status code, a class ("2xx".."5xx"), or "error" (failed/aborted exchanges).');
const sinceMs = z.number().int().min(0).describe('Only exchanges that started at or after this time (epoch milliseconds).');
const id = z.string().min(1).max(200);
const ruleName = z.string().max(200).describe('Optional label; it is shown as "[agent] <name>" in the rules list.');
const headerMap = z.record(z.string(), z.string());

export const EXCHANGE_STATES = ['pending', 'paused-request', 'paused-response', 'completed', 'mocked', 'blocked', 'aborted', 'error'] as const;

const editSchema = z
  .strictObject({
    method: method.optional(),
    url: z.string().optional().describe('Absolute http(s) URL (paused requests only).'),
    status: z.number().int().min(100).max(599).optional().describe('Status code (paused responses only).'),
    headers: z.record(z.string(), z.union([z.string(), z.array(z.string())])).optional().describe('Replaces the WHOLE header set.'),
    body: z.string().optional().describe('New decoded body text. Omit to keep the original body.'),
  })
  .describe('Changes to apply before resuming. Omit to resume unchanged.');

export const toolSchemas = {
  get_status: z.strictObject({}),
  list_requests: z.strictObject({
    url: url.optional(),
    method: method.optional(),
    status: statusFilter.optional(),
    state: z.enum(EXCHANGE_STATES).optional(),
    sinceMs: sinceMs.optional(),
    limit: z.number().int().min(1).max(200).default(50).describe('Max items (newest first), 1-200.'),
  }),
  get_request: z.strictObject({
    id,
    includeBodies: z.boolean().default(true),
    maxBodyChars: z.number().int().min(0).max(1_000_000).default(20_000).describe('Bodies longer than this are cut and marked truncated.'),
  }),
  wait_for_request: z.strictObject({
    url,
    method: method.optional(),
    status: statusFilter.optional(),
    sinceMs: z
      .union([sinceMs, z.literal('now')])
      .optional()
      .describe(
        'Only exchanges that started at or after this time (epoch ms), or "now" = when this call starts. Default: the start of the latest launch_app/hot_restart if it was within the last 120 s (so requests the app sent since then count), otherwise "now".',
      ),
    timeoutMs: z.number().int().min(0).max(120_000).default(30_000).describe('Give up after this long (max 120000) and return {timedOut: true}.'),
    includeBodies: z.boolean().default(false),
  }),
  list_paused: z.strictObject({}),
  list_rules: z.strictObject({}),
  add_mock: z.strictObject({
    url,
    method: method.optional(),
    status: z.number().int().min(100).max(599).default(200),
    headers: headerMap.optional().describe('Response headers. content-type defaults to application/json when body is an object.'),
    body: z.union([z.string(), z.record(z.string(), z.unknown()), z.array(z.unknown())]).describe('Response body: text, or a JSON object/array (sent as JSON).'),
    delayMs: z.number().int().min(0).max(600_000).optional(),
    name: ruleName.optional(),
  }),
  add_block: z.strictObject({
    url,
    method: method.optional(),
    mode: z.enum(['status', 'reset']).default('status').describe('"status" answers with `status`; "reset" drops the connection.'),
    status: z.number().int().min(100).max(599).default(403),
    name: ruleName.optional(),
  }),
  add_breakpoint: z.strictObject({
    url,
    method: method.optional(),
    phase: z.enum(['request', 'response', 'both']).default('response'),
    name: ruleName.optional(),
  }),
  remove_rule: z.strictObject({ ruleId: id }),
  resume_request: z.strictObject({ id, edit: editSchema.optional() }),
  abort_request: z.strictObject({ id }),
  clear_requests: z.strictObject({}),
  export_har: z.strictObject({ url: url.optional(), method: method.optional(), sinceMs: sinceMs.optional() }),
  launch_app: z.strictObject({
    deviceId: z.string().min(1).max(200).optional().describe('Flutter device id (e.g. "emulator-5554", a simulator UDID). Omit to use the device selected in VS Code.'),
    program: z.string().min(1).max(4096).optional().describe('Entry point, e.g. "lib/main_dev.dart". Omit for the default (lib/main.dart).'),
    flutterMode: z.enum(['debug', 'profile']).default('debug'),
  }),
  stop_app: z.strictObject({ sessionId: z.string().min(1).optional().describe('Omit to stop every intercepted session.') }),
  hot_restart: z.strictObject({ sessionId: z.string().min(1).optional().describe('Omit to hot-restart every intercepted session.') }),
} satisfies Record<ToolName, z.ZodType>;

export type ToolInput<T extends ToolName> = z.output<(typeof toolSchemas)[T]>;

/** How long after a launch_app/hot_restart wait_for_request still defaults to its start time. */
export const TRIGGER_WINDOW_MS = 120_000;

export const ALL_TOOLS: ToolName[] = [...READ_TOOLS, ...WRITE_TOOLS];

/** Parses input; throws `Error` with a readable message listing every problem. */
export function parseToolInput<T extends ToolName>(tool: T, input: unknown): ToolInput<T> {
  const r = toolSchemas[tool].safeParse(input ?? {});
  if (r.success) return r.data as ToolInput<T>;
  const msg = r.error.issues.map((i) => `${i.path.length ? i.path.join('.') : 'input'}: ${i.message}`).join('; ');
  throw new Error(`invalid input for ${tool}: ${msg}`);
}

/** JSON Schema (draft 2020-12 shape, input side: defaulted fields optional) for a tool's input. */
export function toolInputJsonSchema(tool: ToolName): Record<string, unknown> {
  const s = z.toJSONSchema(toolSchemas[tool], { io: 'input' }) as Record<string, unknown>;
  delete s.$schema;
  return s;
}

interface ToolDoc {
  title: string;
  /** For the model: what it does and when to use it. */
  model: string;
  /** For the user (tool picker / confirmation). */
  user: string;
}

export const TOOL_DOCS: Record<ToolName, ToolDoc> = {
  get_status: {
    title: 'Intercept status',
    model: 'Get Flutter Intercept status: whether the intercepting proxy runs, the running debug sessions (device, program), how many requests are recorded and paused, and the agent access level. Call this first to see whether an app is running before using the other tools.',
    user: 'Show proxy, session and traffic status.',
  },
  list_requests: {
    title: 'List HTTP requests',
    model: "List HTTP requests the running Flutter/Dart app made (newest first), recorded by Flutter Intercept's proxy. Filter by URL glob or /regex/, method, status (code, class like \"4xx\", or \"error\"), state or start time. Returns ids; call get_request for headers and bodies. Secrets are redacted.",
    user: 'List recorded HTTP requests.',
  },
  get_request: {
    title: 'Get HTTP request details',
    model: 'Get one recorded HTTP exchange by id: method, URL, status, request/response headers and decoded bodies (long bodies truncated, binary bodies summarised, secrets redacted), timings and error. Use after list_requests or wait_for_request.',
    user: 'Show one request with headers and bodies.',
  },
  wait_for_request: {
    title: 'Wait for an HTTP request',
    model: 'Wait until the app makes a request matching a URL glob (and optional method/status) and it completes, then return it. Use this right after triggering an action to verify the resulting network call. After hot_restart or launch_app you can call wait_for_request directly: requests sent since the restart/launch are included, even if they finished before this call. Otherwise only requests starting after this call count (pass sinceMs to choose). Returns the sinceMs it used, and {timedOut: true} after timeoutMs (default 30 s, max 120 s).',
    user: 'Wait for a matching request to complete.',
  },
  list_paused: {
    title: 'List paused requests',
    model: 'List exchanges currently paused by a breakpoint rule, with their phase (request or response) and the time they auto-resume. Resume or abort them with resume_request / abort_request.',
    user: 'List requests paused at a breakpoint.',
  },
  list_rules: {
    title: 'List intercept rules',
    model: 'List the active intercept rules (mocks, blocks, breakpoints) in priority order: the first enabled matching rule wins. Rules created by agents are named "[agent] ...".',
    user: 'List mock, block and breakpoint rules.',
  },
  export_har: {
    title: 'Export HAR',
    model: 'Export recorded exchanges (optionally filtered by URL, method, start time) as a HAR 1.2 file under the project\'s .dart_tool/flutter_intercept/exports/ and return its path. Secrets are redacted according to the user\'s setting.',
    user: 'Export recorded traffic to a HAR file.',
  },
  add_mock: {
    title: 'Add mock rule',
    model: "Make the app receive a fake response for matching requests (the real server is not contacted). Use it to test error states and edge cases (e.g. status 500, empty lists, slow responses via delayMs) without touching the backend. The rule is inserted first so it wins; remove it with remove_rule when done.",
    user: 'Add a rule that answers matching requests with a fake response.',
  },
  add_block: {
    title: 'Add block rule',
    model: 'Block matching requests: answer with a status (default 403) or reset the connection (mode "reset") to simulate a network failure. Inserted first; remove it with remove_rule when done.',
    user: 'Add a rule that blocks matching requests.',
  },
  add_breakpoint: {
    title: 'Add breakpoint rule',
    model: 'Pause matching requests before they are sent (phase "request") or their responses before the app gets them (phase "response", default). Paused exchanges appear in list_paused; continue them with resume_request (optionally edited) or abort_request. The app may time out if left paused.',
    user: 'Add a rule that pauses matching requests or responses.',
  },
  remove_rule: {
    title: 'Remove rule',
    model: 'Remove an intercept rule by id (see list_rules). Clean up the mocks, blocks and breakpoints you added once you are done.',
    user: 'Remove a rule.',
  },
  resume_request: {
    title: 'Resume paused request',
    model: 'Resume a paused exchange, optionally editing it first: for a paused request method/url/headers/body, for a paused response status/headers/body. headers replaces the whole header set; omit body to keep it.',
    user: 'Resume a paused request or response, optionally edited.',
  },
  abort_request: {
    title: 'Abort paused request',
    model: 'Abort a paused exchange: the app sees a connection reset.',
    user: 'Abort a paused request.',
  },
  clear_requests: {
    title: 'Clear recorded requests',
    model: 'Clear the recorded traffic list (in-flight and paused exchanges are kept). Useful before a step so that list_requests only shows what follows.',
    user: 'Clear the recorded traffic list.',
  },
  launch_app: {
    title: 'Launch Flutter app',
    model: 'Start the Flutter/Dart app in a normal VS Code debug session; Flutter Intercept routes its HTTP traffic through the proxy automatically. Optional deviceId (see get_status / the selected device), program (e.g. lib/main_dev.dart) and flutterMode (debug or profile). Returns {sessionId, sinceMs} once the session started; then call wait_for_request directly — requests the app sent since the launch are included.',
    user: 'Launch the app in a debug session with interception.',
  },
  stop_app: {
    title: 'Stop Flutter app',
    model: 'Stop an intercepted debug session (or all of them when sessionId is omitted).',
    user: 'Stop the app debug session(s).',
  },
  hot_restart: {
    title: 'Hot restart Flutter app',
    model: 'Hot-restart the running app (or all intercepted sessions) so it starts over with the current code and rules; interception stays on. Returns {restarted, sinceMs}. Then call wait_for_request directly to verify the network calls made at startup: requests sent since the restart are included, even ones that finished before wait_for_request was called.',
    user: 'Hot restart the running app.',
  },
};

export const LM_TOOL_PREFIX = 'flutter_intercept_';

function pascal(tool: string): string {
  return tool.replace(/(^|_)([a-z])/g, (_m, _s, c: string) => c.toUpperCase());
}

export interface LanguageModelToolContribution {
  name: string;
  displayName: string;
  toolReferenceName: string;
  canBeReferencedInPrompt: true;
  userDescription: string;
  modelDescription: string;
  inputSchema: Record<string, unknown>;
  tags: string[];
}

/** The exact `contributes.languageModelTools` array for package.json. */
export function languageModelToolsContribution(): LanguageModelToolContribution[] {
  return ALL_TOOLS.map((tool) => ({
    name: `${LM_TOOL_PREFIX}${tool}`,
    displayName: `Flutter Intercept: ${TOOL_DOCS[tool].title}`,
    toolReferenceName: `intercept${pascal(tool)}`,
    canBeReferencedInPrompt: true as const,
    userDescription: TOOL_DOCS[tool].user,
    modelDescription: TOOL_DOCS[tool].model,
    inputSchema: toolInputJsonSchema(tool),
    tags: ['flutter', 'http', 'network', 'flutter-intercept'],
  }));
}

/** Model-facing description per tool (for the MCP server's tool list; same text as the LM tools). */
export function toolDescriptions(): Record<ToolName, string> {
  return Object.fromEntries(ALL_TOOLS.map((t) => [t, TOOL_DOCS[t].model])) as Record<ToolName, string>;
}

/** JSON Schema per tool (for front doors that take JSON Schema rather than zod). */
export function toolJsonSchemas(): Record<ToolName, Record<string, unknown>> {
  return Object.fromEntries(ALL_TOOLS.map((t) => [t, toolInputJsonSchema(t)])) as Record<ToolName, Record<string, unknown>>;
}
