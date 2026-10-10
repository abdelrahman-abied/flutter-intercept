/**
 * HAR 1.2 export of recorded exchanges (CONTRACTS §8 `export_har`), redacted per setting, written
 * under `<project>/.dart_tool/flutter_intercept/exports/<timestamp>.har`. Pure except `writeHar`.
 */
import * as fs from 'fs';
import * as path from 'path';
import type { Body, Exchange } from '@flutter-intercept/proxy';
import { Headers, redactBodyText, redactFrameText, redactHeaders, redactSecretValues, redactText, redactUrl } from './redact';

export interface HarOptions {
  redact: boolean;
  creatorVersion?: string;
}

type NV = { name: string; value: string };

function headerList(h: Headers | undefined): NV[] {
  const out: NV[] = [];
  for (const [name, v] of Object.entries(h ?? {})) for (const value of Array.isArray(v) ? v : [v]) out.push({ name, value });
  return out;
}

function headerValue(h: Headers | undefined, name: string): string | undefined {
  for (const [k, v] of Object.entries(h ?? {})) if (k.toLowerCase() === name) return Array.isArray(v) ? v[0] : v;
  return undefined;
}

function queryList(url: string): NV[] {
  try {
    const out: NV[] = [];
    new URL(url).searchParams.forEach((value, name) => out.push({ name, value }));
    return out;
  } catch {
    return [];
  }
}

function bodyBytes(b: Body | undefined): number {
  if (!b) return 0;
  return b.encoding === 'base64' ? Buffer.from(b.text, 'base64').length : Buffer.byteLength(b.text, 'utf8');
}

function bodyText(b: Body, headers: Headers | undefined, redact: boolean): string {
  return b.encoding === 'utf8' && redact ? redactBodyText(b.text, headers) : b.text;
}

/** REVIEW-5 #7: an ISO time for HAR even when `ms` is not a valid date (imported entries); epoch 0 then. */
function isoTime(ms: number): string {
  const d = new Date(Number.isFinite(ms) ? ms : 0);
  return Number.isNaN(d.getTime()) ? new Date(0).toISOString() : d.toISOString();
}

const finiteOr = (v: number | undefined, fallback: number): number => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);

const ms = (v: number | undefined): number | undefined => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.round(v) : undefined);

/**
 * CONTRACTS §13.2: `Exchange.timings` → HAR `timings`. `blocked` = requestMs + pausedMs + delayMs, `dns`, `connect`
 * (TCP + TLS, as HAR defines it), `ssl`, `send`, `wait`, `receive`. The optional phases are -1 when unknown or not
 * applicable (a reused connection); `send` / `wait` / `receive` are required non-negative by HAR 1.2, so unknown is 0
 * there. Without timings (older recordings) the whole duration counts as `wait`.
 */
export function harTimings(e: Pick<Exchange, 'timings' | 'durationMs'>): Record<string, number> {
  const t = e.timings;
  if (!t) return { send: 0, wait: Math.max(0, finiteOr(e.durationMs, 0)), receive: 0 };
  const sum = (...vs: (number | undefined)[]): number => {
    const known = vs.map(ms).filter((v): v is number => v !== undefined);
    return known.length ? known.reduce((a, b) => a + b, 0) : -1;
  };
  const tls = t.reused ? undefined : ms(t.tlsMs);
  return {
    blocked: sum(t.requestMs, t.pausedMs, t.delayMs),
    dns: t.reused ? -1 : (ms(t.dnsMs) ?? -1),
    connect: t.reused ? -1 : sum(t.connectMs, tls),
    ssl: tls ?? -1,
    send: ms(t.sendMs) ?? 0,
    wait: ms(t.waitMs) ?? 0,
    receive: ms(t.receiveMs) ?? 0,
  };
}

const OPCODES: Record<string, number> = { text: 1, binary: 2, close: 8, ping: 9, pong: 10 };

/**
 * CONTRACTS §11: WebSocket frames as Chrome's `_webSocketMessages`, SSE events as `_eventSourceMessages`
 * (time in seconds, redacted like get_frames).
 */
function frameFields(e: Exchange, redact: boolean): Record<string, unknown> {
  if (!e.kind || !e.frames?.length) return {};
  const text = (t: string | undefined) => (t === undefined ? '' : redact ? redactFrameText(t) : t);
  if (e.kind === 'websocket') {
    return {
      _webSocketMessages: e.frames.map((f) => ({
        type: f.dir,
        time: finiteOr(f.at, 0) / 1000,
        opcode: OPCODES[f.kind] ?? 1,
        // Redacted: binary summarised like get_frames (REVIEW-5 #17).
        data: f.base64 !== undefined && f.text === undefined ? (redact ? `[binary ${f.size} bytes]` : f.base64) : text(f.text),
      })),
    };
  }
  return {
    _eventSourceMessages: e.frames.map((f) => ({
      time: finiteOr(f.at, 0) / 1000,
      eventName: f.event ?? 'message',
      eventId: f.id === undefined ? '' : redact ? redactSecretValues(f.id, true) : f.id,
      data: text(f.text),
    })),
  };
}

