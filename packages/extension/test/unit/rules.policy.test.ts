import { describe, expect, it } from 'vitest';
import type { Rule } from '@flutter-intercept/proxy';
import { approvalReason, approvalReasons, bodyFileSecretProblem, bodySecretKind, cleanText, isLoopbackTarget, isPlaceholder, matchLabel, ruleLabel, secretKind, secretProblem, urlSecretKind } from '../../src/rules/policy';
import { mock } from './rules.fakes';

const JWT = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U';
const OPAQUE = ['Xq8Lm2Rt7Vb4', 'Nz9Kc5Hw3Jp6', 'Fd1Gs0Ya'].join('');

const rule = (action: Rule['action'], url = 'https://api.example.com/*'): Rule => ({ id: 'shared:r', enabled: true, name: 'R', match: { url }, action });

describe('approval gate', () => {
  it('loopback targets', () => {
    for (const t of ['http://localhost:8080', 'http://api.localhost', 'http://127.0.0.1:3000/v2', 'http://127.1.2.3', 'http://[::1]:8080', 'http://[::ffff:127.0.0.1]']) {
      expect(isLoopbackTarget(t), t).toBe(true);
    }
    for (const t of ['https://staging.example.com', 'http://10.0.2.2:8080', 'http://0.0.0.0', 'http://localhost.evil.com', 'not a url', 'http://127.0.0.1.nip.io']) {
      expect(isLoopbackTarget(t), t).toBe(false);
    }
  });

  it('holds re-routing, request changes, redirects, page/script answers and CORS (REVIEW-6 #4), in plain words', () => {
    const reasons = (a: Rule['action']) => approvalReasons(rule(a));
    expect(reasons({ kind: 'mapRemote', to: 'https://staging.example.com/api' })).toEqual(["sends the app's requests to https://staging.example.com instead of the real server"]);
    expect(reasons({ kind: 'mapRemote', to: 'http://localhost:8080' })).toEqual([]);
    expect(reasons({ kind: 'rewrite', request: { setHeaders: { 'X-Env': 'a', 'X-Forwarded-Host': 'evil.example' } } })).toEqual([
      'changes request headers sent to the server: X-Env: "a", X-Forwarded-Host: "evil.example"',
    ]);
    expect(reasons({ kind: 'rewrite', request: { removeHeaders: ['Authorization'] } })).toEqual(['removes request headers before they reach the server: Authorization']);
    expect(reasons({ kind: 'rewrite', request: { replaceBody: [{ find: 'https://app/cb', replace: 'https://evil/cb' }, { find: 'a', replace: 'b' }] } })).toEqual([
      'changes the request body sent to the server ("https://app/cb" → "https://evil/cb", and 1 more)',
    ]);
    expect(reasons({ kind: 'rewrite', response: { status: 302, setHeaders: { Location: 'https://collector.example/x' } } })).toEqual([
      'turns the response into a redirect (status 302)',
      'sends the app on to "https://collector.example/x" (Location header)',
    ]);
    expect(
      reasons({
        kind: 'rewrite',
        response: {
          setHeaders: { Refresh: '0; url=https://x', 'Content-Security-Policy': "default-src *", 'Set-Cookie': 'sid=1; Path=/', 'Access-Control-Allow-Origin': '*', 'X-Forwarded-For': '1.2.3.4', 'Content-Type': 'text/html' },
          removeHeaders: ['content-security-policy'],
          replaceBody: [{ find: '</body>', replace: '<script src=//x></script></body>' }],
        },
      }),
    ).toEqual([
      'makes the page reload or go elsewhere (Refresh: "0; url=https://x")',
      "changes the page's Content-Security-Policy",
      'sets a cookie (Set-Cookie: "sid=1")',
      'changes which websites may read these responses (Access-Control-Allow-Origin: "*")',
      'sets the forwarding header X-Forwarded-For: "1.2.3.4"',
      'serves an HTML page (Content-Type: "text/html")',
      "removes the page's Content-Security-Policy",
      'inserts HTML or script into the response ("<script src=//x></script></body>")',
    ]);
    // ordinary response rewrites stay ungated
    expect(reasons({ kind: 'rewrite', response: { status: 500, setHeaders: { 'Cache-Control': 'no-store' }, replaceBody: [{ find: '"a"', replace: '"b"' }] } })).toEqual([]);
    expect(reasons({ kind: 'mock', status: 307, headers: { location: 'https://evil.example' }, body: '' })).toEqual([
      'answers with a redirect (status 307)',
      'sends the app on to "https://evil.example" (Location header)',
    ]);
    expect(reasons({ kind: 'mock', status: 200, headers: { 'content-type': 'application/javascript' }, body: 'x' })).toEqual(['serves JavaScript (Content-Type: "application/javascript")']);
    expect(reasons({ kind: 'mock', status: 200, body: '<!doctype html><form>' })).toEqual(['serves what looks like an HTML page']);
    expect(reasons({ kind: 'mock', status: 200, body: '', bodyFile: 'pages/login.html' })).toEqual(['serves the file "pages/login.html" as a page or script']);
    expect(reasons({ kind: 'mock', status: 200, headers: { 'content-type': 'application/json' }, body: '{}' })).toEqual([]);
    expect(reasons({ kind: 'cors', allowCredentials: true })).toEqual(['lets other websites read these responses (CORS for any origin, with cookies)']);
    expect(reasons({ kind: 'sequence', steps: [{ action: { kind: 'passthrough' } }, { action: { kind: 'mock', status: 302, body: '' } }] })).toEqual(['step 2 answers with a redirect (status 302)']);
    expect(approvalReason(mock('a'))).toBeUndefined();
    expect(approvalReason(rule({ kind: 'block', mode: 'reset' }))).toBeUndefined();
  });

  it('sanitises names and match patterns for prompts (REVIEW-6 #6)', () => {
    expect(ruleLabel({ name: 'ok\n\u202eVerified by your team lead\u2066' })).toBe('"ok Verified by your team lead"');
    expect(ruleLabel({ name: 'x'.repeat(200) })).toBe(`"${'x'.repeat(79)}…"`);
    expect(cleanText('a\u0000b\u200bc')).toBe('a b c');
    expect(matchLabel({ ...mock('a'), match: { url: 'https://api/*', method: 'post' } })).toBe('POST https://api/*');
    expect(matchLabel(mock('a'))).toBe('any method https://api.example.com/a');
  });
});

