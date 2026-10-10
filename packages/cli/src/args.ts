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
                                 devices adb reverse, macOS / iOS simulators localhost. Physical iOS
                                 devices are not supported (LAN mode is editor-only).
  -p, --project <dir>            Flutter project root (default: nearest pubspec.yaml from the cwd).
      --port <n>                 Proxy port on 127.0.0.1 (default: a free port).
      --rules <file>             Shared rules file (default: .vscode/flutter-intercept.json when present).
      --no-rules                 Use no rules.
      --approve-shared-rules     Also apply shared rules that need approval in the editor (map remote to
                                 another host, request header rewrites, scripts, …). Without it they are
                                 skipped with the reason printed.
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
  -h, --help                     Show this help.
      --version                  Show the version.

Everything after -- goes to flutter unchanged (e.g. -- --flavor dev --dart-define=API=staging).

Exit code: flutter's when it fails; else 1 when an assertion failed; else 0. 2 = usage or setup error,
130/143 = interrupted.

Examples:
  flutter-intercept test -d emulator-5554 --har build/traffic.har --assert ci/expect.json --junit build/assert.xml
  flutter-intercept test integration_test/login_test.dart -d macos --replay login --replay-fallback fail
  flutter-intercept run -d macos --network-profile slow-3g`;

type ValueKey = 'project' | 'device' | 'port' | 'rules' | 'replay' | 'replayFallback' | 'networkProfile' | 'har' | 'record' | 'assert' | 'junit' | 'flutter';
type FlagKey = 'noRules' | 'approveSharedRules' | 'noRedact' | 'help' | 'version';

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
};

const FLAG_OPTIONS: Record<string, FlagKey> = {
  '--no-rules': 'noRules',
  '--approve-shared-rules': 'approveSharedRules',
  '--no-redact': 'noRedact',
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
  return { kind: 'options', options };
}
