# iOS WDA MJPEG Local POC Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Verify an iPhone can expose a local WDA MJPEG stream and accept WDA tap, swipe, and text commands from a browser test page.

**Architecture:** Xcode runs WebDriverAgent on the USB-connected iPhone. `iproxy` forwards WDA control port 8100 and MJPEG port 9100 to localhost. A standalone Node server owns the temporary WDA session and exposes a same-origin browser page that proxies the MJPEG bytes and translates browser input into W3C touch actions.

**Tech Stack:** Xcode/WebDriverAgent, libimobiledevice `iproxy`, Node.js built-in HTTP modules, browser HTML/CSS/JavaScript.

## Global Constraints

- Localhost only; do not modify Phone Cloud server, Windows Agent, or deployment configuration.
- Never send the device UDID, signing identity, or Apple account data to the browser.
- Release the WDA session when the browser disconnects or the local process exits.
- Use WDA for all iPhone control; do not use private iOS APIs.

---

### Task 1: Add a local WDA session bridge

**Files:**
- Create: `ios-wda-lab/mjpeg-control-poc/server.mjs`
- Test: `ios-wda-lab/mjpeg-control-poc/server.test.mjs`

**Interfaces:**
- Produces `POST /api/connect`, `POST /api/disconnect`, `POST /api/tap`, `POST /api/swipe`, and `POST /api/text`.
- Proxies the local WDA MJPEG stream as `GET /mjpeg`.

- [ ] **Step 1: Write tests for input validation and coordinate mapping.**
- [ ] **Step 2: Run the tests and confirm they fail before the bridge exists.**
- [ ] **Step 3: Implement a localhost-only server that creates and releases a WDA session and forwards valid commands.**
- [ ] **Step 4: Re-run tests and confirm they pass.**

### Task 2: Add a browser-only control surface

**Files:**
- Create: `ios-wda-lab/mjpeg-control-poc/index.html`
- Create: `ios-wda-lab/mjpeg-control-poc/app.js`
- Create: `ios-wda-lab/mjpeg-control-poc/styles.css`

**Interfaces:**
- Consumes the bridge endpoints from Task 1.
- Renders `/mjpeg` and maps pointer/touch input from the displayed image to the device viewport.

- [ ] **Step 1: Render connection state, image stage, control buttons, text field, FPS counter, and latency readout.**
- [ ] **Step 2: Send pointer taps and drag gestures using the bridge.**
- [ ] **Step 3: Send text only on explicit user command.**
- [ ] **Step 4: Verify browser-side coordinate mapping with a small unit test.**

### Task 3: Run real-device verification

**Files:**
- Create: `ios-wda-lab/mjpeg-control-poc/README.md`

- [ ] **Step 1: Start WDA with MJPEG port 9100 and JPEG quality/scaling settings.**
- [ ] **Step 2: Forward ports 8100 and 9100 over USB with `iproxy`.**
- [ ] **Step 3: Open the POC page, create a session, and verify the first playable frame.**
- [ ] **Step 4: Execute a visible tap, a swipe, and an explicit text input attempt.**
- [ ] **Step 5: Record observed FPS and command round-trip latency, then stop all temporary processes.**
