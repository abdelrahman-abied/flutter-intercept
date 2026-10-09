/**
 * Request → source (CONTRACTS §9.4): opens a resolved stack frame in an editor.
 * Dart prints 1-based line/column; VS Code positions are 0-based.
 */
import * as vscode from 'vscode';
import { checkSourcePath, type ResolvedFrame } from './resolve';

export interface OpenFrameOptions {
  /**
   * Directories files may be opened from: the workspace folders plus `packageRootsFor(projectRoots)`.
   * Frames are app-controlled (REVIEW-3 #3): anything else, UNC paths and symlink escapes are refused.
   */
  allowedRoots: string[];
  /** Test hook (default fs.realpathSync.native). */
  realpath?: (p: string) => string;
}

/** 0-based position for a Dart (1-based) line/column; missing or invalid values become 0. */
export function framePosition(frame: Pick<ResolvedFrame, 'line' | 'column'>): { line: number; character: number } {
  const zeroBased = (n: number | undefined) => (typeof n === 'number' && Number.isFinite(n) && n >= 1 ? Math.floor(n) - 1 : 0);
  return { line: zeroBased(frame.line), character: zeroBased(frame.column) };
}

/**
 * Opens the frame's file at its line:column and reveals it in the center. Only files whose real path is inside
 * `opts.allowedRoots`. Throws a readable Error.
 */
export async function openFrame(frame: ResolvedFrame, opts: OpenFrameOptions): Promise<vscode.TextEditor> {
  if (!frame.path) {
    throw new Error(`No source file for ${frame.fn ? `${frame.fn} (${frame.uri})` : frame.uri}: it is not in this workspace's packages.`);
  }
  const real = opts.realpath ? checkSourcePath(frame.path, opts.allowedRoots, opts.realpath) : checkSourcePath(frame.path, opts.allowedRoots);
  let doc: vscode.TextDocument;
  try {
    doc = await vscode.workspace.openTextDocument(vscode.Uri.file(real));
  } catch (e) {
    throw new Error(`Could not open ${real}: ${e instanceof Error ? e.message : String(e)}`);
  }
  const { line, character } = framePosition(frame);
  const pos = doc.validatePosition(new vscode.Position(line, character));
  const range = new vscode.Range(pos, pos);
  const editor = await vscode.window.showTextDocument(doc, { selection: range, preview: true });
  editor.revealRange(range, vscode.TextEditorRevealType.InCenter);
  return editor;
}
