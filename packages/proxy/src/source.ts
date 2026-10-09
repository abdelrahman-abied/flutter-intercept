// Dart stack parsing for request → source (CONTRACTS §9.2). Pure and dependency-free
// (`@flutter-intercept/proxy/source`): the host and the webview may import it.
//
// Accepted input (any mix, line by line; anything else is skipped):
// - VM `StackTrace.toString()`: `#0      Foo.bar (package:app/x.dart:10:5)`, frames without a column
//   (`(file:///x.dart:10)`) or without a line (`(dart:core-patch/function.dart)`), closures
//   (`_State.build.<anonymous closure>`), `new Foo` constructors, `<asynchronous suspension>`.
// - stack_trace `Trace`/`Chain.toString()` (terse): `package:app/x.dart 10:5   Foo.bar`, `dart:async   _rootRun`,
//   and the chain separator `===== asynchronous gap ===========================`.
// Both an `<asynchronous suspension>` and a chain gap mark the NEXT frame `afterAsyncGap`.
import type { SourceInfo, StackFrame } from './types';

/**
 * Packages whose frames are never the app's call site: HTTP stacks, their adapters/interceptors/loggers,
 * codegen'd API layers and Flutter. Besides these exact names, whole families are treated as framework
 * (see `isFrameworkPackage`): `dio_*`, `http_*`, `gql_*`, `sentry_*`. `flutter_*` is deliberately NOT a
 * family: `flutter create` names apps `flutter_application_1`, so that prefix is often the app itself.
 */
export const FRAMEWORK_PACKAGES: readonly string[] = [
  'dio',
  'http',
  'flutter',
  'retrofit',
  'chopper',
  'graphql',
  'graphql_flutter',
  'stack_trace',
  'async',
  'ferry',
  'cronet_http',
  'cupertino_http',
  'native_dio_adapter',
  'pretty_dio_logger',
  'talker_dio_logger',
  'sentry',
  'web_socket_channel',
  'flutter_cache_manager',
  'cached_network_image',
  'grpc',
];

const FRAMEWORK_PREFIXES = ['dio_', 'http_', 'gql_', 'sentry_'];

/**
 * Lines longer than this are skipped unparsed. Real frames are a few hundred characters; the cap (with the
 * string-operation parsing below, which is linear) keeps an adversarial trace POST cheap (REVIEW-3 #2).
 */
export const MAX_FRAME_LINE = 2048;

const TERSE_LOCATION = /^(?:package:|dart:|file:|org-dartlang-|[A-Za-z]:[\\/]|\/|\.{1,2}\/)/;
const DIGITS = /^\d+$/;

const isDigits = (s: string) => s.length > 0 && s.length <= 9 && DIGITS.test(s);

/** Split `uri:line:col` / `uri:line` / `uri` (the URI itself may contain colons). String ops only. */
function splitLocation(loc: string): { uri: string; line?: number; column?: number } {
  const a = loc.lastIndexOf(':');
  if (a < 0 || !isDigits(loc.slice(a + 1))) return { uri: loc };
  const head = loc.slice(0, a);
  const b = head.lastIndexOf(':');
  if (b >= 0 && isDigits(head.slice(b + 1))) return { uri: head.slice(0, b), line: Number(head.slice(b + 1)), column: Number(loc.slice(a + 1)) };
  if (/[/:]/.test(head)) return { uri: head, line: Number(loc.slice(a + 1)) };
  return { uri: loc };
}

/** `<asynchronous suspension>` (VM) or `===== asynchronous gap ====…` (stack_trace Chain). */
function isGap(line: string): boolean {
  if (line === '<asynchronous suspension>') return true;
  if (!line.startsWith('===')) return false;
  return line.split('=').join(' ').trim().split(/\s+/).join(' ') === 'asynchronous gap';
}

const WS = /\s/;

/** Index of the first whitespace character at or after `from`, or -1. */
function nextWs(s: string, from: number): number {
  for (let i = from; i < s.length; i++) if (WS.test(s[i])) return i;
  return -1;
}

