/**
 * Runs INSIDE the VS Code extension host (no mocha: a tiny sequential runner).
 *
 * Gate: with the real Dart-Code, is the FINAL launched configuration (what the debug adapter
 * receives, observed via onDidStartDebugSession) using our generated entry, and does the app's
 * traffic reach the proxy with its output intact? Every scenario runs in both provider orders:
 *   "natural":  Dart-Code registered first (extensionDependencies) -> our hook runs after it.
 *   "reloaded": after Dart-Code's in-process silent restart (`_dart.reloadExtension`), its
 *               provider is re-registered after ours -> our hook runs BEFORE it.
 */
import * as fs from 'fs';
import { runAgentSuite } from './agent';
import { runClaudeSuite } from './claude';
import { runDartSuite } from './dart';
import { runDevicesSuite } from './devices';
import { runFlutterSuite } from './flutter';
import { RunOutcome } from './helpers';

export async function run(): Promise<void> {
  const suite = process.env.FI_SUITE ?? 'dart';
  const results: RunOutcome[] =
    suite === 'flutter' ? await runFlutterSuite() : suite === 'devices' ? await runDevicesSuite() : suite === 'agent' ? await runAgentSuite() : suite === 'claude' ? await runClaudeSuite() : await runDartSuite();
  const failed = results.filter((r) => r.failures.length);
  if (process.env.FI_RESULTS) {
    fs.writeFileSync(
      process.env.FI_RESULTS,
      JSON.stringify({ suite, total: results.length, failed: failed.length, results }, null, 2),
    );
  }
  console.log(`[suite] ${suite}: ${results.length - failed.length}/${results.length} runs passed`);
  if (failed.length) throw new Error(`${failed.length} run(s) failed: ${failed.map((f) => f.name).join(', ')}`);
}
