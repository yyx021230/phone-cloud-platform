# Realtime Control Scalability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Support 100 ADB-online devices and 20 concurrent interactive screen sessions with isolated video/control transport and without snapshot persistence blocking realtime traffic.

**Architecture:** Keep scrcpy and the current browser H.264 player. First instrument and remove request-time full snapshot writes, then move realtime routing into an independent Relay process, split video and control channels, and finally introduce per-device Agent actors and capacity-aware quality profiles.

**Tech Stack:** Node.js 18+, `ws`, Postgres 16, Redis 8, scrcpy 3.3.4 through `@yume-chan/adb-scrcpy`, browser MSE/H.264, Docker Compose, Nginx.

## Global Constraints

- Existing user-facing screen-session APIs remain compatible during migration.
- Small Red Book automation continues to use Airtest/Poco and is outside this change.
- Realtime control never passes through Postgres or Redis.
- Redis stores runtime coordination only; Postgres remains the durable source of truth.
- Each stage is feature-flagged and independently reversible.
- No quality reduction is used to hide API or persistence stalls.
- Tests must pass before production deployment at every stage.

---

### Task 1: Realtime Performance Instrumentation

**Files:**
- Create: `server/realtime-metrics.mjs`
- Create: `server/realtime-metrics.test.mjs`
- Modify: `server/screen-relay.mjs`
- Modify: `server/index.mjs`
- Modify: `windows-agent/src/screen-stream.mjs`
- Modify: `screen-client/main.js`
- Modify: `package.json`

**Interfaces:**
- Produces: `createRealtimeMetrics({ now, monitorEventLoop })`
- Produces: `metrics.sessionStarted(session)`, `sessionClosed(sessionId)`, `videoForwarded(sessionId, bytes, dropped)`, `controlForwarded(sessionId)`, `controlAcknowledged(sessionId, rttMs, agentElapsedMs)`, `snapshotSaved(durationMs, bytes)`, and `snapshot()`.
- Consumes: existing `sessionId`, `agentId`, and `deviceId` fields.

- [ ] **Step 1: Add failing unit tests**

Test bounded histograms, active-session gauges, bitrate windows, control latency percentiles, snapshot duration, and event-loop delay conversion from nanoseconds to milliseconds.

- [ ] **Step 2: Run the focused test and confirm failure**

Run: `node --test server/realtime-metrics.test.mjs`

Expected: failure because `server/realtime-metrics.mjs` does not exist.

- [ ] **Step 3: Implement the bounded metrics collector**

Use fixed-size rolling samples rather than unbounded event arrays. Use Node's `monitorEventLoopDelay()` with a 20ms resolution and expose P50/P95/P99 in milliseconds.

- [ ] **Step 4: Instrument component boundaries**

Record browser-to-Relay control forwarding, Agent acknowledgement, video bytes, dropped packets, session lifecycle, and snapshot save duration. Do not log every video frame.

- [ ] **Step 5: Add an admin-only metrics endpoint**

Extend `GET /api/v1/metrics/operations` with a `realtime` object. Keep the response lightweight and exclude tokens, raw control payloads, and video data.

- [ ] **Step 6: Verify**

Run: `npm run check && npm run test:screen`

Expected: all existing and new tests pass.

---

### Task 2: Reproducible Multi-Session Load Harness

**Files:**
- Create: `scripts/screen-load-test.mjs`
- Create: `scripts/screen-load-report.mjs`
- Create: `scripts/screen-load-report.test.mjs`
- Modify: `package.json`
- Modify: `docs/IMPLEMENTATION.md`

**Interfaces:**
- Consumes: base URL, username, password, device IDs, duration, concurrency, and action cadence.
- Produces: JSON report containing first-frame time, FPS, bytes, control RTT P50/P95/P99, Agent duration, errors, and session release result.

- [ ] **Step 1: Add report aggregation tests**

Cover empty samples, percentile boundaries, mixed success/failure sessions, and guaranteed cleanup reporting.

- [ ] **Step 2: Implement the browser-compatible protocol client**

Reuse the production login and screen-session APIs. Connect to the production WebSocket protocol, receive video packets without decoding, send a safe home/overview/back sequence, and always delete sessions in `finally`.

- [ ] **Step 3: Add staged commands**

Add scripts for 1, 3, 6, 10, 15, and 20 sessions. Require an explicit device list; never select every online device implicitly.

- [ ] **Step 4: Verify locally without production devices**

Run report unit tests and the existing Relay integration tests. The real-device load command remains opt-in.

---

### Task 3: Structured Postgres Write Layer

**Files:**
- Create: `server/postgres-schema.mjs`
- Create: `server/postgres-repositories.mjs`
- Create: `server/postgres-repositories.test.mjs`
- Modify: `server/index.mjs`
- Modify: `server/state-repositories.mjs`

**Interfaces:**
- Produces: repositories for devices, SMS messages, XHS tasks, Windows tasks, task events, device locks, audits, and screen history.
- Each repository exposes `upsert`, `findById`, paginated query methods, and transactional batch methods where applicable.
- Produces: idempotent `backfillSnapshot(snapshot)` and `compareSnapshot(snapshot)` migration operations.

