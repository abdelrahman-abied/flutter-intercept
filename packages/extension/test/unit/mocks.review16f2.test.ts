// REVIEW-16 fix round F2: one secret check (`mocks/secrets.ts`) for snapshots, the fake backend from traffic, Update
// example, the copy without credentials, the store and (where it was narrower) the agent redaction; unreadable JSON
// (#3), the sign-in / store interplay (#4), snapshots (#5), traffic shapes (#6), the linear JWT regex (#7), personal
// data (#11), large sessions (#12) and the INFO items (#15). Each case uses the reviewer's inputs; planted values never
// appear in what is written.
import { describe, expect, it, vi } from 'vitest';
import type { Exchange, RequestHandler, Rule } from '@flutter-intercept/proxy';
import { compileRules, findRule } from '@flutter-intercept/proxy/rules';
import { isSensitiveField, isSensitiveHeader, redactBodyText, redactSecretValues } from '../../src/agent/redact';
import { redactRecord } from '../../src/agent/tools/store';
import { AuthSessions, jwtClaims } from '../../src/mocks/auth';
import { MockCollectionsCore } from '../../src/mocks/core';
import { collectionFromTraffic, TrafficSanitiser } from '../../src/mocks/fromTraffic';
import { collectionParsers } from '../../src/mocks/parsers';
import { SANITISE_TOO_LARGE, sanitisePostman } from '../../src/mocks/sanitise';
import {
  isCredentialValue,
  isSecretHeaderName,
  isSecretName,
  JWT_ANY,
  safeNameLabel,
  scrubNamedText,
  scrubSecretText,
  withoutSecretFields,
} from '../../src/mocks/secrets';
import { snapshotText } from '../../src/mocks/snapshot';
import type { StoreSnapshot } from '../../src/mocks/types';
import { SharedRulesCore } from '../../src/rules/core';
import { FakeFs, FakeMemento, FILE, fakeValidateRule, ROOT } from './rules.fakes';

vi.mock('vscode', () => ({}));

let seq = 0;
function ex(method: string, url: string, o: { reqH?: Record<string, string | string[]>; reqB?: string; resH?: Record<string, string | string[]>; resB?: string; status?: number } = {}): Exchange {
  seq++;
  return {
    id: `x${seq}`,
    startedAt: 1000 + seq,
    method,
    url,
    state: 'completed',
    status: o.status ?? 200,
    requestHeaders: o.reqH ?? {},
    ...(o.reqB !== undefined ? { requestBody: { text: o.reqB, encoding: 'utf8' as const } } : {}),
    responseHeaders: { 'content-type': 'application/json', ...(o.resH ?? {}) },
    ...(o.resB !== undefined ? { responseBody: { text: o.resB, encoding: 'utf8' as const } } : {}),
  } as Exchange;
}
const holds = (text: string, v: string) => [v, encodeURIComponent(v), JSON.stringify(v).slice(1, -1)].some((f) => text.includes(f));
const none = (what: string, text: string, planted: string[]) => {
  for (const p of planted) expect(holds(text, p), `${what} holds ${p}`).toBe(false);
};

// ------------------------------------------------------------------------------------------------ the shared check

