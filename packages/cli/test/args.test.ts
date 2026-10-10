import { describe, expect, it } from 'vitest';
import { HELP, parseArgs, UsageError } from '../src/args';

const opts = (argv: string[]) => {
  const r = parseArgs(argv);
  if (r.kind !== 'options') throw new Error(`expected options, got ${r.kind}`);
  return r.options;
};

describe('parseArgs', () => {
  it('parses test with targets, options and the -- passthrough', () => {
    const o = opts(['test', 'integration_test/a_test.dart', '-d', 'emulator-5554', '--port=9100', '--har', 'out.har', '--', '--flavor', 'dev', '--dart-define=X=1']);
    expect(o).toEqual({
      command: 'test',
      targets: ['integration_test/a_test.dart'],
      device: 'emulator-5554',
      port: 9100,
      har: 'out.har',
      flutterArgs: ['--flavor', 'dev', '--dart-define=X=1'],
    });
  });

  it('accepts options before the command and every documented option', () => {
    const o = opts([
      '-p', 'app', 'run', 'lib/main_dev.dart', '--device', 'macos', '--rules', 'ci/rules.json', '--approve-shared-rules',
      '--replay', 'login', '--replay-fallback', 'fail', '--network-profile', 'slow-3g', '--record', 'ci-run',
      '--assert', 'expect.json', '--junit', 'junit.xml', '--no-redact', '--flutter', '/opt/flutter/bin/flutter',
    ]);
    expect(o).toMatchObject({
      command: 'run', project: 'app', targets: ['lib/main_dev.dart'], device: 'macos', rules: 'ci/rules.json', approveSharedRules: true,
      replay: 'login', replayFallback: 'fail', networkProfile: 'slow-3g', record: 'ci-run', assert: 'expect.json', junit: 'junit.xml',
      noRedact: true, flutter: '/opt/flutter/bin/flutter', flutterArgs: [],
    });
  });

  it('--no-rules sets rules to false', () => {
    expect(opts(['test', '--no-rules']).rules).toBe(false);
    expect(() => parseArgs(['test', '--no-rules', '--rules', 'x.json'])).toThrow(UsageError);
  });

  it('help and version', () => {
    expect(parseArgs(['--help'])).toEqual({ kind: 'help' });
    expect(parseArgs(['test', '-h'])).toEqual({ kind: 'help', command: 'test' });
    expect(parseArgs(['help'])).toEqual({ kind: 'help' });
    expect(parseArgs(['--version'])).toEqual({ kind: 'version' });
    expect(HELP).toContain('--approve-shared-rules');
  });

  it('keeps arguments after -- even when they look like ours', () => {
    expect(opts(['test', '--', '-d', 'x', '--har']).flutterArgs).toEqual(['-d', 'x', '--har']);
  });

  it.each([
    [[], /missing command/],
    [['build'], /unknown command "build"/],
    [['test', '--bogus'], /unknown option --bogus.*after --/],
    [['test', '-d'], /-d needs a value/],
    [['test', '--har='], /--har needs a value/],
    [['test', '--port', '0'], /--port must be/],
    [['test', '--port', '70000'], /--port must be/],
    [['test', '--port', '12ab'], /--port must be/],
    [['test', '--replay-fallback', 'fail'], /needs --replay/],
    [['test', '--replay', 'r', '--replay-fallback', 'maybe'], /passthrough or fail/],
    [['test', '--network-profile', '5g'], /must be one of offline, slow-3g, fast-3g, flaky/],
    [['test', '--junit', 'j.xml'], /--junit needs --assert/],
    [['test', '--no-redact=yes'], /takes no value/],
    [['test', '-d', 'a', '-d', 'b'], /given twice/],
  ])('rejects %j', (argv, message) => {
    expect(() => parseArgs(argv as string[])).toThrow(message as RegExp);
  });
});
