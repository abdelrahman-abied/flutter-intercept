import { describe, expect, it } from 'vitest';
import {
  checkDeviceHealth,
  detectStartFailure,
  deviceToolPatterns,
  hardExec,
  runWithWatchdog,
  tailOf,
  TimeoutError,
  waitForMarker,
  WaitError,
  withTimeout,
} from '../integration/suite/deviceGuard';

const tools = { adb: '/sdk/platform-tools/adb', xcrun: '/usr/bin/xcrun' };

describe('detectStartFailure', () => {
  it('finds the Gradle failure of a refused AGP version', () => {
    const out = [
      'Launching lib/main.dart on sdk gphone64 arm64 in debug mode...',
      "Running Gradle task 'assembleDebug'...",
      "Error: Your project's Android Gradle Plugin version (9.1.0) is not supported.",
      "Error: Gradle task assembleDebug failed with exit code 1",
    ].join('\n');
    expect(detectStartFailure(out)).toBe("Error: Your project's Android Gradle Plugin version (9.1.0) is not supported.");
  });

  it('finds older-style Gradle and Xcode failures and Dart compile errors', () => {
    expect(detectStartFailure("Running Gradle task 'assembleDebug'...\nException: Gradle task assembleDebug failed with exit code 1\n")).toMatch(/Gradle task assembleDebug failed/);
    expect(detectStartFailure('Running Xcode build...\nXcode build done.\nCould not build the application for the simulator.\n')).toBe('Could not build the application for the simulator.');
    expect(detectStartFailure('Running Xcode build...\nError (Xcode): Undefined symbol: _foo\n')).toBe('Error (Xcode): Undefined symbol: _foo');
    expect(detectStartFailure('lib/main.dart:12:3: Error: Expected a statement.\n')).toBe('lib/main.dart:12:3: Error: Expected a statement.');
    expect(detectStartFailure('Unable to launch com.example.demoApp on 1234:\nProcessException: …\n')).toMatch(/^Unable to launch/);
    expect(detectStartFailure('FAILURE: Build failed with an exception.\n')).toMatch(/^FAILURE/);
  });

  it('ignores a healthy launch and everything the app prints', () => {
    const healthy = [
      'Launching .dart_tool/flutter_intercept/entry_lib__main.dart on iPhone 16 in debug mode...',
      'Running Xcode build...',
      'Xcode build done.                                           12.3s',
      'Connecting to VM Service at ws://127.0.0.1:50123/abc=/ws',
      'flutter: DEMO_START',
      'flutter: DEMO_RESULT http_todo ERR ms=12 Exception: SocketException: Failed host lookup',
      'Error: something the app printed after it started',
    ].join('\n');
    expect(detectStartFailure(healthy)).toBeUndefined();
    // App lines before DEMO_START are skipped too.
    expect(detectStartFailure('I/flutter ( 4321): Exception: from the app\nflutter: Error: from the app\n')).toBeUndefined();
    expect(detectStartFailure('[flutter_intercept] Error: note\n')).toBeUndefined();
    expect(detectStartFailure('')).toBeUndefined();
  });
});

describe('tailOf', () => {
  it('keeps the last 20 non-empty lines', () => {
    const text = Array.from({ length: 50 }, (_, i) => `line ${i}`).join('\n\n');
    const t = tailOf(text);
    expect(t.split('\n')).toHaveLength(20);
    expect(t.startsWith('line 30')).toBe(true);
    expect(t.endsWith('line 49')).toBe(true);
  });

  it('cuts to 2 KB from the end, without a broken character', () => {
    const t = tailOf(`${'é'.repeat(5000)}\nlast line`);
    expect(Buffer.byteLength(t, 'utf8')).toBeLessThanOrEqual(2048);
    expect(t.startsWith('…')).toBe(true);
    expect(t).not.toContain('�');
    expect(t.endsWith('last line')).toBe(true);
  });
});

