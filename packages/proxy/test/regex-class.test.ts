// REVIEW-16 #1: the regex freeze guard reads character classes the way JavaScript does.
import { describe, expect, it } from 'vitest';
import { compileRules, findRule, isInvalidMatcher, isSafeRegexSource, scanClass } from '../src/rules';
import { bestOfMs, budget } from './timing';

/** Class-heavy sources: empty / any classes, a leading `]`, escapes inside classes, ranges, `-` at the edges. */
const CORPUS = [
  '[]',
  '[^]',
  '[]a]',
  '[^]a]',
  '[]?(b)]',
  '[^](b)]',
  'x[]]y',
  '[\\]]',
  '[\\]a]b',
  '[a\\]]',
  '[\\\\]]',
  '[a-c]',
  '[^a-c]x',
  '[-a]',
  '[a-]',
  '[a\\-c]',
  '[\\d-z]',
  '[a-\\d]',
  '[\\x41-\\x43]]',
  '[\\u0041-C]]',
  '[\\b]',
  '[\\c]]',
  '[\\cA]]',
  '[\\c1]]',
  '[\\0]]',
  '[\\101]]',
  '[[]]',
  '[[a]b]',
  '[^[]]',
  '[(]a)',
  '[|]b',
  '[.]*c',
  '[{]2}',
  '[*+?]+',
  '(?:[]|a)b',
  '([^]])',
  '[a][b][]c',
  '[\\s\\S]a',
  '[\\w-]+',
  '[\\u{41}]]',
  '[\\p{L}]]',
  '\\[a]',
  '\\[]a]',
  'a\\u{2}',
  '\\u{(a)}',
  '[a-z][^/]]',
];

/** One flag set per reading of a class: Annex B, `u`, `v` (nested classes). */
const FLAG_SETS = ['', 'u', 'v'];

function compiles(src: string, flags: string): RegExp | undefined {
  try {
    return new RegExp(src, flags);
  } catch {
    return undefined;
  }
}

/** The class spans the guard's scanner finds at the top level of `src`: [start, end) pairs, or undefined. */
function classSpans(src: string, flags: string): [number, number][] | undefined {
  const spans: [number, number][] = [];
  const unicode = /[uv]/.test(flags);
  for (let i = 0; i < src.length; ) {
    if (src[i] === '\\') {
      // `\u{…}` / `\p{…}` are one escape with `u` / `v`; otherwise every escape is `\` + one character here
      if (unicode && 'upP'.includes(src[i + 1]) && src[i + 2] === '{') i = src.indexOf('}', i) + 1 || src.length;
      else i += 2;
      continue;
    }
    if (src[i] === '[') {
      const c = scanClass(src, i, flags);
      if (!c) return undefined;
      spans.push([i, c.end]);
      i = c.end;
      continue;
    }
    i++;
  }
  return spans;
}

/** Probe characters: printable ASCII, a few controls and some characters outside ASCII / Latin-1. */
const PROBE = [...Array.from({ length: 95 }, (_, k) => String.fromCharCode(32 + k)), '\n', '\t', '\b', '\x01', 'é', 'Ā', '\u2028'];

/** The probe characters a class (as the scanner cut it out) matches on its own, or undefined when it isn't one class. */
function classMembers(cls: string, flags: string): string[] | undefined {
  const re = compiles(`^(?:${cls})$`, flags);
  if (!re) return undefined;
  // a class matches exactly one character: no string of two probe characters may match
  for (const a of ['a', ']', '[', 'b', '-', '\\']) for (const b of ['a', ']', '[', 'b', ')', '\\']) if (re.test(a + b)) return undefined;
  return PROBE.filter((ch) => re.test(ch));
}

const escapeChar = (ch: string, unicode: boolean) =>
  unicode ? `\\u{${ch.codePointAt(0)!.toString(16)}}` : `\\u${ch.charCodeAt(0).toString(16).padStart(4, '0')}`;

/** Every string over `alphabet` of length ≤ `max`. */
function* strings(alphabet: string[], max: number): Generator<string> {
  let level = [''];
  yield '';
  for (let n = 1; n <= max; n++) {
    const next: string[] = [];
    for (const s of level) for (const c of alphabet) next.push(s + c);
    yield* next;
    level = next;
  }
}

