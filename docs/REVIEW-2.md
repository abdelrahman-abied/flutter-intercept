# Review 2: LAN mode security (independent, HEAD 15c14d0) — findings and fix plan

| # | Sev | Finding | Owner |
|---|---|---|---|
| 1 | MED | Close race: `LanGate.close()` destroys sockets and waits **before** `server.close()`, so connections accepted in that window are authenticated and handed to mockttp after `closeLan()` cleared `lanGate`/`pool.lan`. Every guard is keyed on "LAN mode on", not "this socket is LAN", so the survivor needs no more auth and has no SSRF guard. Experiment: 1 of 12,945 survived; unauthenticated `GET http://0.0.0.0:<svc>/` reached a 127.0.0.1-only service (`SECRET`). | C |
| 2 | MED (design) | The token travels in clear over Wi-Fi (open network sniffing or ARP-spoofing MITM on WPA2) and any source IP is accepted. The SSRF guard blocks this Mac's own addresses but not *other hosts* reachable through its other interfaces: VPN/tailnet (`100.64.0.5` via utun1 allowed), VM host-only nets (Parallels `10.211.55.x`, `bridge100` `192.168.64.x`). A sniffed token = authenticated pivot into the developer's VPN/VMs. | C (pinning, subnets) + B (notice, docs) |
| 3 | LOW-MED | Unauthenticated DoS: head timeout is an idle timeout (1 byte/10 s keeps a socket ~10 days), no connection cap, `Buffer.concat` per chunk. 300 slow 64 KB heads → event-loop stalls up to 310 ms, ~89% busy, +50 MB RSS. | C |
| 4 | LOW | Token written to disk by flutter_tools: dart-defines in `ios/Flutter/Generated.xcconfig` and `flutter_export_environment.sh` (gitignored by default), baked into the debug app, visible in `flutter run` args. Only usable while a session is live. | B (docs) |
| 5 | LOW | Listener doesn't follow network changes (same DHCP IP on a new network keeps it reachable there); `lanAddress.ts` doesn't require RFC 1918 unless a VPN owns the default route. | B |

## Fix plan
- **C:** close sets `closed` and calls `server.close()` first; refuse in `onConnection`/`onHead` once closed.
  Guards keyed on the socket (`isLanConnection`): always guarded even with no gate (407 / deny / guarded
  agent or throw). Pin to the first authenticated peer IP for the lifetime of the token (refuse other peers
  even with a valid token). Forbid every subnet of interfaces other than the listener's own (utun, ipsec,
  bridge, vmnet, etc.), not only their addresses. Absolute head deadline at accept, `maxConnections`
  ≈ 64 + per-IP cap, incremental `\r\n\r\n` search.
- **B:** close the listener when the LAN interface address changes or disappears; require RFC 1918 (or CGNAT
  only when explicitly the Wi-Fi interface? — no: require RFC 1918); LAN notice mentions shared/untrusted
  Wi-Fi; README: shared-Wi-Fi caveat + token-on-disk note.
