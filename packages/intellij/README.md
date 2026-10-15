# Flutter Intercept for Android Studio / IntelliJ IDEA (preview)

See, mock, pause and replay your Flutter app's HTTP traffic from Android Studio, with no code in your app. The same
engine as the [VS Code extension](../extension/README.md): the proxy, rules, recordings, model checks, exports and
the agent tools run in a small Node process the plugin starts for you.

## Requirements

- Android Studio 2026.2 or newer, or IntelliJ IDEA 2026.2+ with the **Flutter** and **Dart** plugins.
- **Node.js 18 or newer.** Found on your PATH (including Homebrew, Volta, nvm, fnm, asdf, mise), or set
  **Settings → Tools → Flutter Intercept → Node.js path**.

## Use it

1. Open your Flutter project and run or debug it as usual (debug or profile mode). Flutter Intercept launches a
   copy of your run configuration with its generated entry point; your saved configuration is never changed.
   Or use **Run → Run with Flutter Intercept** / **Debug with Flutter Intercept**.
2. Open the **Flutter Intercept** tool window. The traffic shows inside the IDE:
   - **Android Studio** shows it with the Flutter plugin's embedded browser, the same one Flutter DevTools uses.
     The first time, the Flutter plugin downloads that browser (as it does for DevTools); the tool window says so.
   - **IntelliJ IDEA** shows it in its built-in browser (JCEF).
   - If neither is available, the tool window says why and offers **Open Traffic in Browser**: the traffic view
     opens in your web browser on a private local address. Each click makes a new single-use link; reopening an old
     link from the browser history shows "open it again from the IDE".
