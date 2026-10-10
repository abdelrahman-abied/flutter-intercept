/**
 * Codegen service (CONTRACTS §10.4): models and fixture tests from recorded traffic. Pure apart from reading
 * pubspec.yaml, which goes through an injectable `readFile` (tests pass a fake).
 */
import * as fs from 'fs';
import * as path from 'path';
import { generateFixtureTest } from './fixtures';
import { generateModels } from './models';
import { fixtureStyleFor, modelStyleFor, parsePubspecDeps, type PubspecDeps } from './pubspec';
import { routeTemplate } from './route';
import type { CodegenService } from './types';

export interface CodegenServiceOptions {
  /** File contents, or undefined when missing/unreadable. Default: fs.readFileSync (utf8). */
  readFile?: (file: string) => string | undefined;
}

function defaultReadFile(file: string): string | undefined {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return undefined;
  }
}

export function createCodegenService(opts: CodegenServiceOptions = {}): CodegenService {
  const readFile = opts.readFile ?? defaultReadFile;
  const deps = (projectRoot: string): PubspecDeps => {
    const text = readFile(path.join(projectRoot, 'pubspec.yaml'));
    return text === undefined ? { dependencies: new Set(), devDependencies: new Set() } : parsePubspecDeps(text);
  };
  return {
    detectModelStyle: (projectRoot) => modelStyleFor(deps(projectRoot)),
    detectFixtureStyle: (projectRoot) => fixtureStyleFor(deps(projectRoot)),
    generateModels,
    generateFixtureTest,
    routeTemplate,
  };
}
