/**
 * `flutter-intercept test|run [targets…] [options] [-- flutter args]` (CONTRACTS §13.9). Dependency-free parser:
 * `--name value` and `--name=value`, short `-d` / `-p` / `-h`, `--` ends our options.
 */
import type { CliOptions } from './types';

export class UsageError extends Error {
  readonly name = 'UsageError';
}

export type ParsedArgs = { kind: 'help'; command?: CliOptions['command'] } | { kind: 'version' } | { kind: 'options'; options: CliOptions };

export const NETWORK_PROFILE_IDS = ['offline', 'slow-3g', 'fast-3g', 'flaky'] as const;

export const HELP = `Usage: flutter-intercept <command> [targets…] [options] [-- flutter args]

Runs a Flutter app or its integration tests through the Flutter Intercept proxy, headless (CI).
No app code changes: a generated entry point routes the app's dart:io traffic through a local proxy.

Commands:
  test [targets…]   Run integration tests through the proxy (flutter test -d <device>).
                    Targets: test files or directories (default: integration_test/).
  run [targets…]    Start the proxy, generate the entry for each target (default: lib/main.dart),
                    print the flutter command to use, and stop on Ctrl-C (SIGINT/SIGTERM).

Options:
  -d, --device <id>              Flutter device id. Android emulators use 10.0.2.2, physical Android
                                 devices adb reverse, macOS / iOS simulators localhost. A physical
                                 iPhone (test only) reaches a token-protected listener on this
                                 machine's LAN address for the length of the run.
  -p, --project <dir>            Flutter project root (default: nearest pubspec.yaml from the cwd).
      --port <n>                 Proxy port on 127.0.0.1 (default: a free port).
      --rules <file>             Shared rules file (default: .vscode/flutter-intercept.json when present).
      --no-rules                 Use no rules (also turns off collections linked in the shared file).
      --approve-shared-rules     Also apply shared rules that need approval in the editor (map remote to
                                 another host, request header rewrites, scripts, …). Without it they are
                                 skipped with the reason printed.
      --collection <file>        Mock from a Postman, OpenAPI 3, Swagger 2.0, Insomnia or Bruno
                                 (bruno.json) collection (repeatable; added after shared-file links).
      --collection-env <file>    Postman environment file, or environment name for Insomnia / Bruno.
      --collection-var k=v       Set a collection URL variable (repeatable, e.g. baseUrl=https://api.example.com).
      --collection-unmatched <m> Unmatched requests to a collection's host: passthrough (default) or fail.
      --collection-snapshot <s>  Start the collections' remembered data from a snapshot: a name (from
                                 .vscode/flutter-intercept/snapshots/<collection>/<name>.json) or a file.
      --no-collection-store      Collections answer only their saved examples (resources don't remember
                                 what the app sends; as in 0.15).
      --collection-seed <n>      Seed for dynamic values in seeded mode (0–4294967295; default 1).
      --collection-dynamic <m>   Dynamic values in collection examples: seeded (default), random or fixed.
      --collection-auth          Turn sign-in simulation on for the run (needs a login request).
      --collection-auth-ttl <s>  Sign-in session TTL in seconds (60–86400; default 3600).
      --record-collection <name> Write a collection from the run's traffic to
                                 .vscode/flutter-intercept/collections/<slug>.json (personal data replaced,
                                 never overwrites).
      --replay <id|file>         Answer requests from a recording (id in
                                 .dart_tool/flutter_intercept/recordings, or a file path).
      --replay-fallback <mode>   Unmatched requests while replaying: passthrough (default) or fail.
      --network-profile <id>     ${NETWORK_PROFILE_IDS.join(', ')}.
      --har <file>               Write a HAR of the run (secrets redacted unless --no-redact).
      --record <name|file>       Save the run as a recording (a name: saved in the project's recordings,
                                 a path ending in .json: written there). Not redacted (replay needs bodies).
      --assert <file>            Expectations: a JSON array of assert_traffic inputs
                                 ({url, method?, expect: {status?, count?, order?, json?, maxDurationMs?}},
                                 optional "name"). Any failure makes the exit code 1.
      --junit <file>             Write the assertion results as JUnit XML.
      --no-redact                Keep secrets in the HAR and in assertion texts.
      --flutter <path>           Flutter executable (default: $FLUTTER_ROOT/bin/flutter, else flutter on PATH).
      --grpc-decrypt-host <glob> Decrypt TLS gRPC to this host (repeatable). Only for apps that trust the
                                 Flutter Intercept CA in debug; other TLS gRPC is listed undecrypted.
      --no-grpc                  Let gRPC calls connect directly (not intercepted).
      --trust-simulator          iOS simulator only: trust this run's CA so TLS gRPC is decrypted; only that
                                 certificate is removed at the end of the run (or by the next run after a crash).
  -h, --help                     Show this help.
      --version                  Show the version.

Everything after -- goes to flutter unchanged (e.g. -- --flavor dev --dart-define=API=staging).

Exit code: flutter's when it fails; else 1 when an assertion failed; else 0. 2 = usage or setup error,
130/143 = interrupted.

Examples:
  flutter-intercept test -d emulator-5554 --har build/traffic.har --assert ci/expect.json --junit build/assert.xml
  flutter-intercept test integration_test/login_test.dart -d macos --replay login --replay-fallback fail
  flutter-intercept test -d macos --collection api/shop.postman_collection.json --collection-env api/dev.postman_environment.json
  flutter-intercept test -d macos --collection api/shop.postman_collection.json --collection-snapshot checkout
  flutter-intercept run -d macos --network-profile slow-3g`;

