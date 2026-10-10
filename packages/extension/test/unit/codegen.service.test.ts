import * as path from 'path';
import { describe, expect, it } from 'vitest';
import { parsePubspecDeps } from '../../src/codegen/pubspec';
import { isIdSegment, routeTemplate } from '../../src/codegen/route';
import { createCodegenService } from '../../src/codegen/service';

describe('routeTemplate', () => {
  it.each([
    ['/users/42', '/users/{id}'],
    ['/users/42/posts/7', '/users/{id}/posts/{id2}'],
    ['https://api.example.com/users/42?expand=1#x', 'https://api.example.com/users/{id}'],
    ['https://api.example.com', 'https://api.example.com/'],
    ['https://api.example.com/', 'https://api.example.com/'],
    ['/orders/550e8400-e29b-41d4-a716-446655440000', '/orders/{id}'],
    ['/objects/507f1f77bcf86cd799439011', '/objects/{id}'],
    ['/commits/9fceb02', '/commits/9fceb02'], // too short for hex
    ['/commits/9fceb02d', '/commits/{id}'],
    ['/files/01ARZ3NDEKTSV4RRFFQ69G5FAV', '/files/{id}'],
    ['/t/dGhpcyBpcyBhIHRva2VuMTIz==', '/t/{id}'],
    ['/v2/users/me', '/v2/users/me'],
    ['/api/v1/categories/electronics', '/api/v1/categories/electronics'],
    ['/users/-1', '/users/{id}'],
    ['/users/42/', '/users/{id}/'],
    ['/a%2Fb/12', '/a%2Fb/{id}'],
    ['', ''],
  ])('%s → %s', (url, t) => {
    expect(routeTemplate(url)).toBe(t);
  });

  it('decides ids by segment', () => {
    expect(isIdSegment('deadbeefdeadbeef')).toBe(true);
    expect(isIdSegment('abcdef')).toBe(false);
    expect(isIdSegment('settings')).toBe(false);
    expect(isIdSegment('')).toBe(false);
  });
});

describe('pubspec detection', () => {
  const PUBSPEC = `name: my_app # the app
description: "A # in quotes"
environment:
  sdk: ^3.8.0

dependencies:
  flutter:
    sdk: flutter
  dio: ^5.9.0
  freezed_annotation: ^3.1.0 # models
  json_annotation: ^4.9.0

dev_dependencies:
  flutter_test:
    sdk: flutter
  build_runner: ^2.4.0
  "mocktail": ^1.0.4
  http_mock_adapter:
    path: ../hma

dependency_overrides:
  json_serializable: 6.0.0
flutter:
  uses-material-design: true
`;

  it('reads names and both dependency sections, ignoring nested keys and overrides', () => {
    const d = parsePubspecDeps(PUBSPEC);
    expect(d.name).toBe('my_app');
    expect([...d.dependencies]).toEqual(['flutter', 'dio', 'freezed_annotation', 'json_annotation']);
    expect([...d.devDependencies]).toEqual(['flutter_test', 'build_runner', 'mocktail', 'http_mock_adapter']);
  });

  const svc = (files: Record<string, string>) => createCodegenService({ readFile: (f) => files[f] });
  const at = (text: string) => ({ [path.join('/p', 'pubspec.yaml')]: text });
  const deps = (runtime: string[], dev: string[] = []) =>
    at(`name: x\ndependencies:\n${runtime.map((d) => `  ${d}: any\n`).join('')}dev_dependencies:\n${dev.map((d) => `  ${d}: any\n`).join('')}`);

  it('model style: freezed > json_serializable > plain', () => {
    expect(svc(deps(['freezed_annotation', 'json_annotation'], ['freezed', 'json_serializable'])).detectModelStyle('/p')).toBe('freezed');
    expect(svc(deps([], ['freezed'])).detectModelStyle('/p')).toBe('freezed');
    expect(svc(deps(['json_annotation'], ['json_serializable'])).detectModelStyle('/p')).toBe('json_serializable');
    expect(svc(deps(['dio'])).detectModelStyle('/p')).toBe('plain');
    expect(svc({}).detectModelStyle('/p')).toBe('plain');
  });

  it('fixture style: http_mock_adapter > mocktail > mock_client', () => {
    expect(svc(deps(['dio'], ['mocktail', 'http_mock_adapter'])).detectFixtureStyle('/p')).toBe('http_mock_adapter');
    expect(svc(deps(['dio'], ['mocktail'])).detectFixtureStyle('/p')).toBe('mocktail');
    expect(svc(deps(['http'], ['flutter_test'])).detectFixtureStyle('/p')).toBe('mock_client');
    expect(svc({}).detectFixtureStyle('/p')).toBe('mock_client');
  });
});

describe('createCodegenService', () => {
  it('wires the generators and routeTemplate', () => {
    const s = createCodegenService({ readFile: () => undefined });
    expect(s.routeTemplate('https://a.dev/users/1')).toBe('https://a.dev/users/{id}');
    expect(s.generateModels({ samples: [{ id: 1 }], rootName: 'User', style: 'plain' })[0].path).toBe('lib/models/user.dart');
    const files = s.generateFixtureTest({
      exchanges: [{ id: '1', startedAt: 0, method: 'GET', url: 'https://a.dev/u', requestHeaders: {}, status: 200, responseBody: { text: '{}', encoding: 'utf8' }, state: 'completed' }],
      style: 'mock_client',
      name: 'get_u',
    });
    expect(files.map((f) => f.path)).toEqual(['test/fixtures/get_u_1.json', 'test/get_u_test.dart']);
  });

  it('reads pubspec.yaml from disk by default', () => {
    const s = createCodegenService();
    expect(s.detectModelStyle(path.join(__dirname, 'no-such-project'))).toBe('plain');
  });
});
