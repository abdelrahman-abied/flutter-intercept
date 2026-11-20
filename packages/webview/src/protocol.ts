// CONTRACTS §3 types come from the proxy package (type-only import: nothing is bundled).
// §4 message types are defined here, verbatim from docs/CONTRACTS.md.
import type { Exchange, GrpcEdit, LearnedPassthroughReason, RequestEdit, ResponseEdit, Rule, RuleAction } from '@flutter-intercept/proxy/types';
import type { NetworkProfile } from '@flutter-intercept/proxy/network';
export type { NetworkProfile } from '@flutter-intercept/proxy/network';

export type {
  Body, BodyEncoding, Exchange, ExchangeState, Matcher, RequestEdit, ResponseEdit, Rule, RuleAction,
  Frame, GraphqlInfo, CorsInfo, Timings, GrpcInfo, GrpcPause, GrpcEdit,
} from '@flutter-intercept/proxy/types';

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
  | { type: 'grpcDecoded'; id: string; decoded: GrpcDecoded }          // answer to 'decodeGrpc'
  // CONTRACTS §20.3 (never a path, never the passphrase)
  | { type: 'clientCertificateFile'; role: ClientCertFileRole; file?: { token: string; name: string }; problem?: string } // answer to 'chooseClientCertificateFile'; no file + no problem = cancelled
  | { type: 'clientCertificateSaved'; host: string; problem?: string } // answer to 'addClientCertificate'
  // CONTRACTS §21.8
  | { type: 'collectionEndpoints'; id: string; endpoints: CollectionEndpointView[] }   // answer to 'getCollectionEndpoints'
  | { type: 'collectionExample'; id: string; endpoint: string; name: string; status: number; headers: Record<string, string>; body: string; truncated?: true } // ≤ 256 KB body
  // CONTRACTS §22.10
  | { type: 'storeItems'; id: string; resource: string; offset: number; total: number; items: unknown[]; truncated?: true }; // answer to 'getStoreItems'; pushed again while open
export interface Status {
  proxyRunning: boolean; port?: number; interceptEnabled: boolean; sessions: number;
  lan?: { host: string; port: number; peer?: string }; // present while the LAN listener is open (never the token); peer = the pinned iPhone address
  agent?: AgentStatus;                  // CONTRACTS §8 (never the MCP token)
  networkProfile?: NetworkProfile;      // CONTRACTS §9.3; absent = none
  warnings?: SessionWarning[];          // CONTRACTS §11
  replay?: { recording: string; fallback: 'passthrough' | 'fail' };                          // CONTRACTS §12
  sharedRules?: { file?: string; count: number; problems: string[]; pendingApproval: number; pending?: { name: string; reason: string }[] }; // CONTRACTS §12
  upstreamProxy?: string;               // REVIEW-6 #1: host:port of the upstream proxy in use (never credentials)
  upstreamProxySource?: 'flutterIntercept' | 'http.proxy'; // CONTRACTS §14.6
  tlsPassthrough?: string[];            // CONTRACTS §14.2: hosts passed through undecrypted (tunnels)
  clientCertificates?: { host: string; problem?: string }[]; // CONTRACTS §14.3 (never key material)
  learnedPassthrough?: { host: string; port: number; reason: LearnedPassthroughReason; until?: number }[]; // CONTRACTS §20.2 (until absent = until the proxy stops)
  autoPassthrough?: boolean;            // CONTRACTS §20.7: false = servers are never passed through on their own
  upstreamProxyInsecure?: true;         // REVIEW-6 #1: upstream certificate checks are off
  grpc?: GrpcStatus;                    // CONTRACTS §16.4
  collections?: CollectionStatus[];     // CONTRACTS §21.8
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
export interface AgentStatus { access: string; mcpUrl?: string; clients: number; lastCall?: { tool: string; at: number } }

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
  | { type: 'decodeGrpc'; id: string }                                 // host answers 'grpcDecoded'
  // CONTRACTS §20.3
  | { type: 'chooseClientCertificateFile'; role: ClientCertFileRole }   // host answers 'clientCertificateFile'
  | { type: 'addClientCertificate'; host: string; pfx?: string; cert?: string; key?: string; passphrase?: string } // file tokens; host answers 'clientCertificateSaved'
  | { type: 'removeClientCertificate'; host: string }
  | { type: 'forgetLearnedPassthrough'; host?: string; port?: number } // none = all
  // CONTRACTS §21.8
  | { type: 'importCollection' }                                       // host opens the IDE's file picker
  | { type: 'getCollectionEndpoints'; id: string }
  | { type: 'getCollectionExample'; id: string; endpoint: string; name: string }
  | { type: 'updateCollection'; id: string; patch: CollectionPatch }
  | { type: 'removeCollection'; id: string }                           // the IDE confirms; the collection file is kept
  | { type: 'collectionToRule'; id: string; endpoint: string }
  | { type: 'approveCollection'; id: string }
  // CONTRACTS §22.10
  | { type: 'getStoreItems'; id: string; resource: string; offset: number; filter?: string }
  | { type: 'updateStore'; id: string; patch: StorePatch }
  | { type: 'storeSnapshot'; id: string; action: 'save' | 'load' | 'delete'; name?: string } // save without a name → the IDE's input box
  // CONTRACTS §23.2 / §23.3 (the host runs the IDE dialogs; the panel never names a path)
  | { type: 'mockFromTraffic'; source: 'session' | { recording: string } }
  | { type: 'updateExample'; id: string; endpoint: string; status: number; mode?: 'merge' | 'add' } // diff preview + confirm in the IDE
  | { type: 'ignoreDrift'; id: string; endpoint?: string; status?: number };                         // CONTRACTS §21.16: the IDE asks (modal)        // opens the rule editor with a personal copy

/** CONTRACTS §20.3: which file the picker is for. */
export type ClientCertFileRole = 'pfx' | 'cert' | 'key';

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
  kind: 'background-isolate' | 'native-client' | 'web' | 'bypass' | 'other';
  text: string;         // one sentence, e.g. "Requests from background isolate \"worker\" are not intercepted."
  sessionId?: string;
}

