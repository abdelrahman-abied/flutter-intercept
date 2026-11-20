/**
 * Collections for a headless CLI run (CONTRACTS §21.11): loads collections linked in the shared rules file
 * (skipped under `--no-rules`, matching its rules) plus any `--collection <file>` arguments, applies
 * `--collection-env`, `--collection-var` and `--collection-unmatched`, and turns them into proxy rules.
 *
 * Environment and variable values resolve URL variables only and never appear in problems or logs.
 */
import * as path from 'path';
import type { Rule } from '@flutter-intercept/proxy';
import { checkWorkspaceFile, decodeWorkspaceFile, type RulesFs, type WorkspaceFileSpec } from '../../extension/src/rules/bodyFile';
import type { FolderCollectionLinks } from '../../extension/src/rules/core';
import { MAX_PROBLEMS, parseJsonText, slugId } from '../../extension/src/mocks/core';
import { collectionParsers } from '../../extension/src/mocks/parsers';
import { toRules } from '../../extension/src/mocks/toRules';
import { COLLECTION_LIMITS, type CollectionLink, type ParsedCollection } from '../../extension/src/mocks/types';
import { isYamlFile, parseYaml } from '../../extension/src/mocks/yaml';
import { readOnlyRulesFs } from './rules';

const COLLECTION_FILE_SPEC: WorkspaceFileSpec = { what: 'collection file', maxBytes: COLLECTION_LIMITS.fileBytes, maxLabel: '20 MB' };
const ENVIRONMENT_FILE_SPEC: WorkspaceFileSpec = { what: 'environment file', maxBytes: 5 * 1024 * 1024, maxLabel: '5 MB' };

export interface LoadCollectionsOptions {
  /** Links from the shared rules file (omitted when `--no-rules` or no file). */
  sharedLinks?: FolderCollectionLinks[];
  /** CLI `--collection <file>` paths (resolved against `cwd`, in order). */
  files?: string[];
  /** CLI `--collection-env <file>` path (resolved against `cwd`). */
  envFile?: string;
  /** CLI `--collection-var name=value` overrides. */
  vars?: Readonly<Record<string, string>>;
  /** CLI `--collection-unmatched passthrough|fail` override. */
  unmatched?: 'passthrough' | 'fail';
  cwd: string;
  fs?: RulesFs;
}

export interface LoadedCollectionSummary {
  id: string;
  name: string;
  file: string;
  unmatched: 'passthrough' | 'fail';
  endpoints: number;
  mocked: number;
  noExample: number;
  unresolved: string[];
}

export interface LoadedCollections {
  /** Mock (and unmatched-fail block) rules of every active collection, in order (CONTRACTS §21.5). */
  rules: Rule[];
  collections: LoadedCollectionSummary[];
  /** One line per problem (parse issues, invalid links, loose globs, …). */
  problems: string[];
}

function errno(e: unknown): string | undefined {
  return (e as NodeJS.ErrnoException | undefined)?.code;
}

function capProblems(list: string[]): string[] {
  const unique = [...new Set(list)];
  if (unique.length <= MAX_PROBLEMS) return unique;
  return [...unique.slice(0, MAX_PROBLEMS - 1), `… and ${unique.length - (MAX_PROBLEMS - 1)} more problems`];
}

function toVarsMap(record: Readonly<Record<string, string>> | undefined): Map<string, string> {
  const out = new Map<string, string>();
  if (!record || typeof record !== 'object') return out;
  for (const k of Object.keys(record)) {
    const v = Object.getOwnPropertyDescriptor(record, k)?.value as unknown;
    if (typeof v === 'string' && v !== '') out.set(k, v);
  }
  return out;
}

/** Merges variables in priority order: CLI `--collection-var` → link → CLI `--collection-env` → link env → collection. */
function mergeVars(
  cliVars: ReadonlyMap<string, string>,
  linkVars: Readonly<Record<string, string>>,
  cliEnv: ReadonlyMap<string, string>,
  linkEnv: ReadonlyMap<string, string>,
  collectionVars: ReadonlyMap<string, string>,
) {
  const combinedLink: Record<string, string> = Object.create(null);
  for (const k of Object.keys(linkVars)) {
    const v = Object.getOwnPropertyDescriptor(linkVars, k)?.value as unknown;
    if (typeof v === 'string' && v !== '') combinedLink[k] = v;
  }
  for (const [k, v] of cliVars) combinedLink[k] = v;

  const combinedEnv = new Map<string, string>(linkEnv);
  for (const [k, v] of cliEnv) combinedEnv.set(k, v);

  return collectionParsers.mergeCollectionVars(combinedLink, combinedEnv, collectionVars);
}

