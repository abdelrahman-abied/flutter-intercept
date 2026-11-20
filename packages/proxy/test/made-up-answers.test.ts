// REVIEW-16 #14 / #15a / #15b: what a made-up answer (mock, script `respond`, stateful mock) may send, and notes / errors
// on one line. The exchange records what reached the wire: never a 500 from Node recorded as a mocked 200.
import * as net from 'net';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Exchange, InterceptProxy, Rule } from '../src';
import { answerStatusProblem, encodeExtValues, prepareAnswerHeaders } from '../src/answer-headers';
import { clipNote, flattenLine } from '../src/proxy-util';
import { notesOf, settled, startProxy, startUpstream, viaProxy, type Upstream } from './helpers';

let up: Upstream;
let proxy: InterceptProxy;

beforeAll(async () => {
  up = await startUpstream();
});
afterAll(async () => {
  await up?.close();
});
beforeEach(async () => {
  proxy = await startProxy();
  up.hits.length = 0;
});
afterEach(async () => {
  await proxy?.stop();
});

const handlerRule: Rule = { id: 'r1', enabled: true, match: { url: '*/h/*' }, action: { kind: 'handler', handlerId: 'h', timeoutMs: 2000 } };
const mockRule = (status: number, headers: Record<string, string>, body = 'x'): Rule => ({
  id: 'm1',
  name: 'my-mock',
  enabled: true,
  match: { url: '*/m/*' },
  action: { kind: 'mock', status, headers, body },
});
const scriptRule = (code: string): Rule => ({ id: 's1', name: 'my-script', enabled: true, match: { url: '*/s/*' }, action: { kind: 'script', code } });

async function done(urlPart: string): Promise<Exchange> {
  const all = await settled(proxy);
  const ex = [...all].reverse().find((e) => e.url.includes(urlPart));
  if (!ex) throw new Error(`no exchange for ${urlPart}`);
  return ex;
}

/** The raw response bytes for a plain-HTTP request through the proxy (what the app's socket really gets). */
function raw(path: string, timeoutMs = 3000): Promise<string> {
  return new Promise((resolve) => {
    const s = net.connect(proxy.port, '127.0.0.1');
    let out = '';
    s.on('data', (d) => (out += d.toString('latin1')));
    s.on('close', () => resolve(out));
    s.on('error', () => resolve(out));
    s.write(`GET http://h.test${path} HTTP/1.1\r\nHost: h.test\r\nConnection: close\r\n\r\n`);
    setTimeout(() => {
      s.destroy();
      resolve(`${out}\n[timeout]`);
    }, timeoutMs).unref();
  });
}