/** A fake clock: sleep advances time instantly. */
function clock() {
  let t = 0;
  return { now: () => t, sleep: async (ms: number) => void (t += ms) };
}

describe('waitForMarker', () => {
  it('resolves with the output after `from` once the marker is there', async () => {
    const c = clock();
    let out = 'old DEMO_BATCH done\n';
    const from = out.length;
    let polls = 0;
    const text = await waitForMarker({
      output: () => (++polls === 3 ? (out += 'flutter: DEMO_START\nflutter: DEMO_BATCH done\n') : out),
      ended: () => false,
      marker: /DEMO_BATCH done/,
      label: 'DEMO_BATCH done',
      from,
      timeoutMs: 600_000,
      ...c,
    });
    expect(text).toBe('flutter: DEMO_START\nflutter: DEMO_BATCH done\n');
  });

  it('fails at once when the session ended, quoting the output tail', async () => {
    const c = clock();
    const p = waitForMarker({
      output: () => 'Launching lib/main.dart...\nsomething went wrong\n',
      ended: () => true,
      marker: /DEMO_BATCH done/,
      label: 'DEMO_BATCH done',
      timeoutMs: 600_000,
      ...c,
    });
    await expect(p).rejects.toThrow(/the debug session ended before "DEMO_BATCH done" \(after \d+ s\); last output:\nLaunching lib\/main.dart...\nsomething went wrong/);
    await expect(p).rejects.toMatchObject({ kind: 'ended' });
    expect(c.now()).toBeLessThan(5_000);
  });

  it('still succeeds when the marker arrives in the trailing output after the end', async () => {
    const c = clock();
    let n = 0;
    const text = await waitForMarker({
      output: () => (++n > 2 ? 'DEMO_BATCH done' : ''),
      ended: () => true,
      marker: /DEMO_BATCH done/,
      label: 'x',
      timeoutMs: 1000,
      ...c,
    });
    expect(text).toBe('DEMO_BATCH done');
  });

  it('fails fast on a build failure while the session is still alive', async () => {
    const c = clock();
    const err = await waitForMarker({
      output: () => "Running Gradle task 'assembleDebug'...\nError: Gradle task assembleDebug failed with exit code 1\n",
      ended: () => false,
      marker: /DEMO_BATCH done/,
      label: 'DEMO_BATCH done',
      timeoutMs: 600_000,
      ...c,
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(WaitError);
    expect((err as WaitError).kind).toBe('start-failed');
    expect((err as WaitError).message).toMatch(/the app failed to build or start \("Error: Gradle task assembleDebug failed with exit code 1"\)/);
    expect(c.now()).toBeLessThanOrEqual(11_000); // the failure grace, not the 10-minute bound
  });

  it('stops when the case is aborted and otherwise at the timeout', async () => {
    const c1 = clock();
    await expect(
      waitForMarker({ output: () => '', ended: () => false, aborted: () => 'watchdog', marker: /x/, label: 'x', timeoutMs: 600_000, ...c1 }),
    ).rejects.toMatchObject({ kind: 'aborted' });
    const c2 = clock();
    const err = (await waitForMarker({ output: () => 'Running Xcode build...', ended: () => false, marker: /x/, label: 'x', timeoutMs: 10_000, ...c2 }).catch((e: unknown) => e)) as WaitError;
    expect(err.kind).toBe('timeout');
    expect(err.message).toMatch(/^timed out after 10 s before "x" .*last output:\nRunning Xcode build\.\.\.$/s);
  });
});

describe('withTimeout / runWithWatchdog', () => {
  it('withTimeout passes values through and rejects a hung call', async () => {
    await expect(withTimeout(Promise.resolve(3), 50, 'x')).resolves.toBe(3);
    await expect(withTimeout(new Promise(() => undefined), 20, 'stopDebugging(A)')).rejects.toThrow(TimeoutError);
    await expect(withTimeout(new Promise(() => undefined), 20, 'stopDebugging(A)')).rejects.toThrow('stopDebugging(A) did not return within 0 s');
  });

  it('runWithWatchdog returns the body result or its error', async () => {
    expect(await runWithWatchdog(1000, async () => 7, async () => undefined)).toEqual({ ok: true, value: 7 });
    const r = await runWithWatchdog(1000, async () => Promise.reject(new Error('boom')), async () => undefined);
    expect(r).toMatchObject({ ok: false, timedOut: false });
  });

  it('runWithWatchdog aborts a hung body and runs the cleanup', async () => {
    let cleaned = '';
    let seen: { aborted?: string } | undefined;
    const r = await runWithWatchdog(
      20,
      (state) => {
        seen = state;
        return new Promise(() => undefined);
      },
      async (reason) => void (cleaned = reason),
    );
    expect(r).toMatchObject({ ok: false, timedOut: true });
    expect(cleaned).toMatch(/^watchdog: the case did not finish within/);
    expect(seen?.aborted).toBe(cleaned);
  });
});

describe('checkDeviceHealth', () => {
  it('probes adb and simctl with their bounds; macOS / others are not probed', async () => {
    const calls: [string, string[], number][] = [];
    const exec = async (file: string, args: string[], ms: number) => {
      calls.push([file, args, ms]);
      return { code: 0, stdout: file.endsWith('adb') ? 'ok\n' : '/Users/x/Library/Developer/CoreSimulator/Devices/ABC/data\n', stderr: '' };
    };
    expect(await checkDeviceHealth('android', 'emulator-5554', tools, exec)).toBeUndefined();
    expect(await checkDeviceHealth('ios-simulator', 'ABC', tools, exec)).toBeUndefined();
    expect(await checkDeviceHealth('other', 'macos', tools, exec)).toBeUndefined();
    expect(calls).toEqual([
      [tools.adb, ['-s', 'emulator-5554', 'shell', 'echo', 'ok'], 10_000],
      [tools.xcrun, ['simctl', 'getenv', 'ABC', 'HOME'], 30_000],
    ]);
  });

  it('reports a hung, failing or silent device', async () => {
    const hung = async (): Promise<never> => Promise.reject(new TimeoutError('/usr/bin/xcrun simctl getenv ABC HOME did not return within 30 s'));
    expect(await checkDeviceHealth('ios-simulator', 'ABC', tools, hung)).toBe('device not responding: xcrun simctl getenv ABC HOME did not return within 30 s');
    const offline = async () => ({ code: 1, stdout: '', stderr: "adb: device 'emulator-5554' not found\n" });
    expect(await checkDeviceHealth('android', 'emulator-5554', tools, offline)).toBe("device not responding: adb -s emulator-5554 shell echo ok exited 1: adb: device 'emulator-5554' not found");
    const silent = async () => ({ code: 0, stdout: '', stderr: '' });
    expect(await checkDeviceHealth('android', 'emulator-5554', tools, silent)).toMatch(/^device not responding: .*<no output>$/);
  });
});

describe('deviceToolPatterns / hardExec', () => {
  it('targets only the device', () => {
    expect(deviceToolPatterns('ios-simulator', 'AB12-CD')).toEqual(['simctl .*AB12-CD']);
    expect(deviceToolPatterns('android', 'emulator-5554')).toEqual(['adb -s emulator-5554 ']);
    expect(deviceToolPatterns('android', '203.0.113.5:5555')).toEqual(['adb -s 203\\.0\\.113\\.5:5555 ']);
    expect(deviceToolPatterns('other', 'macos')).toEqual([]);
  });

  it('hardExec returns output and kills a process that outlives its bound', async () => {
    await expect(hardExec('/bin/echo', ['ok'], 5_000)).resolves.toMatchObject({ code: 0, stdout: 'ok\n' });
    const t0 = Date.now();
    await expect(hardExec('/bin/sleep', ['10'], 200)).rejects.toThrow(/did not return within 0 s/);
    expect(Date.now() - t0).toBeLessThan(3_000);
  });
});