describe('isSecretName: one check, at least as wide as the agent redaction', () => {
  it('names the four old checks disagreed on (plurals, run-together lower case, variants)', () => {
    const secret = [
      // REVIEW-16 #5 (B/redact.ts)
      'passWord', 'PassWord', 'newpassword', 'userpassword', 'passwordhash', 'passCode', 'pass', 'passphrase', 'accesstoken',
      'authtoken', 'refreshtoken', 'secretkey', 'clientsecret', 'sessiontoken', 'bearer', 'jwt', 'idtoken', 'accessKeyId',
      'awsSecret', 'mnemonic', 'privKey', 'securityCode', 'cvv2', 'ssnLast4', 'pass_word', 'userPass',
      // REVIEW-16 #6 (C/leak.ts)
      'passwords', 'tokens', 'secrets', 'apiKeys', 'apikeys', 'credentials', 'sid', 'verificationCode', 'verification_code',
      'otp', 'otpCode', 'smsCode', 'csrf', 'xsrfToken', 'hmac', 'nonce', 'connect.sid', 'PHPSESSID', 'jsessionid', 'session',
      // the old lists still hold
      'password', 'passwd', 'pwd', 'secret', 'token', 'apiKey', 'api_key', 'authorization', 'auth', 'credential', 'cookie',
      'privateKey', 'pin', 'cardPin', 'sessionId', 'session_key', 'signature', 'ssn', 'cvv', 'cvc', 'cardNumber',
    ];
    for (const n of secret) expect(isSecretName(n), n).toBe(true);
    // headers: the copy's conventions too
    for (const h of ['X-Access-Key', 'X-Request-Sig', 'X-Csrf', 'Ocp-Apim-Subscription-Key', 'X-Signature', 'Set-Cookie', 'X-Api-Key']) {
      expect(isSecretHeaderName(h), h).toBe(true);
      expect(isSensitiveHeader(h), `agent ${h}`).toBe(true);
    }
  });

  it('keeps the false positives the word rule was built for (author, sessionCount, tokenizer …)', () => {
    const plain = [
      'author', 'authored', 'authorId', 'authority', 'sessionCount', 'sessionStart', 'pinned', 'tokenizer', 'passenger',
      'passport', 'compass', 'secretary', 'keyboard', 'opinion', 'spinner', 'code', 'countryCode', 'productCode', 'apiVersion',
      'cardHolder', 'privateNote', 'name', 'email',
    ];
    for (const n of plain) expect(isSecretName(n), n).toBe(false);
    for (const h of ['Content-Type', 'X-Api-Version', 'Accept', 'X-Request-Id']) expect(isSecretHeaderName(h), h).toBe(false);
  });

  it('the agent redaction is widened where it was narrower (never narrower than the shared check)', () => {
    for (const n of ['pin', 'otp', 'sid', 'verificationCode', 'csrf', 'ssn', 'cvv', 'signature', 'cookie', 'hmac', 'jwt']) {
      expect(isSensitiveField(n), n).toBe(true);
    }
    // values: `Token <key>` and well-known key prefixes
    expect(redactSecretValues('Token sk_live_51HxPlanted01')).toBe('Token [redacted]');
    expect(redactSecretValues('sk_live_51Hx0aB2cD3eF', true)).toBe('[redacted]');
    expect(redactSecretValues('xoxb-1234-5678-abcdefgh', true)).toBe('[redacted]');
    expect(redactSecretValues('basic information about our basic plan')).toBe('basic information about our basic plan');
  });

  it('values: JWT, scheme credentials, opaque / prefixed tokens, PEM keys, URL credentials (absolute and relative)', () => {
    for (const v of [
      'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.sig',
      'Bearer abcdefghijklmnop1234',
      'Token sk_live_51HxPlanted01',
      'sk_live_51Hx0aB2cD3eF',
      'AKIAIOSFODNN7EXAMPLE',
      'ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123',
      '-----BEGIN ' + 'PRIVATE KEY-----\nMIIEvQ\n-----END ' + 'PRIVATE KEY-----',
    ]) {
      expect(isCredentialValue(v), v).toBe(true);
    }
    for (const v of ['hello world', 'da39a3ee5e6b4b0d3255bfef95601890afd80709', '550e8400-e29b-41d4-a716-446655440000', 'ASIAPACIFIC']) {
      expect(isCredentialValue(v), v).toBe(false);
    }
    expect(scrubSecretText('/files/1?sig=relsig0value&se=2030')).toBe('/files/1?sig=&se=2030');
    expect(scrubSecretText('see https://deploy:p4ssw0rd@git.example.com/r?token=Zx9K&page=2')).toBe('see https://git.example.com/r?token=&page=2');
    expect(scrubSecretText('https://cdn.example/a.png?X-Amz-Signature=abc&hmac=hmacvalue1234&w=1')).toBe('https://cdn.example/a.png?X-Amz-Signature=&hmac=&w=1');
  });

  it('names inside text that is not JSON: pairs, name=value, XML elements, HTML inputs', () => {
    expect(scrubNamedText('{"password":"hunter2pass","refresh_token":"rt-short-123","v":NaN}')).toBe('{"password":"","refresh_token":"","v":NaN}');
    expect(scrubNamedText('user=a pass=hunter2pass')).toBe('user=a pass=');
    expect(scrubNamedText('token: PlainTextTokenValue123\nsecret=db-pass-1234')).toBe('token: \nsecret=');
    expect(scrubNamedText('<r><token>xmlTOKENvalue99</token><session>PlainTextTokenValue123</session><name>Ada</name></r>')).toBe('<r><token></token><session></session><name>Ada</name></r>');
    expect(scrubNamedText('<input type=hidden name="csrf_token" value="rt-short-123">')).toBe('<input type=hidden name="csrf_token" value="">');
    expect(scrubNamedText('author=Ada sessionCount=3 tokenizer=bpe')).toBe('author=Ada sessionCount=3 tokenizer=bpe');
  });

  it('labels: a key that is itself personal data or a credential shows as a kind', () => {
    expect(safeNameLabel('jane.doe@corp-mail.sa')).toBe('a key that is an e-mail address');
    expect(safeNameLabel('+966501234567')).toBe('a key that is a number');
    expect(safeNameLabel('password')).toBe('password');
  });
});

// ------------------------------------------------------------------------------------------------ #7 linear JWT regex

