# Review 14: v0.14.0 — apps with their own certificate

Independent security review of `feature/0.14.0`, `git diff aee0cad..95fc8ab` (49b7caf … 95fc8ab). afa2e62, which came
after it, only touches READMEs and changelogs; it was scanned for personal data only. The uncommitted PERF-2 work in
`connect-flow.ts` / `intercept-proxy.ts` (the `accepted` map, `handshakeWorked`) was in progress during the review. It is
not covered, except where #2 says how it changes the picture.

Scope:
- proxy: learned passthrough (`learned.ts`, `learn-flow.ts`), the TLS 1.2 probe and `CertRequestFinder`, the HTTP pin
  watch and `pinVerdict` (`connect-flow.ts`), `watchRefusal` / `applyRefusal` and `Connection: close` (`http-taps.ts`),
  `grpcRefusal` (`grpc-relay.ts`), `ruleNamingHost`, `forgetLearnedPassthrough` and the event;
- host: `clientCertUi.ts`, `clientCerts.ts` exports, the §20.3 handlers and `certTokens` (`handlers.ts`, `controller.ts`),
  the VS Code platform and the **Add Client Certificate…** command (`extension.ts`), `learnedPassthroughView`
  (`proxyHost.ts`);
- sidecar: `clientCerts.ts`, `host.ts` (the serialised reload), `types.ts`;
- plugin: `UiRequestHandler.kt` (file chooser, settings write, passphrase), `ClientCertificates.kt`;
- webview: `certificates.ts`, `Certificates.tsx`, `hostMsg.ts`;
- agents: `views.ts`, `har.ts`, `schema.ts`, `package.json` tool texts;
- demo / e2e: `mtls_demo.dart`, `mtls_server.mjs`.

