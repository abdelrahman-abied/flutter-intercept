import { describe, expect, it } from 'vitest';
import { createPathDecision } from '../../src/rules/createPolicy';

const kind = (p: string) => createPathDecision(p).kind;

describe('createPathDecision', () => {
  it('allows our own folder silently', () => {
    expect(kind('.vscode/flutter-intercept/mocks/users.json')).toBe('allow');
    expect(kind('.vscode\\flutter-intercept\\scripts\\auth.js')).toBe('allow');
    expect(kind('.vscode/flutter-intercept/mocks/run.sh')).toBe('refuse');
  });

  it('refuses build, platform, VCS, IDE and tool configuration', () => {
    for (const p of [
      'android/buildSrc/build.gradle', 'android/app/src/main/AndroidManifest.xml', 'ios/Runner/Info.plist', 'macos/x.json', 'linux/CMakeLists.txt', 'windows/runner/main.cpp',
      'web/index.html', 'app/web/index.html', 'build.gradle', 'settings.gradle.kts', 'tool/x.kts', 'pubspec.yaml', 'pubspec_overrides.yaml', 'packages/a/pubspec.yaml',
      'analysis_options.yaml', 'build.yaml', '.git/hooks/pre-commit', '.idea/workspace.xml', '.github/workflows/ci.yml', '.vscode/tasks.json', '.vscode/settings.json',
      '.vscode/flutter-intercept.json', '.env', 'Makefile', 'scripts/deploy.sh', 'run.bat', 'hook/build.dart', 'buildSrc/a.json', 'Android/App/x.json',
    ]) expect(kind(p), p).toBe('refuse');
  });

  it('refuses non-relative paths', () => {
    for (const p of ['', '/etc/passwd', 'C:\\x.json', '../x.json', 'a/../../x.json', 'a\0b']) expect(kind(p), p).toBe('refuse');
  });

  it('asks for anything else', () => {
    for (const p of ['assets/mock.json', 'test/fixtures/user.json', 'lib/mocks/x.json', 'mocks/ok.js']) expect(kind(p), p).toBe('confirm');
  });
});