describe('#7: the JWT regex is linear (the reviewer’s hostile body)', () => {
  const hostile = 'eyJa-'.repeat(Math.floor((1024 * 1024) / 5)); // 1 MB
  it('1 MB of eyJa- in ≤ 50 ms (shared regex, agent redaction, traffic sanitiser)', () => {
    const time = (f: () => unknown) => {
      const t = performance.now();
      f();
      return performance.now() - t;
    };
    // warm up the regex compilation
    'eyJa-'.repeat(10).replace(JWT_ANY, '');
    expect(time(() => hostile.replace(JWT_ANY, ''))).toBeLessThanOrEqual(50);
    expect(time(() => redactSecretValues(hostile))).toBeLessThanOrEqual(50);
    expect(time(() => new TrafficSanitiser(true).text(hostile))).toBeLessThanOrEqual(50);
  });

  it('the whole pipeline stays fast on it (text and JSON string, response and agent views)', () => {
    const t = performance.now();
    collectionFromTraffic([ex('GET', 'https://api.example.com/a', { resH: { 'content-type': 'text/plain' }, resB: hostile })], { name: 'x' });
    collectionFromTraffic([ex('GET', 'https://api.example.com/b', { resB: JSON.stringify({ v: hostile }) })], { name: 'x' });
    redactBodyText(hostile, { 'content-type': 'text/plain' });
    expect(performance.now() - t).toBeLessThan(2000);
  });

  it('a JWT glued to a preceding "-" is no longer found inside text (the opaque rule takes a whole value)', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2lnbmF0dXJlMTIz';
    expect(`see ${jwt} here`.replace(JWT_ANY, 'J')).toBe('see J here');
    expect(`x-${jwt}`.replace(JWT_ANY, 'J')).toBe(`x-${jwt}`);
  });

  it('the other text patterns are linear on hostile 1 MB inputs too', () => {
    const MB = 1024 * 1024;
    for (const unit of ['a=', 'a=a ', '"a":', '<a>', '/a?', '"', 'ghp_', 'sk-', 'Token ', 'http://', '?a=&', 'x@y.', 'eyJaaaa.bbbb', '-----BEGIN ' + 'PRIVATE KEY-----', '<input name=token value=']) {
      const s = unit.repeat(Math.floor(MB / unit.length));
      const t = performance.now();
      scrubNamedText(scrubSecretText(s));
      new TrafficSanitiser(true).responseBody(s, true);
      expect(performance.now() - t, unit).toBeLessThan(1500);
    }
  });
});

// ------------------------------------------------------------------------------------------------ #3 unreadable JSON

describe('#3: a JSON body the strict rewriter can’t read keeps its name-based redaction', () => {
  const SECRET = '{"password":"hunter2pass","refresh_token":"rt-short-123","sessionId":"sess9"}';
  const PLANTED = ['hunter2pass', 'rt-short-123', 'sess9'];
  const cases: Record<string, [string, string]> = {
    bom: ['application/json', `﻿${SECRET}`],
    xssi: ['application/json', `)]}',\n${SECRET}`],
    whileGuard: ['application/json', `while(1);${SECRET}`],
    ndjson: ['application/x-ndjson', `${SECRET}\n${SECRET}`],
    jsonp: ['application/javascript', `cb(${SECRET});`],
    deep: ['application/json', `{"password":"hunter2pass","refresh_token":"rt-short-123","x":${'['.repeat(300)}${']'.repeat(300)}}`],
    nan: ['application/json', '{"password":"hunter2pass","refresh_token":"rt-short-123","v":NaN}'],
    html: ['text/html', '<input type=hidden name="csrf_token" value="rt-short-123"><script>var password="hunter2pass"</script>'],
  };
  for (const [name, [ct, body]] of Object.entries(cases)) {
    it(`response: ${name}`, () => {
      const r = collectionFromTraffic([ex('GET', `https://api.example.com/${name}`, { resH: { 'content-type': ct }, resB: body })], { name: 'fb' });
      none(name, r.text, PLANTED);
    });
  }

  it('the BOM / XSSI prefix is kept in front of the rewritten JSON; NDJSON stays one value per line', () => {
    const s = new TrafficSanitiser(true);
    expect(s.responseBody(`﻿${SECRET}`, true).charCodeAt(0)).toBe(0xfeff);
    expect(s.responseBody(`)]}',\n${SECRET}`, true).startsWith(")]}',\n{")).toBe(true);
    expect(s.readBody(`${SECRET}\n${SECRET}\n`, false, true)).toEqual({ kind: 'ndjson', text: '{"password":"","refresh_token":"","sessionId":""}\n{"password":"","refresh_token":"","sessionId":""}\n' });
    expect(s.readBody(`cb(${SECRET});`, false, false)).toEqual({ kind: 'jsonp', text: 'cb({"password":"","refresh_token":"","sessionId":""});' });
  });

  it('a not-quite-JSON body with a secret-named object is left out, with a skipped line', () => {
    const r = collectionFromTraffic(
      [ex('GET', 'https://api.example.com/a', { resB: '{"tokens":{"fcm":"fcm_abc_ZZZ_short1"},"v":NaN}' })],
      { name: 'x' },
    );
    none('dropped', r.text, ['fcm_abc_ZZZ_short1']);
    expect(r.skipped).toEqual(["1 body that wasn't plain JSON left out (secret-named values in it)"]);
  });

  it('request side: BOM, XSSI-like and NaN request bodies', () => {
    for (const reqB of [`﻿{"username":"a","password":"hunter2pass"}`, '{"password":"hunter2pass","n":NaN}', `{"password":"hunter2pass"}\n{"password":"hunter2pass"}`]) {
      const r = collectionFromTraffic([ex('POST', 'https://api.example.com/login', { reqH: { 'content-type': 'application/json' }, reqB, resB: '{}' })], { name: 'fb' });
      none('request', r.text, ['hunter2pass']);
    }
  });

  it('the copy without credentials reads a raw body with a BOM', () => {
    const doc = { info: { name: 'c' }, item: [{ name: 'x', request: { method: 'POST', url: 'https://a.example/x', body: { mode: 'raw', raw: '﻿{"password":"hunter2pass"}' } } }] };
    expect(JSON.stringify(sanitisePostman(doc).doc)).not.toContain('hunter2pass');
  });
});

