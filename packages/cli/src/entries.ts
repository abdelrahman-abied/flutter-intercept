/**
 * Generated entries for a headless run (CONTRACTS §1, §13.9; docs/spikes/ci.md).
 *
 * The entry itself is the editor's (same template, same `.dart_tool/flutter_intercept/entry_<name>.dart` path). For
 * `flutter test` two things are added, both measured in the spike:
 * - flutter_tools runs a file as an on-device integration test only when its path starts with
 *   `<project>/integration_test`; any other path is a host-side widget test (`-d` ignored).
 * - its test listener calls `main` with no arguments (`Future(test.main)`), and the entry's
 *   `main(List<String> args)` does not compile there.
 * So each entry gets a one-line wrapper under `integration_test/.flutter_intercept/` (hidden, not `*_test.dart`, so
 * a plain `flutter test integration_test` never picks it up; a `.gitignore` keeps it out of git) that calls the
 * entry's `main` with no arguments. The wrapper directory is deleted after the run.
 */
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { ENTRY_DIR_SEGMENTS, isWithin, planEntry, writeEntry, type EntryPlan } from '../../extension/src/entry/generator';
import { ensureDirInside } from '../../extension/src/agent/har';

export const WRAPPER_DIR = path.join('integration_test', '.flutter_intercept');

function toPosix(p: string): string {
  return p.split(path.sep).join('/');
}

/** A target as given: relative to `cwd` when it exists there, else to the project root (like flutter, run from it). */
export function targetPath(t: string, projectRoot: string, cwd: string): string {
  const fromCwd = path.resolve(cwd, t);
  if (path.isAbsolute(t) || fs.existsSync(fromCwd)) return fromCwd;
  return path.resolve(projectRoot, t);
}

/** `*_test.dart` files under `dir` (sorted), skipping hidden and build directories. */
export function findTestFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name.startsWith('.') || e.name === 'build') continue;
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile() && e.name.endsWith('_test.dart')) out.push(p);
    }
  };
  walk(dir);
  return out.sort();
}

/**
 * Absolute test files for `targets` (files or directories, relative to `cwd`; default `integration_test/` of the
 * project). Every file must be a `.dart` file inside the project. Throws a readable Error.
 */
export function resolveTestTargets(targets: string[], projectRoot: string, cwd: string): string[] {
  const list = targets.length ? targets : [path.join(projectRoot, 'integration_test')];
  const files: string[] = [];
  for (const t of list) {
    const abs = targetPath(t, projectRoot, cwd);
    let st: fs.Stats;
    try {
      st = fs.statSync(abs);
    } catch {
      throw new Error(targets.length ? `test target ${t} not found` : `no integration_test/ directory in ${projectRoot} (pass test files, e.g. integration_test/app_test.dart)`);
    }
    if (!isWithin(abs, projectRoot)) throw new Error(`test target ${t} is outside the Flutter project ${projectRoot}`);
    if (isWithin(abs, path.join(projectRoot, WRAPPER_DIR)) || isWithin(abs, path.join(projectRoot, '.dart_tool'))) throw new Error(`test target ${t} is a generated file`);
    if (st.isDirectory()) {
      const found = findTestFiles(abs);
      if (!found.length) throw new Error(`no *_test.dart files in ${t}`);
      files.push(...found);
    } else if (abs.endsWith('.dart')) files.push(abs);
    else throw new Error(`test target ${t} is not a .dart file`);
  }
  return [...new Set(files)];
}

/** `run` targets: app entry points (default lib/main.dart). */
export function resolveRunTargets(targets: string[], projectRoot: string, cwd: string): string[] {
  const list = targets.length ? targets : [path.join(projectRoot, 'lib', 'main.dart')];
  return list.map((t) => {
    const abs = targetPath(t, projectRoot, cwd);
    if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) throw new Error(`target ${t} not found`);
    if (!abs.endsWith('.dart')) throw new Error(`target ${t} is not a .dart file`);
    if (!isWithin(abs, projectRoot)) throw new Error(`target ${t} is outside the Flutter project ${projectRoot}`);
    return abs;
  });
}

/** True when `path` runs as an on-device integration test (flutter_tools' own check is this string prefix). */
export function isIntegrationTestPath(projectRoot: string, file: string): boolean {
  return file.startsWith(path.join(projectRoot, 'integration_test'));
}