- [ ] **Step 1: Add SQL-generation and fake-client tests**

Assert one-row writes, conflict behavior, batch parameterization, SMS uniqueness, event append behavior, and transaction rollback.

- [ ] **Step 2: Move schema creation into a focused module**

Add missing normalized columns and indexes without dropping existing tables. Add `phone_cloud_screen_sessions` for durable session history only.

- [ ] **Step 3: Implement transactional repositories**

No repository method may serialize the complete platform state. Batch SMS inserts use one transaction and `ON CONFLICT` deduplication.

- [ ] **Step 4: Implement idempotent backfill and comparison**

Backfill can be run repeatedly. Comparison reports counts and sampled mismatches without changing reads.

- [ ] **Step 5: Verify against an isolated Postgres database**

Run repository tests with a temporary database in CI or a Docker Compose test profile.

---

### Task 4: Remove High-Frequency Snapshot Persistence

**Files:**
- Modify: `server/index.mjs`
- Modify: `server/runtime-save-scheduler.mjs`
- Create: `server/persistence-policy.mjs`
- Create: `server/persistence-policy.test.mjs`
- Modify: `docs/LAUNCH_READINESS.md`

**Interfaces:**
- Consumes: structured repositories from Task 3.
- Produces: `persistMutation(type, entity, options)` and `scheduleCompatibilityCheckpoint()`.

- [ ] **Step 1: Characterize every `await saveState()` call**

Classify calls as durable fact, runtime state, maintenance transition, or compatibility checkpoint. Add a test fixture that fails if a newly added request route directly invokes full snapshot persistence.

- [ ] **Step 2: Convert the hottest write paths**

Convert Agent device sync, SMS batch ingest, Windows task status, task events, XHS task transitions, device locks, audits, and screen-session history to one-row or batch structured writes.

- [ ] **Step 3: Remove writes from GET routes**

Maintenance state changes run in the maintenance worker and persist changed rows only. GET inventory, metrics, task polling, and SMS queries never write.

- [ ] **Step 4: Add a low-frequency compatibility checkpoint**

Checkpoint no more frequently than every five minutes and never while realtime sessions are active. Measure serialization duration and bytes. A process shutdown may flush once with a bounded timeout.

- [ ] **Step 5: Enable structured reads behind flags**

Use separate flags for SMS, task events, tasks, and inventory. Compare responses before cutting each read path over.

- [ ] **Step 6: Verify database behavior**

During a 10-minute six-session run, `phone_cloud_state` must not be rewritten by screen traffic, task polling, or GET requests. WAL growth must correspond to row mutations rather than full snapshots.

---

### Task 5: Dedicated Realtime Relay Service

**Files:**
- Create: `realtime-relay/index.mjs`
- Create: `realtime-relay/session-store.mjs`
- Create: `realtime-relay/session-store.test.mjs`
- Move/Adapt: `server/screen-relay.mjs` to `realtime-relay/screen-relay.mjs`
- Modify: `server/index.mjs`
- Modify: `server/screen-sessions.mjs`
- Modify: `docker-compose.yml`
- Modify: `Dockerfile`
- Modify: `docs/ALIYUN_DEPLOYMENT.md`

**Interfaces:**
- API creates session leases in Redis and emits lifecycle commands.
- Relay consumes lifecycle commands and owns Agent/browser connections.
- Existing `POST /api/v1/user/devices/:deviceId/screen-sessions` remains compatible and adds Relay connection metadata.

- [ ] **Step 1: Add Redis session-store contract tests**

Cover atomic device lease creation, TTL refresh, ownership validation, idempotent close, stale lease cleanup, and Agent-to-Relay routing.

- [ ] **Step 2: Create the standalone Relay entry point**

Expose `/healthz`, `/readyz`, Agent control WebSocket, browser session WebSockets, and lightweight metrics. Do not import platform state or Postgres repositories.

- [ ] **Step 3: Add reliable lifecycle delivery**

Use Redis Streams for start/stop commands with acknowledgement and stale-message claim. Touch, move, text, key, video, and control ACK messages remain direct WebSocket traffic.

- [ ] **Step 4: Add compatibility mode**

`SCREEN_RELAY_MODE=embedded|standalone`. Default remains embedded until standalone passes canary tests.

- [ ] **Step 5: Add Docker and Nginx deployment configuration**

Run the Relay on an internal port and route `/realtime/` WebSocket upgrades to it. Add CPU/memory health reporting and graceful drain on shutdown.

- [ ] **Step 6: Canary verification**

Route two devices to standalone Relay, run 30 minutes, then six devices. API latency and Postgres saves must not alter control RTT.

---

### Task 6: Split Video And Control Transport

**Files:**
- Modify: `realtime-relay/screen-relay.mjs`
- Modify: `windows-agent/src/screen-stream.mjs`
- Create: `windows-agent/src/screen-control-channel.mjs`
- Create: `windows-agent/src/screen-video-channel.mjs`
- Modify: `screen-client/main.js`
- Create: `screen-client/screen-transport.js`
- Create: `screen-client/screen-transport.test.mjs`

