/**
 * Stateful-mock summaries and helpers for a headless run (CONTRACTS §22.6, §22.11, §24.1).
 *
 * The proxy handlers themselves come from `MockCollectionsCore` (`collections.ts`); this module keeps the summary
 * formatters, change tallying and URL-param helper.
 */
import type { RequestHandler } from '@flutter-intercept/proxy';
import { COLLECTION_RULE_PREFIX, type PathSegment, type StoreOp } from '../../extension/src/mocks/types';

/** `collection:<linkId>` (§22.1): the handler id of a collection. */
export function storeHandlerId(linkId: string): string {
  return `${COLLECTION_RULE_PREFIX}${linkId}`;
}

/** Path params of `url` for an endpoint's path, percent-decoded; undefined when the path doesn't line up. */
export function pathParams(segments: readonly PathSegment[], url: string): Record<string, string> | undefined {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return undefined;
  }
  const parts = u.pathname.split('/').filter((s) => s !== '');
  if (parts.length !== segments.length) return undefined;
  const out = Object.create(null) as Record<string, string>;
  segments.forEach((s, i) => {
    if (typeof s === 'string') return;
    let v = parts[i];
    try {
      v = decodeURIComponent(v);
    } catch {
      // keep it as sent
    }
    out[s.param] = v;
  });
  return out;
}

/** Counts of successful changes per resource during the run (the summary). */
export interface StoreChanges {
  created: number;
  updated: number;
  deleted: number;
}

/** Tallies created / updated / deleted records from a store answer (2xx only). */
export function tally(changes: Map<string, StoreChanges>, o: { resource: string; op: StoreOp }, a: { status: number }): void {
  if (a.status < 200 || a.status > 299) return;
  const c = changes.get(o.resource) ?? { created: 0, updated: 0, deleted: 0 };
  if (o.op === 'create') c.created++;
  else if (o.op === 'replace' || o.op === 'patch') c.updated++;
  else if (o.op === 'delete') c.deleted++;
  else return;
  changes.set(o.resource, c);
}

/** One collection's store for the length of a run (backed by `MockCollectionsCore`). */
export interface CollectionStore {
  id: string;
  name: string;
  handlerId: string;
  resources: { name: string }[];
  /** Current record counts per resource name. */
  counts(): Record<string, number>;
  /** Proxy handler (the core's answer pipeline, wrapped to tally store writes). */
  handler: RequestHandler;
  changes: Map<string, StoreChanges>;
  /** The snapshot the data started from (a name or a file), when any. */
  startsFrom?: string;
}

/** `store users: 12 records (3 created, 1 deleted)`, one line per resource (§22.11). */
export function storeSummary(stores: readonly CollectionStore[]): string[] {
  const named = stores.length > 1;
  const lines: string[] = [];
  for (const s of stores) {
    const counts = s.counts();
    for (const res of s.resources) {
      const n = counts[res.name] ?? 0;
      const c = s.changes.get(res.name);
      const parts = c ? [c.created && `${c.created} created`, c.updated && `${c.updated} updated`, c.deleted && `${c.deleted} deleted`].filter(Boolean) : [];
      lines.push(`store ${res.name}${named ? ` (${s.name})` : ''}: ${n} record${n === 1 ? '' : 's'}${parts.length ? ` (${parts.join(', ')})` : ''}`);
    }
  }
  return lines;
}

/** `collection "Shop API": sign-in: 1 session`, one line per collection with sign-in simulation on (§24.1). */
export function authSummary(collections: readonly { name: string; sessions(): number }[]): string[] {
  return collections.map((c) => {
    const n = c.sessions();
    return `collection "${c.name}": sign-in: ${n} session${n === 1 ? '' : 's'}`;
  });
}
