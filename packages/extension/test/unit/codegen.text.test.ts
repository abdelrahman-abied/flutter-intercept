import type { Exchange } from '@flutter-intercept/proxy';
import { describe, expect, it } from 'vitest';
import { generateFixtureTest } from '../../src/codegen/fixtures';
import { parseJsonSample } from '../../src/codegen/json';
import { generateModels } from '../../src/codegen/models';
import { dartBodyLiteral, dartString } from '../../src/codegen/snippets';
import { commentText, jsonSafe } from '../../src/codegen/text';

// Bidi controls, zero-width / format characters, C1 control, separators, BOM, an astral tag character.
const RLO = '\u202E';
const NASTY = `a${RLO}b\u2066\u2069\u200E\u200F\u061C\u200B\u00AD\u0085\u2028\u2029\uFEFF\u{E0041}z`;
/** No character that REVIEW-4 #10 forbids in generated source (tab and LF are fine). */
const clean = (s: string) => !/(?![\t\n])[\p{Cc}\p{Cf}\u2028\u2029]/u.test(s);

describe('invisible / bidi characters (REVIEW-4 #10)', () => {
  it('dartString escapes them as \\u{…}', () => {
    expect(dartString(NASTY)).toBe(
      "'a\\u{202e}b\\u{2066}\\u{2069}\\u{200e}\\u{200f}\\u{61c}\\u{200b}\\u{ad}\\u{85}\\u{2028}\\u{2029}\\u{feff}\\u{e0041}z'",
    );
    expect(dartString('ü € 😀 \t\n')).toBe("'ü € 😀 \\t\\n'");
  });

  it('dartBodyLiteral never uses a raw string for them', () => {
    expect(dartBodyLiteral(`{"k":"${RLO}"}`)).toBe('\'{"k":"\\u{202e}"}\'');
    expect(dartBodyLiteral('{"k":\n"v"}')).toBe('r\'\'\'{"k":\n"v"}\'\'\'');
  });

  it('commentText shows them as placeholders on one line', () => {
    expect(commentText(`x${RLO}y\r\nz\u{E0041}`)).toBe('x<U+202E>y z<U+E0041>');
  });

  it('jsonSafe escapes them inside JSON strings, keeps layout and value', () => {
    const text = `{\n\t"k${RLO}": "v\u2028\u{E0041}"\r\n}`;
    const safe = jsonSafe(text);
    expect(safe).toBe('{\n\t"k\\u202e": "v\\u2028\\udb40\\udc41"\r\n}');
    expect(JSON.parse(safe)).toEqual(JSON.parse(text));
  });

  it('generated models escape keys and sanitise the source comment', () => {
    for (const style of ['freezed', 'json_serializable', 'plain'] as const) {
      const [f] = generateModels({ samples: [parseJsonSample(`{"na${RLO}me":1}`)], rootName: 'U', style, source: `GET /u${RLO}x` });
      expect(clean(f.content), style).toBe(true);
      expect(f.content).toContain("'na\\u{202e}me'");
      expect(f.content).toContain('// of GET /u<U+202E>x.');
      expect(f.content).toMatch(/\bnaMe\b/); // the identifier only keeps letters and digits
    }
  });

  it('fixture files and tests carry none of them', () => {
    const ex = (url: string, status: number | undefined, body?: string, error?: string): Exchange => ({
      id: '1',
      startedAt: 0,
      method: 'GET',
      url,
      requestHeaders: {},
      status,
      responseBody: body === undefined ? undefined : { text: body, encoding: 'utf8' },
      state: status === undefined ? 'error' : 'completed',
      error,
    });
    for (const style of ['http_mock_adapter', 'mock_client', 'mocktail'] as const) {
      const files = generateFixtureTest({
        exchanges: [
          ex(`https://a.dev/x?q=${RLO}`, 200, `{"k${RLO}":"v${NASTY}"}`),
          ex('https://a.dev/t', 200, `plain ${RLO} text`),
          ex('https://a.dev/e', undefined, undefined, `boom${RLO}`),
        ],
        style,
        name: 'n',
      });
      for (const f of files) expect(clean(f.content), `${style} ${f.path}`).toBe(true);
      expect(JSON.parse(files[0].content)).toEqual(JSON.parse(`{"k${RLO}":"v${NASTY}"}`));
      expect(JSON.parse(files[1].content)).toBe(`plain ${RLO} text`);
      expect(files[2].content).toContain('(error: boom<U+202E>)');
    }
  });
});
