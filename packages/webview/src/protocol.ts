// CONTRACTS §3 types come from the proxy package (type-only import: nothing is bundled).
// §4 message types are defined here, verbatim from docs/CONTRACTS.md.
import type { Exchange, RequestEdit, ResponseEdit, Rule, RuleAction } from '@flutter-intercept/proxy/types';

export type {
  Body, BodyEncoding, Exchange, ExchangeState, Matcher, RequestEdit, ResponseEdit, Rule, RuleAction,
} from '@flutter-intercept/proxy/types';

// host → webview
export type HostMsg =
  | { type: 'snapshot'; exchanges: Exchange[]; rules: Rule[]; status: Status }
  | { type: 'exchange'; exchange: Exchange }
  | { type: 'rules'; rules: Rule[] }
  | { type: 'status'; status: Status }
  | { type: 'removed'; ids: string[] }
  | { type: 'error'; message: string }
  | { type: 'cleared' };
export interface Status {
  proxyRunning: boolean; port?: number; interceptEnabled: boolean; sessions: number;
  lan?: { host: string; port: number }; // present while the LAN listener is open (never the token)
  agent?: AgentStatus;                  // CONTRACTS §8 (never the MCP token)
}
export interface AgentStatus { access: string; mcpUrl?: string; clients: number; lastCall?: { tool: string; at: number } }

// webview → host
export type ViewMsg =
  | { type: 'ready' }
  | { type: 'resume'; id: string; edit?: RequestEdit | ResponseEdit }
  | { type: 'abort'; id: string }
  | { type: 'setRules'; rules: Rule[] }
  | { type: 'clear' }
  | { type: 'setInterceptEnabled'; enabled: boolean }
  | { type: 'createRuleFromExchange'; id: string; action: RuleAction['kind'] };
