import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as zlib from 'zlib';
import {
  asHttpProfile,
  bodiesPatch,
  bodyPlan,
  cleanUrl,
  classifyEntry,
  clientName,
  diffExchange,
  isFinished,
  shouldFetchBodies,
  toBody,
  toExchange,
  toHeaders,
  type HttpProfile,
  type ProfileEntry,
} from '../../src/vm/profile';

// Recorded with the demo app (docs/spikes/vm-service.md): Android emulator debug (cronet_http + dart:io through the
// proxy, template v4) and macOS profile mode (cupertino_http), trimmed headers.
const fixture = <T>(name: string): T => JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'vm', name), 'utf8')) as T;
const android = fixture<HttpProfile>('android-debug-profile.json');
const macPending = fixture<HttpProfile>('macos-profile-pending.json');
const macDone = fixture<HttpProfile>('macos-profile-done.json');
const main = { main: true };
const worker = { main: false };

describe('classifyEntry (recorded profiles)', () => {
  it('imports only package:http_profile entries from the main isolate', () => {
    const verdicts = android.requests.map((q) => [q.id, q.method, classifyEntry(q, main)]);
    const imported = verdicts.filter((v) => v[2] === 'import').map((v) => v[0]);
    expect(imported).toEqual(['from_package/1', 'from_package/2']);
    // dart:io through the proxy (x-fi-id / proxyDetails), the trace side channel and CONNECT tunnels are skipped.
    expect(verdicts.filter((v) => v[1] === 'CONNECT').every((v) => v[2] === 'skip')).toBe(true);
    expect(verdicts.find((v) => String(v[0]) === android.requests.find((q) => q.uri.includes('trace.flutter-intercept'))!.id)![2]).toBe('skip');
  });

  it('imports pending native entries too (macOS profile mode)', () => {
    const imported = macPending.requests.filter((q) => classifyEntry(q, main) === 'import').map((q) => q.id);
    expect(imported).toEqual(['from_package/1', 'from_package/2']);
  });

  it('background isolates: dart:io is imported unless proxyDetails names OUR proxy; waits until the request is sent', () => {
    const direct: ProfileEntry = {
      id: '-1',
      method: 'GET',
      uri: 'https://jsonplaceholder.typicode.com/todos/2',
      startTime: 1_000_000,
      endTime: 1_100_000,
      request: { headers: { 'user-agent': ['Dart/3.13 (dart:io)'] } },
    };
    expect(classifyEntry(direct, worker)).toBe('import');
    expect(classifyEntry(direct, main)).toBe('skip');
    expect(classifyEntry({ ...direct, endTime: undefined, request: undefined }, worker)).toBe('wait');
    const ours = (host: string, port: number) => port === 8899 && (host === 'localhost' || host === '10.0.2.2');
    expect(classifyEntry({ ...direct, request: { headers: {}, proxyDetails: { host: 'localhost', port: 8899 } } }, worker, ours)).toBe('skip');
    // REVIEW-5 #14: another proxy (Charles, a corporate proxy) or a forged x-fi-id does not hide traffic.
    expect(classifyEntry({ ...direct, request: { headers: {}, proxyDetails: { host: '127.0.0.1', port: 8888 } } }, worker, ours)).toBe('import');
    expect(classifyEntry({ ...direct, request: { headers: {}, proxyDetails: { host: 'localhost', port: 8899 } } }, worker)).toBe('import');
    expect(classifyEntry({ ...direct, request: { headers: { 'X-FI-ID': ['abc'] } } }, worker)).toBe('import');
    expect(classifyEntry({ ...direct, id: 'from_package/3', request: { headers: { 'x-fi-id': ['abc'] } } }, main)).toBe('import');
  });

  it('rejects malformed entries', () => {
    expect(classifyEntry({} as ProfileEntry, main)).toBe('skip');
    expect(classifyEntry(null as unknown as ProfileEntry, main)).toBe('skip');
  });
});

