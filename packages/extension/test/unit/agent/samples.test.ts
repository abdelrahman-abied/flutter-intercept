import * as path from 'path';
import { describe, expect, it } from 'vitest';
import type { Exchange } from '@flutter-intercept/proxy';
import { JsonDouble } from '../../../src/codegen/json';
import type { ApiEndpoint } from '../../../src/contract/types';
import { actualCategory, violationForAgent, contractForAgent, defaultFixtureName, endpointScore, fixtureApiFor, packageUri, testPackageFor, defaultModelName, isCheckable, projectRelative, redactExchange, redactJsonValue, routeOf, singular } from '../../../src/agent/samples';
import type { ContractViolation } from '../../../src/contract/types';

const tpl = (p: string) => p.replace(/\/\d+(?=\/|$)/g, '/{id}');
const ROOT = path.join(path.sep, 'home', 'me', 'app');

describe('naming', () => {
  it('singularises and builds class / fixture names from route templates', () => {
    expect(['users', 'categories', 'addresses', 'status', 'boxes', 'news', 'a'].map(singular)).toEqual(['user', 'category', 'address', 'status', 'box', 'new', 'a']);
    expect(defaultModelName('/v1/users/{id}')).toBe('User');
    expect(defaultModelName('/api/order-items')).toBe('OrderItem');
    expect(defaultModelName('/me')).toBe('Me');
    expect(defaultModelName('/{id}')).toBe('ApiResponse');
    expect(defaultModelName('/2fa')).toBe('Model2fa');
    expect(defaultFixtureName('GET', '/v1/users/{id}')).toBe('get_user');
    expect(defaultFixtureName('POST', '/userProfiles')).toBe('post_user_profile');
  });

  it('routeOf groups by method + origin + template', () => {
    expect(routeOf({ method: 'get', url: 'https://a.example/v1/users/42?x=1' }, tpl)).toEqual({ origin: 'https://a.example', template: '/v1/users/{id}', key: 'GET https://a.example/v1/users/{id}' });
  });
});

describe('redaction helpers', () => {
  it('redactJsonValue / redactExchange', () => {
    expect(redactJsonValue({ a: 1, token: 'x', nested: [{ password: 1, ok: true }] })).toEqual({ a: 1, token: '[redacted]', nested: [{ password: '[redacted]', ok: true }] });
    const e: Exchange = {
      id: 'e',
      startedAt: 1,
      method: 'GET',
      url: 'https://a.example/x?api_key=K&page=2',
      requestHeaders: { authorization: 'Bearer T', accept: '*/*' },
      state: 'completed',
      status: 200,
      responseHeaders: { 'set-cookie': 'sid=S' },
      responseBody: { text: '{"session":"S","n":1}', encoding: 'utf8' },
    };
    const r = redactExchange(e);
    expect(r.url).toBe('https://a.example/x?api_key=[redacted]&page=2');
    expect(r.requestHeaders).toEqual({ authorization: '[redacted]', accept: '*/*' });
    expect(r.responseHeaders).toEqual({ 'set-cookie': '[redacted]' });
    expect(r.responseBody?.text).toBe('{"session":"[redacted]","n":1}');
    expect(e.url).toContain('K'); // never mutates
  });

  it('isCheckable: finished, JSON, not truncated', () => {
    const base: Exchange = { id: 'e', startedAt: 1, method: 'GET', url: 'https://a/x', requestHeaders: {}, state: 'completed', responseHeaders: { 'content-type': 'application/problem+json' }, responseBody: { text: 'null', encoding: 'utf8' } };
    expect(isCheckable(base)).toBe(true);
    expect(isCheckable({ ...base, state: 'pending' })).toBe(false);
    expect(isCheckable({ ...base, responseBody: { text: 'null', encoding: 'utf8', truncated: true } })).toBe(false);
    expect(isCheckable({ ...base, responseHeaders: {}, responseBody: { text: 'hello', encoding: 'utf8' } })).toBe(false);
  });

  it('contractForAgent: project-relative files, URL and secret values removed', () => {
    const v = (over: Partial<ContractViolation>): ContractViolation => ({ path: '$.a', model: 'M', field: 'a', key: 'a', expected: 'String', actual: 'null', severity: 'error', message: 'm', ...over });
    const e = { id: 'e', startedAt: 1, method: 'GET', url: 'https://a.example/u/1?token=SECRET', requestHeaders: {}, state: 'completed' } as Exchange;
    const r = contractForAgent(
      {
        exchangeId: 'e',
        checked: true,
        via: 'source',
        model: 'M',
        violations: [
          v({ file: path.join(ROOT, 'lib', 'm.dart'), line: 3, message: `a is null in GET https://a.example/u/1?token=SECRET (${path.join(ROOT, 'lib', 'm.dart')})` }),
          v({ path: '$.auth.kind', key: 'kind', field: 'kind', actual: 'unknown enum value "SECRET2"', message: 'kind is "SECRET2"', severity: 'warning', file: '/elsewhere/x.dart', line: 9 }),
        ],
      },
      { root: ROOT, exchange: e, redact: true },
    );
    expect(r).toMatchObject({ exchangeId: 'e', method: 'GET', url: 'https://a.example/u/1?token=[redacted]', errors: 1, warnings: 1 });
    const [a, b] = r.violations as Record<string, unknown>[];
    expect(a).toMatchObject({ file: 'lib/m.dart', line: 3, actual: 'null', message: 'a is null at $.a: M.a expects String, so fromJson would throw' });
    expect(b.file).toBeUndefined();
    expect(b.line).toBeUndefined();
    // REVIEW-4 #6: no values, path cut at the sensitive key
    expect(b).toMatchObject({ actual: 'unknown enum value', path: '$.auth', message: 'kind has an unknown enum value at $.auth: M.kind expects String (suspicious; fromJson would not throw)' });
    expect(JSON.stringify(r)).not.toMatch(/SECRET|elsewhere|home/);
    expect(projectRelative(path.join(ROOT, '..', 'x'), ROOT)).toBeUndefined();
  });
});

