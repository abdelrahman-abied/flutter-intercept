/** Rule list operations, matching previews, descriptions and labels. Split out of ../state.ts (QUALITY-1 Q6). */
import { compileMatcher } from '@flutter-intercept/proxy/rules';
import type { FaultKind, MutateOp } from '@flutter-intercept/proxy/types';
import { appliesToGrpc, describeGrpcMock, isNativeGrpc } from '../grpc';
import type { Exchange, Rule, RuleAction } from '../protocol';
import { describeRewrite, sequencePreview } from '../scenarios';
import { describeScript } from '../scripts';
import { formatRemaining } from '../util';
import { describeThrottle } from './profile';

// ---------------------------------------------------------------- rules

export function moveRule(rules: Rule[], from: number, to: number): Rule[] {
  if (from < 0 || from >= rules.length || to < 0 || to >= rules.length || from === to) return rules;
  const out = rules.slice();
  const [r] = out.splice(from, 1);
  out.splice(to, 0, r);
  return out;
}

export function toggleRule(rules: Rule[], id: string): Rule[] {
  return rules.map((r) => (r.id === id ? { ...r, enabled: !r.enabled } : r));
}

export function deleteRule(rules: Rule[], id: string): Rule[] {
  return rules.filter((r) => r.id !== id);
}

export function upsertRule(rules: Rule[], rule: Rule): Rule[] {
  const i = rules.findIndex((r) => r.id === rule.id);
  if (i < 0) return [...rules, rule];
  const out = rules.slice();
  out[i] = rule;
  return out;
}

/**
 * A matcher as the preview applies it to recorded exchanges. method + url are the proxy's own matcher;
 * `graphqlOperation` (CONTRACTS §11.2) is compared with the operation the proxy detected (`Exchange.graphql`),
 * which is what its body-based check finds too. Native exchanges (captured: 'vm-profile') never match: rules
 * never apply to them.
 */
export type ExchangeTest = (ex: Pick<Exchange, 'method' | 'url' | 'graphql' | 'captured'>) => boolean;
export function compileExchangeMatcher(m: Rule['match']): ExchangeTest {
  const op = m.graphqlOperation?.trim();
  const test = compileMatcher({ method: m.method, url: m.url });
  return (ex) => !ex.captured && test(ex.method, ex.url) && (!op || ex.graphql?.operationName === op);
}

/** CONTRACTS §16.2: a rule whose action doesn't apply to gRPC never matches a gRPC call (the next rule is tried). */
function actionSkips(a: RuleAction | undefined, ex: Pick<Exchange, 'kind'> & Partial<Pick<Exchange, 'grpc'>>): boolean {
  // gRPC-Web is an HTTP request for every rule but grpcMock (CONTRACTS §19.1): nothing is skipped.
  return !!a && isNativeGrpc(ex) && !appliesToGrpc(a);
}

/** Index of the rule that would handle `ex` (first enabled match wins), or -1. */
export function winningRuleIndex(rules: Rule[], ex: Pick<Exchange, 'method' | 'url' | 'graphql' | 'captured'> & Partial<Pick<Exchange, 'kind' | 'grpc'>>): number {
  return rules.findIndex((r) => r.enabled && !actionSkips(r.action, ex) && compileExchangeMatcher(r.match)(ex));
}

export interface RuleStat { matches: number; wins: number }

/**
 * For each rule: how many current exchanges it matches, and how many it would actually
 * handle given "first enabled match wins". matches > wins means an earlier rule shadows it.
 * Disabled rules still report `matches` (wins is 0) so the user can preview them.
 */
export function ruleStats(rules: Rule[], exchanges: Exchange[]): RuleStat[] {
  // compileMatcher is the proxy's own matcher (same module as `matches`), compiled once per rule.
  const compiled = rules.map((r) => ({ test: compileExchangeMatcher(r.match), enabled: r.enabled, action: r.action }));
  const stats = rules.map(() => ({ matches: 0, wins: 0 }));
  for (const ex of exchanges) {
    let won = false;
    for (let i = 0; i < compiled.length; i++) {
      const c = compiled[i];
      if (actionSkips(c.action, ex) || !c.test(ex)) continue;
      stats[i].matches++;
      if (c.enabled && !won) { stats[i].wins++; won = true; }
    }
  }
  return stats;
}

/** How many exchanges a matcher matches (rule editor preview); `skipGrpc` = the action doesn't apply to gRPC calls. */
export function countMatches(m: Rule['match'], exchanges: Exchange[], skipGrpc = false): number {
  const test = compileExchangeMatcher(m);
  let n = 0;
  for (const e of exchanges) if (!(skipGrpc && isNativeGrpc(e)) && test(e)) n++;
  return n;
}

export const FAULT_LABEL: Record<FaultKind, string> = {
  reset: 'connection reset',
  timeout: 'timeout (never answered)',
  truncate: 'truncated response',
  dns: 'DNS failure (host lookup)',
};