describe('toExchange', () => {
  it('maps a finished cronet_http POST', () => {
    const q = android.requests.find((r) => r.id === 'from_package/2')!;
    const ex = toExchange(q)!;
    expect(ex).toMatchObject({
      method: 'POST',
      url: 'https://jsonplaceholder.typicode.com/posts',
      status: 201,
      state: 'completed',
      captured: 'vm-profile',
      startedAt: Math.round(q.startTime / 1000),
    });
    expect(ex.requestHeaders['content-type']).toBe('application/json; charset=utf-8');
    // package:http_profile split "Sat, 10 Oct 2026 …" on commas: joined back.
    expect(ex.responseHeaders?.date).toMatch(/^Sat, 10 Oct 2026 /);
    expect(ex.durationMs).toBe(Math.round((q.response!.endTime! - q.startTime) / 1000));
    expect(clientName(q)).toBe('cronet_http');
  });

  it('maps a pending cupertino_http GET', () => {
    const q = macPending.requests.find((r) => r.id === 'from_package/1')!;
    const ex = toExchange(q)!;
    expect(ex.state).toBe('pending');
    expect(ex.status).toBeUndefined();
    expect(ex.responseHeaders).toBeUndefined();
    expect(ex.durationMs).toBeUndefined();
    expect(isFinished(q)).toBe(false);
    expect(clientName(q)).toBe('cupertino_http');
  });

  it('maps errors', () => {
    const q: ProfileEntry = { id: 'from_package/9', method: 'get', uri: 'https://x.test/', startTime: 5_000_000, endTime: 5_200_000, request: { error: 'ClientException: Connection refused' }, response: {} };
    const ex = toExchange(q);
    expect(ex).toMatchObject({ method: 'GET', state: 'error', error: 'ClientException: Connection refused', durationMs: 200 });
  });

  it('keeps real dart:io multi-values, joins http_profile ones', () => {
    expect(toHeaders({ 'set-cookie': ['a=1', 'b=2'], x: ['1'] }, false)).toEqual({ 'set-cookie': ['a=1', 'b=2'], x: '1' });
    expect(toHeaders({ date: ['Sat', '10 Oct 2026 06:47:31 GMT'] }, true)).toEqual({ date: 'Sat, 10 Oct 2026 06:47:31 GMT' });
    expect(toHeaders(undefined, true)).toEqual({});
  });

  it('diffExchange returns only changed fields', () => {
    const before = toExchange(macPending.requests.find((r) => r.id === 'from_package/1')!);
    const after = toExchange(macDone.requests.find((r) => r.id === 'from_package/1')!);
    const patch = diffExchange(before!, after!);
    expect(patch).toMatchObject({ status: 200, state: 'completed' });
    expect(patch.method).toBeUndefined();
    expect(patch.url).toBeUndefined();
  });
});

describe('bodies', () => {
  it('decodes the detail payload (request + response, utf8)', () => {
    const detail = fixture<ProfileEntry>('android-detail-from_package_2.json');
    const patch = bodiesPatch(detail);
    expect(JSON.parse(patch.requestBody!.text)).toEqual({ title: 'native', body: 'from cronet_http', userId: 1 });
    expect(patch.requestBody!.encoding).toBe('utf8');
    expect(JSON.parse(patch.responseBody!.text)).toMatchObject({ id: 101 });
    // cronet hands decoded bytes although the headers still say gzip: no double decoding.
    const get = bodiesPatch(fixture<ProfileEntry>('android-detail-from_package_1.json'));
    expect(get.requestBody).toBeUndefined();
    expect(JSON.parse(get.responseBody!.text)).toMatchObject({ id: 1, userId: 1 });
  });

  it('gunzips still-compressed bodies, base64s binary, truncates', () => {
    const gz = [...zlib.gzipSync(Buffer.from('{"a":1}'))];
    expect(toBody(gz, { 'content-encoding': 'gzip' })).toEqual({ text: '{"a":1}', encoding: 'utf8' });
    expect(toBody([0, 1, 2, 255], { 'content-type': 'application/octet-stream' })).toEqual({ text: Buffer.from([0, 1, 2, 255]).toString('base64'), encoding: 'base64' });
    expect(toBody([0x89, 0x50, 0x4e, 0x47], { 'content-type': 'image/png' })!.encoding).toBe('base64');
    const big = toBody(Array.from({ length: 20 }, () => 0x61), {}, 10)!;
    expect(big).toEqual({ text: 'a'.repeat(10), encoding: 'utf8', truncated: true });
    expect(toBody([], {})).toBeUndefined();
    expect(toBody(undefined, {})).toBeUndefined();
  });

  it('REVIEW-5 #2: fetches bodies only for known lengths ≤ 1 MB on both sides and a textual response', () => {
    const json = { 'content-type': ['application/json; charset=utf-8'] };
    const base: ProfileEntry = { id: 'from_package/1', method: 'GET', uri: 'https://x.test/', startTime: 1, request: { headers: {}, contentLength: 0 }, response: { endTime: 2, statusCode: 200, headers: json, contentLength: 300 } };
    expect(bodyPlan(base)).toEqual({ fetch: true });
    expect(shouldFetchBodies(base)).toBe(true);
    // Unknown response length (chunked): not fetched, placeholder.
    expect(bodyPlan({ ...base, response: { ...base.response, contentLength: -1 } })).toEqual({
      fetch: false,
      responseBody: { text: '[body not imported: unknown length]', encoding: 'utf8', truncated: true },
    });
    // content-length header counts as known.
    expect(bodyPlan({ ...base, response: { ...base.response, contentLength: undefined, headers: { ...json, 'content-length': ['12'] } } }).fetch).toBe(true);
    // A 500 MB upload: never fetched (both bodies would come back as JSON number arrays).
    const upload: ProfileEntry = { ...base, method: 'POST', request: { headers: json, contentLength: 500 * 1024 * 1024 } };
    expect(bodyPlan(upload)).toEqual({
      fetch: false,
      requestBody: { text: `[body not imported: ${500 * 1024 * 1024} bytes]`, encoding: 'utf8', truncated: true },
      responseBody: { text: '[body not imported: 300 bytes]', encoding: 'utf8', truncated: true },
    });
    // A POST of unknown length.
    expect(bodyPlan({ ...upload, request: { headers: json } }).fetch).toBe(false);
    // Big or non-textual responses.
    expect(bodyPlan({ ...base, response: { ...base.response, contentLength: 5 * 1024 * 1024 } }).fetch).toBe(false);
    expect(bodyPlan({ ...base, response: { ...base.response, headers: { 'content-type': ['application/x-tar'] }, contentLength: 10 } })).toEqual({
      fetch: false,
      responseBody: { text: '[body not imported: 10 bytes, application/x-tar]', encoding: 'utf8', truncated: true },
    });
    // Empty responses need no type.
    expect(bodyPlan({ ...base, response: { ...base.response, headers: {}, contentLength: 0 } }).fetch).toBe(true);
  });
});

