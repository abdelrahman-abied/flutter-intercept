/**
 * Agent tools: rules (QUALITY-1 Q5: split out of api.ts). Each handler gets the shared AgentViews and its parsed input.
 */
import type { GrpcEdit, RequestEdit, ResponseEdit, Rule } from '@flutter-intercept/proxy';
import { checkMapTarget, expireTokenRule, resolveGrpcEdit, validateEdit } from '../../ui/controller';
import { mapRemoteSelfProblem } from '../../proxyHost';
import { corsPolicyShort, urlGlobHasHost } from '../corsPolicy';
import { isSensitiveHeader, REDACTED } from '../redact';
import { grpcMethodFromGlob } from '../../grpc/service';
import { ToolInput } from '../schema';
import { AgentToolError, ToolResult } from '../types';
import { AGENT_RULE_PREFIX, throttleFields, LOOPBACK_HOSTS, AGENT_REWRITE_FORBIDDEN, ACTIVE_CONTENT, SCRIPTISH, agentMockRefusal, opLabel } from '../shared';
import type { AgentViews } from '../views';
import type { ToolHandlers } from './types';

export function addMock(ag: AgentViews, i: ToolInput<'add_mock'>): ToolResult {
  const grpcPath = grpcMethodFromGlob(i.url);
  if (grpcPath && ag.grpcSchema()?.method(grpcPath)) {
    throw new AgentToolError(`add_mock refused: ${grpcPath} is a gRPC method, and HTTP mocks never match gRPC calls; use add_grpc_mock`, 'invalid');
  }
  const isJson = typeof i.body !== 'string';
  const headers: Record<string, string> = { ...(i.headers ?? {}) };
  if (isJson && !Object.keys(headers).some((k) => k.toLowerCase() === 'content-type')) headers['content-type'] = 'application/json';
  const why = agentMockRefusal(i.url, i.status, headers, isJson ? '' : (i.body as string));
  if (why) throw new AgentToolError(`add_mock refused: ${why}`, 'invalid');
  return ag.insertRule({
    id: ag.newId(),
    enabled: true,
    name: ag.label(i.name, `mock ${i.method ?? '*'} ${i.url}${opLabel(i)} → ${i.status}`),
    match: ag.match(i),
    action: {
      kind: 'mock',
      status: i.status,
      ...(Object.keys(headers).length ? { headers } : {}),
      body: isJson ? JSON.stringify(i.body) : (i.body as string),
      ...(i.delayMs !== undefined ? { delayMs: i.delayMs } : {}),
    },
    ...ag.spending(i),
  });
}


export function addBlock(ag: AgentViews, i: ToolInput<'add_block'>): ToolResult {
  return ag.insertRule({
    id: ag.newId(),
    enabled: true,
    name: ag.label(i.name, `block ${i.method ?? '*'} ${i.url}${opLabel(i)}`),
    match: ag.match(i),
    action: i.mode === 'reset' ? { kind: 'block', mode: 'reset' } : { kind: 'block', mode: 'status', status: i.status },
    ...ag.spending(i),
  });
}


export function addBreakpoint(ag: AgentViews, i: ToolInput<'add_breakpoint'>): ToolResult {
  return ag.insertRule({
    id: ag.newId(),
    enabled: true,
    name: ag.label(i.name, `break ${i.phase} ${i.method ?? '*'} ${i.url}${opLabel(i)}`),
    match: ag.match(i),
    action: { kind: 'breakpoint', phase: i.phase },
    ...ag.spending(i),
  });
}


export function removeRule(ag: AgentViews, i: ToolInput<'remove_rule'>): ToolResult {
  const rules = ag.deps.host.getRules();
  if (rules.find((r) => r.id === i.ruleId)?.shared) {
    throw new AgentToolError(
      `rule "${i.ruleId}" is a shared rule from .vscode/flutter-intercept.json (committed with the project); agents can't change that file — ask the user to edit it or un-share the rule in the Flutter Intercept panel`,
      'invalid',
    );
  }
  const next = rules.filter((r) => r.id !== i.ruleId);
  if (next.length === rules.length) return { removed: false };
  ag.deps.applyRules(next);
  return { removed: true };
}


