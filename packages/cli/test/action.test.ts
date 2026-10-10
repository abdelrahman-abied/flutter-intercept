import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { actionPlan, CLI_INPUTS, escapeCommandData, githubOutput, inputEnvName, readInputs, redactedCopyPath, runAction, splitList, type CliModule } from '../src/action';
import { writeRecording, writeRedactedRecordingCopy } from '../src/outputs';
import type { Exchange } from '@flutter-intercept/proxy';
import { parseYaml, type Yaml } from './yaml-subset';

const repo = path.join(__dirname, '..', '..', '..');
type Map = { [key: string]: Yaml };
const asMap = (v: Yaml | undefined): Map => {
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error(`not a mapping: ${JSON.stringify(v)}`);
  return v;
};
const asList = (v: Yaml | undefined): Yaml[] => {
  if (!Array.isArray(v)) throw new Error(`not a sequence: ${JSON.stringify(v)}`);
  return v;
};

/** CONTRACTS §14.1: the inputs the action must have. */
const SPEC_INPUTS = ['working-directory', 'device', 'targets', 'har', 'record', 'assert', 'junit', 'replay', 'network-profile', 'rules', 'approve-shared-rules', 'flutter-args'];
/** Inputs action.yml uses itself (not passed to the CLI). */
const YML_ONLY_INPUTS = ['working-directory', 'artifact-name', 'upload-artifacts'];

describe('yaml subset parser', () => {
  it('parses mappings, sequences, quoted and block scalars', () => {
    expect(
      parseYaml('a: 1\nb:\n  - x\n  - k: "q\\"s"\n    l: \'it\'\'s\'\nc: |\n  line 1\n    line 2\nd:\n# comment\ne: plain # trailing\nf:\n- y\n'),
    ).toEqual({ a: '1', b: ['x', { k: 'q"s', l: "it's" }], c: 'line 1\n  line 2\n', d: null, e: 'plain', f: ['y'] });
  });

  it('refuses YAML outside the subset', () => {
    expect(() => parseYaml('a: {b: 1}')).toThrow(/unsupported/);
    expect(() => parseYaml('a: [1]')).toThrow(/unsupported/);
    expect(() => parseYaml('a: &x 1')).toThrow(/unsupported/);
    expect(() => parseYaml('a: 1\na: 2')).toThrow(/duplicate key/);
    expect(() => parseYaml('a:\n\t- b')).toThrow(/tabs/);
    expect(() => parseYaml('a: 1\n   b: 2')).toThrow(/indentation/);
  });
});

