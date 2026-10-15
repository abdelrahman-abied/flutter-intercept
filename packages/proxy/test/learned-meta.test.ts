// QUALITY-2: the learned passthrough key format shared with the extension host (`@flutter-intercept/proxy/learned-meta`),
// and the server helpers the HTTP and gRPC refusal paths share (learn-flow.ts).
import * as fs from 'fs';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import {
  bracketHost,
  hostLabel,
  LEARNED_MAX,
  learnedKey,
  learnedKeyOf,
  parseLearnedKey,
  pinKey,
  pinKeyTarget,
} from '../src/learned-meta';
import { connectTargetOf, httpsServerOf, isSameServer } from '../src/learn-flow';
import { LEARNED_MAX as LEARNED_MAX_VIA_LEARNED, parseLearnedKey as parseViaLearned } from '../src/learned';

describe('learned-meta (shared with the extension host)', () => {
  it('imports only net and ./hosts (activation loads it without the proxy)', () => {
    const src = fs.readFileSync(path.join(__dirname, '../src/learned-meta.ts'), 'utf8');
    const specs = [...src.matchAll(/^\s*import\s[^'"]*['"]([^'"]+)['"]/gm)].map((m) => m[1]).sort();
    expect(specs).toEqual(['./hosts', 'net']);
    expect(src).not.toMatch(/require\(/);
  });

  it('learned.ts re-exports the same definitions', () => {
    expect(LEARNED_MAX_VIA_LEARNED).toBe(LEARNED_MAX);
    expect(parseViaLearned).toBe(parseLearnedKey);
  });

  it('keys, labels and brackets', () => {
    expect(bracketHost('2001:db8::1')).toBe('[2001:db8::1]');
    expect(bracketHost('api.example')).toBe('api.example');
    expect(bracketHost('10.0.0.1')).toBe('10.0.0.1');
    expect(learnedKey('2001:db8::1', 443)).toBe('2001:db8::1:443'); // the map's key: no brackets
    expect(hostLabel('api.example', 443)).toBe('api.example');
    expect(hostLabel('api.example', 8443)).toBe('api.example:8443');
    expect(hostLabel('2001:db8::1', 443)).toBe('[2001:db8::1]');
    expect(hostLabel('2001:db8::1', 8443)).toBe('[2001:db8::1]:8443');
    const k = pinKey('loopback', 'api.example', 443);
    expect(k).toBe('loopback|api.example:443');
    expect(pinKeyTarget(k)).toBe('api.example:443');
    expect(pinKeyTarget(pinKey('fd00::5', '2001:db8::1', 443))).toBe('2001:db8::1:443');
  });

  it('learnedKeyOf round-trips through parseLearnedKey (REVIEW-14 #5)', () => {
    expect(learnedKeyOf('2001:DB8::1', 443)).toBe('[2001:db8::1]:443');
    expect(learnedKeyOf('[2001:db8::1]', 8443)).toBe('[2001:db8::1]:8443');
    expect(learnedKeyOf('[2001:db8::1]')).toBe('2001:db8::1');
    expect(learnedKeyOf('API.example', 8443)).toBe('api.example:8443');
    for (const [h, p] of [['2001:db8::1', 443], ['api.example', 8443], ['10.0.0.5', 443], ['[::1]', 9000]] as const) {
      const parsed = parseLearnedKey(learnedKeyOf(h, p));
      expect(parsed).toEqual({ host: h.replace(/^\[|\]$/g, '').toLowerCase(), port: p });
    }
    expect(parseLearnedKey(learnedKeyOf('2001:db8::1'))).toEqual({ host: '2001:db8::1' });
  });
});

describe('refusal servers (learn-flow)', () => {
  it('httpsServerOf: https only, port 443 by default, normalised host', () => {
    expect(httpsServerOf('https://API.Example./x')).toEqual({ host: 'api.example', port: 443 });
    expect(httpsServerOf('https://[2001:db8::1]:8443/')).toEqual({ host: '2001:db8::1', port: 8443 });
    expect(httpsServerOf('http://api.example/')).toBeUndefined();
    expect(httpsServerOf('not a url')).toBeUndefined();
  });

  it('connectTargetOf: the CONNECT target, normalised; undefined without host or port', () => {
    expect(connectTargetOf({ destination: { hostname: 'API.example', port: 443 } })).toEqual({ host: 'api.example', port: 443 });
    expect(connectTargetOf({ destination: { hostname: '[::1]', port: 9000 } })).toEqual({ host: '::1', port: 9000 });
    expect(connectTargetOf({ destination: { hostname: '', port: 443 } })).toBeUndefined();
    expect(connectTargetOf({ destination: { hostname: 'a.example' } })).toBeUndefined();
    expect(connectTargetOf({})).toBeUndefined();
  });

  it('isSameServer: host and port must both match (REVIEW-14 #1)', () => {
    const named = { host: 'api.example', port: 443 };
    expect(isSameServer(named, { host: 'api.example', port: 443 })).toBe(true);
    expect(isSameServer(named, { host: '10.0.0.5', port: 443 })).toBe(false);
    expect(isSameServer(named, { host: 'api.example', port: 8443 })).toBe(false);
    expect(isSameServer(named, undefined)).toBe(false);
  });
});
