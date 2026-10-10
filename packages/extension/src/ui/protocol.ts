/** CONTRACTS §4, verbatim. */
import type { Exchange, RequestEdit, ResponseEdit, Rule, RuleAction } from '@flutter-intercept/proxy';
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
  | { type: 'contract'; results: ContractSummary[] };

// webview → host
export type ViewMsg =
  | { type: 'ready' }
  | { type: 'resume'; id: string; edit?: RequestEdit | ResponseEdit }
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
  | { type: 'generateFixture'; id: string };                           // host opens untitled fixture + test

export type SnippetFormat = 'curl' | 'dart_http' | 'dio';
export interface SendDraft { method: string; url: string; headers?: Record<string, string | string[]>; body?: string }

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
  kind: 'background-isolate' | 'native-client' | 'web' | 'other';
  text: string;         // one sentence, e.g. "Requests from background isolate \"worker\" are not intercepted."
  sessionId?: string;
}
