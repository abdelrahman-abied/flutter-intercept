/**
 * Dart identifier helpers for codegen (CONTRACTS §10.4). Pure.
 * JSON keys become lowerCamelCase fields, nested objects UpperCamelCase classes (list items singularised:
 * `items` → `Item`, `categories` → `Category`, `addresses` → `Address`), files snake_case.
 */

/** Dart reserved words, built-in identifiers and async keywords: never usable as a field or class name. */
const DART_KEYWORDS = new Set(
  (
    'abstract as assert await break case catch class const continue covariant default deferred do dynamic ' +
    'else enum export extends extension external factory false final finally for Function get if implements ' +
    'import in interface is late library mixin new null operator part required rethrow return set ' +
    'static super switch this throw true try typedef var void while with yield base sealed when'
  ).split(' '),
);

/**
 * Field names that compile but break or shadow something in the generated code: Object members, the
 * methods every model has, and the primitive type names used in field declarations.
 */
const FIELD_AVOID = new Set([
  'hashCode',
  'runtimeType',
  'toString',
  'noSuchMethod',
  'copyWith',
  'toJson',
  'fromJson',
  'map',
  'int',
  'double',
  'num',
  'bool',
  'json',
]);

/** Class names that would shadow dart:core types or the annotations the models use. */
export const CLASS_AVOID = new Set(
  (
    'Object String int double num bool List Map Set Iterable Iterator Function Future Stream Type Null Never Record ' +
    'Symbol Enum Error Exception DateTime Duration Uri RegExp Pattern Match Comparable Sink BigInt Invocation ' +
    'StackTrace StringBuffer Runes Expando WeakReference Finalizer MapEntry JsonKey JsonSerializable JsonValue ' +
    'JsonEnum JsonConverter Freezed Default Assert Implements With Mock Fake'
  ).split(' '),
);

/** Splits a JSON key into words: separators, camelCase humps, acronyms (`avatarURL` → avatar, URL). */
export function words(key: string): string[] {
  return key
    .replace(/([a-z\d])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean);
}

const cap = (w: string) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase();

/** UpperCamelCase from a key, '' when it has no letters or digits. */
export function pascalCase(key: string): string {
  return words(key).map(cap).join('');
}

/** lowerCamelCase from a key, '' when it has no letters or digits. */
export function camelCase(key: string): string {
  const p = pascalCase(key);
  return p.charAt(0).toLowerCase() + p.slice(1);
}

/** `UserProfile` → `user_profile` (file names). */
export function snakeCase(name: string): string {
  return words(name)
    .map((w) => w.toLowerCase())
    .join('_');
}

/** A safe Dart field name for a JSON key (not yet de-duplicated against its siblings). */
export function fieldName(key: string): string {
  let name = camelCase(key);
  if (!name) return 'field';
  if (/^\d/.test(name)) name = 'field' + name;
  if (DART_KEYWORDS.has(name) || FIELD_AVOID.has(name)) name += 'Value';
  return name;
}

/** A Dart class name for a key ('' when the key has no usable characters). */
export function className(key: string): string {
  let name = pascalCase(key);
  if (/^\d/.test(name)) name = 'Item' + name;
  return name;
}

/** True if `name` can't be used as a generated class name on its own. */
export function isAvoidedClassName(name: string): boolean {
  return CLASS_AVOID.has(name) || DART_KEYWORDS.has(name) || DART_KEYWORDS.has(name.toLowerCase());
}

const IRREGULAR: Record<string, string> = {
  people: 'person',
  children: 'child',
  men: 'man',
  women: 'woman',
  feet: 'foot',
  teeth: 'tooth',
  mice: 'mouse',
  geese: 'goose',
  indices: 'index',
  matrices: 'matrix',
  vertices: 'vertex',
  criteria: 'criterion',
  analyses: 'analysis',
  caches: 'cache',
  quizzes: 'quiz',
  leaves: 'leaf',
  lives: 'life',
  wives: 'wife',
  knives: 'knife',
  shelves: 'shelf',
  halves: 'half',
};
/** Words whose singular is the word itself: a list of them gets `…Item`. */
const UNCOUNTABLE = new Set([
  'data',
  'info',
  'information',
  'metadata',
  'media',
  'news',
  'series',
  'species',
  'feedback',
  'equipment',
  'content',
  'status',
  'list',
  'payload',
  'stuff',
  'history',
]);
/** `-ies` words that are `-ie` in the singular. */
const IE_WORDS = new Set(['movies', 'cookies', 'calories', 'zombies', 'selfies', 'rookies', 'smoothies', 'pies', 'ties', 'lies', 'dies', 'brownies', 'hoodies', 'goalies', 'species']);

/** Singular of one lower-case English word, or `undefined` when it has none of its own (data, news …). */
export function singularWord(w: string): string | undefined {
  const lower = w.toLowerCase();
  if (UNCOUNTABLE.has(lower)) return undefined;
  if (IRREGULAR[lower]) return IRREGULAR[lower];
  if (lower.length <= 2) return undefined;
  if (IE_WORDS.has(lower)) return w.slice(0, -1);
  if (/[^aeiou]ies$/.test(lower)) return w.slice(0, -3) + 'y';
  if (/(ss|x|ch|sh)es$/.test(lower)) return w.slice(0, -2); // addresses, boxes, matches, dishes
  if (/(t|n|r|b)uses$/.test(lower)) return w.slice(0, -2); // statuses, bonuses, viruses, buses
  if (/(ss|us|is)$/.test(lower)) return undefined; // address, status, analysis: already singular
  if (lower.endsWith('s')) return w.slice(0, -1);
  return undefined;
}

/**
 * Class name for the items of a list under `key`: the last word singularised (`order_items` → `OrderItem`,
 * `categories` → `Category`); words without a singular get `Item` (`data` → `DataItem`).
 */
export function itemClassName(key: string): string {
  const ws = words(key);
  if (!ws.length) return '';
  const last = ws[ws.length - 1];
  const single = singularWord(last);
  const head = ws.slice(0, -1).map(cap).join('');
  if (single === undefined) return className(head + cap(last) + 'Item');
  return className(head + cap(single));
}
