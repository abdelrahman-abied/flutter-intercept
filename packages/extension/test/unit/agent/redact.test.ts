import { describe, expect, it } from 'vitest';
import {
  isSensitiveField,
  isSensitiveHeader,
  REDACTED,
  redactBodyText,
  redactHeaders,
  redactJsonLikeText,
  redactJsonText,
  redactQueryString,
  redactUrl,
  isOpaqueToken,
  redactSecretValues,
} from '../../../src/agent/redact';
import { redactExchange, redactJsonValue } from '../../../src/agent/samples';

describe('headers', () => {
  it.each([
    ['Authorization', true],
    ['proxy-authorization', true],
    ['Cookie', true],
    ['Set-Cookie', true],
    ['X-Api-Key', true],
    ['x-api_key', true],
    ['X-Auth-Token', true],
    ['X-Session-Id', true],
    ['x-client-secret', true],
    ['X-Password', true],
    ['Content-Type', false],
    ['Accept', false],
    ['User-Agent', false],
  ])('%s sensitive=%s', (name, s) => expect(isSensitiveHeader(name)).toBe(s));

  it('redacts values, every element of multi-value headers, keeps others', () => {
    expect(
      redactHeaders({ authorization: 'Bearer abc', 'set-cookie': ['a=1', 'b=2'], 'content-type': 'application/json', 'x-trace': 'ok' }),
    ).toEqual({ authorization: REDACTED, 'set-cookie': [REDACTED, REDACTED], 'content-type': 'application/json', 'x-trace': 'ok' });
    expect(redactHeaders(undefined)).toBeUndefined();
  });
});

describe('fields, URLs and query strings', () => {
  it.each(['password', 'pass', 'access_token', 'refreshToken', 'client_secret', 'apiKey', 'api-key', 'sessionId', 'authCode', 'credentials'])(
    '%s is sensitive',
    (f) => expect(isSensitiveField(f)).toBe(true),
  );
  it.each(['id', 'name', 'email', 'page', 'title'])('%s is not', (f) => expect(isSensitiveField(f)).toBe(false));

  it('redacts query params by name, keeps order, raw keys, other params and the fragment', () => {
    expect(redactUrl('https://x/a?page=2&access_token=abc&q=hi%20there&API_KEY=k#frag')).toBe(
      `https://x/a?page=2&access_token=${REDACTED}&q=hi%20there&API_KEY=${REDACTED}#frag`,
    );
    expect(redactUrl('https://x/a')).toBe('https://x/a');
    expect(redactUrl('https://x/a?flag&token')).toBe(`https://x/a?flag&token=${REDACTED}`);
    expect(redactQueryString('user=bob&pass%77ord=x')).toBe(`user=bob&pass%77ord=${REDACTED}`); // encoded key decoded for matching
  });
});

describe('JSON bodies (lossless)', () => {
  it('redacts nested fields at any depth, whole object/array values, keeps everything else byte for byte', () => {
    const src = '{"user":{"id":12345678901234567890,"name":"Ann","password":"hunter2","tokens":[{"v":1}],"session":{"a":1}},"price":1.10,"e":1e400,"list":[{"apiKey":"k","n":-0.0}]}';
    expect(redactJsonText(src)).toBe(
      `{"user":{"id":12345678901234567890,"name":"Ann","password":"${REDACTED}","tokens":"${REDACTED}","session":"${REDACTED}"},"price":1.10,"e":1e400,"list":[{"apiKey":"${REDACTED}","n":-0.0}]}`,
    );
  });

  it('preserves formatting, unicode escapes and big integers', () => {
    const src = '{\n  "id": 9007199254740993,\n  "label": "caf\\u00e9",\n  "secret": 123\n}\n';
    expect(redactJsonText(src)).toBe(`{\n  "id": 9007199254740993,\n  "label": "caf\\u00e9",\n  "secret": "${REDACTED}"\n}\n`);
  });

  it('matches escaped key names after decoding', () => {
    expect(redactJsonText('{"pa\\u0073sword":"x"}')).toBe(`{"pa\\u0073sword":"${REDACTED}"}`);
  });

  it('top-level arrays and scalars', () => {
    expect(redactJsonText('[{"token":"a"},2,"s",true,null]')).toBe(`[{"token":"${REDACTED}"},2,"s",true,null]`);
    expect(redactJsonText('42')).toBe('42');
  });

  it.each(['{"a":1,}', '{"a" 1}', '[1 2]', '{"a":01}', '{"a":"x', "{'a':1}", '{"a":1} x', ''])('rejects invalid JSON %s', (bad) => {
    expect(() => redactJsonText(bad)).toThrow();
  });

  it('invalid JSON falls back to "name": value regex', () => {
    expect(redactJsonLikeText('{"token": "abc", "id": 7, broken')).toBe(`{"token": "${REDACTED}", "id": 7, broken`);
  });
});

