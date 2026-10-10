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
        timings: { send: 0, wait: time, receive: 0 },
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

/** Writes `har` to `<projectRoot>/.dart_tool/flutter_intercept/exports/<timestamp>.har`; returns the path. */
export async function writeHar(projectRoot: string, har: Record<string, unknown>, now: Date = new Date()): Promise<string> {
  const dir = path.join(projectRoot, EXPORT_DIR);
  await fs.promises.mkdir(dir, { recursive: true });
  const stamp = now.toISOString().replace(/[:.]/g, '-');
  let file = path.join(dir, `${stamp}.har`);
  for (let n = 2; fs.existsSync(file); n++) file = path.join(dir, `${stamp}-${n}.har`);
  await fs.promises.writeFile(file, JSON.stringify(har, null, 2), 'utf8');
  return file;
}
