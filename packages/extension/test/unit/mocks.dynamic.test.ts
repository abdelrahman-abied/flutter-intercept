// CONTRACTS §24.3: dynamic values in example bodies.
import { describe, expect, it } from 'vitest';
import { DYNAMIC_NAMES, FIXED_NOW_MS, MAX_PLACEHOLDERS, mulberry32, renderDynamic } from '../../src/mocks/dynamic';
import { COLLECTION_LIMITS } from '../../src/mocks/types';

const NOW = Date.UTC(2026, 10, 20, 12, 0, 0);
const seeded = (text: string, seed = 7, json = false) => renderDynamic(text, { mode: 'seeded', seed, json, nowMs: NOW });
const one = (name: string, seed = 7): string => seeded(`{{${name}}}`, seed).text;

const CONTRACT_NAMES = [
  '$guid', '$randomUUID', '$timestamp', '$isoTimestamp', '$randomInt', '$randomBoolean', '$randomAlphaNumeric',
  '$randomEmail', '$randomExampleEmail', '$randomUserName', '$randomFirstName', '$randomLastName', '$randomFullName',
  '$randomPhoneNumber', '$randomCity', '$randomStreetAddress', '$randomCountry', '$randomCountryCode',
  '$randomLatitude', '$randomLongitude', '$randomPrice', '$randomProductName', '$randomCompanyName', '$randomJobTitle',
  '$randomWord', '$randomWords', '$randomLoremWord', '$randomLoremSentence', '$randomLoremParagraph',
  '$randomDateFuture', '$randomDatePast', '$randomDateRecent', '$randomColor', '$randomHexColor',
  '$randomCurrencyCode', '$randomIP', '$randomIPV6', '$randomDomainName', '$randomUrl',
];

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;

