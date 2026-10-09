import { execFileSync } from 'child_process';
import { describe, expect, it } from 'vitest';
import { dartBodyLiteral, dartString, shellQuote, snippetHeaders, toSnippet } from '../../src/codegen/snippets';

const sh = (script: string) => execFileSync('/bin/sh', ['-c', script], { encoding: 'utf8' });
/** What the shell actually passes for one quoted word. */
const roundTrip = (s: string) => sh(`printf '%s' ${shellQuote(s)}`);

describe('shellQuote', () => {
  it.each(['plain', "it's", "a'b'c", 'two words', '$HOME `id` $(id) "q" \\n', 'line1\nline2', '', '*?[]{}~!#&;|<>', 'üñî €', "''"])(
    'round-trips %j through /bin/sh',
    (s) => {
      expect(roundTrip(s)).toBe(s);
    },
  );

  it('uses ANSI-C quoting for control characters and still round-trips in bash', () => {
    const s = 'a\tb\x01c\rd\x7fe\'f\\g';
    const q = shellQuote(s);
    expect(q.startsWith("$'")).toBe(true);
    expect(execFileSync('/bin/bash', ['-c', `printf '%s' ${q}`], { encoding: 'utf8' })).toBe(s);
  });

  it('leaves safe words bare', () => {
    expect(shellQuote('https://api.example.com/v1/users')).toBe('https://api.example.com/v1/users');
    expect(shellQuote('https://x.dev/a?b=1&c=2')).toBe("'https://x.dev/a?b=1&c=2'");
  });
});

describe('snippetHeaders', () => {
  it('drops framing, hop-by-hop, proxy and pseudo headers; keeps order and multi-values', () => {
    expect(
      snippetHeaders({
        Host: 'a',
        'content-length': '3',
        Connection: 'keep-alive',
        'Proxy-Authorization': 'Basic xyz',
        'transfer-encoding': 'chunked',
        ':authority': 'a',
        'x-fi-id': 'abc12345',
        Accept: 'application/json',
        'X-Multi': ['1', '2'],
      }),
    ).toEqual([
      ['Accept', ['application/json']],
      ['X-Multi', ['1', '2']],
    ]);
  });
});

