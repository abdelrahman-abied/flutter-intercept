# PERF-6: IntelliJ / Android Studio sidecar baseline (2026-11-22)

This is the first measured pass of the sidecar, the Node process the IntelliJ plugin starts (CONTRACTS §15). It runs
the proxy, the traffic UI server and the agent API outside VS Code. Earlier passes (PERF-1 to PERF-5) measured only the
extension. The question was whether IntelliJ / Android Studio users pay a cost that VS Code users don't.

These are measurements, not estimates. Where a number is derived, the derivation is stated. **No code was changed.**

## 1. Environment and method

| | |
|---|---|
| Machine | Apple M4 Max, macOS 27, Node v26.4.0 |
| Code | `packages/sidecar/dist/sidecar.js` (3 290 310 bytes) built from `df75759` |
| Script | `perf6/side.mjs` in the session scratchpad, outside the repo |

The script drives the real sidecar as the plugin does: `node sidecar.js` with a neutral working directory and
`NODE_OPTIONS` cleared, talking newline-delimited JSON on stdio. It runs these steps:
1. `init`, with a fresh data folder (cold: the CA is created) or a reused one (warm).
2. 10 s idle.
3. The UI opens: the page with its one-time token, `webview.js`, and the WebSocket with `Origin`, using the `ws`
   package as JCEF would. Then `uiVisible`.
4. `prepareLaunch` for a macOS desktop run of a scratch Flutter project. This starts the proxy.
5. Traffic: 2 000 × 1 KB JSON, then 500 × 100 KB JSON, through the proxy (plain HTTP, keep-alive, 8 concurrent) from a
   local upstream. This runs once with the UI attached and once with it closed.
6. `shutdown`.

Sidecar CPU and RSS come from `ps`. The macOS footprint, which is what Activity Monitor shows, comes from
`footprint`. The heap breakdown comes from a `--require` probe that, on `SIGUSR2`, writes `process.memoryUsage()` and the
V8 space statistics after a forced GC. The heap contents come from a `--heapsnapshot-signal` snapshot. Every number in
§2 is from at least two runs.

## 2. Results

### 2.1 Start, idle, stop

| | |
|---|---|
| Finding Node (`node --version`, each candidate) | 20 ms |
| Spawn → `init` answered (warm / cold) | **112–122 ms / 120–123 ms** |
| RSS after `init` | 111 MB |
| CPU while idle, no UI (10 s) | **0 ms** |
| CPU while idle, UI open, after traffic (10 s) | 10 ms (≈ 0.1 %, `ps` resolution) |
| `prepareLaunch` incl. proxy start (warm / cold) | 107–123 ms / 143.6 ms |
| `shutdown` → process exit | 15.6–22.1 ms |

Start-up is about one Node start plus the bundle. The proxy itself loads lazily on first use, as in the extension
(PERF-1). Nothing runs while idle.

### 2.2 Opening the traffic UI

| | |
|---|---|
| Page (token redeemed) | 13.5 ms |
| `webview.js` (361.7 KB) | 3.1 ms |
| WebSocket open → first message (snapshot) | 6.3 ms |

### 2.3 Per request

| | proxy CPU per request | requests / s | messages to the UI |
|---|---|---|---|
| 1 KB answers, UI closed | 0.245–0.30 ms | 8 244–8 969 | — |
| 1 KB answers, UI open | 0.325–0.385 ms | 5 926–6 302 | 2 per exchange (`pending`, then `completed` with bodies) |
| 100 KB answers, UI closed | 0.32–0.42 ms | 5 151–6 121 | — |
| 100 KB answers, UI open | 0.56–0.60 ms | 3 186–3 635 | 1 per exchange, ~107 KB each |

An open UI adds ~0.08–0.12 ms per small answer and ~0.2 ms per 100 KB answer. That is the exchange (bodies included)
serialised and sent over the WebSocket, the same work VS Code does with `postMessage`. Nothing is sent twice:
- `pending` messages carry no body;
- the 1 000 `removed` messages are the store's 1 000-exchange cap evicting, 65 bytes each;
- the contract checks added 15 messages for 2 000 exchanges.

Sending bodies only when an exchange is opened would remove this cost. It would also change how the panel works (the
`body:` filter, opening big exchanges), so it is out of scope (see PERF-1 #8).

### 2.4 Memory after heavy traffic

| | |
|---|---|
| RSS at the peak of the four runs | 390–431 MB |
| After **Clear**, 3 s / 30 s later | unchanged (365–448 MB RSS; footprint 361 MB → 361 MB after 30 s) |
| Live heap after Clear + forced GC | **22 MB used**, 98 MB V8 heap committed (`new_space` 54 MB), `external` 48 MB |
| Heap snapshot after Clear | 32.4 MB in all (strings 11.8 MB, code 7.6 MB) |

There is **no leak**: after Clear, the live data is ~22–32 MB. But the process keeps its high-water mark.
- About 150 MB is V8 heap plus external memory still committed.
- About 250–300 MB is native memory that was freed but not given back to the system (derived: RSS 448 − heap 98 −
  external 48).

The churn comes from body capture and serialisation: copies, decoding, and JSON for the UI. That is PERF-1 #8's
finding (RSS far above the 256 MB body budget). In VS Code the same memory sits inside the shared extension host. In
IntelliJ it shows up as its own `node` process in Activity Monitor.

Tried, not adopted: `--max-semi-space-size=8` / `=16` for the sidecar. The footprint after traffic was 277–339 /
308–364 MB against 388–392 MB, and CPU per 100 KB answer was 0.40–0.48 against 0.32–0.38 ms. The runs varied a lot
and the gain was not consistent, so the flag is not worth its CPU.

## 3. Findings

| # | Finding | Status |
|---|---|---|
| 1 | Start 112–123 ms, idle 0 % CPU, UI open in ~23 ms, stop ~20 ms | OK |
| 2 | An open UI costs ~0.1 ms per small answer and ~0.2 ms per 100 KB answer (full exchanges over the WebSocket, nothing duplicated) | Accepted: the same as VS Code. Lazy bodies would change the panel (PERF-1 #8) |
| 3 | After heavy traffic, the sidecar keeps ~360–430 MB (footprint) although only ~22–32 MB is live. No leak | Open, folded into PERF-1 #8: it only shrinks if fewer copies of each body are made. Reconsider if users report the `node` process size |
| 4 | `--max-semi-space-size` for the sidecar | Not adopted: inconsistent gain, more CPU |

Plugin side (JVM): the plugin's start-up work is the Node probe (20 ms) and the spawn. Traffic never passes through the
JVM, because JCEF talks to the sidecar's WebSocket directly. So nothing on the plugin side needs a pass. JCEF render
time was not measured, as it needs a running IDE.