describe('asHttpProfile', () => {
  it('validates the shape', () => {
    expect(asHttpProfile(android)?.requests.length).toBe(android.requests.length);
    expect(asHttpProfile(undefined)).toBeUndefined();
    expect(asHttpProfile({ type: 'HttpProfile', requests: [] })).toBeUndefined();
    expect(asHttpProfile({ timestamp: 1, requests: [null, { id: 3 }, { id: 'ok', method: 'GET' }] })?.requests).toHaveLength(1);
  });
});

describe('REVIEW-5 #7: imported metadata is validated', () => {
  const base: ProfileEntry = { id: 'from_package/1', method: 'GET', uri: 'https://x.test/a', startTime: 1e15, request: { headers: {} }, response: {} };

  it('drops invalid methods and URLs', () => {
    expect(toExchange({ ...base, method: 'GET\u202etxt.exe' })).toBeUndefined();
    expect(toExchange({ ...base, method: 'X'.repeat(17) })).toBeUndefined();
    expect(toExchange({ ...base, uri: 'file:///etc/passwd' })).toBeUndefined();
    expect(toExchange({ ...base, uri: 'not a url' })).toBeUndefined();
    expect(toExchange({ ...base, uri: `https://x.test/${'a'.repeat(9000)}` })).toBeUndefined();
    expect(toExchange({ ...base, uri: 42 as unknown as string })).toBeUndefined();
    expect(cleanUrl('https://x.test/\u202eevil\u0000')).toBe('https://x.test/evil');
  });

  it('clamps times, status, error and headers', () => {
    const ex = toExchange(
      { ...base, startTime: Number.NaN, request: { headers: { ok: ['1'], 'bad name': ['x'], big: ['v'.repeat(10_000)], ctl: ['a\r\nb\u202ec'] }, error: 'e'.repeat(5000) }, response: { statusCode: Number.NaN } },
      () => 1234,
    )!;
    expect(ex.startedAt).toBe(1234);
    expect(ex.status).toBeUndefined();
    expect(ex.error!.length).toBe(1024);
    expect(ex.requestHeaders).toEqual({ ok: '1', big: 'v'.repeat(8 * 1024), ctl: 'abc' });
    expect(toExchange({ ...base, startTime: 1e30 }, () => 99)!.startedAt).toBe(99);
    expect(toExchange({ ...base, startTime: 'x' as unknown as number }, () => 7)!.startedAt).toBe(7);
    expect(toExchange({ ...base, response: { statusCode: 2000 } })!.status).toBeUndefined();
    expect(toExchange({ ...base, response: { statusCode: 200.5 } })!.status).toBeUndefined();
  });

  it('caps header count and total size', () => {
    const many = Object.fromEntries(Array.from({ length: 300 }, (_, i) => [`h${i}`, ['v']]));
    expect(Object.keys(toHeaders(many, false))).toHaveLength(100);
    const huge = Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`h${i}`, ['v'.repeat(8000)]]));
    const out = toHeaders(huge, false);
    const total = Object.entries(out).reduce((n, [k, v]) => n + k.length + String(v).length, 0);
    expect(total).toBeLessThanOrEqual(64 * 1024);
  });

  it('only well-formed client package names', () => {
    expect(clientName({ ...base, request: { connectionInfo: { package: 'package:cupertino_http' } } })).toBe('cupertino_http');
    expect(clientName({ ...base, request: { connectionInfo: { package: 'package:evil\nline' } } })).toBeUndefined();
    expect(clientName({ ...base, request: { connectionInfo: { package: 'package:\u202eexe' } } })).toBeUndefined();
  });
});