describe('redactBodyText', () => {
  it('JSON by content-type or shape; JSON-ish fallback; urlencoded; plain text untouched', () => {
    expect(redactBodyText('{"token":"a"}', { 'content-type': 'application/json' })).toBe(`{"token":"${REDACTED}"}`);
    expect(redactBodyText('  [{"secret":1}]')).toBe(`  [{"secret":"${REDACTED}"}]`);
    expect(redactBodyText('{"password":"x",oops', { 'Content-Type': 'application/problem+json' })).toBe(`{"password":"${REDACTED}",oops`);
    expect(redactBodyText('grant_type=password&password=x&username=a', { 'content-type': 'application/x-www-form-urlencoded; charset=utf-8' })).toBe(
      `grant_type=password&password=${REDACTED}&username=a`,
    );
    expect(redactBodyText('hello world')).toBe('hello world');
    expect(redactBodyText('<html>"token": "x"</html>', { 'content-type': 'text/html' })).toBe(`<html>"token": "${REDACTED}"</html>`);
  });

  it('deeply nested JSON (stack overflow) degrades to the regex fallback instead of throwing', () => {
    const deep = '['.repeat(200_000) + ']'.repeat(200_000);
    expect(() => redactBodyText(deep)).not.toThrow();
  });

  it('is linear enough for multi-MB bodies', () => {
    const big = JSON.stringify({ items: Array.from({ length: 60_000 }, (_, i) => ({ id: i, token: 't' + i, v: 12345.678 })) });
    const t0 = Date.now();
    const out = redactBodyText(big, { 'content-type': 'application/json' });
    expect(Date.now() - t0).toBeLessThan(3000);
    expect(out).not.toContain('"t1"');
    expect(out.length).toBeGreaterThan(1_000_000);
  });
});

describe('REVIEW-4 #9: credential-looking values, whatever the key', () => {
  const JWT = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c';
  // Opaque, provider-neutral token (built at runtime so no scanner mistakes it for a real key): 34 chars, mixed case + digits.
  const OPAQUE = ['Qw7rTy9Ui', 'Op2AsDfGh3', 'JkLzXcVbNm', '51HxRe'].join('');

  it('detects JWTs, Bearer/Basic credentials and long mixed tokens; keeps hashes, UUIDs, ids and prose', () => {
    expect(redactSecretValues(JWT, true)).toBe(REDACTED);
    expect(redactSecretValues(`see ${JWT} here`)).toBe(`see ${REDACTED} here`);
    expect(redactSecretValues('Bearer abcdef0123456789xyz')).toBe(`Bearer ${REDACTED}`);
    expect(redactSecretValues('basic information about our basic plan')).toBe('basic information about our basic plan');
    expect(isOpaqueToken(OPAQUE)).toBe(true);
    for (const keep of ['da39a3ee5e6b4b0d3255bfef95601890afd80709', '123e4567-e89b-12d3-a456-426614174000', '12345678', 'https://example.com/a/very/long/path/with/many/segments']) {
      expect(redactSecretValues(keep, true)).toBe(keep);
    }
  });

  it('in JSON bodies under any key (byte-exact elsewhere), headers, query values, URL paths and text bodies', () => {
    const body = `{"access": "${JWT}", "jwt":{"v":"${OPAQUE}"}, "n": 1.0, "msg": "Bearer abcdef0123456789xyz", "sha": "da39a3ee5e6b4b0d3255bfef95601890afd80709"}`;
    expect(redactJsonText(body)).toBe(`{"access": "${REDACTED}", "jwt":{"v":"${REDACTED}"}, "n": 1.0, "msg": "Bearer ${REDACTED}", "sha": "da39a3ee5e6b4b0d3255bfef95601890afd80709"}`);
    expect(redactHeaders({ 'x-id-jwt': JWT, 'x-forwarded': `Bearer ${OPAQUE}`, etag: '"abc123"' })).toEqual({ 'x-id-jwt': REDACTED, 'x-forwarded': `Bearer ${REDACTED}`, etag: '"abc123"' });
    expect(redactQueryString(`code=${OPAQUE}&page=2`)).toBe(`code=${REDACTED}&page=2`);
    expect(redactUrl(`https://a.example/reset/${JWT}?x=1#f`)).toBe(`https://a.example/reset/${REDACTED}?x=1#f`);
    expect(redactBodyText(`--b\r\nContent-Disposition: form-data; name="id_jwt"\r\n\r\n${JWT}\r\n--b--`, { 'content-type': 'multipart/form-data; boundary=b' })).not.toContain(JWT);
    expect(redactBodyText(`query { me } # Bearer abcdef0123456789xyz`, { 'content-type': 'text/plain' })).toBe(`query { me } # Bearer ${REDACTED}`);
  });

  it('decoded values and fixtures (redactExchange) too', () => {
    expect(redactJsonValue({ refresh: JWT, list: [OPAQUE, 'ok'] })).toEqual({ refresh: REDACTED, list: [REDACTED, 'ok'] });
    const r = redactExchange({ id: 'e', startedAt: 1, method: 'POST', url: 'https://a/login', requestHeaders: {}, state: 'completed', status: 200, responseHeaders: { 'content-type': 'application/json' }, responseBody: { text: `{"access":"${JWT}","bearer":"${OPAQUE}"}`, encoding: 'utf8' } });
    expect(r.responseBody!.text).toBe(`{"access":"${REDACTED}","bearer":"${REDACTED}"}`);
  });
});
