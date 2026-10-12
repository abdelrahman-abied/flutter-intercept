/** CONTRACTS §4, verbatim. */
import type { Exchange, GrpcEdit, RequestEdit, ResponseEdit, Rule, RuleAction } from '@flutter-intercept/proxy';
import type { NetworkProfile } from '@flutter-intercept/proxy/network';

export interface Status {
  proxyRunning: boolean;
  port?: number;
  interceptEnabled: boolean;
  sessions: number;
  /** CONTRACTS §7: set while the LAN listener for a physical iPhone is open ("LAN open for iPhone"). Never the token. */
  lan?: { host: string; port: number; peer?: string };
  /** CONTRACTS §8: AI agent access (never the MCP token). */
  agent?: AgentStatus;
  /** CONTRACTS §9.3: active network profile; absent = none. */
  networkProfile?: NetworkProfile;
  /** CONTRACTS §11: things the user should know about the running sessions (e.g. background isolates). */
  warnings?: SessionWarning[];
  /** CONTRACTS §12: replay mode (recording name) and shared-rules file state. */
  replay?: { recording: string; fallback: 'passthrough' | 'fail' };
  sharedRules?: { file?: string; count: number; problems: string[]; pendingApproval: number; pending?: { name: string; reason: string }[] };
  /** CONTRACTS §12.6 / REVIEW-6 #1: the upstream proxy in use (`host:port`, never credentials). */
  upstreamProxy?: string;
  /** REVIEW-6 #1: the upstream proxy is used with certificate checks off (flutterIntercept.upstreamProxyIgnoreCertErrors). */
  upstreamProxyInsecure?: true;
  /** CONTRACTS §14.6: where `upstreamProxy` came from (`http.proxy` = VS Code's setting, used when ours is empty). */
  upstreamProxySource?: 'flutterIntercept' | 'http.proxy';
  /** CONTRACTS §14.2: hosts whose TLS is passed through undecrypted (listed as tunnels). */
  tlsPassthrough?: string[];
  /** CONTRACTS §14.3: configured client certificates (host pattern + whether it loaded; never paths' contents or passphrases). */
  clientCertificates?: { host: string; problem?: string }[];
  /** CONTRACTS §16.4: gRPC interception and the schema read from the app's generated `*.pb*.dart`. */
  grpc?: GrpcStatus;
}

export interface AgentStatus {
  access: string;
  mcpUrl?: string;
  clients: number;
  lastCall?: { tool: string; at: number };
}

// host → webview
export type HostMsg =
  | { type: 'snapshot'; exchanges: Exchange[]; rules: Rule[]; status: Status }
  | { type: 'exchange'; exchange: Exchange }
  | { type: 'rules'; rules: Rule[] }
  | { type: 'status'; status: Status }
  | { type: 'removed'; ids: string[] }
  | { type: 'error'; message: string }
  | { type: 'cleared' }
  | { type: 'sent'; id: string } // CONTRACTS §9.3: after a successful 'send'
  // CONTRACTS §10.5
  | { type: 'contract'; results: ContractSummary[] }
  // CONTRACTS §12.7
  | { type: 'recordings'; recordings: RecordingSummary[] }
  | { type: 'authFlows'; flows: AuthFlowSummary[] }
  // CONTRACTS §13.7
  | { type: 'select'; id: string }                                     // focus this exchange (from a notification's "Show")
  | { type: 'exported'; format: ExportFormat; path: string }           // after a successful 'export'
  // CONTRACTS §16.4
  | { type: 'grpcDecoded'; id: string; decoded: GrpcDecoded };         // answer to 'decodeGrpc'

// webview → host
export type ViewMsg =
  | { type: 'ready' }
  | { type: 'resume'; id: string; edit?: RequestEdit | ResponseEdit | GrpcEdit } // GrpcEdit: CONTRACTS §17.2
  | { type: 'abort'; id: string }
  | { type: 'setRules'; rules: Rule[] }
  | { type: 'clear' }
  | { type: 'setInterceptEnabled'; enabled: boolean }
  | { type: 'createRuleFromExchange'; id: string; action: RuleAction['kind'] }
  // CONTRACTS §9.3
  | { type: 'send'; request: SendDraft; resentFrom?: string }
  | { type: 'openSource'; id: string; frame?: number }
  | { type: 'copySnippet'; id: string; format: SnippetFormat }
  | { type: 'setNetworkProfile'; profile: NetworkProfile }
  // CONTRACTS §10.5
  | { type: 'pickModel'; id: string }                                  // host shows a model QuickPick, remembers, re-checks
  | { type: 'openViolation'; id: string; index: number }               // opens the model field's line
  | { type: 'mutateField'; id: string; path: string; op: 'null' | 'delete' | 'set'; value?: unknown; valueJson?: string } // rule inserted FIRST; valueJson = byte-exact JSON text
  | { type: 'generateModel'; id: string }                              // host opens untitled Dart model(s)
  | { type: 'generateFixture'; id: string }                            // host opens untitled fixture + test
  // CONTRACTS §12.7
  | { type: 'shareRule'; id: string; shared: boolean }                 // move a rule into / out of .vscode/flutter-intercept.json
  | { type: 'approveSharedRules' }                                     // approve held-back shared rules (map remote / rewrite)
  | { type: 'saveRecording'; name: string; ids?: string[]; redact?: boolean } // default: every finished HTTP exchange shown
  | { type: 'replayRecording'; id?: string; fallback?: 'passthrough' | 'fail' } // id undefined = stop replaying
  | { type: 'diffRecordings'; a: string; b: string }                   // host opens vscode.diff
  | { type: 'deleteRecording'; id: string }
  | { type: 'expireToken'; url: string; count: number }                // preset: sequence [401 × count, passthrough]
  | { type: 'openSharedRules' }                                        // opens .vscode/flutter-intercept.json
  | { type: 'openBodyFile'; path: string; create?: { content: string }; ruleId?: string } // opens a mock body file (creates it, never overwrites); ruleId = resolve in that rule's folder (REVIEW-7 #6)
  // CONTRACTS §13.7
  | { type: 'export'; format: ExportFormat; ids?: string[] }           // host asks redact or not, then a save dialog; ids default = all shown HTTP
  | { type: 'openInNewWindow' }                                        // opens the panel as an editor in its own window
  | { type: 'openScriptFile'; path: string; create?: { content: string }; ruleId?: string } // like openBodyFile, for script rules (.js); create never reuses an existing file (REVIEW-7 #1)
  // CONTRACTS §16.4
  | { type: 'decodeGrpc'; id: string };                                // host answers 'grpcDecoded'

