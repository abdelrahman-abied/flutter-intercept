/**
 * v0.7.0 panel export (CONTRACTS §13.5 / §13.7 `export`). Pure.
 */
import type { Exchange, ExportFormat } from './protocol';

export const EXPORT_FORMATS: readonly ExportFormat[] = ['openapi', 'postman', 'har'];
export const EXPORT_LABEL: Record<ExportFormat, string> = { openapi: 'OpenAPI 3.1', postman: 'Postman collection', har: 'HAR' };
export const EXPORT_TITLE: Record<ExportFormat, string> = {
  openapi: 'An OpenAPI 3.1 description of the routes seen (paths, parameters, JSON schemas inferred from the bodies)',
  postman: 'A Postman v2.1 collection: one request per route, a folder per host, with example responses',
  har: 'An HTTP Archive of the exchanges, with timings — opens in browser dev tools and HAR viewers',
};

/** WebSocket and SSE exchanges are not part of an export. */
export const isExportable = (e: Pick<Exchange, 'kind'>): boolean => !e.kind;

export interface ExportScope {
  /** Ids to send with `export` (the filtered HTTP exchanges); undefined = everything shown (host default). */
  ids?: string[];
  /** How many exchanges the export covers. */
  count: number;
  filtered: boolean;
}

/**
 * The `export` scope: while a filter is active, the HTTP exchanges the list shows (their ids go along); otherwise no
 * ids — the host exports every HTTP exchange shown.
 */
export function exportScope(shown: readonly Exchange[], filtered: boolean): ExportScope {
  if (!filtered) {
    let count = 0;
    for (const e of shown) if (isExportable(e)) count++;
    return { count, filtered: false };
  }
  const ids = shown.filter(isExportable).map((e) => e.id);
  return { ids, count: ids.length, filtered: true };
}
