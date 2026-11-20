// CONTRACTS §24.5: a rule index for big collections. Pure and dependency-free (the webview reaches it through
// `rules.ts`). Rules are grouped by method × origin so a request only tests the rules that could match it; the
// candidates keep the rules' order, so first-match-wins and everything decided while scanning stays as it was.
//
// Correctness rests on one property: a rule placed under an origin can only match a URL whose request key
// (`requestOriginKey`) is that origin. The extractor below proves that for two shapes only (anything else goes to
// the wildcard list, tested for every request):
// - a glob whose text before the first `*` holds `scheme://authority` closed by `/`, `?` or `#` (or a glob with no
//   `*`: it equals the URL). Globs are case-sensitive, so the URL starts with exactly those characters;
// - a regex `^scheme:\/\/authority` of literal ASCII characters (flags only from `igysd`; no top-level `|`) followed by
//   an optional `(?::port)?` and a terminator: `/`, `?`, `#`, a class of those, `$`, or a `(?:…|…)` group each of
//   whose alternatives starts with one (a terminator made optional with `?` / `*` must be followed by another one).
//   Without the `u` / `v` flags a case-insensitive regex matches an ASCII letter only with its ASCII other case, so
//   the URL's scheme and authority are the literal's up to ASCII case, which the key lower-cases.
//
// Under each method × origin there is a second level: a trie on the literal path segments the rule's URL is proven to
// start with (`PathKey`). A rule sits at the node of those segments, either `exact` (the path ends there, give or take
// one trailing slash) or open (anything may follow). The extractor stops at the first segment it can't prove, so a
// rule it knows nothing about sits at the root, open: the origin bucket of before. What it proves, per segment:
// - the segment is plain text: unquantified literal characters, printable ASCII, not empty. Keys are lower-cased; so
//   is the request's segment. With the `i` flag an ASCII character only matches its own two cases (see above), and
//   without it (and in a glob) the text is the same, so a matching URL's segment always lower-cases to the key. A
//   segment with anything else in it (a parameter, a group of encodings, `é`, which `i` folds its own way) ends the
//   proof there. Nothing is decoded on either side: the matchers read the raw URL, and so do the keys;
// - the segment is whole: what follows it in the pattern can only start with `/`, `?`, `#` or the end of the URL
//   (a glob: one of those characters before the first `*`). `/user` + anything is not the segment `user`;
// - `exact`: what follows is one optional `/` and then only `?`, `#` or the end (a glob: the pattern ends there with no
//   `*`, or reaches its `?` / `#`).
// A request walks its own path segments (up to the first `?` / `#`) down the trie and takes the open rules of every
// node it passes, plus the exact rules of the node where its path ends. A rule deeper than the walk got needs a
// segment the request doesn't have.

