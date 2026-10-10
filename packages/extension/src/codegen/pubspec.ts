/**
 * Picks the model / fixture style from a project's pubspec.yaml (CONTRACTS §10.4). Pure apart from the
 * injectable `readFile`. The YAML is scanned, not parsed: only the package names directly under the
 * top-level `dependencies:` / `dev_dependencies:` (and `dependency_overrides:` is ignored on purpose).
 */
import type { FixtureStyle, ModelStyle } from './types';

export interface PubspecDeps {
  name?: string;
  dependencies: Set<string>;
  devDependencies: Set<string>;
}

export function parsePubspecDeps(text: string): PubspecDeps {
  const deps: PubspecDeps = { dependencies: new Set(), devDependencies: new Set() };
  let section: Set<string> | undefined;
  let childIndent: number | undefined;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/\s+#.*$/, '').replace(/^#.*$/, '');
    if (!line.trim()) continue;
    const indent = line.length - line.trimStart().length;
    if (indent === 0) {
      const top = /^([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(line);
      section = undefined;
      childIndent = undefined;
      if (!top) continue;
      if (top[1] === 'name' && top[2]) deps.name = top[2].replace(/^['"]|['"]$/g, '').trim();
      else if (top[1] === 'dependencies') section = deps.dependencies;
      else if (top[1] === 'dev_dependencies') section = deps.devDependencies;
      continue;
    }
    if (!section) continue;
    childIndent ??= indent;
    if (indent !== childIndent) continue;
    const m = /^\s*['"]?([A-Za-z_][\w]*)['"]?\s*:/.exec(line);
    if (m) section.add(m[1]);
  }
  return deps;
}

const has = (d: PubspecDeps, name: string) => d.dependencies.has(name) || d.devDependencies.has(name);

/** freezed > json_serializable > plain. */
export function modelStyleFor(d: PubspecDeps): ModelStyle {
  if (has(d, 'freezed_annotation') || has(d, 'freezed')) return 'freezed';
  if (has(d, 'json_annotation') || has(d, 'json_serializable')) return 'json_serializable';
  return 'plain';
}

/** http_mock_adapter > mocktail > mock_client (package:http's testing MockClient needs nothing extra). */
export function fixtureStyleFor(d: PubspecDeps): FixtureStyle {
  if (has(d, 'http_mock_adapter')) return 'http_mock_adapter';
  if (has(d, 'mocktail')) return 'mocktail';
  return 'mock_client';
}
