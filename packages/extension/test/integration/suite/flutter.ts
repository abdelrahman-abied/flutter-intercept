/**
 * Flutter suite (macOS desktop device, so no emulator/phone is touched): proves that in BOTH
 * provider orders the final config uses our entry AND keeps Dart-Code's Flutter debugger
 * (debuggerType 2), and that the app's dart:io traffic reaches the proxy.
 *
 * Negative control: with interception off, launching the generated entry path directly makes
 * Dart-Code pick the plain Dart debugger (debuggerType 0) — the hazard that `debuggerType`
 * pinning in "before" mode exists for.
 */
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { activateBoth, freePort, registerOutputTracker, RunOutcome, runSession, sleep, startOrigin } from './helpers';

export async function runFlutterSuite(): Promise<RunOutcome[]> {
  const fixture = process.env.FI_FIXTURE!;
  const runs = Number(process.env.FI_FLUTTER_RUNS ?? '1');
  const results: RunOutcome[] = [];
  registerOutputTracker();
  const origin = await startOrigin();
  const proxyPort = await freePort();
  console.log(`[suite] origin :${origin.port} proxy port setting :${proxyPort} fixture ${fixture}`);
  const { api } = await activateBoth();
  const cfg = vscode.workspace.getConfiguration('flutterIntercept');
  await cfg.update('port', proxyPort, vscode.ConfigurationTarget.Global);
  await cfg.update('enabled', true, vscode.ConfigurationTarget.Global);
  const folder = vscode.workspace.workspaceFolders![0];
  const entry = path.join(fixture, '.dart_tool', 'flutter_intercept', 'entry_lib__main.dart');
  const original = path.join(fixture, 'lib', 'main.dart');

  // Give the Flutter daemon time to discover the macOS device (Dart-Code waits only 5 s for a deviceId).
  await sleep(10_000);

  const build = (name: string, u: string, program?: string): vscode.DebugConfiguration => ({
    type: 'dart',
    request: 'launch',
    name,
    program: program ?? 'lib/main.dart',
    deviceId: 'macos',
    suppressPrompts: true,
    toolArgs: [`--dart-define=FIXTURE_URL=${u}`],
  });

  async function startWithRetry(config: vscode.DebugConfiguration, opts: { timeoutMs?: number; stopAfterStart?: boolean }) {
    for (let attempt = 1; ; attempt++) {
      try {
        return await runSession(folder, config, opts);
      } catch (e) {
        if (attempt >= 3 || !String(e).includes('startDebugging returned false')) throw e;
        console.log(`[suite] ${config.name}: device not ready, retrying in 10 s`);
        await sleep(10_000);
      }
    }
  }

  async function runIntercepted(phase: string, i: number) {
    const name = `FI-F ${phase} #${i}`;
    const u = `http://127.0.0.1:${origin.port}/hello?run=${encodeURIComponent(name)}`;
    const out: RunOutcome = { name, output: '', proxyHits: [], failures: [], ms: 0 };
    const t0 = Date.now();
    try {
      const before = api.events.length;
      const rulesBefore = JSON.stringify(api.getRules());
      const { session, output } = await startWithRetry(build(name, u), { timeoutMs: 420_000 });
      const rulesAfter = JSON.stringify(api.getRules());
      if (rulesBefore !== '[]' || rulesAfter !== '[]') out.failures.push(`unexpected rules (before ${rulesBefore}, after ${rulesAfter}); events ${JSON.stringify(api.controller.sentCounts)} ready=${api.controller.readyCount}`);
      const conf = session.configuration;
      const ev = api.events.slice(before).find((e) => e.hook === 'resolveDebugConfigurationWithSubstitutedVariables');
      Object.assign(out, {
        finalProgram: conf.program,
        originalProgram: conf.flutterInterceptOriginalProgram,
        debuggerType: conf.debuggerType,
        output,
        proxyHits: api.getExchanges().filter((e) => e.url === u).map((e) => `${e.state} ${e.method} ${e.url}`),
        dartCodeRanFirst: ev?.dartCodeRanFirst,
        mode: ev?.mode ?? ev?.reason,
      });
      if (conf.program !== entry) out.failures.push(`(a) final program ${conf.program} != ${entry}`);
      if (conf.flutterInterceptOriginalProgram !== original) out.failures.push(`original ${conf.flutterInterceptOriginalProgram}`);
      if (conf.debuggerType !== 2) out.failures.push(`debuggerType ${conf.debuggerType} is not Flutter (2)`);
      // CONTRACTS §1: exactly one entry-hash define, matching the entry file actually launched.
      const sha = crypto.createHash('sha1').update(fs.readFileSync(entry)).digest('hex').slice(0, 12);
      const defines = ((conf.toolArgs ?? []) as string[]).filter((a) => a.includes('FLUTTER_INTERCEPT_ENTRY_SHA'));
      if (defines.length !== 1 || defines[0] !== `--dart-define=FLUTTER_INTERCEPT_ENTRY_SHA=${sha}`) out.failures.push(`sha define ${JSON.stringify(defines)} != ${sha}`);
      // CONTRACTS §2: macOS desktop -> localhost.
      if (conf.flutterInterceptProxyHost !== 'localhost') out.failures.push(`proxy host ${conf.flutterInterceptProxyHost}`);
      if (out.proxyHits.length !== 1) out.failures.push(`(b) proxy hits: ${out.proxyHits.length}`);
      if (!output.includes(`FIXTURE_RESPONSE[flutter] status=200 via=none body=hello-from-origin /hello?run=${encodeURIComponent(name)}`)) out.failures.push('(c) response line missing');
      if (!output.includes('FIXTURE_DONE[flutter]')) out.failures.push('(c) FIXTURE_DONE missing');
    } catch (e) {
      out.failures.push(`exception: ${(e as Error).message}`);
    }
    out.ms = Date.now() - t0;
    results.push(out);
    log(out);
  }

  function log(out: RunOutcome) {
    console.log(
      `[suite] ${out.failures.length ? 'FAIL' : 'ok  '} ${out.name} (${out.ms} ms) dartCodeRanFirst=${out.dartCodeRanFirst} mode=${out.mode} ` +
        `program=${out.finalProgram ? path.relative(fixture, out.finalProgram) : out.finalProgram} debuggerType=${String(out.debuggerType)} proxyHits=${out.proxyHits.length}` +
        (out.failures.length ? `\n         ${out.failures.join('\n         ')}\n         output: ${JSON.stringify(out.output.slice(-1500))}` : ''),
    );
  }

  for (let i = 1; i <= runs; i++) await runIntercepted('natural', i);

  // Negative control: interception off, program = generated entry, no debuggerType pin.
  {
    await cfg.update('enabled', false, vscode.ConfigurationTarget.Global);
    const name = 'FI-F control-unpinned';
    const out: RunOutcome = { name, output: '', proxyHits: [], failures: [], ms: 0 };
    const t0 = Date.now();
    try {
      const { session } = await startWithRetry(build(name, 'http://127.0.0.1:1/', entry), { timeoutMs: 60_000, stopAfterStart: true });
      out.finalProgram = session.configuration.program;
      out.debuggerType = session.configuration.debuggerType;
      out.mode = 'control';
      // Expected: Dart-Code classifies a .dart_tool/ program as plain Dart.
      if (out.debuggerType !== 0) out.failures.push(`expected Dart-Code to pick Dart (0) for an unpinned .dart_tool program, got ${out.debuggerType}`);
    } catch (e) {
      out.failures.push(`exception: ${(e as Error).message}`);
    }
    out.ms = Date.now() - t0;
    results.push(out);
    log(out);
    await cfg.update('enabled', true, vscode.ConfigurationTarget.Global);
    await sleep(2000);
  }

  console.log('[suite] executing _dart.reloadExtension (Dart-Code in-process restart)');
  await vscode.commands.executeCommand('_dart.reloadExtension', 'flutter-intercept-test');
  await sleep(15_000); // daemon restarts and rediscovers devices
  for (let i = 1; i <= runs; i++) await runIntercepted('reloaded', i);

  origin.server.close();
  return results;
}
