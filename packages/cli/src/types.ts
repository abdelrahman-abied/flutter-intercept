/**
 * Headless / CI mode (CONTRACTS §13.9). Shared types, lead-owned. Implemented in packages/cli/src/**.
 * Reuses the vscode-free extension modules (entry generator, CA, shared rules core, recordings, assertions).
 */

export interface CliOptions {
  /** `test` = `flutter test <integration test>` through the proxy; `run` = start the proxy only and print the define. */
  command: 'test' | 'run';
  /** Flutter project root (default: nearest pubspec.yaml from cwd). */
  project?: string;
  /** Integration test target(s), e.g. integration_test/app_test.dart (default: integration_test/). */
  targets: string[];
  /** Flutter device id (-d). Android emulators get 10.0.2.2, physical Android adb reverse; a physical iPhone gets the LAN listener (CONTRACTS §14.1). */
  device?: string;
  /** Proxy port (default: a free port). */
  port?: number;
  /** Shared rules file (default `.vscode/flutter-intercept.json` when present; `--no-rules` = none). */
  rules?: string | false;
  /** Rules that need approval in the editor (CONTRACTS §12.1, §13.4) are skipped unless this is set. */
  approveSharedRules?: boolean;
  /** Replay a recording (`.dart_tool/flutter_intercept/recordings/<id>.json` or a path). */
  replay?: string;
  replayFallback?: 'passthrough' | 'fail';
  /** Network profile preset id (offline, slow-3g, …). */
  networkProfile?: string;
  /** Write a HAR of the run (redacted unless `noRedact`). */
  har?: string;
  /** Save the run as a recording (replayable). */
  record?: string;
  /** Expectations file: JSON array of `assert_traffic` inputs (CONTRACTS §10.6); any failure → exit code 1. */
  assert?: string;
  /** Write a JUnit XML report of the assertions. */
  junit?: string;
  noRedact?: boolean;
  /** Extra args passed to `flutter test` after `--`. */
  flutterArgs: string[];
  /** Flutter executable (default `flutter` on PATH, or $FLUTTER_ROOT/bin/flutter). */
  flutter?: string;
}

export interface CliResult {
  /** Process exit code: flutter's when it fails, else 1 if an assertion failed, else 0. */
  exitCode: number;
  exchanges: number;
  assertions: { passed: number; failed: number };
  outputs: { har?: string; record?: string; junit?: string };
}
