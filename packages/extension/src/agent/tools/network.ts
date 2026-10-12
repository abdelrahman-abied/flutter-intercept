/**
 * Agent tools: network (QUALITY-1 Q5: split out of api.ts). Each handler gets the shared AgentViews and its parsed input.
 */
import type { Exchange, RequestEdit, RuleAction } from '@flutter-intercept/proxy';
import { describeProfile, NETWORK_PRESETS, presetProfile, type NetworkPresetId, type NetworkProfile } from '@flutter-intercept/proxy/network';
import { grpcResendMessages, resolveSendGrpc, sanitizeGrpcSendHeaders, sanitizeSendHeaders, validateSendDraft, validateEdit } from '../../ui/controller';
import { REDACTED } from '../redact';
import { decodeGrpcMessages, grpcMethodPath } from '../../grpc/service';
import { ToolInput } from '../schema';
import { AgentToolError, ToolResult } from '../types';
import { throttleFields, opLabel, restoreRedactedJson, restoreRedactedHeaders, restoreRedactedQuery } from '../shared';
import type { AgentViews } from '../views';
import type { ToolHandlers } from './types';

export function simulateNetwork(ag: AgentViews, i: ToolInput<'simulate_network'>): ToolResult {
  const custom = i.latencyMs !== undefined || i.kbps !== undefined || i.uploadKbps !== undefined || i.dropRate !== undefined;
  const bad = (m: string) => new AgentToolError(m, 'invalid');
  if (i.fault && i.profile) throw bad('pass either profile or fault, not both');
  if (!i.fault && !i.profile) throw bad('profile is required (or fault together with a url)');
  if (custom && i.profile !== 'custom') throw bad('latencyMs, kbps, uploadKbps and dropRate are only used with profile "custom"');
  if (i.profile === 'custom' && !custom) throw bad('profile "custom" needs latencyMs, kbps, uploadKbps and/or dropRate');

  if (i.url === undefined) {
    if (i.fault) throw bad('fault needs a url; to make every request fail use profile "offline"');
    if (i.method !== undefined || i.graphqlOperation !== undefined || i.times !== undefined || i.ttlMs !== undefined || i.name !== undefined) {
      throw bad('method, graphqlOperation, times, ttlMs and name only apply together with a url (a rule for matching requests)');
    }
    const p: NetworkProfile =
      i.profile === 'none' || i.profile === 'offline'
        ? { kind: i.profile }
        : i.profile === 'custom'
          ? { kind: 'throttle', ...throttleFields(i) }
          : presetProfile(i.profile as NetworkPresetId);
    if (!ag.deps.host.setNetworkProfile) throw new AgentToolError('this version of the proxy cannot simulate network conditions', 'state');
    try {
      ag.deps.host.setNetworkProfile(p);
    } catch (err) {
      throw new AgentToolError((err as Error).message, 'state');
    }
    return { profile: ag.profileView(p) };
  }

  if (i.profile === 'none') throw bad('profile "none" with a url changes nothing: remove the rule with remove_rule, or omit url to restore the global profile');
  let action: RuleAction;
  let what: string;
  if (i.fault || i.profile === 'offline') {
    const fault = i.fault ?? 'dns';
    action = { kind: 'fault', fault };
    what = i.fault ? `fault ${fault}` : 'offline';
  } else if (i.profile === 'custom') {
    action = { kind: 'throttle', ...throttleFields(i) };
    what = describeProfile({ ...action, kind: 'throttle' });
  } else {
    const preset = NETWORK_PRESETS.find((x) => x.id === i.profile)!;
    action = { kind: 'throttle', ...throttleFields(preset) };
    what = preset.label;
  }
  return ag.insertRule({
    id: ag.newId(),
    enabled: true,
    name: ag.label(i.name, `${what} ${i.method ?? '*'} ${i.url}${opLabel(i)}`),
    match: ag.match({ ...i, url: i.url }),
    action,
    ...ag.spending(i),
  });
}


