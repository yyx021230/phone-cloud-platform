# Screen Latency And Control Reliability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Improve the existing scrcpy + H.264 + WebSocket + MSE screen-control path without adding quality profiles or changing decoder/transport technologies.

**Architecture:** Browser pointer events are coalesced and assigned sequence IDs, then relayed to a per-session serialized Agent control queue. The Agent acknowledges completed injections. Video remains MSE-based, with bounded WebSocket queues and keyframe-aware stale-frame dropping.

**Tech Stack:** Node.js, ws, scrcpy 3.3.4, @yume-chan/scrcpy, browser MediaSource, node:test.

## Global Constraints

- Keep the current H.264, WebSocket and MSE path.
- Do not add quality tiers, WebCodecs, WebRTC or ADB input fallback.
- Never drop pointer down, up, cancel or key events.
- Coalesce only pointer move events.
- Preserve current device/session authorization and exclusive screen lock behavior.

---

### Task 1: Browser Input Pipeline

**Files:**
- Create: `screen-client/control-input.js`
- Create: `screen-client/control-input.test.mjs`
- Modify: `screen-client/main.js`

**Interfaces:**
- Produce `createControlInput({ video, send, requestFrame, cancelFrame })` with `destroy()` and `flush()`.
- Every wire message contains a monotonic `sequenceId`.

- [x] Write failing tests proving pointer moves are coalesced once per animation frame, down/up ordering is preserved, and black-bar pointer-down events are ignored.
- [x] Run `node --test screen-client/control-input.test.mjs` and confirm the new tests fail.
- [x] Implement the input helper and integrate it into `PhoneCloudScreenController`.
- [x] Clamp mapped coordinates to `0..width-1` and `0..height-1`.
- [x] Run all screen-client tests.

### Task 2: Serialized Agent Control And ACK

**Files:**
- Create: `windows-agent/src/screen-control-queue.mjs`
- Create: `windows-agent/src/screen-control-queue.test.mjs`
- Modify: `windows-agent/src/screen-stream.mjs`
- Modify: `server/screen-relay.mjs`
- Modify: `server/screen-relay.test.mjs`
- Modify: `screen-client/main.js`

**Interfaces:**
- Produce `createScreenControlQueue({ execute, acknowledge })`.
- Agent emits `screen_control_ack` with `sessionId`, `sequenceId`, `status`, `action`, and `agentElapsedMs`.
- Browser reports `controlRttMs` through screen metrics.

- [x] Write failing tests for serialized down/move/up execution, latest-move coalescing, and ACK relay authorization.
- [x] Run the focused tests and confirm expected failures.
- [x] Implement the queue, Agent ACK, server forwarding, and browser RTT tracking.
- [x] Run the focused tests and confirm they pass.

### Task 3: Video Backpressure And Low-Latency Playback

**Files:**
- Create: `server/screen-backpressure.mjs`
- Create: `server/screen-backpressure.test.mjs`
- Modify: `server/screen-relay.mjs`
- Modify: `windows-agent/src/screen-stream.mjs`
- Modify: `windows-agent/src/screen-stream.test.mjs`
- Modify: `screen-client/mse-player.js`
- Modify: `screen-client/mse-player.test.mjs`

**Interfaces:**
- Produce a keyframe-aware gate that enters drop mode when WebSocket `bufferedAmount` exceeds 2 MiB and resumes on the next keyframe.
- Browser playback targets roughly 80-150ms and jumps near live when buffer exceeds 450ms.

- [x] Write failing tests for stale delta-frame dropping, keyframe recovery, and the reduced playback thresholds.
- [x] Run focused tests and confirm expected failures.
- [x] Add Agent/server backpressure gates and dropped-frame metrics.
- [x] Tune MSE playback catch-up without changing the decoder.
- [x] Run focused tests and confirm they pass.

### Task 4: Build, Deploy And Verify

**Files:**
- Rebuild: `public/vendor/screen-control.js`
- Modify: `public/index.html` only if the bundle cache key changes.

- [x] Run `npm run build:screen`.
- [x] Run `npm run check` and `npm run test:screen`.
- [x] Deploy server files and restart the phone-cloud container.
- [x] Deploy Windows Agent files and restart exactly one Agent process.
- [x] Verify a real phone reaches first frame, click and swipe ACKs arrive, browser buffer remains bounded, and no other devices go offline.