3. Mock, block, pause, throttle, record, replay and export exactly as described in the
   [tutorials](../extension/README.md#tutorials).

The status bar shows `Intercept: on · N paused`; click it to turn interception off for the next runs. The actions
(Tools → Flutter Intercept) include Connect AI Agent, Export OpenAPI / Postman, Save CA Certificate and Set Client
Certificate Passphrase. Settings live in **Settings → Tools → Flutter Intercept** and apply to all projects.

## gRPC

grpc-dart calls are intercepted like HTTP requests, with each message decoded from your app's generated `*.pb.dart`
code, or from `.proto` files in the project when the generated code isn't there. Settings are in
**Settings → Tools → Flutter Intercept → gRPC**:

- **Intercept gRPC calls (grpc-dart, connectrpc)**: on by default. Off, the app's gRPC calls connect directly.
  Applies to the next run.
- **Decrypt TLS gRPC for hosts**: one host or glob per line (for example `*.staging.example`). Only for apps that
  trust the Flutter Intercept CA in debug builds; other gRPC over TLS is listed as an undecrypted tunnel.
- **Make iOS simulators trust the Flutter Intercept CA during a session (decrypts TLS gRPC)**: off by default. While
  a run is on a booted iOS simulator, that simulator trusts the CA, so TLS gRPC with default credentials is decrypted
  with no change to the app. Only that certificate is added, and only it is removed when the run ends, when you turn
  the setting off, or after a crash at the next start. Physical devices, Android and macOS are never changed. Details:
  [See TLS gRPC on the iOS simulator](../extension/README.md#see-tls-grpc-on-the-ios-simulator).

To use it:

1. Run the app. Each gRPC call shows as a row with a **gRPC** badge, its method, the gRPC status and the message
   counts; **Messages** has every message, decoded.
2. **Mock this** on a call creates a gRPC mock with its messages and status; Block, faults, throttling and the network
   profiles apply too.
3. **Break on this** pauses each message and the end of the call: edit the message as JSON (or base64), drop it,
   change the final status and trailers, or abort the call. Right-click a field of a decoded response message to
   change it in the next responses (a **Mutate JSON** rule).
4. **Recordings** save gRPC calls with their messages; replay answers them without the server, and **Diff selected**
   compares their status, message counts and response shape.
5. **More rules…** on a call starts a **Rewrite** (metadata and trailers), **Script (JS)** (`onGrpcMessage` /
   `onGrpcStatus`) or **Map remote** rule for its method. **Resend** sends the call again with its recorded messages;
   **Edit and resend** lets you change the metadata and the messages (JSON or base64) first.
6. For gRPC over TLS, make debug builds trust the CA (**Tools → Flutter Intercept → Save CA Certificate**, or an
   `onBadCertificate` callback behind `kDebugMode`) and add the host above. On an iOS simulator, tick the simulator
   setting above instead.
7. **Copy request as → Copy as grpcurl** gives a `grpcurl` command for the call (TLS verified, `-proto` when the
   method comes from a `.proto` file in the project).
8. Flutter Web's gRPC-Web calls show as gRPC calls with their messages; gRPC mock and block rules answer them.
   Message-level breakpoints, Mutate JSON, gRPC script hooks and resend don't apply to them yet.

The VS Code tutorials cover it step by step, starting at
[See gRPC calls and their messages](../extension/README.md#see-grpc-calls-and-their-messages); the
[limitations](../extension/README.md#limitations) apply here too.

## Apps with their own certificate (mTLS)

1. Run the app. If a server asks for the app's own certificate, the first request to it may fail once; after that the
   server is passed through without decryption and the app talks to it directly with its own certificate.
2. To see those requests, click **Add client certificate…** on that request in the traffic view, choose the PKCS#12
   file (or the PEM certificate and its key) in the IDE's file chooser, type the passphrase if there is one, and save.

The certificate stays where it is on your computer: the plugin only remembers its location (Settings → Tools →
Flutter Intercept) and presents it to that server during the connection, the way the app does. It is never uploaded
anywhere. The passphrase goes to the IDE's password safe. The server never sees anything that names Flutter Intercept,
but it may log the first refused attempt, and after you add the certificate the connection comes from the plugin
instead of the app: use a certificate you're allowed to use for testing. **Pass servers … through automatically** in
Settings → Tools → Flutter Intercept turns the automatic part off. Step by step:
[Apps with their own certificate](../extension/README.md#apps-with-their-own-certificate-mtls).

## Differences from VS Code

- Android Studio shows the traffic through the Flutter plugin's embedded browser (see above).
- No editor diagnostics for the model check (the results show in the traffic view).
- Agents can't start or stop the app (`launch_app`, `stop_app`, `hot_restart`): use the IDE's Run and Stop.
- GitHub Copilot's VS Code tools aren't available; MCP clients (Claude Code, Cursor, Windsurf, Gemini CLI) work.
- iOS simulator trust is a setting only: there are no **Trust** / **Remove** actions.

## Build from source

```bash
npm ci && npm run build                     # repository root (builds the sidecar and the webview)
cd packages/intellij
export JAVA_HOME="/Applications/Android Studio.app/Contents/jbr/Contents/Home"   # Java 25 (target 262)
./gradlew buildPlugin                       # build/distributions/flutter-intercept-intellij-<version>.zip
./gradlew runIde                            # a sandboxed Android Studio with the plugin
./gradlew test verifyPlugin
```

Install the zip with **Settings → Plugins → ⚙ → Install Plugin from Disk…**. The build uses your local Android
Studio and its Flutter / Dart plugins; set `platformLocalPath` / `flutterPluginPath` / `dartPluginPath` in
`gradle.properties` if they live elsewhere. Design and protocol: [docs/CONTRACTS.md §15](../../docs/CONTRACTS.md).

## Note: the Flutter plugin's embedded browser

Android Studio ships no JCEF, so in Android Studio the tool window borrows the Flutter plugin's embedded browser
(`io.flutter.jxbrowser`, the JxBrowser setup Flutter DevTools uses). That isn't a public API of the Flutter plugin:
the plugin reaches it through reflection, checks every class and method it needs first, and falls back to **Open
Traffic in Browser** (with one log line saying why) when something doesn't match. A new Flutter plugin release may
need an update here; the adapter is `src/main/kotlin/dev/flutterintercept/toolwindow/FlutterEmbeddedBrowser.kt`.