export function buildHar(exchanges: Exchange[], opts: HarOptions): Record<string, unknown> {
  const r = opts.redact;
  const entries = [...exchanges]
    .sort((a, b) => finiteOr(a.startedAt, 0) - finiteOr(b.startedAt, 0))
    .map((e) => {
      const url = r ? redactUrl(e.url) : e.url;
      const reqHeaders = r ? redactHeaders(e.requestHeaders) : e.requestHeaders;
      const resHeaders = r ? redactHeaders(e.responseHeaders) : e.responseHeaders;
      const reqMime = headerValue(e.requestHeaders, 'content-type') ?? 'application/octet-stream';
      const resMime = headerValue(e.responseHeaders, 'content-type') ?? '';
      const time = Math.max(0, finiteOr(e.durationMs, 0));
      const entry: Record<string, unknown> = {
        startedDateTime: isoTime(e.startedAt),
        time,
        request: {
          method: e.method,
          url,
          httpVersion: 'HTTP/1.1',
          cookies: [],
          headers: headerList(reqHeaders),
          queryString: queryList(url),
          headersSize: -1,
          bodySize: e.requestBody ? bodyBytes(e.requestBody) : 0,
          ...(e.requestBody
            ? {
                postData: {
                  mimeType: reqMime,
                  text: bodyText(e.requestBody, e.requestHeaders, r),
                  ...(e.requestBody.encoding === 'base64' ? { encoding: 'base64' } : {}),
                },
              }
            : {}),
        },
        response: {
          status: e.status ?? 0,
          statusText: '',
          httpVersion: 'HTTP/1.1',
          cookies: [],
          headers: headerList(resHeaders),
          content: {
            size: bodyBytes(e.responseBody),
            mimeType: resMime,
            ...(e.responseBody
              ? { text: bodyText(e.responseBody, e.responseHeaders, r), ...(e.responseBody.encoding === 'base64' ? { encoding: 'base64' } : {}) }
              : {}),
            ...(e.responseBody?.truncated ? { comment: 'body truncated by Flutter Intercept (size cap)' } : {}),
          },
          redirectURL: headerValue(e.responseHeaders, 'location') ?? '',
          headersSize: -1,
          bodySize: e.responseBody ? bodyBytes(e.responseBody) : -1,
        },
        cache: {},
        timings: harTimings(e),
        ...(e.timings?.reused ? { _reusedConnection: true } : {}),
        _state: e.state,
        ...(e.matchedRuleId ? { _matchedRuleId: e.matchedRuleId } : {}),
        ...(e.error ? { _error: r ? redactText(e.error) : e.error } : {}),
        ...(e.framesDropped ? { _framesDropped: e.framesDropped } : {}),
        ...(e.graphql ? { _graphql: { ...e.graphql } } : {}),
        ...(e.captured ? { _captured: e.captured } : {}),
        ...frameFields(e, r),
      };
      return entry;
    });
  return {
    log: {
      version: '1.2',
      creator: { name: 'Flutter Intercept', version: opts.creatorVersion ?? '0' },
      pages: [],
      entries,
      comment: r ? 'Secrets redacted (flutterIntercept.agent.redactSecrets).' : 'Not redacted.',
    },
  };
}

export const EXPORT_DIR = path.join('.dart_tool', 'flutter_intercept', 'exports');

/**
 * REVIEW-6 #9: `<root>/<rel>` as a real directory INSIDE the project: every existing component is `lstat`ed (a
 * symlink or a non-directory is refused, so a repo can't point `.dart_tool/…` at a tracked or synced folder) and
 * realpath-checked; missing ones are created one at a time (never `recursive`). Returns the real path.
 */
export async function ensureDirInside(root: string, rel: string): Promise<string> {
  const realRoot = await fs.promises.realpath(root);
  let cur = realRoot;
  for (const seg of rel.split(/[\\/]+/).filter(Boolean)) {
    if (seg === '.' || seg === '..') throw new Error(`refusing to write outside the project (${rel})`);
    const next = path.join(cur, seg);
    let st: fs.Stats;
    try {
      st = await fs.promises.lstat(next);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
      try {
        await fs.promises.mkdir(next);
      } catch (m) {
        if ((m as NodeJS.ErrnoException).code !== 'EEXIST') throw m;
      }
      st = await fs.promises.lstat(next);
    }
    if (st.isSymbolicLink() || !st.isDirectory()) {
      throw new Error(`refusing to write into ${path.relative(realRoot, next) || seg}: it is ${st.isSymbolicLink() ? 'a symbolic link' : 'not a folder'} (the export must stay inside the project)`);
    }
    const real = await fs.promises.realpath(next);
    if (real !== next) throw new Error(`refusing to write into ${path.relative(realRoot, next)}: it resolves outside the project`);
    cur = next;
  }
  return cur;
}

/** Writes `har` to `<projectRoot>/.dart_tool/flutter_intercept/exports/<timestamp>.har`; returns the path. */
export async function writeHar(projectRoot: string, har: Record<string, unknown>, now: Date = new Date()): Promise<string> {
  return writeExportFile(projectRoot, JSON.stringify(har, null, 2), '.har', now);
}

/**
 * CONTRACTS §13.8: writes `text` to `<projectRoot>/.dart_tool/flutter_intercept/exports/<timestamp><ext>` (e.g.
 * `.openapi.json`) with the same safe-directory checks as `writeHar`; never replaces an existing file. Returns the path.
 */
export async function writeExportFile(projectRoot: string, text: string, ext: string, now: Date = new Date()): Promise<string> {
  if (!/^(\.[a-z0-9_]+)+$/i.test(ext)) throw new Error(`unexpected export file extension ${JSON.stringify(ext)}`);
  const dir = await ensureDirInside(projectRoot, EXPORT_DIR);
  const stamp = now.toISOString().replace(/[:.]/g, '-');
  for (let n = 1; ; n++) {
    const name = n === 1 ? `${stamp}${ext}` : `${stamp}-${n}${ext}`;
    try {
      // `wx`: never follows or replaces an existing entry (file or symlink planted in the folder).
      await fs.promises.writeFile(path.join(dir, name), text, { encoding: 'utf8', flag: 'wx' });
      // Reported under the project path as given (every component below it was checked to be a real folder).
      return path.join(projectRoot, EXPORT_DIR, name);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST' || n >= 1000) throw e;
    }
  }
}
