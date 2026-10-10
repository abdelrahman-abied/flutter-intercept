/**
 * Input schemas for every agent tool (CONTRACTS §8) — the ONE source for both front doors (MCP and
 * VS Code language model tools) and for package.json `languageModelTools` (unit-tested equal).
 */
import { z } from 'zod';
import { READ_TOOLS, ToolName, WRITE_TOOLS } from './types';

/** REVIEW-4 #2: agents pass globs only (a `/regex/` could freeze the extension host); at most MAX_GLOB_STARS `*`. */
export const MAX_GLOB_STARS = 16;
const REGEX_LITERAL = /^\/(.+)\/([a-z]*)$/s;
const url = z
  .string()
  .min(1)
  .max(8192)
  .refine((v) => !REGEX_LITERAL.test(v.trim()), 'URL patterns are globs on the full URL (* matches any characters); /regex/ patterns are not accepted')
  .refine((v) => (v.match(/\*/g)?.length ?? 0) <= MAX_GLOB_STARS, `at most ${MAX_GLOB_STARS} * in a URL glob`)
  .describe('URL glob on the full URL; * matches any characters (e.g. "https://api.example.com/v1/users*", "*/users/*"). Matched against the URL as you see it (redacted query values read "[redacted]").');
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
// CONTRACTS §10.4 / §10.6
export const MODEL_STYLES = ['freezed', 'json_serializable', 'plain'] as const;
export const FIXTURE_STYLES = ['http_mock_adapter', 'mock_client', 'mocktail'] as const;
export const JSON_TYPES = ['string', 'number', 'integer', 'boolean', 'null', 'object', 'array'] as const;
export const MAX_MUTATE_OPS = 20;
// CONTRACTS §11.5
export const EXCHANGE_KINDS = ['http', 'websocket', 'sse', 'tunnel'] as const; // tunnel: CONTRACTS §14.2
export const MAX_FRAMES_PER_CALL = 500;
// CONTRACTS §12.7
export const MAX_SEQUENCE_STEPS = 50;
export const MAX_REWRITE_HEADERS = 50;
export const MAX_REWRITE_REPLACEMENTS = 20;
export const MAX_DIFF_ENTRIES = 200;

const includeBrowserInternal = z
  .boolean()
  .optional()
  .describe("Flutter Web: also include the browser's own requests (Chrome updates, GCM, optimization guide), which are hidden by default.");

const graphqlOperation = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[_A-Za-z][_0-9A-Za-z]*$/, 'a GraphQL operation name such as GetUser')
  .describe('GraphQL operation name (exact, case-sensitive), e.g. "GetUser". Requests are matched by url AND this name.');
const ruleGraphql = graphqlOperation.describe(
  'Only GraphQL requests with this operation name (exact, case-sensitive), e.g. "GetUser". The url glob still applies (usually the GraphQL endpoint, e.g. "*/graphql").',
);

const jsonPath = z
  .string()
  .min(1)
  .max(1000)
  .describe('JSON path into the response body: "$.user.avatar_url", "$.items[0].id", "$.items[*].price" ([*] = every element), "$[\'odd key\']". No filters or "..".');

const mutateOp = z
  .strictObject({
    path: jsonPath,
    op: z.enum(['null', 'delete', 'set']).describe('"null" sets the field to null, "delete" removes the key (or array element), "set" replaces it with `value`.'),
    value: z.unknown().optional().describe('With op "set": the new JSON value, e.g. "42" to send a number as a string. Max 1 MB.'),
    valueJson: z
      .string()
      .max(1024 * 1024)
      .optional()
      .describe(
        'With op "set", instead of value: the new value as JSON text, written byte-exact. Use it when the exact number form matters: "1.0" (a double, which Dart parses as double, not int), integers beyond 2^53 ("12345678901234567890"), "1e3". Wins over value.',
      ),
  })
  .describe('One change to the JSON response body.');

const dartName = z
  .string()
  .regex(/^[A-Za-z][A-Za-z0-9_]*$/, 'a Dart identifier such as User or user_profile')
  .max(100);

const jsonAssertion = z
  .strictObject({
    path: jsonPath,
    exists: z.boolean().optional().describe('true: the path selects at least one value; false: it selects nothing. Default true when neither equals nor type is given.'),
    equals: z
      .unknown()
      .optional()
      .describe('Every selected value deep-equals this JSON value. Compared with what get_request shows: a secret field only equals "[redacted]".'),
    type: z.enum(JSON_TYPES).optional().describe('Every selected value has this JSON type ("integer" = a whole number).'),
  })
  .describe('An assertion on the JSON response body of every matched request.');

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

// ---- CONTRACTS §12.7
const recordingId = z.string().min(1).max(200).describe('A recording id (from list_recordings or save_recording).');
const stepCount = z.number().int().min(1).max(1000).optional().describe('How many successive matching requests this step answers (1-1000, default 1).');
const mockBody = z
  .union([z.string(), z.record(z.string(), z.unknown()), z.array(z.unknown())])
  .describe('Response body: text, or a JSON object/array (sent as JSON).');
