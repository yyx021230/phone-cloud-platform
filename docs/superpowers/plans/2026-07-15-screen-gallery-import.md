# Screen Gallery Import Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an active real-time-control user import a PNG, JPEG, or WebP image into the currently controlled Android phone gallery.

**Architecture:** The browser submits the image only to its active `ScreenSession`. The server verifies session ownership, queues a device-bound `screen_gallery_import` task for the bound Windows Agent, then exposes only the task status to the session owner. The Agent writes the image to a temporary cache file, pushes it to `/sdcard/Pictures/PhoneCloud/`, requests a media scan, and deletes the local temporary file.

**Tech Stack:** Browser FileReader and Fetch, Node HTTP API, existing Windows task queue, Android Debug Bridge, existing Android media scanner command.

## Global Constraints

- Import accepts only PNG, JPEG, and WebP images no larger than 3 MB.
- The browser never sends a device id for import; the server derives it from the owned active screen session.
- The server removes `imageDataUrl` from the task state immediately after delivering the task to the Windows Agent.
- ADB push and media scan use `/sdcard/Pictures/PhoneCloud/`.
- No new APK, screen WebSocket message type, or direct browser-to-Agent connection is introduced.

---

### Task 1: Session-bound Import API

**Files:**
- Modify: `server/index.mjs:441-492`, `server/index.mjs:850-930`, `server/index.mjs:3421-3448`
- Modify: `server/screen-sessions.test.mjs`

**Interfaces:**
- Consumes: `screenSessions.get(sessionId)`, `screenSessions.canAccess(session, ctx)`, `createWindowsAgentTask(input)`, `normalizeQrImageDataUrl(value)`.
- Produces: `POST /api/v1/screen-sessions/:sessionId/gallery-import` and `GET /api/v1/screen-sessions/:sessionId/gallery-imports/:taskId`.

- [ ] **Step 1: Write the failing API authorization tests**

Add focused assertions around a small exported helper that makes the access rule explicit:

```js
test("screen gallery import only accepts its owning session", () => {
  const session = { sessionId: "screen-1", userId: "user-1", deviceId: "device-1", agentId: "agent-1", adbSerial: "serial-1", status: "live" };
  assert.equal(canQueueScreenGalleryImport(session, { userId: "user-1", role: "user" }), true);
  assert.equal(canQueueScreenGalleryImport(session, { userId: "user-2", role: "user" }), false);
});

test("screen gallery import only accepts valid image data", () => {
  assert.throws(() => normalizeQrImageDataUrl("data:text/plain;base64,aGVsbG8="), /PNG, JPEG, or WebP/);
});
```

- [ ] **Step 2: Run the focused test to verify it fails**

Run: `node --test server/screen-sessions.test.mjs`

Expected: FAIL because `canQueueScreenGalleryImport` is not exported or the route/task behavior does not exist.

- [ ] **Step 3: Add session-bound queue and status routes**

Add routes before the generic `/api/v1/screen-sessions/:sessionId` route:

```js
const screenGalleryImportMatch = url.pathname.match(/^\/api\/v1\/screen-sessions\/([^/]+)\/gallery-import$/);
if (req.method === "POST" && screenGalleryImportMatch) {
  const ctx = requireAuth(req, ["user", "admin"]);
  const session = screenSessions.get(decodeURIComponent(screenGalleryImportMatch[1]));
  if (!session || !screenSessions.canAccess(session, ctx) || !canQueueScreenGalleryImport(session, ctx)) {
    return json(res, 404, { error: "screen_session_not_found" });
  }
  const input = await readJson(req);
  const imageDataUrl = normalizeQrImageDataUrl(input.imageDataUrl);
  const task = createWindowsAgentTask({
    agentId: session.agentId,
    adbSerial: session.adbSerial,
    deviceId: session.deviceId,
    type: "screen_gallery_import",
    payload: { screenSessionId: session.sessionId, imageDataUrl }
  });
  addAudit("screen_gallery_import_create", ctx, { sessionId: session.sessionId, deviceId: session.deviceId, taskId: task.taskId });
  await saveState();
  return json(res, 202, { ok: true, task: publicScreenGalleryImportTask(task) });
}
```

The status route must require `screenSessions.canAccess`, require `task.type === "screen_gallery_import"`, and require `task.payload.screenSessionId === session.sessionId`. It returns only `taskId`, `status`, `createdAt`, `updatedAt`, and a sanitized `result.message`/`result.remotePath`.

When `/api/v1/windows-agents/:agentId/tasks/next` claims a `screen_gallery_import` task, create `const responseTask = publicWindowsTask(task)`, delete `task.payload.imageDataUrl`, save state, and return `responseTask`. This preserves the Agent payload while preventing long-lived server storage.

- [ ] **Step 4: Run the focused test to verify it passes**

Run: `node --test server/screen-sessions.test.mjs`

Expected: PASS.

### Task 2: Windows Agent Import Executor

**Files:**
- Modify: `windows-agent/src/index.mjs:629-646`, `windows-agent/src/index.mjs:1410-1467`
- Modify: `windows-agent/src/screen-stream.test.mjs`

**Interfaces:**
- Consumes: claimed task `{ type: "screen_gallery_import", adbSerial, payload: { imageDataUrl } }`, `adb(serial, args)`, `scanMediaFile(serial, remotePath)`.
- Produces: `taskScreenGalleryImport(task)` result `{ message, remotePath, bytes, timings, scan }`.

- [ ] **Step 1: Write the failing executor test**

Extract and test a dependency-injected helper:

```js
test("imports an image into the PhoneCloud gallery and scans media", async () => {
  const calls = [];
  const result = await importDataUrlToGallery({
    serial: "serial-1",
    taskId: "task-1",
    dataUrl: validPngDataUrl,
    cachePath: "/tmp/task-1.png",
    runAdb: async (_serial, args) => calls.push(args),
    scan: async (_serial, target) => ({ method: "scan", target })
  });
  assert.equal(result.remotePath, "/sdcard/Pictures/PhoneCloud/import-task-1.png");
  assert.deepEqual(calls.slice(0, 2), [["shell", "mkdir", "-p", "/sdcard/Pictures/PhoneCloud"], ["push", "/tmp/task-1.png", "/sdcard/Pictures/PhoneCloud/import-task-1.png"]]);
});
```

- [ ] **Step 2: Run the focused test to verify it fails**

Run: `node --test windows-agent/src/screen-stream.test.mjs`

Expected: FAIL because `importDataUrlToGallery` and the task type do not exist.

- [ ] **Step 3: Implement the executor with existing media scan**

Add the dispatch branch:

```js
else if (task.type === "screen_gallery_import") result = await taskScreenGalleryImport(task);
```

Implement `taskScreenGalleryImport` using an `importDataUrlToGallery` helper. The helper must accept only the existing image data URL format, derive its extension from MIME, write beneath `path.join(cacheDir, "screen-gallery")`, push to `/sdcard/Pictures/PhoneCloud/import-${task.taskId}.${ext}`, call `scanMediaFile`, and return a result with `message: "图片已导入手机图库"`. Use `finally` to remove the local cache file. Do not capture screen evidence for a successful import.

- [ ] **Step 4: Run the focused test to verify it passes**

Run: `node --test windows-agent/src/screen-stream.test.mjs`

Expected: PASS.

### Task 3: Real-time Control UI and Task Progress

**Files:**
- Modify: `public/index.html:270-300`
- Modify: `public/app.js:49-56`, `public/app.js:688-727`, `public/app.js:775-799`, `public/app.js:3276-3287`
- Modify: `public/styles.css` near `.screen-control-actions` and `.screen-text-toolbar`
- Modify: `screen-client/screen-ui.test.mjs`

**Interfaces:**
- Consumes: active `state.userScreenSession`, `state.userScreenDeviceId`, `fileToDataUrl(file)`, `api(url, options)`.
- Produces: `submitUserScreenGalleryImport()`, `pollUserScreenGalleryImport(taskId)`, and a session-bound file picker.

- [ ] **Step 1: Write the failing UI test**

Add static UI tests:

```js
test("screen workspace exposes a session-bound gallery import control", () => {
  assert.match(html, /id="userScreenGalleryImportInput"/);
  assert.match(html, /id="userScreenGalleryImportButton"/);
  assert.match(app, /screen-sessions\/\$\{encodeURIComponent\(sessionId\)\}\/gallery-import/);
  assert.match(app, /screen_gallery_import/);
});
```

- [ ] **Step 2: Run the focused test to verify it fails**

Run: `node --test screen-client/screen-ui.test.mjs`

Expected: FAIL because the file input and submit handler do not exist.

- [ ] **Step 3: Add the user interaction**

Add a hidden `<input type="file" accept="image/png,image/jpeg,image/webp">`, a visible `导入图片` button, and a compact `#userScreenGalleryImportHint` status node next to the screen controls. Add state fields for `userScreenGalleryImportTaskId`, `userScreenGalleryImporting`, and `userScreenGalleryImportHint`.

`submitUserScreenGalleryImport()` must require a selected file and an owned active session, use the existing `fileToDataUrl(file)` validation, POST `{ imageDataUrl }` to the session route, clear the file input, render `正在导入图片…`, then poll the status route every 700 ms for at most 45 seconds. Terminal success renders `图片已导入手机图库`; terminal failure renders the sanitized task message. Stopping or releasing a screen session clears the poll timer and import state.

- [ ] **Step 4: Run the UI test to verify it passes**

Run: `node --test screen-client/screen-ui.test.mjs`

Expected: PASS.

### Task 4: Full Verification and Release

**Files:**
- Modify: `public/index.html` cache version query strings.
- Modify: `docs/superpowers/specs/2026-07-15-screen-gallery-import-design.md` only if testing reveals an actual design adjustment.

- [ ] **Step 1: Run static and integration test suites**

Run: `npm run check && npm run build:screen && npm run test:screen`

Expected: all checks succeed with no failures.

- [ ] **Step 2: Test the live Android path**

Start a screen session for one online device, select a small PNG, and verify the status endpoint reaches `succeeded` with `remotePath` beginning `/sdcard/Pictures/PhoneCloud/`. Open the phone gallery through the active screen stream and verify the new image appears.

- [ ] **Step 3: Release only the changed web and Agent files**

Deploy `public/index.html`, `public/app.js`, `public/styles.css`, `server/index.mjs`, and `windows-agent/src/index.mjs`. Restart the platform container and the Windows Agent. Verify `/readyz`, the new cache version, and one end-to-end import.

- [ ] **Step 4: Persist the verified runtime image**

Run: `docker commit phone-cloud-platform phone-cloud-platform-phone-cloud:latest`

Expected: the committed image id is printed and the running container remains healthy.

## Self-review

- Spec coverage: session ownership, image validation, server data retention, Agent media scan, UI status, and device verification are covered in Tasks 1-4.
- Placeholder scan: no deferred requirements or undefined work items remain.
- Type consistency: `screen_gallery_import`, `imageDataUrl`, `screenSessionId`, `taskScreenGalleryImport`, and `publicScreenGalleryImportTask` are used consistently across tasks.
