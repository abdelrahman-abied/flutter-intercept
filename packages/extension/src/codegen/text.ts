/**
 * Invisible and direction-changing characters in generated code (docs/REVIEW-4.md #10). Pure.
 * Response-derived text (JSON keys, URLs, error messages) can carry bidi controls (U+202A–202E, U+2066–2069,
 * U+200E/F, U+061C), other format characters (Cf: zero-width spaces, U+FEFF …), control characters (Cc) and
 * the Unicode line/paragraph separators. In Dart string literals they become `\u{…}` escapes (see
 * `dartString` in snippets.ts), in comments a visible `<U+202E>` placeholder, in JSON text `\u202e` escapes.
 */

/** Every character that must never appear literally in generated source. */
export const INVISIBLE = /[\p{Cc}\p{Cf}\u2028\u2029]/gu;

/** INVISIBLE without the whitespace JSON layout uses. */
const INVISIBLE_IN_JSON = /(?![\t\n\r])[\p{Cc}\p{Cf}\u2028\u2029]/gu;

const hex = (ch: string, width: number) => ch.codePointAt(0)!.toString(16).toUpperCase().padStart(width, '0');

/** Text safe to put in a `//` comment: one line, invisible characters shown as `<U+XXXX>`. */
export function commentText(s: string): string {
  return s.replace(/[\r\n]+/g, ' ').replace(INVISIBLE, (ch) => `<U+${hex(ch, 4)}>`);
}

/**
 * Valid JSON text with invisible characters written as `\uXXXX` escapes (same value when decoded). In valid
 * JSON they can only occur inside strings, where an escape is equivalent; astral ones become surrogate pairs.
 */
export function jsonSafe(text: string): string {
  // Tab / LF / CR can't be inside a valid JSON string: outside one they are the layout, so they stay.
  return text.replace(INVISIBLE_IN_JSON, (ch) =>
    [...Array(ch.length).keys()].map((i) => `\\u${ch.charCodeAt(i).toString(16).padStart(4, '0')}`).join(''),
  );
}
