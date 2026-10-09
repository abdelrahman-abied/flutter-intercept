# demo_app

Plain Flutter networking demo used by Flutter Intercept's device checks. It has
**no interception code**: Dio + package:http + shared_preferences only.

On startup (and on hot restart) it fires one batch and prints greppable lines:

    DEMO_START flavor=<prod|dev> ...
    DEMO_RESULT <label> <status|ERR> ms=<n> <compact body, 160 chars>
    DEMO_BATCH done <n>

Labels: `dio_user` (Dio GET /users/1), `http_todo` (http GET /todos/1), `dio_post`
(Dio POST /posts), `http_gzip` (httpbin.org/gzip), `http_plain` (plain http://),
`dio_user2` (/users/2), `http_comment` (/comments/1), `prefs` (plugin call).

Targets: `lib/main.dart` (prod), `lib/main_dev.dart` (dev flavor entry).

Dart defines:
- `APP_SETS_OVERRIDES=true` — app assigns its own `HttpOverrides.global` (tags User-Agent).
- `APP_ZONE_OVERRIDES=true` — app wraps runApp in its own `HttpOverrides.runWithHttpOverrides`.
- `REPEAT_SECONDS=n` — re-run the batch every n seconds.
- `APP_FINDPROXY=charles|env` — the app's own `HttpClient` (Dio `IOHttpClientAdapter` +
  package:http `IOClient`) sets `findProxy` after creation: `charles` = leftover debug
  snippet `'PROXY 127.0.0.1:8888'`, `env` = `HttpClient.findProxyFromEnvironment`.
- `APP_PINNING=callback|context|dio_validate` — certificate pinning via
  `badCertificateCallback`, via `SecurityContext(withTrustedRoots: false)` with the real
  roots in `lib/pinned_roots.dart`, or via Dio's `validateCertificate`.
- `EVIL_URL=https://host:port/` — also GET this URL with a plain package:http client (label `attack`);
  used with `scripts/e2e/evil_server.dart` (self-signed certificate) to check it is always rejected.

Device check: `scripts/e2e/run_device.sh <deviceId> [--app-mode <mode>]` (see
`docs/spikes/device.md`, `docs/spikes/template-v2.md`, `docs/spikes/template-v3.md`).
