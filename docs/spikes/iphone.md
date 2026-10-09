# Spike — real iPhone (LAN mode, CONTRACTS §7)

Date 2026-10-09 · Flutter 3.47.6 / Dart 3.13.5 / Xcode 27.0 · Agent A
Device: iPhone 16 Pro Max, iOS 27.0.1, `00008110-000A1B2C3D4E5F60`, **paired over Wi-Fi** ("My iPhone (wireless)"),
Developer Mode on. Mac: Wi-Fi `en0` = `192.168.1.20`, application firewall on. **No Rosetta** installed.

## Verdict: **works on a real iPhone over Wi-Fi, in debug and profile, with no Rosetta**

- In wireless mode `flutter run` never invokes the x86_64 `iproxy`. The VM service is found over the
  network, and no Rosetta error appeared in any of the runs below.
- **USB** iPhones still need Rosetta on Apple Silicon (Flutter 3.47.6's bundled `iproxy` is x86_64);
  see Update 2. B's extension warns about this before launching.

| Check | Real iPhone, my harness (`run_device.sh … --lan 192.168.1.20 --attack`) | Real iPhone, packaged extension (`FI_SUITE=devices`, physical iOS) |
|---|---|---|
| Launch with the generated entry, LAN host + token define | ✅ debug: Xcode build 13.1 s, install + launch **40.6 s** over Wi-Fi | ✅ A: `host=192.168.1.20`, LAN listener open, 102 s |
| Dio / http / HTTPS / POST / gzip / plain http intercepted; mock, edit, block | ✅ `dio_user 200 {"_intercepted":true,…"EDITED BY TOOL"…}`, `http_gzip 200 {"_intercepted":true,"gzipped":true…}`, `dio_user2 200 {"mocked":true…}`, `http_comment 403 {"blocked":true}`, `http_plain 200 {"_intercepted":true…}` | ✅ A: all 7 exchanges recorded; B: mock + block + response breakpoint edited through the webview path |
| Requests come from the phone over Wi-Fi | ✅ proxy log `from 192.168.1.42` (the iPhone) | ✅ |
| Hot restart over Wi-Fi | ✅ `Restarted application in 1,720ms / 1,324ms / 1,514ms`, still intercepted | ✅ B (6 s incl. rules) |
| Token never logged; no 407 with the right token | ✅ | ✅ (the token appears only in the define) |
| **Wrong token** (proxy restarted with another token, hot restart) | ✅ `PROXY_407 CONNECT … from 192.168.1.42` → HTTPS **verified DIRECT** (`dio_user 200 {"name":"Leanne Graham"…}`); **plain `http://` gets `407`** (`http_plain 407`) | — |
| Evil server on the LAN IP, proxy up | ✅ `attack 403 {"refused":"local target"}` (SSRF guard) | — |
| Proxy down → DIRECT, TLS verified | ✅ app works (`dio_user 200 … "Leanne Graham"`); evil server `attack ERR HandshakeException … CERTIFICATE_VERIFY_FAILED: application verification failure` | — |
| Stop → LAN listener closed | ✅ (proxy stopped) | ✅ C |
| App `findProxy` (Charles) | — | ✅ D, still intercepted |
| `enabled=false` → untouched launch | — | ✅ E: `lib/main.dart`, 0 exchanges |
| **`flutter run --profile` on the iPhone** (the user's question) | ✅ **ALL PASSED**: build 25.9 s, install + launch 6.0 s; `dio_user 200 {"_intercepted":true…}`, `http_gzip 200 {"_intercepted":true,"gzipped":true…}`, `attack 403`, token never logged | ✅ F: `flutterMode=profile`, 7 exchanges |
| `flutterMode=release` | n/a | ⚠️ G **timed out**, but the cause is the test, not the product: on iOS **release** builds `print` output does not reach the debug console, so the suite's "app ran" check (waits for `DEMO_BATCH done`) never sees it. The program stayed `lib/main.dart`, so it was not intercepted. Fix belongs to B: for physical iOS, accept a release run without app output (assert untouched program + 0 exchanges). |
| Local Network permission denied | not run: needs the user to toggle Settings → Privacy & Security → Local Network → Demo App off | — |

Wireless-specific notes:
- **Launch latency.** Over Wi-Fi the first debug launch takes ~40 s to install and launch. The app's first
  batch then reports ~19–23 s per request (`prefs ms=19054` too, so the isolate was waiting for the tool to
  attach, not the network). After hot restart, the same batch takes ~3.5 s, and in profile ~0.4–0.9 s.
- **Local Network.** All LAN requests from the phone succeeded on the first run, so the permission was
  granted (iOS asks once per app). The test VS Code instance's first suite run timed out on every launch
  with no Flutter output at all. The immediate rerun passed A–F. The most likely cause is a pending
  macOS prompt (Local Network or firewall for the test copy of Visual Studio Code) that the user answered
  in between. I could not confirm this from the logs.
- **`127.0.0.1` VM service URL.** The DDS/forwarded URL is printed even in wireless mode; no `iproxy` is involved.

## User steps (README material)
1. **Xcode → Settings → Accounts → "+" → Apple Account**: sign in with the Apple ID of the signing team.
2. Signing team for the app (demo: personal team `<TEAM_ID>`, automatic signing).
3. **iPhone → Settings → General → VPN & Device Management → Developer App → Trust** (first install of a
   free-team app).
4. **Either** pair the iPhone over Wi-Fi (Xcode → Window → Devices and Simulators → "Connect via network";
   `flutter devices` shows "(wireless)") **or**, for USB on Apple Silicon, install Rosetta
   (`sudo softwareupdate --install-rosetta --agree-to-license`).
5. **iPhone → "Allow … to find and connect to devices on your local network?" → Allow** (first launch).
6. **Mac → firewall prompt "accept incoming network connections" for Visual Studio Code / Code Helper →
   Allow** (first LAN session). Also allow Local Network for VS Code if macOS asks.
7. The iPhone must be unlocked and on the same Wi-Fi as the Mac. A free-team profile expires after 7 days.

## Update (after the Xcode account was added)

- ✅ **Signing now works** with the personal team: `Automatically signing iOS for device deployment using
  specified development team in Xcode project: <TEAM_ID>` → `✓ Built build/ios/iphoneos/Runner.app`.
  `flutter run` installed **Demo App** (`dev.flutterintercept.demoApp`) on the iPhone.
- ⛔ **Launch is blocked until the user trusts the developer certificate on the phone.** `flutter run` reported
  `The Dart VM Service was not discovered after 60 seconds`. Launching with `devicectl` shows the reason:
  `Unable to launch dev.flutterintercept.demoApp because it has an invalid code signature, inadequate
  entitlements or its profile has not been explicitly trusted by the user` (`FBSOpenApplicationErrorDomain`
  error 3, `RequestDenied` / Security).
  **User action:** on the iPhone, **Settings → General → VPN & Device Management → Developer App →
  "Apple Development: <your Apple ID>" → Trust "Apple Development: <your Apple ID>" → Trust**.
  The phone must be unlocked. This happens once per developer certificate.
- I stopped the harness and cleaned up (no proxy, LAN listener, evil server or `flutter run` left).

### Update 2 (after Trust)
- ✅ The developer certificate is trusted: `devicectl device process launch … dev.flutterintercept.demoApp` →
  `Launched application`.
- ⛔ **`flutter run` on the USB iPhone needs Rosetta.** Install and launch succeed (`Process 47994 resuming`,
  Impeller starts), then the tool exits:
  ```
  Error: Flutter failed to run ".../flutter/bin/cache/artifacts/libusbmuxd/iproxy 49850:49390 --udid 00008110-000A1B2C3D4E5F60".
  The binary was built with the incorrect architecture to run on this machine.
  If you are on an ARM Apple Silicon Mac, Flutter requires the Rosetta translation environment.
  ```
  Flutter 3.47.6's bundled `iproxy` (which forwards the Dart VM service port over USB) is
  `Mach-O 64-bit executable x86_64`, and this Mac has no Rosetta (`arch -x86_64 /usr/bin/true` → `Bad CPU type`).
  Without the VM service, the app stays paused before `main`: the proxy saw no request.
  This affects every `flutter run` / F5 on a USB iPhone from this Mac, with or without Flutter Intercept.
  **User action (Mac, Terminal, admin password):**
  `sudo softwareupdate --install-rosetta --agree-to-license`.
  (README: Flutter on Apple Silicon needs Rosetta for physical iOS devices.)

## Template: no change needed (verified)

The v3 entry builds `const _proxy = 'PROXY $_proxyAddress; DIRECT';` from the define unchanged. So
`FLUTTER_INTERCEPT_PROXY=flutter-intercept:<token>@192.168.1.20:<port>` becomes
`PROXY flutter-intercept:<token>@192.168.1.20:<port>; DIRECT`.
- dart:io parses `user:pass@host:port` and sends `Proxy-Authorization` pre-emptively on CONNECT and on
  plain requests. The proxy logged no 407 when the token was right.
- A base64url token contains no `:`, `@` or `;`.
- The `; DIRECT` fallback and CA trust are untouched.

## Results so far

The test proxy runs in LAN mode: `scripts/e2e/mitm_proxy.dart --bind 192.168.1.20 --token <t>`.
- It binds exactly that address (wildcards are refused, and the bound address is verified).
- A missing or wrong `Proxy-Authorization` gets a constant-time compare, then `407` and the connection is closed.
- Upstream targets that are loopback, link-local or any of the Mac's own addresses get `403 {"refused":"local target"}`.
- `Proxy-Authorization` is never forwarded upstream.
- The token is never logged.

| Check | Dart VM (`dart run -DFLUTTER_INTERCEPT_PROXY=…` + v3 entry) | iOS simulator over the LAN IP (`run_device.sh <sim> --lan 192.168.1.20 --attack`, 35 checks ALL PASSED) | Real iPhone |
|---|---|---|---|
| Interception with the right token (Dio/http/HTTPS/POST/gzip/plain http, mock, edit, block) | ✅ compat harness `failures=0`, all intercepted | ✅ `dio_user 200 {"_intercepted":true,…"EDITED BY TOOL"…}`, `http_plain 200 {"_intercepted":true…}`, mock, block, gzip | ⏳ blocked (signing) |
| Hot restart | — | ✅ `Restarted application`, the batch is intercepted again | ⏳ |
| No 407 with the right token; token never logged | ✅ token absent from the proxy log | ✅ | ⏳ |
| **Wrong token** (proxy restarted with a new token, app keeps the old one) | HTTPS: `plain 200 {"name":"Leanne Graham"…}` (CONNECT 407 → Dart tries the next entry → **verified DIRECT**, not intercepted). Plain `http://`: **`GET:407`** returned to the app | ✅ `PROXY_407 CONNECT jsonplaceholder.typicode.com:443` → `dio_user 200 {"name":"Leanne Graham"…}` (DIRECT); **`http_plain 407`** (plain requests get the 407, no fallback); attack → `CERTIFICATE_VERIFY_FAILED` | ⏳ |
| Attack server on the LAN IP, proxy up | — | ✅ `attack 403 {"refused":"local target"}` (SSRF guard: the evil server runs on the Mac's own IP) | ⏳ |
| Attack server, proxy down → DIRECT | ✅ (template-v3.md) | ✅ `attack ERR HandshakeException … CERTIFICATE_VERIFY_FAILED: application verification failure` | ⏳ |
| Proxy down → app works DIRECT | ✅ | ✅ `dio_user 200 {"name":"Leanne Graham"…}`, `http_plain 200 {"args":…}` | ⏳ |
| `flutter run --profile` | n/a | n/a (the simulator has no profile mode) | ⏳ **the user's profile-on-iOS question** |
| Local Network permission (allow / deny) | n/a | n/a (the simulator never asks) | ⏳ |

Notes:
- **Wrong token:** HTTPS is safe and silent (verified DIRECT). Plain `http://` requests surface a 407 to the
  app instead of falling back. This is dart:io behaviour: only connection/tunnel failures move to the next
  `findProxy` entry. A stale token only happens if the proxy restarts while an old build keeps running. The
  extension should hot-restart or relaunch the session on a new token (B/lead).
- The simulator reaches `192.168.1.20` through the Mac's own stack, so it proves the token, 407, SSRF and
  fallback logic but not Wi-Fi reachability, the macOS firewall or iOS Local Network privacy. Those three
  need the phone.

## User actions

### Needed now (Mac)
1. Open **Xcode → Settings… (⌘,) → Accounts → "+" → Apple Account** and sign in with the Apple ID of the
   personal team (`<your Apple ID>`).
2. Check that **"<Your Name> (Personal Team)"** appears under that account. Nothing else is needed:
   the project is already set to that team with automatic signing.

### Expected afterwards (I will stop and report again if any of these blocks)
3. **Mac**, the first time the proxy listens on the LAN IP: the macOS firewall asks whether `dart` (test
   proxy) or **VS Code** (real extension) may accept incoming connections → **Allow**.
4. **iPhone**, first install of a free-team app: the launch fails with "Untrusted Developer" until the user
   opens **Settings → General → VPN & Device Management → Developer App → "Apple Development:
   <your Apple ID>" → Trust → Trust**.
5. **iPhone**, first launch: **"Allow 'demo_app' to find and connect to devices on your local network?"**
   → **Allow**. Denying it is one of the pending checks: expected result is that connections to
   `192.168.1.20` fail, `; DIRECT` takes over and the app works but is not intercepted. To re-enable:
   Settings → Privacy & Security → Local Network → demo_app.
6. The iPhone must be **unlocked** during install/launch, and on the **same Wi-Fi** as the Mac.
7. Free-team limits (for the README): the profile expires after **7 days** (rebuild to renew), and there
   is a maximum of 3 apps per device.

## Pending iPhone run (one command per check, once step 1 is done)

```bash
# debug: interception, hot restart, wrong token, proxy down, attack
scripts/e2e/run_device.sh 00008110-000A1B2C3D4E5F60 --lan 192.168.1.20 --attack
# profile on iOS (the user's question)
scripts/e2e/run_device.sh 00008110-000A1B2C3D4E5F60 --lan 192.168.1.20 --attack --profile
# Local Network denied: toggle off in Settings → Privacy & Security → Local Network, then
scripts/e2e/run_device.sh 00008110-000A1B2C3D4E5F60 --lan 192.168.1.20 --no-restart --no-fallback
```

## Files changed
- `samples/demo_app/ios/Runner.xcodeproj/project.pbxproj`: `DEVELOPMENT_TEAM = <TEAM_ID>`, automatic signing (Runner).
- `samples/demo_app/lib/demo.dart`: `http_plain` reports a non-200 status (e.g. 407) instead of a JSON parse error.
- `scripts/e2e/mitm_proxy.dart`: LAN mode (`--bind`, `--token`, 407, SSRF guard, no `Proxy-Authorization` forwarding).
- `scripts/e2e/run_device.sh`: `--lan <ipv4>` (token define, LAN evil URL, token-leak and 407 checks, wrong-token stage).
- `packages/extension/src/entry/generator.ts` / CONTRACTS §1: unchanged.
