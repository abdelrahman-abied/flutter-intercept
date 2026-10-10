/**
 * Recordings: save traffic, replay it as mocks, diff two of them (CONTRACTS §12.4–12.5). Lead-owned types.
 */
import type { Exchange, ReplayEntry } from '@flutter-intercept/proxy';

export interface RecordingMeta {
  id: string;            // file-name safe slug
  name: string;
  createdAt: number;
  exchanges: number;
  /** Where it lives: `.dart_tool/flutter_intercept/recordings/<id>.json` (not committed) unless the user exported it. */
  path: string;
  redacted: boolean;     // saved with secrets redacted (replay then sends "[redacted]" values)
}

export interface Recording extends RecordingMeta {
  version: 1;
  entries: Exchange[];   // finished HTTP exchanges only (no WebSocket / SSE / vm-profile)
}

export interface RecordingDiffEntry {
  route: string;         // "GET /users/{id}"
  change: 'added' | 'removed' | 'status' | 'shape' | 'body' | 'count' | 'timing';
  detail: string;        // "200 → 500", "+field avatar_url (string)", "3 → 5 calls"
}

export interface RecordingService {
  list(): Promise<RecordingMeta[]>;
  /** Saves the given finished exchanges as a recording. `redact` default false (local file under .dart_tool). */
  save(name: string, exchanges: Exchange[], opts?: { redact?: boolean }): Promise<RecordingMeta>;
  load(id: string): Promise<Recording>;
  remove(id: string): Promise<void>;
  /** Copies a recording to `dest` (a user-chosen path), optionally redacted; returns the written path. */
  export(id: string, dest: string, opts?: { redact?: boolean }): Promise<string>;
  toReplay(rec: Recording): ReplayEntry[];
  diff(a: Recording, b: Recording): RecordingDiffEntry[];
  /** Normalised, stable text of a recording for a side-by-side `vscode.diff` (bodies pretty-printed, volatile headers dropped). */
  diffText(rec: Recording): string;
}
