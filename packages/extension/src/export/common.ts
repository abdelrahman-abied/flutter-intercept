/**
 * Shared pieces of the OpenAPI / Postman exports (CONTRACTS §13.5). Pure: no vscode, no fs.
 *
 * - Which exchanges are exported: finished HTTP exchanges with a response (`completed` / `mocked` with a status),
 *   vm-profile captures included; WebSocket, SSE, browser-internal, unfinished (pending / paused) and
 *   response-less (error / aborted / blocked) ones are skipped, each kind counted in a note.
 * - Path templates: `routeTemplate`'s id segments (`{id}`, `{id2}`, …), plus segments that are credentials
 *   (JWTs, opaque tokens: `/reset/eyJ…`), so a secret never becomes part of a path name.
 */
import type { Body, Exchange } from '@flutter-intercept/proxy';
import { STATUS_CODES } from 'http';
import { isIdSegment } from '../codegen/route';
import { prettyJson } from '../codegen/json';
import { redactSecretValues } from '../agent/redact';

export type Headers = Record<string, string | string[]>;

export interface Sample {
  e: Exchange;
  /** Upper-case method. */
  method: string;
  /** `https://api.example.com` (no userinfo). */
  origin: string;
  /** `api.example.com:8443` */
  host: string;
  /** Raw (percent-encoded) path segments after the leading `/`. */
  segments: string[];
  /** `/users/{id}/posts/{id2}` */
  template: string;
  /** For each path segment: the parameter name, or undefined for a literal segment. */
  params: (string | undefined)[];
}

export interface Selection {
  /** Oldest first (by `startedAt`, stable), so the last sample of a group is the latest. */
  samples: Sample[];
  notes: string[];
}

export const DEFAULT_MAX_EXAMPLE_CHARS = 20_000;

export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/** An id-like segment (`routeTemplate`) or one that holds a credential. */
export function isParamSegment(raw: string): boolean {
  const v = safeDecode(raw);
  return isIdSegment(v) || redactSecretValues(v, true) !== v;
}

/** `/users/42/posts/9f1c…` → `{ template: '/users/{id}/posts/{id2}', params: [undefined, 'id', undefined, 'id2'] }`. */
export function templatePath(segments: readonly string[]): { template: string; params: (string | undefined)[] } {
  let n = 0;
  const params = segments.map((seg) => (isParamSegment(seg) ? `id${++n === 1 ? '' : n}` : undefined));
  return { template: '/' + segments.map((seg, i) => (params[i] ? `{${params[i]}}` : seg)).join('/'), params };
}

const FINISHED = new Set(['completed', 'mocked']);

/** The exchanges an export uses, with notes for the ones it skips. */
export function selectExchanges(exchanges: readonly Exchange[]): Selection {
  const skipped = { websocket: 0, sse: 0, browser: 0, unfinished: 0, noResponse: 0, badUrl: 0 };
  const samples: Sample[] = [];
  const sorted = exchanges
    .map((e, i) => ({ e, i }))
    .sort((a, b) => (finite(a.e.startedAt) - finite(b.e.startedAt)) || a.i - b.i)
    .map((x) => x.e);
  for (const e of sorted) {
    if (e.kind === 'websocket') skipped.websocket++;
    else if (e.kind === 'sse') skipped.sse++;
    else if (e.browserInternal) skipped.browser++;
    else if (e.state === 'pending' || e.state === 'paused-request' || e.state === 'paused-response') skipped.unfinished++;
    else if (!FINISHED.has(e.state) || typeof e.status !== 'number') skipped.noResponse++;
    else {
      let u: URL;
      try {
        u = new URL(e.url);
      } catch {
        skipped.badUrl++;
        continue;
      }
      if (u.protocol !== 'http:' && u.protocol !== 'https:') {
        skipped.badUrl++;
        continue;
      }
      const segments = u.pathname.split('/').slice(1);
      const { template, params } = templatePath(segments);
      samples.push({ e, method: e.method.toUpperCase(), origin: u.origin, host: u.host, segments, template, params });
    }
  }
  const notes: string[] = [];
  if (skipped.websocket) notes.push(`${plural(skipped.websocket, 'WebSocket exchange')} skipped`);
  if (skipped.sse) notes.push(`${plural(skipped.sse, 'SSE exchange')} skipped`);
  if (skipped.browser) notes.push(`${plural(skipped.browser, 'browser-internal exchange')} skipped`);
  if (skipped.unfinished) notes.push(`${plural(skipped.unfinished, 'unfinished exchange')} (pending or paused) skipped`);
  if (skipped.noResponse) notes.push(`${plural(skipped.noResponse, 'exchange')} without a response (failed, aborted or blocked) skipped`);
  if (skipped.badUrl) notes.push(`${plural(skipped.badUrl, 'exchange')} with a non-HTTP URL skipped`);
  if (!samples.length) notes.push('No finished HTTP exchanges to export.');
  return { samples, notes };
}

