/**
 * Opens two recordings side by side in VS Code's diff editor (CONTRACTS §12.5). The normalised texts are served
 * from read-only virtual documents (no temp files holding traffic on disk).
 */
import * as vscode from 'vscode';
import { diffText } from './diff';
import type { Recording } from './types';

export const RECORDING_DIFF_SCHEME = 'flutter-intercept-recording';
const MAX_DOCS = 20;

const docs = new Map<string, string>(); // uri path + query → text
let registration: vscode.Disposable | undefined;
let seq = 0;

function ensureProvider(): void {
  if (registration) return;
  const provider: vscode.TextDocumentContentProvider = {
    provideTextDocumentContent: (uri) => docs.get(`${uri.path}?${uri.query}`) ?? '',
  };
  registration = vscode.workspace.registerTextDocumentContentProvider(RECORDING_DIFF_SCHEME, provider);
}

function put(rec: Recording, n: number): vscode.Uri {
  const label = rec.name.replace(/[\\/:*?"<>|#%\0-\x1f]+/g, '-').slice(0, 80) || rec.id;
  const uri = vscode.Uri.from({ scheme: RECORDING_DIFF_SCHEME, path: `/${label}.txt`, query: `${rec.id}-${n}` });
  docs.set(`${uri.path}?${uri.query}`, diffText(rec));
  while (docs.size > MAX_DOCS) docs.delete(docs.keys().next().value as string);
  return uri;
}

/** Opens `vscode.diff` with recording `a` on the left and `b` on the right. */
export async function openRecordingDiff(a: Recording, b: Recording): Promise<void> {
  ensureProvider();
  const n = ++seq;
  const left = put(a, n);
  const right = put(b, n);
  await vscode.commands.executeCommand('vscode.diff', left, right, `Recordings: ${a.name} ↔ ${b.name}`, { preview: true });
}

/** Unregisters the content provider (extension deactivate); safe to call more than once. */
export function disposeRecordingDiffs(): void {
  registration?.dispose();
  registration = undefined;
  docs.clear();
}
