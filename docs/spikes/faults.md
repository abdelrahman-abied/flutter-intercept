# Faults, throttling and network profiles (proxy, v0.3.0)

Date: 2026-10-09. mockttp 4.6.3, Node 26.4, Dart 3.13.5 (real `dart:io` HttpClient), macOS arm64.
Contract: CONTRACTS §9.2. Code: `packages/proxy/src/{intercept-proxy,shaper,taps,upstream-pool}.ts`.
Measured by `packages/proxy/test/faults.test.ts` (prints the table below on every run), with
`test/fixtures/fault_client.dart`.

## The constraint: never fail the connection to the proxy

The generated entry uses `findProxy` = `PROXY host:port; DIRECT`. dart:io tries the proxies in order, and
**anything that fails while it is still connecting** falls through to `DIRECT`: the TCP connect to the proxy,
the CONNECT response (any status other than 200), and the TLS handshake inside the tunnel (all of these are
part of `_ConnectionTarget.connect`). On an emulator, `DIRECT` reaches the real network, so a fault at that
level would silently turn "simulate a failure" into "skip the proxy".

So every fault happens **at the request level**: mockttp has already answered the CONNECT with 200 and the
TLS handshake with the app is done (for `https://`), or the plain request's head has been read (`http://`).

The control row proves the detection: with the proxy port closed, Dart goes DIRECT and the upstream sees the
request (1 hit). Every fault row has 0 upstream hits (truncate: exactly the 1 forwarded request).

## What the app sees (real dart:io HttpClient, `PROXY 127.0.0.1:<port>; DIRECT`)

"ends in" = where the client was when it failed: `open` = `openUrl` (connecting, CONNECT, TLS),
`close` = `request.close()` (sending, waiting for the response head), `body` = reading the body,
`done` = success. Upstream response: 10,000 bytes.

| case | scheme | ends in | status | Dart type | message | body bytes | upstream hits | exchange |
|---|---|---|---|---|---|---|---|---|
| fault reset | http | close | – | `HttpException` | Connection reset by peer | 0 | 0 | blocked |
| fault reset | https | close | – | `HttpException` | Connection reset by peer | 0 | 0 | blocked |
| fault dns | http | close | – | `HttpException` | Connection closed before full header was received | 0 | 0 | blocked |
| fault dns | https | close | – | `HttpException` | Connection closed before full header was received | 0 | 0 | blocked |
| offline profile | http | close | – | `HttpException` | Connection closed before full header was received | 0 | 0 | blocked |
| offline profile | https | close | – | `HttpException` | Connection closed before full header was received | 0 | 0 | blocked |
| fault timeout (app timeout 1.5 s) | http | close | – | `TimeoutException` | TimeoutException after 0:00:01.500000 | 0 | 0 | blocked |
| fault timeout (app timeout 1.5 s) | https | close | – | `TimeoutException` | TimeoutException after 0:00:01.500000 | 0 | 0 | blocked |
| fault timeout (no app timeout; hold 3 s) | http | close | – | `HttpException` | Connection reset by peer | 0 | 0 | blocked |
| fault timeout (no app timeout; hold 3 s) | https | close | – | `HttpException` | Connection reset by peer | 0 | 0 | blocked |
| fault truncate | http | body | 200 | `HttpException` | Connection closed while receiving data | 5000 | 1 | blocked |
| fault truncate | https | body | 200 | `HttpException` | Connection closed while receiving data | 5000 | 1 | blocked |
| Slow 3G profile (+400 ms, 400 kbps) | http | done | 200 | ok | – | 10000 | 1 | completed |
| Slow 3G profile (+400 ms, 400 kbps) | https | done | 200 | ok | – | 10000 | 1 | completed |
| throttle dropRate 1 | http | close | – | `HttpException` | Connection reset by peer | 0 | 0 | blocked |
| throttle dropRate 1 | https | close | – | `HttpException` | Connection reset by peer | 0 | 0 | blocked |
| reference: a real DNS failure behind the proxy | http | done | 502 | ok | (body: `getaddrinfo ENOTFOUND …`) | 51 | 0 | error |
| control: proxy port closed | http | done | 200 | ok | – (went DIRECT) | 17 | **1** | – |

Before implementing, the same primitives were measured with a bare mockttp (`thenResetConnection`,
`thenCloseConnection`, `thenReply(502)`, `thenTimeout`): identical results, 0 upstream hits each.

