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
2. Open the **Flutter Intercept** tool window.
   - **IntelliJ IDEA** shows the traffic inside the IDE.
   - **Android Studio** has no embedded browser, so click **Open Traffic in Browser**: the traffic view opens in
     your browser on a private local address. Each click makes a new single-use link; reopening an old link from
     the browser history shows "open it again from the IDE".
3. Mock, block, pause, throttle, record, replay and export exactly as described in the
   [tutorials](../extension/README.md#tutorials).

The status bar shows `Intercept: on · N paused`; click it to turn interception off for the next runs. The actions
(Tools → Flutter Intercept) include Connect AI Agent, Export OpenAPI / Postman, Save CA Certificate and Set Client
Certificate Passphrase. Settings live in **Settings → Tools → Flutter Intercept** and apply to all projects.

## Differences from VS Code

- Android Studio shows the traffic in your browser (see above).
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
Studio and its Flutter / Dart plugins; set `platformPath` / `flutterPluginPath` / `dartPluginPath` in
`gradle.properties` if they live elsewhere. Design and protocol: [docs/CONTRACTS.md §15](../../docs/CONTRACTS.md).