const sequenceStep = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('mock'),
    status: z.number().int().min(100).max(599).default(200),
    headers: headerMap.optional().describe('Response headers. content-type defaults to application/json when body is an object.'),
    body: mockBody.optional(),
    delayMs: z.number().int().min(0).max(600_000).optional(),
    count: stepCount,
  }),
  z.strictObject({
    kind: z.literal('block'),
    mode: z.enum(['status', 'reset']).default('status'),
    status: z.number().int().min(100).max(599).default(403),
    count: stepCount,
  }),
  z.strictObject({ kind: z.literal('fault'), fault: z.enum(FAULT_KINDS), count: stepCount }),
  z.strictObject({
    kind: z.literal('throttle'),
    latencyMs: z.number().int().min(0).max(600_000).optional(),
    kbps: z.number().min(1).max(10_000_000).optional(),
    uploadKbps: z.number().min(1).max(10_000_000).optional(),
    dropRate: z.number().min(0).max(1).optional(),
    count: stepCount,
  }),
  z.strictObject({ kind: z.literal('passthrough'), count: stepCount }),
]);
const rewriteHeaders = z.record(z.string(), z.string()).describe('Headers to set (replacing any existing value).');
const replaceBody = z
  .array(
    z.strictObject({
      find: z.string().min(1).max(10 * 1024).describe('Literal text to find (no regex).'),
      replace: z.string().max(64 * 1024).describe('Replacement text (at most 64 KB; all find + replace texts of a rule at most 256 KB).'),
      all: z.boolean().optional().describe('Replace every occurrence (default: the first only).'),
    }),
  )
  .min(1)
  .max(MAX_REWRITE_REPLACEMENTS)
  .describe('Literal find/replace on the decoded text body, applied in order (1-20). Non-text bodies are left untouched.');
const rewriteRequest = z
  .strictObject({
    setHeaders: rewriteHeaders.optional(),
    removeHeaders: z.array(z.string().min(1).max(200)).max(MAX_REWRITE_HEADERS).optional(),
    replaceBody: replaceBody.optional(),
  })
  .describe('Changes to the request before it is forwarded to the real server.');
const rewriteResponse = z
  .strictObject({
    status: z.number().int().min(100).max(599).optional(),
    setHeaders: rewriteHeaders.optional(),
    removeHeaders: z.array(z.string().min(1).max(200)).max(MAX_REWRITE_HEADERS).optional(),
    replaceBody: replaceBody.optional(),
  })
  .describe("Changes to the real server's response before the app gets it.");

// ---- CONTRACTS §13.8
const exportSpecInput = z.strictObject({
  url: url.optional().describe('Only exchanges whose URL matches this glob (e.g. "https://api.example.com/v1/*"). Omit for every finished HTTP request.'),
  method: method.optional(),
  sinceMs: sinceMs.optional(),
  title: z.string().trim().min(1).max(200).optional().describe("Document / collection title. Default: the Flutter project's name."),
  includeBrowserInternal,
});