describe('action.yml (CONTRACTS §14.1)', () => {
  const doc = asMap(parseYaml(fs.readFileSync(path.join(repo, 'action.yml'), 'utf8')));
  const inputs = asMap(doc.inputs);
  const outputs = asMap(doc.outputs);
  const runs = asMap(doc.runs);
  const steps = asList(runs.steps).map(asMap);
  const text = JSON.stringify(doc);

  it('is a composite action with a name, description and branding', () => {
    expect(Object.keys(doc).sort()).toEqual(['author', 'branding', 'description', 'inputs', 'name', 'outputs', 'runs']);
    expect(doc.name).toBe('Flutter Intercept');
    expect(typeof doc.description).toBe('string');
    expect(asMap(doc.branding)).toMatchObject({ icon: expect.any(String), color: expect.any(String) });
    expect(runs.using).toBe('composite');
  });

  it('has every input of the contract, each with a description and a string default', () => {
    for (const name of SPEC_INPUTS) expect(Object.keys(inputs)).toContain(name);
    for (const [name, spec] of Object.entries(inputs)) {
      const s = asMap(spec);
      expect(typeof s.description, name).toBe('string');
      expect(typeof (s.default ?? ''), name).toBe('string');
      expect(s.required ?? 'false', name).toBe('false');
    }
    expect(Object.keys(inputs).sort()).toEqual([...new Set([...CLI_INPUTS, ...YML_ONLY_INPUTS])].sort());
  });

  it('passes every CLI input as FI_INPUT_* env to the step that runs dist/action.js', () => {
    const run = steps.find((s) => s.id === 'run')!;
    expect(run.run).toBe('exec node "$GITHUB_ACTION_PATH/packages/cli/dist/action.js"');
    expect(run['working-directory']).toBe('${{ inputs.working-directory }}');
    const env = asMap(run.env);
    expect(Object.keys(env).sort()).toEqual(CLI_INPUTS.map(inputEnvName).sort());
    for (const name of CLI_INPUTS) expect(env[inputEnvName(name)]).toBe(`\${{ inputs.${name} }}`);
  });

  it('never interpolates expressions into scripts (script injection), and every run step names its shell', () => {
    for (const s of steps) {
      if (s.run === undefined) continue;
      expect(String(s.run), String(s.name)).not.toContain('${{');
      expect(s.shell, String(s.name)).toBe('bash');
    }
  });

  it('builds the CLI from the action checkout before running it', () => {
    const build = steps[0];
    expect(build['working-directory']).toBe('${{ github.action_path }}');
    const script = String(build.run);
    expect(script).toMatch(/^set -euo pipefail$/m);
    expect(script).toMatch(/^npm ci --no-audit --no-fund --ignore-scripts$/m);
    expect(script).toMatch(/^npm run build --workspace packages\/proxy$/m);
    expect(script).toMatch(/^npm run build --workspace packages\/cli$/m);
    expect(script.indexOf('build --workspace packages/proxy')).toBeLessThan(script.indexOf('build --workspace packages/cli'));
    expect(steps.findIndex((s) => s.id === 'run')).toBeGreaterThan(0);
  });

  it('uploads the outputs with actions/upload-artifact pinned to a major version, even when the run failed', () => {
    const upload = steps.find((s) => typeof s.uses === 'string' && s.uses.startsWith('actions/upload-artifact@'))!;
    expect(upload.uses).toMatch(/^actions\/upload-artifact@v\d+$/);
    expect(String(upload.if)).toMatch(/always\(\)/);
    expect(String(upload.if)).toContain("inputs.upload-artifacts == 'true'");
    const w = asMap(upload.with);
    expect(w.path).toBe('${{ steps.run.outputs.artifacts }}');
    expect(w.name).toBe('${{ inputs.artifact-name }}');
    expect(w['if-no-files-found']).toBe('ignore');
    for (const s of steps) if (typeof s.uses === 'string') expect(s.uses).toMatch(/^[\w-]+\/[\w-]+@v\d+$/);
  });

  it('references only declared inputs and step ids; outputs map to what dist/action.js writes', () => {
    const ids = new Set(steps.map((s) => s.id).filter((id): id is string => typeof id === 'string'));
    for (const m of text.matchAll(/inputs\.([\w-]+)/g)) expect(Object.keys(inputs), m[0]).toContain(m[1]);
    for (const m of text.matchAll(/steps\.([\w-]+)\./g)) expect([...ids], m[0]).toContain(m[1]);
    const written = ['artifacts', 'har', 'junit', 'record', 'exit-code'];
    for (const [name, spec] of Object.entries(outputs)) {
      const v = String(asMap(spec).value);
      expect(v).toBe(`\${{ steps.run.outputs.${name} }}`);
      expect(written).toContain(name);
    }
  });

  it('README workflow examples use the action with declared inputs only', () => {
    const readme = fs.readFileSync(path.join(__dirname, '..', 'README.md'), 'utf8');
    const blocks = [...readme.matchAll(/```yaml\n([\s\S]*?)```/g)].map((m) => m[1]);
    const uses: Map[] = [];
    for (const b of blocks) {
      const wf = asMap(parseYaml(b));
      for (const job of Object.values(asMap(wf.jobs))) {
        for (const step of asList(asMap(job).steps).map(asMap)) {
          if (typeof step.uses === 'string' && step.uses.startsWith('abdelrahman-abied/flutter-intercept')) uses.push(step);
        }
      }
    }
    expect(uses.length).toBeGreaterThanOrEqual(2);
    for (const step of uses) {
      expect(step.uses).toBe('abdelrahman-abied/flutter-intercept@v0.8.0');
      for (const k of Object.keys(asMap(step.with))) expect(Object.keys(inputs)).toContain(k);
    }
  });
});