export function resume(ag: AgentViews, i: ToolInput<'resume_request'>): ToolResult {
  const e = ag.pausedOrThrow(i.id);
  // CONTRACTS §17.6: a paused gRPC call takes `grpc` (message / messageJson / drop, or status + trailers)
  if (e.kind === 'grpc' && e.grpcPause) {
    if (i.edit !== undefined) throw new AgentToolError('this is a paused gRPC call: pass grpc {messageJson | message | drop} (held message) or grpc {status, trailers?} (end of the call), not edit', 'invalid');
    let g: GrpcEdit | undefined;
    try {
      g = resolveGrpcEdit(e, ag.restoreRedactedGrpc(e, i.grpc), ag.deps.grpc);
    } catch (err) {
      throw new AgentToolError(`${(err as Error).message} (the call stays paused)`, 'invalid');
    }
    ag.deps.host.resume(i.id, g);
    return { resumed: true, ...(g?.drop ? { dropped: true } : g?.message ? { edited: true } : g?.status ? { status: g.status.code } : {}) };
  }
  if (i.grpc !== undefined) throw new AgentToolError(`exchange "${i.id}" is not a paused gRPC call; use edit`, 'invalid');
  let edit: RequestEdit | ResponseEdit | undefined;
  try {
    edit = validateEdit(i.edit, e.state === 'paused-request' ? 'request' : 'response');
    ag.deps.host.resume(i.id, edit);
  } catch (err) {
    throw new AgentToolError((err as Error).message, 'invalid');
  }
  return { resumed: true };
}


export function abortRequest(ag: AgentViews, i: ToolInput<'abort_request'>): ToolResult {
  ag.pausedOrThrow(i.id);
  ag.deps.host.abort(i.id);
  return { aborted: true };
}


export function addMutation(ag: AgentViews, i: ToolInput<'add_mutation'>): ToolResult {
  const ops = i.ops.map((o) => ({ path: o.path, op: o.op, ...(o.value !== undefined ? { value: o.value } : {}), ...(o.valueJson !== undefined ? { valueJson: o.valueJson } : {}) }));
  const summary = ops.map((o) => `${o.op} ${o.path}`).join(', ');
  const fallback = `mutate ${i.method ?? '*'} ${i.url}${opLabel(i)}: ${summary}`;
  return ag.insertRule({
    id: ag.newId(),
    enabled: true,
    name: ag.label(i.name, fallback.length > 300 ? `${fallback.slice(0, 299)}…` : fallback),
    match: ag.match(i),
    action: { kind: 'mutate', ops },
    ...ag.spending(i),
  });
}

// ------------------------------------------------------------------ v0.5.0 (CONTRACTS §11.5)


export function addCorsRule(ag: AgentViews, i: ToolInput<'add_cors_rule'>): ToolResult {
  if (i.allowOrigin === '*' && i.allowCredentials) {
    throw new AgentToolError('allowOrigin "*" cannot be combined with allowCredentials (browsers reject it); name the origin instead (e.g. "http://localhost:5000")', 'invalid');
  }
  // REVIEW-5 #3: never a match-all CORS rule.
  if (!urlGlobHasHost(i.url)) {
    throw new AgentToolError(`add_cors_rule needs a url with a host, e.g. "https://api.example.com/*" (got ${JSON.stringify(i.url.slice(0, 100))}): a CORS rule for every site would let any page in the debug browser read them`, 'invalid');
  }
  // The policy is always part of the name, also with a custom one (REVIEW-5 #3).
  const policy = `[CORS dev only: ${corsPolicyShort(i.allowOrigin, i.allowCredentials)}]`;
  const base = (i.name ?? '').trim() || `${i.method ?? '*'} ${i.url}`;
  return ag.insertRule({
    id: ag.newId(),
    enabled: true,
    name: ag.label(undefined, `${base} ${policy}`),
    match: ag.match(i),
    action: { kind: 'cors', ...(i.allowOrigin !== undefined ? { allowOrigin: i.allowOrigin } : {}), ...(i.allowCredentials !== undefined ? { allowCredentials: i.allowCredentials } : {}) },
    ...ag.spending(i),
  });
}

// ------------------------------------------------------------------ v0.6.0 (CONTRACTS §12.7)


