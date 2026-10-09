/**
 * Agent suite (FI_SUITE=agent): the agent tools that launch/drive the app, against samples/demo_app in
 * place, in a real VS Code with the real Dart-Code. Devices: FI_AGENT_DEVICES (default "macos").
 *
 * Per device: get_status → launch_app → wait_for_request(GET users/1) → add_mock(users/1) →
 * hot_restart → the restarted app prints the mocked body → remove_rule → stop_app.
 * v0.3.0 (MCP door): get_request_source, get_body_shape, get_request snippets, resend_request (and its origin
 * refusal), simulate_network (global profile + url-scoped fault with times:1), add_mock with ttlMs.
 *
 * Two paths, chosen automatically:
 *  - "lm":     the extension registered `flutter_intercept_*` (lead wiring + package.json
 *              languageModelTools present) → every step goes through `vscode.lm.invokeTool`.
 *  - "direct": not wired yet → every step goes through our LmTool objects (src/agent/lmTools.ts
 *              `makeLmTool`, built with the REAL vscode LanguageModelToolResult/TextPart/MarkdownString)
 *              on top of a small AgentTools adapter over the real AppLauncher (src/agent/launch.ts) and
 *              the extension's public API (rules, exchanges). Only VS Code's registration is skipped.
 */
import * as vscode from 'vscode';
import type { Exchange, Rule } from '@flutter-intercept/proxy';
import { createAppLauncher } from '../../../src/agent/launch';
import { lmToolName, makeLmTool, LmVscode, registerLmTools } from '../../../src/agent/lmTools';
import { AgentTools, AgentToolError, ToolName } from '../../../src/agent/types';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { activateBoth, freePort, outputOf, registerOutputTracker, RunOutcome, sleep, waitFor } from './helpers';

/** Values the demo app sends in headers on GET users/1: must never appear in any tool output. */
const SECRETS = ['demo-secret-123', 'demo-key-456'];

const USERS1 = 'https://jsonplaceholder.typicode.com/users/1';