function skipWs(s: string, from: number): number {
  let i = from;
  while (i < s.length && WS.test(s[i])) i++;
  return i;
}

/** VM: `#<n> <fn> (<location>)`. The fn ends at the first " (" (fn names have no parentheses). */
function parseVm(line: string): { fn: string; loc: string } | undefined {
  let i = 1;
  while (i < line.length && line[i] >= '0' && line[i] <= '9') i++;
  if (i === 1 || !WS.test(line[i] ?? '')) return undefined;
  const rest = line.slice(skipWs(line, i));
  if (!rest.endsWith(')')) return undefined;
  const open = rest.indexOf(' (');
  if (open <= 0) return undefined;
  const fn = rest.slice(0, open).trim();
  return fn ? { fn, loc: rest.slice(open + 2, -1) } : undefined;
}

/** stack_trace terse/plain: `<location>[ <line>[:<col>]]<2+ spaces><member>`. The location has no spaces. */
function parseTerse(line: string): { fn: string; uri: string; line?: number; column?: number } | undefined {
  const sp = nextWs(line, 0);
  if (sp <= 0) return undefined;
  const loc = line.slice(0, sp);
  if (!TERSE_LOCATION.test(loc) && !loc.endsWith('.dart')) return undefined;
  let pos = sp;
  let lineNo: number | undefined;
  let col: number | undefined;
  const tokStart = skipWs(line, pos);
  const tokEnd = nextWs(line, tokStart);
  if (tokEnd > tokStart) {
    const tok = line.slice(tokStart, tokEnd);
    const c = tok.indexOf(':');
    const l = c < 0 ? tok : tok.slice(0, c);
    if (isDigits(l) && (c < 0 || isDigits(tok.slice(c + 1)))) {
      lineNo = Number(l);
      if (c >= 0) col = Number(tok.slice(c + 1));
      pos = tokEnd;
    }
  }
  const memberStart = skipWs(line, pos);
  if (memberStart - pos < 2) return undefined;
  const fn = line.slice(memberStart).trim();
  return fn ? { fn, uri: terseUri(loc), line: lineNo, column: col } : undefined;
}

/** stack_trace prints file URIs as paths: make absolute ones `file:///…` again; keep relative ones. */
function terseUri(library: string): string {
  if (/^[A-Za-z]:[\\/]/.test(library)) return `file:///${library.replace(/\\/g, '/')}`;
  if (library.startsWith('/')) return `file://${library}`;
  return library;
}

function frame(fn: string, loc: { uri: string; line?: number; column?: number }, afterAsyncGap: boolean): StackFrame {
  const f: StackFrame = { fn, uri: loc.uri };
  if (loc.line !== undefined && loc.line > 0) f.line = loc.line;
  if (loc.column !== undefined && loc.column > 0) f.column = loc.column;
  if (afterAsyncGap) f.afterAsyncGap = true;
  return f;
}

/**
 * Parse a Dart `StackTrace.toString()` (VM `#0 fn (uri:line:col)` with `<asynchronous suspension>`) or a
 * stack_trace Chain (`===== asynchronous gap ===`). At most `maxFrames` (default 30). Never throws.
 * Linear in the input: lines over MAX_FRAME_LINE are skipped, the rest is parsed with string operations.
 */
export function parseDartStack(stack: string, maxFrames = 30): StackFrame[] {
  const frames: StackFrame[] = [];
  if (typeof stack !== 'string' || maxFrames <= 0) return frames;
  let gap = false;
  for (const raw of stack.split('\n')) {
    if (raw.length > MAX_FRAME_LINE) continue;
    const line = raw.trim();
    if (!line) continue;
    if (isGap(line)) {
      gap = frames.length > 0; // a gap before the first frame says nothing
      continue;
    }
    if (line.startsWith('#')) {
      const vm = parseVm(line);
      if (!vm) continue; // not a frame (AOT "#00 abs …" lines, …)
      frames.push(frame(vm.fn, splitLocation(vm.loc), gap));
    } else {
      const t = parseTerse(line);
      if (!t) continue; // headers, garbage
      frames.push(frame(t.fn, t, gap));
    }
    gap = false;
    if (frames.length >= maxFrames) break;
  }
  return frames;
}

