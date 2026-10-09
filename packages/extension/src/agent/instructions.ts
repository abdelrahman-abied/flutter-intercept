/**
 * Command `flutterIntercept.addAgentInstructions` (CONTRACTS §8 "Instructions command").
 *
 * Writes a short "how to use the Flutter Intercept tools" section into the agent instruction files the
 * user picks (AGENTS.md, CLAUDE.md, .github/copilot-instructions.md) in the Flutter project's workspace
 * folder. The section lives between markers and is updated in place, so running the command again is
 * idempotent and everything outside the markers is preserved. Nothing is written without the command.
 *
 * The pure part (section text, upsert, file application over an injected fs) has no `vscode` import and is
 * unit-tested; `registerInstructionsCommand` loads `vscode` lazily.
 */
import * as nodeFs from 'fs';
import * as path from 'path';
import type * as vscodeTypes from 'vscode';

export const SECTION_START = '<!-- flutter-intercept:start -->';
export const SECTION_END = '<!-- flutter-intercept:end -->';

export const INSTRUCTION_TARGETS = ['AGENTS.md', 'CLAUDE.md', '.github/copilot-instructions.md'] as const;
export type InstructionTarget = (typeof INSTRUCTION_TARGETS)[number];

/** The section, markers included. Tool names are the MCP names from CONTRACTS §8. */
export const AGENT_SECTION = [
  SECTION_START,
  '## Flutter Intercept (HTTP traffic tools)',
  '',
  "This project uses the Flutter Intercept VS Code extension. Its tools show and control the app's real HTTP",
  'traffic (Dio, package:http, dart:io) while it runs from VS Code. In VS Code (Copilot) the tools are named',
  '`flutter_intercept_<tool>`; over MCP they are `<tool>`.',
  '',
  '**Verify after every networking change**',
  '1. Start the app with `launch_app` (or ask the user to press F5); `get_status` lists sessions. After code',
  '   changes use `hot_restart`.',
  '2. Trigger the flow, then `wait_for_request` with a URL glob (e.g. `*/api/login*`) and inspect the result',
  '   with `get_request`: method, URL, headers, request body, status and response.',
  '3. `list_requests` (filter by url, method, status, state) gives a quick overview.',
  '',
  '**Test error and edge states without changing the backend**',
  '- `add_mock` a 500, an empty body (`[]` / `{}`) or a slow response (`delayMs`, e.g. beyond the client',
  '  timeout), reproduce, check the UI, then `remove_rule` with the returned `ruleId`.',
  '- `add_block` simulates a failing endpoint.',
  '',
  '**Inspect or change live traffic**',
  '- `add_breakpoint` (phase `request` or `response`) → trigger → `list_paused` → `resume_request` with an',
  '  `edit` holding only the changed fields, or `abort_request`. Resume promptly: the app\'s own timeout keeps',
  '  running while a request is paused.',
  '',
  '**Housekeeping**',
  '- `clear_requests` between experiments so results only show the new run; `export_har` saves evidence.',
  '- Before finishing, remove every rule you added (`list_rules`; agent rules are named `[agent] …`).',
  '- Secrets (auth headers, cookies, tokens, passwords) appear as `[redacted]`. That is intentional.',
  '- Release builds are never intercepted; use debug or profile. Write tools may ask the user to confirm, and',
  '  the user can make agent access read-only or turn it off.',
  SECTION_END,
].join('\n');

export type UpsertAction = 'created' | 'appended' | 'updated' | 'unchanged' | 'conflict';

/**
 * Insert or replace the marked section in `existing` (undefined = file missing).
 * - Missing file → just the section.
 * - Both markers present → the first start…end block is replaced; everything else is kept byte for byte.
 * - No markers → appended after a blank line.
 * - A start marker without a matching end marker → `conflict`, text unchanged (never guess what to delete).
 * The file's line ending (CRLF vs LF) is preserved.
 */
export function upsertSection(existing: string | undefined, section: string = AGENT_SECTION): { text: string; action: UpsertAction } {
  if (existing === undefined) return { text: `${section}\n`, action: 'created' };
  const eol = existing.includes('\r\n') ? '\r\n' : '\n';
  const block = section.replace(/\r?\n/g, eol);
  const start = existing.indexOf(SECTION_START);
  if (start >= 0) {
    const endAt = existing.indexOf(SECTION_END, start + SECTION_START.length);
    if (endAt < 0) return { text: existing, action: 'conflict' };
    const end = endAt + SECTION_END.length;
    const text = existing.slice(0, start) + block + existing.slice(end);
    return { text, action: text === existing ? 'unchanged' : 'updated' };
  }
  if (existing.indexOf(SECTION_END) >= 0) return { text: existing, action: 'conflict' };
  if (existing.trim() === '') return { text: block + eol, action: 'appended' };
  const sep = existing.endsWith(eol + eol) ? '' : existing.endsWith(eol) ? eol : eol + eol;
  return { text: existing + sep + block + eol, action: 'appended' };
}

/** The bits of `fs` this module needs (injected in tests). */
export interface InstructionsFs {
  readFile(file: string): string | undefined; // undefined when missing
  writeFile(file: string, text: string): void;
  mkdirp(dir: string): void;
}

