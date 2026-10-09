# Security policy

## Reporting a vulnerability

Please **don't open a public issue** for a security problem. Report it privately through GitHub's private
vulnerability reporting:

**[Security → Report a vulnerability](https://github.com/abdelrahman-abied/flutter-intercept/security/advisories/new)**

Please include:
- the version (shown in the Extensions view);
- your OS, and the VS Code, Dart-Code and Flutter versions;
- the target device kind (Android emulator or phone, iOS simulator, iPhone over USB or Wi-Fi, macOS);
- steps to reproduce, and what you expected.

Don't include real tokens, signing team IDs, device UDIDs or private keys. Redact them; they aren't needed to
reproduce a problem.

You'll get an acknowledgement in the advisory thread. The fix and the disclosure are then coordinated there.

## Supported versions

| Version | Supported |
| --- | --- |
| 0.1.x | Yes |
| < 0.1 | No (never published) |

## Threat model (summary)

Flutter Intercept is a **local debugging tool**. It runs a man-in-the-middle HTTP(S) proxy inside VS Code, and
makes Flutter/Dart apps that you launch from VS Code send their `dart:io` traffic through it. The protections
below come from the design in [`docs/CONTRACTS.md`](docs/CONTRACTS.md) and the fixes for two independent
reviews, [`docs/REVIEW-1.md`](docs/REVIEW-1.md) and [`docs/REVIEW-2.md`](docs/REVIEW-2.md). The user-facing
version is in the extension README's
[Security section](packages/extension/README.md#security).

### What the design protects

**Loopback by default**
- The proxy listens on `127.0.0.1`.
- It verifies the address it actually bound to and refuses to start otherwise.

**iPhone LAN listener (physical iPhones only)**
- It is open only while a physical-iPhone session runs, and only on a private (RFC 1918) address of the Mac.
- Every request and `CONNECT` must carry a per-session secret token: 32 random bytes, compared in constant time.
  Anything else gets `407` and the connection is closed.
- The listener locks to the first device that authenticates.
- It refuses upstream targets that would reach the Mac itself (loopback, link-local, unspecified, the Mac's own
  addresses) or networks routed through other interfaces (VPN, VM and bridge networks).
- Connections are capped and slow request heads time out.
- It closes when the last iPhone session ends, or when the Mac's network changes.

**Certificate trust**
- The extension generates a **CA unique to your installation**. It is stored in VS Code's extension storage with
  owner-only permissions.
- The generated launcher makes the app trust that CA, and only in intercepted sessions. It never accepts
  arbitrary certificates, and nothing is installed in a system trust store.
- When the proxy is unreachable, the `; DIRECT` fallback keeps **normal TLS verification**.

**Upstream verification**
- By default the proxy verifies the real server's certificate. A failure reaches the app as a `502` carrying the
  error.

**Scope of interception**
- Only launch sessions started from VS Code while interception is on are intercepted.
- Attach sessions, test runs, web sessions and **release launches** are never intercepted.
- Your source and `pubspec.yaml` are not modified.

**Webview**
- The traffic panel runs under a strict Content Security Policy: nonce-only scripts, no inline styles, no
  network.
- The extension host validates every message the panel sends before acting on it.

### Known limits and residual risks

**The iPhone token travels in clear text.** It sits in the proxy request over Wi-Fi. On shared, public or
otherwise untrusted Wi-Fi, someone who can observe the traffic may learn it. What limits the damage:
- The listener locks to the first authenticated device.
- It closes with the session.
- It refuses targets on the Mac and on other-interface networks.

Still, use iPhone sessions on a trusted network.

**The iPhone token reaches disk.** It is a build define, so `flutter_tools` writes it into
`ios/Flutter/Generated.xcconfig` and `ios/Flutter/flutter_export_environment.sh` (both gitignored by default).
It is also:
- baked into the debug app;
- visible in `flutter run`'s process arguments;
- possibly in Dart-Code's debug log.

It is only usable while that session's listener is open.

**The CA private key** is a file on your machine. Anyone who can read it could impersonate servers to apps
launched in intercepted sessions. Protect your user account as you would any developer credential.

**App certificate pinning is bypassed while the proxy is up.** This applies to pinning via
`badCertificateCallback` or `SecurityContext(withTrustedRoots: false)`, and it is intended for a debugging tool.
With the proxy down, the app's pinning behaves exactly as without the tool.

**Not covered by interception at all:** native HTTP stacks, Flutter web, background isolates, and apps that
install their own `HttpOverrides` zone. See the extension README's
[Limitations](packages/extension/README.md#limitations).

### Out of scope

- Attacks that need local code execution as your user, or read access to your home directory. Such an attacker
  can already control VS Code.
- Recorded traffic shown in the panel. It contains whatever your app sends, including credentials, by design.
  It is kept in memory only and cleared when the window reloads.