describe('made-up answers: header values Node would refuse (REVIEW-16 #14)', () => {
  it("the reviewer's handler answers (\\x01, Ā, Arabic) → 502 naming the header, recorded as sent", async () => {
    proxy.setRules([handlerRule]);
    const cases: [string, string][] = [
      ['ctl-x01', 'a\x01b'],
      ['unicode', 'Ā '],
      ['arabic', 'مرحبا'],
      ['del', 'a\x7fb'],
    ];
    for (const [name, value] of cases) {
      proxy.setHandler('h', () => ({ status: 200, headers: { 'x-a': value }, body: 'x' }));
      const out = await raw(`/h/${name}`);
      expect(out, name).toMatch(/^HTTP\/1\.1 502 Bad Gateway\r\n/);
      expect(out, name).not.toMatch(/500|ERR_INVALID_CHAR/);
      expect(out).toContain(`Flutter Intercept: Handler r1: answer header "x-a" has characters HTTP can't send`);
      const ex = await done(`/h/${name}`);
      expect(ex).toMatchObject({ state: 'error', status: 502 });
      expect(ex.error).toBe(`Handler r1: answer header "x-a" has characters HTTP can't send (outside Latin-1, or control characters)`);
    }
    // Latin-1 is what Node sends: still answered
    proxy.setHandler('h', () => ({ status: 200, headers: { 'x-a': 'café' }, body: 'x' }));
    const ok = await viaProxy(proxy.port, 'http://h.test/h/latin1');
    expect(ok.status).toBe(200);
    expect(Buffer.from(ok.headers['x-a'] as string, 'latin1').toString('latin1')).toBe('café');
    expect(await done('/h/latin1')).toMatchObject({ state: 'mocked', status: 200 });
  });

  it('a mock rule (0.15) and a script respond with x-message: مرحبا → 502, not a hidden 500 recorded as a mocked 200', async () => {
    proxy.setRules([
      mockRule(200, { 'content-type': 'application/json', 'x-message': 'مرحبا' }, '{}'),
      scriptRule(`function onRequest() { return { response: { status: 200, headers: { 'x-message': 'مرحبا' }, body: 'x' } }; }`),
    ]);
    const m = await viaProxy(proxy.port, 'http://h.test/m/1');
    expect(m.status).toBe(502);
    expect(m.text).toBe(`Flutter Intercept: Mock my-mock: answer header "x-message" has characters HTTP can't send (outside Latin-1, or control characters)`);
    expect(await done('/m/1')).toMatchObject({ state: 'error', status: 502, error: m.text.replace('Flutter Intercept: ', '') });

    const s = await viaProxy(proxy.port, 'http://h.test/s/1');
    expect(s.status).toBe(502);
    const ex = await done('/s/1');
    expect(ex).toMatchObject({ state: 'error', status: 502 });
    expect(ex.error).toMatch(/^Script my-script: response header "x-message" has characters HTTP can't send/);
    expect(ex.scriptLog?.at(-1)).toBe(ex.error);
    expect(up.hits).toEqual([]);
  });

  it('content-disposition / link with non-Latin-1 parameters are sent RFC 8187-encoded, with a note, and recorded so', async () => {
    proxy.setRules([
      mockRule(200, { 'content-disposition': 'attachment; filename="تقرير 1.pdf"', link: '<https://a.test/p2>; rel="next"; title="الصفحة 2"' }),
    ]);
    const r = await viaProxy(proxy.port, 'http://h.test/m/2');
    expect(r.status).toBe(200);
    expect(r.headers['content-disposition']).toBe("attachment; filename*=UTF-8''%D8%AA%D9%82%D8%B1%D9%8A%D8%B1%201.pdf");
    expect(r.headers.link).toBe("<https://a.test/p2>; rel=\"next\"; title*=UTF-8''%D8%A7%D9%84%D8%B5%D9%81%D8%AD%D8%A9%202");
    const ex = await done('/m/2');
    expect(ex.state).toBe('mocked');
    expect(ex.responseHeaders?.['content-disposition']).toBe(r.headers['content-disposition']);
    expect(ex.responseHeaders?.link).toBe(r.headers.link);
    expect(notesOf(ex)).toContain('Encoded non-Latin-1 text in content-disposition, link as RFC 8187');
    // a parameterised header whose non-Latin-1 text isn't in a parameter is refused like any other
    proxy.setRules([mockRule(200, { link: '<https://a.test/مرحبا>; rel="next"' })]);
    expect((await viaProxy(proxy.port, 'http://h.test/m/3')).status).toBe(502);
    expect((await done('/m/3')).error).toMatch(/header "link" has characters HTTP can't send/);
  });

  it('encodeExtValues / prepareAnswerHeaders', () => {
    expect(encodeExtValues('attachment; filename="é ملف.txt"')).toBe("attachment; filename*=UTF-8''%C3%A9%20%D9%85%D9%84%D9%81.txt");
    expect(encodeExtValues('inline; filename=ملف')).toBe("inline; filename*=UTF-8''%D9%85%D9%84%D9%81");
    // a `name*` already there wins: the plain one is left out
    expect(encodeExtValues("attachment; filename=\"ملف\"; filename*=UTF-8''%D9%85")).toBe("attachment; filename*=UTF-8''%D9%85");
    // a `name*` written with raw characters is percent-encoded when it says UTF-8, refused otherwise
    expect(encodeExtValues("attachment; filename*=UTF-8'ar'ملف")).toBe("attachment; filename*=UTF-8'ar'%D9%85%D9%84%D9%81");
    expect(encodeExtValues("attachment; filename*=ISO-8859-1''ملف")).toBeUndefined();
    expect(encodeExtValues('مرفق; filename="a"')).toBeUndefined();
    // quoted `;` / `,` don't split
    expect(encodeExtValues('attachment; filename="a;b,ملف"')).toBe("attachment; filename*=UTF-8''a%3Bb%2C%D9%85%D9%84%D9%81");

    const h: Record<string, string | string[]> = { 'Content-Type': 'text/plain', 'x-many': ['a', 'b'], 'Content-Disposition': 'attachment; filename="ü-ā"' };
    expect(prepareAnswerHeaders(h)).toEqual({ dropped: [], encoded: ['content-disposition'] });
    expect(h['Content-Disposition']).toBe("attachment; filename*=UTF-8''%C3%BC-%C4%81");
    expect(() => prepareAnswerHeaders({ 'x-a': ['ok', 'ā'] })).toThrow(/header "x-a" has characters/);
    expect(() => prepareAnswerHeaders({ 'bad name': 'x' })).toThrow(/header name "bad name" is not a valid/);
    expect(() => prepareAnswerHeaders({ 'content-disposition': 'attachment; filename="a\x01b"' })).not.toThrow(); // encoded
    expect(() => prepareAnswerHeaders({ 'content-disposition': 'attachment; filename="a\r\nb"' })).toThrow();
  });
});

describe('made-up answers: final statuses and connection headers (REVIEW-16 #15a)', () => {
  it('1xx statuses → 502 for a handler, a mock and a script respond (never sent as the answer)', async () => {
    proxy.setRules([handlerRule, mockRule(101, { connection: 'upgrade', upgrade: 'websocket' }), scriptRule(`function onRequest() { return { response: { status: 100 } }; }`)]);
    for (const status of [100, 101, 103]) {
      proxy.setHandler('h', () => ({ status, headers: { connection: 'upgrade', upgrade: 'websocket' }, body: 'x' }));
      const out = await raw(`/h/${status}`);
      expect(out).toMatch(/^HTTP\/1\.1 502 Bad Gateway\r\n/);
      expect(out).not.toContain('[timeout]'); // the socket isn't held
      expect((await done(`/h/${status}`)).error).toBe(`Handler r1: answer status ${status} is informational (1xx); a made-up answer must have a final status, 200–599`);
    }
    const m = await raw('/m/1');
    expect(m).toMatch(/^HTTP\/1\.1 502 Bad Gateway\r\n/);
    expect(await done('/m/1')).toMatchObject({ state: 'error', status: 502, error: expect.stringMatching(/^Mock my-mock: answer status 101 is informational/) });
    expect((await raw('/s/1'))).toMatch(/^HTTP\/1\.1 502 Bad Gateway\r\n/);
    expect((await done('/s/1')).error).toMatch(/^Script my-script: response status 100 is informational/);
    expect(answerStatusProblem(200)).toBeUndefined();
    expect(answerStatusProblem(599)).toBeUndefined();
  });

  it('hop-by-hop headers are left out with a note; the answer arrives and the connection is not held', async () => {
    proxy.setRules([handlerRule]);
    proxy.setHandler('h', () => ({
      status: 200,
      headers: {
        connection: 'upgrade',
        upgrade: 'websocket',
        'keep-alive': 'timeout=1',
        'Proxy-Authenticate': 'Basic',
        'proxy-connection': 'keep-alive',
        te: 'trailers',
        trailer: 'x-t',
        'transfer-encoding': 'chunked',
        'x-kept': '1',
      },
      body: 'hello',
    }));
    const out = await raw('/h/conn');
    expect(out).not.toContain('[timeout]');
    const head = out.split('\r\n\r\n')[0].toLowerCase();
    expect(head).toContain('x-kept: 1');
    for (const name of ['connection: upgrade', 'upgrade:', 'keep-alive:', 'proxy-authenticate:', 'proxy-connection:', 'te:', 'trailer:', 'transfer-encoding:']) {
      expect(head).not.toContain(`\r\n${name}`);
    }
    expect(out.endsWith('hello')).toBe(true);
    const ex = await done('/h/conn');
    expect(ex.state).toBe('mocked');
    expect(Object.keys(ex.responseHeaders ?? {}).sort()).toEqual(['content-length', 'x-kept']);
    expect(notesOf(ex)).toBe(
      "Left out connection headers a made-up answer can't send: connection, upgrade, keep-alive, proxy-authenticate, proxy-connection, te, trailer, transfer-encoding.",
    );
  });

  it('a 204 / 304 answer is sent and recorded without a body or content-length', async () => {
    proxy.setRules([handlerRule]);
    proxy.setHandler('h', () => ({ status: 204, body: 'should-not-be-here' }));
    const out = await raw('/h/204');
    expect(out).toBe('HTTP/1.1 204 No Content\r\n\r\n');
    const ex = await done('/h/204');
    expect(ex).toMatchObject({ state: 'mocked', status: 204 });
    expect(ex.responseHeaders?.['content-length']).toBeUndefined();
    expect(ex.responseBody?.text ?? '').toBe('');
    expect(notesOf(ex)).toContain('A 204 answer has no body; its body was left out.');
  });
});

describe('notes and errors are one line (REVIEW-16 #15b)', () => {
  const nasty = 'a\r\nb\u0085c\u2028d\u2029e\x01f\x7fg\u202eh\u2066i\u2069j\u200fk\tl';

  it('flattenLine / clipNote: every control character becomes a space; bidi controls go', () => {
    expect(flattenLine(nasty)).toBe('a b c d e f ghijk l');
    expect(clipNote(` ${nasty} `)).toBe('a b c d e f ghijk l');
    expect(flattenLine('plain text, kept  as is')).toBe('plain text, kept  as is');
  });

  it("a handler's note and error are flattened the same way, on the wire and in the record", async () => {
    proxy.setRules([handlerRule]);
    proxy.setHandler('h', () => ({ status: 200, body: 'x', note: nasty }));
    expect((await viaProxy(proxy.port, 'http://h.test/h/note')).status).toBe(200);
    expect((await done('/h/note')).notes).toEqual(['a b c d e f ghijk l']);

    proxy.setHandler('h', () => {
      throw new Error(nasty);
    });
    const r = await viaProxy(proxy.port, 'http://h.test/h/error');
    expect(r.status).toBe(502);
    expect(r.text).toBe('Flutter Intercept: Handler r1: a b c d e f ghijk l');
    expect((await done('/h/error')).error).toBe('Handler r1: a b c d e f ghijk l');
  });

  it('a script error with control and bidi characters is recorded on one line', async () => {
    proxy.setRules([scriptRule(`function onRequest() { throw new Error(${JSON.stringify(nasty)}); }`)]);
    const r = await viaProxy(proxy.port, 'http://h.test/s/err');
    expect(r.status).toBe(502);
    const ex = await done('/s/err');
    expect(ex.error).not.toMatch(/[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069\u200f]/);
    expect(ex.error).toContain('a b c d e f ghijk l');
    expect(r.text).toBe(`Flutter Intercept: ${ex.error}`);
  });
});
