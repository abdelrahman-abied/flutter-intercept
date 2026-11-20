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

  it('parses the gRPC options (CONTRACTS §16.6)', () => {
    expect(opts(['test', '--grpc-decrypt-host', 'grpc.example', '--grpc-decrypt-host=*.staging.example', '--grpc-decrypt-host', 'grpc.example']).grpcDecryptHosts)
      .toEqual(['grpc.example', '*.staging.example']);
    expect(opts(['test', '--no-grpc']).grpc).toBe(false);
    expect(opts(['test']).grpc).toBeUndefined();
    expect(() => parseArgs(['test', '--no-grpc', '--grpc-decrypt-host', 'a'])).toThrow(/cannot be combined/);
    expect(() => parseArgs(['test', '--grpc-decrypt-host'])).toThrow(/needs a value/);
  });

  it('parses --trust-simulator (CONTRACTS §19.3)', () => {
    expect(opts(['test', '--trust-simulator']).trustSimulator).toBe(true);
    expect(opts(['test']).trustSimulator).toBeUndefined();
    expect(() => parseArgs(['test', '--trust-simulator', '--no-grpc'])).toThrow(/cannot be combined/);
  });

  it('parses collection options and rejects invalid usage (CONTRACTS §21.11)', () => {
    const o = opts([
      'test',
      '--collection', 'api/shop.postman_collection.json',
      '--collection=api/extra.openapi.yaml',
      '--collection-env', 'api/dev.postman_environment.json',
      '--collection-var', 'baseUrl=https://api.shop.example',
      '--collection-var=token=a=b=c',
      '--collection-var', 'baseUrl=https://staging.shop.example',
      '--collection-unmatched', 'fail',
    ]);
    expect(o.collections).toEqual(['api/shop.postman_collection.json', 'api/extra.openapi.yaml']);
    expect(o.collectionEnv).toBe('api/dev.postman_environment.json');
    expect(o.collectionVars).toEqual({ baseUrl: 'https://staging.shop.example', token: 'a=b=c' });
    expect(o.collectionUnmatched).toBe('fail');
    expect(opts(['test', '--no-rules', '--collection', 'a.json']).rules).toBe(false);
    expect(opts(['test', '--collection-unmatched=passthrough']).collectionUnmatched).toBe('passthrough');

    expect(HELP).toContain('--collection <file>');
    expect(HELP).toContain('--collection-env <file>');
    expect(HELP).toContain('--collection-var');
    expect(HELP).toContain('--collection-unmatched');

    for (const [argv, pattern] of [
      [['test', '--collection'], /--collection needs a value/],
      [['test', '--collection='], /--collection needs a value/],
      [['test', '--collection-env'], /--collection-env needs a value/],
      [['test', '--collection-env', 'a.json', '--collection-env', 'b.json'], /given twice/],
      [['test', '--collection-var'], /--collection-var needs a value/],
      [['test', '--collection-var', 'noequals'], /must be name=value/],
      [['test', '--collection-var', '=https://a.example'], /must be name=value/],
      [['test', '--collection-var', 'bad name=https://a.example'], /invalid variable name/],
      [['test', '--collection-var', 'baseUrl='], /needs a value/],
      [['test', '--collection-var', `baseUrl=${'a'.repeat(2049)}`], /at most 2048/],
      [['test', '--collection-var', 'baseUrl=https://a.example\nfoo'], /one line/],
      [['test', '--collection-unmatched'], /--collection-unmatched needs a value/],
      [['test', '--collection-unmatched', 'block'], /passthrough or fail/],
    ] as [string[], RegExp][]) {
      expect(() => parseArgs(argv)).toThrow(UsageError);
      expect(() => parseArgs(argv)).toThrow(pattern);
    }
  });
});
