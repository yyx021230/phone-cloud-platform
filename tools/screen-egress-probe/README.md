# Single-flow egress pacing probe (experimental)

Diagnostic tooling only. This is not a production congestion controller, not a
deployment script, and not an approved global configuration. It does not change
the encoder, Windows publisher or MediaMTX binary. Do not attach it to a shared
or wildcard production flow.

The Linux executable consumes one externally provisioned NFQUEUE. It matches an
exact IPv4 destination and UDP port pair, passes STUN/DTLS/RTCP immediately, and
paces RTP (including retransmitted RTP) without modifying/decrypting payloads.
SIGUSR1 starts baseline → paced → baseline blocks by default. The rate is a scheduling cap
including IP/UDP overhead, not an exact guaranteed throughput and not the H.264
quality bitrate. Go/kernel scheduling can make the achieved rate lower.

`--packets-per-group=1|2|4|8` controls the maximum immediate RTP burst,
independently of `--rate`. The default remains one packet. The group is charged
for its actual IP bytes before another group starts; a partial group does not
wait to fill, and idle periods do not accumulate catch-up credit. This changes
only the experimental tool, not Windows or the deployed MediaMTX sender.

`--coalesce-pending` is a separate, **default-off diagnostic intervention**.
During the paced block it compares complete opaque UDP payloads in memory and
holds byte-identical repeated packets behind their pending original. Only after
the original receives a successful accept verdict are those waiting copies
discarded and counted as `coalescedCopies`. Different content, truncated packets,
control traffic, and retransmissions arriving after release are not merged.
No packet is decrypted or logged. Gates and shutdown flush copies unchanged.
This mode therefore does **not** preserve every datagram count: validate unique
payload preservation and `received = accepted + coalescedCopies` at clean exit.
It is not permission to drop reference frames, suppress all NACKs, or deploy a
permanent production retransmission policy.

Exceeding the age/error gate latches pass-through and invalidates the trial.
Completion also enters pass-through; it waits for the owner to remove the rule
and send SIGTERM. It cannot guarantee loss-free operation if it is killed with
packets still queued: NFQUEUE bypass/fail-open is not a replacement for cleanup.

Required external harness safeguards, not implemented by this executable:

- Prove the current platform session belongs to the explicitly authorized phone
  and has exactly the expected viewer flow; recheck while sampling.
- Refuse when another NFQUEUE consumer is active. Keep unrelated rules, services
  and root qdisc untouched. The explicitly authorized manual10/129 controller
  may own two independent queues after proving both were initially unused;
  it must never share a queue or attach another owner's consumer.
- Install only a tagged exact-flow rule with `--queue-bypass`, after an independent
  TTL cleanup has been armed. Cleanup must delete that exact rule **before**
  terminating/draining this process, including SSH-disconnect/error paths.
- Stop and restore on an identity change or any latency/error gate; treat the
  result as inconclusive/failed rather than silently continuing.
- Record only numeric same-window telemetry, run real foreground gestures, and
  check queue/rule/process cleanup and unaffected sessions afterward.

Local checks:

```sh
go test -race ./...
GOOS=linux GOARCH=amd64 CGO_ENABLED=0 go build -o /tmp/screen-egress-probe .
```

On macOS the race test covers the platform-independent policy, not the Linux
netlink runner. Linux namespace integration evidence and current authorization
status are in `docs/SCREEN_10_DIAGNOSIS_20260910.md`.

On 2026-09-10 the first real device10 trial temporarily paced one existing
viewer. Its dynamic segment improved delivery but hit the 350ms age gate, so
the fixed 5Mbps candidate was withdrawn. Calibration then exposed Go timer
rounding: 5Mbps and 8Mbps both took about 330ms for 156 packets on that host.
The Linux worker now uses interruptible kernel nanosleep without busy-spinning;
the 8Mbps calibration took 200.7ms (still a cap, not exact throughput). The second
8Mbps trial had no new gesture records and was interrupted during the restored
baseline by a Windows Agent restart. It is **not a dynamic acceptance pass**.
All temporary production rules, queues, timers and the uploaded binary were
removed afterward. No permanent/global fix is deployed.

The subsequent 5/8/10Mbps × 1/2/4/8 packet matrix passed 12 isolated Linux
namespace calibrations (11,376/11,376 unchanged datagrams), with kernel receive
timestamps validating the group sizes and pacing intervals. Four bounded
overload cases passed as well (1,604/1,604 unchanged datagrams). These are
protocol/tool checks, **not customer-path loss tests or dynamic screen passes**.
The device10 viewer was absent at the initial preflight; real foreground
production trials only began after the user made that viewer available.
The isolated-test binary and empty remote staging directory were then removed;
no probe process, queue, host rule or timer was left behind.

The subsequent authorized real-client run tried all 12 combinations and repeated
10Mbps/2 then 10Mbps/1 in reverse order, with 840 native browser swipes across 14
45-second trials. Seven initial candidates hit the projected packet-age gate;
five completed the intervention. Neither repeated small-group candidate proved
stable playback. Net loss close to zero and low latency among matched control
samples are not acceptance criteria on their own. Diagnostics measure the next
presented callback after an acknowledgement, not a content-verified response
frame; some long waits were acknowledgement waits, distinct from media waiting.
All exact-flow rules, timers, queued packets, temporary client tasks, remote
probe files and the task-owned SSH multiplex connection were cleaned up. No
permanent sender policy was applied. See the diagnosis document and
`docs/evidence/SCREEN_10_EGRESS_MATRIX_20260910.json` for windows and limitations.

## Authorized manual10/129 canary (2026-09-10)

After three subsequent dynamic ABA trials, the user requested manual comparison
on phones10 and129. `--manual-duration` is an explicit 10s–60m bounded opt-in:
SIGUSR1 starts continuous pacing until expiry, then enters pass-through. Default
ABA behavior is unchanged; byte-identical-copy coalescing remains disabled.

`manual_canary.py` follows only the two hardcoded device IDs through authenticated
platform occupancy/session metadata, current MediaMTX reader IDs and unique
IPv4 UDP candidates. It detaches before following a replacement session; it does
not infer media slots from IDs. Only an exact tagged OUTPUT rule is inserted.
Metadata errors and packet-age/netlink gates remove the canary, without retrying
or restarting production components. Identity checks are sampled, not atomic
with application session transitions; this remains a bounded experiment.

Deploy this controller only with a private staging directory, an absolute lease,
an independently armed cleanup timer, and service `ExecStopPost` cleanup. Both
cleanup paths remove owned exact rules before signaling their workers. Do not
install this as an unbounded service or as a global pacing policy. Numeric status
distinguishes `waiting` (no current viewer) from `active`; waiting is not proof
that a real viewer has already received paced packets.

Python safeguards: `python3 -m unittest manual_canary_test -v`. The two-flow
`manual_namespace_test.py` must run **inside an isolated network namespace only**.
It checks unchanged payloads, independent pacing, unrelated-flow bypass and
expiry, not real customer playback quality. Production manual lease and results
are recorded in `docs/SCREEN_10_DIAGNOSIS_20260910.md`.
