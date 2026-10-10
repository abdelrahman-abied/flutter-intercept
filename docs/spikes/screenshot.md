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

## 0.8.0: physical iPhones (CONTRACTS §14.7)

Order for a physical iPhone (`00008xxx-…` / 40-hex UDID), macOS only, after the VM route (kept first, as for every
device: Flutter content only, ~10× smaller PNGs, works in every debug session):
1. `xcrun devicectl device capture screenshot --quiet --device <udid> --destination <tmp>/screenshot.png` —
   Xcode's CoreDevice tool (present in Xcode 27; older Xcodes have no `capture` subcommand, which fails fast and
   falls through). Checked against the booted iPhone 17 Pro simulator, which devicectl also lists: 1206×2622 PNG
   in 1.26 s. Not run on a physical iPhone (none connected).
2. `idevicescreenshot -u <udid> <tmp>/screenshot.png` (libimobiledevice) when installed: PATH, then
   `/opt/homebrew/bin`, `/usr/local/bin` (VS Code started from the Dock has a minimal PATH). Flutter ships a copy in
   `bin/cache/artifacts/libimobiledevice/`, but it is x86_64-only and its dylibs are found only through the
   tool's `DYLD_LIBRARY_PATH`; on this Apple Silicon Mac without Rosetta it fails with "bad CPU type", so PATH
   entries under `bin/cache/artifacts/` are skipped. Old iOS versions answer TIFF: refused as "not a PNG". Needs
   the developer disk image mounted (true after any Xcode run on the device). Not installed here: unit-tested with
   fakes only.
Both write into a fresh `mkdtemp` folder that is removed afterwards; the file is `lstat`ed (regular, ≤ 16 MB) and
checked for the PNG signature; the result is saved with the REVIEW-7 rules (0600 in a 0700 folder, newest 50 kept).
Failures list every route ("devicectl: …; idevicescreenshot: not installed"). Deviation from the spec's wording
("idevicescreenshot when installed, else the VM route"): the VM route stays first for consistency with Android /
simulators, and devicectl comes before idevicescreenshot because it needs no extra install and supports current
iOS through CoreDevice.

`Screenshot.method` needs `'devicectl'` as well (lead-owned `src/screenshot/types.ts` has `'idevicescreenshot'`; the code
casts until then).