export const nodeInstructionsFs: InstructionsFs = {
  readFile(file) {
    try {
      return nodeFs.readFileSync(file, 'utf8');
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw e;
    }
  },
  writeFile: (file, text) => nodeFs.writeFileSync(file, text, 'utf8'),
  mkdirp: (dir) => nodeFs.mkdirSync(dir, { recursive: true }),
};

export interface ApplyResult { target: InstructionTarget; file: string; action: UpsertAction }

/** Applies the section to each selected target under `root`. Only writes when the text changes. */
export function applyInstructions(root: string, targets: readonly InstructionTarget[], fs: InstructionsFs = nodeInstructionsFs): ApplyResult[] {
  return targets.map((target) => {
    const file = path.join(root, ...target.split('/'));
    const { text, action } = upsertSection(fs.readFile(file));
    if (action === 'created' || action === 'appended' || action === 'updated') {
      if (action === 'created') fs.mkdirp(path.dirname(file));
      fs.writeFile(file, text);
    }
    return { target, file, action };
  });
}

/** Workspace folders that hold a Flutter/Dart project (pubspec.yaml at the root or one level down). */
export function projectRoots(folders: readonly string[], exists: (p: string) => boolean = nodeFs.existsSync,
  subdirs: (p: string) => string[] = listSubdirs): string[] {
  return folders.filter((f) => exists(path.join(f, 'pubspec.yaml')) || subdirs(f).some((d) => exists(path.join(f, d, 'pubspec.yaml'))));
}

function listSubdirs(dir: string): string[] {
  try {
    return nodeFs.readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory() && !d.name.startsWith('.')).map((d) => d.name);
  } catch {
    return [];
  }
}

export function summarize(results: readonly ApplyResult[]): string {
  const by = (a: UpsertAction) => results.filter((r) => r.action === a).map((r) => r.target);
  const parts: string[] = [];
  const created = by('created');
  const written = [...by('appended'), ...by('updated')];
  const same = by('unchanged');
  if (created.length) parts.push(`created ${created.join(', ')}`);
  if (written.length) parts.push(`updated ${written.join(', ')}`);
  if (same.length) parts.push(`${same.join(', ')} already up to date`);
  return parts.length ? `Flutter Intercept agent instructions: ${parts.join('; ')}.` : 'Nothing to do.';
}

/**
 * Registers `flutterIntercept.addAgentInstructions`. The caller adds the command to package.json
 * (`contributes.commands`, title "Add AI Agent Instructions", category "Flutter Intercept").
 */
export function registerInstructionsCommand(context: vscodeTypes.ExtensionContext): vscodeTypes.Disposable {
  // Lazy so the pure functions above can be unit-tested without a VS Code host.
  const vscode = require('vscode') as typeof vscodeTypes;
  const disposable = vscode.commands.registerCommand('flutterIntercept.addAgentInstructions', async () => {
    const folders = (vscode.workspace.workspaceFolders ?? []).filter((f) => f.uri.scheme === 'file');
    if (!folders.length) {
      void vscode.window.showWarningMessage('Flutter Intercept: open your Flutter project folder first.');
      return;
    }
    const withProject = projectRoots(folders.map((f) => f.uri.fsPath));
    const candidates = withProject.length ? folders.filter((f) => withProject.includes(f.uri.fsPath)) : folders;
    let folder = candidates[0];
    if (candidates.length > 1) {
      const pick = await vscode.window.showQuickPick(
        candidates.map((f) => ({ label: f.name, description: f.uri.fsPath, folder: f })),
        { title: 'Flutter Intercept: add agent instructions to which folder?' },
      );
      if (!pick) return;
      folder = pick.folder;
    }
    const root = folder.uri.fsPath;

    const items = INSTRUCTION_TARGETS.map((target) => {
      const existing = nodeInstructionsFs.readFile(path.join(root, ...target.split('/')));
      const has = existing?.includes(SECTION_START);
      return {
        label: target,
        target,
        description: existing === undefined ? 'will be created' : has ? 'update the existing section' : 'add a section',
        detail: target === 'AGENTS.md' ? 'Read by many coding agents'
          : target === 'CLAUDE.md' ? 'Read by Claude Code' : 'Read by GitHub Copilot in VS Code',
        picked: existing !== undefined,
      };
    });
    const picked = await vscode.window.showQuickPick(items, {
      canPickMany: true,
      title: 'Flutter Intercept: add agent instructions',
      placeHolder: 'Choose the files to add or update (everything outside the marked section is kept)',
    });
    if (!picked?.length) return;

    let results: ApplyResult[];
    try {
      results = applyInstructions(root, picked.map((p) => p.target));
    } catch (e) {
      void vscode.window.showErrorMessage(`Flutter Intercept: could not write agent instructions: ${(e as Error).message}`);
      return;
    }
    const conflicts = results.filter((r) => r.action === 'conflict');
    if (conflicts.length) {
      void vscode.window.showWarningMessage(
        `Flutter Intercept: ${conflicts.map((c) => c.target).join(', ')} has an incomplete ${SECTION_START} … ${SECTION_END} block; fix or remove the markers and run the command again.`,
      );
    }
    const done = results.filter((r) => r.action !== 'conflict');
    if (!done.length) return;
    const open = 'Open';
    const choice = await vscode.window.showInformationMessage(summarize(done), open);
    if (choice === open) {
      const doc = await vscode.workspace.openTextDocument(done[0].file);
      await vscode.window.showTextDocument(doc);
    }
  });
  context.subscriptions.push(disposable);
  return disposable;
}