Spec: CONTRACTS §20, §14.2, §14.3, §19.3, §7; guarantees from REVIEW-8 (certificate loader, host patterns) and REVIEW-13
(#6, pin strikes).

I read the code and ran throwaway probes in the session scratchpad, outside the repo, against the built
`@flutter-intercept/proxy` (`dist`, built from 95fc8ab):
- `hostspoof.js`: a client CONNECTs to an IP, then sends a request whose `Host` (and SNI) names another host. The server
  at the IP refuses with TLS alert 116 (TLS 1.3 `requestCert` + `rejectUnauthorized`) or with nginx's 400 page;
- `pin.js`: a client CONNECTs to a host that doesn't exist (`api.victim.example:443`). It then abandons the TLS handshake
  twice, either by destroying the socket after its ClientHello or by completing the handshake and closing;
- `alert.js`: `openssl s_client -proxy … -verify_return_error` (OpenSSL 3.6) to the same host: one handshake that the
  client refuses with an alert;
- `mock.js`: a `mock` rule and a `rewrite` rule with a path-only pattern that answer 400 `text/html` with nginx's text;
- `finder.js`: `CertRequestFinder` fed hostile record streams: 1–100-byte handshake records under a message header that
  claims 16 MB, sent in 64 KB and 1460-byte chunks;
- a check of `parseLearnedKey` on unbracketed IPv6 keys, and of `parseHostPattern` on broad patterns (`*.*`, `*.com`,
  `**`, `*-*`).

I did not run the unit, integration, device or plugin suites, start an IDE, or touch devices or emulators.

Threat model as in REVIEW-1 to REVIEW-13: a malicious cloned repo (trusted workspace); a malicious or prompt-injected
agent that only has our tools; a malicious app under debug; hostile servers and web pages; other local users and
processes; the paired LAN device. New in 0.14.0:
- the proxy now **changes its own routing** (decrypt → pass through) based on what servers answer and on how any
  client's TLS handshake ends. The map is global, across every client of the proxy;
- the panel can write user-level settings and secret storage, and it opens a native file picker.

| # | Sev | Finding | Owner |
|---|---|---|---|
| 1 | LOW-MED | **A client can make the proxy learn `client-certificate` for any host name. It lasts until the proxy stops.** The refusal is keyed on the exchange URL's host (`ex.url`). mockttp builds that host from `Host` / `:authority` / SNI whenever the CONNECT target is an IP, but it connects to the IP. **Probe:** CONNECT to the attacker's server by IP + `Host: api.victim.example`. The server answers alert 116 (or nginx's 400), and `api.victim.example:<port>` is learned. From then on, the developer's app's CONNECTs to that host are passed through undecrypted. Rules that don't name the host stop applying to it, and `closeIdle` closes the app's idle connections to it. Legitimate apps that CONNECT by IP are never passed through (wrong key). | P |
| 2 | LOW-MED | **Any client's handshake can pin any host for 10 min, renewable, and the HTTP watch now covers every CONNECT.** One TLS alert from the client pins the host at once. Two abandoned handshakes within 60 s also do, without any server being contacted. **Probe:** `openssl s_client -verify_return_error` once, or two dropped handshakes, to the nonexistent `api.victim.example` → `{reason: 'pinned', until: +10 min}`. Realistic false positives: in LAN mode the iPhone's Wi-Fi proxy is system-wide, and with `nativeClients: proxy` the emulator's `http_proxy` is global. Other apps on the device that don't trust the CA (Safari, Play services, Chrome) then pin the hosts they share with the Flutter app (`*.googleapis.com`, analytics, crash reporters). A hot restart that cuts a handshake counts as a strike. 1000 pins (or 1000 one-strike hosts in `pinStrikes`) also turn learning off. | P |
| 3 | LOW | **Plugin: the Settings dialog's Apply can silently undo a certificate added from the panel.** `writeClientCertificates` runs with `ModalityState.any()`, so it writes under an open Settings dialog. `InterceptConfigurable` keeps the `certText` it loaded when the dialog opened. Changing anything else and pressing OK runs `apply()`, which writes the stale list. The new entry is gone, and its passphrase stays in the PasswordSafe, orphaned. | I |
| 4 | LOW | **Saving stores the passphrase before the entry, with no rollback, and Remove deletes the passphrase without asking.** If `writeEntries` fails (settings.json unwritable, plugin refusal), the host's previous passphrase is already replaced, and the existing entry stops loading ("the stored passphrase is wrong"). The **Remove** confirmation lives only in the webview, so a compromised panel (or a buggy one) can delete every stored passphrase with `removeClientCertificate`. Passphrases aren't recoverable from the IDE. | H (+ I) |
| 5 | LOW | **Learned IPv6 hosts can't be forgotten from the panel.** `forgetLearnedPassthrough` with `host` + `port` sends `` `${host}:${port}` `` unbracketed. `parseLearnedKey('2001:db8::1:443')` parses that as a bare IPv6 host with no port, so nothing matches. **Try decrypting again** and **Forget** silently do nothing for IPv6 servers. | H |
| 6 | INFO | Smaller items: `Connection: close` on every HTTPS 400 that is `text/html` or has no content type; probes that hang in the upstream proxy outlive the 4-probe cap; when the map is full, every 40 / 42 failure probes again; pins ignore rules added after them; learned entries expire without an event; the setting is `application`-scoped, so Settings Sync copies certificate paths to other machines; the banner prefills a host that a server picked; there is no limit on chooser requests (focus stealing in browser mode); the sidecar can't delete the passphrase of a legacy entry whose host fails `certHostProblem`. | various |

## Details

### 1 (LOW-MED) Learned `client-certificate` host comes from the Host header, not the server that refused

`http-taps.ts:131-151` `refusal()` takes `host` / `port` from `new URL(ex.url)`. For a request inside a decrypted
CONNECT tunnel, mockttp (`node_modules/mockttp/dist/util/request-utils.js:236-252`) sets the URL like this:
- the tunnel's host name, if the CONNECT named a host;
- **otherwise (CONNECT to an IP) `:authority` → `Host` → SNI**;
- the port always comes from the tunnel.

`req.destination`, the address it actually connects to, is the tunnel's. `learn-flow.ts:108-137` `verdict()` then
learns `f.host:f.port`:
- at once for alert 116 and for nginx's 400;
- after a probe **to `f.host`** for 40 / 42.

Probe (`hostspoof.js`):
```
CONNECT 127.0.0.1:<srv>   then   GET / HTTP/1.1  Host: api.victim.example   (SNI api.victim.example)
server at 127.0.0.1:<srv>: TLS 1.3 requestCert → alert 116           → learned [{host: 'api.victim.example', port: <srv>, reason: 'client-certificate'}]
server at 127.0.0.1:<srv>: 400 text/html "No required SSL certificate was sent" → same
exchange url https://api.victim.example:<srv>/, error "This server needs the app's own client certificate (…)"
```
With the attacker's server on port 443, the key is `api.victim.example:443`.

Who can do it:
- any local process (the proxy listens on loopback for every user);
- in LAN mode, the paired device: its other apps, or anything that holds the token.

A web page can't. Browsers CONNECT by host name and can't set `Host`.

What it does:
- `client-certificate` entries have no expiry (`learned.ts:90`). The developer's own app's CONNECTs to
  `api.victim.example:443` are passed through until the proxy stops, which in VS Code is the window's lifetime.
- A mock, rewrite, breakpoint or throttle rule whose pattern has no `scheme://host` part (`*/login*`) silently stops
  applying to that host. `patternNamesHost` only protects rules that name the host.
- The panel shows a banner asking the user to add a client certificate for a server that never asked for one.
- `applyRefusal` → `closeIdle('api.victim.example', 443)` closes the app's idle keep-alive connections there.
  `trackConnection` keys by `destination` (`intercept-proxy.ts:1722`), so the attacker's verdict reaches the app's real
  connections.
- An attacker can also fill the map (1000 made-up names, one server) so that real mTLS hosts are never learned
  (`LEARNED_MAX`). It stays full until the proxy stops.
- The 40 / 42 probe goes to the `Host` name, not to the server that refused. That reaches nothing the same client couldn't
  CONNECT to itself: the probe goes through the LAN gate and `targetsSelf`.

The same mismatch also breaks the feature for an honest app that resolves names itself and CONNECTs by IP with the name in
SNI / `Host`:
- the entry is learned under the name;
- `forConnect` looks up the IP (`connect-flow.ts:126`), so the next CONNECT is decrypted again and fails again, every
  time.

gRPC (`grpc-relay.ts` `grpcRefusal`) is consistent: the relay connects to the URL host itself.

**Fix (P):**
- Key the refusal on `req.destination` (the connected server: the CONNECT target), not on `ex.url`. That is the key
  `trackConnection` and `forConnect` use. Keep the `Host` name only for the message.
- Alternatively, learn nothing when the URL host and the destination differ, and say so in the error.
- Probe the destination too.
- **Test:** CONNECT to an IP with a different `Host`, server answers 116 → the learned key is the IP (or nothing), never
  the `Host` name. The app's next CONNECT to the same IP is passed through.

### 2 (LOW-MED) Pins: any client, any host, no server needed

0.14 calls `watchDecryptHandshake(…, http = true)` for **every** CONNECT that mockttp answers (`connect-flow.ts:132`), not
only for the app's silent gRPC tunnels. `pinVerdict` (`connect-flow.ts:548-600`) then decides:
- `cert-rejected` (any TLS alert from the client that mockttp maps to it: `unknown ca`, `bad certificate`,
  `certificate unknown`) → pinned at once;
- `reset` / `closed` → a strike; two within `PIN_STRIKE_WINDOW_MS` → pinned.

Each pin lasts 10 min and is renewed by the next one. Nothing ties the strike to the client that later uses the host.

Probes:
```
pin.js  (no server: api.victim.example doesn't resolve; mockttp answers CONNECT without connecting)
  destroy after ClientHello ×2      → "…(reset). If it happens again within a minute…", then pinned 10 min
  complete handshake, close ×2      → "…(closed)…", then pinned 10 min
alert.js  openssl s_client -proxy 127.0.0.1:<p> -connect api.victim.example:443 -verify_return_error, once
                                    → "api.victim.example pins its certificate: passed through without decryption from now on, for 10 minutes"
```

Who triggers it:
- **Other clients of the same proxy, without meaning to.** In LAN mode the iPhone's Wi-Fi HTTP proxy is system-wide, so
  Safari and every other app on the phone go through the proxy. With `nativeClients: proxy`, `adb.ts` sets the
  emulator-wide `http_proxy`, so Play services and Chrome go through it too. Those clients don't trust the Flutter
  Intercept CA (Android apps ignore user CAs by default). Their handshakes fail, with an alert (`certificate_unknown`) or
  a close, and pin the hosts they reach: `*.googleapis.com`, `firebaseinstallations.googleapis.com`, crash and analytics
  endpoints. The Flutter app calls the same hosts. Its traffic there is then passed through in renewable 10-minute
  windows, and mocks or breakpoints with path-only patterns stop applying. I found this by reading the code and
  mockttp's `getCauseFromError`; I didn't run it on a device.
- **Deliberately:** any local process, or the paired LAN device, with one `s_client` per host every 10 minutes.
- **Hot restart / app kill mid-handshake:** twice within a minute for the same host is enough (REVIEW-13 #6 pattern, now
  for all HTTPS).
- **Caps used as an off switch:**
  - 1000 pins → `learn()` refuses, and real mTLS hosts aren't learned;
  - 1000 distinct one-strike hosts fill `pinStrikes`, which is never pruned (`connect-flow.ts:559`, only cleared on
    pin, forget-all or stop). After that, close-based learning stops for every new host until the proxy stops. This
    one is fail-safe: hosts stay decrypted.

The uncommitted PERF-2 change (`accepted` / `handshakeWorked`) skips close-based strikes for a host where the app
completed a decrypted request within 60 s. That helps the hot-restart case, but not alerts, not hosts the app hasn't
called in the last minute, and not other clients.

**Fix (P):**
- Count strikes and keep pins **per client address** (`remoteAddress`, plus the LAN peer). The learned entry then applies
  to CONNECTs from that client only. Loopback still mixes the simulator / emulator traffic with local processes, but a
  LAN device or the emulator's other apps can no longer change what the app on the dev machine sees. For a global
  `http_proxy` on the emulator, consider learning HTTP pins only from connections that carry the app's own marker (the
  entry's `SILENT_TUNNEL_HEADER`-style hop marker), or none at all from the global proxy.
- Don't pin for the target of a CONNECT that never reached our certificate. A client that drops before mockttp sent its
  Certificate isn't a rejection: use mockttp's timing (`tlsConnectedTimestamp` absent → `reset` before our flight).
- Prune `pinStrikes` by age (like `negative` in `learn-flow.ts:162`) and cap pins separately from `client-certificate`
  entries, so pins can't crowd mTLS hosts out.
- Make the 10-minute pin visible as such in Status (it is: `until`), and send an event when it expires (see #6).
- **Tests:** a second client's alert doesn't pin for the first client; a ClientHello dropped before ServerHello is no
  strike; 1001 single strikes don't stop learning for a new host after the window.

### 3 (LOW) Plugin: Settings dialog Apply overwrites a panel add

- `UiRequestHandler.kt:269` `writeClientCertificates` = `onEdt(ModalityState.any())` → `InterceptSettings.update(next)`.
  It runs even while a modal Settings dialog is open.
- `InterceptConfigurable.load()` reads `certText` once, at `createPanel()`. `apply()` (`InterceptConfigurable.kt:110-118`)
  parses that `certText` and writes `working.clientCertificates` over the stored list.

Sequence:
1. The panel runs in the system browser (§15.4), so the modal dialog doesn't block it.
2. The user chooses the files, which needs the EDT, so they do it before opening Settings.
3. The user opens Settings, then presses **Save** in the browser panel. The entry is written, the sidecar reloads, and
   the passphrase is stored.
4. The user changes something else in Settings and presses OK. `apply()` writes the old list. The new entry disappears,
   the sidecar reloads without it, and the PasswordSafe keeps a passphrase that no entry uses.

Nothing tells the user. This is the "Apply overwrite race" the brief names, confirmed by reading the code. I didn't run
it in an IDE.

**Fix (I):** use the default modality for `writeClientCertificates`, like the chooser, so it waits for the dialog to
close. Alternatively:
- have `InterceptConfigurable` re-read the stored list in `apply()`;
- merge: keep entries added since `load()`, or refuse with "Close the Settings dialog first";
- or subscribe to `InterceptSettings.TOPIC` in the configurable and `reset()` the certificate text when it changes.

### 4 (LOW) Passphrase before entry, no rollback; Remove deletes secrets without a host-side confirmation

- `clientCertUi.ts:197-208`: `setPassphrase(host, passphrase)` comes first, then `writeEntries`. The first call replaces
  (or, when the new file has none, deletes) the host's existing secret. If the write then fails, the problem says "Couldn't
  save the certificate…", but the old entry, still in settings, now loads with the new passphrase and fails ("the stored
  passphrase is wrong"). In VS Code, `secrets.onDidChange` reloads at once, so the old certificate breaks before the write
  is even tried.
- `clientCertUi.ts:221-246` / `handlers.ts:354`: `removeClientCertificate` removes the entry and deletes the passphrase
  from secret storage / PasswordSafe. The only confirmation is the webview's inline one. The webview is the least trusted
  part (a stored-XSS bug there would be enough), and passphrases can't be read back from the IDE. A compromised panel can
  loop over `Status.clientCertificates` and wipe them all. Before 0.14 the panel couldn't change settings.json or
  secret storage.

**Fix (H):**
- Keep the previous secret (read it first; VS Code `secrets.get`, plugin `secrets.clientCertPassphrase`) and restore it
  when `writeEntries` fails.
- Alternatively, store the passphrase under a new key and switch entries atomically. Simplest: write the entry first,
  then the passphrase, accepting one failed reload in between.
- For **Remove**: ask in the host (`showWarningMessage({modal: true})` / `ui.confirm`) before deleting anything.
  Alternatively, delete the entry but keep the secret: it's harmless, and re-adding the same host reuses it.

### 5 (LOW) IPv6 learned hosts can't be forgotten from the panel

`handlers.ts:372` builds `` `${host}:${msg.port}` `` from the webview's `{host, port}`. The proxy's `parseLearnedKey`
(`learned.ts:48`) accepts any string that `net.isIPv6` accepts as a bare host:
```
parseLearnedKey('2001:db8::1:443')   → { host: '2001:db8::1:443' }          (no port)
parseLearnedKey('[2001:db8::1]:443') → { host: '2001:db8::1', port: 443 }
```
For an IPv6 server, **Try decrypting again** and **Forget** match nothing and report nothing. `hostLabel` already brackets
IPv6 for messages.

**Fix (H):** bracket IPv6 hosts in the handler (`net.isIPv6(host) ? `[${host}]:${port}` : …`), or give
`forgetLearnedPassthrough` a `{host, port}` form. Add a test.

### 6 (INFO) Smaller items

- **`Connection: close` on non-nginx 400s.** `http-taps.ts:111-127` marks every HTTPS 400 whose content type is
  `text/html` *or missing* as `maybeNginx` and returns `mayTeach` = true. The app's keep-alive connection is closed after
  every such 400, which is common for empty-body API errors. Only performance. Consider requiring `text/html`, a small
  `content-length`, or `server: nginx`.
- **Probe lifetime.** The 5 s deadline frees the `probing` slot, but `openTunnelUpstream` through an upstream proxy
  (`connectTunnel`) and `resolveCheckedTarget` have no timeout of their own. A hanging upstream proxy can pile up
  connection attempts beyond `PROBE_MAX_AT_ONCE` (one per key every 60 s). Pass the remaining time to `connectTunnel`.
- **Probe repetition.** Only negative results are cached. When the map is full, or `learn()` returns false, every 40 / 42
  failure of a confirmed mTLS host probes again (one at a time per key). Cache positives for a minute too.
- **`CertRequestFinder`** is robust:
  - records over 18 432 bytes and versions other than 3.x stop it;
  - 256 KB of input at most;
  - worst case measured 48–67 ms for 1–5-byte records under a header that claims 16 MB (`Buffer.concat` per record);
  - it never answers true for a server other than the one probed.
- **Pins ignore later rules.** `forConnect` returns `pinned` entries without `keepDecrypted` (`learn-flow.ts:94`). A rule
  added after a pin doesn't apply for up to 10 minutes (the tunnel note says why).
- **Silent expiry.** `LearnedHosts.get` / `list` drop expired pins without the `'learnedPassthrough'` event. Status and the
  panel's learned list keep showing them (countdown at zero) until something else broadcasts (agents read the list on
  demand, so they are current). Emit the event on a timer at the earliest `until`.
- **Settings Sync.** `flutterIntercept.clientCertificates` is `"scope": "application"` (`package.json:109`), so Settings
  Sync copies absolute certificate paths (folder and user names) to other machines, where they don't load. `machine` is
  also user-level-only (not settable in a workspace) and isn't synced.
- **Banner prefill.** **Add client certificate…** prefills `learnedPassthrough.host`. A server named by a web page in the
  proxied browser, or by a LAN client (see #1), can ask for "the app's own certificate". The popup doesn't say the
  certificate will be presented to *that* host. Show the host prominently next to Save ("will be sent to <host> during the
  TLS handshake").
- **Chooser spam.** `chooseClientCertificateFile` has no in-flight limit. A compromised panel can queue native choosers.
  In browser mode each one also calls `ProjectUtil.focusProjectWindow(project, true)`. Allow one at a time per view.
- **Legacy hosts in the plugin.** Removing an entry whose host was typed on the settings page and fails `certHostProblem`
  fails in the sidecar's `setPassphrase` (`sidecar/src/clientCerts.ts:116`). The entry goes, the PasswordSafe secret
  stays.

## Checked, fine

- **The probe stays inside what a CONNECT allows:**
  - it is opened with `openTunnelUpstream`, like a passthrough tunnel. LAN clients get `resolveCheckedTarget` and a pinned
    IP; the upstream proxy is used when set; emulator aliases apply only to non-LAN clients; `targetsSelf` is refused;
  - one per `host:port`, at most 4 at once, 60 s negative cache, 5 s deadline, sockets destroyed in `finally`;
  - only a ClientHello is sent. The chunk that decides is never handed to the TLS stack, and Node verifies the server
    certificate in JS after the handshake, so no alert, certificate or key exchange goes out;
  - a hostile server can only make the proxy learn its own `host:port`. The `Host` mismatch is #1.
- **What can't teach:**
  - `mock` and `rewrite` answers (probe `mock.js`: nothing learned);
  - Map Remote, send / resend (`noLearn`);
  - a configured certificate that was rejected: it says so, with no probe;
  - replay, a rule that names the host, `grpcDecryptHosts`.
  - `patternNamesHost` is linear (indexOf glob) and ignores `*`-only hosts, regexes and scheme-less patterns, as
    specified.
- **Performance:**
  - `forConnect` is one `Map.get` (plus `ruleNamingHost` only for `client-certificate` hits);
  - the event is coalesced per tick;
  - Status and agents cap the list at 200, and `learnedPassthroughView` filters malformed entries;
  - the map, `negative` and `decrypting` are bounded.
- **Tokens:**
  - 24 random bytes (base64url), bound to one role and valid for 10 minutes;
  - used up only by a successful save, at most 50;
  - bound to the issuing view through `certTokens` (a `WeakMap` on the view's sink, which is stable per VS Code
    panel / view and per sidecar WebSocket);
  - tokens from the palette command can't be used by a webview, and a token can't be used for another role.
- **Paths:**
  - the webview only ever gets a token and a sanitised base name;
  - `readCertFile` runs at choose time and again at save time: absolute, `realpath`, `stat`, `O_NOFOLLOW | O_NONBLOCK`,
    `fstat` dev / ino re-check, 1 MB, not empty. FIFOs and swaps are refused;
  - VS Code refuses non-`file` URIs, and the plugin refuses non-local files and checks paths again (absolute, one line,
    no comma).
- **Passphrase:**
  - it is never logged: the log lines name hosts and paths only;
  - it is never echoed: problems are the fixed `reasonOf` sentences, and `onlyKeys` errors name fields, not values;
  - it isn't in Status, and it isn't persisted by the webview (`certDialog` is not in `Persisted`; the field is cleared
    on send);
  - capped at 1024 (extension / sidecar) / 4096 (plugin) characters;
  - checked with `tls.createSecureContext` before anything is stored;
  - stored under `passphraseSecretKey(host)`, lower-cased on both sides, as the loader reads it.
- **User level only:**
  - VS Code reads `inspect().globalValue` and writes `ConfigurationTarget.Global`;
  - the plugin writes the application-level `InterceptSettings`;
  - workspace or folder values and launch.json can't add entries;
  - a shared rule can only keep a host decrypted, which makes the mTLS requests fail with an error that names the rule.
  - The broad patterns `*`, `*.*`, `*.com`, `**` and `*-*` are refused (REVIEW-8 #4 still holds through
    `certHostProblem`).
- **Agents:**
  - no agent tool, LM tool or MCP path reaches `clientCertUi` or `forgetLearnedPassthrough`; they only read
    `learnedPassthrough` (host, port, reason, until);
  - host names are validated host names, and HAR `_learnedPassthrough` has the same three fields.
- **System-browser fallback:**
  - the new messages ride the existing page-token + `Host` + `Origin`-checked WebSocket (`uiServer.ts`), one sink per
    socket;
  - another local page or process can't open it without the one-time token.
- **Webview:** host names, file names and problems are rendered as JSX text. There is no `innerHTML` anywhere in
  `packages/webview/src`.
- **Personal data:**
  - no home paths, LAN IPs, UDIDs, emails, team IDs or provider-format tokens in the diff or in afa2e62;
  - `mtls_server.mjs` binds `127.0.0.1` and makes throwaway certificates in a temp dir; `demo-pass` is a test-only value.

## Fixes (all findings fixed on feature/0.14.0)

| # | Fix | Commit |
|---|---|---|
| 1 | Learning keys on the CONNECT target. A refusal teaches only when the request's host (Host / `:authority` / SNI) and port equal the CONNECT target; otherwise nothing is learned and the error stays as before. Apps connecting by IP are learned under the IP. Tests include the review's attack (HTTP 116, nginx 400, gRPC). | bf7e971 |
| 2 | Pins and strikes are per client (the peer address; all loopback is one client, documented). A close / reset counts only after the proxy's TLS flight was written (> 512 bytes since the CONNECT). PERF-2: a connection that carried a request ends its watch, and a client that completed a decrypted request to the host within 60 s gets no strikes. Caps: 1000 in all, 250 per teaching client (its own oldest evicted), strikes swept by age. | 2834c17, bf7e971 |
| 3 | Plugin Settings Apply merges: only the user's own edits to the certificate text are applied on top of what is stored now; a panel add survives. | 7c0e2b4 |
| 4 | A failed save restores the previous passphrase (`getPassphrase`); an empty passphrase is deleted only after the write succeeded. Remove asks in the IDE (`confirmRemove`, VS Code modal / plugin dialog); a cancel changes nothing and sends nothing. | 82b5934, 7c0e2b4 |
| 5 | `forgetLearnedPassthrough` builds `[v6]:port` keys (`learnedKeyOf`), round-trip tested against the proxy's parser. | 82b5934 |
| 6 | HTML-400 `Connection: close` only for `text/html` and learnable hosts; probes hold their slot until done and have a 5 s deadline through an upstream proxy; probe answers reused both ways (no re-probe storm when full); pins step aside for rules added later; an expiry timer emits the event; the setting is `machine`-scoped; one file chooser at a time (host, sidecar, plugin); legacy plugin passphrases are deleted on Remove; the webview hides expired pins. The banner's host is the CONNECT target (#1). | various |

Remaining, documented: every loopback client is one client for pins (local processes, iOS simulators and Android
emulators can't be told apart), so another local process can still pin hosts for a simulator / emulator app for 10
minutes (Try decrypting again undoes it).
