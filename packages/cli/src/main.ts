/**
 * `flutter-intercept` command line (CONTRACTS §13.9). Exit codes: CliResult.exitCode; 2 = usage / setup error.
 */
import { HELP, parseArgs, UsageError } from './args';
import { defaultDeps, runCli, SetupError } from './run';

declare const __FI_CLI_VERSION__: string | undefined;
export const VERSION = typeof __FI_CLI_VERSION__ === 'string' ? __FI_CLI_VERSION__ : 'dev';

export async function main(argv: string[]): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs(argv);
  } catch (e) {
    if (e instanceof UsageError) {
      process.stderr.write(`flutter-intercept: ${e.message}\nRun flutter-intercept --help for usage.\n`);
      return 2;
    }
    throw e;
  }
  if (parsed.kind === 'help') {
    process.stdout.write(`${HELP}\n`);
    return 0;
  }
  if (parsed.kind === 'version') {
    process.stdout.write(`flutter-intercept ${VERSION}\n`);
    return 0;
  }
  try {
    const result = await runCli(parsed.options, defaultDeps(VERSION));
    return result.exitCode;
  } catch (e) {
    if (e instanceof SetupError) {
      process.stderr.write(`flutter-intercept: ${e.message}\n`);
      return 2;
    }
    process.stderr.write(`flutter-intercept: ${(e as Error)?.stack ?? String(e)}\n`);
    return 2;
  }
}

if (require.main === module) {
  // mockttp's dependencies use url.parse(); its deprecation notice is noise in a CI log.
  process.noDeprecation = true;
  // REVIEW-7 #13: an error in an event handler still ends through process.exit, so the run's exit hook cleans up.
  process.on('uncaughtException', (e) => {
    process.stderr.write(`flutter-intercept: ${(e as Error)?.stack ?? String(e)}\n`);
    process.exit(2);
  });
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (e) => {
      process.stderr.write(`flutter-intercept: ${(e as Error)?.stack ?? String(e)}\n`);
      process.exit(2);
    },
  );
}
