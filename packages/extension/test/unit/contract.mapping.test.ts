import { describe, expect, it } from 'vitest';
import type { XEndpoint } from '../../src/contract/api';
import { bestEndpoint, endpointsFromFrames, frameMethod, matchEndpoint, pathTemplate, routeKey, splitUrl } from '../../src/contract/mapping';

const ep = (p: Partial<XEndpoint>): XEndpoint => ({
  method: 'GET',
  pathTemplate: '/',
  dartMethod: 'm',
  file: '/w/lib/api.dart',
  line: 1,
  apiClass: 'Api',
  kind: 'retrofit',
  rawPath: '/',
  ...p,
});

describe('route keys', () => {
  it('templates ids and drops origin and query', () => {
    expect(routeKey('get', 'https://api.example.com/users/42?x=1')).toBe('GET /users/{id}');
    expect(routeKey('GET', 'https://a.b/users/42/posts/7')).toBe('GET /users/{id}/posts/{id2}');
    expect(pathTemplate('/o/507f1f77bcf86cd799439011/x/3fa85f64-5717-4562-b3fc-2c963f66afa6')).toBe('/o/{id}/x/{id2}');
    expect(pathTemplate('/users/me')).toBe('/users/me');
    expect(splitUrl('https://API.example.com:443/a?b')).toEqual({ origin: 'https://api.example.com', path: '/a' });
    expect(splitUrl('not a url')).toBeUndefined();
  });
});

describe('path template matching', () => {
  const byId = ep({ pathTemplate: '/users/{id}', baseUrl: 'https://jsonplaceholder.typicode.com', dartMethod: 'getUser' });
  const me = ep({ pathTemplate: '/users/me', baseUrl: 'https://jsonplaceholder.typicode.com', dartMethod: 'me' });
  const noBase = ep({ pathTemplate: '/users/{id}', dartMethod: 'noBase' });

  it('matches with a known base, by method and segment count', () => {
    expect(matchEndpoint(byId, 'GET', 'https://jsonplaceholder.typicode.com/users/1')).toBeDefined();
    expect(matchEndpoint(byId, 'POST', 'https://jsonplaceholder.typicode.com/users/1')).toBeUndefined();
    expect(matchEndpoint(byId, 'GET', 'https://jsonplaceholder.typicode.com/users/1/todos')).toBeUndefined();
    expect(matchEndpoint(byId, 'GET', 'https://jsonplaceholder.typicode.com/users/')).toBeUndefined();
  });

  it('literal segments beat parameters; a matched origin beats a suffix match', () => {
    expect(bestEndpoint([byId, me], 'GET', 'https://jsonplaceholder.typicode.com/users/me')?.endpoint.dartMethod).toBe('me');
    expect(bestEndpoint([noBase, byId], 'GET', 'https://jsonplaceholder.typicode.com/users/3')?.endpoint.dartMethod).toBe('getUser');
    // unknown base: the template matches the end of the path
    expect(bestEndpoint([noBase], 'GET', 'https://staging.example.com/api/v2/users/3')?.endpoint.dartMethod).toBe('noBase');
    expect(bestEndpoint([byId], 'GET', 'https://other.example.com/users/3')?.endpoint.dartMethod).toBe('getUser');
  });

  it('mixed segments and encoded literals', () => {
    const file = ep({ pathTemplate: '/files/{name}.json' });
    expect(matchEndpoint(file, 'GET', 'https://x.y/files/report.json')).toBeDefined();
    expect(matchEndpoint(file, 'GET', 'https://x.y/files/report.xml')).toBeUndefined();
    const spaced = ep({ pathTemplate: '/a b' });
    expect(matchEndpoint(spaced, 'GET', 'https://x.y/a%20b')).toBeDefined();
  });
});

describe('source frames', () => {
  it('reads Class.method out of closures', () => {
    expect(frameMethod('_UsersApi.getUser.<anonymous closure>')).toEqual({ cls: '_UsersApi', method: 'getUser' });
    expect(frameMethod('_$ItemService.getItem')).toEqual({ cls: '_$ItemService', method: 'getItem' });
    expect(frameMethod('main')).toBeUndefined();
  });

  it('finds endpoints through frames in generated Retrofit / Chopper classes', () => {
    const a = ep({ apiClass: 'UsersApi', dartMethod: 'getUser', file: '/w/lib/api/users_api.dart' });
    const b = ep({ apiClass: 'UsersApi', dartMethod: 'getUser', file: '/w/pkg/other/users_api2.dart' });
    const c = ep({ apiClass: 'ItemService', dartMethod: 'getItem', kind: 'chopper', file: '/w/lib/chop.dart' });
    const classes = [
      { generated: '_UsersApi', api: 'UsersApi', file: '/w/pkg/other/users_api2.g.dart' },
      { generated: '_UsersApi', api: 'UsersApi', file: '/w/lib/api/users_api.g.dart' },
      { generated: '_$ItemService', api: 'ItemService', file: '/w/lib/chop.chopper.dart' },
    ];
    const frames = [
      { fn: 'Dio.fetch', uri: 'package:dio/src/dio_mixin.dart', line: 1 },
      { fn: '_UsersApi.getUser', uri: 'package:app/api/users_api.g.dart', line: 40 },
      { fn: 'main', uri: 'package:app/main.dart', line: 3 },
    ];
    expect(endpointsFromFrames(frames, classes, [b, a, c])).toEqual([a, b]);
    expect(endpointsFromFrames([{ fn: '_$ItemService.getItem', uri: 'package:app/chop.chopper.dart' }], classes, [a, b, c])).toEqual([c]);
    // frames outside generated files never map
    expect(endpointsFromFrames([{ fn: '_UsersApi.getUser', uri: 'package:app/api/users_api.dart' }], classes, [a])).toEqual([]);
  });
});
