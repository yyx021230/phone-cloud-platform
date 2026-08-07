# Realtime Control Scalability Design

## Goal

Support 100 ADB-online Android devices and an initial target of 20 concurrent interactive screen sessions without database activity, one slow device, or one congested stream degrading unrelated sessions.

## Current Evidence

- Three concurrent sessions already raise control RTT P95 to roughly 1.7-2.5 seconds.
- Six concurrent sessions produce 2-4.5 second RTT and control acknowledgement timeouts.
- Agent-side scrcpy injection remains 0-3ms, so phone-side control execution is not the shared bottleneck.
- The API process, realtime WebSocket relay, JSON serialization, and Postgres writes share one Node.js event loop.
- The snapshot is about 33MB as JSON text and 15MB as JSONB.
- `phone_cloud_state` has been inserted roughly 699,000 times and Postgres reports about 14TB of WAL since the statistics reset.
- Every Agent currently multiplexes all device video packets, lifecycle messages, control messages, and control acknowledgements over one WebSocket.

## Architecture Decision

Adopt a control-plane/data-plane split while retaining scrcpy, the existing browser H.264 player, existing public API routes, and the current Agent authentication model.

### Control Plane

The Phone Cloud API owns authentication, authorization, inventory, SMS, automation tasks, durable audit history, and screen-session creation. Postgres stores durable facts in structured tables. Redis stores short-lived leases, online TTLs, session routing, and lifecycle commands.

### Realtime Data Plane

A dedicated Realtime Relay process owns Agent and browser WebSockets. It does not load the full platform snapshot, write SMS, write task events, or perform database compaction. Video and control use separate channels so video congestion cannot queue control acknowledgements.

### Agent Device Actors

Each ADB serial has one logical actor that owns its scrcpy session, control queue, video publisher, ADB priority queue, health state, and cleanup lifecycle. Operations are serialized per serial and concurrent across serials. Active screen control has higher priority than SMS refresh and ordinary inspection for the same serial.

## Target Data Flow

### Session Lifecycle

1. Browser calls the existing screen-session creation API.
2. API validates listing, ADB status, ownership, and device lock.
3. API creates a short-lived Redis session lease and one-time browser credentials.
4. API emits a reliable start command for the Relay.
5. Relay sends the lifecycle command over the Agent control channel.
6. Agent starts the device actor's scrcpy session and opens the session video channel.
7. Browser connects separate video and control WebSockets.
8. Stop, expiration, browser disconnect, Agent disconnect, and process shutdown release the lease idempotently.

### Video

`scrcpy -> Agent session video socket -> Realtime Relay -> browser video socket -> MSE player`

The Relay performs no decoding or transcoding. Backpressure is tracked independently per session. Once congestion begins, non-keyframes may be dropped until a decodable keyframe boundary is available.

### Control

`browser control socket -> Relay -> Agent control socket -> device actor -> scrcpy controller -> acknowledgement`

Control never passes through Postgres, snapshot persistence, Redis Streams, or the video socket. Redis is only used for lifecycle coordination, leases, and lightweight runtime state.

## Storage Migration

The current JSONB snapshot remains a compatibility source during migration, but no longer remains the write path for high-frequency facts.

Migration order:

1. Backfill structured tables from the current snapshot.
2. Introduce repository methods that write one device, SMS message, task, event, lock, or audit row transactionally.
3. Dual-write and compare structured rows against snapshot projections.
4. Move list and detail reads to structured SQL queries.
5. Stop request-time snapshot persistence.
6. Retain a low-frequency compatibility checkpoint until rollback confidence is established.

Snapshot checkpoints must never run in the Realtime Relay process.

## Capacity Model

The current upper profile is 1600px, 30 FPS, and 5Mbps per session. Expected aggregate video traffic is therefore:

| Concurrent sessions | Typical to upper traffic per direction |
| --- | --- |
| 6 | 18-30Mbps |
| 15 | 45-75Mbps |
| 20 | 60-100Mbps |
| 50 | 150-250Mbps |

The first production target is 20 concurrent sessions. The deployment must have at least 30% network headroom above measured peak traffic. Public cloud egress limits must be verified outside the guest operating system.

## Quality Profiles

- `high`: max size 1600, 30 FPS, 4-5Mbps.
- `standard`: max size 1280, 30 FPS, 2.5-3Mbps.
- `smooth`: max size 960, 24 FPS, 1.2-2Mbps.
- `auto`: selects one scrcpy profile when the session starts; it never switches control technology.

Quality changes are not the first performance fix. Process isolation and persistence repair must be validated first.

## Observability

All components use `sessionId`, `agentId`, and `deviceId` correlation fields.

Required metrics:

- active and connecting sessions;
- first-frame duration;
- per-session FPS, bitrate, forwarded frames, and dropped frames;
- Agent and browser WebSocket buffered bytes;
- control RTT P50/P95/P99 and Agent injection duration;
- Node.js event-loop delay P50/P95/P99;
- snapshot and structured write duration;
- Relay CPU, memory, ingress, and egress;
- device actor restart, control timeout, and cleanup counts.

## Security

- Browser video and control credentials are one-time, random, hashed at rest, scoped to one session, and expire with the session lease.
- Agent connections remain outbound and authenticate with the Agent-specific token.
- Relay validates session ownership and Agent routing before forwarding.
- Control messages have strict schemas, payload limits, and per-session rate limits.
- A user cannot observe or control a session owned by another user.
- Realtime endpoints never expose Agent tokens or ADB serials unnecessarily.

## Availability And Isolation

- One device actor failure closes only that device session.
- One browser video consumer becoming slow cannot block another session.
- API or Postgres latency cannot delay active control messages.
- Relay restart may terminate active sessions in the first deployment, but leases and locks are reclaimed automatically.
- Later Relay sharding uses Agent affinity and Redis routing without changing browser-facing APIs.

## Service-Level Objectives

- Warm first frame: P95 <= 3 seconds.
- Cold first frame: P95 <= 8 seconds.
- Control RTT at 20 concurrent sessions: P95 <= 300ms, P99 <= 600ms.
- Agent injection: P95 <= 20ms.
- Presented FPS: P95 session average >= 24 FPS on `standard` under active UI motion.
- MSE live buffer: P95 <= 150ms.
- Cross-session failure propagation: zero.
- Eight-hour soak: no permanently occupied device, unreleased session, or control channel that requires page refresh.

## Rollout

1. Instrument the current path and preserve a reproducible baseline.
2. Replace high-frequency snapshot writes with structured writes.
3. Deploy the Relay as a separate process while keeping the old relay behind a feature flag.
4. Split Agent and browser video/control channels.
5. Introduce device actors and ADB priority scheduling.
6. Validate 2, 6, 10, 15, and 20 concurrent sessions.
7. Run 30-minute, 2-hour, and 8-hour soak tests before removing the old path.

Each rollout stage has an independent feature flag and rollback. Database migration is additive until structured reads are proven equivalent.