function finite(v: number | undefined): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

export function headerValue(h: Headers | undefined, name: string): string | undefined {
  for (const [k, v] of Object.entries(h ?? {})) if (k.toLowerCase() === name) return Array.isArray(v) ? v[0] : v;
  return undefined;
}

/** Lower-case media type without parameters, or undefined when there is no `Content-Type`. */
export function mediaTypeOf(h: Headers | undefined): string | undefined {
  const ct = headerValue(h, 'content-type');
  const mt = ct?.split(';')[0].trim().toLowerCase();
  return mt || undefined;
}

export function isJsonMediaType(mt: string): boolean {
  return mt === 'application/json' || mt.endsWith('+json') || mt.endsWith('/json');
}

/** A body worth exporting: present and not empty. */
export function hasBody(b: Body | undefined): b is Body {
  return !!b && b.text.length > 0;
}

/** The media type a body is exported under: its `Content-Type`, else a guess from the content. */
export function bodyMediaType(b: Body, h: Headers | undefined): string {
  const mt = mediaTypeOf(h);
  if (mt) return mt;
  if (b.encoding === 'base64') return 'application/octet-stream';
  const t = b.text.trimStart();
  return t.startsWith('{') || t.startsWith('[') ? 'application/json' : 'text/plain';
}

/** `text` cut to `max` chars (with `…`), and whether it was cut. */
export function cut(text: string, max: number): { text: string; cut: boolean } {
  return text.length > max ? { text: `${text.slice(0, max)}…`, cut: true } : { text, cut: false };
}

export function reasonPhrase(status: number): string {
  return STATUS_CODES[status] ?? '';
}

/**
 * Raw JSON text embedded verbatim in the output (examples keep `1.0`, big integers and key order exactly).
 * Built with `jsonWithRaw`.
 */
export class RawJson {
  constructor(readonly text: string) {}
}

/** `JSON.stringify(value, null, 2)` where every `RawJson` is replaced by its text, re-indented in place. */
export function jsonWithRaw(value: unknown): string {
  const raws: string[] = [];
  const marker = (i: number) => `\u0000fi-raw-${i}\u0000`;
  const text = JSON.stringify(
    value,
    (_k, v: unknown) => {
      if (v instanceof RawJson) {
        raws.push(v.text);
        return marker(raws.length - 1);
      }
      return v;
    },
    2,
  );
  if (!raws.length) return text;
  return text.replace(/^( *)(.*?)"\\u0000fi-raw-(\d+)\\u0000"/gm, (whole, indent: string, prefix: string, i: string) => {
    const raw = raws[Number(i)];
    if (raw === undefined) return whole;
    let pretty: string;
    try {
      pretty = prettyJson(raw);
    } catch {
      pretty = JSON.stringify(raw);
    }
    return `${indent}${prefix}${pretty.replace(/\n/g, `\n${indent}`)}`;
  });
}
