# Review 1 (independent, HEAD e3e0b17) — findings and fix plan

| # | Sev | Finding | Owner |
|---|---|---|---|
| 1 | HIGH | Entry's accept-any-cert callback also covers `; DIRECT` fallback → TLS unverified whenever the proxy is unreachable (app reopened from launcher, VS Code closed, iOS physical device, adb reverse removed). Confirmed: self-signed `CN=evil.example` server accepted through the entry. | A |
| 2 | MED | Entry file shared across sessions/devices/flavors: name from basename only, content bakes PROXY_HOST. Emulator (10.0.2.2) + simulator (localhost) sessions overwrite each other; `lib/flavors/dev/main.dart` vs `lib/flavors/prod/main.dart` collide. | A |
| 3 | MED | Proxy buffers every body fully and unbounded (`'response'` listener, `decode()` copy, `.matching()` waits for request body). 400 MB download → extension host RSS 96 MB → 1011 MB. | C |
| 4 | LOW-MED | Webview JSON tree + Format lose precision > 2^53 (`{"id":12345678901234567890}` shown/sent as ...7000). | D |
| 5 | LOW | 127.0.0.1 bind fails OPEN if mockttp internals change (`if (raw)` silently skips rebind). | C |
| 6 | LOW | adb reverse cleanup races with in-flight reverse; user's own pre-existing `adb reverse tcp:<port>` gets taken over and removed. | B |
| 7 | LOW | Host doesn't validate webview messages (`setRules` any array; rule without `match` = match-all; non-string edit header → 500 in app). | B |
| 8 | LOW | "Mock this" from truncated/binary response → broken mock (truncated body / empty body with original content-type). | C (+B surfaces error) |

## Fix design for 1 + 2 (Agent A)
- **Trust, don't accept.** Per-install CA (random subject), generated once by the extension and persisted in
  `context.globalStorageUri` (private key never leaves the dev machine); passed to `InterceptProxy({ ca })`.
  The entry embeds only the CA **certificate** PEM and adds it as a trusted root
  (`SecurityContext.defaultContext` and any app-supplied context via `setTrustedCertificatesBytes`), so proxy
  leaf certs pass normal chain + hostname verification. `badCertificateCallback`: NOT accept-any — delegate to
  the app's callback if it set one (preserves app pinning on the DIRECT path), else reject.
  Issuer-string checks are not acceptable (spoofable).
- **Device-independent entry content.** Proxy host/port via `--dart-define` read with `String.fromEnvironment`
  (defaults `localhost`/configured port for plain-Dart sessions, which can't take dart-define); file name
  from the full project-relative path so flavors never collide.