// ------------------------------------------------------------------------------------------------ #5 snapshots

describe('#5: snapshot redaction is as wide as the agent’s, and wider on values', () => {
  const rec: Record<string, unknown> = {
    id: 1,
    passWord: 'Hunter2!', newpassword: 'Hunter2!', userpassword: 'Hunter2!', passwordhash: '$2b$10$abc', passCode: '123456', pass: 'Hunter2!',
    passphrase: 'correct horse', accesstoken: 'abc123def', authtoken: 'abc123def', refreshtoken: 'r-abc123', secretkey: 'abc123',
    clientsecret: 'abc123', sessiontoken: 'abc', idtoken: 'x1',
    databaseUrl: 'postgres://admin:S3cretPass@db.internal:5432/app',
    avatarUrl: 'https://bucket.s3.amazonaws.com/a.png?X-Amz-Credential=AKIAIOSFODNN7EXAMPLE%2F20261120&X-Amz-Signature=0123456789abcdef',
    link: 'https://api.example.com/reset?token=Zx9Kq2Lm8Np4Rs6T',
    basicUrl: 'https://deploy:p4ssw0rd@git.example.com/repo.git',
    stripe: 'sk_live_51Hx0aB2cD3eF', slack: 'xoxb-1234-5678-abcdefgh', aws: 'AKIAIOSFODNN7EXAMPLE',
    nested: { payload: '{"access_token":"tok_plain_v4lue"}' },
    // kept on purpose
    author: 'Sara', sessionCount: 4, pinned: true, tokenizer: 'bpe',
  };
  const PLANTED = ['Hunter2!', '$2b$10$abc', '123456', 'correct horse', 'abc123def', 'r-abc123', 'abc123', 'S3cretPass', 'p4ssw0rd', 'Zx9Kq2Lm8Np4Rs6T', '0123456789abcdef', 'AKIAIOSFODNN7EXAMPLE', 'sk_live_51Hx0aB2cD3eF', 'xoxb-1234-5678-abcdefgh', 'tok_plain_v4lue'];

  it('every value an agent never sees is blanked in the file; look-alikes stay', () => {
    const dump: StoreSnapshot = { version: 1, collection: 'c', savedAt: '', resources: { users: [{ records: [rec] }] } };
    const { text } = snapshotText(dump);
    none('snapshot', text, PLANTED);
    const out = JSON.parse(text).resources.users[0].records[0];
    expect(out).toMatchObject({ id: 1, author: 'Sara', sessionCount: 4, pinned: true, tokenizer: 'bpe' });
    expect(out.databaseUrl).toBe('postgres://db.internal:5432/app');
    expect(out.link).toBe('https://api.example.com/reset?token=');
    // nothing the agent's view hides is kept by the snapshot
    const agent = redactRecord(rec) as Record<string, unknown>;
    for (const k of Object.keys(rec)) if (agent[k] !== rec[k] && !['author', 'sessionCount', 'tokenizer'].includes(k)) expect(out[k], k).not.toEqual(rec[k]);
  });

  it('scope values go through the value redaction (#15c); a key that is an e-mail is not echoed in blanked', () => {
    const dump: StoreSnapshot = {
      version: 1,
      collection: 'c',
      savedAt: '',
      resources: { orders: [{ scope: { userId: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2lnbmF0dXJl' }, records: [{ id: 1, byEmail: { 'jane.doe@corp-mail.sa': { token: 'x' } } }] }] },
    };
    const { text, blanked } = snapshotText(dump);
    expect(text).not.toContain('eyJhbGciOiJIUzI1NiJ9');
    expect(blanked).toContain('orders.scope.userId');
    expect(JSON.stringify(blanked)).not.toContain('jane.doe');
  });
});

// ------------------------------------------------------------------------------------------------ #6 / #11 traffic shapes

describe('#6 / #11: the traffic sanitiser catches the reviewer’s shapes', () => {
  const OPAQ = 'sk_live_51HxPlanted01';
  const JWT = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMiLCJlbWFpbCI6ImFAYi5jb20ifQ.sig_abcDEF123';
  const P = {
    hunter: 'hunter2pass', otp: '482913', sid: 's%3AQx9aZ1', innerTok: 'tok_plain_v4lue', email: 'jane.doe@corp-mail.sa',
    phone: '966501234567', phonePlus: '+966501234567', relSig: 'relsig0value', awsKeyId: 'AKIAIOSFODNN7EXAMPLE',
    magic: 'Xk9pQ2mZrT', devTok: 'fcm_abc_ZZZ_short1', passphrase: 'correct horse battery', xmlTok: 'xmlTOKENvalue99',
    plainTok: 'PlainTextTokenValue123', apiKeysArr: 'ak_live_9988', secretsVal: 'db-pass-1234', hmac: 'hmacvalue1234',
    xAccessKey: 'xaccesskeyvalue1', xSig: 'xsigvalue55', csrf: 'csrfval66', userinfo: 'deploy:S3cr3tPw', formPin: '7777',
  };
  function leak() {
    return collectionFromTraffic(
      [
        ex('GET', `https://api.shop.example/v1/users/${P.phone}/balance?msisdn=${P.phone}`, {
          resH: { 'X-Access-Key': P.xAccessKey, 'X-Request-Sig': P.xSig, 'X-Csrf': P.csrf },
          resB: JSON.stringify({
            msisdn: P.phone, verificationCode: P.otp, sid: P.sid, passphrase: P.passphrase,
            tokens: { fcm: P.devTok }, secrets: { db: P.secretsVal }, apiKeys: [P.apiKeysArr], passwords: [P.hunter],
            AccessKeyId: P.awsKeyId, payload: JSON.stringify({ access_token: P.innerTok }),
            downloadUrl: `/files/1?sig=${P.relSig}&se=2030`, avatar: `https://${P.userinfo}@cdn.example/a.png?X-Amz-Signature=abc&hmac=${P.hmac}`,
            contacts: { [P.email]: { phone: P.phonePlus } }, byPhone: { [P.phonePlus]: true }, list: [JWT, `Token ${OPAQ}`],
          }),
        }),
        ex('GET', `https://api.shop.example/v1/profile/${P.phonePlus}`, { resB: '{"ok":true}' }),
        ex('GET', `https://api.shop.example/v1/magic/${P.magic}`, { resB: '{"ok":true}' }),
        ex('GET', `https://api.shop.example/v1/reset/${P.otp}`, { resB: '{"ok":true}' }),
        ex('POST', 'https://api.shop.example/v1/login', {
          reqH: { 'content-type': 'application/x-www-form-urlencoded' },
          reqB: `username=${encodeURIComponent(P.email)}&pin=${P.formPin}&passphrase=${encodeURIComponent(P.passphrase)}&otp=${P.otp}`,
          resB: JSON.stringify({ accessToken: JWT, user: { email: P.email } }),
        }),
        ex('POST', 'https://api.shop.example/v1/login-text', {
          reqH: { 'content-type': 'text/plain' },
          reqB: `user=${P.email} pass=${P.hunter}`,
          resH: { 'content-type': 'application/xml' },
          resB: `<r><token>${P.xmlTok}</token><session>${P.plainTok}</session></r>`,
        }),
        ex('GET', 'https://api.shop.example/v1/plain', { resH: { 'content-type': 'text/plain' }, resB: `token: ${P.plainTok}\nsecret=${P.secretsVal}` }),
      ],
      { name: 'probe' },
    );
  }

  it('no planted credential or personal value reaches the collection', () => {
    const r = leak();
    none('collection', r.text, [OPAQ, JWT, ...Object.values(P)]);
    // the e-mail / phone keys got the same replacement as values
    expect(r.text).toContain('user1@example.com');
    expect(r.text).toContain('+10000000');
  });

  it('removed never echoes a key that is personal data (also for keys under a secret-named parent)', () => {
    const r = leak();
    none('removed', JSON.stringify(r.removed), [P.email, P.phonePlus, P.phone]);
    const r2 = collectionFromTraffic([ex('GET', 'https://api.example.com/a', { resB: '{"auth":{"jane.doe@corp-mail.sa":"x","+966501234567":"y"}}' })], { name: 'x' });
    expect(r2.removed).toEqual(['auth', 'e-mail addresses', 'phone numbers']);
    none('file', r2.text, ['jane.doe@corp-mail.sa', '+966501234567']);
  });

  it('paths: phone numbers, short tokens and one-time codes become params with empty values; short ids are kept', () => {
    const r = leak();
    const doc = JSON.parse(r.text) as { item: { item: { name: string; request: { url: { variable?: { key: string; value: string }[] } } }[] }[] };
    const names = doc.item[0].item.map((i) => i.name).sort();
    expect(names).toContain('GET /v1/profile/:profileId');
    expect(names).toContain('GET /v1/magic/:magicId');
    const vars = doc.item[0].item.flatMap((i) => i.request.url.variable ?? []);
    expect(vars.every((v) => v.value === '')).toBe(true);
    const ok = collectionFromTraffic([ex('GET', 'https://api.example.com/orders/1234567', { resB: '{"id":1234567}' })], { name: 'x' });
    expect(ok.text).toContain('"value": "1234567"');
  });

  it('with personal-data replacement off, phone numbers stay but credentials still go', () => {
    const r = collectionFromTraffic(
      [ex('POST', 'https://api.example.com/login', { reqH: { 'content-type': 'application/x-www-form-urlencoded' }, reqB: `username=${encodeURIComponent(P.email)}&otp=${P.otp}`, resB: '{"ok":true}' })],
      { name: 'x', replacePersonalData: false },
    );
    expect(holds(r.text, P.email)).toBe(true);
    expect(holds(r.text, P.otp)).toBe(false);
  });

  it('merge mode of Update example: added fields with plural / variant names are blanked (C/splice.ts part 2)', () => {
    const s = new TrafficSanitiser(true);
    const fresh = s.responseBody('{"id":1,"passwords":["hunter2pass"],"verificationCode":"482913","refresh_token":"rt-1","contacts":{"jane.doe@corp-mail.sa":1}}', true);
    none('fresh', fresh, ['hunter2pass', '482913', 'rt-1', 'jane.doe@corp-mail.sa']);
  });

  it('look-alikes in answers keep their values', () => {
    const r = collectionFromTraffic([ex('GET', 'https://api.example.com/p', { resB: '{"author":"Ada","sessionCount":3,"tokenizer":"bpe","code":"NOT_FOUND"}' })], { name: 'x' });
    expect(JSON.parse((JSON.parse(r.text) as { item: { item: { response: { body: string }[] }[] }[] }).item[0].item[0].response[0].body)).toEqual({ author: 'Ada', sessionCount: 3, tokenizer: 'bpe', code: 'NOT_FOUND' });
  });
});

// ------------------------------------------------------------------------------------------------ #12 large sessions

describe('#12: a larger session is written whole, never as an empty collection', () => {
  it('900 × 2 endpoints with 10 request headers: every endpoint is in the file, counts match', () => {
    const hs: Record<string, string> = {};
    for (let k = 0; k < 10; k++) hs[`x-h${k}`] = `v${k}`;
    const list: Exchange[] = [];
    for (let i = 0; i < 900; i++) for (const m of ['GET', 'POST']) list.push(ex(m, `https://api.example.com/r${i}?a=1&b=2&c=3`, { reqH: hs, resB: `{"k${i}":${i}}`, resH: { 'x-a': '1' } }));
    const r = collectionFromTraffic(list, { name: 'big' });
    const doc = JSON.parse(r.text) as { item: { item: unknown[] }[] };
    const items = doc.item.reduce((n, f) => n + f.item.length, 0);
    expect(r.endpoints).toBe(1800);
    expect(items).toBe(1800);
    expect(r.removed).not.toContain(SANITISE_TOO_LARGE);
  });

  it('the copy without credentials sizes its budget to a plain tree; a YAML alias DAG still stops', () => {
    const item = Array.from({ length: 40_000 }, (_, i) => ({ name: `r${i}`, request: { method: 'GET', url: `https://a.example/r${i}`, header: [{ key: 'x-a', value: '1' }, { key: 'Authorization', value: 'Bearer abcdefghijklmnop1234' }] } }));
    const res = sanitisePostman({ info: { name: 'big' }, item });
    expect(res.removed).not.toContain(SANITISE_TOO_LARGE);
    expect((res.doc as { item: unknown[] }).item).toHaveLength(40_000);
    expect(JSON.stringify(res.doc)).not.toContain('abcdefghijklmnop1234');
    const shared = { name: 'x', item: [] as unknown[] };
    let level: unknown = shared;
    for (let i = 0; i < 7; i++) level = { name: `l${i}`, item: Array(10).fill(level) };
    expect(sanitisePostman({ info: { name: 'dag' }, item: [level] }).removed).toContain(SANITISE_TOO_LARGE);
  });
});

// ------------------------------------------------------------------------------------------------ #15 INFO

describe('#15: INFO items', () => {
  it('collapseSiblings is linear: 5 URLs of 8 000 segments', () => {
    const p = Array.from({ length: 8000 }, (_, i) => `s${i % 7}`).join('/');
    const list = Array.from({ length: 5 }, (_, k) => ex('GET', `https://api.example.com/${p}/x${k}`, { resB: '{"id":1}' }));
    const t = performance.now();
    collectionFromTraffic(list, { name: 'long' });
    expect(performance.now() - t).toBeLessThan(500);
  });

  it('session tokens come from crypto, not Math.random (15e)', () => {
    const spy = vi.spyOn(Math, 'random');
    const s = new AuthSessions();
    const a = s.login('{"token":"x"}', 'random', 600, 0);
    const b = s.login('{"token":"x"}', 'random', 600, 0);
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
    expect(a.token).toMatch(/^fi\.[a-z0-9]{32}$/);
    expect(a.token).not.toBe(b.token);
  });

  it('the JWT sub is a keyed hash: stable within one store, different in another (15f)', () => {
    const JWT_EXAMPLE = `${Buffer.from('{"alg":"HS256"}').toString('base64url')}.${Buffer.from('{"sub":"1"}').toString('base64url')}.sig`;
    const one = new AuthSessions();
    const a = jwtClaims(one.login(JSON.stringify({ token: JWT_EXAMPLE }), 'seeded', 600, 0, 'sara@example.com').token)!.sub;
    const b = jwtClaims(one.login(JSON.stringify({ token: JWT_EXAMPLE }), 'seeded', 600, 0, 'sara@example.com').token)!.sub;
    const c = jwtClaims(new AuthSessions().login(JSON.stringify({ token: JWT_EXAMPLE }), 'seeded', 600, 0, 'sara@example.com').token)!.sub;
    expect(a).toMatch(/^u_[0-9a-f]{16}$/);
    expect(a).toBe(b);
    expect(c).not.toBe(a);
  });

  it('withoutSecretFields drops secret names at any depth and keeps look-alikes', () => {
    const removed = new Set<string>();
    expect(JSON.parse(JSON.stringify(withoutSecretFields({ user: 'sara', pass: 'x', password: 'x', profile: { otp: '1', author: 'a' }, list: [{ token: 't', sessionCount: 1 }] }, removed)))).toEqual({
      user: 'sara',
      profile: { author: 'a' },
      list: [{ sessionCount: 1 }],
    });
    expect([...removed].sort()).toEqual(['otp', 'pass', 'password', 'token']);
  });
});

// ------------------------------------------------------------------------------------------------ host: #4 and Update example

const BASE = 'http://api.shop.test';
const J = { key: 'Content-Type', value: 'application/json' };
const u = (p: string[]) => ({ raw: `{{baseUrl}}/${p.join('/')}`, host: ['{{baseUrl}}'], path: p });
const PW = 'Hunter2-planted-PW!';

function authCollection(withSuccess: boolean): string {
  return JSON.stringify({
    info: { name: 'Auth', schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json' },
    variable: [{ key: 'baseUrl', value: BASE }],
    item: [
      {
        name: 'Sign in',
        request: { method: 'POST', url: u(['api', 'sessions']), body: { mode: 'raw', raw: '{"login":"a@b.c","pass":"x"}' } },
        response: withSuccess ? [{ name: 'OK', code: 201, header: [J], body: '{"id":1,"token":"abc","userId":5}' }] : [{ name: 'Bad', code: 401, header: [J], body: '{"error":"bad"}' }],
      },
      { name: 'Sign out', request: { method: 'DELETE', url: u(['api', 'sessions', ':id']) }, response: [{ name: 'Bye', code: 204, header: [], body: '' }] },
      { name: 'Users', request: { method: 'GET', url: u(['api', 'users']) }, response: [{ name: 'OK', code: 200, header: [J], body: '[{"id":1,"name":"Sara"}]' }] },
      { name: 'Create user', request: { method: 'POST', url: u(['api', 'users']) }, response: [{ name: 'Created', code: 201, header: [J], body: '{"id":2,"name":"Lina"}' }] },
      { name: 'User', request: { method: 'GET', url: u(['api', 'users', ':id']) }, response: [{ name: 'OK', code: 200, header: [J], body: '{"id":1,"name":"Sara"}' }] },
      { name: 'Me', request: { method: 'GET', url: u(['api', 'me']) }, response: [{ name: 'OK', code: 200, header: [J], body: '{"id":5}' }] },
    ],
  });
}

interface Host {
  core: MockCollectionsCore;
  handlers: Map<string, RequestHandler>;
  files: FakeFs;
}

async function host(sharedJson: unknown, put: Record<string, string>, exchanges: Exchange[] = []): Promise<Host> {
  const files = new FakeFs();
  files.put(`${ROOT}/pubspec.yaml`, 'name: app');
  for (const [p, t] of Object.entries(put)) files.put(`${ROOT}/${p}`, t);
  files.put(FILE, JSON.stringify(sharedJson, null, 2));
  const memento = new FakeMemento();
  const shared = new SharedRulesCore({ folders: () => [{ name: 'app', path: ROOT }], fs: files, validateRule: fakeValidateRule, memento });
  await shared.reload();
  const handlers = new Map<string, RequestHandler>();
  const core = new MockCollectionsCore({
    links: () => shared.collectionLinks(),
    saveLinks: (f, l) => shared.saveCollections(f, l),
    primaryFolderPath: () => shared.primaryFolderPath(),
    writeWorkspaceFile: (f, r, t) => shared.writeWorkspaceFile(f, r, t),
    workspaceRoots: () => [ROOT],
    fs: files,
    memento,
    parsers: collectionParsers,
    newRuleId: () => 'rule_new',
    exchanges: () => exchanges,
    setHandler: (id, fn) => void (fn ? handlers.set(id, fn) : handlers.delete(id)),
    saveStore: (f, c, e) => shared.saveStore(f, c, e),
    driftEnabled: () => true,
    now: () => Date.UTC(2026, 10, 20, 12),
  });
  await core.reload();
  return { core, handlers, files };
}

function send(h: Host, method: string, url: string, text?: string): { status: number; body: string } {
  const rule = findRule(compileRules(h.core.rules()), method, url) as Rule | undefined;
  if (!rule) throw new Error(`no rule for ${method} ${url}`);
  const a = rule.action;
  if (a.kind === 'mock') return { status: a.status, body: a.body };
  if (a.kind !== 'handler') throw new Error(a.kind);
  const fn = h.handlers.get(a.handlerId)!;
  const r = fn(
    { exchangeId: `e${++seq}`, ruleId: rule.id, method, url, headers: { 'content-type': 'application/json' }, ...(text !== undefined ? { body: { text, encoding: 'utf8' as const } } : {}) },
    new AbortController().signal,
  ) as { status?: number; body?: string; fallback?: true } | undefined;
  if (!r || r.fallback) return { status: a.fallback!.status, body: a.fallback!.body };
  return { status: r.status!, body: r.body ?? '' };
}

describe('#4: the sign-in simulation wins over the store; the store keeps no secret field', () => {
  for (const [label, authOn, success] of [['auth off (default)', false, true], ['auth on, login with no 2xx example', true, false]] as const) {
    it(`POST /sessions + DELETE /sessions/:id keeps no password: ${label}`, async () => {
      const h = await host(
        { version: 1, rules: [], collections: [{ id: 'auth', file: 'api/auth.postman_collection.json' }], ...(authOn ? { stores: [{ collection: 'auth', auth: { enabled: true } }] } : {}) },
        { 'api/auth.postman_collection.json': authCollection(success) },
      );
      const a = send(h, 'POST', `${BASE}/api/sessions`, JSON.stringify({ user: 'sara@example.com', pass: PW, password: PW }));
      expect(a.body).not.toContain(PW);
      expect(a.status).toBe(success ? 201 : 401);
      const items = h.core.storeItems('auth', 'sessions', {});
      expect(items.total).toBe(0);
      expect(JSON.stringify(h.core.storeStatus('auth'))).not.toContain(PW);
    });
  }

  it('a password sent to any other create is not stored nor answered back (look-alikes kept)', async () => {
    const h = await host({ version: 1, rules: [], collections: [{ id: 'auth', file: 'api/auth.postman_collection.json' }] }, { 'api/auth.postman_collection.json': authCollection(true) });
    const a = send(h, 'POST', `${BASE}/api/users`, JSON.stringify({ name: 'Omar', password: PW, profile: { otp: '482913', author: 'x' } }));
    expect(a.status).toBe(201);
    expect(a.body).not.toContain(PW);
    expect(a.body).not.toContain('482913');
    expect(JSON.parse(a.body)).toMatchObject({ name: 'Omar', profile: { author: 'x' } });
    const listed = send(h, 'GET', `${BASE}/api/users`);
    expect(listed.body).not.toContain(PW);
    expect(listed.body).toContain('Omar');
  });
});

describe('#3: Update example reads past a BOM / XSSI guard and refuses what isn’t plain JSON', () => {
  const ORIGIN = 'https://api.shop.example';
  const COLLECTION = JSON.stringify({
    info: { name: 'Shop', schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json' },
    variable: [{ key: 'baseUrl', value: ORIGIN }],
    item: [{ name: 'User', request: { method: 'GET', url: u(['users', ':id']) }, response: [{ name: '200 OK', code: 200, header: [J], body: '{"id":1,"name":"a"}' }] }],
  });
  const ENDPOINT = 'GET {{baseUrl}}/users/:id';

  async function drifted(body: string): Promise<Host> {
    const traffic: Exchange[] = [];
    const h = await host({ version: 1, rules: [], collections: [{ id: 'shop', file: 'api/shop.postman_collection.json' }] }, { 'api/shop.postman_collection.json': COLLECTION }, traffic);
    await h.core.update('shop', { enabled: false });
    for (let k = 0; k < 3; k++) {
      const x = ex('GET', `${ORIGIN}/users/1`, { resB: body });
      traffic.push(x);
      h.core.observeExchange(x);
    }
    h.core.flushDrift();
    return h;
  }

  it('BOM and XSSI answers: add and merge hold no planted value', async () => {
    for (const body of [`﻿{"id":1,"name":"b","refresh_token":"rt-1","password":"hunter2pass"}`, `)]}',\n{"id":1,"name":"b","refresh_token":"rt-1","password":"hunter2pass"}`]) {
      const h = await drifted(body);
      const up = await h.core.exampleUpdate('shop', ENDPOINT, 200, 'add');
      none('add', JSON.stringify(up), ['hunter2pass', 'rt-1']);
      expect(JSON.parse(up.newBody)).toEqual({ id: 1, name: 'b', refresh_token: '', password: '' });
      // merge: whatever drift made of the answer, nothing planted is merged
      const merged = await h.core.exampleUpdate('shop', ENDPOINT, 200, 'merge').catch((e: Error) => e.message);
      none('merge', JSON.stringify(merged), ['hunter2pass', 'rt-1']);
    }
  });

  it('NDJSON / NaN answers are refused (never written as text)', async () => {
    for (const body of ['{"id":1,"password":"hunter2pass"}\n{"id":2,"password":"hunter2pass"}', '{"id":1,"password":"hunter2pass","v":NaN}']) {
      const h = await drifted(body);
      await expect(h.core.exampleUpdate('shop', ENDPOINT, 200, 'add')).rejects.toThrow(/isn't plain JSON/);
    }
  });
});

// ------------------------------------------------------------------------------------------------ agents (#15d)

describe('#15d: an agent can’t turn personal-data replacement off', () => {
  it('mock_from_traffic passes replacePersonalData: true whatever the agent sends', async () => {
    const { createAgentApi } = await import('../../src/agent/api');
    const seen: unknown[] = [];
    const api = createAgentApi({
      host: { running: true, port: 1, getExchanges: () => [], getRules: () => [], on: () => undefined, off: () => undefined, resume: () => undefined, abort: () => undefined } as never,
      applyRules: () => undefined,
      clear: () => undefined,
      getSettings: () => ({ access: 'readWrite', redactSecrets: true, interceptEnabled: true }),
      launcher: { launch: vi.fn(), stop: vi.fn(), hotRestart: vi.fn(), sessions: () => [] } as never,
      projectRoot: () => ROOT,
      now: () => 0,
      collections: {
        state: () => [],
        endpoints: () => [],
        example: () => undefined,
        update: async () => undefined,
        importFile: async () => ({ id: 'x' }),
        describeRule: () => undefined,
        endpointForRequest: () => undefined,
        mockFromTraffic: async (req: unknown) => {
          seen.push(req);
          return { id: 'x', file: 'f.json', endpoints: 1, examples: 1, resources: [], skipped: [], removed: [], dryRun: true };
        },
      } as never,
    });
    await api.call('mock_from_traffic', { dryRun: true, replacePersonalData: false });
    expect(seen).toHaveLength(1);
    expect((seen[0] as { replacePersonalData: boolean }).replacePersonalData).toBe(true);
  });
});
