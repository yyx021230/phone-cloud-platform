# Screen Text Input Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add secure, explicit text, enter, and delete controls to the existing Android scrcpy live-control session.

**Architecture:** The browser assigns sequence IDs and sends text through the existing authenticated screen WebSocket. The server validates the payload, and the Agent's per-session queue serializes it before using scrcpy clipboard paste. The scrcpy acknowledgement channel is enabled internally, but phone clipboard values are never forwarded to the browser, stored, or logged.

**Tech Stack:** Node.js, ws, scrcpy 3.3.4, @yume-chan/scrcpy, browser JavaScript, node:test.

## Global Constraints

- Do not expose automatic clipboard synchronization to the browser or platform.
- Do not log text content.
- Limit text to 1000 UTF-16 code units per message.
- Preserve ordering with touch and key controls.
- Keep the existing H.264, WebSocket, and MSE screen path.

---

### Task 1: Protocol And Browser Controller

**Files:**
- Modify: `screen-client/control-input.js`
- Modify: `screen-client/control-input.test.mjs`
- Modify: `server/screen-relay.mjs`
- Modify: `server/screen-relay.test.mjs`

- [x] Add failing tests for text sequence IDs, text validation, and enter/delete keys.
- [x] Run focused tests and confirm they fail because text is unsupported.
- [x] Implement minimal browser and relay support.
- [x] Run focused tests and confirm they pass.

### Task 2: Agent Injection

**Files:**
- Modify: `windows-agent/src/screen-control-queue.mjs`
- Modify: `windows-agent/src/screen-control-queue.test.mjs`
- Modify: `windows-agent/src/screen-stream.mjs`
- Modify: `windows-agent/src/screen-stream.test.mjs`

- [x] Add failing tests for text action labels and Android enter/delete key codes.
- [x] Run focused tests and confirm they fail.
- [x] Inject text with `setClipboard({ sequence, paste: true, content })` and add key codes.
- [x] Run focused tests and confirm they pass.

### Task 3: Product UI

**Files:**
- Modify: `public/index.html`
- Modify: `public/styles.css`
- Modify: `public/app.js`
- Modify: `screen-client/screen-ui.test.mjs`

- [x] Add failing UI tests for the explicit input field and send wiring.
- [x] Run UI tests and confirm they fail.
- [x] Add the compact input toolbar, disabled states, and event handlers.
- [x] Rebuild the screen bundle and run the full test suite.

### Task 4: Deployment And Real Device Verification

- [x] Deploy server and browser assets.
- [x] Deploy and restart exactly one Windows Agent.
- [x] Verify English, numbers, Chinese, delete, and enter on a real Android device.
- [x] Confirm device counts remain stable and the container remains healthy.
