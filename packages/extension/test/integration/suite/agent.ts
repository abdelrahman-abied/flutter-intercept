/**
 * Agent suite (FI_SUITE=agent): the agent tools that launch/drive the app, against samples/demo_app in
 * place, in a real VS Code with the real Dart-Code. Devices: FI_AGENT_DEVICES (default "macos").
 *
 * Per device: get_status → launch_app → wait_for_request(GET users/1) → add_mock(users/1) →
 * hot_restart → the restarted app prints the mocked body → remove_rule → stop_app.
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
import { activateBoth, freePort, outputOf, registerOutputTracker, RunOutcome, sleep, waitFor } from './helpers';

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
      console.log(`[suite] agent wait_for_request -> ${JSON.stringify(waited)} at +${Date.now() - since} ms`);

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
  for (const d of suiteSubs) d.dispose();
  launcher.dispose();
  return results;
}