**Interfaces:**
- Agent control endpoint: `/realtime/v1/agents/:agentId/control`.
- Agent video endpoint: `/realtime/v1/sessions/:sessionId/video-publish`.
- Browser video endpoint: `/realtime/v1/sessions/:sessionId/video`.
- Browser control endpoint: `/realtime/v1/sessions/:sessionId/control`.

- [ ] **Step 1: Add transport authorization and isolation tests**

Verify wrong session, wrong Agent, expired token, cross-user access, video congestion, and control acknowledgement behavior.

- [ ] **Step 2: Split Agent control and session video sockets**

One Agent control socket carries lifecycle, control, status, and ACK messages. Every active session publishes video independently.

- [ ] **Step 3: Split browser video and control sockets**

Preserve the current UI/controller interface while replacing its internal transport. A video socket close must not silently keep a controllable session alive.

- [ ] **Step 4: Apply independent backpressure**

Track buffered bytes per video consumer. Never drop configuration packets. When dropping begins, resume only on a keyframe below the low-water mark.

- [ ] **Step 5: Verify control isolation**

Artificially throttle one video consumer. Control RTT and unrelated sessions must remain within SLO.

---

### Task 7: Per-Device Agent Actors And ADB Priorities

**Files:**
- Create: `windows-agent/src/device-actor.mjs`
- Create: `windows-agent/src/device-actor.test.mjs`
- Create: `windows-agent/src/adb-priority-queue.mjs`
- Create: `windows-agent/src/adb-priority-queue.test.mjs`
- Modify: `windows-agent/src/index.mjs`
- Modify: `windows-agent/src/screen-stream.mjs`
- Modify: `windows-agent/src/serial-reservation.mjs`

**Interfaces:**
- Produces: `DeviceActorManager.get(serial)`.
- Produces per-device operations: `startScreen`, `stopScreen`, `injectControl`, `runInteractiveAdb`, `runBackgroundAdb`, and `health`.
- Priority: screen lifecycle and control > user SMS refresh > automation > inventory scan.

- [ ] **Step 1: Add actor isolation and priority tests**

Test same-serial serialization, cross-serial concurrency, priority ordering, cancellation, crash isolation, and cleanup idempotency.

- [ ] **Step 2: Move scrcpy ownership into the device actor**

No global session failure may close another serial. Actor cleanup releases only its serial reservation and sockets.

- [ ] **Step 3: Route ADB operations through per-device queues**

Background scans yield to realtime operations on the same serial while continuing concurrently on other serials.

- [ ] **Step 4: Add actor health telemetry**

Expose queue depth, active operation, scrcpy generation, last control, restart count, and last failure without exposing SMS or credentials.

- [ ] **Step 5: Run a two-hour mixed-workload soak**

Exercise screen control, user-triggered SMS refresh, inventory scans, and automation tasks across different phones.

---

### Task 8: Quality Profiles, SLO Gates, And Production Cutover

**Files:**
- Create: `server/screen-quality.mjs`
- Create: `server/screen-quality.test.mjs`
- Modify: `server/index.mjs`
- Modify: `realtime-relay/screen-relay.mjs`
- Modify: `windows-agent/config.example.json`
- Modify: `public/app.js`
- Modify: `docs/LAUNCH_READINESS.md`

**Interfaces:**
- Produces profiles `high`, `standard`, `smooth`, and `auto`.
- `auto` selects a scrcpy profile at session creation from measured capacity; it never changes transport technology.

- [ ] **Step 1: Add deterministic profile-selection tests**

Cover requested profile, Agent capability, current active sessions, configured bandwidth ceiling, and hard minimum quality.

- [ ] **Step 2: Add the profile to session creation and UI**

Default to `auto`, remember the user's last choice, and display actual resolution/FPS/bitrate in diagnostics.

- [ ] **Step 3: Add SLO gates to the load report**

Fail the report when first frame, control P95/P99, FPS, buffer, errors, cleanup, or cross-session isolation violate the approved thresholds.

- [ ] **Step 4: Run staged production validation**

Run 2, 6, 10, 15, and 20 sessions. Then run 30-minute, two-hour, and eight-hour soaks. Record server public bandwidth separately from guest NIC statistics.

- [ ] **Step 5: Cut over and retain rollback**

Switch standalone Relay and structured reads on only after all gates pass. Retain embedded Relay and snapshot read compatibility for one release window, then remove them in a separate reviewed change.

## Plan Self-Review

- Coverage: persistence, Relay isolation, transport separation, Agent isolation, observability, security, capacity, rollout, and rollback are represented.
- Placeholders: no implementation step depends on an unspecified component or unnamed interface.
- Type consistency: session, Agent, and device identifiers remain stable across API, Redis, Relay, Agent, and browser boundaries.
- Scope: WebRTC, iOS, automation-script changes, payment, and UI redesign are explicitly excluded.
