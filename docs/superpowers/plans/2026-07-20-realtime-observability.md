# Realtime Observability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Identify whether concurrent screen-control degradation originates in the browser, server Relay, Windows Agent, or a specific Android device before changing the stream architecture.

**Architecture:** Keep the existing scrcpy transport unchanged. Add bounded, in-memory runtime telemetry at each boundary: browser playback reports, Relay forwarding/control timings, and Agent per-session stream/queue status. Expose a read-only administrator metrics response and render it only on the diagnostics page.

**Tech Stack:** Node.js, `ws`, browser MediaSource API, existing Phone Cloud diagnostics API.

## Global Constraints

- Do not alter scrcpy quality selection, control injection, reconnect behavior, or task scheduling in this change.
- Metrics must be bounded in memory and must not persist raw frames, input text, screenshots, tokens, or SMS contents.
- Browser reports at most once every five seconds per active session.
- Existing screen control messages and public APIs remain compatible.

---

### Task 1: Extend bounded Relay metrics

**Files:**
- Modify: `server/realtime-metrics.mjs`
- Modify: `server/realtime-metrics.test.mjs`

**Interfaces:**
- Produces `metrics.agentStreamReported(sessionId, payload)`.
- Produces `metrics.browserPlaybackReported(sessionId, payload)`.
- Extends `metrics.snapshot().video.sessions[]` with latest safe Agent and browser measurements.

- [ ] Write failing tests proving Agent FPS/bitrate/drop data and browser FPS/buffer/drop data are attached only to the matching active session.
- [ ] Run `node --test server/realtime-metrics.test.mjs` and confirm the missing methods fail.
- [ ] Store only normalized numeric fields: `fps`, `megabitsPerSecond`, `droppedFrames`, `bufferedBytes`, `presentedFrames`, `bufferMs`, `videoWidth`, `videoHeight`, `reportedAt`.
- [ ] Run the focused test until it passes.

### Task 2: Carry metrics over the existing authenticated sockets

**Files:**
- Modify: `server/screen-relay.mjs`
- Modify: `server/screen-relay.test.mjs`
- Modify: `windows-agent/src/screen-stream.mjs`
- Modify: `windows-agent/src/screen-stream.test.mjs`

**Interfaces:**
- Agent sends `{ type: "screen_stream_metrics", sessionId, metrics }` every five seconds.
- Browser control socket sends `{ type: "screen_playback_metrics", sessionId, metrics }` every five seconds.
- Relay accepts reports only from the session-bound Agent or browser token and does not forward them to device control.

- [ ] Write relay tests proving accepted reports update the metrics collector and malformed reports are ignored.
- [ ] Run `node --test server/screen-relay.test.mjs` and confirm the test initially fails.
- [ ] Add strict numeric clamping and session/Agent ownership checks in the Relay.
- [ ] Add Agent stream reports using its existing five-second stream window without logging a packet per frame.
- [ ] Run Relay and Agent focused tests until they pass.

### Task 3: Report browser playback quality

**Files:**
- Modify: `screen-client/main.js`
- Modify: `screen-client/main.test.mjs` or `screen-client/screen-ui.test.mjs`
- Modify: `public/app.js`

**Interfaces:**
- `ScreenController` sends the current player `fps`, `dropped`, `presented`, and `bufferSeconds` over the existing control socket every five seconds while connected.

- [ ] Write a failing test proving playback reports are rate-limited and sent only with an active control transport.
- [ ] Run the focused client test and confirm failure.
- [ ] Implement report scheduling and clear it when the controller stops.
- [ ] Run the focused test until it passes.

### Task 4: Render an administrator-only realtime diagnostic panel

**Files:**
- Modify: `public/index.html`
- Modify: `public/app.js`
- Modify: `public/styles.css`
- Modify: `screen-client/screen-ui.test.mjs`

**Interfaces:**
- Diagnostics page loads `GET /api/v1/metrics/operations` only when opened.
- Panel renders aggregate event-loop delay, active sessions, control P50/P95/P99, and one row per active session with Agent/browser measurements.

- [ ] Write a failing HTML/UI contract test for the realtime diagnostics panel.
- [ ] Run the focused UI test and confirm failure.
- [ ] Render readable empty, healthy, and overloaded states without exposing device input or credentials.
- [ ] Run `npm run check && npm run test:screen`.

### Task 5: Local evidence collection

**Files:**
- Modify: `docs/IMPLEMENTATION.md`

- [ ] Document a repeatable 1/3/5/10-device load-test command and the measurements required before any stream tuning.
- [ ] Run a local static test suite; real-device load execution remains opt-in and does not target production.

## Acceptance Criteria

- A five-device test can distinguish browser decode pressure, server Relay event-loop delay, Agent video backpressure, ADB queue wait, and Android-side control injection latency.
- Metrics remain bounded and are unavailable to normal users.
- No current screen stream behavior changes solely because telemetry was added.