const COLLECTION_VAR_NAME = /^[A-Za-z0-9_.$-]{1,100}$/;
const MAX_COLLECTION_VAR_VALUE = 2048;
export const COLLECTION_DYNAMIC_MODES = ['random', 'seeded', 'fixed'] as const;
const MIN_AUTH_TTL_SECONDS = 60;
const MAX_AUTH_TTL_SECONDS = 86_400;
const MAX_COLLECTION_SEED = 0xffffffff;

type ValueKey =
  | 'project'
  | 'device'
  | 'port'
  | 'rules'
  | 'replay'
  | 'replayFallback'
  | 'networkProfile'
  | 'har'
  | 'record'
  | 'assert'
  | 'junit'
  | 'flutter'
  | 'collectionEnv'
  | 'collectionUnmatched'
  | 'collectionSnapshot'
  | 'collectionSeed'
  | 'collectionDynamic'
  | 'collectionAuthTtl'
  | 'recordCollection';
type FlagKey = 'noRules' | 'approveSharedRules' | 'noRedact' | 'noGrpc' | 'trustSimulator' | 'noCollectionStore' | 'collectionAuth' | 'help' | 'version';

const VALUE_OPTIONS: Record<string, ValueKey> = {
  '--project': 'project',
  '-p': 'project',
  '--device': 'device',
  '-d': 'device',
  '--device-id': 'device',
  '--port': 'port',
  '--rules': 'rules',
  '--replay': 'replay',
  '--replay-fallback': 'replayFallback',
  '--network-profile': 'networkProfile',
  '--har': 'har',
  '--record': 'record',
  '--assert': 'assert',
  '--junit': 'junit',
  '--flutter': 'flutter',
  '--collection-env': 'collectionEnv',
  '--collection-unmatched': 'collectionUnmatched',
  '--collection-snapshot': 'collectionSnapshot',
  '--collection-seed': 'collectionSeed',
  '--collection-dynamic': 'collectionDynamic',
  '--collection-auth-ttl': 'collectionAuthTtl',
  '--record-collection': 'recordCollection',
};

const FLAG_OPTIONS: Record<string, FlagKey> = {
  '--no-rules': 'noRules',
  '--approve-shared-rules': 'approveSharedRules',
  '--no-redact': 'noRedact',
  '--no-grpc': 'noGrpc',
  '--trust-simulator': 'trustSimulator',
  '--no-collection-store': 'noCollectionStore',
  '--collection-auth': 'collectionAuth',
  '--help': 'help',
  '-h': 'help',
  '--version': 'version',
};

function requireValue(name: string, value: string | undefined): string {
  if (value === undefined || value === '') throw new UsageError(`${name} needs a value`);
  return value;
}

