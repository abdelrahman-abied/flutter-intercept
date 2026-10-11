# Changelog

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
