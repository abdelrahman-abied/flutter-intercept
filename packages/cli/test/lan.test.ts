import { describe, expect, it } from 'vitest';
import type { Exchange } from '@flutter-intercept/proxy';
import { maskArgs, maskProxyCredentials } from '../src/command';
import { isVerboseFlutter, lanProxyAddress, newRunToken, resolveLanHost, withoutProxyAuthorization } from '../src/lan';

describe('LAN helpers (CONTRACTS §7, §14.1)', () => {
  it('a new 32-byte base64url token per run', () => {
    const a = newRunToken();
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(newRunToken()).not.toBe(a);
  });

  it('the define value is flutter-intercept:<token>@<ip>:<port>', () => {
    expect(lanProxyAddress({ host: '192.168.1.20', port: 5000, token: 'tok' })).toBe('flutter-intercept:tok@192.168.1.20:5000');
  });

  it('resolves the LAN host or says why there is none', async () => {
    await expect(resolveLanHost(async () => ({ address: '192.168.1.20', iface: 'en0' }))).resolves.toBe('192.168.1.20');
    await expect(resolveLanHost(async () => undefined)).rejects.toThrow(/no LAN address/);
    await expect(resolveLanHost(async () => ({ problem: 'address 100.64.0.2 (en0) is not a private (RFC 1918) LAN address' }))).rejects.toThrow(/^physical iPhone: address 100\.64\.0\.2/);
    await expect(resolveLanHost(async () => Promise.reject(new Error('boom')))).rejects.toThrow(/could not find this machine's LAN address: boom/);
  });

  it('masks the token in printed defines, ours and only the credentials', () => {
    expect(maskProxyCredentials('flutter-intercept:abc_-123@192.168.1.20:5000')).toBe('flutter-intercept:***@192.168.1.20:5000');
    expect(maskProxyCredentials('localhost:5000')).toBe('localhost:5000');
    expect(maskProxyCredentials('10.0.2.2:5000')).toBe('10.0.2.2:5000');
    expect(maskArgs(['test', '--dart-define=FLUTTER_INTERCEPT_PROXY=flutter-intercept:SECRET@192.168.1.20:5000', '--dart-define', 'FLUTTER_INTERCEPT_PROXY=flutter-intercept:SECRET@h:1'])).toEqual([
      'test',
      '--dart-define=FLUTTER_INTERCEPT_PROXY=flutter-intercept:***@192.168.1.20:5000',
      '--dart-define',
      'FLUTTER_INTERCEPT_PROXY=flutter-intercept:***@h:1',
    ]);
  });

  it('drops Proxy-Authorization request headers (any case) from copies', () => {
    const e = { id: '1', method: 'GET', url: 'http://x.test/', startedAt: 0, state: 'completed', requestHeaders: { 'Proxy-Authorization': 'Basic x', accept: '*/*' } } as unknown as Exchange;
    const plain = { ...e, id: '2', requestHeaders: { accept: '*/*' } } as Exchange;
    const [a, b] = withoutProxyAuthorization([e, plain]);
    expect(a.requestHeaders).toEqual({ accept: '*/*' });
    expect(e.requestHeaders['Proxy-Authorization']).toBe('Basic x');
    expect(b).toBe(plain);
  });

  it('spots flutter verbose flags', () => {
    expect(isVerboseFlutter(['--flavor', 'dev'])).toBe(false);
    expect(isVerboseFlutter(['-v'])).toBe(true);
    expect(isVerboseFlutter(['--verbose'])).toBe(true);
  });
});
