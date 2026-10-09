import { describe, expect, it } from 'vitest';
import {
  base64ByteLength, bodyByteLength, describeMatcherUrl, formatBytes, formatCountdown, formatDuration, headerValue,
  isJsonContentType, pauseClock, splitUrl, statusClassOf, utf8ByteLength, validateJson,
} from '../src/util';
import { isHostMsg } from '../src/host';

describe('validateJson', () => {
  it('accepts valid JSON of every shape', () => {
    for (const s of ['{}', '[]', '0', '-1.5e+3', '"x\\u00e9\\n"', 'true', 'null', ' {"a":[1,{"b":null}],"c":"d"} ']) {
      expect(validateJson(s)).toEqual({ ok: true });
      expect(() => JSON.parse(s)).not.toThrow();
    }
  });
  it('rejects what JSON.parse rejects, with line/column', () => {
    const cases: [string, number, number][] = [
      ['{"a":1,}', 1, 8],
      ['{\n  "a": 1\n  "b": 2\n}', 3, 3],
      ["{'a':1}", 1, 2],
      ['[1 2]', 1, 4],
      ['{"a":tru}', 1, 6],
      ['', 1, 1],
      ['{"a":1} x', 1, 9],
      ['"tab\there"', 1, 5],
      ['01', 1, 2],
      ['{"a":"\\x"}', 1, 7],
    ];
    for (const [text, line, column] of cases) {
      expect(() => JSON.parse(text)).toThrow();
      expect(validateJson(text)).toMatchObject({ ok: false, line, column });
    }
  });
  it('validates a large document quickly', () => {
    const big = JSON.stringify({ items: Array.from({ length: 50_000 }, (_, i) => ({ id: i, name: `n${i}`, tags: ['a', 'b'] })) });
    const t = performance.now();
    expect(validateJson(big).ok).toBe(true);
    expect(performance.now() - t).toBeLessThan(1000);
  });
});

describe('matcher descriptions (matching itself is the proxy\'s)', () => {
  it('classifies any / glob / regex and reports regex errors', () => {
    expect(describeMatcherUrl('')).toEqual({ kind: 'any' });
    expect(describeMatcherUrl(' * ')).toEqual({ kind: 'any' });
    expect(describeMatcherUrl('https://a.com/*')).toEqual({ kind: 'glob' });
    expect(describeMatcherUrl('/USERS\\/\\d+$/i')).toEqual({ kind: 'regex', source: 'USERS\\/\\d+$', flags: 'i' });
    expect(describeMatcherUrl('/[/')).toMatchObject({ kind: 'regex', error: expect.any(String) });
  });
});

describe('pause countdown', () => {
  const now = 1_000_000;
  it('formatCountdown is m:ss, rounded up, never negative', () => {
    expect(formatCountdown(272_000)).toBe('4:32');
    expect(formatCountdown(271_001)).toBe('4:32');
    expect(formatCountdown(5_000)).toBe('0:05');
    expect(formatCountdown(-10)).toBe('0:00');
  });
  it('counts down to pauseDeadline, urgent in the last 30 s, then auto-resuming', () => {
    expect(pauseClock({ state: 'paused-request', pausedAt: now, pauseDeadline: now + 300_000 }, now + 28_000))
      .toMatchObject({ label: '4:32', urgent: false });
    expect(pauseClock({ state: 'paused-response', pauseDeadline: now + 20_000 }, now)).toMatchObject({ label: '0:20', urgent: true });
    expect(pauseClock({ state: 'paused-response', pauseDeadline: now }, now + 1)).toMatchObject({ label: '0:00', title: 'Auto-resuming unedited…' });
  });
  it('falls back to time since pausedAt, and is undefined when not paused', () => {
    expect(pauseClock({ state: 'paused-request', pausedAt: now }, now + 12_000)).toMatchObject({ label: '0:12', title: 'Paused for 0:12' });
    expect(pauseClock({ state: 'paused-request' }, now)).toBeUndefined();
    expect(pauseClock({ state: 'completed', pauseDeadline: now + 5 }, now)).toBeUndefined();
  });
});

describe('formatting and helpers', () => {
  it('formatBytes / formatDuration', () => {
    expect(formatBytes(undefined)).toBe('');
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(2048)).toBe('2.0 kB');
    expect(formatBytes(5 * 1024 * 1024)).toBe('5.0 MB');
    expect(formatDuration(12.4)).toBe('12 ms');
    expect(formatDuration(1234)).toBe('1.23 s');
    expect(formatDuration(65_000)).toBe('1m 5s');
  });
  it('byte lengths', () => {
    expect(base64ByteLength('AAEC')).toBe(3);
    expect(base64ByteLength('AAE=')).toBe(2);
    expect(base64ByteLength('AA==')).toBe(1);
    expect(utf8ByteLength('aé€😀')).toBe(1 + 2 + 3 + 4);
    expect(bodyByteLength({ text: 'AAEC', encoding: 'base64' })).toBe(3);
    expect(bodyByteLength(undefined)).toBeUndefined();
  });
  it('statusClassOf', () => {
    expect(statusClassOf({ state: 'completed', status: 204 })).toBe('2xx');
    expect(statusClassOf({ state: 'mocked', status: 503 })).toBe('5xx');
    expect(statusClassOf({ state: 'error' })).toBe('error');
    expect(statusClassOf({ state: 'aborted', status: 200 })).toBe('error');
    expect(statusClassOf({ state: 'blocked' })).toBe('error');
    expect(statusClassOf({ state: 'blocked', status: 403 })).toBe('4xx');
    expect(statusClassOf({ state: 'pending' })).toBeUndefined();
  });
  it('headerValue / isJsonContentType / splitUrl', () => {
    expect(headerValue({ 'Content-Type': 'a' }, 'content-type')).toBe('a');
    expect(headerValue({ 'set-cookie': ['a', 'b'] }, 'Set-Cookie')).toBe('a, b');
    expect(isJsonContentType('application/json; charset=utf-8')).toBe(true);
    expect(isJsonContentType('application/problem+json')).toBe(true);
    expect(isJsonContentType('text/html')).toBe(false);
    expect(splitUrl('https://a.com:8443/x/y?q=1')).toEqual({ host: 'a.com:8443', path: '/x/y?q=1' });
    expect(splitUrl('nonsense')).toEqual({ host: '', path: 'nonsense' });
  });
  it('isHostMsg accepts only host message types', () => {
    expect(isHostMsg({ type: 'cleared' })).toBe(true);
    expect(isHostMsg({ type: 'resume' })).toBe(false);
    expect(isHostMsg('snapshot')).toBe(false);
    expect(isHostMsg(null)).toBe(false);
  });
});
