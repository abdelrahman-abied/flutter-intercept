/**
 * Dart CLI suite with the REAL proxy (InterceptProxy bundled in dist/extension.js).
 *
 * Part 1, F5 takeover (every scenario in both provider orders): final program is our entry, the
 * proxy recorded the fixture's request, the fixture's output is intact.
 * Part 2, proxy actions end to end through the extension's routing: mock, response breakpoint +
 * resume-with-edit (via the webview message path), block, createRuleFromExchange.
 * Part 3, webview: the panel is revealed on the first intercepted session, the real bundle loads
 * under the CSP, posts `ready`, and receives a `snapshot` (+ live `exchange` messages).
 */
import * as path from 'path';
import * as vscode from 'vscode';
import type { Exchange } from '@flutter-intercept/proxy';
import type { HostMsg } from '../../../src/ui/protocol';
import { activateBoth, freePort, registerOutputTracker, RunOutcome, runSession, sleep, startOrigin, waitFor } from './helpers';

export async function runDartSuite(): Promise<RunOutcome[]> {
  const fixture = process.env.FI_FIXTURE!;
  const runs = Number(process.env.FI_RUNS ?? '3');
  const results: RunOutcome[] = [];

  registerOutputTracker();
  const origin = await startOrigin();
  const proxyPort = await freePort(); // never 8899 (reserved for device runs)
  console.log(`[suite] origin :${origin.port} proxy port setting :${proxyPort} fixture ${fixture}`);

  const { api } = await activateBoth();
  const cfg = vscode.workspace.getConfiguration('flutterIntercept');
  await cfg.update('port', proxyPort, vscode.ConfigurationTarget.Global);
  await cfg.update('enabled', true, vscode.ConfigurationTarget.Global);
  if (api.proxyHost.running) throw new Error('proxy must start lazily, not on activation');
  // Rules persist in workspaceState; each run uses a fresh --user-data-dir, so nothing can leak in.
  if (api.getRules().length) throw new Error(`fresh profile has rules: ${JSON.stringify(api.getRules())}`);
  if (api.view.resolved) throw new Error('view resolved before any session');
  const folder = vscode.workspace.workspaceFolders![0];
  const base = `http://127.0.0.1:${origin.port}`;
  const entry = (b: string) => path.join(fixture, '.dart_tool', 'flutter_intercept', `entry_${b}.dart`);
  const exchangesFor = (u: string) => api.getExchanges().filter((e) => e.url === u);

  function record(out: RunOutcome) {
    results.push(out);
    console.log(
      `[suite] ${out.failures.length ? 'FAIL' : 'ok  '} ${out.name} (${out.ms} ms) dartCodeRanFirst=${out.dartCodeRanFirst} mode=${out.mode} ` +
        `program=${out.finalProgram ? path.relative(fixture, out.finalProgram) : out.finalProgram} debuggerType=${String(out.debuggerType)} exchanges=${out.proxyHits.join(',')}` +
        (out.failures.length ? `\n         ${out.failures.join('\n         ')}\n         output: ${JSON.stringify(out.output.slice(-600))}` : ''),
    );
  }

  /** Runs one session of bin/main.dart (or a scenario config) and checks the common gate assertions. */
  async function run(
    name: string,
    config: Record<string, unknown>,
    expect: { entryBase?: string; original?: string; tag: string; url: string; line?: string; state?: Exchange['state']; intercept?: boolean },
    opts: { eager?: boolean; during?: () => Promise<void> } = {},
  ): Promise<RunOutcome> {
    const out: RunOutcome = { name, output: '', proxyHits: [], failures: [], ms: 0 };
    const t0 = Date.now();
    try {
      let conf: vscode.DebugConfiguration = { type: 'dart', request: 'launch', name, ...config };
      if (opts.eager) conf = await api.prepare(folder, conf);
      const before = api.events.length;
      const during = opts.during?.();
      const { session, output } = await runSession(folder, conf);
      await during;
      const c = session.configuration;
      const ev = api.events.slice(before).find((e) => e.hook === 'resolveDebugConfigurationWithSubstitutedVariables');
      Object.assign(out, { finalProgram: c.program, originalProgram: c.flutterInterceptOriginalProgram, debuggerType: c.debuggerType, output, dartCodeRanFirst: ev?.dartCodeRanFirst, mode: ev?.mode ?? ev?.reason });
      await sleep(100);
      const seen = exchangesFor(expect.url);
      out.proxyHits = seen.map((e) => e.state);
      if (expect.intercept === false) {
        if (c.program === entry(expect.entryBase ?? 'bin__main')) out.failures.push('program rewritten although interception is off');
        if (seen.length) out.failures.push('proxy recorded a request although interception is off');
      } else {
        if (expect.entryBase && c.program !== entry(expect.entryBase)) out.failures.push(`(a) final program ${c.program} != ${entry(expect.entryBase)}`);
        if (expect.original && c.flutterInterceptOriginalProgram !== path.join(fixture, expect.original)) out.failures.push(`original ${c.flutterInterceptOriginalProgram}`);
        if (seen.length !== 1) out.failures.push(`(b) proxy exchanges for ${expect.url}: ${seen.length}`);
        else if (seen[0].state !== (expect.state ?? 'completed')) out.failures.push(`(b) exchange state ${seen[0].state} != ${expect.state ?? 'completed'}`);
      }
      const line = expect.line ?? `FIXTURE_RESPONSE[${expect.tag}] status=200 via=none body=hello-from-origin ${new URL(expect.url).pathname}${new URL(expect.url).search}`;
      if (!output.includes(line)) out.failures.push(`(c) missing output line: ${line}`);
      if (!output.includes(`FIXTURE_DONE[${expect.tag}]`)) out.failures.push('(c) FIXTURE_DONE missing');
    } catch (e) {
      out.failures.push(`exception: ${(e as Error).message}`);
    }
    out.ms = Date.now() - t0;
    record(out);
    return out;
  }

  const bin = (u: string) => ({ program: 'bin/main.dart', cwd: fixture, args: [u] });
  const binExpect = { entryBase: 'bin__main', original: 'bin/main.dart', tag: 'bin/main' };

  // ---------- Part 1: F5 takeover in both provider orders ----------
  type Scenario = { id: string; original: string; entryBase: string; tag: string; build: (u: string) => Record<string, unknown>; eager?: boolean };
  const scenarios: Scenario[] = [
    { id: 'program-bin-main', original: 'bin/main.dart', entryBase: 'bin__main', tag: 'bin/main', build: (u) => ({ program: 'bin/main.dart', cwd: fixture, args: [u] }) },
    { id: 'no-program-default', original: 'bin/main.dart', entryBase: 'bin__main', tag: 'bin/main', build: (u) => ({ args: [u] }) },
    { id: 'program-noargs-async', original: 'bin/noargs.dart', entryBase: 'bin__noargs', tag: 'bin/noargs', build: (u) => ({ program: '${workspaceFolder}/bin/noargs.dart', env: { FIXTURE_URL: u } }) },
    { id: 'program-lib-void-async', original: 'lib/app_main.dart', entryBase: 'lib__app_main', tag: 'lib/app_main', build: (u) => ({ program: 'lib/app_main.dart', cwd: fixture, env: { FIXTURE_URL: u } }) },
    { id: 'eager-command-path', eager: true, original: 'bin/main.dart', entryBase: 'bin__main', tag: 'bin/main', build: (u) => ({ program: 'bin/main.dart', cwd: fixture, args: [u] }) },
  ];
  const runScenario = (phase: string, s: Scenario, i: number) => {
    const name = `FI ${phase} ${s.id} #${i}`;
    const u = `${base}/hello?run=${encodeURIComponent(name)}`;
    return run(name, s.build(u), { entryBase: s.entryBase, original: s.original, tag: s.tag, url: u }, { eager: s.eager });
  };

  for (let i = 1; i <= runs; i++) {
    for (const s of scenarios) {
      await runScenario('natural', s, i);
      if (i === 1 && s === scenarios[0]) await checkWebview();
    }
  }

  // ---------- Part 2: proxy actions through the extension ----------
  const viewSink: HostMsg[] = [];
  const reply = (m: HostMsg) => viewSink.push(m);

  // Mock: rule set through the same path as the webview's setRules.
  {
    const u = `${base}/mock/item?run=1`;
    api.setRules([{ id: 'mock1', enabled: true, match: { method: 'GET', url: `${base}/mock/*` }, action: { kind: 'mock', status: 200, headers: { 'content-type': 'text/plain' }, body: 'MOCKED-BODY' } }]);
    const hitsBefore = origin.hits('/mock/item');
    const r = await run('FI action mock', bin(u), { ...binExpect, url: u, state: 'mocked', line: 'FIXTURE_RESPONSE[bin/main] status=200 via=none body=MOCKED-BODY' });
    if (origin.hits('/mock/item') !== hitsBefore) r.failures.push('mock contacted the origin');
  }

  // Response breakpoint: pause, check the paused count, resume with an edit via the webview message path.
  {
    const u = `${base}/bp/item?run=1`;
    api.setRules([{ id: 'bp1', enabled: true, match: { url: `${base}/bp/*` }, action: { kind: 'breakpoint', phase: 'response' } }]);
    let pausedSeen = 0;
    let pausedCountSeen = 0;
    const during = async () => {
      const paused = await waitFor(() => api.getExchanges().find((e) => e.url === u && e.state === 'paused-response'), 60_000);
      pausedSeen++;
      pausedCountSeen = api.controller.pausedCount;
      if (paused.responseBody?.text !== `hello-from-origin /bp/item?run=1`) throw new Error(`paused body ${paused.responseBody?.text}`);
      await api.controller.handle({ type: 'resume', id: paused.id, edit: { status: 299, body: 'EDITED-BODY' } }, reply);
    };
    const r = await run('FI action breakpoint+edit', bin(u), { ...binExpect, url: u, line: 'FIXTURE_RESPONSE[bin/main] status=299 via=none body=EDITED-BODY' }, { during });
    if (pausedSeen !== 1) r.failures.push('never paused');
    if (pausedCountSeen !== 1) r.failures.push(`paused count while paused = ${pausedCountSeen}`);
    if (api.controller.pausedCount !== 0) r.failures.push(`paused count after resume = ${api.controller.pausedCount}`);
  }

  // Block (status mode, default 403).
  {
    const u = `${base}/blocked/item?run=1`;
    api.setRules([{ id: 'blk', enabled: true, match: { url: `${base}/blocked/*` }, action: { kind: 'block', mode: 'status', status: 403 } }]);
    await run('FI action block', bin(u), { ...binExpect, url: u, state: 'blocked', line: 'FIXTURE_RESPONSE[bin/main] status=403 via=none body=Blocked by Flutter Intercept' });
  }

  // createRuleFromExchange (webview path): pass through once, create a block rule from it, run again.
  {
    api.setRules([]);
    const u = `${base}/cr/item?run=1`;
    await run('FI action create-rule (before)', bin(u), { ...binExpect, url: u });
    const ex = exchangesFor(u)[0];
    viewSink.length = 0;
    await api.controller.handle({ type: 'createRuleFromExchange', id: ex.id, action: 'block' }, reply);
    const rules = api.getRules();
    const out: RunOutcome = { name: 'FI action create-rule (rule)', output: '', proxyHits: [], failures: [], ms: 0 };
    if (rules[0]?.match.url !== `${base}/cr/item*` || rules[0]?.action.kind !== 'block') out.failures.push(`rule ${JSON.stringify(rules[0])}`);
    if (viewSink.some((m) => m.type === 'error')) out.failures.push(`error: ${JSON.stringify(viewSink)}`);
    record(out);
    api.controller.clear();
    await run('FI action create-rule (after)', bin(u), { ...binExpect, url: u, state: 'blocked', line: 'FIXTURE_RESPONSE[bin/main] status=403 via=none body=Blocked by Flutter Intercept' });
    api.setRules([]);
  }

  // Interception off: launches untouched, nothing recorded.
  await cfg.update('enabled', false, vscode.ConfigurationTarget.Global);
  {
    const u = `${base}/hello?run=disabled`;
    await run('FI disabled program-bin-main', bin(u), { ...binExpect, url: u, intercept: false });
  }
  await cfg.update('enabled', true, vscode.ConfigurationTarget.Global);

  // ---------- Part 1 again after Dart-Code's silent restart (our hook now runs first) ----------
  console.log('[suite] executing _dart.reloadExtension (Dart-Code in-process restart)');
  await vscode.commands.executeCommand('_dart.reloadExtension', 'flutter-intercept-test');
  await sleep(3000);
  for (let i = 1; i <= runs; i++) for (const s of scenarios) await runScenario('reloaded', s, i);

  origin.server.close();
  return results;

  // ---------- Part 3: webview ----------
  async function checkWebview() {
    const out: RunOutcome = { name: 'FI webview reveal+ready+snapshot', output: '', proxyHits: [], failures: [], ms: 0 };
    const t0 = Date.now();
    try {
      // Revealed (preserveFocus) by the first intercepted session -> resolves -> the real bundle runs under the CSP and posts `ready`.
      await waitFor(() => api.view.resolved || undefined, 20_000).catch(() => out.failures.push('view not revealed by the first session'));
      await waitFor(() => (api.controller.readyCount > 0 ? true : undefined), 20_000).catch(() => out.failures.push('webview never posted ready'));
      await waitFor(() => ((api.controller.sentCounts.snapshot ?? 0) > 0 ? true : undefined), 5_000).catch(() => out.failures.push('no snapshot sent'));
      if (!api.proxyHost.running) out.failures.push('proxy not running after the first session');
      // openPanel focuses it (no new resolve needed) and live exchange messages flow to the view.
      await vscode.commands.executeCommand('flutterIntercept.openPanel');
      const before = api.controller.sentCounts.exchange ?? 0;
      const u = `${base}/hello?run=webview`;
      await run('FI webview live session', bin(u), { ...binExpect, url: u });
      await sleep(200);
      if ((api.controller.sentCounts.exchange ?? 0) <= before) out.failures.push('no exchange messages posted to the view');
      out.mode = `resolves=${api.view.resolveCount} ready=${api.controller.readyCount} sent=${JSON.stringify(api.controller.sentCounts)}`;
    } catch (e) {
      out.failures.push(`exception: ${(e as Error).message}`);
    }
    out.ms = Date.now() - t0;
    record(out);
  }
}
