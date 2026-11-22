// PERF-5 #1: the name checks keep their answers (names repeat across answers), bounded, without changing any answer.
import { describe, expect, it } from 'vitest';
import { isSecretHeaderName, isSecretName, memoName } from '../../src/mocks/secrets';

describe('memoName', () => {
  it('checks a name once, however often it is asked', () => {
    const seen: string[] = [];
    const check = memoName((n) => (seen.push(n), n.startsWith('s')));
    for (let i = 0; i < 5; i++) {
      expect(check('secret')).toBe(true);
      expect(check('name')).toBe(false);
    }
    expect(seen).toEqual(['secret', 'name']);
  });

  it('is bounded: names over 200 characters are never kept, and the map starts over at 4 096 names', () => {
    let calls = 0;
    const check = memoName(() => (calls++, false));
    const long = 'a'.repeat(201);
    check(long);
    check(long);
    expect(calls).toBe(2);

    calls = 0;
    check('first');
    for (let i = 0; i < 4096; i++) check(`n${i}`);
    expect(calls).toBe(4097);
    check('first'); // dropped when the map started over
    expect(calls).toBe(4098);
  });

  it('non-strings go to the check as before', () => {
    expect(isSecretName(undefined as unknown as string)).toBe(false);
    expect(isSecretName(42 as unknown as string)).toBe(false);
  });
});

describe('isSecretName keeps its answers', () => {
  const secret = ['password', 'newPassword', 'apiKeys', 'access_token', 'x-api-key', 'session', 'otpCode', 'clientSecret', 'passwordHash', 'pin2'];
  const plain = ['author', 'sessionCount', 'tokenizer', 'pinned', 'passenger', 'secretary', 'countryCode', 'name', '', 'a'.repeat(300)];

  it('the same on the first and every later call', () => {
    for (let round = 0; round < 3; round++) {
      for (const n of secret) expect(isSecretName(n), n).toBe(true);
      for (const n of plain) expect(isSecretName(n), n).toBe(false);
      expect(isSecretHeaderName('Authorization')).toBe(true);
      expect(isSecretHeaderName('Accept')).toBe(false);
    }
  });
});