export function parseArgs(argv: string[]): ParsedArgs {
  const values: Partial<Record<ValueKey, string>> = {};
  const flags = new Set<FlagKey>();
  const positionals: string[] = [];
  const grpcDecryptHosts: string[] = [];
  const collections: string[] = [];
  const collectionVars = new Map<string, string>();
  let flutterArgs: string[] = [];
  let command: CliOptions['command'] | undefined;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--') {
      flutterArgs = argv.slice(i + 1);
      break;
    }
    if (arg.startsWith('-') && arg !== '-') {
      const eq = arg.indexOf('=');
      const name = arg.startsWith('--') && eq > 0 ? arg.slice(0, eq) : arg;
      const inline = arg.startsWith('--') && eq > 0 ? arg.slice(eq + 1) : undefined;
      const flag = FLAG_OPTIONS[name];
      if (flag) {
        if (inline !== undefined) throw new UsageError(`${name} takes no value`);
        flags.add(flag);
        continue;
      }
      if (name === '--grpc-decrypt-host') {
        if (inline !== undefined) grpcDecryptHosts.push(requireValue(name, inline));
        else {
          grpcDecryptHosts.push(requireValue(name, argv[i + 1]));
          i++;
        }
        continue;
      }
      if (name === '--collection') {
        if (inline !== undefined) collections.push(requireValue(name, inline));
        else {
          collections.push(requireValue(name, argv[i + 1]));
          i++;
        }
        continue;
      }
      if (name === '--collection-var') {
        const raw = inline !== undefined ? requireValue(name, inline) : (i++, requireValue(name, argv[i]));
        const sep = raw.indexOf('=');
        if (sep <= 0) throw new UsageError('--collection-var must be name=value (e.g. --collection-var baseUrl=https://api.example.com)');
        const varName = raw.slice(0, sep);
        const varValue = raw.slice(sep + 1);
        if (!COLLECTION_VAR_NAME.test(varName)) throw new UsageError(`--collection-var: invalid variable name "${varName}"`);
        if (!varValue) throw new UsageError(`--collection-var ${varName}= needs a value`);
        if (varValue.length > MAX_COLLECTION_VAR_VALUE || /[\r\n\0]/.test(varValue)) {
          throw new UsageError(`--collection-var ${varName}: value must be one line of at most ${MAX_COLLECTION_VAR_VALUE} characters`);
        }
        collectionVars.set(varName, varValue);
        continue;
      }
      const key = VALUE_OPTIONS[name];
      if (!key) {
        throw new UsageError(`unknown option ${name} (flutter options go after --, e.g. flutter-intercept test -- ${arg})`);
      }
      let value: string;
      if (inline !== undefined) value = requireValue(name, inline);
      else {
        value = requireValue(name, argv[i + 1]);
        i++;
      }
      if (values[key] !== undefined && values[key] !== value) throw new UsageError(`${name} given twice`);
      values[key] = value;
      continue;
    }
    if (command === undefined) {
      if (arg === 'test' || arg === 'run') command = arg;
      else if (arg === 'help') flags.add('help');
      else throw new UsageError(`unknown command "${arg}" (use test or run)`);
      continue;
    }
    positionals.push(arg);
  }

  if (flags.has('help')) return { kind: 'help', ...(command ? { command } : {}) };
  if (flags.has('version')) return { kind: 'version' };
  if (!command) throw new UsageError('missing command (test or run)');

  const options: CliOptions = { command, targets: positionals, flutterArgs };
  if (values.project !== undefined) options.project = values.project;
  if (values.device !== undefined) options.device = values.device;
  if (values.port !== undefined) {
    const n = Number(values.port);
    if (!/^\d+$/.test(values.port) || !Number.isInteger(n) || n < 1 || n > 65535) throw new UsageError(`--port must be a number from 1 to 65535, got "${values.port}"`);
    options.port = n;
  }
  if (flags.has('noRules') && values.rules !== undefined) throw new UsageError('--rules and --no-rules cannot be combined');
  if (flags.has('noRules')) options.rules = false;
  else if (values.rules !== undefined) options.rules = values.rules;
  if (flags.has('approveSharedRules')) options.approveSharedRules = true;
  if (values.replay !== undefined) options.replay = values.replay;
  if (values.replayFallback !== undefined) {
    if (values.replayFallback !== 'passthrough' && values.replayFallback !== 'fail') {
      throw new UsageError(`--replay-fallback must be passthrough or fail, got "${values.replayFallback}"`);
    }
    if (values.replay === undefined) throw new UsageError('--replay-fallback needs --replay');
    options.replayFallback = values.replayFallback;
  }
  if (values.networkProfile !== undefined) {
    if (!(NETWORK_PROFILE_IDS as readonly string[]).includes(values.networkProfile)) {
      throw new UsageError(`--network-profile must be one of ${NETWORK_PROFILE_IDS.join(', ')}, got "${values.networkProfile}"`);
    }
    options.networkProfile = values.networkProfile;
  }
  if (values.har !== undefined) options.har = values.har;
  if (values.record !== undefined) options.record = values.record;
  if (values.assert !== undefined) options.assert = values.assert;
  if (values.junit !== undefined) options.junit = values.junit;
  if (values.junit !== undefined && values.assert === undefined) throw new UsageError('--junit needs --assert (the report lists the assertions)');
  if (flags.has('noRedact')) options.noRedact = true;
  if (values.flutter !== undefined) options.flutter = values.flutter;
  if (flags.has('noGrpc') && grpcDecryptHosts.length) throw new UsageError('--grpc-decrypt-host and --no-grpc cannot be combined');
  if (flags.has('noGrpc')) options.grpc = false;
  if (flags.has('trustSimulator')) {
    if (flags.has('noGrpc')) throw new UsageError('--trust-simulator and --no-grpc cannot be combined');
    options.trustSimulator = true;
  }
  if (grpcDecryptHosts.length) options.grpcDecryptHosts = [...new Set(grpcDecryptHosts)];
  if (collections.length) options.collections = collections;
  if (values.collectionEnv !== undefined) options.collectionEnv = values.collectionEnv;
  if (collectionVars.size) {
    const out: Record<string, string> = {};
    for (const [k, v] of collectionVars) Object.defineProperty(out, k, { value: v, enumerable: true, configurable: true, writable: true });
    options.collectionVars = out;
  }
  if (values.collectionUnmatched !== undefined) {
    if (values.collectionUnmatched !== 'passthrough' && values.collectionUnmatched !== 'fail') {
      throw new UsageError(`--collection-unmatched must be passthrough or fail, got "${values.collectionUnmatched}"`);
    }
    options.collectionUnmatched = values.collectionUnmatched;
  }
  // CONTRACTS §22.11: stateful mocks
  if (flags.has('noCollectionStore')) {
    if (values.collectionSnapshot !== undefined) throw new UsageError('--collection-snapshot and --no-collection-store cannot be combined');
    options.collectionStore = false;
  }
  if (values.collectionSnapshot !== undefined) {
    if (/[\0\r\n]/.test(values.collectionSnapshot) || values.collectionSnapshot.length > 1024) throw new UsageError('--collection-snapshot must be a snapshot name or a file path');
    options.collectionSnapshot = values.collectionSnapshot;
  }
  // CONTRACTS §24.1 / §24.3: dynamic values & sign-in simulation
  if (values.collectionDynamic !== undefined) {
    if (!(COLLECTION_DYNAMIC_MODES as readonly string[]).includes(values.collectionDynamic)) {
      throw new UsageError(`--collection-dynamic must be random, seeded or fixed, got "${values.collectionDynamic}"`);
    }
    options.collectionDynamic = values.collectionDynamic as CliOptions['collectionDynamic'];
  }
  if (values.collectionSeed !== undefined) {
    const n = Number(values.collectionSeed);
    if (!/^\d+$/.test(values.collectionSeed) || !Number.isInteger(n) || n < 0 || n > MAX_COLLECTION_SEED) {
      throw new UsageError(`--collection-seed must be a whole number from 0 to ${MAX_COLLECTION_SEED}, got "${values.collectionSeed}"`);
    }
    if (options.collectionDynamic !== undefined && options.collectionDynamic !== 'seeded') {
      throw new UsageError(`--collection-seed only applies to seeded mode (cannot be combined with --collection-dynamic ${options.collectionDynamic})`);
    }
    options.collectionSeed = n;
  }
  if (flags.has('collectionAuth')) options.collectionAuth = true;
  if (values.collectionAuthTtl !== undefined) {
    const n = Number(values.collectionAuthTtl);
    if (!/^\d+$/.test(values.collectionAuthTtl) || !Number.isInteger(n) || n < MIN_AUTH_TTL_SECONDS || n > MAX_AUTH_TTL_SECONDS) {
      throw new UsageError(`--collection-auth-ttl must be a whole number of seconds from ${MIN_AUTH_TTL_SECONDS} to ${MAX_AUTH_TTL_SECONDS}, got "${values.collectionAuthTtl}"`);
    }
    options.collectionAuthTtl = n;
  }
  // CONTRACTS §23.6: record a collection from the run's traffic
  if (values.recordCollection !== undefined) {
    const trimmed = values.recordCollection.trim();
    if (!trimmed || trimmed.length > 100 || /[\u0000-\u001f\u007f]/.test(trimmed)) {
      throw new UsageError('--record-collection must be a collection name (1–100 characters, one line)');
    }
    options.recordCollection = trimmed;
  }
  return { kind: 'options', options };
}
