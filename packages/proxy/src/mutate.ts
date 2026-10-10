// The `mutate` rule action (CONTRACTS §10.2): change fields of a real JSON response before the app
// gets it. This module only transforms bytes; routing / framing live in intercept-proxy.ts.
import { isUtf8 } from 'buffer';
import { decodeStrict } from './body';
import { applyOps } from './jsonpath';
import { MAX_JSON_OUTPUT, MAX_JSON_VALUES, parseJsonText, stringifyJsonText } from './json-text';
import { RESPONSE_PAUSE_LIMIT_BYTES } from './taps';
import type { MutateOp } from './types';

/** Decoded bodies above this are forwarded unchanged (the wire body is already capped at the same size). */
export const MUTATE_LIMIT_BYTES = RESPONSE_PAUSE_LIMIT_BYTES;
/**
 * Work / output budget (REVIEW-4 #4): at most this many places changed in total, places × value size and
 * the written body at most MUTATE_OUTPUT_LIMIT. Above → forwarded unchanged with a note.
 */
export const MUTATE_MAX_TARGETS = 1_000_000;
export const MUTATE_OUTPUT_LIMIT = MAX_JSON_OUTPUT; // 64 MB

const tick = () => new Promise<void>((r) => setImmediate(r));

export type MutateOutcome =
  /** `decoded`: the new body, not yet content-encoded. `unmatched`: op paths that changed nothing. */
  | { kind: 'mutated'; decoded: Buffer; label: string; unmatched: string[] }
  /** Forward the original response unchanged; `note` says why (Exchange.error on a completed exchange). */
  | { kind: 'skipped'; note: string };

const MB = 1024 * 1024;
const skipped = (why: string): MutateOutcome => ({ kind: 'skipped', note: `Mutate rule not applied: ${why}; the response was forwarded unchanged.` });

function preview(v: unknown): string {
  let s: string;
  try {
    s = JSON.stringify(v) ?? String(v);
  } catch {
    s = String(v);
  }
  return s.length > 24 ? `${s.slice(0, 23)}…` : s;
}

function describeOp(op: MutateOp): string {
  if (op.op === 'null') return `${op.path} → null`;
  if (op.op === 'delete') return `${op.path} removed`;
  if (typeof op.valueJson === 'string') {
    const s = op.valueJson.trim();
    return `${op.path} → ${s.length > 24 ? `${s.slice(0, 23)}…` : s}`;
  }
  return `${op.path} → ${preview(op.value)}`;
}

/**
 * `set` ops with `valueJson`: parsed here with the number-preserving parser (RawNumber leaves survive
 * applyOps' copy), so the literal lands in the body byte-exact. Throws on invalid valueJson.
 */
function withExactValues(ops: MutateOp[]): MutateOp[] {
  return ops.map((op, i) => {
    if (!op || op.op !== 'set' || op.valueJson === undefined) return op;
    if (typeof op.valueJson !== 'string') throw new Error(`op ${i} (set ${op.path}) has a valueJson that is not a string`);
    let value: unknown;
    try {
      value = parseJsonText(op.valueJson);
    } catch (e) {
      throw new Error(`op ${i} (set ${op.path}) has invalid valueJson (${(e as Error).message})`);
    }
    const { valueJson: _v, ...rest } = op;
    return { ...rest, value }; // a RawNumber (bare or nested) survives applyOps as a leaf
  });
}

/** `Mutated: $.avatar_url → null, $.items[*].id → "42" (+2 more)` — up to 3 ops, as written in the rule. */
export function mutateLabel(ops: MutateOp[]): string {
  const shown = ops.slice(0, 3).map(describeOp).join(', ');
  return `Mutated: ${shown}${ops.length > 3 ? ` (+${ops.length - 3} more)` : ''}`;
}

/**
 * Apply `ops` to a complete response body as it came off the wire (`raw`, per `contentEncoding`).
 * Non-JSON (incl. not UTF-8), invalid JSON, undecodable or too large bodies, bad ops and ops that
 * match nothing → skipped. Numbers the ops don't touch keep their exact text (src/json-text.ts); a
 * UTF-8 BOM is kept.
 */
export async function mutateBody(raw: Buffer, contentEncoding: string | undefined, ops: MutateOp[]): Promise<MutateOutcome> {
  if (!Array.isArray(ops) || ops.length === 0) return skipped('the rule has no operations');
  if (raw.length === 0) return skipped('the response has no body');
  let decoded: Buffer;
  try {
    decoded = await decodeStrict(raw, contentEncoding, MUTATE_LIMIT_BYTES);
  } catch (e) {
    if ((e as { code?: string }).code === 'E_FI_TOO_LARGE') {
      return skipped(`the response is larger than ${MUTATE_LIMIT_BYTES / MB} MB decoded`);
    }
    return skipped(`the body could not be decoded (${(e as Error).message})`);
  }
  if (decoded.length === 0) return skipped('the response has no body');
  if (!isUtf8(decoded)) return skipped('the body is not UTF-8 text, so it is not JSON');
  let text = decoded.toString('utf8');
  const bom = text.charCodeAt(0) === 0xfeff;
  if (bom) text = text.slice(1);
  // Each phase runs on the event loop (bounded: ≤ 2 M values, ≤ 64 MB out); yield between them.
  await tick();
  let json: unknown;
  try {
    json = parseJsonText(text, MAX_JSON_VALUES);
  } catch (e) {
    if (e instanceof RangeError) return skipped(`the body is too large to change (${e.message})`);
    return skipped(`the body is not valid JSON (${(e as Error).message})`);
  }
  text = '';
  await tick();
  let value: unknown;
  let changed: number[];
  try {
    // In place: `json` is ours, and dropped if an op fails.
    ({ value, changed } = applyOps(json, withExactValues(ops), { inPlace: true, maxTargets: MUTATE_MAX_TARGETS, maxWork: MUTATE_OUTPUT_LIMIT }));
  } catch (e) {
    return skipped((e as Error).message);
  }
  const applied = ops.filter((_, i) => changed[i] > 0);
  const unmatched = ops.filter((_, i) => changed[i] === 0).map((op) => op.path);
  if (applied.length === 0) return skipped(`nothing in the body matched ${unmatched.join(', ')}`);
  await tick();
  let out: string;
  try {
    out = stringifyJsonText(value, MUTATE_OUTPUT_LIMIT);
  } catch (e) {
    return skipped(`the result could not be written as JSON (${(e as Error).message})`);
  }
  return { kind: 'mutated', decoded: Buffer.from(bom ? `\ufeff${out}` : out, 'utf8'), label: mutateLabel(applied), unmatched };
}
