/**
 * Launches a real VS Code (downloaded by @vscode/test-electron) with:
 *  - this extension as the development extension,
 *  - a COPY of the user's installed Dart-Code in an isolated --extensions-dir under .vscode-test/
 *    (the user's real VS Code profile is never touched),
 *  - an isolated --user-data-dir,
 *  - a fresh copy of test/fixtures/dart_cli as the workspace.
 *
 * Env: FI_VSCODE_VERSION (default 'stable'), FI_RUNS (repeats per scenario, default 3),
 *      FI_DART_CODE_DIR (default ~/.vscode/extensions/dart-code.dart-code-3.144.0).
 */
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { downloadAndUnzipVSCode, runTests } from '@vscode/test-electron';

async function main(): Promise<void> {
  // When launched from a terminal/agent inside VS Code, these leak in: ELECTRON_RUN_AS_NODE turns
  // the test VS Code into plain Node, VSCODE_IPC_HOOK & co. could attach it to the user's instance.
  for (const key of Object.keys(process.env)) {
    if (key === 'ELECTRON_RUN_AS_NODE' || key.startsWith('VSCODE_')) delete process.env[key];
  }
  const extRoot = path.resolve(__dirname, '..');
  const testRoot = path.join(extRoot, '.vscode-test');
  const extensionsDir = path.join(testRoot, 'extensions');
  // Short path: the user-data-dir hosts IPC sockets, macOS limits socket paths to ~103 bytes.
  const userDataDir = path.join(os.tmpdir(), `fi-ud-${process.pid}`);
  const workspaceRoot = path.join(testRoot, 'workspace');

  // FI_VSIX=<file.vsix>: run against the packaged extension (unzipped) instead of the source tree.
  let devPath = extRoot;
  if (process.env.FI_VSIX) {
    const unpacked = path.join(testRoot, 'vsix-unpacked');
    fs.rmSync(unpacked, { recursive: true, force: true });
    fs.mkdirSync(unpacked, { recursive: true });
    execFileSync('unzip', ['-q', '-o', path.resolve(process.env.FI_VSIX), '-d', unpacked]);
    devPath = path.join(unpacked, 'extension');
    console.log(`[runTest] using packaged extension from ${process.env.FI_VSIX}`);
  }

  const dartCodeSrc = process.env.FI_DART_CODE_DIR ?? path.join(os.homedir(), '.vscode', 'extensions', 'dart-code.dart-code-3.144.0');
  const dartCodeDst = path.join(extensionsDir, path.basename(dartCodeSrc));
  if (!fs.existsSync(dartCodeSrc)) throw new Error(`Dart-Code not found at ${dartCodeSrc}`);
  if (!fs.existsSync(dartCodeDst)) {
    fs.mkdirSync(extensionsDir, { recursive: true });
    fs.cpSync(dartCodeSrc, dartCodeDst, { recursive: true });
  }
  // Let VS Code rebuild its extensions manifest from the folder contents.
  fs.rmSync(path.join(extensionsDir, 'extensions.json'), { force: true });

  const version = process.env.FI_VSCODE_VERSION ?? 'stable';
  let vscodeExecutablePath = await downloadAndUnzipVSCode({ version, cachePath: testRoot });
  // Recent macOS builds name the binary `Code`; @vscode/test-electron 2.5.x still expects `Electron`.
  if (!fs.existsSync(vscodeExecutablePath) && fs.existsSync(path.join(path.dirname(vscodeExecutablePath), 'Code'))) {
    vscodeExecutablePath = path.join(path.dirname(vscodeExecutablePath), 'Code');
  }
  console.log(`[runTest] VS Code: ${vscodeExecutablePath}`);

  const flutterRoot = path.join(os.homedir(), 'Documents', 'flutter');
  const dartSdk = path.join(flutterRoot, 'bin', 'cache', 'dart-sdk');
  // dart: Dart CLI fixture (any OS). flutter: Flutter fixture on the macOS desktop device.
  const suites = (process.env.FI_SUITE ?? (process.platform === 'darwin' ? 'dart,flutter' : 'dart')).split(',');
  fs.rmSync(workspaceRoot, { recursive: true, force: true });

  for (const suite of suites) {
    // devices: the real sample app in place (no copy: keeps its Gradle/Xcode caches warm).
    const fixture =
      suite === 'devices'
        ? path.resolve(extRoot, '..', '..', 'samples', 'demo_app')
        : path.join(workspaceRoot, suite === 'flutter' ? 'flutter_app' : 'dart_cli');
    if (suite !== 'devices') fs.cpSync(path.join(extRoot, 'test', 'fixtures', path.basename(fixture)), fixture, { recursive: true });
    if (suite === 'devices') {
      if (!process.env.FI_DEVICES) throw new Error('FI_DEVICES=<deviceId,...> is required for the devices suite');
      if (!fs.existsSync(path.join(fixture, '.dart_tool', 'package_config.json'))) {
        execFileSync('flutter', ['pub', 'get', '--offline'], { cwd: fixture, stdio: 'inherit' });
      }
    } else if (suite === 'flutter') {
      execFileSync('flutter', ['create', '--platforms=macos', '--offline', '--project-name', 'fi_flutter_app', '.'], { cwd: fixture, stdio: 'inherit' });
      // The macOS sandbox blocks outgoing connections (even to localhost) without this entitlement.
      for (const f of ['DebugProfile.entitlements', 'Release.entitlements']) {
        const plist = path.join(fixture, 'macos', 'Runner', f);
        const buddy = '/usr/libexec/PlistBuddy';
        try {
          execFileSync(buddy, ['-c', 'Add :com.apple.security.network.client bool true', plist], { stdio: 'pipe' });
        } catch {
          execFileSync(buddy, ['-c', 'Set :com.apple.security.network.client true', plist], { stdio: 'pipe' });
        }
      }
      execFileSync('flutter', ['pub', 'get', '--offline'], { cwd: fixture, stdio: 'inherit' });
    } else {
      execFileSync('dart', ['pub', 'get', '--offline'], { cwd: fixture, stdio: 'inherit' });
    }

    fs.rmSync(userDataDir, { recursive: true, force: true });
    fs.mkdirSync(path.join(userDataDir, 'User'), { recursive: true });
    fs.writeFileSync(
      path.join(userDataDir, 'User', 'settings.json'),
      JSON.stringify(
        {
          'telemetry.telemetryLevel': 'off',
          'update.mode': 'none',
          'extensions.autoUpdate': false,
          'extensions.autoCheckUpdates': false,
          'workbench.startupEditor': 'none',
          'security.workspace.trust.enabled': false,
          'dart.checkForSdkUpdates': false,
          'dart.promptToRunIfErrors': false,
          'dart.showTodos': false,
          'dart.notifyAnalyzerErrors': false,
          'dart.allowAnalytics': false,
          'dart.openDevTools': 'never',
          'dart.devToolsBrowser': 'default',
          ...(fs.existsSync(dartSdk) ? { 'dart.sdkPath': dartSdk, 'dart.flutterSdkPath': flutterRoot } : {}),
        },
        null,
        2,
      ),
    );

    const resultsFile = path.join(testRoot, `results-${suite}.json`);
    fs.rmSync(resultsFile, { force: true });
    console.log(`[runTest] suite ${suite}: ${fixture}`);
    try {
      await runTests({
        vscodeExecutablePath,
        extensionDevelopmentPath: devPath,
        extensionTestsPath: path.join(extRoot, 'dist-test', 'suite', 'index.js'),
        launchArgs: [
          fixture,
          '--extensions-dir',
          extensionsDir,
          '--user-data-dir',
          userDataDir,
          '--disable-workspace-trust',
          '--skip-welcome',
          '--skip-release-notes',
          '--disable-telemetry',
        ],
        extensionTestsEnv: {
          FI_SUITE: suite,
          FI_FIXTURE: fixture,
          FI_RUNS: process.env.FI_RUNS ?? '3',
          FI_FLUTTER_RUNS: process.env.FI_FLUTTER_RUNS ?? '1',
          FI_DEVICES: process.env.FI_DEVICES ?? '',
          FI_ALLOW_PHYSICAL_IOS: process.env.FI_ALLOW_PHYSICAL_IOS ?? '',
          FI_RESULTS: resultsFile,
        },
      });
    } finally {
      fs.rmSync(userDataDir, { recursive: true, force: true });
    }
  }
}

main().catch((err) => {
  console.error('[runTest] FAILED:', err);
  process.exit(1);
});