export function addSequence(ag: AgentViews, i: ToolInput<'add_sequence'>): ToolResult {
  const steps = i.steps.map((st, n) => {
    const count = st.count !== undefined ? { count: st.count } : {};
    switch (st.kind) {
      case 'mock': {
        const isJson = st.body !== undefined && typeof st.body !== 'string';
        const headers: Record<string, string> = { ...(st.headers ?? {}) };
        if (isJson && !Object.keys(headers).some((k) => k.toLowerCase() === 'content-type')) headers['content-type'] = 'application/json';
        const body = st.body === undefined ? '' : isJson ? JSON.stringify(st.body) : (st.body as string);
        const why = agentMockRefusal(i.url, st.status, headers, isJson ? '' : body);
        if (why) throw new AgentToolError(`add_sequence refused (step ${n + 1}): ${why}`, 'invalid');
        return { action: { kind: 'mock' as const, status: st.status, ...(Object.keys(headers).length ? { headers } : {}), body, ...(st.delayMs !== undefined ? { delayMs: st.delayMs } : {}) }, ...count };
      }
      case 'block':
        return { action: st.mode === 'reset' ? { kind: 'block' as const, mode: 'reset' as const } : { kind: 'block' as const, mode: 'status' as const, status: st.status }, ...count };
      case 'fault':
        return { action: { kind: 'fault' as const, fault: st.fault }, ...count };
      case 'throttle':
        return {
          action: { kind: 'throttle' as const, ...throttleFields(st) },
          ...count,
        };
      default:
        return { action: { kind: 'passthrough' as const }, ...count };
    }
  });
  const summary = i.steps.map((st) => `${st.kind === 'mock' ? st.status : st.kind}${st.count && st.count > 1 ? `×${st.count}` : ''}`).join(' → ');
  const fallback = `sequence ${i.method ?? '*'} ${i.url}${opLabel(i)}: ${summary}`;
  return ag.insertRule({
    id: ag.newId(),
    enabled: true,
    name: ag.label(i.name, fallback.length > 300 ? `${fallback.slice(0, 299)}…` : fallback),
    match: ag.match(i),
    action: { kind: 'sequence', steps, then: i.then },
  });
}


export function expireToken(ag: AgentViews, i: ToolInput<'expire_token'>): ToolResult {
  let rule: Rule;
  try {
    rule = expireTokenRule(ag.newId(), i.url, i.count, { namePrefix: AGENT_RULE_PREFIX });
  } catch (e) {
    throw new AgentToolError((e as Error).message, 'invalid');
  }
  return { ...ag.insertRule(rule), count: i.count, match: rule.match.url };
}


/** CONTRACTS §12.7: agents may only map to loopback targets (local backends), and never match-all. */
export function addMapRemote(ag: AgentViews, i: ToolInput<'add_map_remote'>): ToolResult {
  if (!urlGlobHasHost(i.url)) {
    throw new AgentToolError(`add_map_remote needs a url with a host, e.g. "https://api.example.com/*" (got ${JSON.stringify(i.url.slice(0, 100))})`, 'invalid');
  }
  let to: URL;
  try {
    to = checkMapTarget(i.to, 'to');
  } catch (e) {
    throw new AgentToolError((e as Error).message, 'invalid');
  }
  // CONTRACTS §18.6 / REVIEW-12 #1: never the proxy itself (a relay loop)
  const own = ag.deps.host.ownListeners ?? { ports: ag.deps.host.port !== undefined ? [ag.deps.host.port] : [], hosts: [] };
  const self = mapRemoteSelfProblem(i.to, own);
  if (self) throw new AgentToolError(`add_map_remote refused: ${self}`, 'invalid');
  if (!LOOPBACK_HOSTS.has(to.hostname.toLowerCase())) {
    throw new AgentToolError(
      `agents can only map requests to a local server (localhost, 127.0.0.1 or [::1]); got ${JSON.stringify(to.hostname.slice(0, 100))}. Mapping to another host can be set up by the user in the Flutter Intercept panel.`,
      'invalid',
    );
  }
  return ag.insertRule({
    id: ag.newId(),
    enabled: true,
    name: ag.label(undefined, `map ${i.method ?? '*'} ${i.url} → ${to.origin}`),
    match: ag.match(i),
    action: { kind: 'mapRemote', to: i.to },
  });
}


/**
 * CONTRACTS §12.7: no request headers whose names match the redaction rules (an agent must not inject or replace
 * credentials), no "[redacted]" values, and — while redaction is on — no body find/replace: a conditional
 * replacement is an oracle for redacted values (a matching `find` changes what the agent then sees).
 */
