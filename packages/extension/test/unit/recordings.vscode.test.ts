import { describe, expect, it, vi } from 'vitest';
import type { Recording } from '../../src/recordings/types';

const calls: { registered: string[]; commands: unknown[][]; provider?: { provideTextDocumentContent(uri: unknown): string } } = { registered: [], commands: [] };

vi.mock('vscode', () => ({
  Uri: {
    from: (c: { scheme: string; path: string; query: string }) => ({ ...c, toString: () => `${c.scheme}:${c.path}?${c.query}` }),
  },
  workspace: {
    registerTextDocumentContentProvider: (scheme: string, provider: { provideTextDocumentContent(uri: unknown): string }) => {
      calls.registered.push(scheme);
      calls.provider = provider;
      return { dispose: () => undefined };
    },
  },
  commands: {
    executeCommand: async (...args: unknown[]) => {
      calls.commands.push(args);
    },
  },
}));

import { disposeRecordingDiffs, openRecordingDiff, RECORDING_DIFF_SCHEME } from '../../src/recordings/vscodeDiff';

const rec = (id: string, name: string, status: number): Recording => ({
  version: 1,
  id,
  name,
  createdAt: 0,
  exchanges: 1,
  path: `/x/${id}.json`,
  redacted: false,
  entries: [
    { id: 'e', startedAt: 1, method: 'GET', url: 'https://a.example.com/x', requestHeaders: {}, status, responseHeaders: {}, state: 'completed' },
  ],
});

describe('openRecordingDiff', () => {
  it('serves both normalised texts as virtual documents and runs vscode.diff', async () => {
    await openRecordingDiff(rec('a', 'Before: v1/2', 200), rec('b', 'After', 500));
    await openRecordingDiff(rec('a', 'Before: v1/2', 200), rec('b', 'After', 500));
    expect(calls.registered).toEqual([RECORDING_DIFF_SCHEME]); // registered once
    const [cmd, left, right, title] = calls.commands[0] as [string, { path: string }, { path: string }, string];
    expect(cmd).toBe('vscode.diff');
    expect(left.path).toBe('/Before- v1-2.txt');
    expect(title).toBe('Recordings: Before: v1/2 ↔ After');
    expect(calls.provider!.provideTextDocumentContent(left)).toContain('→ 200');
    expect(calls.provider!.provideTextDocumentContent(right)).toContain('→ 500');
    disposeRecordingDiffs();
    expect(calls.provider!.provideTextDocumentContent(left)).toBe('');
  });
});
