/**
 * Recording → proxy replay entries (CONTRACTS §12.4). Pure.
 */
import { createHash } from 'crypto';
import type { Body, Exchange, ReplayEntry, ReplayOptions } from '@flutter-intercept/proxy';
import type { Recording } from './types';

/** Headers that describe the wire framing of the recorded bytes, not the body replay sends. */
const FRAMING_HEADERS = new Set(['content-length', 'transfer-encoding', 'connection', 'keep-alive']);

/** Encodings the proxy decodes for display when they are the only one (packages/proxy/src/body.ts `DECODERS`). */
const DISPLAY_DECODED = new Set(['gzip', 'x-gzip', 'deflate', 'br']);

function encodingList(h: Record<string, string | string[]> | undefined): string[] {
  const out: string[] = [];
  for (const [k, v] of Object.entries(h ?? {})) {
    if (k.toLowerCase() !== 'content-encoding') continue;
    for (const part of (Array.isArray(v) ? v.join(',') : v).split(',')) {
      const e = part.trim().toLowerCase();
      if (e && e !== 'identity') out.push(e);
    }
  }
  return out;
}

/**
 * True when the recorded body is still the wire bytes for its `content-encoding` (CONTRACTS §12.8): the proxy's
 * display decode leaves zstd, stacked encodings and unknown encodings raw, and falls back to the raw bytes when
 * gzip / deflate data can't be inflated (recognised here by the gzip / zlib header on a binary body; brotli has no
 * signature, so a failed brotli decode is treated as decoded). Such entries keep `content-encoding` on replay.
 */
export function isStillEncoded(body: Body | undefined, responseHeaders: Record<string, string | string[]> | undefined): boolean {
  const encs = encodingList(responseHeaders);
  if (!encs.length || !body || !body.text) return false;
  if (encs.length > 1 || !DISPLAY_DECODED.has(encs[0])) return true;
  if (body.encoding !== 'base64') return false;
  const b = Buffer.from(body.text.slice(0, 8), 'base64');
  if (b.length < 2) return false;
  if (encs[0] === 'gzip' || encs[0] === 'x-gzip') return b[0] === 0x1f && b[1] === 0x8b;
  if (encs[0] === 'deflate') return (b[0] & 0x0f) === 8 && ((b[0] << 8) | b[1]) % 31 === 0;
  return false;
}

/** `ReplayOptions` for `rec` (its name labels replayed exchanges "Replayed from <name>"). */
export function replayOptionsFor(rec: Pick<Recording, 'name'>, fallback: ReplayOptions['fallback'], matchTemplates = true): ReplayOptions {
  return { fallback, matchTemplates, name: rec.name };
}

/**
 * `ReplayEntry.requestBodyHash`: hex sha256 of the decoded request body bytes (utf8 text as UTF-8, base64 text
 * decoded). Undefined for no / empty body. The proxy must hash the incoming decoded body the same way.
 */
export function requestBodyHash(body: Body | undefined): string | undefined {
  if (!body || !body.text) return undefined;
  const bytes = body.encoding === 'base64' ? Buffer.from(body.text, 'base64') : Buffer.from(body.text, 'utf8');
  if (bytes.length === 0) return undefined;
  return createHash('sha256').update(bytes).digest('hex');
}

/** True when this exchange can be replayed faithfully (finished HTTP with a status and a complete body). */
export function isReplayable(e: Exchange): boolean {
  return typeof e.status === 'number' && !e.kind && !e.responseBody?.truncated;
}

/**
 * The recording's responses in the order they were recorded (the proxy serves several responses for one key in
 * that order). Framing headers are dropped (the proxy re-frames the body); `content-encoding` is dropped for a
 * decoded body and kept when the body is still encoded (`isStillEncoded`). Exchanges whose
 * response body was truncated by the 5 MB display cap are skipped: replaying half a body would be worse than the
 * fallback. A request body that was truncated gives no hash (it could never match).
 */
export function toReplay(rec: Recording): ReplayEntry[] {
  return [...rec.entries]
    .map((e, i) => ({ e, i }))
    .sort((x, y) => x.e.startedAt - y.e.startedAt || x.i - y.i)
    .filter(({ e }) => isReplayable(e))
    .map(({ e }) => {
      const headers: Record<string, string | string[]> = {};
      const keepEncoding = isStillEncoded(e.responseBody, e.responseHeaders);
      for (const [k, v] of Object.entries(e.responseHeaders ?? {})) {
        const lk = k.toLowerCase();
        if (FRAMING_HEADERS.has(lk) || (lk === 'content-encoding' && !keepEncoding)) continue;
        Object.defineProperty(headers, k, { value: Array.isArray(v) ? [...v] : v, enumerable: true, writable: true, configurable: true });
      }
      const hash = e.requestBody?.truncated ? undefined : requestBodyHash(e.requestBody);
      const entry: ReplayEntry = { method: e.method.toUpperCase(), url: e.url, status: e.status!, headers };
      if (e.responseBody) entry.body = { text: e.responseBody.text, encoding: e.responseBody.encoding };
      if (hash) entry.requestBodyHash = hash;
      return entry;
    });
}
