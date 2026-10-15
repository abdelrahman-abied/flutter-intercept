# Changelog

## 0.14.0 (preview)

- **Apps with their own certificate (mTLS)**, the same as in the VS Code extension 0.14.0:
  - A server that asks for the app's own client certificate (or an app that rejects the proxy's certificate) is
    passed through without decryption after one failed request, so the app keeps working with its own certificate.
  - **Add client certificate…** on such a request or in the **Client certificates** list of the traffic view: the
    IDE's file chooser (PKCS#12, or PEM certificate and key), then the passphrase. The location goes to the plugin
    settings, the passphrase to the IDE's password safe; the certificate is never uploaded anywhere. Remove
    certificates and retry passed-through servers from the same list.
  - Agents: `learnedPassthrough` in `get_status`, `list_requests` and `get_request`.
- **Fix**: decoding a gRPC message on demand in the traffic view works again.

## 0.13.0 (preview)

- **gRPC-Web, grpcurl and TLS gRPC on the iOS simulator**, the same as in the VS Code extension 0.13.0:
  - Flutter Web's gRPC-Web calls show as gRPC calls with their messages, status and trailers (filter `grpc:web`).
    gRPC mock and block rules answer them in gRPC-Web format. Message-level breakpoints, Mutate JSON, gRPC script
    hooks and resend don't apply to them yet.
  - **Copy as grpcurl** on gRPC calls (TLS verified, never `-insecure`; `-proto` when the method comes from a
    `.proto` file in the project).
  - New checkbox in **Settings → Tools → Flutter Intercept → gRPC**: **Make iOS simulators trust the Flutter Intercept
    CA during a session (decrypts TLS gRPC)**, off by default. Only that certificate is added, and only it is removed
    when the run ends, when the setting goes off, or after a crash at the next start. Physical devices, Android and
    macOS are never changed.
  - Agents: `get_request` `snippet: "grpcurl"`, `grpc.web` on gRPC-Web calls, `grpc.simulatorTrust` in `get_status`,
    and `notes` on exchanges.
- **Behaviour changes**: one set of rule checks everywhere. Map Remote targets with a `?query` are refused, sequences
  have at most 50 steps, and gRPC metadata names are checked more strictly. Shared gRPC mocks that set cookies or CORS
  headers need approval.
- **Performance**: proxy gRPC CPU per call −11%, streaming +14%, HTTPS small responses −25% (docs/PERF-1.md).
- **Quality**: the proxy is split into modules, and the gRPC metadata rules and limits are shared
  (docs/QUALITY-1.md).
- **Security**: independent review docs/REVIEW-13.md.

## 0.12.0 (preview)

- **gRPC tools complete**, the same as in the VS Code extension 0.12.0: rewrite rules change gRPC metadata and
  trailers; scripts run `onGrpcMessage` / `onGrpcStatus` on each message and on the end of the call; Map Remote sends
  gRPC calls to another server (h2c or TLS); **Resend** and **Edit and resend** work on gRPC calls (messages as JSON
  or base64). **More rules…** on a call starts a rewrite, script or Map Remote rule for it. Agents:
  `resend_request` with `grpc`, `add_rewrite` with trailers, `add_map_remote` on gRPC calls.
- **Security**: independent review docs/REVIEW-12.md.

## 0.11.0 (preview)

- **gRPC parity**, the same as in the VS Code extension 0.11.0: breakpoints on gRPC messages and on the end of the
  call (edit as JSON or base64, drop, change the status and trailers, abort); Mutate JSON on decoded response
  messages; recordings, replay and diff with gRPC calls; `.proto` files in the project as a schema source (the
  generated Dart wins). Agents: `resume_request` with `grpc`, `grpcPause` in `list_paused` / `get_request`, and
  `add_breakpoint`, `add_mutation` and the recording tools on gRPC calls.
- **Security**: fixes from the independent review docs/REVIEW-11.md (one budget for held gRPC data, pauses end with
  their call, same-origin gRPC replay, no request hash in redacted recordings, bounded `.proto` parsing).

## 0.10.0 (preview)

- **gRPC**: grpc-dart calls (and connectrpc over h2c) are intercepted with no app code, the same as in the VS Code
  extension 0.10.0: one row per call with its method, gRPC status, trailers and every message decoded with the app's
  generated `*.pb.dart` code; gRPC mock rules; block, faults, throttling, network profiles and sequences; the agent
  tools `add_grpc_mock` and `get_grpc_schema`.
- New **gRPC** group in **Settings → Tools → Flutter Intercept**: **Intercept gRPC calls** (on by default) and
  **Decrypt TLS gRPC for hosts** (for apps that trust the Flutter Intercept CA in debug builds; other gRPC over TLS
  is listed as an undecrypted tunnel).
- **Security**: fixes from the independent review docs/REVIEW-10.md (held TLS gRPC tunnels, bounded decompression,
  no absolute paths for agents, `list_rules` redaction).

## 0.9.2 (preview)

- Fixed an empty Flutter Intercept tool window ("Nothing to show") when it was opened after an app had already been
  run with interception.

## 0.9.1 (preview)

- Fixed the plugin icon on the JetBrains Marketplace and in the Plugins settings (it showed as a small square).

## 0.9.0 (preview)

- First version for Android Studio 2026.2+ and IntelliJ IDEA with the Flutter plugin: the traffic view, rules,
  breakpoints, mocks, network profiles, recordings, model checks, code generation, exports and the MCP agent tools
  of the VS Code extension 0.8.0.
- Run and debug Flutter configurations as usual: a copy of the configuration runs with Flutter Intercept's entry
  point and defines; release builds and your saved configurations are never changed.
- Android Studio opens the traffic view in your browser through single-use links (it has no embedded browser).
