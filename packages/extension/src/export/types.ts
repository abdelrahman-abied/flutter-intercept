/**
 * OpenAPI / Postman export from recorded traffic (CONTRACTS §13.5). Shared types, lead-owned. Implemented in
 * src/export/** (pure: no vscode, no fs).
 */
import type { Exchange } from '@flutter-intercept/proxy';

export interface ExportOptions {
  /** Document / collection title, e.g. the Flutter project's name. */
  title: string;
  /** Redact secrets (headers, query params, JSON fields; CONTRACTS §8 rules). Default true. */
  redact?: boolean;
  /** Example bodies longer than this are cut (with a note). Default 20 000 chars. */
  maxExampleChars?: number;
}

export interface ExportResult {
  /** Pretty-printed JSON text (2 spaces), ready to write. */
  text: string;
  /** Exchanges used (finished HTTP only; WebSocket / SSE / browser-internal / unfinished skipped). */
  exchanges: number;
  /** Distinct routes (method + path template). */
  routes: number;
  /** Human notes, e.g. "3 WebSocket exchanges skipped". */
  notes: string[];
}

/** OpenAPI 3.1 document (JSON). */
export type ToOpenApi = (exchanges: readonly Exchange[], opts: ExportOptions) => ExportResult;
/** Postman Collection v2.1 (JSON). */
export type ToPostman = (exchanges: readonly Exchange[], opts: ExportOptions) => ExportResult;
