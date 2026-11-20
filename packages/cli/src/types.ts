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
  /** CONTRACTS §16.6: `--no-grpc` = false (the entry connects gRPC directly). Default true. */
  grpc?: boolean;
  /** CONTRACTS §16.6: TLS gRPC hosts to decrypt (`--grpc-decrypt-host`, repeatable). */
  grpcDecryptHosts?: string[];
  /** CONTRACTS §19.3: make the iOS simulator trust this run's CA (`--trust-simulator`); removed at the end of the run. */
  trustSimulator?: boolean;
  /** CONTRACTS §21.11: collection files to mock from (`--collection`, repeatable; added after any in the shared file). */
  collections?: string[];
  /** CONTRACTS §21.11: Postman environment file for URL variables (`--collection-env`). */
  collectionEnv?: string;
  /** CONTRACTS §21.11: URL variables for collections (`--collection-var name=value`, repeatable). */
  collectionVars?: Record<string, string>;
  /** CONTRACTS §21.11: unmatched requests for collections (`--collection-unmatched passthrough|fail`). */
  collectionUnmatched?: 'passthrough' | 'fail';
  /** CONTRACTS §22.11: `--no-collection-store` = false (collections answer only their examples, as in 0.15). Default true. */
  collectionStore?: boolean;
  /** CONTRACTS §22.11: `--collection-snapshot <name|file>`: the remembered data starts from this snapshot. */
  collectionSnapshot?: string;
  /** CONTRACTS §24.3: `--collection-seed <n>` (seeded mode; default 1). */
  collectionSeed?: number;
  /** CONTRACTS §24.3: `--collection-dynamic random|seeded|fixed` (CLI default: `seeded`). */
  collectionDynamic?: 'random' | 'seeded' | 'fixed';
  /** CONTRACTS §24.1: `--collection-auth`: turn sign-in simulation on for the run. */
  collectionAuth?: boolean;
  /** CONTRACTS §24.1: `--collection-auth-ttl <60-86400>`: sign-in session TTL in seconds. */
  collectionAuthTtl?: number;
  /** CONTRACTS §23.6: `--record-collection <name>`: write a collection from the run's traffic. */
  recordCollection?: string;
}

export interface CliResult {
  /** Process exit code: flutter's when it fails, else 1 if an assertion failed, else 0. */
  exitCode: number;
  exchanges: number;
  assertions: { passed: number; failed: number };
  outputs: { har?: string; record?: string; junit?: string; collection?: string };
  /** CONTRACTS §22.11: the final count of each remembered resource (absent when no collection remembers data). */
  stores?: { collection: string; resource: string; records: number; created: number; updated: number; deleted: number }[];
  /** CONTRACTS §24.1: collections with sign-in simulation on and their active session counts at the end of the run. */
  auth?: { collection: string; sessions: number }[];
}
