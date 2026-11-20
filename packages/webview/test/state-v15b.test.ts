// W2 helpers (CONTRACTS §21.15, §21.16, §21.17).
import { describe, expect, it } from 'vitest';
import { exchangeForSeen, limitedRemoved, limitedText, overridesText, seenSummaryText } from '../src/collections';

describe('limitedText', () => {
  it('plain words, at most five reasons, nothing when no answer is limited', () => {
    expect(limitedText({ reasons: ['sets cookies', 'redirects'], answers: 3 })).toBe('Some answers are limited until you approve: sets cookies, redirects');
    expect(limitedText({ reasons: [], answers: 1 })).toBe('Some answers are limited until you approve');
    expect(limitedText({ reasons: ['a', 'b', 'c', 'd', 'e', 'f'], answers: 6 })).toBe('Some answers are limited until you approve: a, b, c, d, e');
    expect(limitedText({ reasons: ['x'], answers: 0 })).toBeUndefined();
    expect(limitedText(undefined)).toBeUndefined();
  });
});

describe('overridesText / seenSummaryText', () => {
  it('singular and plural, nothing for zero', () => {
    expect(overridesText(1)).toBe('1 change for you');
    expect(overridesText(3)).toBe('3 changes for you');
    expect(overridesText(0)).toBeUndefined();
    expect(seenSummaryText({ notInCollection: [{ method: 'GET', path: '/a', count: 9 }], noExample: [] })).toBe('1 request not in the collection');
    expect(seenSummaryText({ notInCollection: [], noExample: [{ endpoint: 'k', count: 1 }, { endpoint: 'j', count: 1 }] })).toBe('2 answered 501 (no example)');
    expect(seenSummaryText({ notInCollection: [], noExample: [] })).toBeUndefined();
  });
});

describe('exchangeForSeen', () => {
  const exs = [
    { id: 'old', method: 'GET', url: 'https://api.test/users/1' },
    { id: 'post', method: 'POST', url: 'https://api.test/users/2' },
    { id: 'other', method: 'GET', url: 'https://evil.test/users/3' },
    { id: 'new', method: 'get', url: 'https://api.test/users/4?x=1' },
    { id: 'deep', method: 'GET', url: 'https://api.test/users/4/posts' },
    { id: 'bad', method: 'GET', url: 'not a url' },
  ];
  it('newest exchange with the same method, an origin of the collection and a fitting path', () => {
    expect(exchangeForSeen(exs, ['https://api.test'], 'GET', '/users/{id}')?.id).toBe('new');
    expect(exchangeForSeen(exs, ['https://api.test'], 'POST', '/users/{id}')?.id).toBe('post');
    expect(exchangeForSeen(exs, ['https://api.test'], 'GET', '/users/{id}/posts')?.id).toBe('deep');
    expect(exchangeForSeen(exs, ['https://api.test'], 'DELETE', '/users/{id}')).toBeUndefined();
    expect(exchangeForSeen(exs, ['https://nowhere.test'], 'GET', '/users/{id}')).toBeUndefined();
  });
  it('a {…} segment never matches an empty segment', () => {
    expect(exchangeForSeen([{ id: 'e', method: 'GET', url: 'https://api.test/users/' }], ['https://api.test'], 'GET', '/users/{id}')).toBeUndefined();
  });
});

describe('limitedRemoved', () => {
  it('reads the limited marker, ignores others', () => {
    expect(limitedRemoved({ responseHeaders: { 'x-flutter-intercept': 'limited; removed=set-cookie,location' } })).toEqual(['set-cookie', 'location']);
    expect(limitedRemoved({ responseHeaders: { 'X-Flutter-Intercept': 'limited; removed=none' } })).toEqual([]);
    expect(limitedRemoved({ responseHeaders: { 'x-flutter-intercept': 'no-example' } })).toBeUndefined();
    expect(limitedRemoved({ responseHeaders: {} })).toBeUndefined();
  });
});
