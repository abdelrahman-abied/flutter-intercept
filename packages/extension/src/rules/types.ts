/**
 * Shared rules in the repo (CONTRACTS §12.1–12.2). Shared types, lead-owned. Implemented in src/rules/**.
 */
import type { Rule } from '@flutter-intercept/proxy';

/** `.vscode/flutter-intercept.json` (committed with the project). */
export interface SharedRulesFile {
  version: 1;
  rules: Rule[];
}

export interface SharedRulesState {
  /** Workspace-relative path of the file, when one exists. */
  file?: string;
  rules: Rule[];                 // validated, each with `shared: true`
  /** Readable problems with the file (parse errors, invalid rules skipped). */
  problems: string[];
  /** Rules held back until the user approves them (mapRemote / rewrite to other hosts, CONTRACTS §12.1; every shared
   * `script` rule, CONTRACTS §13.4; and personal script rules whose file contents aren't approved, REVIEW-7 #1 — ids
   * without the `shared:` prefix). Script file contents are approved per file. */
  pendingApproval: Rule[];
}

export interface SharedRulesService {
  state(): SharedRulesState;
  onDidChange(listener: (s: SharedRulesState) => void): { dispose(): void };
  /** Writes the given rules (shared ones) to the file, creating it; keeps the user's formatting where possible. */
  save(rules: Rule[]): Promise<void>;
  /** The user approved the held-back rules of the current file content (remembered per content hash). */
  approvePending(): Promise<void>;
  /** Resolves `mock.bodyFile` (workspace-relative, inside the workspace only) to text; watched for changes. */
  resolveBodyFile(path: string): Promise<string>;
  onDidChangeBodyFile(listener: (path: string) => void): { dispose(): void };
  /**
   * CONTRACTS §13.4: resolves `script.file` (workspace-relative `.js`, inside the workspace, regular file ≤ 256 KB)
   * to its source; watched like body files (onDidChangeBodyFile fires for it too).
   */
  resolveScriptFile(path: string): Promise<string>;
}
