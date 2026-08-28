import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const [html, app, screenBundle, server, css] = await Promise.all([
  readFile(new URL("../public/index.html", import.meta.url), "utf8"),
  readFile(new URL("../public/app.js", import.meta.url), "utf8"),
  readFile(new URL("../public/vendor/screen-control.js", import.meta.url), "utf8"),
  readFile(new URL("../server/index.mjs", import.meta.url), "utf8"),
  readFile(new URL("../public/styles.css", import.meta.url), "utf8")
]);

test("renders a dedicated wake screen button", () => {
  assert.match(html, /id="userScreenWakeButton"/);
  assert.match(html, />唤醒屏幕</);
});

test("keeps the large live screen and system navigation together on the left", () => {
  assert.match(html, /class="screen-control-layout"/);
  assert.match(html, /class="screen-viewer-column"/);
  assert.match(html, /class="screen-operations-column"/);
  const viewerStart = html.indexOf('class="screen-viewer-column"');
  const operationsStart = html.indexOf('class="screen-operations-column"');
  assert.ok(viewerStart > -1 && operationsStart > viewerStart);
  for (const selector of ["screen-device-shell", "screen-navigation", 'data-screen-key="back"', 'data-screen-key="home"', 'data-screen-key="overview"']) {
    const index = html.indexOf(selector, viewerStart);
    assert.ok(index > viewerStart && index < operationsStart, `${selector} must be in the viewer column`);
  }
});

test("groups all session and gallery controls in the right operation rail", () => {
  const operationsStart = html.indexOf('class="screen-operations-column"');
  assert.ok(operationsStart > -1);
  for (const selector of ["userScreenStartButton", "userScreenWakeButton", "userScreenStopButton", "userScreenGalleryFileInput"]) {
    assert.ok(html.indexOf(selector, operationsStart) > operationsStart, `${selector} must be in the operation rail`);
  }
  assert.match(html, /class="screen-operation-section screen-session-section"/);
});

test("uses a sectioned control rail and a four-card desktop inventory grid", () => {
  assert.match(html, /class="screen-operation-heading"/);
  assert.match(html, /class="screen-session-summary"/);
  assert.match(css, /\.user-device-grid\s*\{[^}]*grid-template-columns: repeat\(4, minmax\(0, 1fr\)\);/);
});

test("ordinary users can see who occupies a phone and when the usage started", () => {
  assert.match(app, /<span>使用者<\/span>/);
  assert.match(app, /<b>\$\{escapeHtml\(occupancy\.ownerLabel\)\}<\/b>/);
  assert.match(app, /occupancy\.label} · \$\{startedAt}/);
  assert.match(app, /profileFact\("当前使用者"/);
  assert.match(css, /\.user-device-inventory-view \.device-occupancy-line\s*\{[^}]*display: grid;/);
});

test("recovery UI explains continuous recovery and per-cycle cooldown", () => {
  assert.match(app, /continuous_recovery/);
  assert.match(app, /异常设备持续恢复/);
  assert.match(app, /recovery_cycle_cooldown/);
  assert.match(app, /冷却结束后自动开始下一轮/);
  assert.match(app, /只统计动作，不再作为停止条件/);
});

