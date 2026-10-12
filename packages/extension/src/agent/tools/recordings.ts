/**
 * Agent tools: recordings (QUALITY-1 Q5: split out of api.ts). Each handler gets the shared AgentViews and its parsed input.
 */
import type { AuthAnalysis } from '../../analysis/types';
import { isRecordable } from '../../ui/controller';
import { redactText } from '../redact';
import { MAX_DIFF_ENTRIES, ToolInput } from '../schema';
import { AgentToolError, ToolResult } from '../types';
import { streamCounts } from '../shared';
import type { AgentViews } from '../views';
import type { ToolHandlers } from './types';

export async function listRecordings(ag: AgentViews): Promise<ToolResult> {
  const list = await ag.recordingsOrThrow().list();
  return {
    recordings: list.map((m) => ({ id: m.id, name: m.name, createdAt: m.createdAt, exchanges: m.exchanges, redacted: m.redacted, ...streamCounts(m) })),
    ...ag.replayView(),
  };
}


export async function saveRecording(ag: AgentViews, i: ToolInput<'save_recording'>): Promise<ToolResult> {
  const svc = ag.recordingsOrThrow();
  const keep = ag.filter({ url: i.url, sinceMs: i.sinceMs });
  const list = ag.deps.host.getExchanges().filter((e) => isRecordable(e) && keep(e));
  if (!list.length) {
    throw new AgentToolError(`no finished HTTP request, WebSocket or SSE stream${i.url ? ` matches ${i.url}` : ' is recorded'}${i.sinceMs !== undefined ? ' since sinceMs' : ''} (open connections, TLS tunnels and native-client traffic are not recorded)`, 'not_found');
  }
  // Agents save redacted unless they ask otherwise (the user's panel default is unredacted).
  const meta = await svc.save(i.name, list, { redact: i.redact });
  ag.changed();
  const where = ag.projectPath(meta.path);
  return { id: meta.id, name: meta.name, exchanges: meta.exchanges, redacted: meta.redacted, ...streamCounts(meta), ...(where ? { path: where } : {}) };
}


export async function replayRecording(ag: AgentViews, i: ToolInput<'replay_recording'>): Promise<ToolResult> {
  const host = ag.deps.host;
  if (!host.setReplay) throw new AgentToolError('this version of the proxy cannot replay recordings', 'state');
  if (i.id === undefined) {
    const was = host.replay;
    host.setReplay(undefined);
    ag.changed();
    return { replaying: false, ...(was ? { stopped: was.recording } : {}) };
  }
  const svc = ag.recordingsOrThrow();
  const rec = await ag.loadRecording(i.id);
  const entries = svc.toReplay(rec);
  if (!entries.length) throw new AgentToolError(`recording "${rec.id}" has no responses to replay`, 'invalid');
  try {
    host.setReplay(entries, { fallback: i.fallback, matchTemplates: true }, { id: rec.id, name: rec.name });
  } catch (e) {
    throw new AgentToolError((e as Error).message, 'state');
  }
  ag.changed();
  return {
    replaying: true,
    id: rec.id,
    name: rec.name,
    entries: entries.length,
    fallback: i.fallback,
    ...(rec.redacted ? { note: 'this recording was saved redacted: replayed secrets (tokens, cookies) read "[redacted]"' } : {}),
  };
}


/** Details are always redacted (CONTRACTS §12.7), whatever the setting. */
export async function diffRecordings(ag: AgentViews, i: ToolInput<'diff_recordings'>): Promise<ToolResult> {
  if (i.a === i.b) throw new AgentToolError('pass two different recordings', 'invalid');
  const svc = ag.recordingsOrThrow();
  const [a, b] = [await ag.loadRecording(i.a), await ag.loadRecording(i.b)];
  const all = svc.diff(a, b);
  const entries = all.slice(0, MAX_DIFF_ENTRIES).map((d) => ({ route: redactText(d.route), change: d.change, detail: redactText(d.detail) }));
  return {
    a: { id: a.id, name: a.name, exchanges: a.exchanges },
    b: { id: b.id, name: b.name, exchanges: b.exchanges },
    entries,
    total: all.length,
    ...(all.length > entries.length ? { more: all.length - entries.length } : {}),
    ...(all.length ? {} : { note: 'no differences by route, status, JSON shape, body values, call counts or timing' }),
  };
}


export function getAuthFlows(ag: AgentViews, i: ToolInput<'get_auth_flows'>): ToolResult {
  if (!ag.deps.analyzeAuth) throw new AgentToolError('auth-flow analysis is not available in this build of Flutter Intercept', 'state');
  const keep = ag.filter({ sinceMs: i.sinceMs });
  const list = ag.deps.host.getExchanges().filter(keep);
  const byId = new Map(list.map((e) => [e.id, e]));
  let flows: AuthAnalysis['flows'];
  try {
    flows = ag.deps.analyzeAuth(list).flows;
  } catch (e) {
    throw new AgentToolError(`auth-flow analysis failed: ${(e as Error)?.message ?? String(e)}`, 'internal');
  }
  const shown = flows.slice(-50);
  return {
    flows: shown.map((f) => ({
      steps: f.steps.map((s) => {
        const e = byId.get(s.exchangeId);
        return {
          exchangeId: s.exchangeId,
          role: s.role,
          at: s.at,
          ...(e ? { method: e.method, url: ag.url(e.url), ...(e.status !== undefined ? { status: e.status } : {}) } : {}),
        };
      }),
      ...(f.stampede ? { stampede: f.stampede } : {}),
      ...(f.problem ? { problem: ag.text(f.problem) } : {}),
    })),
    total: flows.length,
    ...(flows.length ? {} : { note: 'no 401/403 followed by a refresh call was recorded; expire_token makes the next request(s) get 401' }),
  };
}

export const recordingsTools: ToolHandlers = {
  list_recordings: (ag, _i) => listRecordings(ag),
  diff_recordings: (ag, i) => diffRecordings(ag, i),
  get_auth_flows: (ag, i) => getAuthFlows(ag, i),
  save_recording: (ag, i) => saveRecording(ag, i),
  replay_recording: (ag, i) => replayRecording(ag, i),
};
