# web_app

Plain Flutter **Web** networking sample used by Flutter Intercept's web checks. It has **no interception
code**: Dio (browser adapter) + package:http (`BrowserClient`) only, talking to public JSON APIs.

On startup (and on hot restart) it fires one batch, in order, and prints greppable lines:

    WEB_START run=<n>
    WEB_RESULT <label> <status|ERR> ms=<n> <compact body or error, 160 chars>
    WEB_BATCH done ok=<n> err=<n>

Labels:
- `http_todo` — package:http GET jsonplaceholder `/todos/1` (simple request, no preflight).
- `dio_user` — Dio GET jsonplaceholder `/users/1`.
- `dio_post` — Dio POST jsonplaceholder `/posts` with a JSON body (CORS preflight: `content-type: application/json`).
- `http_post` — package:http POST jsonplaceholder `/todos` with a JSON body (preflight).
- `dio_profile` — Dio GET jsonplaceholder `/users/2` with a custom `x-demo-client` header (preflight). The web
  integration suite mocks this one: the mock must answer the preflight too, or the browser blocks it.
- `cors_blocked` — package:http GET the Wikipedia API **without** `origin=*`: the server answers 200 but sends no
  `Access-Control-Allow-Origin`, so the browser blocks it and the app only sees
  `ClientException: XMLHttpRequest error` (or `Failed to fetch`). Flutter Intercept still records the real 200
  and explains the CORS problem.

Run: `flutter run -d chrome` (F5 in VS Code with Flutter Intercept on adds the proxy browser flags).
