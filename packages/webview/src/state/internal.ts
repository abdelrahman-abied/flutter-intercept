/** Small helpers shared by the reducer and the host-message handler (not re-exported). Split out of ../state.ts (QUALITY-1 Q6). */
import { hasMessagesTab } from '../frames';
import type { Exchange, Rule } from '../protocol';
import type { Composer, DetailTab, Notice } from './core';

let noticeSeq = 0;
let errorSeq = 0;
export const notice = (text: string, undoRules?: Rule[], short?: boolean): Notice => ({ id: ++noticeSeq, text, undoRules, short });
/** Id of the next host error kept for the banner. */
export const nextErrorId = (): number => ++errorSeq;


export function hideComposer(c: Composer | undefined): Composer | undefined {
  if (!c || !c.open) return c;
  return { ...c, open: false };
}


export function pick<T>(rec: Record<string, T>, keep: Map<string, unknown>): Record<string, T> {
  const out: Record<string, T> = {};
  for (const [k, v] of Object.entries(rec)) if (keep.has(k)) out[k] = v;
  return out;
}

export function tabFor(ex: Exchange | undefined, current: DetailTab): DetailTab {
  if (ex?.state === 'paused-response') return 'response';
  if (ex?.state === 'paused-request') return 'request';
  return current;
}

/**
 * Tab when the user selects an exchange: a paused phase wins; a WebSocket / SSE / gRPC exchange opens on its messages;
 * leaving one for a plain exchange goes back to the response.
 */
export function tabForSelect(ex: Exchange | undefined, current: DetailTab): DetailTab {
  const t = tabFor(ex, current);
  if (!ex || t !== current || (ex.state === 'paused-request' || ex.state === 'paused-response')) return t;
  if (current === 'timing') return 'timing'; // every exchange has a Timing tab: stay on it
  if (hasMessagesTab(ex)) return 'messages';
  return current === 'messages' ? 'response' : current;
}

export function omit<T>(rec: Record<string, T>, key: string): Record<string, T> {
  if (!(key in rec)) return rec;
  const { [key]: _, ...rest } = rec;
  return rest;
}