export function describeAction(a: RuleAction): string {
  switch (a.kind) {
    case 'mock': return `Mock ${a.status}${a.bodyFile ? ` from ${a.bodyFile}` : ''}${a.delayMs ? ` after ${a.delayMs} ms` : ''}`;
    case 'block': return a.mode === 'reset' ? 'Block (connection reset)' : `Block with ${a.status ?? 403}`;
    case 'breakpoint': return a.phase === 'both' ? 'Break on request + response' : `Break on ${a.phase}`;
    case 'throttle': return `Throttle (${describeThrottle(a)})`;
    case 'fault': return `Fault: ${FAULT_LABEL[a.fault]}`;
    case 'mutate': return `Mutate: ${describeMutateOps(a.ops)}`;
    case 'cors': return describeCors(a);
    case 'sequence': return `Sequence: ${sequencePreview(a.steps, a.then)}`;
    case 'mapRemote': return `Map to ${a.to}${a.preserveHost ? ' (keep Host)' : ''}`;
    case 'rewrite': return describeRewrite(a);
    case 'script': return describeScript(a);
    case 'grpcMock': return describeGrpcMock(a);
  }
}

/** "CORS (dev only): allow the request's origin", "+ credentials". */
export function describeCors(a: { allowOrigin?: string; allowCredentials?: boolean }): string {
  const origin = a.allowOrigin?.trim() ? a.allowOrigin.trim() : 'localhost origins';
  return `CORS (dev only): allow ${origin}${a.allowCredentials ? ' + credentials' : ''}`;
}

const MAX_VALUE_TEXT = 40;

const shortText = (t: string) => (t.length > MAX_VALUE_TEXT ? `${t.slice(0, MAX_VALUE_TEXT - 1)}…` : t);

/** JSON text of a `set` value, shortened for one-line labels. */
export function shortJson(v: unknown): string {
  let t: string;
  try { t = JSON.stringify(v) ?? 'undefined'; } catch { t = String(v); }
  return shortText(t);
}

/** "$.avatar_url → null", "$.id removed", "$.age = \"42\"". */
export function describeMutateOp(op: MutateOp): string {
  if (op.op === 'null') return `${op.path} → null`;
  if (op.op === 'delete') return `${op.path} removed`;
  return `${op.path} = ${op.valueJson !== undefined ? shortText(op.valueJson) : shortJson(op.value)}`;
}

/** The first two ops, then "+N more". */
export function describeMutateOps(ops: MutateOp[]): string {
  if (!ops.length) return 'no changes';
  const head = ops.slice(0, 2).map(describeMutateOp).join(', ');
  return ops.length > 2 ? `${head} +${ops.length - 2} more` : head;
}

/** How often a rule was used, judged from the exchanges listed (the proxy keeps the real count). */
export function ruleHits(rule: Pick<Rule, 'id'>, exchanges: Exchange[]): number {
  let n = 0;
  for (const e of exchanges) if (e.matchedRuleId === rule.id) n++;
  return n;
}

/** "2 of 3 left · expires in 4m 10s" for rules with `times` / `expiresAt`; undefined otherwise. */
export function ruleBudget(rule: Pick<Rule, 'times' | 'expiresAt'>, hits: number, now: number): { text: string; spent: boolean } | undefined {
  const parts: string[] = [];
  let spent = false;
  if (rule.times !== undefined) {
    const left = Math.max(0, rule.times - hits);
    if (!left) spent = true;
    parts.push(`${left} of ${rule.times} left`);
  }
  if (rule.expiresAt !== undefined) {
    const ms = rule.expiresAt - now;
    if (ms <= 0) { spent = true; parts.push('expired'); }
    else parts.push(`expires in ${formatRemaining(ms)}`);
  }
  return parts.length ? { text: parts.join(' · '), spent } : undefined;
}

export function ruleLabel(r: Rule): string {
  return r.name?.trim() || matcherLabel(r.match);
}

/** "POST https://api.example.com/graphql · op getUser". */
export function matcherLabel(m: Rule['match']): string {
  return `${m.method ? m.method.toUpperCase() + ' ' : ''}${m.url}${m.graphqlOperation ? ` · op ${m.graphqlOperation}` : ''}`;
}

/** Rules created through the Agent API are named "[agent] …" (CONTRACTS §8). */
export const AGENT_RULE_PREFIX = '[agent] ';
export function isAgentRule(r: Pick<Rule, 'name'> | undefined): boolean {
  return !!r?.name?.startsWith(AGENT_RULE_PREFIX);
}

/** Label without the "[agent] " prefix (the UI shows an agent badge instead). */
export function ruleDisplayName(r: Rule): string {
  if (!isAgentRule(r)) return ruleLabel(r);
  const rest = r.name!.slice(AGENT_RULE_PREFIX.length).trim();
  return rest || matcherLabel(r.match);
}