/** `package:<name>/…` → name, else undefined. */
export function packageOf(uri: string): string | undefined {
  const m = /^package:([^/]+)\//.exec(uri);
  return m ? m[1] : undefined;
}

export function isFrameworkPackage(name: string): boolean {
  return FRAMEWORK_PACKAGES.includes(name) || FRAMEWORK_PREFIXES.some((p) => name.startsWith(p));
}

/**
 * A frame of Flutter Intercept's generated entry (CONTRACTS §1): anything under
 * `.dart_tool/flutter_intercept/`, a non-package file named `entry_*.dart` (the entry is never under lib/,
 * so it is never a `package:` URI — an app's own `lib/entry_screen.dart` is not mistaken for it), or the
 * entry's wrapper classes.
 */
export function isGeneratedEntryFrame(f: StackFrame): boolean {
  const uri = f.uri.replace(/\\/g, '/');
  if (uri.includes('/.dart_tool/flutter_intercept/') || uri.startsWith('.dart_tool/flutter_intercept/')) return true;
  if (!uri.startsWith('package:') && /(?:^|\/)entry_[A-Za-z0-9_]+\.dart$/.test(uri)) return true;
  return /^_(?:Intercepted|FlutterIntercept)\w*\./.test(f.fn);
}

/**
 * Index of the app's call site: the first frame in one of `appPackages` if any matches; else the first
 * frame that is not `dart:`, not the generated entry, and not a framework package (`FRAMEWORK_PACKAGES`
 * or one of its families). Frames with no URI scheme package (e.g. `file:///…/bin/main.dart`) count as app.
 */
export function pickAppFrame(frames: StackFrame[], appPackages: readonly string[] = []): number | undefined {
  if (appPackages.length) {
    const i = frames.findIndex((f) => {
      const p = packageOf(f.uri);
      return p !== undefined && appPackages.includes(p);
    });
    if (i >= 0) return i;
  }
  const i = frames.findIndex((f) => {
    if (f.uri.startsWith('dart:') || f.uri.startsWith('org-dartlang-sdk:') || isGeneratedEntryFrame(f)) return false;
    const p = packageOf(f.uri);
    return p === undefined || !isFrameworkPackage(p);
  });
  return i >= 0 ? i : undefined;
}

/** Frames kept per exchange (CONTRACTS §9.2). */
export const MAX_SOURCE_FRAMES = 30;
/** Frames parsed before choosing the window (Dio interceptor chains can be deep). */
const PARSE_FRAMES = 256;

/**
 * Parse + pick, as stored on `Exchange.source`. The generated entry's own frames (always on top) are
 * dropped, and at most 30 frames are kept: the first 30, or — when the app frame is deeper — a window
 * that ends 10 frames below it, so `appFrame` is always inside `frames`.
 */
export function toSourceInfo(stack: string, appPackages: readonly string[] = []): SourceInfo {
  let frames = parseDartStack(stack, PARSE_FRAMES);
  let top = 0;
  while (top < frames.length && isGeneratedEntryFrame(frames[top])) top++;
  if (top > 0) {
    frames = frames.slice(top);
    if (frames[0]?.afterAsyncGap) delete frames[0].afterAsyncGap;
  }
  let appFrame = pickAppFrame(frames, appPackages);
  if (frames.length > MAX_SOURCE_FRAMES) {
    const start = appFrame !== undefined && appFrame >= MAX_SOURCE_FRAMES ? appFrame - (MAX_SOURCE_FRAMES - 10) : 0;
    frames = frames.slice(start, start + MAX_SOURCE_FRAMES);
    if (appFrame !== undefined) appFrame -= start;
  }
  return appFrame === undefined ? { frames } : { frames, appFrame };
}
