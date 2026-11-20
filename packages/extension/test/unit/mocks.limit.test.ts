// CONTRACTS §21.16 / REVIEW-15 #1, #7: limited answers and clean problem lines.
import { describe, expect, it } from 'vitest';
import type { Rule } from '@flutter-intercept/proxy';
import { approvalReasons } from '../../src/rules/policy';
import { cleanLine, limitAnswer } from '../../src/mocks/limit';

const mock = (status: number, headers: Record<string, string>, body = '{}'): Rule => ({ id: 'collection:c:1', enabled: true, match: { url: '*' }, action: { kind: 'mock', status, headers, body } });

describe('limitAnswer', () => {
  it('each of the five reasons is taken out; the rest of the answer stays', () => {
    const r = mock(302, {
      location: 'https://attacker.example/collect',
      'set-cookie': 'session=attacker; Domain=victim.example',
      'access-control-allow-origin': 'https://evil.example',
      'content-security-policy': "default-src 'none'",
      'x-forwarded-host': 'evil.example',
      'content-type': 'text/html',
      'x-request-id': 'abc',
    }, '<h1>pwned</h1>');
    expect(approvalReasons(r).length).toBeGreaterThanOrEqual(6);
    const l = limitAnswer(r)!;
    expect(l.reasons).toEqual(['redirects', 'sets cookies', 'changes CORS', 'sets a content security policy', 'sets forwarding headers', 'serves HTML or scripts']);
    const a = l.rule.action as { status: number; headers: Record<string, string>; body: string };
    expect(a.headers).toEqual({ 'content-type': 'text/plain; charset=utf-8', 'x-request-id': 'abc', 'x-flutter-intercept': 'limited; removed=location,set-cookie,access-control-allow-origin,content-security-policy,x-forwarded-host,content-type' });
    expect(a.status).toBe(302);
    expect(a.body).toBe('<h1>pwned</h1>');
    // what's left needs no approval except the bare redirect status (no Location: nothing follows it)
    expect(approvalReasons(l.rule)).toEqual(['answers with a redirect (status 302)']);
  });

  it('an untyped body starting with < is served as text; refresh is a redirect', () => {
    const l = limitAnswer(mock(200, { refresh: '0; url=https://x.example' }, '  <script>x()</script>'))!;
    expect(l.reasons).toEqual(['redirects', 'serves HTML or scripts']);
    expect((l.rule.action as { headers: Record<string, string> }).headers['content-type']).toBe('text/plain; charset=utf-8');
    expect(approvalReasons(l.rule)).toEqual([]);
  });

  it('plain JSON answers, non-mock rules and a forged marker header', () => {
    expect(limitAnswer(mock(200, { 'content-type': 'application/json' }, '{"a":1}'))).toBeUndefined();
    expect(limitAnswer({ id: 'x', enabled: true, match: { url: '*' }, action: { kind: 'block', mode: 'reset' } })).toBeUndefined();
    const l = limitAnswer(mock(200, { 'x-flutter-intercept': 'approved', 'set-cookie': 'a=1' }))!;
    expect((l.rule.action as { headers: Record<string, string> }).headers['x-flutter-intercept']).toBe('limited; removed=set-cookie');
  });

  it('keeps __proto__ as a header name', () => {
    const headers = JSON.parse('{"__proto__":"x","set-cookie":"a=1"}');
    const h = (limitAnswer(mock(200, headers))!.rule.action as { headers: Record<string, string> }).headers;
    expect(Object.keys(h)).toContain('__proto__');
    expect(Object.getPrototypeOf(h)).toBe(Object.prototype);
  });
});

describe('cleanLine', () => {
  it('one line, no bidi controls, no URL credentials, capped', () => {
    expect(cleanLine('a\r\nb\tc‮d⁦e')).toBe('a b cde');
    expect(cleanLine('see https://bot:hunter2@api.example/x and ftp://u@h')).toBe('see https://***@api.example/x and ftp://***@h');
    expect(cleanLine('x'.repeat(400))).toHaveLength(300);
    expect(cleanLine('x'.repeat(400)).endsWith('…')).toBe(true);
  });
});