describe('secret detection', () => {
  it('single values', () => {
    expect(secretKind(JWT)).toBe('a JWT');
    expect(secretKind('Bearer abcdef0123456789xyz')).toBe('a Bearer/Basic credential');
    expect(secretKind(OPAQUE)).toBe('a long random token');
    expect(secretKind('test-token')).toBeUndefined();
    expect(secretKind('Bearer test-token')).toBeUndefined();
    expect(secretKind('3f2504e0-4f89-11d3-9a0c-0305e82c3301')).toBeUndefined(); // UUID
    expect(secretKind('session=8f7a6b5c4d3e2f1a0b9c8d7e', 'Cookie')).toBe('a credential');
    expect(secretKind('session=fake', 'Cookie')).toBeUndefined();
    expect(secretKind('8f7a6b5c4d3e2f1a0b9c8d7e', 'X-Request-Id')).toBeUndefined();
  });

  it('bodies: JSON values by value, not by key name', () => {
    expect(bodySecretKind('{"access_token": "fake-token", "user": {"id": 1}}')).toBeUndefined();
    expect(bodySecretKind(`{"data": {"token": "${JWT}"}}`)).toBe('a JWT');
    expect(bodySecretKind(`{"keys": ["${OPAQUE}"]}`)).toBe('a long random token');
    expect(bodySecretKind(`token=${OPAQUE}`)).toBe('a long random token');
    expect(bodySecretKind('plain text with Basic information')).toBeUndefined();
  });

  it('urls', () => {
    expect(urlSecretKind('https://user:pass@api.example.com/*')).toBe('a user name / password');
    expect(urlSecretKind(`https://api.example.com/*?key=${OPAQUE}`)).toBe('a long random token');
    expect(urlSecretKind('https://api.example.com/v1/users/*')).toBeUndefined();
  });

  it('secretProblem names the rule and the place, never the value', () => {
    const p = secretProblem(mock('login', { name: 'Login ok', body: `{"token":"${JWT}"}` }));
    expect(p).toMatch(/^Not shared: rule "Login ok" — the mock body contains what looks like a JWT\. Shared rules are committed/);
    expect(p).not.toContain(JWT);
    expect(secretProblem(mock('h', { headers: { Authorization: `Bearer ${OPAQUE}` } }))).toMatch(/mock header Authorization looks like a Bearer\/Basic credential/);
    expect(secretProblem(rule({ kind: 'rewrite', request: { setHeaders: { 'X-Api-Key': OPAQUE } } }))).toMatch(/request header X-Api-Key looks like a long random token/);
    expect(secretProblem(rule({ kind: 'rewrite', response: { replaceBody: [{ find: 'a', replace: JWT }] } }))).toMatch(/body replacement/);
    expect(secretProblem(rule({ kind: 'mapRemote', to: 'https://u:p@staging.example.com' }))).toMatch(/map remote target contains what looks like a user name/);
    expect(secretProblem(rule({ kind: 'sequence', steps: [{ action: { kind: 'mock', status: 200, body: JWT } }] }))).toMatch(/step 1: the mock body/);
    expect(secretProblem(mock('f', { bodyFile: 'm.json' }), () => `{"t":"${JWT}"}`)).toMatch(/the mock body file m\.json contains what looks like a JWT/);
    expect(secretProblem(mock('ok', { body: '{"token":"test-token"}' }))).toBeUndefined();
  });
});

