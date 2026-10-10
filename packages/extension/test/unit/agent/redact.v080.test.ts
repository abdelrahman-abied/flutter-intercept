// CONTRACTS §14.6: multipart/form-data redaction for agents (text and binary-recorded bodies), HAR, redactExchange.
import { describe, expect, it } from 'vitest';
import type { Exchange } from '@flutter-intercept/proxy';
import { MAX_MULTIPART_BYTES, multipartBoundary, REDACTED, redactBody, redactBodyText, redactMultipart } from '../../../src/agent/redact';
import { buildHar } from '../../../src/agent/har';
import { redactExchange } from '../../../src/agent/samples';

const B = '----dart-http-boundary-7Xyz';
const CT = `multipart/form-data; boundary=${B}`;
const SECRET = ['hun', 'ter', '2-', 'pw'].join(''); // built at run time
const TOKEN = ['tok', 'en-', 'VALUE', '-123'].join('');
const JWT = ['eyJhbGciOiJIUzI1NiJ9', 'eyJzdWIiOiIxIn0', 'c2lnbmF0dXJlMTIz'].join('.');

function multipart(parts: { name: string; filename?: string; type?: string; value: string | Buffer; extra?: string }[], eol = '\r\n', close = true): Buffer {
  const chunks: Buffer[] = [];
  for (const p of parts) {
    let head = `--${B}${eol}Content-Disposition: form-data; name="${p.name}"${p.filename !== undefined ? `; filename="${p.filename}"` : ''}${eol}`;
    if (p.type) head += `Content-Type: ${p.type}${eol}`;
    if (p.extra) head += `${p.extra}${eol}`;
    chunks.push(Buffer.from(`${head}${eol}`, 'utf8'), Buffer.isBuffer(p.value) ? p.value : Buffer.from(p.value, 'utf8'), Buffer.from(eol));
  }
  if (close) chunks.push(Buffer.from(`--${B}--${eol}`));
  return Buffer.concat(chunks);
}

const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xff, 0xfe, 0x00, 0x01]);

describe('multipartBoundary', () => {
  it('quoted, unquoted, missing', () => {
    expect(multipartBoundary(CT)).toBe(B);
    expect(multipartBoundary('multipart/form-data; charset=utf-8; boundary="a b;c"')).toBe('a b;c');
    expect(multipartBoundary('multipart/form-data')).toBeUndefined();
    expect(multipartBoundary(`multipart/form-data; boundary=${'x'.repeat(71)}`)).toBeUndefined();
  });
});

describe('redactMultipart (CONTRACTS §14.6)', () => {
  const body = multipart([
    { name: 'username', value: 'alice' },
    { name: 'password', value: SECRET },
    { name: 'api_key', value: TOKEN },
    { name: 'avatar', filename: 'me.png', type: 'image/png', value: png },
    { name: 'meta', type: 'application/json', value: `{"session":"${TOKEN}","n":1}` },
    { name: 'note', value: `Bearer ${JWT}` },
    { name: 'blob', value: Buffer.from([0xff, 0xfe, 0xfd]) },
    { name: 'plain', value: 'hello world', extra: `X-Auth-Token: ${TOKEN}` },
  ]);

  it('redacts secret fields, summarises files and binary values, redacts JSON and credential values, keeps the rest', () => {
    const out = redactMultipart(body, CT)!;
    expect(out).toBeDefined();
    expect(out).not.toContain(SECRET);
    expect(out).not.toContain(TOKEN);
    expect(out).not.toContain(JWT);
    expect(out).toContain('name="username"\r\n\r\nalice\r\n');
    expect(out).toContain(`name="password"\r\n\r\n${REDACTED}\r\n`);
    expect(out).toContain(`name="api_key"\r\n\r\n${REDACTED}\r\n`);
    expect(out).toContain('filename="me.png"\r\nContent-Type: image/png\r\n\r\n[file me.png, 12 bytes]\r\n');
    expect(out).toContain(`{"session":"${REDACTED}","n":1}`);
    expect(out).toContain(`Bearer ${REDACTED}`);
    expect(out).toContain('[binary 3 bytes]');
    expect(out).toContain(`X-Auth-Token: ${REDACTED}`);
    expect(out).toContain('hello world');
    expect(out.endsWith(`--${B}--\r\n`)).toBe(true);
  });

  it('LF-only line endings, a preamble, quoted names with UTF-8, filename*=', () => {
    const lf = Buffer.concat([Buffer.from('preamble\n'), multipart([{ name: 'clé_token', value: SECRET }, { name: 'doc', filename: 'ignored.txt', value: 'x' }], '\n')]);
    const out = redactMultipart(lf, CT)!;
    expect(out).toContain(`name="clé_token"\r\n\r\n${REDACTED}`);
    expect(out).not.toContain(SECRET);
    expect(out).not.toContain('preamble');
    const ext = Buffer.from(`--${B}\r\nContent-Disposition: form-data; name="f"; filename*=UTF-8''r%C3%A9sum%C3%A9.pdf\r\n\r\n%PDF-1.4\r\n--${B}--\r\n`);
    expect(redactMultipart(ext, CT)).toContain('[file résumé.pdf, 8 bytes]');
  });

  it('a truncated body keeps the complete parts and says so', () => {
    const cut = multipart([{ name: 'a', value: 'one' }, { name: 'token', value: TOKEN }, { name: 'file', filename: 'big.bin', value: Buffer.alloc(100, 1) }], '\r\n', false).subarray(0, -40);
    const out = redactMultipart(cut, CT)!;
    expect(out).toContain('name="a"\r\n\r\none');
    expect(out).not.toContain(TOKEN);
    expect(out).toMatch(/\[truncated\]/);
  });

  it('gives up (undefined) without a boundary, a delimiter, or over 5 MB', () => {
    expect(redactMultipart(body, 'multipart/form-data')).toBeUndefined();
    expect(redactMultipart(Buffer.from('no parts here'), CT)).toBeUndefined();
    expect(redactMultipart(Buffer.alloc(MAX_MULTIPART_BYTES + 1), CT)).toBeUndefined();
    expect(redactMultipart(Buffer.from(`--${B}\r\nbroken header line\r\n\r\nx\r\n--${B}--\r\n`), CT)).toBeUndefined();
  });

  it('caps the number of parts', () => {
    const many = multipart(Array.from({ length: 1005 }, (_, i) => ({ name: `f${i}`, value: 'v' })));
    const out = redactMultipart(many, CT)!;
    expect(out).toContain('name="f999"');
    expect(out).not.toContain('name="f1000"');
    expect(out).toContain('[5 more parts]');
  });

  it('is linear on hostile input', () => {
    const hostile = Buffer.from(`--${B}\r\n` + `Content-Disposition: form-data; name="a"\r\n\r\n` + '-'.repeat(3_000_000));
    const t = Date.now();
    redactMultipart(hostile, CT);
    expect(Date.now() - t).toBeLessThan(2000);
  });
});