export async function resendRequest(ag: AgentViews, i: ToolInput<'resend_request'>): Promise<ToolResult> {
  const e = ag.find(i.id);
  const why = ag.resendRefusal(e);
  if (why) throw new AgentToolError(`resend_request refused: ${why}.`, 'invalid');
  if (!ag.deps.host.send) throw new AgentToolError('this version of the proxy cannot send requests', 'state');
  if (i.grpc !== undefined && e.kind !== 'grpc') throw new AgentToolError(`exchange "${e.id}" is not a gRPC call; pass edit (not grpc)`, 'invalid');
  let edit: RequestEdit | undefined;
  try {
    edit = validateEdit(i.edit, 'request') as RequestEdit | undefined;
  } catch (err) {
    throw new AgentToolError((err as Error).message, 'invalid');
  }
  if (e.kind === 'grpc') return resendGrpc(ag, e, edit, i.grpc);
  const original = new URL(e.url);
  let url = e.url;
  if (edit?.url !== undefined) {
    const target = new URL(edit.url); // validateEdit: absolute http(s)
    // Same origin only (scheme, host, port; WHATWG-normalised): the original credentials go nowhere else.
    if (target.origin !== original.origin || target.username || target.password) {
      throw new AgentToolError(
        `resend_request refused: edit.url must keep the original origin ${original.origin} (only path and query may change); got ${target.username || target.password ? 'a URL with user info' : target.origin}.`,
        'invalid',
      );
    }
    // Send the normalised form of exactly what was checked (no parser differential downstream).
    const sent = new URL(restoreRedactedQuery(edit.url, e.url));
    if (sent.origin !== original.origin) throw new AgentToolError(`resend_request refused: edit.url must keep the original origin ${original.origin}.`, 'invalid');
    url = sent.href;
  }
  let body: string | undefined;
  if (edit?.body !== undefined) body = edit.body;
  else if (e.requestBody) {
    if (e.requestBody.encoding === 'base64') throw new AgentToolError('the original request body is binary and cannot be resent as is; pass edit.body', 'invalid');
    if (e.requestBody.truncated) throw new AgentToolError('the original request body was truncated when recorded; pass edit.body', 'invalid');
    body = e.requestBody.text;
  }
  const headers = sanitizeSendHeaders(edit?.headers !== undefined ? restoreRedactedHeaders(edit.headers, e.requestHeaders) : e.requestHeaders);
  const sinceMs = ag.now();
  let id: string;
  try {
    ({ id } = await ag.deps.host.send({
      method: (edit?.method ?? e.method).toUpperCase(),
      url,
      ...(headers ? { headers } : {}),
      ...(body !== undefined ? { body } : {}),
      initiator: 'agent',
      resentFrom: e.id,
    }));
  } catch (err) {
    throw new AgentToolError(`could not send the request: ${(err as Error).message}`, 'state');
  }
  return { id, sinceMs };
}


/**
 * CONTRACTS §18.4: resend a gRPC call — its recorded request messages, or `grpc.messagesJson` (encoded with the request
 * type; "[redacted]" values keep the original message's value at the same index and path) / `grpc.messages` (base64).
 * Same origin and still a gRPC method; method POST; no body; the proxy opens its own HTTP/2 call (LAN-recorded calls
 * are refused earlier: `resendRefusal`).
 */
export async function resendGrpc(ag: AgentViews, e: Exchange, edit: RequestEdit | undefined, g: ToolInput<'resend_request'>['grpc']): Promise<ToolResult> {
  const bad = (m: string) => new AgentToolError(`resend_request refused: ${m}`, 'invalid');
  if (edit?.body !== undefined) throw bad('a gRPC call has no body: pass grpc.messagesJson or grpc.messages');
  if (edit?.method !== undefined && edit.method.toUpperCase() !== 'POST') throw bad('a gRPC call is sent with method POST');
  const original = new URL(e.url);
  let url = e.url;
  if (edit?.url !== undefined) {
    const target = new URL(edit.url);
    if (target.origin !== original.origin || target.username || target.password) throw bad(`edit.url must keep the original origin ${original.origin}`);
    if (!grpcMethodPath(target.href)) throw bad('edit.url must name a gRPC method (…/package.Service/Method)');
    url = target.href;
  }
  let grpcIn: { messages?: string[]; messagesJson?: unknown[] };
  if (g?.messagesJson !== undefined && g.messages !== undefined) throw bad('pass grpc.messagesJson or grpc.messages, not both');
  if (g?.messagesJson !== undefined) {
    // REVIEW-12 #4: "[redacted]" values are restored only from the same method's recorded messages
    const sameMethod = grpcMethodPath(url) === grpcMethodPath(e.url);
    const originals = sameMethod ? decodeGrpcMessages(e, ag.deps.grpc, { filter: (f) => f.kind === 'message' && f.dir === 'send' && !f.dropped }).messages : [];
    grpcIn = {
      messagesJson: g.messagesJson.map((m, n) => {
        const o = originals[n];
        if (o?.via === 'schema' && o.json !== undefined && !o.truncated) return restoreRedactedJson(m, o.json);
        if (JSON.stringify(m)?.includes(REDACTED)) throw bad(`grpc.messagesJson[${n}] contains "[redacted]", but there is no decodable original message ${n + 1} of the same method to restore it from; pass the full message`);
        return m;
      }),
    };
  } else if (g?.messages !== undefined) grpcIn = { messages: g.messages };
  else {
    try {
      grpcIn = { messages: grpcResendMessages(e) };
    } catch (err) {
      throw bad((err as Error).message);
    }
  }
  let resolved: { messages: string[] };
  try {
    const checked = validateSendDraft({ method: 'POST', url, grpc: grpcIn });
    resolved = resolveSendGrpc(url, checked.grpc!, ag.deps.grpc);
  } catch (err) {
    throw bad((err as Error).message);
  }
  const headers = sanitizeGrpcSendHeaders(edit?.headers !== undefined ? restoreRedactedHeaders(edit.headers, e.requestHeaders) : e.requestHeaders);
  const sinceMs = ag.now();
  let id: string;
  try {
    ({ id } = await ag.deps.host.send!({ method: 'POST', url, headers, grpc: resolved, initiator: 'agent', resentFrom: e.id }));
  } catch (err) {
    throw new AgentToolError(`could not send the gRPC call: ${(err as Error).message}`, 'state');
  }
  return { id, sinceMs, messages: resolved.messages.length };
}

// ------------------------------------------------------------------ v0.4.0 (CONTRACTS §10.6)

export const networkTools: ToolHandlers = {
  simulate_network: (ag, i) => simulateNetwork(ag, i),
  resend_request: (ag, i) => resendRequest(ag, i),
};
