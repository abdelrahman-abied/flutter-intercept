/**
 * REVIEW-9 #2: where "Create file" from the traffic UI (`openBodyFile` / `openScriptFile` with `create`) may write a
 * new file. Pure (no fs, no vscode): shared by the VS Code host (src/extension.ts) and the sidecar.
 *
 * - `allow`   — under `.vscode/flutter-intercept/` (the mocks/ and scripts/ folders our own UI creates): no prompt.
 * - `refuse`  — build, platform, VCS, IDE and tool configuration that runs code or changes builds: platform folders,
 *               Gradle / Kotlin script files, pubspec / analysis / build configs, Dart build hooks, dotfiles and
 *               dot-folders (`.git`, `.idea`, `.github`, `.vscode/*.json`, `.env`, …), Makefiles and shell / batch
 *               scripts, `web/index.html`. Matched case-insensitively on any path segment (nested projects too).
 * - `confirm` — anything else: the host asks with a modal naming the full path (Cancel is the default).
 */

export type CreateDecision = { kind: 'allow' } | { kind: 'confirm' } | { kind: 'refuse'; reason: string };

/** The shared rules file: never a body file, but not refused by the dotfile rule (it is ours). */
const SHARED_RULES_FILE = '.vscode/flutter-intercept.json';
const OWN_DIR = '.vscode/flutter-intercept/';
/** Folders that hold platform projects / build logic: refused wherever they appear in the path. */
const REFUSED_DIRS = new Set(['android', 'ios', 'macos', 'linux', 'windows', 'buildsrc', 'hook', 'build', 'gradle', 'node_modules']);
const REFUSED_NAMES = new Set(['pubspec.yaml', 'pubspec.lock', 'pubspec_overrides.yaml', 'analysis_options.yaml', 'build.yaml', 'dart_test.yaml', 'l10n.yaml', 'makefile', 'gnumakefile', 'cmakelists.txt', 'package.json', 'podfile', 'gemfile', 'dockerfile']);
const REFUSED_EXT = /\.(gradle|kts|sh|bash|zsh|command|bat|cmd|ps1|psm1|py|rb|pl|exe|dll|so|dylib|jar|plist|xcconfig|pbxproj|entitlements|cmake)$/;

/** Splits a project-relative path (either separator) into lower-case segments; undefined when it isn't relative. */
function segments(rel: string): string[] | undefined {
  if (typeof rel !== 'string' || !rel || rel.includes('\0')) return undefined;
  const norm = rel.replace(/\\/g, '/');
  if (norm.startsWith('/') || /^[A-Za-z]:/.test(norm)) return undefined;
  const segs = norm.split('/').filter((s) => s && s !== '.');
  if (!segs.length || segs.includes('..')) return undefined;
  return segs.map((s) => s.toLowerCase());
}

export function createPathDecision(rel: string): CreateDecision {
  const segs = segments(rel);
  if (!segs) return { kind: 'refuse', reason: 'not a project-relative path' };
  const joined = segs.join('/');
  if (joined === SHARED_RULES_FILE) return { kind: 'refuse', reason: 'the shared rules file is not a body or script file' };
  const name = segs[segs.length - 1];
  if (joined.startsWith(OWN_DIR) && segs.length > 2) {
    // our folder: still never an executable / build file under it
    if (REFUSED_EXT.test(name)) return { kind: 'refuse', reason: `a ${name.replace(/^.*\./, '.')} file can run code or change builds` };
    return { kind: 'allow' };
  }
  const dot = segs.find((s) => s.startsWith('.'));
  if (dot) return { kind: 'refuse', reason: `${dot} is tool or editor configuration` };
  const dir = segs.slice(0, -1).find((s) => REFUSED_DIRS.has(s));
  if (dir) return { kind: 'refuse', reason: `${dir}/ holds platform projects or build logic` };
  if (REFUSED_NAMES.has(name)) return { kind: 'refuse', reason: `${name} is project or build configuration` };
  if (/^(build|settings)\.gradle/.test(name) || REFUSED_EXT.test(name)) return { kind: 'refuse', reason: `${name} can run code or change builds` };
  if (joined === 'web/index.html' || joined.endsWith('/web/index.html')) return { kind: 'refuse', reason: 'web/index.html is the Flutter Web host page' };
  return { kind: 'confirm' };
}