How apps classify these: package:http wraps both `HttpException`s in `ClientException`; Dio reports them as
`DioExceptionType.unknown` with the `HttpException` as `error` (its `connectionError` is only used for a
`SocketException` while connecting, which a proxy can't produce without triggering DIRECT). Apps that check
"no response at all" (any exception rather than a status) treat all fault rows as a network failure.

## Semantics chosen

| action | what the proxy does | exchange |
|---|---|---|
| `fault: reset` | waits for the request (≤ 5 MB body, like block), then RST | `blocked`, "Fault: connection reset" |
| `fault: dns` | waits for the request, then closes without a response (FIN) | `blocked`, "Fault: DNS failure" |
| `fault: timeout` | holds the request unanswered; when the app gives up → closed; after `breakpointTimeoutMs` (default 5 min) → RST | `blocked`, "Fault: timeout (the app gave up after 1.5 s)" / "(reset after 300.0 s)" |
| `fault: truncate` | forwards (streaming route), then cuts the response body at half its `content-length` (or half the first chunk when unknown), FIN | `blocked`, status/headers as received, body = what the app got (`truncated: true`) |
| `throttle` | `latencyMs` before forwarding; `kbps` paces the response body to the app; `dropRate` = share of requests reset (after the latency) instead of forwarded | normal end + `simulated` ("+300 ms, 800 kbps"); drops `blocked`, "…: dropped" |
| profile `offline` | the `dns` fault for every request that would reach the network | `blocked`, "Offline" |
| profile `throttle` | as a throttle rule, for every request that would reach the network | `simulated` = preset label ("Slow 3G") |

**Why `dns` = close without a response.** A failed lookup is "no connection, no response". Through a proxy
the app can't get a `SocketException` at `openUrl` without the DIRECT fallback, so the closest is a
connection that ends before any response head. A 502 (what the proxy really answers when *its* lookup
fails, reference row) would make apps take their "server error" path, which is the opposite of what an
offline test wants. `reset` (RST) and `dns` (FIN) differ only in the message; both are "no response".

**`timeout` and app timeouts.** dart:io has no default response timeout (`connectionTimeout` covers only the
connect to the proxy, which succeeds), so an app without its own timeout (Dio `receiveTimeout`, http
`.timeout()`) waits until `breakpointTimeoutMs`, then sees a reset. Tested with a 3 s hold.

**What the profile touches.** Everything that would reach the network: requests with no rule, breakpoints
(an offline request breakpoint fails instead of pausing), throttle rules (whose own settings win over a
throttle profile), and `send()`. Mock, block and fault rules answer as configured. The trace sink is never
affected (it is decided before rules). A profile change applies to requests that arrive afterwards.

## Implementation notes

- **Latency without reading the body.** On the streaming route the latency is applied by the route matcher
  itself (mockttp awaits matcher promises): the passthrough starts only after it, and nothing touches the
  request body meanwhile (the "nothing reads the request body before streaming" rule in proxy.md). If the
  app leaves during the delay, the request is not forwarded. On hooked routes (breakpoints) it is applied in
  `beforeRequest`, after a resume.
- **kbps is streaming** (`src/shaper.ts`, installed by the tap on the tracked response's `write`/`end`):
  50 ms ticks of `kbps × 125 × 0.05` bytes; `write()` returns false while chunks are queued and `'drain'` is
  emitted when the queue is empty, so a piped upstream is paused instead of read ahead. A response
  breakpoint's single `end(body)` is sliced the same way. Only delivered bytes are recorded.
  Measured: 100 KB at 800 kbps → first byte < 300 ms, total ≈ 1.0–1.5 s, body intact (Node, http and https).
- mockttp checks `response.writableEnded` as soon as the upstream ends; with a paced queue the real `end()`
  is later, so the shaper defines an instance getter `writableEnded = true` from the moment `end()` was
  requested (removed after the real end). Otherwise mockttp would log "handler finished without ending the
  response" and append an error text.
- A throttled response the app abandons midway gets no mockttp `'abort'` (mockttp considers the request
  handled); the tap's close records it as `error` ("…before the throttled response was complete").
- **truncate** ends the app's socket (FIN) after the cut, so the bytes before it arrive; mockttp then aborts
  the upstream request (its `clientRes 'close'` handler).

## Open issues

- `kbps` limits the response body only (not the upload, not the response head), per contract.
- An offline/`dns`/`reset` fault first receives the request body (≤ 5 MB kept), like `block`; a large upload
  completes before the app sees the failure.
- Websockets are not throttled or faulted (rules don't apply to them, as before).
- `dropRate` uses `Math.random()` per request; not seeded.