/** CONTRACTS §12.7 */
export interface RecordingSummary { id: string; name: string; createdAt: number; exchanges: number; redacted: boolean; streams?: number; frames?: number; grpc?: number } // streams/frames: CONTRACTS §14.5 (WebSocket / SSE); grpc: §17.4
export interface AuthFlowSummary {
  steps: { exchangeId: string; role: 'unauthorized' | 'refresh' | 'retry' | 'other' }[];
  stampede?: { refreshCalls: number; windowMs: number };
  problem?: string;
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

/** CONTRACTS §21.8: a collection linked in the shared file, as the panel shows it (names and origins, never values). */
export interface CollectionStatus {
  id: string;
  name: string;
  file: string;
  format?: 'postman' | 'openapi' | 'swagger' | 'insomnia' | 'bruno';
  enabled: boolean;
  unmatched: 'passthrough' | 'fail';
  endpoints: number;
  mocked: number;
  noExample: number;
  generated: number;
  off: number;
  unresolved: string[];
  origins: string[];
  problems: string[];
  /** CONTRACTS §21.16: answers served limited (risky headers / types removed) until the user approves the collection. */
  limited?: { reasons: string[]; answers: number };
  /** CONTRACTS §21.15: this user's own overlay entries in effect (selected / off / unmatched). */
  overrides: number;
  /** CONTRACTS §21.15: from this session's traffic to the collection's origins (top 20 each, most frequent first). */
  seen?: { notInCollection: { method: string; path: string; count: number }[]; noExample: { endpoint: string; count: number }[] };
  /** CONTRACTS §22.10: the collection's stateful resources. */
  store?: StoreStatus;
  /** CONTRACTS §23.3: the real server's answers no longer look like the examples. */
  drift?: { endpoints: number; line: string };
}

/** CONTRACTS §21.8: one endpoint of a collection (url = origin + path, params as `:name`). */
export interface CollectionEndpointView {
  key: string;
  method: string;
  name: string;
  folder: string[];
  url: string;
  examples: { name: string; status: number; generated?: true; query?: Record<string, string>; /** CONTRACTS §24.2: request-body field names this example is chosen by. */ byBody?: string[] }[];
  selected?: string;
  off?: true;
  unresolved?: string[];
  /** CONTRACTS §21.15: `selected` / `off` come from this user's overlay. */
  overridden?: true;
  /** CONTRACTS §23.3 */
  drift?: DriftView[];
}

/** CONTRACTS §23.3: one difference between the real server's answers and an example (paths and kinds, never values). */
export interface DriftChange {
  kind: 'added' | 'removed' | 'type' | 'nullable' | 'status';
  path: string;
  from?: string;
  to?: string;
}

/** CONTRACTS §23.3 */
export interface DriftView {
  endpoint: string;
  status: number;
  samples: number;
  changes: DriftChange[];
  since: number;
}

/** CONTRACTS §21.7: what `updateCollection` may change (one or more). */
export interface CollectionPatch {
  enabled?: boolean;
  unmatched?: 'passthrough' | 'fail';
  variable?: { name: string; value: string };
  example?: { endpoint: string; name: string };
  off?: { endpoint: string; off: boolean };
  /** CONTRACTS §21.15: 'me' (default) = this user's overlay; 'team' = the shared file. `variable` is always 'team'. */
  scope?: 'me' | 'team';
  /** CONTRACTS §21.15 (scope 'me'): clear this user's overlay — the whole collection, or one endpoint with `endpoint`. */
  reset?: true;
  endpoint?: string;
}

/** CONTRACTS §22.10: a collection's stateful resources, as the panel shows them (counts only, never records). */
export interface StoreStatus {
  enabled: boolean;
  resources: StoreResourceView[];
  /** Snapshot names saved for this collection. */
  snapshots: string[];
  /** The snapshot the data starts from instead of the seed. */
  startsFrom?: string;
  /** The data differs from what it started from (the app or someone changed it). */
  changed: boolean;
  /** CONTRACTS §22.7: this user's own store settings are in effect. */
  overridden?: true;
  problems: string[];
  /** CONTRACTS §24.1: sign-in simulation (sessions only; never a password or token). */
  auth?: StoreAuthStatus;
  /** CONTRACTS §24.3: how `{{$random…}}` values in examples are produced. */
  dynamic?: 'random' | 'seeded' | 'fixed';
}

/** CONTRACTS §24.1 */
export interface StoreAuthStatus {
  /** A login request was found in the collection. */
  available: boolean;
  enabled: boolean;
  login?: string;
  refresh?: string;
  ttlSeconds: number;
  protect: 'declared' | 'all';
  /** Signed-in sessions right now (a count, never tokens). */
  sessions: number;
  problems: string[];
}

/** CONTRACTS §22.10: one resource (e.g. users) of a collection's store. */
export interface StoreResourceView {
  name: string;
  /** "/users/:id" */
  path: string;
  idField: string;
  count: number;
  remembers: boolean;
  detected: boolean;
  overridden?: true;
  generatedSeed?: true;
  problem?: string;
}

/** CONTRACTS §22.10: what `updateStore` may change (data never reaches a file; settings follow `scope`). */
export interface StorePatch {
  resource?: string;
  enabled?: boolean;
  remembers?: boolean;
  idField?: string;
  put?: { item: unknown };
  remove?: { itemId: string };
  replace?: unknown[];
  /** ≤ 5 000 copies of the seed's first record with new ids. */
  generate?: { count: number };
  startsFrom?: string | null;
  scope?: 'me' | 'team';
  reset?: 'data' | 'settings';
  /** CONTRACTS §24.1: settings follow `scope`; `expire` is a data change (signs everyone out). */
  auth?: { enabled?: boolean; ttlSeconds?: number; protect?: 'declared' | 'all'; expire?: 'all' };
  /** CONTRACTS §24.3 */
  dynamic?: 'random' | 'seeded' | 'fixed';
}

/** CONTRACTS §22.10: which store operation answered an exchange. */
export interface StoreOpView {
  resource: string;
  op: 'list' | 'create' | 'get' | 'replace' | 'patch' | 'delete';
  itemId?: string;
}