describe('curl', () => {
  it('GET with headers, multi-value headers, --compressed instead of accept-encoding', () => {
    const s = toSnippet(
      {
        method: 'GET',
        url: 'https://api.example.com/v1/users?page=1&q=a b',
        headers: { accept: 'application/json', 'accept-encoding': 'gzip, deflate', 'x-tag': ['a', 'b'], 'content-length': '0', host: 'api.example.com' },
      },
      'curl',
    );
    expect(s).toBe(
      [
        "curl 'https://api.example.com/v1/users?page=1&q=a b' \\",
        "  -H 'accept: application/json' \\",
        "  -H 'x-tag: a' \\",
        "  -H 'x-tag: b' \\",
        '  --compressed',
      ].join('\n'),
    );
    expect(s).not.toMatch(/-X|host:|content-length/i);
  });

  it('POST JSON body: no -X (implied by --data-raw), body quoted safely', () => {
    const body = '{"name":"O\'Brien","note":"$HOME `x`"}';
    const s = toSnippet({ method: 'post', url: 'https://x.dev/users', headers: { 'Content-Type': 'application/json' }, body: { text: body, encoding: 'utf8' } }, 'curl');
    expect(s).not.toContain('-X');
    expect(s).toContain("-H 'Content-Type: application/json'");
    expect(s).toContain(`--data-raw ${shellQuote(body)}`);
    // The body survives the shell intact.
    const m = /--data-raw (.*)$/m.exec(s)!;
    expect(sh(`printf '%s' ${m[1]}`)).toBe(body);
  });

  it('-X for other methods and for GET with a body; --head for HEAD; -g for glob characters', () => {
    expect(toSnippet({ method: 'DELETE', url: 'https://x.dev/a' }, 'curl')).toBe("curl https://x.dev/a \\\n  -X DELETE");
    expect(toSnippet({ method: 'PUT', url: 'https://x.dev/a', body: { text: 'x', encoding: 'utf8' } }, 'curl')).toContain('-X PUT');
    expect(toSnippet({ method: 'GET', url: 'https://x.dev/a', body: { text: 'x', encoding: 'utf8' } }, 'curl')).toContain('-X GET');
    expect(toSnippet({ method: 'HEAD', url: 'https://x.dev/a' }, 'curl')).toContain('--head');
    expect(toSnippet({ method: 'GET', url: 'https://x.dev/a?ids[]=1' }, 'curl')).toMatch(/ -g$/);
  });

  it('binary bodies become a commented placeholder, never inline bytes', () => {
    const s = toSnippet({ method: 'POST', url: 'https://x.dev/up', body: { text: Buffer.from([0, 1, 2, 255]).toString('base64'), encoding: 'base64' } }, 'curl');
    expect(s.split('\n')[0]).toBe('# Binary request body (4 bytes) not included: save it as body.bin next to this command.');
    expect(s).toContain('--data-binary @body.bin');
    expect(s).not.toContain('AAEC');
  });

  it('notes a truncated body', () => {
    expect(toSnippet({ method: 'POST', url: 'https://x.dev', body: { text: 'abc', encoding: 'utf8', truncated: true } }, 'curl')).toMatch(/^# Note: the request body was truncated/);
  });

  it('the whole command is valid shell (sh -n)', () => {
    const s = toSnippet(
      { method: 'PATCH', url: "https://x.dev/a'b", headers: { 'x-q': "it's \"q\"" }, body: { text: "line1\nit's\n$x", encoding: 'utf8' } },
      'curl',
    );
    execFileSync('/bin/sh', ['-n', '-c', s]);
  });
});

describe('Dart literals', () => {
  it('dartString escapes quotes, backslashes, $ and control characters', () => {
    expect(dartString("a'b\\c$d\ne\tf\x01")).toBe("'a\\'b\\\\c\\$d\\ne\\tf\\u{1}'");
  });

  it('dartBodyLiteral uses a raw multi-line string only when lossless', () => {
    expect(dartBodyLiteral('{"a":"$x \\n"}')).toBe(`r'''{"a":"$x \\n"}'''`);
    expect(dartBodyLiteral("ends with '")).toBe("'ends with \\''");
    expect(dartBodyLiteral("has ''' inside")).toBe("'has \\'\\'\\' inside'");
    expect(dartBodyLiteral('\nleading newline')).toBe("'\\nleading newline'");
    expect(dartBodyLiteral('cr\r\n')).toBe("'cr\\r\\n'");
  });
});

describe('dart_http', () => {
  it('GET uses http.get with a header map (multi-values joined, cookies with "; ")', () => {
    const s = toSnippet(
      { method: 'GET', url: 'https://x.dev/a?$b', headers: { accept: 'application/json', cookie: ['a=1', 'b=2'], 'x-multi': ['1', '2'], 'accept-encoding': 'gzip' } },
      'dart_http',
    );
    expect(s).toBe(
      [
        "import 'package:http/http.dart' as http;",
        '',
        'Future<void> main() async {',
        '  final response = await http.get(',
        "    Uri.parse('https://x.dev/a?\\$b'),",
        '    headers: {',
        "      'accept': 'application/json',",
        "      'cookie': 'a=1; b=2',",
        "      'x-multi': '1, 2',",
        '    },',
        '  );',
        "  print('${response.statusCode} ${response.body}');",
        '}',
      ].join('\n'),
    );
  });

  it('POST JSON body as a raw string', () => {
    const s = toSnippet({ method: 'POST', url: 'https://x.dev/u', headers: { 'content-type': 'application/json' }, body: { text: '{"a":1}', encoding: 'utf8' } }, 'dart_http');
    expect(s).toContain('await http.post(');
    expect(s).toContain(`    body: r'''{"a":1}''',`);
  });

  it('other methods (and GET with a body) use http.Request', () => {
    const s = toSnippet({ method: 'OPTIONS', url: 'https://x.dev/u', headers: { a: 'b' } }, 'dart_http');
    expect(s).toContain("final request = http.Request('OPTIONS', Uri.parse('https://x.dev/u'));");
    expect(s).toContain('request.headers.addAll({');
    expect(s).toContain('http.Response.fromStream(await request.send())');
    const g = toSnippet({ method: 'GET', url: 'https://x.dev/u', body: { text: 'q', encoding: 'utf8' } }, 'dart_http');
    expect(g).toContain("http.Request('GET'");
    expect(g).toContain("request.body = r'''q''';");
  });

  it('binary body placeholder', () => {
    const s = toSnippet({ method: 'PUT', url: 'https://x.dev/u', body: { text: 'AAEC', encoding: 'base64' } }, 'dart_http');
    expect(s).toContain('body: <int>[] /* binary request body (3 bytes) not included */,');
  });
});

describe('dio', () => {
  it('dio.request with method, headers, data, plain response, every status accepted', () => {
    const s = toSnippet(
      { method: 'post', url: 'https://x.dev/u', headers: { 'content-type': 'application/json', 'content-length': '7' }, body: { text: '{"a":1}', encoding: 'utf8' } },
      'dio',
    );
    expect(s).toBe(
      [
        "import 'package:dio/dio.dart';",
        '',
        'Future<void> main() async {',
        '  final dio = Dio();',
        '  final response = await dio.request<String>(',
        "    'https://x.dev/u',",
        `    data: r'''{"a":1}''',`,
        '    options: Options(',
        "      method: 'POST',",
        '      headers: {',
        "        'content-type': 'application/json',",
        '      },',
        '      responseType: ResponseType.plain,',
        '      validateStatus: (_) => true,',
        '    ),',
        '  );',
        "  print('${response.statusCode} ${response.data}');",
        '}',
      ].join('\n'),
    );
  });

  it('GET without body or headers', () => {
    const s = toSnippet({ method: 'GET', url: 'https://x.dev/u' }, 'dio');
    expect(s).not.toContain('data:');
    expect(s).not.toContain('headers:');
  });

  it('rejects an unknown format', () => {
    expect(() => toSnippet({ method: 'GET', url: 'https://x.dev' }, 'wget' as never)).toThrow(/unknown snippet format/);
  });
});
