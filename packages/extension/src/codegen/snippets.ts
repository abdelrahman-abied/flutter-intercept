/**
 * "Copy as …" code snippets for a recorded request (CONTRACTS §9.4). Pure: no `vscode`, no I/O.
 *
 * - `curl`: POSIX shell, single-quoted (ANSI-C `$'…'` only when the text has control characters),
 *   `--compressed` instead of an Accept-Encoding header, `-g` when the URL has glob characters.
 * - `dart_http`: package:http. `dio`: package:dio (validateStatus accepts every status, plain response).
 * - Framing / hop-by-hop headers (content-length, host, connection, transfer-encoding, proxy-*, …) are
 *   dropped: the client recomputes them, and Proxy-Authorization is the proxy's own credential.
 * - Binary bodies never appear inline: a commented placeholder says how many bytes are missing.
 * The caller decides about redaction (the webview's copy is the user's own clipboard: unredacted;
 * agents get a snippet built from the redacted view).
 */
import type { Body } from '@flutter-intercept/proxy';
import type { SnippetFormat } from '../ui/protocol';

export type { SnippetFormat };
export const SNIPPET_FORMATS: readonly SnippetFormat[] = ['curl', 'dart_http', 'dio'];

export interface SnippetRequest {
  method: string;
  url: string;
  headers?: Record<string, string | string[]>;
  body?: Body;
}

/** Headers a snippet never carries (lower-case). */
const DROPPED = new Set([
  'content-length',
  'host',
  'connection',
  'keep-alive',
  'proxy-connection',
  'proxy-authorization',
  'proxy-authenticate',
  'transfer-encoding',
  'te',
  'trailer',
  'upgrade',
  'x-fi-id',
]);

/** Header entries to put in a snippet, in their original order (pseudo-headers and framing dropped). */
export function snippetHeaders(headers: Record<string, string | string[]> | undefined): [string, string[]][] {
  const out: [string, string[]][] = [];
  for (const [name, value] of Object.entries(headers ?? {})) {
    const lower = name.toLowerCase();
    if (lower.startsWith(':') || DROPPED.has(lower)) continue;
    const values = (Array.isArray(value) ? value : [value]).filter((v): v is string => typeof v === 'string');
    if (values.length) out.push([name, values]);
  }
  return out;
}

/** The Accept-Encoding header asks for compression a client can decode itself. */
function wantsCompression(headers: [string, string[]][]): boolean {
  return headers.some(([n, v]) => n.toLowerCase() === 'accept-encoding' && /\b(gzip|deflate|br|zstd)\b/i.test(v.join(',')));
}

function withoutAcceptEncoding(headers: [string, string[]][]): [string, string[]][] {
  return headers.filter(([n]) => n.toLowerCase() !== 'accept-encoding');
}

/** One header value for clients whose header map takes a single string (Cookie joins with "; "). */
function joined(name: string, values: string[]): string {
  return values.join(name.toLowerCase() === 'cookie' ? '; ' : ', ');
}

function binaryBytes(b: Body): number {
  return Buffer.from(b.text, 'base64').length;
}

export function toSnippet(req: SnippetRequest, format: SnippetFormat): string {
  switch (format) {
    case 'curl':
      return toCurl(req);
    case 'dart_http':
      return toDartHttp(req);
    case 'dio':
      return toDio(req);
    default:
      throw new Error(`unknown snippet format ${JSON.stringify(format)}`);
  }
}

// ------------------------------------------------------------------ shell

/** Quotes one shell word: '…' normally, $'…' when it has control characters (NUL is dropped: argv can't hold it). */
export function shellQuote(s: string): string {
  if (s !== '' && /^[A-Za-z0-9_@%+=:,./-]+$/.test(s)) return s;
  // eslint-disable-next-line no-control-regex
  if (!/[\x00-\x08\x0b-\x1f\x7f]/.test(s)) return `'${s.replace(/'/g, `'\\''`)}'`;
  let out = "$'";
  for (const ch of s) {
    const c = ch.codePointAt(0)!;
    if (ch === '\\') out += '\\\\';
    else if (ch === "'") out += "\\'";
    else if (ch === '\n') out += '\\n';
    else if (ch === '\r') out += '\\r';
    else if (ch === '\t') out += '\\t';
    else if (c === 0) continue;
    else if (c < 0x20 || c === 0x7f) out += `\\x${c.toString(16).padStart(2, '0')}`;
    else out += ch;
  }
  return out + "'";
}

function toCurl(req: SnippetRequest): string {
  const method = req.method.toUpperCase();
  const all = snippetHeaders(req.headers);
  const compressed = wantsCompression(all);
  const headers = compressed ? withoutAcceptEncoding(all) : all;
  const pre: string[] = [];
  const args: string[] = [];
  const body = req.body;
  const hasBody = !!body && (body.encoding === 'base64' || body.text.length > 0);

  if (method === 'HEAD') args.push('--head');
  else if (!((method === 'GET' && !hasBody) || (method === 'POST' && hasBody))) args.push(`-X ${shellQuote(method)}`);
  for (const [name, values] of headers) for (const v of values) args.push(`-H ${shellQuote(`${name}: ${v}`)}`);
  if (hasBody && body) {
    if (body.encoding === 'base64') {
      pre.push(`# Binary request body (${binaryBytes(body)} bytes) not included: save it as body.bin next to this command.`);
      args.push('--data-binary @body.bin');
    } else {
      if (body.truncated) pre.push('# Note: the request body was truncated when it was recorded (larger than 5 MB).');
      args.push(`--data-raw ${shellQuote(body.text)}`);
    }
  }
  if (compressed) args.push('--compressed');
  if (/[[\]{}]/.test(req.url)) args.push('-g');
  const lines = [`curl ${shellQuote(req.url)}`, ...args.map((a) => `  ${a}`)];
  return [...pre, lines.join(' \\\n')].join('\n');
}

