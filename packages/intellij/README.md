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

## Differences from VS Code

- Android Studio shows the traffic through the Flutter plugin's embedded browser (see above).
- No editor diagnostics for the model check (the results show in the traffic view).
- Agents can't start or stop the app (`launch_app`, `stop_app`, `hot_restart`): use the IDE's Run and Stop.
- GitHub Copilot's VS Code tools aren't available; MCP clients (Claude Code, Cursor, Windsurf, Gemini CLI) work.

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
