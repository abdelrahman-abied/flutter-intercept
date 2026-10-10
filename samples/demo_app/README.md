# demo_app

Plain Flutter networking demo used by Flutter Intercept's device checks. It has
**no interception code**: Dio + package:http + shared_preferences (+ Retrofit / json_serializable) only.

On startup (and on hot restart) it fires one batch and prints greppable lines:

    DEMO_START flavor=<prod|dev> ...
    DEMO_RESULT <label> <status|ERR> ms=<n> <compact body, 160 chars>
    DEMO_BATCH done <n>

Labels: `dio_user` (Dio GET /users/1), `http_todo` (http GET /todos/1), `dio_post`
(Dio POST /posts), `http_gzip` (httpbin.org/gzip), `http_plain` (plain http://),
`dio_user2` (/users/2), `http_comment` (/comments/1), `prefs` (plugin call).
Request → source checks (0.3.0): `catalog_album` (Dio with an interceptor and a `QueuedInterceptor`,
`lib/api/catalog_api.dart`), `orders_create` (package:http POST worth resending, `lib/api/orders_api.dart`),
`local_health` (host-machine server, `lib/api/local_api.dart`; only with `LOCAL_PORT`).
Contract check (0.4.0): `retrofit_user` (Retrofit `UsersApi.getUser(3)` → GET /users/3, decoded into the
json_serializable models in `lib/models/`). Real data matches the models (no violations). To see a
violation, "Make null in next responses" on `email` (or `mutate` `$.email` → null): the app prints
`retrofit_user ERR type 'Null' is not a subtype of type 'String' in type cast` and the extension flags
`final String email;` in `lib/models/user.dart`. Setting `$.tier` to an unknown string gives a warning
(decoded as `UserTier.unknown`). `UsersApi.getTodos` (a `List<Todo>` endpoint) is declared but not called.
The generated `*.g.dart` files are committed (they are parser fixtures too); after editing a model or the
API run `dart run build_runner build --delete-conflicting-outputs`.

Targets: `lib/main.dart` (prod), `lib/main_dev.dart` (dev flavor entry).

Dart defines:
- `APP_SETS_OVERRIDES=true` — app assigns its own `HttpOverrides.global` (tags User-Agent).
- `APP_ZONE_OVERRIDES=true` — app wraps runApp in its own `HttpOverrides.runWithHttpOverrides`.
- `REPEAT_SECONDS=n` — re-run the batch every n seconds.
- `LOCAL_PORT=n` (and optionally `LOCAL_HOST=host`) — also GET `/health` on a server on the host machine:
  `10.0.2.2` on the Android emulator, `localhost` elsewhere. Start one with
  `dart run scripts/e2e/host_server.dart --port 8787`, then run with `--dart-define=LOCAL_PORT=8787`.
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