export function wrapperPathFor(projectRoot: string, entryPath: string): string {
  return path.join(projectRoot, WRAPPER_DIR, `${path.basename(entryPath, '.dart')}_fi.dart`);
}

export function renderWrapper(wrapperPath: string, entryPath: string): string {
  const rel = toPosix(path.relative(path.dirname(wrapperPath), entryPath))
    .split('/')
    .map((seg) => (seg === '..' || seg === '.' ? seg : encodeURIComponent(seg)))
    .join('/');
  return [
    '// GENERATED by Flutter Intercept (headless run). Do not edit. Deleted after the run; safe to delete.',
    `import '${rel.replace(/'/g, "\\'")}' as entry;`,
    '',
    '// flutter test calls main() without arguments.',
    'Future<void> main() async => entry.main(const <String>[]);',
    '',
  ].join('\n');
}

/** `--dart-define=FLUTTER_INTERCEPT_ENTRY_SHA=` value for several entries (one entry: its own sha). */
export function combinedSha(plans: Pick<EntryPlan, 'sha'>[]): string {
  if (plans.length === 1) return plans[0].sha;
  return crypto.createHash('sha1').update(plans.map((p) => p.sha).join('\n')).digest('hex').slice(0, 12);
}

/** Removes `p` when it is a symbolic link (the link, not its target). */
function unlinkIfLink(p: string): void {
  try {
    if (fs.lstatSync(p).isSymbolicLink()) fs.unlinkSync(p);
  } catch {
    // missing
  }
}

/** Replaces `p` with a new regular file: whatever is there (a file or a planted link) is removed, then `wx`. */
export function writeFresh(p: string, text: string): void {
  fs.rmSync(p, { force: true });
  fs.writeFileSync(p, text, { flag: 'wx', mode: 0o644 });
}

export interface PreparedEntries {
  plans: EntryPlan[];
  /** What flutter runs: the wrappers (`test`) or the entries (`run`). */
  files: string[];
  sha: string;
  /** Removes what this run created for flutter test (the wrapper directory). Never throws. */
  cleanup(): void;
}

export async function prepareEntries(opts: { programs: string[]; projectRoot: string; proxyPort: number; caCertPem: string; wrap: boolean }): Promise<PreparedEntries> {
  const plans: EntryPlan[] = [];
  for (const program of opts.programs) {
    const plan = planEntry({ program, proxyPort: opts.proxyPort, caCertPem: opts.caCertPem, fallbackRoot: opts.projectRoot });
    if (!plan) throw new Error(`no pubspec.yaml found for ${program}`);
    if (path.resolve(plan.projectRoot) !== path.resolve(opts.projectRoot)) throw new Error(`${program} belongs to another Flutter project (${plan.projectRoot})`);
    // REVIEW-7 #13: a real folder inside the project (no symlinked component), and never write through a link
    await ensureDirInside(opts.projectRoot, ENTRY_DIR_SEGMENTS.join('/'));
    unlinkIfLink(plan.entryPath);
    await writeEntry(plan);
    plans.push(plan);
  }
  const wrapperDir = path.join(opts.projectRoot, WRAPPER_DIR);
  const files: string[] = [];
  if (opts.wrap) {
    await ensureDirInside(opts.projectRoot, toPosix(WRAPPER_DIR));
    writeFresh(path.join(wrapperDir, '.gitignore'), '# Generated by Flutter Intercept (headless runs).\n*\n');
    for (const plan of plans) {
      const w = wrapperPathFor(opts.projectRoot, plan.entryPath);
      writeFresh(w, renderWrapper(w, plan.entryPath));
      files.push(w);
    }
  } else files.push(...plans.map((p) => p.entryPath));
  const written = [...files];
  return {
    plans,
    files,
    sha: combinedSha(plans),
    cleanup() {
      if (!opts.wrap) return;
      for (const f of written) fs.rmSync(f, { force: true });
      try {
        const left = fs.readdirSync(wrapperDir).filter((n) => n !== '.gitignore');
        if (!left.length) fs.rmSync(wrapperDir, { recursive: true, force: true });
      } catch {
        // already gone
      }
    },
  };
}