function globToRegExp(glob: string): RegExp {
  return new RegExp('^' + glob.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$');
}

export async function runAgentSuite(): Promise<RunOutcome[]> {
  const results: RunOutcome[] = [];
  registerOutputTracker();
  const { api } = await activateBoth();
  const cfg = vscode.workspace.getConfiguration('flutterIntercept');
  await cfg.update('port', await freePort(), vscode.ConfigurationTarget.Global);
  await cfg.update('enabled', true, vscode.ConfigurationTarget.Global);
  await sleep(10_000); // Flutter daemon device discovery

  const sessions = new Map<string, vscode.DebugSession>();
  vscode.debug.onDidStartDebugSession((s) => sessions.set(s.id, s));
  const launcher = createAppLauncher({ log: (m) => console.log(`[agent] ${m}`) });

  // ---- AgentTools adapter over the real launcher + the extension API (stands in for B's AgentApi) ----
  const direct: AgentTools = {
    access: 'readWrite',
    onDidCall: () => ({ dispose: () => undefined }),
    async call(tool: ToolName, input: Record<string, any>, signal?: AbortSignal) {
      switch (tool) {
        case 'get_status':
          return { proxyRunning: api.proxyHost.running, port: api.proxyHost.port, sessions: launcher.sessions(), exchangeCount: api.getExchanges().length };
        case 'launch_app':
          return launcher.launch(input);
        case 'stop_app':
          return launcher.stop(input.sessionId);
        case 'hot_restart':
          return launcher.hotRestart(input.sessionId);
        case 'wait_for_request': {
          const since = typeof input.sinceMs === 'number' ? input.sinceMs : Date.now();
          const re = globToRegExp(String(input.url));
          const end = Date.now() + Math.min(Number(input.timeoutMs ?? 30_000), 120_000);
          while (Date.now() < end && !signal?.aborted) {
            const hit = api
              .getExchanges()
              .find((e: Exchange) => e.startedAt >= since && re.test(e.url) && (!input.method || e.method === input.method) && !['pending', 'paused-request', 'paused-response'].includes(e.state));
            if (hit) return { id: hit.id, method: hit.method, url: hit.url, status: hit.status, state: hit.state };
            await sleep(200);
          }
          return { timedOut: true };
        }
        case 'add_mock': {
          const rule: Rule = {
            id: `agent-${Date.now()}`,
            enabled: true,
            name: `[agent] ${input.name ?? 'mock'}`,
            match: { url: String(input.url), ...(input.method ? { method: String(input.method) } : {}) },
            action: { kind: 'mock', status: input.status ?? 200, headers: { 'content-type': 'application/json' }, body: typeof input.body === 'string' ? input.body : JSON.stringify(input.body) },
          };
          api.setRules([rule, ...api.getRules()]);
          return { ruleId: rule.id };
        }
        case 'remove_rule': {
          const before = api.getRules();
          api.setRules(before.filter((r) => r.id !== input.ruleId));
          return { removed: before.length !== api.getRules().length };
        }
        default:
          throw new AgentToolError(`${tool} is not part of this suite's adapter`, 'invalid');
      }
    },
  };

  const lm = (vscode as any).lm as { tools?: readonly { name: string }[]; invokeTool?: (...a: any[]) => Thenable<any> } | undefined;
  const wired = (lm?.tools ?? []).map((t) => t.name).filter((n) => n.startsWith('flutter_intercept_'));
  let viaLm = wired.includes('flutter_intercept_launch_app') && typeof lm?.invokeTool === 'function';
  let path = viaLm ? 'lm (extension wiring)' : 'direct';
  console.log(`[suite] agent: vscode ${vscode.version}, lm.invokeTool=${typeof lm?.invokeTool}, lm.registerTool=${typeof (vscode as any).lm?.registerTool}, wired flutter_intercept tools=${wired.length} -> path ${viaLm ? 'lm' : 'direct'}`);
  const realVs = vscode as unknown as LmVscode;
  const suiteSubs: { dispose(): unknown }[] = [];
  if (!viaLm && typeof (vscode as any).lm?.registerTool === 'function' && typeof lm?.invokeTool === 'function') {
    // Not wired yet: register OUR tools from the suite (src/agent/lmTools.ts registerLmTools over the
    // adapter) and drive them through vscode.lm.invokeTool if this VS Code accepts that.
    const reg = registerLmTools({ subscriptions: suiteSubs }, { tools: direct, log: (m) => console.log(`[agent] ${m}`) });
    try {
      const cts = new vscode.CancellationTokenSource();
      const r = await lm.invokeTool(lmToolName('get_status'), { input: {}, toolInvocationToken: undefined }, cts.token);
      JSON.parse((r.content ?? []).map((p: any) => p.value ?? '').join(''));
      viaLm = true;
      path = `lm (suite-registered ${reg.registered.length} tools via registerLmTools)`;
    } catch (e) {
      console.log(`[suite] agent: invokeTool on suite-registered tools failed (${(e as Error).message}); using direct LmTool objects`);
    }
  }
  console.log(`[suite] agent: path = ${path}`);

  /** Runs one tool through the chosen path; returns the parsed JSON result and the prepared messages. */
  async function tool(name: ToolName, input: Record<string, unknown> = {}): Promise<{ result: any; prepared?: any }> {
    const cts = new vscode.CancellationTokenSource();
    try {
      if (viaLm) {
        const r = await lm!.invokeTool!(lmToolName(name), { input, toolInvocationToken: undefined }, cts.token);
        const text = (r.content ?? []).map((p: any) => p.value ?? '').join('');
        allOutputs.push(text);
        return { result: JSON.parse(text) };
      }
      const t = makeLmTool(name, { tools: direct, vscode: realVs });
      const prepared = await t.prepareInvocation({ input }, cts.token);
      const r: any = await t.invoke({ input }, cts.token);
      if (!(r instanceof (vscode as any).LanguageModelToolResult)) throw new Error('invoke did not return a vscode.LanguageModelToolResult');
      const part = r.content[0];
      if (!(part instanceof (vscode as any).LanguageModelTextPart)) throw new Error('result part is not a vscode.LanguageModelTextPart');
      return { result: JSON.parse(part.value), prepared };
    } finally {
      cts.dispose();
    }
  }

  const allOutputs: string[] = [];
  const devices = (process.env.FI_AGENT_DEVICES || 'macos').split(',').filter(Boolean);
  for (const dev of devices) {
    const out: RunOutcome = { name: `AGENT ${dev} launch → wait → mock + hot restart → stop (${path})`, output: '', proxyHits: [], failures: [], ms: 0 };
    const t0 = Date.now();
    const f = out.failures;
    let sessionId: string | undefined;
    try {
      const status0 = (await tool('get_status')).result;
      if (!Array.isArray(status0.sessions)) f.push(`get_status: ${JSON.stringify(status0)}`);

      const since = Date.now();
      const launched = await tool('launch_app', { deviceId: dev });
      sessionId = launched.result.sessionId;
      if (!sessionId) f.push(`launch_app: ${JSON.stringify(launched.result)}`);
      if (launched.prepared && !/Launch the app/.test(launched.prepared.confirmationMessages?.title ?? '')) f.push(`launch_app confirmation: ${JSON.stringify(launched.prepared)}`);
      if (launched.result.intercepted === false) f.push('session was not intercepted');
      console.log(`[suite] agent launch_app -> ${JSON.stringify(launched.result)} in ${Date.now() - since} ms`);

      const status1 = (await tool('get_status')).result;
      if (!status1.sessions?.some((s: any) => s.id === sessionId)) f.push(`get_status sessions: ${JSON.stringify(status1.sessions)}`);

      const waited = (await tool('wait_for_request', { url: USERS1, method: 'GET', sinceMs: since, timeoutMs: 120_000 })).result;
      if (waited.timedOut || waited.status !== 200) f.push(`wait_for_request: ${JSON.stringify(waited)}`);
      console.log(`[suite] agent wait_for_request -> ${JSON.stringify(waited).slice(0, 160)} at +${Date.now() - since} ms`);
      if (viaLm && waited.id) {
        const detail = (await tool('get_request', { id: waited.id })).result;
        const auth = JSON.stringify(detail.requestHeaders ?? {});
        if (!/"authorization":\s*"\[redacted\]"/i.test(auth)) f.push(`get_request Authorization not redacted: ${auth.slice(0, 200)}`);
        if (!/"x-api-key":\s*"\[redacted\]"/i.test(auth)) f.push(`get_request X-Api-Key not redacted: ${auth.slice(0, 200)}`);
      }

      const mock = await tool('add_mock', { url: USERS1, method: 'GET', status: 200, body: { mocked: 'agent' }, name: 'users/1' });
      const ruleId = mock.result.ruleId;
      if (mock.prepared && !String(mock.prepared.confirmationMessages?.message?.value ?? '').includes('Mock GET')) f.push(`add_mock confirmation: ${JSON.stringify(mock.prepared)}`);
      const session = sessions.get(sessionId!);
      const from = session ? outputOf(session).length : 0;
      const restarted = (await tool('hot_restart', { sessionId })).result;
      if (restarted.restarted !== 1) f.push(`hot_restart: ${JSON.stringify(restarted)}`);
      if (session) {
        await waitFor(() => /DEMO_RESULT dio_user 200 ms=\d+ \{"mocked":"agent"\}/.test(outputOf(session).slice(from)) || undefined, 90_000, 250).catch(() =>
          f.push('restarted app did not print the mocked users/1 body'),
        );
        out.output = outputOf(session)
          .slice(from)
          .split(/\r?\n/)
          .filter((l) => /DEMO_RESULT dio_user |Restarted application/.test(l))
          .join('\n');
      } else f.push('session object not seen');
      const removed = (await tool('remove_rule', { ruleId })).result;
      if (!removed.removed) f.push(`remove_rule: ${JSON.stringify(removed)}`);

      const stopped = (await tool('stop_app', { sessionId })).result;
      if (stopped.stopped !== 1) f.push(`stop_app: ${JSON.stringify(stopped)}`);
      sessionId = undefined;
      if (launcher.sessions().length) f.push(`sessions left: ${JSON.stringify(launcher.sessions())}`);
      out.mode = `session launched+stopped, mocked body seen after hot restart`;
    } catch (e) {
      f.push(`exception: ${(e as Error).message}`);
    } finally {
      if (sessionId) await launcher.stop(sessionId).catch(() => undefined);
    }
    out.ms = Date.now() - t0;
    results.push(out);
    console.log(`[suite] ${f.length ? 'FAIL' : 'ok  '} ${out.name} (${out.ms} ms)${f.length ? `\n         ${f.join('\n         ')}` : ''}\n${out.output}`);
  }
  // ---------------- MCP door (real @modelcontextprotocol/sdk client, Streamable HTTP) ----------------
  const mcpAccess = (api as any).mcp as { url?: string; token(): Thenable<string | undefined> } | undefined;
  if (!mcpAccess) {
    results.push({ name: 'AGENT MCP', output: '', proxyHits: [], failures: ['api.mcp missing: FI_TEST_EXPOSE_MCP_TOKEN not applied'], ms: 0 });
  } else {
    await waitFor(() => mcpAccess.url || undefined, 30_000, 200).catch(() => undefined);
    const url = mcpAccess.url!;
    const token = (await mcpAccess.token())!;
    const connect = async () => {
      const client = new Client({ name: 'fi-agent-suite', version: '0.0.0' });
      await client.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
      return client;
    };
    let client: Client | undefined;
    const mcpCall = async (name: ToolName, args: Record<string, unknown> = {}): Promise<{ result: any; isError: boolean; text: string }> => {
      const r: any = await client!.callTool({ name, arguments: args });
      const text = (r.content ?? []).map((c: any) => c.text ?? '').join('');
      allOutputs.push(text);
      let result: any;
      try {
        result = JSON.parse(text);
      } catch {
        result = { text };
      }
      return { result, isError: !!r.isError, text };
    };

    // Auth: no token -> 401.
    {
      const out: RunOutcome = { name: 'AGENT MCP auth: no token -> 401, server bound to 127.0.0.1', output: '', proxyHits: [], failures: [], ms: 0 };
      const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}' });
      if (res.status !== 401) out.failures.push(`no-token status ${res.status}`);
      const bad = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer nope' }, body: '{}' });
      if (bad.status !== 401) out.failures.push(`wrong-token status ${bad.status}`);
      if (!/^http:\/\/127\.0\.0\.1:\d+\/mcp$/.test(url)) out.failures.push(`url ${url}`);
      out.mode = `no token ${res.status}, wrong token ${bad.status}, ${url}`;
      results.push(out);
      console.log(`[suite] ${out.failures.length ? 'FAIL' : 'ok  '} ${out.name}${out.failures.length ? '\n         ' + out.failures.join('\n         ') : ''}`);
    }

    for (const dev of devices) {
      const out: RunOutcome = { name: `AGENT ${dev} over MCP: launch → wait → mock + hot restart → get_request → remove → stop`, output: '', proxyHits: [], failures: [], ms: 0 };
      const f = out.failures;
      const t0 = Date.now();
      let sessionId: string | undefined;
      try {
        client = await connect();
        const st = await mcpCall('get_status');
        if (st.isError || !Array.isArray(st.result.sessions)) f.push(`get_status: ${st.text.slice(0, 200)}`);
        const since = Date.now();
        const l = await mcpCall('launch_app', { deviceId: dev });
        sessionId = l.result.sessionId;
        if (l.isError || !sessionId) f.push(`launch_app: ${l.text.slice(0, 200)}`);
        const w = await mcpCall('wait_for_request', { url: USERS1, method: 'GET', sinceMs: since, timeoutMs: 120_000 });
        if (w.isError || w.result.timedOut || w.result.status !== 200) f.push(`wait_for_request: ${w.text.slice(0, 200)}`);
        const m = await mcpCall('add_mock', { url: USERS1, method: 'GET', status: 200, body: { mocked: 'mcp' }, name: 'users/1 via mcp' });
        const ruleId = m.result.ruleId;
        if (m.isError || !ruleId) f.push(`add_mock: ${m.text.slice(0, 200)}`);
        const restartAt = Date.now();
        const h = await mcpCall('hot_restart', { sessionId });
        if (h.isError || h.result.restarted !== 1) f.push(`hot_restart: ${h.text.slice(0, 200)}`);
        const w2 = await mcpCall('wait_for_request', { url: USERS1, method: 'GET', sinceMs: restartAt, timeoutMs: 90_000 });
        if (w2.isError || w2.result.timedOut) f.push(`wait after restart: ${w2.text.slice(0, 200)}`);
        const g = await mcpCall('get_request', { id: w2.result.id, includeBodies: true });
        const view = JSON.stringify(g.result);
        if (g.isError || !view.includes('mocked') || !view.includes('mcp')) f.push(`get_request body: ${view.slice(0, 300)}`);
        if (g.result.state !== 'mocked') f.push(`get_request state ${g.result.state}`);
        if (!/"authorization":\s*"\[redacted\]"/i.test(view)) f.push(`MCP get_request Authorization not redacted: ${view.slice(0, 300)}`);
        out.output = `get_request state=${g.result.state} requestHeaders=${JSON.stringify(g.result.requestHeaders ?? {}).slice(0, 200)} body=${JSON.stringify(g.result.responseBody ?? '').slice(0, 120)}`;
        const r = await mcpCall('remove_rule', { ruleId });
        if (r.isError || r.result.removed !== true) f.push(`remove_rule: ${r.text.slice(0, 200)}`);
        const s2 = await mcpCall('stop_app', { sessionId });
        if (s2.isError || s2.result.stopped !== 1) f.push(`stop_app: ${s2.text.slice(0, 200)}`);
        else sessionId = undefined;
      } catch (e) {
        f.push(`exception: ${(e as Error).message}`);
      } finally {
        if (sessionId) await launcher.stop(sessionId).catch(() => undefined);
        await client?.close().catch(() => undefined);
        client = undefined;
      }
      out.ms = Date.now() - t0;
      results.push(out);
      console.log(`[suite] ${f.length ? 'FAIL' : 'ok  '} ${out.name} (${out.ms} ms)${f.length ? '\n         ' + f.join('\n         ') : ''}\n         ${out.output}`);
    }

    // v0.3.0 tools (CONTRACTS §9.5) over MCP against the real AgentApi + proxy: source, body shape, snippets,
    // resend (origin-restricted), network profile, url-scoped fault with times:1 (spent rule removed by the
    // host), add_mock with ttlMs (expiry removes it without traffic).
    for (const dev of devices) {
      const out: RunOutcome = { name: `AGENT ${dev} v0.3.0 tools over MCP: source, shape, snippet, resend, simulate_network, times/ttlMs`, output: '', proxyHits: [], failures: [], ms: 0 };
      const f = out.failures;
      const t0 = Date.now();
      let sessionId: string | undefined;
      const notes: string[] = [];
      const rulesNow = async () => ((await mcpCall('list_rules')).result.rules ?? []) as Rule[];
      const gone = async (ruleId: string, ms: number) => {
        const end = Date.now() + ms;
        while (Date.now() < end) {
          if (!(await rulesNow()).some((r) => r.id === ruleId)) return true;
          await sleep(250);
        }
        return false;
      };
      try {
        client = await connect();
        const since = Date.now();
        const l = await mcpCall('launch_app', { deviceId: dev });
        sessionId = l.result.sessionId;
        if (l.isError || !sessionId) throw new Error(`launch_app: ${l.text.slice(0, 200)}`);
        const w = await mcpCall('wait_for_request', { url: USERS1, method: 'GET', sinceMs: since, timeoutMs: 120_000 });
        if (w.isError || w.result.timedOut || w.result.status !== 200) throw new Error(`wait_for_request: ${w.text.slice(0, 200)}`);
        const id = w.result.id as string;

        // get_request_source: the trace may arrive just after the exchange completes.
        let src: any;
        for (let i = 0; i < 20; i++) {
          src = (await mcpCall('get_request_source', { id })).result;
          if (src.available) break;
          await sleep(250);
        }
        if (!src?.available) f.push(`get_request_source: ${JSON.stringify(src).slice(0, 300)}`);
        else {
          if (!/^lib\/.+\.dart$/.test(src.appFrame?.path ?? '')) f.push(`get_request_source appFrame.path not project-relative lib/…: ${JSON.stringify(src.appFrame)}`);
          if (!(src.appFrame?.line > 0)) f.push(`get_request_source appFrame.line: ${JSON.stringify(src.appFrame)}`);
          if (JSON.stringify(src).includes(process.env.HOME ?? '/Users/')) f.push('get_request_source leaks an absolute home path');
          notes.push(`source ${src.appFrame?.path}:${src.appFrame?.line} (${src.appFrame?.fn})`);
        }

        // get_body_shape: jsonplaceholder users/1.
        const shape = await mcpCall('get_body_shape', { id });
        const sh = shape.result.shape;
        if (shape.isError || sh?.id !== 'integer' || typeof sh?.address !== 'object' || sh?.email !== 'string') f.push(`get_body_shape: ${shape.text.slice(0, 300)}`);
        if (shape.text.length > 4000) f.push(`get_body_shape result too large: ${shape.text.length} chars`);
        if (/Leanne|Sincere@april\.biz/.test(shape.text)) f.push('get_body_shape returned values');

        // get_request snippets (redacted view).
        for (const fmt of ['curl', 'dart_http', 'dio']) {
          const g = await mcpCall('get_request', { id, snippet: fmt, includeBodies: false });
          const snip = String(g.result.snippet ?? '');
          if (g.isError || !snip.includes('jsonplaceholder.typicode.com/users/1')) f.push(`get_request snippet ${fmt}: ${g.text.slice(0, 200)}`);
          if (!snip.includes('[redacted]')) f.push(`snippet ${fmt} has no [redacted] auth header: ${snip.slice(0, 300)}`);
        }

        // resend_request: same origin works and is recorded as the agent's; another origin is refused.
        const rs = await mcpCall('resend_request', { id });
        const newId = rs.result.id as string | undefined;
        if (rs.isError || !newId) f.push(`resend_request: ${rs.text.slice(0, 200)}`);
        else {
          let g: any;
          for (let i = 0; i < 120; i++) {
            g = (await mcpCall('get_request', { id: newId, includeBodies: false })).result;
            if (g.state && !['pending', 'paused-request', 'paused-response'].includes(g.state)) break;
            await sleep(250);
          }
          if (g?.state !== 'completed' || g?.status !== 200 || g?.initiator !== 'agent' || g?.resentFrom !== id) f.push(`resent exchange: ${JSON.stringify(g).slice(0, 300)}`);
          notes.push(`resent ${id} -> ${newId} ${g?.state} ${g?.status}`);
        }
        const foreign = await mcpCall('resend_request', { id, edit: { url: 'https://example.com/' } });
        if (!foreign.isError || !/must keep the original origin/.test(foreign.text)) f.push(`resend to a foreign origin not refused: ${foreign.text.slice(0, 200)}`);
        // REVIEW-3 #1: an exchange a rule handled (here: a mocked one) is never resent.
        const mk = await mcpCall('add_mock', { url: 'https://jsonplaceholder.typicode.com/users/2', body: { m: 1 }, times: 1 });
        const restart2 = Date.now();
        await mcpCall('hot_restart', { sessionId });
        const mw = await mcpCall('wait_for_request', { url: 'https://jsonplaceholder.typicode.com/users/2', sinceMs: restart2, timeoutMs: 60_000 });
        if (mw.result.state === 'mocked') {
          const rm = await mcpCall('resend_request', { id: mw.result.id });
          if (!rm.isError || !/handled by rule/.test(rm.text)) f.push(`resend of a mocked exchange not refused: ${rm.text.slice(0, 200)}`);
        } else f.push(`users/2 was not mocked: ${mw.text.slice(0, 200)}`);
        if (mk.result.ruleId) await mcpCall('remove_rule', { ruleId: mk.result.ruleId });

        // Global network profile: visible in get_status and in the UI status.
        const slow = await mcpCall('simulate_network', { profile: 'slow-3g' });
        if (slow.isError || slow.result.profile?.label !== 'Slow 3G') f.push(`simulate_network slow-3g: ${slow.text.slice(0, 200)}`);
        const st = (await mcpCall('get_status')).result;
        if (st.networkProfile?.preset !== 'slow-3g') f.push(`get_status networkProfile: ${JSON.stringify(st.networkProfile)}`);
        if ((api.controller.status() as any).networkProfile?.preset !== 'slow-3g') f.push('UI status lacks the network profile');
        const none = await mcpCall('simulate_network', { profile: 'none' });
        if (none.isError || none.result.profile?.kind !== 'none') f.push(`simulate_network none: ${none.text.slice(0, 200)}`);
        if ((api.controller.status() as any).networkProfile) f.push('UI status still shows a profile after "none"');

        // url-scoped fault, times: 1 → the next users/1 fails, then the host removes the spent rule.
        const fault = await mcpCall('simulate_network', { url: USERS1, method: 'GET', fault: 'reset', times: 1 });
        const faultRule = fault.result.ruleId as string | undefined;
        if (fault.isError || !faultRule) f.push(`simulate_network fault: ${fault.text.slice(0, 200)}`);
        else {
          const r = (await rulesNow()).find((x) => x.id === faultRule);
          if (!r || r.times !== 1 || !r.name?.startsWith('[agent] ') || (r.action as any).fault !== 'reset') f.push(`fault rule: ${JSON.stringify(r)}`);
          const restartAt = Date.now();
          const h = await mcpCall('hot_restart', { sessionId });
          if (h.isError) f.push(`hot_restart: ${h.text.slice(0, 200)}`);
          const wf = await mcpCall('wait_for_request', { url: USERS1, method: 'GET', sinceMs: restartAt, timeoutMs: 90_000 });
          if (wf.isError || wf.result.timedOut || wf.result.state !== 'blocked' || !wf.result.simulated) f.push(`faulted users/1: ${wf.text.slice(0, 300)}`);
          if (!(await gone(faultRule, 10_000))) f.push('spent fault rule (times: 1) was not removed');
          notes.push(`fault -> ${wf.result.state} "${wf.result.simulated ?? ''}"`);
        }

        // add_mock with ttlMs: expires (and is removed) without any traffic.
        const m = await mcpCall('add_mock', { url: 'https://jsonplaceholder.typicode.com/never-called*', body: { x: 1 }, ttlMs: 2000 });
        const mockRule = m.result.ruleId as string | undefined;
        if (m.isError || !mockRule) f.push(`add_mock ttlMs: ${m.text.slice(0, 200)}`);
        else if (!(await gone(mockRule, 15_000))) f.push('expired add_mock rule (ttlMs: 2000) was not removed');

        const s2 = await mcpCall('stop_app', { sessionId });
        if (s2.isError || s2.result.stopped !== 1) f.push(`stop_app: ${s2.text.slice(0, 200)}`);
        else sessionId = undefined;
        out.output = notes.join('; ');
      } catch (e) {
        f.push(`exception: ${(e as Error).message}`);
      } finally {
        if (sessionId) await launcher.stop(sessionId).catch(() => undefined);
        await mcpCall('simulate_network', { profile: 'none' }).catch(() => undefined);
        await client?.close().catch(() => undefined);
        client = undefined;
      }
      out.ms = Date.now() - t0;
      results.push(out);
      console.log(`[suite] ${f.length ? 'FAIL' : 'ok  '} ${out.name} (${out.ms} ms)${f.length ? '\n         ' + f.join('\n         ') : ''}\n         ${out.output}`);
    }

    // Access: readOnly blocks writes on both doors; off stops the MCP server.
    {
      const out: RunOutcome = { name: 'AGENT access: readOnly blocks add_mock (LM + MCP), off stops MCP', output: '', proxyHits: [], failures: [], ms: 0 };
      const f = out.failures;
      const agentCfg = vscode.workspace.getConfiguration('flutterIntercept');
      try {
        await agentCfg.update('agent.access', 'readOnly', vscode.ConfigurationTarget.Global);
        await sleep(500);
        const before = api.getRules().length;
        // The "direct" path (host without usable LM tools, e.g. Cursor) uses the suite's own adapter, not the
        // extension's AgentApi, so the access setting can only be checked on the real LM door.
        let lmMsg = viaLm ? 'not rejected' : 'n/a (no LM tools in this host)';
        if (viaLm) {
          try {
            await tool('add_mock', { url: 'https://example.com/ro', body: 'x' });
          } catch (e) {
            lmMsg = (e as Error).message;
          }
          if (!/access|read-?only/i.test(lmMsg)) f.push(`LM add_mock under readOnly: ${lmMsg}`);
        }
        client = await connect();
        const m = await mcpCall('add_mock', { url: 'https://example.com/ro', body: 'x' });
        if (!m.isError || !/access|read-?only/i.test(m.text)) f.push(`MCP add_mock under readOnly: isError=${m.isError} ${m.text.slice(0, 200)}`);
        const sn = await mcpCall('simulate_network', { profile: 'offline' });
        if (!sn.isError || !/access|read-?only/i.test(sn.text)) f.push(`MCP simulate_network under readOnly: isError=${sn.isError} ${sn.text.slice(0, 200)}`);
        if ((api.controller.status() as any).networkProfile) f.push('a network profile was set under readOnly');
        const st = await mcpCall('get_status');
        if (st.isError) f.push(`MCP get_status under readOnly: ${st.text.slice(0, 200)}`);
        await client.close().catch(() => undefined);
        client = undefined;
        if (api.getRules().length !== before) f.push('a rule was added under readOnly');
        out.output = `readOnly: LM -> "${lmMsg.slice(0, 100)}"; MCP -> "${m.text.slice(0, 100)}"`;

        await agentCfg.update('agent.access', 'off', vscode.ConfigurationTarget.Global);
        let refused = false;
        for (let i = 0; i < 40 && !refused; i++) {
          try {
            await fetch(url, { method: 'POST', headers: { authorization: `Bearer ${token}` }, body: '{}' });
            await sleep(250);
          } catch {
            refused = true;
          }
        }
        if (!refused) f.push('MCP server still answering 10 s after access=off');
        if (mcpAccess.url) f.push(`mcp url still set with access=off: ${mcpAccess.url}`);
        let offMsg = viaLm ? 'not rejected' : 'n/a (no LM tools in this host)';
        if (viaLm) {
          try {
            await tool('get_status');
          } catch (e) {
            offMsg = (e as Error).message;
          }
          if (!/off|access/i.test(offMsg)) f.push(`LM get_status with access=off: ${offMsg}`);
        }
        out.output += `; off: MCP refused=${refused}, LM -> "${offMsg.slice(0, 100)}"`;
      } catch (e) {
        f.push(`exception: ${(e as Error).message}`);
      } finally {
        await agentCfg.update('agent.access', undefined, vscode.ConfigurationTarget.Global);
      }
      results.push(out);
      console.log(`[suite] ${f.length ? 'FAIL' : 'ok  '} ${out.name}${f.length ? '\n         ' + f.join('\n         ') : ''}\n         ${out.output}`);
    }
  }

  // Redaction: the real header values never appear in anything a tool returned (both doors).
  {
    const leaked = SECRETS.filter((sec) => allOutputs.some((o) => o.includes(sec)));
    const out: RunOutcome = { name: `AGENT redaction: secrets absent from all ${allOutputs.length} tool outputs`, output: '', proxyHits: [], failures: leaked.map((l) => `leaked ${l}`), ms: 0 };
    if (!allOutputs.length) out.failures.push('no tool outputs collected');
    results.push(out);
    console.log(`[suite] ${out.failures.length ? 'FAIL' : 'ok  '} ${out.name}${out.failures.length ? ' ' + out.failures.join(', ') : ''}`);
  }

  for (const d of suiteSubs) d.dispose();
  launcher.dispose();
  return results;
}