/** Reads an explicit CLI file path (not restricted to the workspace root, like `--replay` and `--assert`). */
async function readCliFile(raw: string, cwd: string, files: RulesFs, spec: WorkspaceFileSpec): Promise<string> {
  const abs = path.resolve(cwd, raw);
  let st: Awaited<ReturnType<RulesFs['stat']>>;
  try {
    st = await files.stat(abs);
  } catch (e) {
    if (errno(e) === 'ENOENT' || errno(e) === 'ENOTDIR') throw new Error(`${spec.what} ${raw} not found`);
    throw new Error(`${spec.what} ${raw} can't be read (${errno(e) ?? (e as Error).message})`);
  }
  if (!st.isFile()) throw new Error(`${spec.what} ${raw} is not a regular file`);
  if (st.size > spec.maxBytes) throw new Error(`${spec.what} ${raw} is larger than ${spec.maxLabel}`);
  return decodeWorkspaceFile(await files.readFile(abs), raw, spec);
}

function parseDoc(text: string, label: string): { value?: unknown; problem?: string } {
  return isYamlFile(label) ? parseYaml(text, label) : parseJsonText(text, label);
}

function unresolvedOf(parsed: ParsedCollection): string[] {
  const out = new Set<string>();
  for (const ep of parsed.endpoints) for (const u of ep.unresolved) out.add(u);
  return [...out];
}

function parseCollectionDoc(
  doc: unknown,
  label: string,
  cliVars: ReadonlyMap<string, string>,
  linkVars: Readonly<Record<string, string>>,
  cliEnv: ReadonlyMap<string, string>,
  linkEnv: ReadonlyMap<string, string>,
): { parsed?: ParsedCollection; problem?: string } {
  const detected = collectionParsers.detectFormat(doc);
  if (!detected.format) {
    return { problem: `${label}: ${detected.problem ?? 'not a Postman collection or an OpenAPI 3 document'}` };
  }
  const colVars = detected.format === 'postman' ? collectionParsers.postmanCollectionVariables(doc) : new Map<string, string>();
  const vars = mergeVars(cliVars, linkVars, cliEnv, linkEnv, colVars);
  const parsed = detected.format === 'postman' ? collectionParsers.parsePostman(doc, vars) : collectionParsers.parseOpenApi(doc, vars);
  return { parsed };
}

function applyParsed(
  parsed: ParsedCollection,
  id: string,
  file: string,
  link: Pick<CollectionLink, 'selected' | 'off'>,
  unmatched: 'passthrough' | 'fail',
  extraProblems: string[],
  out: { rules: Rule[]; collections: LoadedCollectionSummary[]; problems: string[] },
): void {
  const name = parsed.name || id;
  const unresolved = unresolvedOf(parsed);
  // CONTRACTS §21.11: unresolved variables with `fail` are a usage error (exit code 2).
  if (unmatched === 'fail' && unresolved.length) {
    throw new Error(
      `collection "${name}" has unresolved URL variable(s) (${unresolved.map((u) => `{{${u}}}`).join(', ')}) with unmatched=fail: set them with --collection-var name=value or --collection-env <file>`,
    );
  }
  const built = toRules(parsed, { id, name, selected: link.selected, off: link.off, unmatched });
  out.rules.push(...built.rules);
  out.collections.push({
    id,
    name,
    file,
    unmatched,
    endpoints: built.stats.endpoints,
    mocked: built.stats.mocked,
    noExample: built.stats.noExample,
    unresolved,
  });
  out.problems.push(...capProblems([...extraProblems, ...parsed.problems, ...built.problems]));
}