// ------------------------------------------------------------------ Dart

/** A Dart single-quoted string literal with everything escaped (`$` included). */
export function dartString(s: string): string {
  let out = "'";
  for (const ch of s) {
    const c = ch.codePointAt(0)!;
    if (ch === '\\') out += '\\\\';
    else if (ch === "'") out += "\\'";
    else if (ch === '$') out += '\\$';
    else if (ch === '\n') out += '\\n';
    else if (ch === '\r') out += '\\r';
    else if (ch === '\t') out += '\\t';
    else if (c < 0x20 || c === 0x7f) out += `\\u{${c.toString(16)}}`;
    else out += ch;
  }
  return out + "'";
}

/** A readable body literal: a raw multi-line string when that is lossless, else an escaped one. */
export function dartBodyLiteral(s: string): string {
  const rawOk =
    s.length > 0 &&
    !s.includes("'''") &&
    !s.endsWith("'") &&
    !/^[ \t]*\n/.test(s) && // a leading blank line would be stripped by Dart
    // eslint-disable-next-line no-control-regex
    !/[\x00-\x08\x0b-\x1f\x7f]/.test(s);
  return rawOk ? `r'''${s}'''` : dartString(s);
}

function dartHeaderMap(headers: [string, string[]][], indent: string): string {
  if (!headers.length) return '{}';
  const inner = headers.map(([n, v]) => `${indent}  ${dartString(n)}: ${dartString(joined(n, v))},`).join('\n');
  return `{\n${inner}\n${indent}}`;
}

/** Body expression for Dart plus comment lines to put before the call. */
function dartBody(body: Body | undefined): { expr?: string; notes: string[] } {
  if (!body || (body.encoding === 'utf8' && body.text.length === 0)) return { notes: [] };
  if (body.encoding === 'base64') {
    return { expr: `<int>[] /* binary request body (${binaryBytes(body)} bytes) not included */`, notes: [] };
  }
  return { expr: dartBodyLiteral(body.text), notes: body.truncated ? ['  // Note: the request body was truncated when it was recorded (larger than 5 MB).'] : [] };
}

const HTTP_SHORTHANDS = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE']);

function toDartHttp(req: SnippetRequest): string {
  const method = req.method.toUpperCase();
  const headers = withoutAcceptEncoding(snippetHeaders(req.headers)); // dart:io negotiates gzip itself
  const { expr, notes } = dartBody(req.body);
  const uri = `Uri.parse(${dartString(req.url)})`;
  const lines = ["import 'package:http/http.dart' as http;", '', 'Future<void> main() async {', ...notes];
  const bodyless = method === 'GET' || method === 'HEAD';
  if (HTTP_SHORTHANDS.has(method) && !(bodyless && expr !== undefined)) {
    lines.push(`  final response = await http.${method.toLowerCase()}(`, `    ${uri},`);
    if (headers.length) lines.push(`    headers: ${dartHeaderMap(headers, '    ')},`);
    if (expr !== undefined) lines.push(`    body: ${expr},`);
    lines.push('  );');
  } else {
    lines.push(`  final request = http.Request(${dartString(method)}, ${uri});`);
    if (headers.length) lines.push(`  request.headers.addAll(${dartHeaderMap(headers, '  ')});`);
    if (expr !== undefined) lines.push(req.body?.encoding === 'base64' ? `  request.bodyBytes = ${expr};` : `  request.body = ${expr};`);
    lines.push('  final response = await http.Response.fromStream(await request.send());');
  }
  lines.push("  print('${response.statusCode} ${response.body}');", '}');
  return lines.join('\n');
}

function toDio(req: SnippetRequest): string {
  const method = req.method.toUpperCase();
  const headers = withoutAcceptEncoding(snippetHeaders(req.headers));
  const { expr, notes } = dartBody(req.body);
  const lines = [
    "import 'package:dio/dio.dart';",
    '',
    'Future<void> main() async {',
    ...notes,
    '  final dio = Dio();',
    '  final response = await dio.request<String>(',
    `    ${dartString(req.url)},`,
  ];
  if (expr !== undefined) lines.push(`    data: ${expr},`);
  lines.push('    options: Options(', `      method: ${dartString(method)},`);
  if (headers.length) lines.push(`      headers: ${dartHeaderMap(headers, '      ')},`);
  lines.push('      responseType: ResponseType.plain,', '      validateStatus: (_) => true,', '    ),', '  );', "  print('${response.statusCode} ${response.data}');", '}');
  return lines.join('\n');
}