export function addRewrite(ag: AgentViews, i: ToolInput<'add_rewrite'>): ToolResult {
  const bad = (m: string) => new AgentToolError(m, 'invalid');
  if (!urlGlobHasHost(i.url)) throw bad(`add_rewrite needs a url with a host, e.g. "https://api.example.com/*" (got ${JSON.stringify(i.url.slice(0, 100))})`);
  if (!i.request && !i.response) throw bad('pass request and/or response changes');
  const hasRedacted = (v: string) => v.includes(REDACTED) || v.includes(encodeURIComponent(REDACTED));
  for (const [side, spec] of [['request', i.request], ['response', i.response]] as const) {
    if (!spec) continue;
    // CONTRACTS §18.1: gRPC trailers follow the response-header rules
    const trailers = side === 'response' ? (i.response?.setTrailers ?? {}) : {};
    for (const [name, value] of [...Object.entries(spec.setHeaders ?? {}), ...Object.entries(trailers)]) {
      if (side === 'request' && isSensitiveHeader(name)) {
        throw bad(`request.setHeaders: "${name}" carries credentials, which agents can't set (they only see them redacted); the user can add such a rewrite in the panel`);
      }
      if (AGENT_REWRITE_FORBIDDEN.test(name.trim())) {
        throw bad(`${side}.setHeaders: agents can't set "${name}" (redirect, cookie, browser security policy or forwarding headers); the user can add such a rewrite in the panel`);
      }
      if (side === 'response' && name.trim().toLowerCase() === 'content-type' && ACTIVE_CONTENT.test(value)) {
        throw bad(`response.setHeaders: content-type "${value.slice(0, 100)}" is refused for agents: a browser would run it (HTML, JavaScript or SVG)`);
      }
      if (hasRedacted(value)) throw bad(`${side}.setHeaders "${name}": "[redacted]" is a placeholder, not a value`);
    }
    if (spec.replaceBody?.length) {
      if (side === 'request') {
        throw bad('request.replaceBody is not available to agents: changing what the real server receives (callback URLs, e-mail addresses, amounts) needs the user; use resend_request with an edited body to try a different payload');
      }
      if (spec.replaceBody.some((r) => SCRIPTISH.test(r.replace))) throw bad('response.replaceBody: the replacement looks like markup or script, which agents may not inject');
      if (ag.redact) {
        throw bad(`${side}.replaceBody is not available to agents while secrets are redacted (a find/replace could reveal redacted values); use add_mutation to change JSON fields`);
      }
      for (const r of spec.replaceBody) if (hasRedacted(r.find) || hasRedacted(r.replace)) throw bad(`${side}.replaceBody: "[redacted]" is a placeholder, not a value`);
    }
  }
  const strip = <T extends object>(o: T | undefined): T | undefined => (o && Object.keys(o).length ? o : undefined);
  const request = strip(i.request);
  const response = strip(i.response);
  if (!request && !response) throw bad('pass request and/or response changes');
  return ag.insertRule({
    id: ag.newId(),
    enabled: true,
    name: ag.label(i.name, `rewrite ${i.method ?? '*'} ${i.url}${opLabel(i)}`),
    match: ag.match(i),
    action: { kind: 'rewrite', ...(request ? { request } : {}), ...(response ? { response } : {}) },
    ...ag.spending(i),
  });
}

// ------------------------------------------------------------------ v0.7.0 (CONTRACTS §13.8)

export const rulesTools: ToolHandlers = {
  add_mock: (ag, i) => addMock(ag, i),
  add_block: (ag, i) => addBlock(ag, i),
  add_breakpoint: (ag, i) => addBreakpoint(ag, i),
  remove_rule: (ag, i) => removeRule(ag, i),
  resume_request: (ag, i) => resume(ag, i),
  abort_request: (ag, i) => abortRequest(ag, i),
  add_mutation: (ag, i) => addMutation(ag, i),
  add_cors_rule: (ag, i) => addCorsRule(ag, i),
  add_sequence: (ag, i) => addSequence(ag, i),
  expire_token: (ag, i) => expireToken(ag, i),
  add_map_remote: (ag, i) => addMapRemote(ag, i),
  add_rewrite: (ag, i) => addRewrite(ag, i),
};