test("uses direct keyboard input on the focused phone surface", () => {
  assert.match(html, /id="userScreenVideo"[^>]*tabindex="0"/);
  assert.match(html, /id="userScreenKeyboardBridge"/);
  assert.match(html, /点击后可直接使用键盘输入/);
  assert.doesNotMatch(html, /id="userScreenTextInput"/);
  assert.doesNotMatch(html, /id="userScreenTextSendButton"/);
  assert.doesNotMatch(app, /function sendUserScreenText\(/);
  assert.match(screenBundle, /compositionend/);
  assert.match(screenBundle, /clipboardData/);
  assert.match(screenBundle, /select_all/);
  assert.match(html, /styles\.css\?v=20260827-lookup-results-v2/);
  assert.match(html, /app\.js\?v=20260827-screen-idle-10m-v1/);
  assert.match(html, /screen-control\.js\?v=20260806-ice-ready-wake-v1/);
});

test("screen workspace imports an image into the active phone gallery", () => {
  assert.match(html, /id="userScreenGalleryFileInput"/);
  assert.match(html, /导入到手机相册/);
  assert.match(app, /function importUserScreenGalleryImage\(/);
  assert.match(app, /screen-sessions\/\$\{encodeURIComponent\(sessionId\)\}\/gallery-imports/);
  assert.match(app, /function pollUserScreenGalleryImport\(sessionId, taskId\)/);
});

test("screen workspace accepts clipboard images through a dedicated paste input", () => {
  assert.match(html, /id="userScreenGalleryPasteButton"/);
  assert.match(html, /id="userScreenGalleryPasteZone"/);
  assert.match(html, /contenteditable="true"/);
  assert.match(app, /document\.addEventListener\("paste", \(event\) => \{/);
  assert.match(app, /handleUserScreenGalleryPaste\(event\)/);
});

test("screen workspace stages a selected or pasted image before confirming the gallery upload", () => {
  assert.match(html, /id="userScreenGalleryPasteZone"/);
  assert.match(html, /id="userScreenGalleryPreview"/);
  assert.match(html, /id="userScreenGalleryConfirmButton"/);
  assert.match(app, /function stageUserScreenGalleryImage\(file\)/);
  assert.match(app, /state\.userScreenGalleryDraftFile/);
  assert.match(app, /importUserScreenGalleryImage\(state\.userScreenGalleryDraftFile\)/);
});

test("screen workspace uses the selected paste-first gallery upload layout", () => {
  assert.match(html, /class="screen-gallery-import-head"/);
  assert.match(html, /在此粘贴图片/);
  assert.match(html, /Ctrl \+ V/);
  assert.match(html, /选择图片/);
  assert.match(html, /粘贴图片/);
  assert.match(html, /screen-gallery-confirm-button/);
  assert.match(html, /导入到手机相册/);
  assert.doesNotMatch(html, /class="screen-gallery-guide"/);
  assert.match(app, /state\.userScreenGalleryDraftDataUrl/);
  assert.match(app, /await fileToDataUrl\(file, \{ label: "待上传图片" \}\)/);
});

test("gallery preview stays collapsed until an image is staged and preserves the full image", () => {
  assert.match(html, /id="userScreenGalleryImport"/);
  assert.match(app, /classList\.toggle\("has-draft", Boolean\(galleryDraft\)\)/);
  assert.match(app, /hidden = !galleryDraft/);
  assert.match(css, /\.screen-gallery-draft\[hidden\]\s*\{\s*display: none !important;/);
  assert.match(css, /\.screen-gallery-draft img\s*\{[^}]*object-fit: contain;/);
});

test("manual wake uses the existing screen controller wakeup key", () => {
  assert.match(app, /userScreenController\?\.key\("wakeup"\)/);
});

test("releases an active screen session when the page is refreshed or closed", () => {
  assert.match(app, /function releaseUserScreenSessionOnPageExit\(\)/);
  assert.match(app, /method: "DELETE",[\s\S]{0,180}keepalive: true/);
  assert.match(app, /window\.addEventListener\("pagehide", releaseUserScreenSessionOnPageExit\)/);
});

test("screen sessions warn after ten idle minutes and default to disconnect after ten seconds", () => {
  assert.match(html, /id="userScreenIdleModal"/);
  assert.match(html, /role="alertdialog"/);
  assert.match(html, /已连续 10 分钟没有检测到操作/);
  assert.match(html, /id="userScreenIdleContinueButton"[^>]*>继续控制</);
  assert.match(html, /id="userScreenIdleDisconnectButton"[^>]*>立即断开</);
  assert.match(app, /import \{ ScreenInactivityGuard \} from "\.\/screen-inactivity-guard\.js\?v=20260827-screen-idle-10m-v1"/);
  assert.match(app, /stopUserScreenSession\(\{ detail: "长时间未操作，已自动断开" \}\)/);
  assert.match(app, /\["pointerdown", "keydown", "wheel", "touchstart"\]/);
  assert.match(app, /if \(!event\.isTrusted \|\| !state\.userScreenSession\?\.sessionId\) return/);
  assert.match(css, /\.screen-idle-modal\s*\{[^}]*position: fixed;[^}]*place-items: center;/);
  assert.match(css, /\.screen-idle-modal\[hidden\]\s*\{\s*display: none;/);
});

test("administrators can switch to the user workbench and return to management", () => {
  assert.match(html, /id="userTopAdminButton"/);
  assert.match(html, />管理后台</);
  assert.match(app, /role === "admin" && rolePage\(button\) === "user"/);
  assert.match(app, /const userWorkbenchChrome = state\.page === "user-workbench"/);
  assert.match(app, /userTopAdminButton\?\.addEventListener\("click"/);
  assert.match(app, /state\.page = "dashboard"/);
});

test("administrator user workbench loads the same user device data path", () => {
  assert.match(app, /const usesUserWorkbench = state\.page === "user-workbench"/);
  assert.match(app, /if \(state\.user\?\.role !== "admin" \|\| usesUserWorkbench\)/);
  assert.match(app, /if \(state\.page === "user-workbench"\) \{\s*renderUserWorkbench\(\);/);
});

test("administrator user workbench keeps user SMS refresh active", () => {
  const smsPanel = app.match(/function isUserSmsPanelActive\(\) \{[\s\S]*?\n\}/)?.[0] || "";
  assert.match(smsPanel, /state\.page === "user-workbench"/);
  assert.doesNotMatch(smsPanel, /role !== "admin"/);
});

test("screen workspace reports live FPS, buffer and control round-trip metrics", () => {
  assert.match(app, /onMetrics\(metrics\)/);
  assert.match(app, /controlRttMs/);
  assert.match(app, /bufferSeconds/);
});

test("screen workspace renders a native video element", () => {
  assert.match(html, /<video id="userScreenVideo"[^>]*muted[^>]*playsinline/);
  assert.doesNotMatch(html, /id="userScreenCanvas"/);
  assert.match(app, /video: els\.userScreenVideo/);
});

test("screen bundle has one MSE decoder path and no legacy decoder", () => {
  assert.match(screenBundle, /MediaSource/);
  assert.doesNotMatch(screenBundle, /TinyH264|WebCodecsVideoDecoder|VideoDecoder/);
});

test("content security policy does not permit WebAssembly eval", () => {
  assert.match(server, /script-src 'self'/);
  assert.doesNotMatch(server, /wasm-unsafe-eval|'unsafe-eval'/);
});

test("diagnostics presents live screen relay measurements without loading stream payloads", () => {
  assert.match(html, /id="realtimeDiagnostics"/);
  assert.match(app, /function renderRealtimeDiagnostics\(\)/);
  assert.match(app, /api\("\/api\/v1\/metrics\/operations"\)/);
  assert.match(app, /Agent 编码/);
  assert.match(app, /浏览器解码/);
  assert.match(app, /链路判断/);
});

test("diagnostics retains a compact completed-session history for post-run analysis", () => {
  assert.match(app, /const recentSessions = realtime\.sessions\?\.recent \|\| \[\]/);
  assert.match(app, /最近结束会话/);
  assert.match(app, /screenCloseReasonLabel/);
  assert.match(css, /\.realtime-history\s*\{/);
});

test("device inventory distinguishes an unauthorized ADB device from a disconnected one", () => {
  assert.match(html, /option value="unauthorized">未授权/);
  assert.match(html, /data-user-device-filter="unauthorized"[^>]*>未授权/);
  assert.match(html, /option value="offline">未连接/);
  assert.match(app, /function userDeviceAdbUnauthorized\(device\)/);
  assert.match(app, /ADB 未授权/);
  assert.match(app, /Windows 管理器未检测到这台手机/);
});

test("windows manager cards surface process load and active screen sessions", () => {
  assert.match(app, /进程 CPU/);
  assert.match(app, /进程内存/);
  assert.match(app, /投屏会话/);
  assert.match(app, /REALTIME_DIAGNOSTICS_REFRESH_MS/);
});