/** `scheme://authority` at the start of a URL (the authority ends at the first `/`, `?` or `#`). */
const SCHEME_AUTHORITY = /^([a-z][a-z0-9+.-]*):\/\/([^/?#]*)/i;
const DEFAULT_PORTS = new Map([
  ['http', '80'],
  ['https', '443'],
  ['ws', '80'],
  ['wss', '443'],
]);
/** Characters with a meaning in a regex outside a class. */
const META = new Set('\\^$.|?*+()[]{}');
const QUANTIFIER = new Set('*+?{');
const TERMINATORS = new Set('/?#');
/** What may follow the last segment of a path. */
const PATH_ENDS = new Set('?#');
/** ASCII punctuation: `\` + one of these is the character itself (identity escape, without the `u` flag). */
const PUNCTUATION = /^[!-/:-@[-`{-~]$/;
const PRINTABLE_ASCII = /^[\x21-\x7e]*$/;
/** Flags whose meaning can't move where the regex matches (`g` / `y` are dropped by the matcher). */
const SAFE_FLAGS = /^[igysd]*$/;
/** A path segment the trie can key: printable ASCII, not empty. */
const KEYABLE = /^[\x21-\x7e]+$/;
/** Deepest trie level (a rule with more literal segments sits at this depth, open). */
const MAX_DEPTH = 16;
/** Trie nodes per index, the origins' roots aside (past it a rule sits at the deepest node it reached, open). */
export const MAX_TRIE_NODES = 20_000;

/**
 * Where a rule sits in its origin's path trie: the literal segments every URL it matches starts with (lower-cased
 * ASCII, never empty), and whether the path ends there (`exact`: nothing but one trailing slash may follow).
 */
export interface PathKey {
  readonly segs: readonly string[];
  readonly exact: boolean;
}

/** The origins a rule's URL can match and its place in their path tries. */
export interface IndexKey {
  origins: string[];
  path: PathKey;
}

/** Nothing proven about the path: any path of the origin. */
const ANY_PATH: PathKey = Object.freeze({ segs: Object.freeze([]) as readonly string[], exact: false });

/** The index key of a scheme + authority: lower-cased, the scheme's default port dropped. */
export function originKey(scheme: string, authority: string): string {
  const s = scheme.toLowerCase();
  let a = authority.toLowerCase();
  const port = DEFAULT_PORTS.get(s);
  if (port !== undefined && a.endsWith(`:${port}`)) a = a.slice(0, a.length - port.length - 1);
  return `${s}://${a}`;
}

/** The request's index key, or undefined when the URL has no `scheme://` (then only wildcard rules can match). */
export function requestOriginKey(url: string): string | undefined {
  const m = SCHEME_AUTHORITY.exec(url);
  return m ? originKey(m[1], m[2]) : undefined;
}

/**
 * The path key of a glob: `head` = its text before the first `*` (`whole`: there is none, the glob equals the URL),
 * `start` = the index after the authority.
 */
function globPath(head: string, start: number, whole: boolean): PathKey {
  const segs: string[] = [];
  let p = start; // at `/`, `?`, `#` or the end of the head
  for (;;) {
    const c = head[p];
    if (c === undefined) return { segs, exact: whole };
    if (c !== '/') return { segs, exact: true }; // `?` or `#`: the path is over
    let q = p + 1;
    while (q < head.length && !TERMINATORS.has(head[q])) q++;
    if (q === head.length && !whole) return { segs, exact: false }; // the `*` may continue this segment
    if (q === p + 1) return { segs, exact: head[q] !== '/' }; // a trailing slash ends the path; `//` isn't keyed
    const seg = head.slice(p + 1, q);
    if (segs.length >= MAX_DEPTH || !KEYABLE.test(seg)) return { segs, exact: false };
    segs.push(seg.toLowerCase());
    p = q;
  }
}

/** The index key of a glob (trimmed, not `''` / `*`), or undefined (wildcard). */
export function globIndexKey(pattern: string): IndexKey | undefined {
  const star = pattern.indexOf('*');
  const head = star < 0 ? pattern : pattern.slice(0, star);
  const m = SCHEME_AUTHORITY.exec(head);
  if (!m) return undefined;
  if (star >= 0 && m[0].length === head.length) return undefined; // the authority isn't closed before the first `*`
  return { origins: [originKey(m[1], m[2])], path: globPath(head, m[0].length, star < 0) };
}

/** The origin keys a glob (trimmed, not `''` / `*`) can match, or undefined (wildcard). */
export function globOriginKeys(pattern: string): string[] | undefined {
  return globIndexKey(pattern)?.origins;
}

/** A literal atom at `i`: [character, index after it], or undefined. */
function literalAt(src: string, i: number): [string, number] | undefined {
  const c = src[i];
  if (c === undefined) return undefined;
  if (c === '\\') {
    const e = src[i + 1];
    return e !== undefined && PUNCTUATION.test(e) ? [e, i + 2] : undefined;
  }
  return META.has(c) ? undefined : [c, i + 1];
}

/** Index after the class starting at `i` (`[`), JavaScript's rule (`]` right after `[` closes it), or -1. */
function skipClass(src: string, i: number): number {
  return scanClass(src, i, '')?.end ?? -1;
}

/** A class range covering at least this many code points counts as a wide atom (`[ -~]`, `[\x00-￿]`). */
const WIDE_RANGE = 94;
const HEX2 = /^[0-9a-fA-F]{2}$/;
const HEX4 = /^[0-9a-fA-F]{4}$/;
const CONTROL_ESCAPE: Readonly<Record<string, number>> = { b: 8, t: 9, n: 10, v: 11, f: 12, r: 13 };

/** One atom inside a class at `j` (not `]`): the index after it, its code point (when it can end a range), whether it's wide. */
function classAtom(src: string, j: number, unicode: boolean): { next: number; value?: number; wide: boolean } {
  const c = src[j];
  if (c !== '\\') {
    const cp = unicode ? src.codePointAt(j)! : src.charCodeAt(j);
    return { next: j + (cp > 0xffff ? 2 : 1), value: cp, wide: false };
  }
  const e = src[j + 1];
  if (e === undefined) return { next: j + 1, wide: false }; // a trailing `\`: the class never closes
  if (e === 'd' || e === 's' || e === 'w') return { next: j + 2, wide: false };
  if (e === 'D' || e === 'S' || e === 'W') return { next: j + 2, wide: true };
  if (unicode && (e === 'p' || e === 'P' || e === 'q') && src[j + 2] === '{') {
    // `\p{…}` / `\P{…}` (a property: counted as wide), `\q{…}` (`v` only, strings; `\}` escapes)
    let k = j + 3;
    while (k < src.length && src[k] !== '}') k += src[k] === '\\' ? 2 : 1;
    return { next: Math.min(k + 1, src.length), wide: e !== 'q' };
  }
  if (e === 'x' && HEX2.test(src.slice(j + 2, j + 4))) return { next: j + 4, value: parseInt(src.slice(j + 2, j + 4), 16), wide: false };
  if (e === 'u') {
    if (unicode && src[j + 2] === '{') {
      const close = src.indexOf('}', j + 3);
      if (close < 0) return { next: src.length, wide: false };
      return { next: close + 1, value: parseInt(src.slice(j + 3, close), 16), wide: false };
    }
    if (HEX4.test(src.slice(j + 2, j + 6))) return { next: j + 6, value: parseInt(src.slice(j + 2, j + 6), 16), wide: false };
  }
  if (e === 'c') {
    const l = src[j + 2] ?? '';
    // Annex B (no `u`): digits and `_` are control letters inside a class too; otherwise the `\` is itself a character
    if (/^[A-Za-z]$/.test(l) || (!unicode && /^[0-9_]$/.test(l))) return { next: j + 3, value: l.charCodeAt(0) % 32, wide: false };
    if (!unicode) return { next: j + 1, value: 0x5c, wide: false };
  }
  if (e in CONTROL_ESCAPE) return { next: j + 2, value: CONTROL_ESCAPE[e], wide: false };
  if (!unicode && e >= '0' && e <= '7') {
    // a legacy octal escape (at most \377)
    const m = /^[0-7]{1,3}/.exec(src.slice(j + 1, j + 4))![0];
    const digits = parseInt(m, 8) > 0o377 ? m.slice(0, 2) : m;
    return { next: j + 1 + digits.length, value: parseInt(digits, 8), wide: false };
  }
  const cp = unicode ? src.codePointAt(j + 1)! : src.charCodeAt(j + 1);
  return { next: j + 1 + (cp > 0xffff ? 2 : 1), value: cp, wide: false };
}

/**
 * The class starting at `i` (`[`), read the way JavaScript reads it (REVIEW-16 #1): `]` right after `[` / `[^` closes
 * it (`[]` matches nothing, `[^]` any character), `\]` and every other escape are one atom, and with the `v` flag
 * `[` opens a nested class. `end` is the index after its `]`; `wide` is true for a negated class (`[^…]`, `[^]`), one
 * holding `\S` / `\W` / `\D` / a property, or a range of at least 94 code points. Undefined when it never closes.
 */
export function scanClass(src: string, i: number, flags: string): { end: number; wide: boolean } | undefined {
  const unicode = flags.includes('u') || flags.includes('v');
  const sets = flags.includes('v');
  let j = i + 1;
  let wide = false;
  if (src[j] === '^') {
    wide = true;
    j++;
  }
  let depth = 1;
  while (j < src.length) {
    const c = src[j];
    if (c === ']') {
      if (--depth === 0) return { end: j + 1, wide };
      j++;
      continue;
    }
    if (sets && c === '[') {
      depth++;
      j++;
      if (src[j] === '^') {
        wide = true;
        j++;
      }
      continue;
    }
    if (sets && (src.startsWith('--', j) || src.startsWith('&&', j))) {
      j += 2;
      continue;
    }
    const a = classAtom(src, j, unicode);
    if (a.wide) wide = true;
    j = a.next;
    // a range `a-b` (a `-` before `]`, or after a set like `\d`, is a plain character)
    if (src[j] === '-' && a.value !== undefined && j + 1 < src.length && src[j + 1] !== ']' && !(sets && src[j + 1] === '-')) {
      if (sets && src[j + 1] === '[') continue;
      const b = classAtom(src, j + 1, unicode);
      if (b.value !== undefined) {
        if (b.value - a.value + 1 >= WIDE_RANGE) wide = true;
        j = b.next;
      }
    }
  }
  return undefined;
}

/**
 * From `i` (just inside a group, or 0 for the whole source): the starts of the alternatives at this depth and the index
 * after the closing `)` (src.length at depth 0), or undefined when unbalanced.
 */
function alternatives(src: string, i: number, inGroup: boolean): { starts: number[]; end: number } | undefined {
  const starts = [i];
  let depth = 0;
  let j = i;
  while (j < src.length) {
    const c = src[j];
    if (c === '\\') j += 2;
    else if (c === '[') {
      j = skipClass(src, j);
      if (j < 0) return undefined;
    } else if (c === '(') {
      depth++;
      j++;
    } else if (c === ')') {
      if (depth === 0) return inGroup ? { starts, end: j + 1 } : undefined;
      depth--;
      j++;
    } else {
      if (c === '|' && depth === 0) starts.push(j + 1);
      j++;
    }
  }
  return inGroup || depth !== 0 ? undefined : { starts, end: src.length };
}

/** A class at `i` whose members are all in `set` (`/`, `?`, `#`): the index after it, or -1. */
function terminatorClass(src: string, i: number, set: ReadonlySet<string>): number {
  const end = skipClass(src, i);
  if (end < 0 || src[i + 1] === '^' || end - i < 3) return -1;
  for (let j = i + 1; j < end - 1; ) {
    // in a class `?` is plain; `\/`, `\?`, `\#` are the characters themselves
    const c = src[j] === '\\' ? src[j + 1] : src[j];
    if (c === undefined || !set.has(c)) return -1;
    j += src[j] === '\\' ? 2 : 1;
  }
  return end;
}

/** Does every match of the source from `i` start with a character of `set` (`/`, `?`, `#`) or the end of the URL? */
function terminatorAt(src: string, i: number, set: ReadonlySet<string> = TERMINATORS, depth = 0): boolean {
  if (depth > 8) return false;
  if (src[i] === '$') return !QUANTIFIER.has(src[i + 1] ?? '');
  let next: number;
  if (src.startsWith('(?:', i)) {
    const g = alternatives(src, i + 3, true);
    if (!g || !g.starts.every((s) => terminatorAt(src, s, set, depth + 1))) return false;
    next = g.end;
  } else if (src[i] === '[') {
    next = terminatorClass(src, i, set);
    if (next < 0) return false;
  } else {
    const a = literalAt(src, i);
    if (!a || !set.has(a[0])) return false;
    next = a[1];
  }
  const q = src[next];
  if (q === '+') return true;
  if (q === '?' || q === '*') return terminatorAt(src, next + 1 + (src[next + 1] === '?' ? 1 : 0), set, depth + 1); // optional
  return q !== '{';
}

/** Does the path end at `i`: one optional `/`, then only `?`, `#` or the end of the URL? */
function pathEndAt(src: string, i: number): boolean {
  const a = literalAt(src, i);
  if (!a || a[0] !== '/') return terminatorAt(src, i, PATH_ENDS);
  const q = src[a[1]] ?? '';
  if (q === '?') return terminatorAt(src, a[1] + 1, PATH_ENDS); // (a lazy `/??` fails here: `?` starts no terminator)
  return !QUANTIFIER.has(q) && terminatorAt(src, a[1], PATH_ENDS); // `/+`, `/*`: more than one slash isn't this node
}

/** The path key of a regex from `i`: the index in the source where the URL's path starts (right after the authority). */
function regexPath(src: string, i: number): PathKey {
  const segs: string[] = [];
  for (;;) {
    if (pathEndAt(src, i)) return { segs, exact: true };
    const slash = literalAt(src, i);
    if (!slash || slash[0] !== '/' || QUANTIFIER.has(src[slash[1]] ?? '')) return { segs, exact: false };
    let j = slash[1];
    let seg = '';
    for (;;) {
      const a = literalAt(src, j);
      if (!a || TERMINATORS.has(a[0]) || QUANTIFIER.has(src[a[1]] ?? '')) break; // a quantified atom isn't fixed text
      seg += a[0];
      j = a[1];
    }
    // the segment must be whole: `\/user` + a parameter also matches `/users`
    if (segs.length >= MAX_DEPTH || !KEYABLE.test(seg) || !terminatorAt(src, j)) return { segs, exact: false };
    segs.push(seg.toLowerCase());
    i = j;
  }
}

/**
 * The index key of a `/regex/flags` rule (`src` as the matcher compiles it, after simplifyRegexSource), or undefined
 * (wildcard).
 */
export function regexIndexKey(src: string, flags: string): IndexKey | undefined {
  if (!SAFE_FLAGS.test(flags) || src[0] !== '^') return undefined;
  const top = alternatives(src, 0, false);
  if (!top || top.starts.length !== 1) return undefined; // a top-level `|`: the prefix doesn't bind every alternative
  let i = 1;
  let lit = '';
  const at: number[] = []; // where each character of `lit` is in the source
  for (;;) {
    const a = literalAt(src, i);
    if (!a || QUANTIFIER.has(src[a[1]] ?? '')) break; // a quantified atom isn't fixed text
    lit += a[0];
    at.push(i);
    i = a[1];
  }
  const m = SCHEME_AUTHORITY.exec(lit);
  // only the scheme and authority make the key (what follows a closing `/`, `?` or `#` is the path's business)
  if (!m || !PRINTABLE_ASCII.test(m[0])) return undefined;
  if (m[0].length < lit.length) {
    // closed by a literal `/`, `?` or `#`: the path starts there
    return { origins: [originKey(m[1], m[2])], path: regexPath(src, at[m[0].length]) };
  }
  const auths = [m[2]];
  const port = /^\(\?::(\d{1,5})\)\?/.exec(src.slice(i, i + 16));
  if (port) {
    i += port[0].length;
    auths.push(`${m[2]}:${port[1]}`);
  }
  if (!terminatorAt(src, i)) return undefined;
  return { origins: [...new Set(auths.map((a) => originKey(m[1], a)))], path: regexPath(src, i) };
}

/** The origin keys a `/regex/flags` rule can match, or undefined (wildcard). */
export function regexOriginKeys(src: string, flags: string): string[] | undefined {
  return regexIndexKey(src, flags)?.origins;
}

/** A node of an origin's path trie: the rules whose proven path is the segments leading here. */
interface TrieNode {
  /** Unique in the index. */
  readonly id: number;
  /** Rules that match this path and anything deeper. */
  open: number[] | undefined;
  /** Rules that match this path only (and its trailing slash). */
  exact: number[] | undefined;
  children: Map<string, TrieNode> | undefined;
}

interface Bucket {
  /** The path trie of each origin (its root). */
  origins: Map<string, TrieNode>;
  wild: number[];
}

const NONE: readonly number[] = Object.freeze([]);
/** Merged candidate lists kept: at most this many, of at most this many rule positions together. */
const CACHE_MAX = 4096;
const CACHE_ITEMS_MAX = 1 << 18;
const SLASH = 47;
const QUESTION = 63;
const HASH = 35;

function merge(a: readonly number[], b: readonly number[]): number[] {
  const out = new Array<number>(a.length + b.length);
  let i = 0;
  let j = 0;
  let k = 0;
  while (i < a.length && j < b.length) out[k++] = a[i] < b[j] ? a[i++] : b[j++];
  while (i < a.length) out[k++] = a[i++];
  while (j < b.length) out[k++] = b[j++];
  return out;
}

/** Sorted lists (two or more) as one sorted list. */
function mergeAll(parts: readonly (readonly number[])[]): readonly number[] {
  let lists = parts.slice();
  while (lists.length > 1) {
    const next: (readonly number[])[] = [];
    for (let i = 0; i < lists.length; i += 2) next.push(i + 1 < lists.length ? merge(lists[i], lists[i + 1]) : lists[i]);
    lists = next;
  }
  return lists[0];
}

/**
 * Rules by method (upper-cased, `*` = any) × origin (or wildcard) × literal path prefix. `candidates` returns, in the
 * rules' order, every rule that could match a request: the union of its method's and `*`'s wildcard lists and of the
 * lists its path passes in their tries for its origin. Built once per rule set; never changed afterwards (the rules'
 * state — enabled, spent, sequence position — is read while scanning).
 */
export class RuleIndex {
  private readonly methods = new Map<string, Bucket>();
  /** Merged candidate lists by method + the trie nodes reached (only when more than one list applies). */
  private readonly merged = new Map<string, readonly number[]>();
  private mergedItems = 0;
  /** Some rule is under an origin (else the request's origin isn't worth reading). */
  private indexed = false;
  private nodes = 0;
  private trieNodes = 0;
  /** The lists that apply to the request being looked up (reused: `candidates` doesn't re-enter). */
  private readonly parts: (readonly number[])[] = [];

  /**
   * `size`: the number of rules indexed (a list of another length isn't this index's). `maxNodes`: trie nodes allowed
   * (0 = no path level: every rule at its origin's root).
   */
  constructor(
    readonly size: number,
    private readonly maxNodes: number = MAX_TRIE_NODES,
  ) {}

  private node(): TrieNode {
    return { id: this.nodes++, open: undefined, exact: undefined, children: undefined };
  }

  /**
   * Rule `i` (added in increasing order): its method (`*` = any), origin keys (undefined = wildcard) and place in the
   * origins' path tries (none = any path).
   */
  add(i: number, method: string, keys: readonly string[] | undefined, path: PathKey = ANY_PATH): void {
    let b = this.methods.get(method);
    if (!b) this.methods.set(method, (b = { origins: new Map(), wild: [] }));
    if (!keys) {
      b.wild.push(i);
      return;
    }
    this.indexed = true;
    for (const k of keys) {
      let node: TrieNode | undefined = b.origins.get(k);
      if (!node) b.origins.set(k, (node = this.node()));
      let exact = path.exact;
      for (const seg of path.segs) {
        let child: TrieNode | undefined = node.children?.get(seg);
        if (!child) {
          if (this.trieNodes >= this.maxNodes) {
            exact = false; // past the cap: the rule stays at the node it reached, for any deeper path
            break;
          }
          this.trieNodes++;
          child = this.node();
          (node.children ??= new Map()).set(seg, child);
        }
        node = child;
      }
      const list = exact ? (node.exact ??= []) : (node.open ??= []);
      if (list[list.length - 1] !== i) list.push(i);
    }
  }

  /**
   * Walks the URL's path (from `start`, the index after the authority) down a trie, adding to `parts` the open rules of
   * every node passed and the exact rules of the last one when the path ends there. Returns that node and whether the
   * path ended there, as one number (the lists added depend on nothing else).
   */
  private walk(root: TrieNode, url: string, start: number): number {
    const parts = this.parts;
    let node = root;
    let p = start; // at `/`, `?`, `#` or the end of the URL
    let ended = false;
    for (;;) {
      if (node.open !== undefined) parts.push(node.open);
      if (url.charCodeAt(p) !== SLASH) {
        ended = true; // the end, `?` or `#`
        break;
      }
      let q = p + 1;
      for (; q < url.length; q++) {
        const c = url.charCodeAt(q);
        if (c === SLASH || c === QUESTION || c === HASH) break;
      }
      if (q === p + 1) {
        ended = url.charCodeAt(q) !== SLASH; // a trailing slash ends the path; `//` is a segment no rule is keyed by
        break;
      }
      // lower-cased like the keys: a segment a rule's literal matches is that literal up to ASCII case
      const child = node.children?.get(url.slice(p + 1, q).toLowerCase());
      if (!child) break;
      node = child;
      p = q;
    }
    if (ended && node.exact !== undefined) parts.push(node.exact);
    return node.id * 2 + (ended ? 1 : 0);
  }

  /** Indexes of the rules that could match, in order. `method` already upper-cased. */
  candidates(method: string, url: string): readonly number[] {
    if (this.methods.size === 0) return NONE;
    const exact = method === '*' ? undefined : this.methods.get(method);
    const any = this.methods.get('*');
    const parts = this.parts;
    parts.length = 0;
    let e = -1;
    let a = -1;
    if (this.indexed) {
      const m = SCHEME_AUTHORITY.exec(url);
      if (m) {
        const origin = originKey(m[1], m[2]);
        const er = exact?.origins.get(origin);
        const ar = any?.origins.get(origin);
        if (er) e = this.walk(er, url, m[0].length);
        if (ar) a = this.walk(ar, url, m[0].length);
      }
    }
    if (exact && exact.wild.length > 0) parts.push(exact.wild);
    if (any && any.wild.length > 0) parts.push(any.wild);
    if (parts.length === 0) return NONE;
    if (parts.length === 1) return parts[0];
    const key = `${e},${a},${exact ? method : '*'}`;
    let out = this.merged.get(key);
    if (!out) {
      out = mergeAll(parts);
      if (this.merged.size >= CACHE_MAX || this.mergedItems + out.length > CACHE_ITEMS_MAX) {
        this.merged.clear();
        this.mergedItems = 0;
      }
      this.merged.set(key, out);
      this.mergedItems += out.length;
    }
    return out;
  }
}
