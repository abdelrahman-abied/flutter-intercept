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
const times = z
  .number()
  .int()
  .min(1)
  .max(1000)
  .describe('Apply the rule to the first N matching requests only (1-1000); it is then removed automatically.');
const ttlMs = z
  .number()
  .int()
  .min(1000)
  .max(86_400_000)
  .describe('Remove the rule automatically after this many milliseconds (1000-86400000).');
export const SNIPPET_FORMATS = ['curl', 'dart_http', 'dio'] as const;
export const NETWORK_PROFILES = ['none', 'offline', 'slow-3g', 'fast-3g', 'flaky', 'custom'] as const;
export const FAULT_KINDS = ['reset', 'timeout', 'truncate', 'dns'] as const;

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

const requestEditSchema = z
  .strictObject({
    method: method.optional(),
    url: z.string().max(8192).optional().describe('Absolute http(s) URL with the SAME origin (scheme, host, port) as the recorded request; only path and query may change.'),
    headers: z
      .record(z.string(), z.union([z.string(), z.array(z.string())]))
      .optional()
      .describe('Replaces the WHOLE header set. A value of "[redacted]" is replaced by the original value of that header.'),
    body: z.string().optional().describe('New body text. Omit to keep the original body.'),
  })
  .describe('Changes to the recorded request. Omit to send it unchanged.');

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
    snippet: z
      .enum(SNIPPET_FORMATS)
      .optional()
      .describe('Also return the request as code: "curl", "dart_http" (package:http) or "dio". Built from the redacted view.'),
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
    times: times.optional(),
    ttlMs: ttlMs.optional(),
  }),
  add_block: z.strictObject({
    url,
    method: method.optional(),
    mode: z.enum(['status', 'reset']).default('status').describe('"status" answers with `status`; "reset" drops the connection.'),
    status: z.number().int().min(100).max(599).default(403),
    name: ruleName.optional(),
    times: times.optional(),
    ttlMs: ttlMs.optional(),
  }),
  add_breakpoint: z.strictObject({
    url,
    method: method.optional(),
    phase: z.enum(['request', 'response', 'both']).default('response'),
    name: ruleName.optional(),
    times: times.optional(),
    ttlMs: ttlMs.optional(),
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
  get_request_source: z.strictObject({
    id,
    maxFrames: z.number().int().min(1).max(30).default(20).describe('Max stack frames to return (1-30).'),
  }),
  get_body_shape: z.strictObject({
    id,
    which: z.enum(['response', 'request']).default('response').describe('Which body to describe.'),
    maxDepth: z.number().int().min(1).max(12).default(6).describe('Nesting depth to describe (1-12); deeper structure shows as "{…}" / "[…]".'),
  }),
  simulate_network: z.strictObject({
    profile: z
      .enum(NETWORK_PROFILES)
      .optional()
      .describe(
        '"slow-3g" (+400 ms, 400 kbps), "fast-3g" (+150 ms, 1600 kbps), "flaky" (+200 ms, 20% of requests fail), "offline" (every request fails), "custom" (use latencyMs/kbps/dropRate), "none" (restore). Required unless `fault` is given.',
      ),
    latencyMs: z.number().int().min(0).max(600_000).optional().describe('custom: added latency per request, ms.'),
    kbps: z.number().min(1).max(10_000_000).optional().describe('custom: response bandwidth, kilobits per second.'),
    dropRate: z.number().min(0).max(1).optional().describe('custom: share of requests that fail (0-1).'),
    url: url.optional().describe('Only affect requests matching this URL glob or /regex/ (adds a rule, inserted first). Omit to set the profile for ALL app traffic.'),
    method: method.optional(),
    fault: z
      .enum(FAULT_KINDS)
      .optional()
      .describe('With url: make matching requests fail instead of slowing them: "reset" (connection reset), "timeout" (no answer until the client gives up), "truncate" (response cut mid-body), "dns" (lookup failure).'),
    times: times.optional(),
    ttlMs: ttlMs.optional(),
    name: ruleName.optional(),
  }),
  resend_request: z.strictObject({ id, edit: requestEditSchema.optional() }),
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
    model: 'Get one recorded HTTP exchange by id: method, URL, status, request/response headers and decoded bodies (long bodies truncated, binary bodies summarised, secrets redacted), timings and error. Use after list_requests or wait_for_request. Pass snippet ("curl", "dart_http" or "dio") to also get the request as runnable code (redacted values stay "[redacted]"). For large JSON responses prefer get_body_shape first.',
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
    model: "Make the app receive a fake response for matching requests (the real server is not contacted). Use it to test error states and edge cases (e.g. status 500, empty lists, slow responses via delayMs) without touching the backend. The rule is inserted first so it wins. Pass times (e.g. 1 = only the next request, to test a retry) or ttlMs to have it removed automatically; otherwise remove it with remove_rule when done.",
    user: 'Add a rule that answers matching requests with a fake response.',
  },
  add_block: {
    title: 'Add block rule',
    model: 'Block matching requests: answer with a status (default 403) or reset the connection (mode "reset") to simulate a network failure. Inserted first; times / ttlMs remove it automatically, otherwise remove it with remove_rule when done. For timeouts, slow or truncated responses use simulate_network.',
    user: 'Add a rule that blocks matching requests.',
  },
  add_breakpoint: {
    title: 'Add breakpoint rule',
    model: 'Pause matching requests before they are sent (phase "request") or their responses before the app gets them (phase "response", default). Paused exchanges appear in list_paused; continue them with resume_request (optionally edited) or abort_request. The app may time out if left paused. times: 1 pauses only the next matching request.',
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
  get_request_source: {
    title: 'Find the code that sent a request',
    model: "Find where in the app's Dart code a recorded request was made. Returns appFrame (the app's call site: function, package URI, path relative to the project, line, column) and the stack frames (inProject marks the project's own files; afterAsyncGap marks frames after an await). Use it to go from an unexpected, failing or duplicated request straight to the code that sent it. Returns {available: false, reason} when there is no trace: source capture off, a request sent by the editor/an agent, or the trace has not arrived yet (retry shortly).",
    user: 'Show the Dart call site that sent a request.',
  },
  get_body_shape: {
    title: 'Get JSON body structure',
    model: 'Get the structure of a recorded JSON response (or request, which:"request") body without its values: key names and types only, every array merged into one element shape plus its length. Compact even for megabyte bodies, so use it before get_request to understand an API response or to write/fix model classes and parsing code. Notation: "string" | "integer" | "number" | "boolean" | "null"; unions like "string|null"; "key?" = missing in some merged objects; arrays {"[]": element shape, "length": n or "min-max"}; {"|": [...]} = a union mixing objects/arrays; "{…}" / "[…]" = deeper than maxDepth; "…" = more keys omitted. Non-JSON bodies return {shape: null, reason}.',
    user: 'Show the structure of a JSON body.',
  },
  simulate_network: {
    title: 'Simulate network conditions (all app traffic or matching requests)',
    model: 'Simulate bad network conditions to test loading states, timeouts, retries and offline handling. Without url: set the profile for ALL app traffic: "slow-3g", "fast-3g", "flaky" (20% of requests fail), "offline" (every request fails), "custom" (latencyMs, kbps, dropRate), or "none" to restore normal speed (do this when done). With url (glob or /regex/): add a rule, inserted first, that slows only matching requests with the given profile, or makes them fail with fault ("reset", "timeout", "truncate", "dns"); times / ttlMs remove the rule automatically, otherwise use remove_rule. Mocks and blocks still answer instantly. get_status shows the active profile; affected exchanges carry a "simulated" label.',
    user: 'Throttle or break the network for the app or for matching requests.',
  },
  resend_request: {
    title: 'Resend a request',
    model: 'Send a recorded request again through the proxy, optionally edited (method, url, headers, body), without involving the app — e.g. to check a fix on the backend or try a different payload. Only for an app request that reached the real server unchanged (state "completed", no rule matched it, not from a physical device over LAN), and only to that request\'s own origin: edit.url may change path and query, never scheme, host or port. Anything else is refused with the reason. Omitted fields keep the original, including secret headers you only see as "[redacted]"; a "[redacted]" value in edit.headers (or the query) is replaced by the original. Rules and the network profile apply. Returns {id, sinceMs}: the new exchange starts "pending"; wait for it with wait_for_request (same url, that sinceMs) or check get_request(id).',
    user: 'Send a recorded request again, optionally edited.',
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