describe('action entry (dist/action.js)', () => {
  it('splits list inputs: one per line, or on spaces in a single line', () => {
    expect(splitList(undefined)).toEqual([]);
    expect(splitList('--flavor dev')).toEqual(['--flavor', 'dev']);
    expect(splitList('--flavor dev\n')).toEqual(['--flavor', 'dev']);
    expect(splitList('--flavor\ndev\n--dart-define=MSG=hello world\n')).toEqual(['--flavor', 'dev', '--dart-define=MSG=hello world']);
  });

  it('reads FI_INPUT_* and builds the flutter-intercept test command', () => {
    const env = {
      FI_INPUT_DEVICE: 'emulator-5554',
      FI_INPUT_TARGETS: 'integration_test/a_test.dart integration_test/b_test.dart',
      FI_INPUT_HAR: 'build/traffic.har',
      FI_INPUT_ASSERT: 'ci/expect.json',
      FI_INPUT_JUNIT: 'build/junit.xml',
      FI_INPUT_RECORD: 'build/run.json',
      FI_INPUT_REPLAY: 'login',
      FI_INPUT_REPLAY_FALLBACK: 'fail',
      FI_INPUT_NETWORK_PROFILE: 'slow-3g',
      FI_INPUT_RULES: 'ci/rules.json',
      FI_INPUT_APPROVE_SHARED_RULES: 'true',
      FI_INPUT_FLUTTER_ARGS: '--flavor dev',
      FI_INPUT_UNKNOWN: 'x',
      FI_INPUT_HAR_EXTRA: '',
    };
    const plan = actionPlan(readInputs(env));
    expect(plan.argv).toEqual([
      'test', 'integration_test/a_test.dart', 'integration_test/b_test.dart',
      '--device=emulator-5554', '--har=build/traffic.har', '--record=build/run.json', '--assert=ci/expect.json', '--junit=build/junit.xml',
      '--replay=login', '--replay-fallback=fail', '--network-profile=slow-3g', '--rules=ci/rules.json', '--approve-shared-rules', '--', '--flavor', 'dev',
    ]);
    // REVIEW-8 #2: the (unredacted) recording is not uploaded by default
    expect(plan.artifacts).toEqual({ har: 'build/traffic.har', junit: 'build/junit.xml' });
    expect(plan.record).toBe('build/run.json');
    expect(plan.warnings).toEqual([]);
  });

  it('defaults: empty inputs → plain test; approve false; rules none → --no-rules; a recording name is not uploaded', () => {
    expect(actionPlan(readInputs({ FI_INPUT_DEVICE: '  ', FI_INPUT_APPROVE_SHARED_RULES: 'false' }))).toEqual({ argv: ['test'], artifacts: {}, warnings: [] });
    expect(actionPlan({ rules: 'none', record: 'nightly' })).toEqual({ argv: ['test', '--record=nightly', '--no-rules'], artifacts: {}, warnings: [] });
    // a device id that starts with "-" stays a value
    expect(actionPlan({ device: '--no-rules' }).argv).toEqual(['test', '--device=--no-rules']);
  });

  it('refuses bad inputs', () => {
    expect(() => actionPlan({ 'approve-shared-rules': 'maybe' })).toThrow(/approve-shared-rules must be true or false/);
    expect(() => actionPlan({ targets: '--flavor dev' })).toThrow(/looks like an option/);
    expect(() => actionPlan({ har: 'a\nb' })).toThrow(/single line/);
    expect(() => actionPlan({ 'upload-recording': 'yes please' })).toThrow(/upload-recording must be true or false/);
  });

  it('REVIEW-8 #12: artifact paths must be literal (upload-artifact reads globs and ! exclusions)', () => {
    for (const [name, v] of [['har', '**'], ['har', 'build/*.har'], ['junit', 'j?.xml'], ['record', 'build/[ab].json'], ['har', '{a,b}.har'], ['junit', '!build/j.xml']] as const) {
      expect(() => actionPlan({ [name]: v, ...(name === 'junit' ? { assert: 'e.json' } : {}) }), `${name}=${v}`).toThrow(/must be a plain file path/);
    }
    expect(actionPlan({ har: 'build/traffic-1.har', junit: 'out dir/j.xml', record: 'build/run.json' }).artifacts).toEqual({ har: 'build/traffic-1.har', junit: 'out dir/j.xml' });
  });

  it('REVIEW-8 #2: upload-recording uploads a redacted copy, never the recording itself', () => {
    expect(redactedCopyPath('build/run.json')).toBe('build/run.redacted.json');
    expect(redactedCopyPath('build/run')).toBe('build/run.redacted.json');
    const plan = actionPlan({ record: 'build/run.json', 'upload-recording': 'true', har: 'build/t.har' });
    expect(plan.artifacts).toEqual({ har: 'build/t.har', recordRedacted: 'build/run.redacted.json' });
    expect(plan.record).toBe('build/run.json');
    expect(plan.warnings).toEqual([expect.stringMatching(/uploading a redacted copy \(build\/run\.redacted\.json\); build\/run\.json keeps the real credentials/)]);
    const named = actionPlan({ record: 'nightly', 'upload-recording': 'true' });
    expect(named.artifacts).toEqual({});
    expect(named.warnings).toEqual([expect.stringMatching(/set record to a \.json path/)]);
  });

  it('formats $GITHUB_OUTPUT entries and escapes workflow command data', () => {
    expect(githubOutput('artifacts', '/a\n/b', 'EOF1')).toBe('artifacts<<EOF1\n/a\n/b\nEOF1\n');
    expect(() => githubOutput('x', 'EOF1', 'EOF1')).toThrow();
    expect(githubOutput('x', 'v')).toMatch(/^x<<fi_[0-9a-f]{32}\nv\nfi_[0-9a-f]{32}\n$/);
    expect(escapeCommandData('a%b\r\n::error::x')).toBe('a%25b%0D%0A::error::x');
  });

  describe('runAction', () => {
    let dir: string;
    beforeEach(() => {
      dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fi-action-')));
    });
    afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

    const outputs = (file: string) => {
      const out: Record<string, string> = {};
      const re = /^([\w-]+)<<(\S+)\n([\s\S]*?)\n\2\n/gm;
      for (const m of fs.readFileSync(file, 'utf8').matchAll(re)) out[m[1]] = m[3];
      return out;
    };

    it('runs the CLI with the planned argv and writes the outputs, exit code included', async () => {
      const outFile = path.join(dir, 'github_output');
      const logs: string[] = [];
      let argv: string[] | undefined;
      const code = await runAction(
        { GITHUB_OUTPUT: outFile, FI_INPUT_DEVICE: 'macos', FI_INPUT_HAR: 'build/t.har', FI_INPUT_ASSERT: 'e.json', FI_INPUT_JUNIT: 'build/j.xml', FI_INPUT_FLUTTER_ARGS: '--dart-define=API_KEY=s3cret' },
        { cwd: dir, log: (l) => logs.push(l), loadCli: () => ({ main: async (a) => ((argv = a), 1), writeRedactedRecordingCopy: () => 0 }) },
      );
      expect(code).toBe(1);
      expect(argv).toEqual(['test', '--device=macos', '--har=build/t.har', '--assert=e.json', '--junit=build/j.xml', '--', '--dart-define=API_KEY=s3cret']);
      expect(outputs(outFile)).toEqual({
        artifacts: `${path.join(dir, 'build/t.har')}\n${path.join(dir, 'build/j.xml')}`,
        har: path.join(dir, 'build/t.har'),
        junit: path.join(dir, 'build/j.xml'),
        record: '',
        'exit-code': '1',
      });
      expect(logs.join('\n')).toContain('--dart-define=API_KEY=***');
      expect(logs.join('\n')).not.toContain('s3cret');
    });

    it('REVIEW-8 #2: with record (default inputs) only the HAR / JUnit are artifacts; with upload-recording a redacted copy is', async () => {
      const secret = 'Bearer s3cret-live-token-0123456789';
      const exchange = {
        id: '1', startedAt: 1, durationMs: 5, method: 'POST', url: 'https://api.example.test/login',
        requestHeaders: { authorization: secret, 'content-type': 'application/json' },
        requestBody: { encoding: 'utf8', text: '{"password":"hunter2-pass"}', size: 27 },
        status: 200, responseHeaders: { 'content-type': 'application/json' },
        responseBody: { encoding: 'utf8', text: '{"access_token":"tok-abcdef0123456789"}', size: 39 }, state: 'completed',
      } as unknown as Exchange;
      const cli: CliModule = {
        main: async (a) => {
          const rec = a.find((x) => x.startsWith('--record='))!.slice('--record='.length);
          await writeRecording(rec, [exchange], dir, dir);
          return 0;
        },
        writeRedactedRecordingCopy,
      };
      const outA = path.join(dir, 'out_a');
      await runAction({ GITHUB_OUTPUT: outA, FI_INPUT_HAR: 'build/t.har', FI_INPUT_RECORD: 'build/run.json' }, { cwd: dir, log: () => undefined, loadCli: () => cli });
      expect(outputs(outA).artifacts).toBe(path.join(dir, 'build/t.har'));
      expect(outputs(outA).record).toBe(path.join(dir, 'build/run.json'));
      expect(fs.existsSync(path.join(dir, 'build/run.redacted.json'))).toBe(false);

      const outB = path.join(dir, 'out_b');
      const logs: string[] = [];
      await runAction({ GITHUB_OUTPUT: outB, FI_INPUT_RECORD: 'build/run.json', FI_INPUT_UPLOAD_RECORDING: 'true' }, { cwd: dir, log: (l) => logs.push(l), loadCli: () => cli });
      expect(outputs(outB).artifacts).toBe(path.join(dir, 'build/run.redacted.json'));
      expect(logs[0]).toMatch(/^::warning title=flutter-intercept::upload-recording: uploading a redacted copy/);
      const original = fs.readFileSync(path.join(dir, 'build/run.json'), 'utf8');
      expect(original).toContain('s3cret-live-token');
      const copy = fs.readFileSync(path.join(dir, 'build/run.redacted.json'), 'utf8');
      expect(JSON.parse(copy)).toMatchObject({ redacted: true, exchanges: 1 });
      for (const s of ['s3cret-live-token', 'hunter2-pass', 'tok-abcdef0123456789']) expect(copy).not.toContain(s);
      expect(copy).toContain('api.example.test/login');
    });

    it('a bad input is an ::error:: and exit code 2, the CLI never runs', async () => {
      const logs: string[] = [];
      const code = await runAction({ FI_INPUT_APPROVE_SHARED_RULES: 'sure\n::warning::x' }, { cwd: dir, log: (l) => logs.push(l), loadCli: () => { throw new Error('must not load'); } });
      expect(code).toBe(2);
      expect(logs).toEqual(['::error title=flutter-intercept::approve-shared-rules must be true or false, got "sure%0A::warning::x"']);
    });
  });
});
