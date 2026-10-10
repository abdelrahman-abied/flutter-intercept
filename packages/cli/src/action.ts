/**
 * Entry of the GitHub Action (root `action.yml`, CONTRACTS §14.1), bundled as dist/action.js next to dist/cli.js.
 * The composite action passes its inputs as `FI_INPUT_<NAME>` environment variables (never interpolated into a
 * script); this turns them into a `flutter-intercept test` command line, publishes the output file paths for the
 * upload step, runs the CLI in this process (its own signal handling and cleanup apply), and exits with its code.
 */
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { displayCommand } from './command';

/** Inputs the CLI step reads; `working-directory`, `artifact-name` and `upload-artifacts` are used by action.yml. */
export const CLI_INPUTS = [
  'device',
  'targets',
  'har',
  'record',
  'assert',
  'junit',
  'replay',
  'replay-fallback',
  'network-profile',
  'rules',
  'approve-shared-rules',
  'flutter-args',
] as const;
export type CliInput = (typeof CLI_INPUTS)[number];
export type ActionInputs = Partial<Record<CliInput, string>>;

/** `network-profile` → `FI_INPUT_NETWORK_PROFILE`. */
export function inputEnvName(input: string): string {
  return `FI_INPUT_${input.toUpperCase().replace(/-/g, '_')}`;
}

export function readInputs(env: NodeJS.ProcessEnv): ActionInputs {
  const out: ActionInputs = {};
  for (const name of CLI_INPUTS) {
    const v = env[inputEnvName(name)];
    if (v !== undefined && v.trim() !== '') out[name] = v.trim();
  }
  return out;
}

export class ActionInputError extends Error {
  readonly name = 'ActionInputError';
}

/**
 * A list input: several lines → one item per line (items may contain spaces); one line → split on whitespace.
 * No shell quoting is interpreted.
 */
export function splitList(value: string | undefined): string[] {
  if (!value) return [];
  const lines = value.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (lines.length > 1) return lines;
  return lines.length ? lines[0].split(/\s+/) : [];
}

/** Same rule as outputs.ts: a value with a path separator or ending in .json names a file. */
function looksLikePath(value: string): boolean {
  return /[\\/]/.test(value) || /\.json$/i.test(value);
}

function parseBool(name: string, value: string | undefined): boolean {
  if (value === undefined) return false;
  if (/^(true|yes|1)$/i.test(value)) return true;
  if (/^(false|no|0)$/i.test(value)) return false;
  throw new ActionInputError(`${name} must be true or false, got "${value}"`);
}

export interface ActionPlan {
  /** Arguments for `flutter-intercept`. */
  argv: string[];
  /** Output files (relative to the working directory) to upload: HAR, JUnit, a recording written to a path. */
  artifacts: { har?: string; junit?: string; record?: string };
}

const VALUE_INPUTS: [CliInput, string][] = [
  ['device', '--device'],
  ['har', '--har'],
  ['record', '--record'],
  ['assert', '--assert'],
  ['junit', '--junit'],
  ['replay', '--replay'],
  ['replay-fallback', '--replay-fallback'],
  ['network-profile', '--network-profile'],
];

export function actionPlan(inputs: ActionInputs): ActionPlan {
  const argv = ['test'];
  for (const t of splitList(inputs.targets)) {
    if (t.startsWith('-')) throw new ActionInputError(`targets: "${t}" looks like an option (flutter options go in flutter-args)`);
    argv.push(t);
  }
  for (const [name, flag] of VALUE_INPUTS) {
    const v = inputs[name];
    if (v === undefined) continue;
    if (/[\r\n\0]/.test(v)) throw new ActionInputError(`${name} must be a single line`);
    // --name=value: a value starting with "-" can't be taken for an option
    argv.push(`${flag}=${v}`);
  }
  const rules = inputs.rules;
  if (rules !== undefined) {
    if (/[\r\n\0]/.test(rules)) throw new ActionInputError('rules must be a single line');
    argv.push(/^(none|false)$/i.test(rules) ? '--no-rules' : `--rules=${rules}`);
  }
  if (parseBool('approve-shared-rules', inputs['approve-shared-rules'])) argv.push('--approve-shared-rules');
  const flutterArgs = splitList(inputs['flutter-args']);
  if (flutterArgs.length) argv.push('--', ...flutterArgs);
  const artifacts: ActionPlan['artifacts'] = {};
  if (inputs.har) artifacts.har = inputs.har;
  if (inputs.junit) artifacts.junit = inputs.junit;
  if (inputs.record && looksLikePath(inputs.record)) artifacts.record = inputs.record;
  return { argv, artifacts };
}

/** `name<<delimiter\nvalue\ndelimiter\n` for $GITHUB_OUTPUT (multi-line safe; the delimiter is random). */
export function githubOutput(name: string, value: string, delimiter = `fi_${crypto.randomBytes(16).toString('hex')}`): string {
  if (value.includes(delimiter)) throw new Error('output value contains the delimiter');
  return `${name}<<${delimiter}\n${value}\n${delimiter}\n`;
}

/** Workflow-command data escaping (`%`, CR, LF), so a message can't start another command. */
export function escapeCommandData(s: string): string {
  return s.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
}

export interface ActionDeps {
  cwd: string;
  log(line: string): void;
  /** The CLI's `main` (dist/cli.js). */
  loadCli(): { main(argv: string[]): Promise<number> };
}

export async function runAction(env: NodeJS.ProcessEnv, deps: ActionDeps): Promise<number> {
  let plan: ActionPlan;
  try {
    plan = actionPlan(readInputs(env));
  } catch (e) {
    if (!(e instanceof ActionInputError)) throw e;
    deps.log(`::error title=flutter-intercept::${escapeCommandData(e.message)}`);
    return 2;
  }
  const outputFile = env.GITHUB_OUTPUT;
  const setOutput = (name: string, value: string) => {
    if (outputFile) fs.appendFileSync(outputFile, githubOutput(name, value));
  };
  const abs = (p: string) => path.resolve(deps.cwd, p);
  const files = Object.values(plan.artifacts).filter((p): p is string => !!p).map(abs);
  for (const f of files) if (/[\r\n]/.test(f)) throw new Error('output paths must be single lines');
  setOutput('artifacts', files.join('\n'));
  for (const k of ['har', 'junit', 'record'] as const) setOutput(k, plan.artifacts[k] ? abs(plan.artifacts[k]!) : '');
  deps.log(displayCommand('flutter-intercept', plan.argv));
  const code = await deps.loadCli().main(plan.argv);
  setOutput('exit-code', String(code));
  return code;
}

if (require.main === module) {
  // Same process-level setup as main.ts: quiet deprecations, and an uncaught error still exits through the CLI's
  // exit hook (temp CA, wrappers, adb reverse removed).
  process.noDeprecation = true;
  process.on('uncaughtException', (e) => {
    process.stderr.write(`flutter-intercept: ${(e as Error)?.stack ?? String(e)}\n`);
    process.exit(2);
  });
  runAction(process.env, {
    cwd: process.cwd(),
    log: (l) => process.stdout.write(`${l}\n`),
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    loadCli: () => require(path.join(__dirname, 'cli.js')) as { main(argv: string[]): Promise<number> },
  }).then(
    (code) => process.exit(code),
    (e) => {
      process.stderr.write(`flutter-intercept: ${(e as Error)?.stack ?? String(e)}\n`);
      process.exit(2);
    },
  );
}