export const toolSchemas = {
  get_status: z.strictObject({}),
  list_requests: z.strictObject({
    url: url.optional(),
    method: method.optional(),
    status: statusFilter.optional(),
    state: z.enum(EXCHANGE_STATES).optional(),
    sinceMs: sinceMs.optional(),
    kind: z
      .enum(EXCHANGE_KINDS)
      .optional()
      .describe('"websocket", "sse" (server-sent events), "tunnel" (a TLS connection passed through undecrypted for a flutterIntercept.tlsPassthrough host) or "http" (everything else).'),
    graphqlOperation: graphqlOperation.optional().describe('Only GraphQL requests with this operation name (exact, case-sensitive).'),
    includeBrowserInternal,
    // CONTRACTS §13.2
    slowerThanMs: z
      .number()
      .int()
      .min(0)
      .max(600_000)
      .optional()
      .describe('Only finished requests that took longer than this many milliseconds (durationMs > slowerThanMs). Read where the time went with get_request (timings).'),
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
    includeBrowserInternal,
  }),
  list_paused: z.strictObject({}),
  list_rules: z.strictObject({}),
  add_mock: z.strictObject({
    url,
    method: method.optional(),
    graphqlOperation: ruleGraphql.optional(),
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
    graphqlOperation: ruleGraphql.optional(),
    mode: z.enum(['status', 'reset']).default('status').describe('"status" answers with `status`; "reset" drops the connection.'),
    status: z.number().int().min(100).max(599).default(403),
    name: ruleName.optional(),
    times: times.optional(),
    ttlMs: ttlMs.optional(),
  }),
  add_breakpoint: z.strictObject({
    url,
    method: method.optional(),
    graphqlOperation: ruleGraphql.optional(),
    phase: z.enum(['request', 'response', 'both']).default('response'),
    name: ruleName.optional(),
    times: times.optional(),
    ttlMs: ttlMs.optional(),
  }),
  remove_rule: z.strictObject({ ruleId: id }),
  resume_request: z.strictObject({ id, edit: editSchema.optional() }),
  abort_request: z.strictObject({ id }),
  clear_requests: z.strictObject({}),
  export_har: z.strictObject({ url: url.optional(), method: method.optional(), sinceMs: sinceMs.optional(), includeBrowserInternal }),
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
        '"slow-3g" (+400 ms, 400 kbps down / 400 up), "fast-3g" (+150 ms, 1600 kbps down / 750 up), "flaky" (+200 ms, 20% of requests fail), "offline" (every request fails), "custom" (use latencyMs/kbps/uploadKbps/dropRate), "none" (restore). Required unless `fault` is given.',
      ),
    latencyMs: z.number().int().min(0).max(600_000).optional().describe('custom: added latency per request, ms.'),
    kbps: z.number().min(1).max(10_000_000).optional().describe('custom: response bandwidth, kilobits per second.'),
    uploadKbps: z.number().min(1).max(10_000_000).optional().describe('custom: request (upload) bandwidth, kilobits per second; also paces WebSocket messages the app sends.'),
    dropRate: z.number().min(0).max(1).optional().describe('custom: share of requests that fail (0-1).'),
    url: url.optional().describe('Only affect requests matching this URL glob (adds a rule, inserted first). Omit to set the profile for ALL app traffic.'),
    method: method.optional(),
    graphqlOperation: ruleGraphql.optional().describe('With url: only GraphQL requests with this operation name (exact, case-sensitive).'),
    fault: z
      .enum(FAULT_KINDS)
      .optional()
      .describe('With url: make matching requests fail instead of slowing them: "reset" (connection reset), "timeout" (no answer until the client gives up), "truncate" (response cut mid-body), "dns" (lookup failure).'),
    times: times.optional(),
    ttlMs: ttlMs.optional(),
    name: ruleName.optional(),
  }),
  resend_request: z.strictObject({ id, edit: requestEditSchema.optional() }),
  // CONTRACTS §10.6
  check_contract: z.strictObject({
    id: id.optional().describe('Check this one exchange. Omit to check the latest matching JSON responses.'),
    url: url.optional(),
    method: method.optional(),
    sinceMs: sinceMs.optional(),
    model: dartName.optional().describe('Check against this Dart model class (e.g. "User") instead of the one found automatically.'),
    limit: z.number().int().min(1).max(50).default(20).describe('Max exchanges to check when no id is given (newest first), 1-50.'),
  }),
  generate_model: z.strictObject({
    id: id.optional().describe('A recorded exchange; every recorded response of the same method + route (e.g. GET /users/{id}) is used as a sample.'),
    url: url.optional().describe('Or: the newest matching JSON response picks the route; all its recorded samples are used.'),
    name: dartName.optional().describe('Root class name (default: from the URL, e.g. "User" for /users/{id}).'),
    style: z.enum(MODEL_STYLES).optional().describe("Code style. Default: the project's own (freezed > json_serializable > plain, from pubspec.yaml)."),
  }),
  generate_fixture_test: z.strictObject({
    ids: z.array(id).min(1).max(20).optional().describe('Recorded exchanges to turn into fixtures (1-20).'),
    url: url.optional().describe('Or: the newest (up to 20) finished exchanges matching this URL.'),
    style: z.enum(FIXTURE_STYLES).optional().describe("Test style. Default: the project's own dev_dependencies (http_mock_adapter > mocktail > mock_client)."),
    name: z
      .string()
      .regex(/^[a-z][a-z0-9_]*$/, 'snake_case, e.g. get_user')
      .max(60)
      .optional()
      .describe('snake_case base name for the files (default: from the first request, e.g. "get_user").'),
  }),
  assert_traffic: z.strictObject({
    url: url.describe('Requests to check: a glob on the full URL; * matches any characters.'),
    method: method.optional(),
    sinceMs: sinceMs
      .optional()
      .describe('Only requests that started at or after this time (epoch ms). Default: the start of the latest launch_app/hot_restart if within the last 120 s, otherwise all recorded traffic.'),
    withinMs: z
      .number()
      .int()
      .min(0)
      .max(120_000)
      .default(0)
      .describe('Wait up to this long (max 120000) for the expected requests. 0 = check what is recorded now. With count.max or count.exact the whole window is observed.'),
    expect: z
      .strictObject({
        status: statusFilter.optional().describe('Every matched request has this status: a code, a class ("2xx".."5xx") or "error".'),
        count: z
          .strictObject({
            min: z.number().int().min(0).max(1000).optional(),
            max: z.number().int().min(0).max(1000).optional(),
            exact: z.number().int().min(0).max(1000).optional(),
          })
          .optional()
          .describe('How many matching requests. Default: at least one.'),
        order: z
          .array(url)
          .min(2)
          .max(20)
          .optional()
          .describe('URL globs that must have been requested in this order (each one starting after the previous one), among all requests since sinceMs.'),
        json: z.array(jsonAssertion).min(1).max(20).optional(),
        maxDurationMs: z.number().int().min(0).max(600_000).optional().describe('Every matched request finished within this many ms.'),
      })
      .describe('What must hold. Every given expectation is checked.'),
    includeBrowserInternal,
  }),
  add_mutation: z.strictObject({
    url,
    method: method.optional(),
    graphqlOperation: ruleGraphql.optional(),
    ops: z.array(mutateOp).min(1).max(MAX_MUTATE_OPS).describe('Changes applied in order to the real JSON response (1-20).'),
    times: times.optional(),
    ttlMs: ttlMs.optional(),
    name: ruleName.optional(),
  }),
  // CONTRACTS §11.5
  get_frames: z.strictObject({
    id,
    since: z
      .number()
      .int()
      .min(0)
      .optional()
      .describe('Return frames from this index on (the `next` of the previous call). Indexes count every frame of the connection, including dropped ones. Default: the oldest kept frame.'),
    limit: z.number().int().min(1).max(MAX_FRAMES_PER_CALL).default(100).describe(`Max frames to return, 1-${MAX_FRAMES_PER_CALL}.`),
    maxChars: z.number().int().min(0).max(65_536).default(4000).describe('Each frame\'s text is cut to this many characters (marked truncated).'),
  }),
  add_cors_rule: z.strictObject({
    url: url.describe('URL glob WITH a host, e.g. "https://api.example.com/*" (match-all patterns such as "*" are refused).'),
    method: method.optional(),
    allowOrigin: z
      .string()
      .min(1)
      .max(500)
      .optional()
      .describe('Access-Control-Allow-Origin to send: one origin such as "http://localhost:5000", or "*" (any website). Default: the request\'s Origin, but only for loopback pages (localhost, 127.0.0.1, [::1]). "null" is refused.'),
    allowCredentials: z.boolean().optional().describe('Also allow credentials (cookies): Access-Control-Allow-Credentials: true. Default false. Not allowed with allowOrigin "*".'),
    times: times.optional(),
    ttlMs: ttlMs.optional(),
    name: ruleName.optional(),
  }),
  // CONTRACTS §12.7
  list_recordings: z.strictObject({}),
  diff_recordings: z.strictObject({ a: recordingId.describe('The earlier / baseline recording.'), b: recordingId.describe('The recording to compare with it.') }),
  get_auth_flows: z.strictObject({ sinceMs: sinceMs.optional() }),
  save_recording: z.strictObject({
    name: z.string().trim().min(1).max(100).describe('A name for the recording, e.g. "checkout happy path".'),
    url: url.optional().describe('Only exchanges whose URL matches this glob. Omit for every finished HTTP request and closed WebSocket / SSE stream.'),
    sinceMs: sinceMs.optional(),
    redact: z
      .boolean()
      .default(true)
      .describe('Save secrets (auth headers, cookies, tokens) as "[redacted]" (default true). Replays of a redacted recording send "[redacted]" values to the app.'),
  }),
  replay_recording: z.strictObject({
    id: recordingId.optional().describe('Recording to replay. Omit to stop replaying.'),
    fallback: z
      .enum(['passthrough', 'fail'])
      .default('passthrough')
      .describe('Requests the recording has no answer for: "passthrough" (go to the real server) or "fail" (fail like offline, for a fully offline demo).'),
  }),
  add_sequence: z.strictObject({
    url,
    method: method.optional(),
    graphqlOperation: ruleGraphql.optional(),
    steps: z.array(sequenceStep).min(1).max(MAX_SEQUENCE_STEPS).describe('What successive matching requests get, in order (1-50 steps), e.g. [{kind:"mock", status:500, count:2}, {kind:"passthrough"}].'),
    then: z
      .enum(['last', 'passthrough', 'loop'])
      .default('last')
      .describe('After the last step: "last" keeps answering with the last step (default), "passthrough" lets requests reach the server, "loop" starts over.'),
    name: ruleName.optional(),
  }),
  expire_token: z.strictObject({
    url: url.describe('URL glob of the authenticated request(s) whose token should look expired, e.g. "https://api.example.com/v1/*".'),
    count: z.number().int().min(1).max(1000).default(1).describe('How many matching requests get 401 before the real server answers again (1-1000, default 1).'),
  }),
  add_map_remote: z.strictObject({
    url: url.describe('URL glob WITH a host of the requests to redirect, e.g. "https://api.example.com/*".'),
    to: z
      .string()
      .min(1)
      .max(2048)
      .describe('Loopback target origin or URL prefix: http://localhost:<port>, http://127.0.0.1:<port> or http://[::1]:<port> (optionally with a path prefix). Other hosts are refused for agents.'),
    method: method.optional(),
  }),
  add_rewrite: z.strictObject({
    url: url.describe('URL glob WITH a host, e.g. "https://api.example.com/v1/*".'),
    method: method.optional(),
    graphqlOperation: ruleGraphql.optional(),
    request: rewriteRequest.optional(),
    response: rewriteResponse.optional(),
    times: times.optional(),
    ttlMs: ttlMs.optional(),
    name: ruleName.optional(),
  }),
  // CONTRACTS §13.8
  export_openapi: exportSpecInput,
  export_postman: exportSpecInput,
  take_screenshot: z.strictObject({
    sessionId: z.string().min(1).max(200).optional().describe('Debug session to capture (see get_status). Omit when exactly one app is running.'),
  }),
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
    model: 'Get Flutter Intercept status: whether the intercepting proxy runs, the running debug sessions (device, program), how many requests are recorded and paused, the agent access level, and warnings about traffic that is NOT intercepted (e.g. requests from a background isolate, native HTTP clients that are only listed read-only, requests that bypass the proxy). Also: upstreamProxy (host:port the traffic is chained through; upstreamProxySource "http.proxy" = VS Code\'s proxy setting), tlsPassthrough (host globs whose HTTPS is passed through undecrypted, listed as kind "tunnel") and clientCertificates ([{host, loaded, problem?}] — mutual-TLS certificates the proxy presents; a problem means it did not load and the server will likely reject the connection). Call this first to see whether an app is running before using the other tools.',
    user: 'Show proxy, session and traffic status.',
  },
  list_requests: {
    title: 'List HTTP requests',
    model: "List HTTP requests the running Flutter/Dart app made (newest first), recorded by Flutter Intercept's proxy. Filter by URL glob (* matches any characters), method, status (code, class like \"4xx\", or \"error\"), state, start time, kind (\"websocket\", \"sse\", \"http\"), GraphQL operation name, or slowerThanMs (only requests that took longer). Items show kind, the GraphQL operation and captured: \"vm-profile\" for read-only requests of native HTTP clients (no rules apply to them); kind \"tunnel\" items are TLS connections to a flutterIntercept.tlsPassthrough host, passed through undecrypted (notDecrypted: true, bytesSent / bytesReceived, no status, headers or bodies). Returns ids; call get_request for headers and bodies, get_frames for WebSocket messages / SSE events. Secrets are redacted.",
    user: 'List recorded HTTP requests.',
  },
  get_request: {
    title: 'Get HTTP request details',
    model: 'Get one recorded HTTP exchange by id: method, URL, status, request/response headers and decoded bodies (long bodies truncated, binary bodies summarised, secrets redacted), error, and timings (ms per phase: requestMs = receiving the app\'s request, pausedMs = held at breakpoints, delayMs = added by a mock delay / throttle, dnsMs / connectMs / tlsMs on a new upstream connection or reused: true, sendMs, waitMs = time to first byte from the server, receiveMs = downloading the response; a missing phase did not happen or is unknown). scriptLog holds the lines a user\'s script rule logged (redacted). Use after list_requests or wait_for_request. Pass snippet ("curl", "dart_http" or "dio") to also get the request as runnable code (redacted values stay "[redacted]"). For large JSON responses prefer get_body_shape first. Also shows kind (websocket/sse), frameCount (read the frames with get_frames), graphql {operationName, operationType}, cors (a browser preflight / why a browser would block the response, Flutter Web) and captured: "vm-profile" (read-only, from a native HTTP client). A tunnel (kind "tunnel") has no headers or bodies: tunnel {notDecrypted: why, bytesSent, bytesReceived} explains that the host is passed through without decryption (usually because the app pins its certificate) — remove it from flutterIntercept.tlsPassthrough to inspect it. clientCertificate is the host pattern of the mutual-TLS client certificate the proxy presented upstream. multipart/form-data bodies are shown parsed: secret fields "[redacted]", file parts "[file <name>, N bytes]".',
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
    model: 'List the active intercept rules (mocks, blocks, breakpoints, …) in priority order: the first enabled matching rule wins. Rules created by agents are named "[agent] ...". Script rules (the user\'s own JavaScript hooks) are shown as {kind: "script", file?} without their code; agents cannot read, add or change scripts.',
    user: 'List mock, block and breakpoint rules.',
  },
  export_har: {
    title: 'Export HAR',
    model: 'Export recorded exchanges (optionally filtered by URL, method, start time) as a HAR 1.2 file under the project\'s .dart_tool/flutter_intercept/exports/ and return its path. Secrets are redacted according to the user\'s setting.',
    user: 'Export recorded traffic to a HAR file.',
  },
  add_mock: {
    title: 'Add mock rule',
    model: "Make the app receive a fake response for matching requests (the real server is not contacted). Use it to test error states and edge cases (e.g. status 500, empty lists, slow responses via delayMs) without touching the backend. The rule is inserted first so it wins. Pass times (e.g. 1 = only the next request, to test a retry) or ttlMs to have it removed automatically; otherwise remove it with remove_rule when done. GraphQL: all operations share one URL, so pass graphqlOperation (e.g. \"GetUser\") to mock just that operation (list_requests shows the names). Refused: HTML / JavaScript / SVG content types (or an untyped HTML body), and 3xx redirects whose location leaves the request's own origin (except to localhost).",
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
    model: 'Simulate bad network conditions to test loading states, timeouts, retries and offline handling. Without url: set the profile for ALL app traffic: "slow-3g", "fast-3g", "flaky" (20% of requests fail), "offline" (every request fails), "custom" (latencyMs, kbps, uploadKbps, dropRate), or "none" to restore normal speed (do this when done). With url (a glob; * matches any characters): add a rule, inserted first, that slows only matching requests with the given profile, or makes them fail with fault ("reset", "timeout", "truncate", "dns"); times / ttlMs remove the rule automatically, otherwise use remove_rule. Mocks and blocks still answer instantly. get_status shows the active profile; affected exchanges carry a "simulated" label.',
    user: 'Throttle or break the network for the app or for matching requests.',
  },
  resend_request: {
    title: 'Resend a request',
    model: 'Send a recorded request again through the proxy, optionally edited (method, url, headers, body), without involving the app — e.g. to check a fix on the backend or try a different payload. Only for an app request that reached the real server unchanged (state "completed", no rule matched it, not from a physical device over LAN), and only to that request\'s own origin: edit.url may change path and query, never scheme, host or port. Anything else is refused with the reason. Omitted fields keep the original, including secret headers you only see as "[redacted]"; a "[redacted]" value in edit.headers (or the query) is replaced by the original. Rules and the network profile apply. Returns {id, sinceMs}: the new exchange starts "pending"; wait for it with wait_for_request (same url, that sinceMs) or check get_request(id).',
    user: 'Send a recorded request again, optionally edited.',
  },
  check_contract: {
    title: 'Check responses against the Dart models',
    model:
      "Check recorded JSON responses against the app's own Dart models — exactly what the generated fromJson (json_serializable / freezed *.g.dart) would do with them. Finds the fields that would make parsing throw (error: a null or missing non-nullable field, a string where an int is expected, an unknown enum value) or are suspicious (warning). Pass id for one exchange, or url/method/sinceMs for the latest matching ones; model forces a model class. Each result says which model was used and how it was found (via: retrofit/chopper annotations, the request's stack trace, or the user's choice), or checked:false with the reason (no model mapped, not JSON, …). Violations give the JSON path, the model field, expected vs actual type and the model file:line (project-relative). Use it when the app shows a parse error (\"type 'Null' is not a subtype of type 'String'\") or after changing a model.",
    user: 'Check JSON responses against the Dart models.',
  },
  generate_model: {
    title: 'Generate Dart models from traffic',
    model:
      "Generate Dart model classes from the app's recorded JSON responses: every recorded sample of the same method + route is merged (a field missing in some samples becomes optional, a field seen null becomes nullable, int+double becomes double), nested objects get their own classes. Style follows the project (freezed, json_serializable or plain fromJson/toJson) unless style is given. Returns {files: [{path, content}], samples, route}: nothing is written, so write the files yourself (paths are suggestions relative to the project) and run build_runner for freezed/json_serializable. Secret field values are redacted before inference. Make the app call the endpoint a few times with different data first for better nullability.",
    user: 'Generate Dart models from recorded responses.',
  },
  generate_fixture_test: {
    title: 'Generate a fixture test from traffic',
    model:
      "Turn recorded exchanges into a test: one JSON fixture file per response under test/fixtures/ plus a test file that serves them with the project's mocking library (http_mock_adapter for Dio, package:http's MockClient, or mocktail for a Retrofit interface). Pass ids or a url glob. Returns {files: [{path, content}]} without writing them; adjust the generated test to call your repository/service and assert what matters. Always built from the redacted view: secrets appear as \"[redacted]\".",
    user: 'Generate JSON fixtures and a test from recorded requests.',
  },
  assert_traffic: {
    title: 'Assert on recorded traffic',
    model:
      'Check in one call that the app made the expected requests: matching url (glob; * matches any characters) and method since sinceMs (default: the latest launch_app/hot_restart, else all recorded traffic), with expect: status (code, "2xx".., "error"), count {min, max, exact} (default: at least one), order (URL globs requested in that order), json assertions on every matched response ({path: "$.items[0].id", exists | equals | type}), maxDurationMs. withinMs waits (event-driven, max 120 s) for the requests to arrive; it never hangs. Returns {pass, matched, ids, failures: [readable reasons]}. Failure texts name the request, path and expectation but never echo response values; equals compares with the redacted view (a secret only equals "[redacted]"). Use it as the final check of a change instead of reading bodies by hand.',
    user: 'Check that expected requests and responses happened.',
  },
  add_mutation: {
    title: 'Add response mutation rule',
    model:
      "Let matching requests reach the real server, then change its JSON response before the app gets it: ops [{path: \"$.user.avatar_url\", op: \"null\"}, {path: \"$.items[*].price\", op: \"set\", value: \"9.99\"}, {path: \"$.email\", op: \"delete\"}]. For an exact number form use valueJson (JSON text written byte-exact) instead of value: \"1.0\" to send a double (an int-typed Dart field then throws), integers beyond 2^53. Use it to reproduce or test how the app handles a null/missing/mistyped field from the backend (e.g. \"Null is not a subtype of String\") without mocking the whole response. Non-JSON responses pass unchanged. The rule is inserted first; times (e.g. 1) or ttlMs remove it automatically, otherwise use remove_rule. Affected exchanges carry a \"simulated\" label; check_contract shows what the models make of them.",
    user: 'Add a rule that changes fields of real JSON responses.',
  },
  get_frames: {
    title: 'Get WebSocket / SSE frames',
    model:
      'Read the messages of a recorded WebSocket connection or the events of a server-sent events (SSE) stream (list_requests kind "websocket" / "sse"): oldest first, each with index, dir ("send" = app → server, "receive"), at (epoch ms), kind (text, binary, ping, pong, close, event), size and text (SSE: event name and id). Binary payloads are summarised as "[binary N bytes]"; JSON messages are redacted structurally, other text by pattern (secrets read "[redacted]"). Page with since = the returned next; while the connection is open (state "pending") new frames keep arriving. Only the newest 500 frames per connection are kept (dropped counts the older ones).',
    user: 'Show the messages of a WebSocket or SSE stream.',
  },
  add_cors_rule: {
    title: 'Add CORS rule (development only)',
    model:
      'Flutter Web development only: let matching requests reach the real server, but answer the browser\'s CORS preflight (OPTIONS) locally and add Access-Control-Allow-Origin (default: the request\'s Origin; or allowOrigin), allow-methods/headers and optionally Allow-Credentials to the real response, so the app can be developed while the backend\'s CORS setup is wrong. By default only loopback pages (the Flutter Web dev server on localhost) are allowed, without credentials; pass allowOrigin / allowCredentials only when needed. The url must name a host. The real server is NOT changed: the same requests still fail in production until the backend sends the headers itself, so report the actual problem (get_request shows cors.problem). allowOrigin "*" cannot be combined with allowCredentials. Inserted first; times / ttlMs remove it automatically, otherwise use remove_rule.',
    user: 'Add a development-only rule that adds CORS headers to matching responses.',
  },
  // CONTRACTS §12.7
  list_recordings: {
    title: 'List traffic recordings',
    model: 'List the saved traffic recordings (id, name, createdAt, number of exchanges, whether secrets were redacted) and which one is being replayed, if any. Recordings are made with save_recording or from the traffic panel and live in the project\'s .dart_tool/flutter_intercept/recordings/ (not committed).',
    user: 'List saved traffic recordings.',
  },
  diff_recordings: {
    title: 'Compare two recordings',
    model: 'Compare two recordings route by route (method + path template such as GET /users/{id}): routes added or removed, status changes, JSON shape changes (keys added/removed, type changes), how many body values changed (values are never shown), call-count changes and responses more than 2x slower. Use it to see what a backend or app change did to the traffic: save a recording before and after, then diff them (a = before, b = after). Details are redacted.',
    user: 'Compare two traffic recordings.',
  },
  get_auth_flows: {
    title: 'Analyse token refresh flows',
    model: 'Find the app\'s token refresh flows in the recorded traffic: each 401/403, the refresh call(s) that followed and the retried request(s), with a stampede warning when the app sent several refresh calls for one expiry within 2 s, and a problem when the retry never happened or got 401 again. Steps carry exchange ids, method, redacted URL and status (read them with get_request). Combine with expire_token to test the refresh logic: expire_token, trigger the flow, then get_auth_flows.',
    user: 'Show 401 → token refresh → retry flows.',
  },
  save_recording: {
    title: 'Save a traffic recording',
    model: 'Save the finished HTTP exchanges and closed WebSocket / SSE streams with their messages (optionally only those matching url / since sinceMs; open connections, TLS tunnels and read-only native-client traffic are not recorded) as a named recording under the project\'s .dart_tool/flutter_intercept/recordings/. Secrets are saved as "[redacted]" unless you pass redact: false. Use recordings to replay a backend state offline (replay_recording: WebSocket / SSE streams replay as a scripted server with the recorded timing) or to compare traffic before and after a change (diff_recordings). Returns {id, name, exchanges, streams?, frames?} (streams = WebSocket / SSE exchanges among them).',
    user: 'Save the recorded traffic as a recording.',
  },
  replay_recording: {
    title: 'Replay a recording',
    model: 'Answer the app\'s requests from a saved recording instead of the real server: the same method + URL (and request body) gets the recorded response; several recorded responses for one request are served in order; requests whose path differs only in ids (/users/42 vs /users/7) match by path template. Rules still win. fallback decides what unmatched requests do: "passthrough" (real server, default) or "fail" (like offline — a fully offline demo). Recorded WebSocket / SSE streams are replayed too: the proxy answers the upgrade / stream itself and sends the recorded server messages with their timing (WebSocket: in step with the app\'s messages). Replayed exchanges carry simulated: "Replayed from <name>". Call it without id to stop replaying (do this when done); get_status / list_recordings show what is being replayed.',
    user: 'Answer requests from a saved recording (or stop replaying).',
  },
  add_sequence: {
    title: 'Add a scenario (sequence) rule',
    model: 'Make successive matching requests get different answers, to test retries, polling and recovery: steps [{kind:"mock", status:500, count:2}, {kind:"passthrough"}] fails the first two requests and lets the third reach the server. Step kinds: mock (status, body, headers, delayMs), block (status or reset), fault (reset, timeout, truncate, dns), throttle (latencyMs, kbps, uploadKbps, dropRate), passthrough (the real server); count = how many requests each step answers (default 1). then: "last" (default) keeps the last step, "passthrough", or "loop". Mock steps have add_mock\'s limits (no HTML/JavaScript, no redirects off the request\'s origin). The rule is inserted first; remove it with remove_rule when done. The panel and rule-hit show which step answered.',
    user: 'Add a rule whose answer changes from request to request.',
  },
  expire_token: {
    title: 'Expire the auth token',
    model: 'Simulate an expired access token: the next count (default 1) requests matching url get 401 {"error":"token_expired"}; after that the real server answers again. Use it to test the app\'s token refresh: expire_token on the authenticated API, trigger a request, then get_auth_flows (did it refresh once and retry?) or assert_traffic. Inserted first; remove it with remove_rule when done.',
    user: 'Make matching requests fail with 401 "token expired" for a while.',
  },
  add_map_remote: {
    title: 'Map requests to a local server',
    model: 'Redirect matching requests to a local backend (http://localhost:<port>, 127.0.0.1 or [::1], optionally with a path prefix): the path and query after the matched URL are kept, the app still sees the original URL, and exchanges carry simulated: "Mapped to <origin>". Requests keep their headers (including credentials), so map only to your own local server. Agents can only map to loopback targets; the user can map elsewhere from the panel. The url must name a host. Inserted first; remove it with remove_rule when done.',
    user: 'Send matching requests to a local server instead.',
  },
  // CONTRACTS §13.8
  export_openapi: {
    title: 'Export OpenAPI from traffic',
    model: "Write an OpenAPI 3.1 document (JSON) inferred from the app's recorded HTTP traffic (optionally filtered by url glob, method, start time) under the project's .dart_tool/flutter_intercept/exports/ and return its path: servers per origin, paths with {id} parameters for id-like segments, query parameters, request and response bodies per status with JSON schemas inferred from every sample (required = present in all samples, nullable when seen null) and one example each. Returns {path, exchanges, routes, notes}. Use it to document an undocumented backend or to compare the app's real usage with a spec. Secrets are redacted according to the user's setting. Make the app call each endpoint a few times first for better schemas.",
    user: 'Export recorded traffic as an OpenAPI document.',
  },
  export_postman: {
    title: 'Export Postman collection from traffic',
    model: "Write a Postman Collection v2.1 (JSON) from the app's recorded HTTP traffic (optionally filtered by url glob, method, start time) under the project's .dart_tool/flutter_intercept/exports/ and return its path: a folder per host, one request per route (the latest sample) with saved example responses, {{baseUrl}} variables per origin, and credential headers as empty {{variables}}. Returns {path, exchanges, routes, notes}. Secrets are redacted according to the user's setting.",
    user: 'Export recorded traffic as a Postman collection.',
  },
  take_screenshot: {
    title: 'Take a screenshot of the app',
    model: "Take a screenshot of the running Flutter app (the debug session's device; pass sessionId when several apps run) to see what the UI shows after a change or a mocked response. Returns the PNG image plus {path, width, height, takenAt, method, recentRequests}: recentRequests are the (at most 10) requests that started in the 5 s before the screenshot (redacted summaries; read them with get_request). The user confirms every screenshot and can turn the tool off (setting flutterIntercept.agent.screenshots). Supported on Android devices/emulators, iOS simulators, macOS and Flutter Web in Chrome (and wherever the Flutter VM service can render one); other devices answer \"not supported\".",
    user: 'Take a screenshot of the running app (asks first).',
  },
  add_rewrite: {
    title: 'Add a rewrite rule',
    model: 'Let matching requests reach the real server but change them on the way: request {setHeaders, removeHeaders, replaceBody} before forwarding, response {status, setHeaders, removeHeaders, replaceBody} before the app gets it. replaceBody is a literal find/replace on the decoded text (1-20 replacements, no regex). Use it for feature flags in headers, forcing a status, or patching a response text. Refused: setting request headers that carry credentials (Authorization, Cookie, *token*, *session*, *api-key* …); setting Location, Refresh, Set-Cookie, Content-Security-Policy, Access-Control-*, X-Forwarded-*, Forwarded, Host or method-override headers, or an HTML/JavaScript content-type; "[redacted]" values; request.replaceBody; markup or script in replacements; and — while secrets are redacted — response replaceBody (a find/replace could reveal redacted values); use add_mutation for JSON fields. The url must name a host. Inserted first; times / ttlMs remove it automatically, otherwise use remove_rule.',
    user: 'Add a rule that changes headers, status or body text of real requests or responses.',
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
