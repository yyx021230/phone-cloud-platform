# Viewer RTP pacing — D-075 global production activation

Activated on 2026-09-10 at 10:16:25 UTC after explicit media-restart approval.
Production enables 8Mbps / 2 packets via a persistent systemd drop-in for all
`pc/` viewers; the binary remains disabled when that environment is absent.
Three reconnected production viewers and organic input were observed initially.
This is not completed all-device, 15-viewer or long-duration acceptance. See
`docs/evidence/VIEWER_PACING_PRODUCTION_20260910.json` for results and limits.

This extends the 2026-09-10 phone10/129 smooth-egress experiments. It does not
change Windows pacing, scrcpy encoding, resolution, frame rate, SDP codecs,
NACK generation, browser control or the host firewall/qdisc.

Pinned upstream references: [MediaMTX interceptor registration](https://github.com/bluenviron/mediamtx/blob/v1.18.2/internal/protocols/webrtc/peer_connection.go),
[Pion chain binding order](https://github.com/pion/interceptor/blob/v0.1.45/chain.go),
[Pion NACK saved-writer path](https://github.com/pion/interceptor/blob/v0.1.45/pkg/nack/responder_interceptor.go).

The MediaMTX v1.18.2 overlay installs a separate interceptor **per pc/ viewer**,
before Pion's NACK responder in registry order. Both normal writes and the
responder's saved writer therefore consume one common budget. All tracks for
one viewer share that budget; different viewers do not share locks. RTCP,
STUN/DTLS and data channels are not routed through this interceptor.

Initial candidate: 8 Mbps scheduling budget, at most 2 packets immediately,
no idle/catch-up credit, no packet content changes, no reference-frame discard.
Budget includes conservative 64-byte transport overhead, not precise on-wire
accounting. This is not an 8 Mbps encoder setting, guaranteed delivery rate,
total-server bandwidth allocation or congestion control. Fifteen simultaneous
viewer bursts can still contend on a shared server uplink; that needs measured
multi-viewer acceptance, not a single-viewer claim.

Writes are synchronous: no new asynchronous packet copies/queues or per-packet
goroutines. That also means pacing can create upstream per-reader backpressure.
The 350ms gate measures waiting **inside this interceptor**, not the age of an
entire frame in MediaMTX's existing reader buffer. A gate hit latches visible
pass-through for that peer; it does not drop reference packets or restart a
connection. `bypass=true` is a failed pacing acceptance, not a healthy success.
This does not fix Pion's existing per-NACK goroutine creation or bound the
network writer itself. Inspect MediaMTX discarded frames and source/browser
delivery alongside pacing counters before deployment.

Closing a peer cancels waiting writers; transport write errors are preserved.
Linux uses interruptible <=2ms kernel sleeps, not busy-spin/realtime scheduling.
Metadata logs show packets, budget bytes, max wait, waiting callers, write errors
and bypass; they do not include credentials, addresses or media content.

## Build and validation

`go test -race -count=3 ./...` in this module covers payload preservation,
group limits, no idle credit, 15 independent viewers, shared-track budget,
close/error handling, control bypass and the **real Pion v0.1.45 NACK responder**.

From the project root:

```sh
node deploy/mediamtx-pacing/build.mjs /absolute/new/path/mediamtx-candidate
```

The build checks the upstream Go module and two exact hook hashes, overlays only
the viewer registration, executes upstream WebRTC package tests, builds a Linux
candidate and records hashes. It never deploys. The old stock installer now
refuses before any download, file write or service operation: stock MediaMTX
would silently remove this functionality even with the pacing environment set.

## Preserve this production baseline on later releases

`deploy/mediamtx-pacing/production-baseline.json` pins the approved binary hash,
service paths and 8Mbps / 2-packet environment. Changing the baseline requires
explicit user approval and matching decision, test and rollback evidence.
Do not automatically bless a rebuilt artifact just because its version matches.

```sh
# Local files only; NOT a production success claim.
node deploy/mediamtx-pacing/verify.mjs --repository
# On the Linux media host, before and after every release; read-only.
# Requires permission to read the service's /proc environment (normally root).
node deploy/mediamtx-pacing/verify.mjs --live
```

The live guard checks both installed and running executable hashes, the exact
persistent drop-in, active process pacing values, and a stable service PID.
It never changes configuration, starts a viewer or restarts a service. It does
not replace real-session `viewer_pacing` / bypass / discard / browser checks.
Ordinary compose deployment runs this guard before and after startup, even if
optional preflight is disabled. On hosts without any local media installation
it reports `repository-only`; a separate media host still requires `--live`
before release sign-off. Existing old deployment checkouts do not acquire these
guards until these local changes are included in the next approved release.

On macOS the two upstream test functions that explicitly select Linux `lo` are
reported as requiring Linux validation, not silently counted as passes. Their
three local candidate and five connectivity variants passed separately in an
isolated Linux loopback namespace; external-STUN variants were not run there.
Three native ICE/DTLS/SRTP A/B runs received all 100 packets each, with paced send
spans 118.22–118.26ms. See the D-075 evidence file; this is not a browser FPS test.

## Activation gate

The binary defaults to disabled. The separately supplied systemd drop-in enables
it for **new pc/ viewers**, but installing/restarting the shared media service
disconnects current viewers and publishers. Do not do that implicitly while
users are connected. Back up the exact live binary, configuration and service;
verify the live version and source dependencies before replacement. Do not
deploy the rest of this dirty project checkout.

Do not pace twice: retire the owned temporary10/129 NFQUEUE rules and drain its
workers before activating native pacing. Do not remove anyone else's rules.
After isolated Linux and single/two-viewer dynamic acceptance, expand to all
viewers. Check real input, source and presented frame rates, same-window loss,
NACK, freeze, MediaMTX discard, source queue, CPU and physical egress counters.
An error, bypass or discard regression blocks expansion; restore the exact
binary/drop-in baseline, with the restart impact explicitly authorized.