export async function loadCollections(o: LoadCollectionsOptions): Promise<LoadedCollections> {
  const files = o.fs ?? readOnlyRulesFs;
  const out: LoadedCollections = { rules: [], collections: [], problems: [] };
  const sharedLinks = o.sharedLinks ?? [];
  const cliFiles = o.files ?? [];

  const cliVars = toVarsMap(o.vars);
  let cliEnv = new Map<string, string>();
  if (o.envFile !== undefined) {
    const envText = await readCliFile(o.envFile, o.cwd, files, ENVIRONMENT_FILE_SPEC);
    const parsedEnv = parseJsonText(envText, o.envFile);
    if (parsedEnv.problem !== undefined) throw new Error(parsedEnv.problem);
    const pe = collectionParsers.parsePostmanEnvironment(parsedEnv.value);
    cliEnv = pe.values;
    out.problems.push(...pe.problems.map((p) => `${o.envFile}: ${p}`));
  }

  const seenIds = new Set<string>();
  let total = 0;

  // 1. Collections linked in the shared rules file (in file order).
  for (const folder of sharedLinks) {
    out.problems.push(...folder.problems);
    for (const link of folder.links) {
      if (seenIds.has(link.id)) {
        out.problems.push(`${folder.label}: collection "${link.id}" is also linked in another workspace folder (skipped)`);
        continue;
      }
      seenIds.add(link.id);
      if (!link.enabled) continue;
      if (++total > COLLECTION_LIMITS.linksPerFile) {
        out.problems.push(`at most ${COLLECTION_LIMITS.linksPerFile} collections can be loaded (skipped "${link.id}")`);
        continue;
      }
      const extraProblems: string[] = [];
      let doc: unknown;
      let linkEnv = new Map<string, string>();
      try {
        const col = await checkWorkspaceFile(link.file, folder.folderPath, [folder.folderPath], files, COLLECTION_FILE_SPEC);
        const text = decodeWorkspaceFile(await files.readFile(col.real), link.file, COLLECTION_FILE_SPEC);
        const r = parseDoc(text, link.file);
        if (r.problem !== undefined) {
          out.problems.push(r.problem);
          continue;
        }
        doc = r.value;
        if (link.environment) {
          const env = await checkWorkspaceFile(link.environment, folder.folderPath, [folder.folderPath], files, ENVIRONMENT_FILE_SPEC);
          const envText = decodeWorkspaceFile(await files.readFile(env.real), link.environment, ENVIRONMENT_FILE_SPEC);
          const er = parseJsonText(envText, link.environment);
          if (er.problem !== undefined) {
            out.problems.push(er.problem);
            continue;
          }
          const pe = collectionParsers.parsePostmanEnvironment(er.value);
          linkEnv = pe.values;
          extraProblems.push(...pe.problems.map((p) => `${link.environment}: ${p}`));
        }
      } catch (e) {
        out.problems.push((e as Error).message);
        continue;
      }
      const res = parseCollectionDoc(doc, link.file, cliVars, link.variables, cliEnv, linkEnv);
      if (res.problem !== undefined || !res.parsed) {
        out.problems.push(res.problem ?? `${link.file}: couldn't be read`);
        continue;
      }
      applyParsed(res.parsed, link.id, link.file, link, o.unmatched ?? link.unmatched, extraProblems, out);
    }
  }

  // 2. Collections passed on the command line (`--collection`, in order).
  for (const rawFile of cliFiles) {
    if (++total > COLLECTION_LIMITS.linksPerFile) {
      throw new Error(`at most ${COLLECTION_LIMITS.linksPerFile} collections can be loaded`);
    }
    const text = await readCliFile(rawFile, o.cwd, files, COLLECTION_FILE_SPEC);
    const r = parseDoc(text, rawFile);
    if (r.problem !== undefined) throw new Error(r.problem);
    const res = parseCollectionDoc(r.value, rawFile, cliVars, Object.create(null), cliEnv, new Map());
    if (res.problem !== undefined || !res.parsed) throw new Error(res.problem ?? `${rawFile}: couldn't be read`);
    const stem = path.basename(rawFile).replace(/\.(postman_collection\.)?(json|ya?ml)$/i, '');
    const id = slugId(res.parsed.name || stem, seenIds);
    seenIds.add(id);
    applyParsed(res.parsed, id, rawFile, { selected: {}, off: [] }, o.unmatched ?? 'passthrough', [], out);
  }

  return out;
}
