# Spike: app screenshots for agents (0.7.0, CONTRACTS §13.8)

Date: 2026-10-10. Flutter 3.47.6 (Impeller on every target below), Dart-Code 3.144.0 for the device suite.
Devices: Android emulator (API 36, 1080×2400), an iPhone 17 Pro simulator (1206×2622), macOS desktop
(800×600 window on a 2× display). The calls went through the same `callService` custom request Dart-Code's debug
adapter answers (scratch DAP client first, then the real extension in the device suite, check I).

## Verdict

| Route | Android emulator | iOS simulator | macOS | Notes |
|---|---|---|---|---|
| `_flutter.screenshot` (engine, VM service) | ❌ | ❌ | ❌ | `-32000 Could not capture image screenshot.` with Impeller, through the DAP and through a direct WebSocket alike |
| `ext.flutter.inspector.screenshot` of the root widget | ✅ 900×2000, 131 KB | ✅ 920×2000, 124 KB | ✅ 1600×1200, 208 KB | 20–250 ms; Flutter content only |
| `adb -s <id> exec-out screencap -p` | ✅ 1080×2400 | – | – | ~0.6 s; the real screen (status bar, keyboard, native dialogs) |
| `xcrun simctl io <udid> screenshot <file>` | – | ✅ 1206×2622, 2.4 MB | – | ~1.2 s; the real screen |

Built: VM service first (the inspector route, then `_flutter.screenshot` for Skia builds), then `adb` (Android) or
`simctl` (iOS simulators). Other devices (macOS / Linux / Windows desktop, web, physical iOS) get
`ScreenshotUnsupportedError` ("… are not supported: only Android devices / emulators and iOS simulators, or any app
whose Flutter VM service can render one (debug sessions) (<reasons>)") when the VM route fails. In practice the VM
route works in every debug session, so macOS desktop and physical iPhones (not tried) are covered too.

## The inspector route

Three calls on the main isolate (`getVM` → the isolate named `main`, else the first non-system one):
1. `ext.flutter.inspector.getRootWidget {isolateId, objectGroup: 'flutter-intercept-screenshot'}` →
   `{result: {valueId: 'inspector-0', description: '[root]', …}}`.
2. `ext.flutter.inspector.screenshot {isolateId, id: 'inspector-0', width: '2000', height: '2000',
   maxPixelRatio: '1', margin: '0', debugPaint: 'false'}` → `{result: '<base64 PNG>'}`. The framework renders the
   render object's layer again (`OffsetLayer.toImage`), which works with Impeller.
3. `ext.flutter.inspector.disposeGroup {isolateId, objectGroup}` (always, fire and forget).

Sizing: at the root the render bounds are the `RenderView`'s paint bounds, which are in **physical** pixels, so
`pixelRatio = min(maxPixelRatio, width / boundsW, height / boundsH)` is relative to the device resolution. With
`maxPixelRatio: 1` and a 2000 px box, the result is the device resolution, scaled down to fit 2000×2000:
measured 900×2000 (Android, 1080×2400 physical), 920×2000 (iPhone, 1206×2622), and on the macOS window (1600×1200
physical) 1600×1200 with `maxPixelRatio: 1` but an upscaled 2000×1500 with 2. Agents' image inputs are downscaled further anyway.

What it shows: exactly the app's Flutter frame, including the DEBUG banner. **Not** the status bar, the
keyboard, platform views (maps, web views) or native dialogs (permission prompts). The device tools show those,
so they stay as fallbacks. The VM route is first anyway because it works on every debug target, needs no SDK tool,
and its PNGs are ~10× smaller.

Debug sessions only: the inspector extensions are registered in debug builds. In profile mode Dart-Code's
`callService` answers with no body (no VM connection in the DAP); the code treats that as a failure and goes on to
the device tool.

## The device tools

- `adb`: `locateAdb()` (ANDROID_HOME, ANDROID_SDK_ROOT, the OS default SDK, PATH), argument array
  `['-s', id, 'exec-out', 'screencap', '-p']`, `maxBuffer` 16 MB + 1, PNG signature + IHDR checked.
- `simctl`: `xcrun simctl io <udid> screenshot --type=png <tmp>/screenshot.png` in a fresh `mkdtemp` folder,
  `lstat` (regular file, ≤ 16 MB), read, folder removed. `-` as the path does **not** write to stdout (it creates a
  file named `-`).
- Device ids are validated before any tool runs: UUID → iOS simulator; `00008xxx-<16 hex>` / 40 hex → physical
  iOS (no tool); `macos` / `linux` / `windows` → desktop; `chrome` / `edge` / `web-server` → web; otherwise an adb
  serial matching `^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$` (so nothing starting with `-`). Anything else: no tool.

## Saving

`<project>/.dart_tool/flutter_intercept/screenshots/<ISO timestamp>.png` (`-2`, `-3`, … for the same ms) through
`ensureDirInside` from `agent/har.ts` (every component `lstat`ed and realpath-checked, created one at a time, no
symlinks), written with `wx` and mode 0600 in a 0700 folder, ≤ 16 MB. Only the newest 50 are kept: after each
write, older files matching our own name pattern are deleted (REVIEW-7 #13: app screens show personal data and
one-time codes). Width / height come from the IHDR chunk.

## API (src/screenshot/index.ts)

- `takeScreenshot: TakeScreenshot` (CONTRACTS §13.8 types), `takeScreenshotWith(target, deps, {adbPath?, now?})`.
- `ScreenshotUnsupportedError`, `pngSize(buf)`, `deviceKind(id)`, `saveScreenshot(root, png, now?)`,
  `pruneScreenshots(dir, keep?)`, `SCREENSHOT_DIR`, `MAX_SCREENSHOT_BYTES`, `MAX_SCREENSHOTS`, `MAX_VM_EDGE`.
- `callService` for the host: `VmWatcherHandle.callService(sessionId, method, params)` (the object
  `createVmWatcher` returns, for any Dart debug session it has seen), or `vmCallService(session, method, params)`
  for a `vscode.DebugSession` in hand. Both reject when the adapter answers without a body (profile mode).

Host wiring:

```ts
const shot = await takeScreenshot(
  { sessionId: session.id, deviceId: session.configuration.deviceId, projectRoot },
  { callService: (id, m, p) => vm.callService(id, m, p), exec: execFileBuffer, log },
);
```

`exec` must return stdout as a `Buffer` (`execFile(cmd, args, {encoding: 'buffer', timeout, maxBuffer})`).

## Not covered

- Flutter Web (DWDS): not tried; the inspector route may work through Dart-Code there, otherwise "not supported".
- Physical iPhone / Android device: same code paths as the simulator / emulator (VM route, adb), not run here.