describe('renderDynamic', () => {
  it('supports exactly the §24.3 list', () => {
    expect([...DYNAMIC_NAMES].sort()).toEqual([...CONTRACT_NAMES].sort());
  });

  it('gives each supported name a well-formed value', () => {
    for (let seed = 0; seed < 25; seed++) {
      expect(one('$guid', seed)).toMatch(UUID_V4);
      expect(one('$randomUUID', seed)).toMatch(UUID_V4);
      expect(one('$timestamp', seed)).toBe(String(Math.floor(NOW / 1000)));
      expect(one('$isoTimestamp', seed)).toBe(new Date(NOW).toISOString());
      const n = Number(one('$randomInt', seed));
      expect(Number.isInteger(n) && n >= 0 && n <= 1000).toBe(true);
      expect(['true', 'false']).toContain(one('$randomBoolean', seed));
      expect(one('$randomAlphaNumeric', seed)).toMatch(/^[a-z0-9]$/);
      expect(one('$randomEmail', seed)).toMatch(/^[a-z]+\.[a-z]+@example\.(com|net|org)$/);
      expect(one('$randomExampleEmail', seed)).toMatch(/^[a-z]+\d+@example\.(com|net|org)$/);
      expect(one('$randomUserName', seed)).toMatch(/^[a-z]+_[a-z]+\d+$/);
      expect(one('$randomFirstName', seed)).toMatch(/^[A-Z][a-z]+$/);
      expect(one('$randomLastName', seed)).toMatch(/^[A-Z][a-z]+$/);
      expect(one('$randomFullName', seed)).toMatch(/^[A-Z][a-z]+ [A-Z][a-z]+$/);
      expect(one('$randomPhoneNumber', seed)).toMatch(/^555-\d{3}-\d{4}$/);
      expect(one('$randomCity', seed)).toMatch(/^[A-Z][a-z]+$/);
      expect(one('$randomStreetAddress', seed)).toMatch(/^\d{1,3} [A-Z][a-z]+ [A-Z][a-z]+$/);
      expect(one('$randomCountry', seed)).toMatch(/^[A-Z][A-Za-z ]+$/);
      expect(one('$randomCountryCode', seed)).toMatch(/^[A-Z]{2}$/);
      const lat = Number(one('$randomLatitude', seed));
      const lon = Number(one('$randomLongitude', seed));
      expect(lat >= -90 && lat <= 90 && lon >= -180 && lon <= 180).toBe(true);
      expect(one('$randomPrice', seed)).toMatch(/^\d{1,4}\.\d{2}$/);
      expect(one('$randomProductName', seed).split(' ')).toHaveLength(3);
      expect(one('$randomCompanyName', seed)).toMatch(/^[A-Z][a-z]+ /);
      expect(one('$randomJobTitle', seed).split(' ')).toHaveLength(3);
      expect(one('$randomWord', seed)).toMatch(/^[a-z]+$/);
      expect(one('$randomWords', seed)).toMatch(/^[a-z]+ [a-z]+ [a-z]+$/);
      expect(one('$randomLoremWord', seed)).toMatch(/^[a-z]+$/);
      expect(one('$randomLoremSentence', seed)).toMatch(/^[A-Z][a-z ]+\.$/);
      expect(one('$randomLoremParagraph', seed).split('. ').length).toBeGreaterThanOrEqual(3);
      const future = Date.parse(one('$randomDateFuture', seed));
      const past = Date.parse(one('$randomDatePast', seed));
      const recent = Date.parse(one('$randomDateRecent', seed));
      expect(one('$randomDateFuture', seed)).toMatch(ISO);
      expect(future).toBeGreaterThan(NOW);
      expect(past).toBeLessThan(NOW);
      expect(recent).toBeLessThan(NOW);
      expect(recent).toBeGreaterThan(NOW - 2 * 86_400_000);
      expect(one('$randomColor', seed)).toMatch(/^[a-z]+$/);
      expect(one('$randomHexColor', seed)).toMatch(/^#[0-9a-f]{6}$/);
      expect(one('$randomCurrencyCode', seed)).toMatch(/^[A-Z]{3}$/);
      expect(one('$randomIP', seed)).toMatch(/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/);
      expect(one('$randomIPV6', seed)).toMatch(/^[0-9a-f]{4}(?::[0-9a-f]{4}){7}$/);
      expect(one('$randomDomainName', seed)).toMatch(/^[a-z]+\.example\.com$/);
      expect(one('$randomUrl', seed)).toMatch(/^https:\/\/example\.com\/[a-z]+$/);
    }
  });

  it('JSON-escapes values inside JSON strings and leaves values outside strings bare', () => {
    const vars = { quote: 'say "hi"\\ \n now', num: '42' };
    const text = '{"msg":"{{quote}}","n":{{num}},"id":"{{$guid}}","k":"a\\"{{num}}"}';
    const out = renderDynamic(text, { mode: 'seeded', seed: 1, json: true, vars });
    const parsed = JSON.parse(out.text) as { msg: string; n: number; id: string; k: string };
    expect(parsed.msg).toBe('say "hi"\\ \n now');
    expect(parsed.n).toBe(42);
    expect(parsed.id).toMatch(UUID_V4);
    expect(parsed.k).toBe('a"42');
    // Not JSON: inserted as it is.
    expect(renderDynamic('x={{quote}}', { mode: 'seeded', json: false, vars }).text).toBe(`x=${vars.quote}`);
  });

  it('is deterministic in seeded mode and varies with the seed; random mode varies', () => {
    const text = '{"a":"{{$guid}}","b":{{$randomInt}},"c":"{{$randomFullName}}","d":"{{$randomLoremParagraph}}"}';
    expect(seeded(text, 3, true).text).toBe(seeded(text, 3, true).text);
    expect(seeded(text, 3, true).text).not.toBe(seeded(text, 4, true).text);
    const r1 = renderDynamic('{{$guid}}', { mode: 'random', json: false }).text;
    const r2 = renderDynamic('{{$guid}}', { mode: 'random', json: false }).text;
    expect(r1).toMatch(UUID_V4);
    expect(r1).not.toBe(r2);
    // Seeded without a clock uses the fixed base, so the output depends on nothing but text and seed.
    expect(renderDynamic('{{$timestamp}}', { mode: 'seeded', json: false }).text).toBe(String(FIXED_NOW_MS / 1000));
  });

  it('uses the §21.4 constants in fixed mode', () => {
    const r = (name: string): string => renderDynamic(`{{${name}}}`, { mode: 'fixed', json: false, nowMs: NOW }).text;
    expect(r('$guid')).toBe('00000000-0000-4000-8000-000000000000');
    expect(r('$isoTimestamp')).toBe('2026-01-01T00:00:00Z');
    expect(r('$timestamp')).toBe(String(Date.UTC(2026, 0, 1) / 1000));
    expect(r('$randomEmail')).toBe('user@example.com');
    expect(r('$randomExampleEmail')).toBe('user@example.com');
    expect(r('$randomIP')).toBe('192.0.2.1');
    expect(r('$randomIPV6')).toBe('2001:db8::1');
    expect(r('$randomUrl')).toBe('https://example.com');
    expect(r('$randomDomainName')).toBe('example.com');
    expect(r('$randomInt')).toBe('0');
    expect(r('$randomBoolean')).toBe('true');
    // Always the same.
    const all = DYNAMIC_NAMES.map((n) => `{{${n}}}`).join('|');
    expect(renderDynamic(all, { mode: 'fixed', json: false }).text).toBe(renderDynamic(all, { mode: 'fixed', json: false, nowMs: 1 }).text);
  });

  it('leaves unsupported names and unknown variables as written', () => {
    const text = '{{$randomImageUrl}} {{$randomPassword}} {{$randomUserAgent}} {{unknownVar}} {{ $guid }} {{}} {{$constructor}}';
    const out = seeded(text);
    expect(out.text).toBe(text);
    expect(out.problems).toHaveLength(1);
    expect(out.problems[0]).toContain('$randomImageUrl');
    expect(out.problems[0]).toContain('$randomPassword');
    expect(out.problems[0]).not.toContain('unknownVar');
  });

  it('takes plain variables from ctx.vars only (never environment values) and only own keys', () => {
    // The caller passes link + collection variables; an environment value is simply not in ctx.vars.
    const environment = new Map([['token', 'env-token-must-never-leave-the-host']]);
    void environment;
    const out = seeded('{"t":"{{token}}","b":"{{baseUrl}}","p":"{{__proto__}}","c":"{{constructor}}"}');
    expect(out.text).not.toContain('env-token');
    expect(out.text).toBe('{"t":"{{token}}","b":"{{baseUrl}}","p":"{{__proto__}}","c":"{{constructor}}"}');
    const withVars = renderDynamic('{{baseUrl}}/{{id}}', { mode: 'seeded', json: false, vars: new Map([['baseUrl', 'https://api.example']]) });
    expect(withVars.text).toBe('https://api.example/{{id}}');
  });

  it('replaces at most 1 000 placeholders per body', () => {
    const text = Array.from({ length: MAX_PLACEHOLDERS + 5 }, () => '{{$randomInt}}').join(',');
    const out = seeded(text);
    const parts = out.text.split(',');
    expect(parts.filter((p) => /^\d+$/.test(p))).toHaveLength(MAX_PLACEHOLDERS);
    expect(parts.slice(MAX_PLACEHOLDERS)).toEqual(Array(5).fill('{{$randomInt}}'));
    expect(out.problems.some((p) => p.includes('1000'))).toBe(true);
  });

  it('never makes a body larger than exampleBodyBytes (served as written instead)', () => {
    const big = 'x'.repeat(COLLECTION_LIMITS.exampleBodyBytes / 2);
    const text = '{{big}}{{big}}{{big}}';
    const out = renderDynamic(text, { mode: 'seeded', json: false, vars: { big } });
    expect(out.text).toBe(text);
    expect(out.problems[0]).toContain('MB');
  });

  it('stays linear on hostile input', () => {
    const hostile = '{{'.repeat(500_000);
    const t0 = Date.now();
    expect(seeded(hostile).text).toBe(hostile);
    const hostile2 = `${'{{a'.repeat(200_000)}}}`;
    expect(seeded(hostile2).text).toBe(hostile2);
    expect(Date.now() - t0).toBeLessThan(2000);
  });

  it('mulberry32 is deterministic and in [0, 1)', () => {
    const a = mulberry32(42);
    const b = mulberry32(42);
    for (let i = 0; i < 100; i++) {
      const x = a();
      expect(x).toBe(b());
      expect(x >= 0 && x < 1).toBe(true);
    }
  });
});