describe('REVIEW-16 #1: classes are read as JavaScript reads them', () => {
  it("the reviewer's inputs are refused (never match, reported invalid) and run in no time", () => {
    for (const src of ['[]?(a+)+]', '[^](a+)+]', '\\u{(a+)+}', '[]?(\\w+)+]', '[^](\\w+)+]', 'x\\u{(\\w+)+$}', '^https:\\/\\/api\\.example\\.com\\/[]?(\\w+)+]']) {
      expect(isSafeRegexSource(src), src).toBe(false);
      expect(isInvalidMatcher({ url: `/${src}/` }), src).toBe(true);
    }
    const rules = compileRules([
      { id: 'x', enabled: true, match: { url: '/^https:\\/\\/api\\.example\\.com\\/[]?(\\w+)+]/' }, action: { kind: 'block', mode: 'reset' } },
      { id: 'y', enabled: true, match: { url: '/[^](\\w+)+]/' }, action: { kind: 'block', mode: 'reset' } },
    ]);
    const url = `https://api.example.com/${'x'.repeat(30)}`;
    expect(findRule(rules, 'GET', url)).toBeUndefined();
    expect(bestOfMs(() => findRule(rules, 'GET', url))).toBeLessThan(budget(5)); // was 3.3 s at 25 characters
  });

  it('`[^]` and `[\\s\\S]` are wide atoms; `[]` is an empty class; a leading `]` closes the class', () => {
    expect(isSafeRegexSource('[^]*a[^]*b')).toBe(false); // two unbounded quantifiers on "any character"
    expect(isSafeRegexSource('[\\s\\S]*a[\\s\\S]*b')).toBe(false);
    expect(isSafeRegexSource('[\\x00-\\uffff]*a.*b')).toBe(false);
    expect(isSafeRegexSource('\\p{L}*a.*b', 'u')).toBe(false);
    expect(isSafeRegexSource('[^]*a\\d+b')).toBe(true); // one wide, one narrow: as `.*a\d+b`
    expect(isSafeRegexSource('[]]')).toBe(true);
    expect(isSafeRegexSource('[a-z]+\\/[^/]+$')).toBe(true);
    expect(isSafeRegexSource('\\u{3}')).toBe(true); // `uuu` without the u flag
    expect(isSafeRegexSource('\\u{1F600}', 'u')).toBe(true);
    expect(isSafeRegexSource('[[a]](b+)+', 'v')).toBe(false);
    expect(isSafeRegexSource('[[a]--[b]]+x', 'v')).toBe(true);
    expect(scanClass('[]?(a+)+]', 0, '')).toEqual({ end: 2, wide: false });
    expect(scanClass('[^](a+)+]', 0, '')).toEqual({ end: 3, wide: true });
    expect(scanClass('[\\]]x', 0, '')).toEqual({ end: 4, wide: false });
    expect(scanClass('[[a]b]', 0, '')?.end).toBe(4);
    expect(scanClass('[[a]b]', 0, 'v')?.end).toBe(6);
    expect(scanClass('[ab', 0, '')).toBeUndefined();
  });

  it('differential: where the scanner ends each class is where new RegExp ends it (probed one character at a time)', () => {
    let checked = 0;
    for (const flags of FLAG_SETS) {
      const unicode = flags !== '';
      for (const src of CORPUS) {
        const original = compiles(src, flags);
        if (!original) continue; // not a regex under these flags
        const spans = classSpans(src, flags);
        expect(spans, `${src} /${flags}`).toBeDefined();
        // Each span must be one whole class on its own: replace it by an alternation of the probe characters it
        // matches. Had the scanner cut a class too short or too long, the rebuilt regex would read differently.
        let rebuilt = '';
        let at = 0;
        for (const [s, e] of spans!) {
          const members = classMembers(src.slice(s, e), flags);
          expect(members, `${src} /${flags}: ${src.slice(s, e)} is not one class`).toBeDefined();
          rebuilt += src.slice(at, s) + (members!.length ? `(?:${members!.map((ch) => escapeChar(ch, unicode)).join('|')})` : '(?!)');
          at = e;
        }
        rebuilt += src.slice(at);
        const copy = compiles(rebuilt, flags);
        expect(copy, `${src} /${flags} → ${rebuilt}`).toBeDefined();
        const alphabet = [...new Set([...src.replace(/\\/g, ''), 'a', 'b', 'Z', '0', ' ', 'é', 'Ā', '\n'])].slice(0, 16);
        for (const s of strings(alphabet, 3)) {
          checked++;
          if (original.test(s) !== copy!.test(s)) {
            expect.fail(`${src} /${flags} and ${rebuilt} disagree on ${JSON.stringify(s)}`);
          }
        }
      }
    }
    expect(checked).toBeGreaterThan(50_000);
  });

  it('differential: the safety verdict follows the class reading (a hidden nested quantifier is always found)', () => {
    // Every corpus class followed by a nested quantifier: whatever the class swallows in a PCRE reading, JavaScript
    // sees the group, so the guard must refuse it.
    for (const flags of FLAG_SETS) {
      for (const cls of CORPUS.filter((c) => c.startsWith('['))) {
        const src = `${cls}(a+)+]`;
        if (!compiles(src, flags)) continue;
        expect(isSafeRegexSource(src, flags), `${src} /${flags}`).toBe(false);
      }
    }
  });
});