/** CONTRACTS §13.5 */
export type ExportFormat = 'openapi' | 'postman' | 'har';

export type SnippetFormat = 'curl' | 'dart_http' | 'dio' | 'grpcurl'; // grpcurl: CONTRACTS §19.2
export interface SendDraft { method: string; url: string; headers?: Record<string, string | string[]>; body?: string; grpc?: { messages?: string[]; messagesJson?: unknown[] } }

/** CONTRACTS §10.5: the contract check of one exchange, as the panel shows it. */
export interface ContractSummary {
  id: string;
  checked: boolean;
  model?: string;
  via: 'retrofit' | 'chopper' | 'source' | 'user' | 'none';
  violations: { path: string; field: string; expected: string; actual: string; severity: 'error' | 'warning'; message: string }[];
  reason?: string;
}

/** CONTRACTS §11: a session-level warning shown as a banner (dismissable per id). */
export interface SessionWarning {
  id: string;           // stable, e.g. "isolate:<sessionId>:<isolateName>"
  kind: 'background-isolate' | 'native-client' | 'web' | 'bypass' | 'other'; // bypass: CONTRACTS §14.7
  text: string;         // one sentence, e.g. "Requests from background isolate \"worker\" are not intercepted."
  sessionId?: string;
}

/** CONTRACTS §12.7 */
export interface RecordingSummary { id: string; name: string; createdAt: number; exchanges: number; redacted: boolean; streams?: number; frames?: number; grpc?: number } // streams/frames: CONTRACTS §14.5 (WebSocket / SSE)
export interface AuthFlowSummary {
  steps: { exchangeId: string; role: 'unauthorized' | 'refresh' | 'retry' | 'other' }[];
  stampede?: { refreshCalls: number; windowMs: number };
  problem?: string;
}

/** CONTRACTS §16.4 */
export interface GrpcStatus {
  enabled: boolean;
  decryptHosts: string[];
  /** The proxy's self-check failed: gRPC calls are only seen as undecrypted tunnels. */
  problem?: string;
  /** From the app's generated `*.pb*.dart`. */
  schema?: { methods: number; messages: number; problems: string[] };
  /** CONTRACTS §19.3: iOS simulators that trust the Flutter Intercept CA (opt-in), and whether every TLS gRPC call is decrypted. */
  simulatorTrust?: { devices: { udid: string; name?: string; state: 'trusted' | 'pre-existing' | 'failed'; problem?: string }[]; decryptAll: boolean };
}

/** CONTRACTS §16.4: a gRPC call's messages decoded by the host (schema from the app's `*.pb*.dart`, else raw). */
export interface GrpcDecoded {
  /** e.g. `/pkg.Service/Method` → types; absent when the schema doesn't know the method. */
  method?: { requestType: string; responseType: string; clientStreaming: boolean; serverStreaming: boolean; file?: string };
  /** One per `message` frame, same order as `exchange.frames` (other frame kinds skipped). */
  messages: GrpcDecodedMessage[];
  /** `exchange.framesDropped` when decoded (0 = none), so the panel lines messages up with frames exactly. */
  framesDropped: number;
  /** CONTRACTS §17.6: the message a breakpoint holds, decoded in full (≤ 4 MB), while the call is paused on a message. */
  paused?: GrpcDecodedMessage & { index: number };
  /** Example JSON for each type (rule editor "skeleton" button). */
  skeletons?: { request?: string; response?: string };
  problem?: string;
}
export interface GrpcDecodedMessage {
  dir: 'send' | 'receive';
  /** Pretty JSON (schema decode) or raw field tree (`protoc --decode_raw` style). */
  json?: string;
  via: 'schema' | 'raw' | 'none';
  /** First 4 KB as hex. */
  hex: string;
  size: number;
  truncated?: true;
  error?: string;
}
