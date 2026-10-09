/** CONTRACTS §4, verbatim. */
import type { Exchange, RequestEdit, ResponseEdit, Rule, RuleAction } from '@flutter-intercept/proxy';

export interface Status {
  proxyRunning: boolean;
  port?: number;
  interceptEnabled: boolean;
  sessions: number;
  /** CONTRACTS §7: set while the LAN listener for a physical iPhone is open ("LAN open for iPhone"). Never the token. */
  lan?: { host: string; port: number; peer?: string };
}

// host → webview
export type HostMsg =
  | { type: 'snapshot'; exchanges: Exchange[]; rules: Rule[]; status: Status }
  | { type: 'exchange'; exchange: Exchange }
  | { type: 'rules'; rules: Rule[] }
  | { type: 'status'; status: Status }
  | { type: 'removed'; ids: string[] }
  | { type: 'error'; message: string }
  | { type: 'cleared' };

// webview → host
export type ViewMsg =
  | { type: 'ready' }
  | { type: 'resume'; id: string; edit?: RequestEdit | ResponseEdit }
  | { type: 'abort'; id: string }
  | { type: 'setRules'; rules: Rule[] }
  | { type: 'clear' }
  | { type: 'setInterceptEnabled'; enabled: boolean }
  | { type: 'createRuleFromExchange'; id: string; action: RuleAction['kind'] };