describe('redactBodyText / redactBody wiring', () => {
  it('a text multipart body goes through the parser; unparseable falls back to the text rules', () => {
    const text = multipart([{ name: 'password', value: SECRET }, { name: 'x', value: 'y' }]).toString('utf8');
    expect(redactBodyText(text, { 'Content-Type': CT })).toContain(`name="password"\r\n\r\n${REDACTED}`);
    expect(redactBodyText(`password=${SECRET} Bearer ${JWT}`, { 'content-type': CT })).not.toContain(JWT);
  });

  it('a binary-recorded multipart body becomes redacted text; other binary bodies stay as they are', () => {
    const raw = multipart([{ name: 'password', value: SECRET }, { name: 'pic', filename: 'a.png', type: 'image/png', value: png }]);
    const r = redactBody({ text: raw.toString('base64'), encoding: 'base64' }, { 'content-type': CT });
    expect(r.encoding).toBe('utf8');
    expect(r.text).toContain(REDACTED);
    expect(r.text).toContain('[file a.png, 12 bytes]');
    expect(r.text).not.toContain(SECRET);
    const img = { text: png.toString('base64'), encoding: 'base64' as const };
    expect(redactBody(img, { 'content-type': 'image/png' })).toBe(img);
    expect(redactBody({ text: '{"token":"x"}', encoding: 'utf8' }, { 'content-type': 'application/json' }).text).toBe(`{"token":"${REDACTED}"}`);
  });

  it('HAR and redactExchange use it', () => {
    const raw = multipart([{ name: 'password', value: SECRET }, { name: 'pic', filename: 'a.png', type: 'image/png', value: png }]);
    const e: Exchange = {
      id: 'm1',
      startedAt: 1,
      method: 'POST',
      url: 'https://api.example.com/upload',
      requestHeaders: { 'content-type': CT },
      requestBody: { text: raw.toString('base64'), encoding: 'base64' },
      state: 'completed',
      status: 201,
    };
    const har = JSON.stringify(buildHar([e], { redact: true, creatorVersion: 't' }));
    expect(har).not.toContain(SECRET);
    expect(har).not.toContain(raw.toString('base64'));
    expect(har).toContain('[file a.png, 12 bytes]');
    const keep = JSON.stringify(buildHar([e], { redact: false, creatorVersion: 't' }));
    expect(keep).toContain(raw.toString('base64'));
    expect(keep).toContain('"encoding":"base64"');
    const red = redactExchange(e);
    expect(red.requestBody?.encoding).toBe('utf8');
    expect(red.requestBody?.text).not.toContain(SECRET);
  });
});