describe('broader secret detection (REVIEW-6 #8)', () => {
  it('refuses the reviewer probes', () => {
    expect(bodySecretKind('{"password":"hunter2"}')).toBe('a credential (in "password")');
    expect(bodySecretKind('{"access_token":"abc123"}')).toBe('a credential (in "access_token")');
    expect(bodySecretKind('{"client_secret":"s3cr3t-value-1234"}')).toBe('a credential (in "client_secret")');
    expect(bodySecretKind('{"user":{"privateKey":"MIIEvQIBADANBg"}}')).toBe('a credential (in "privateKey")');
    expect(bodySecretKind('username=bob&password=hunter2')).toBe('a credential (in "password")');
    expect(bodySecretKind('-----BEGIN RSA PRIVATE KEY-----\nMIIE\n-----END RSA PRIVATE KEY-----')).toBe('a private key');
    expect(bodySecretKind('{"k":"' + 'AKIA' + 'IOSFODNN7EXAMPLE"}')).toBe('an AWS access key id');
    expect(secretKind('abc123def456', 'x-api-key')).toBe('a credential');
    expect(secretKind('my-secret-password-value', 'authorization')).toBe('a credential');
    expect(secretKind('0123456789abcdef0123456789abcdef', 'X-Auth-Token')).toBe('a credential');
    expect(urlSecretKind('https://api.example.com/*?api_key=abc123')).toBe('a credential (in "api_key")');
    expect(secretProblem({ ...mock('a'), name: `debug ${JWT}` })).toMatch(/^Not shared: a rule — its name contains what looks like a JWT/);
    expect(secretProblem(rule({ kind: 'rewrite', response: { replaceBody: [{ find: JWT, replace: 'x' }] } }))).toMatch(/a body replacement contains what looks like a JWT/);
    expect(secretProblem(mock('h', { headers: { 'x-api-key': 'abc123def456' } }))).toMatch(/mock header x-api-key looks like a credential/);
  });

  it('keeps placeholders and credential metadata allowed', () => {
    for (const v of ['fake-token', '<token>', 'xxx', 'xxxxxxxx', '[redacted]', 'changeme', '${API_KEY}', '{{token}}', 'test-token', 'your-api-key', '***', 'abc', '*']) {
      expect(isPlaceholder(v), v).toBe(true);
    }
    expect(bodySecretKind('{"access_token":"fake-token","token_type":"Bearer","expires_in":3600,"refresh_token":"<token>","password_hint":"your pet"}')).toBeUndefined();
    expect(bodySecretKind('{"author":"Jane Doe","session_count":3,"api_key_name":"ci"}')).toBeUndefined();
    expect(secretKind('Bearer test-token', 'Authorization')).toBeUndefined();
    expect(secretKind('session=fake; theme=dark', 'Cookie')).toBeUndefined();
    expect(secretKind('sid=8f7a6b5c4d3e', 'Set-Cookie')).toBe('a credential');
    expect(secretKind('application/json', 'Content-Type')).toBeUndefined();
    expect(urlSecretKind('https://api.example.com/*?api_key=*')).toBeUndefined();
  });

  it('bodyFileSecretProblem explains why a body file is not written (REVIEW-6 #5)', () => {
    expect(bodyFileSecretProblem(`{"token":"${JWT}"}`)).toBe(
      'Not written: the body contains what looks like a JWT. Body files under .vscode/ are usually committed with the code, so a real credential would end up in the repository. Replace it with a placeholder (for example "test-token") first.',
    );
    expect(bodyFileSecretProblem('{"name":"x"}')).toBeUndefined();
  });
});