describe('fixture API (mocktail)', () => {
  const ep = (over: Partial<ApiEndpoint>): ApiEndpoint => ({ method: 'GET', pathTemplate: '/users/{id}', dartMethod: 'getUser', file: '/f.dart', line: 1, className: 'UsersApi', ...over });
  it('endpointScore matches method + path template (relative or absolute), longest literal wins', () => {
    expect(endpointScore(ep({}), 'get', 'https://a.example/users/1')).toBe('/users/'.length);
    expect(endpointScore(ep({}), 'GET', 'https://a.example/v1/users/1?x=1')).toBeDefined(); // baseUrl path prefix
    expect(endpointScore(ep({}), 'POST', 'https://a.example/users/1')).toBeUndefined();
    expect(endpointScore(ep({}), 'GET', 'https://a.example/users/1/todos')).toBeUndefined();
    expect(endpointScore(ep({}), 'GET', 'https://a.example/xusers/1')).toBeUndefined();
    expect(endpointScore(ep({ pathTemplate: 'https://a.example/users/{id}' }), 'GET', 'https://a.example/users/1')).toBeDefined();
    expect(endpointScore(ep({ pathTemplate: 'https://a.example/users/{id}' }), 'GET', 'https://b.example/users/1')).toBeUndefined();
  });

  it('fixtureApiFor picks the class matching most exchanges, with imports', () => {
    const root = path.join(path.sep, 'ws');
    const eps = [
      ep({ responseModel: 'User', importUri: 'package:app/api/users_api.dart' }),
      ep({ dartMethod: 'getTodos', pathTemplate: '/users/{id}/todos', responseModel: 'Todo', importUri: 'package:app/api/users_api.dart' }),
      ep({ className: 'OtherApi', pathTemplate: '/users/{id}/todos' }),
    ];
    const models = [{ name: 'User', file: path.join(root, 'lib', 'models', 'user.dart') }, { name: 'Todo', file: path.join(root, 'test', 'todo.dart') }];
    const api = fixtureApiFor(eps, [{ method: 'GET', url: 'https://a/users/1' }, { method: 'GET', url: 'https://a/users/2' }], models, { root, packageName: 'app' });
    expect(api).toEqual({ className: 'UsersApi', imports: ['package:app/api/users_api.dart', 'package:app/models/user.dart'], endpoints: [eps[0], eps[1]] });
    expect(fixtureApiFor(eps, [{ method: 'DELETE', url: 'https://a/users/1' }], models, { root })).toBeUndefined();
    expect(packageUri(path.join(root, 'lib', 'a.dart'), root, undefined)).toBeUndefined();
  });

  it('testPackageFor: "test" only for pure Dart packages', () => {
    expect(testPackageFor('/p', () => 'name: cli\ndependencies:\n  http: ^1.0.0\n')).toBe('test');
    expect(testPackageFor('/p', () => 'name: app\ndependencies:\n  flutter:\n    sdk: flutter\n')).toBeUndefined();
    expect(testPackageFor('/p', () => {
      throw new Error('ENOENT');
    })).toBeUndefined();
    expect(testPackageFor(undefined)).toBeUndefined();
  });

  it('redactJsonValue keeps JsonDouble instances', () => {
    const d = new JsonDouble(1);
    const r = redactJsonValue({ a: d, list: [d], password: d }) as Record<string, unknown>;
    expect(r.a).toBe(d);
    expect((r.list as unknown[])[0]).toBe(d);
    expect(r.password).toBe('[redacted]');
  });
});

describe('REVIEW-4 #6: agent violations carry no values', () => {
  it('categorises every actual form the checker writes, without the value', () => {
    expect(['null', 'missing', 'string "SECRET"', 'a string ("x")', 'number 98234123', 'a number (98234123)', 'a bool (true)', 'true', 'unknown enum value "SECRET"', 'Invalid argument(s): `SECRET` is not one of … unknown enum', 'list', 'an object', '???'].map(actualCategory)).toEqual([
      'null', 'missing', 'string', 'string', 'number', 'number', 'bool', 'bool', 'unknown enum value', 'unknown enum value', 'list', 'object', 'other',
    ]);
  });

  it('never passes the checker message, numbers or backtick-quoted enum values', () => {
    const base = { model: 'S', expected: 'String', severity: 'error' as const, file: '/x.dart', line: 1 };
    const views = [
      violationForAgent({ ...base, path: '$.session', field: 'session', key: 'session', actual: 'a number (98234123)', message: 'session is a number (98234123)' }, { redact: true }),
      violationForAgent({ ...base, path: '$.access_token', field: 'accessToken', key: 'access_token', actual: 'unknown enum value', message: 'Invalid argument(s): `eyJSECRETVALUE` is not one of the supported values' }, { redact: true }),
      violationForAgent({ ...base, path: "$.sessions['k_9f2a'].x", field: 'x', key: 'x', actual: 'number 7', message: 'x is number 7' }, { redact: true }),
    ];
    const text = JSON.stringify(views);
    expect(text).not.toMatch(/98234123|SECRET|k_9f2a|\b7\b/);
    expect(views[2].path).toBe('$.sessions');
  });
});
