import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const serverDir = path.dirname(fileURLToPath(import.meta.url));
const projectDir = path.dirname(serverDir);
const html = fs.readFileSync(path.join(projectDir, "public", "index.html"), "utf8");
const app = fs.readFileSync(path.join(projectDir, "public", "app.js"), "utf8");
const styles = fs.readFileSync(path.join(projectDir, "public", "styles.css"), "utf8");
const server = fs.readFileSync(path.join(serverDir, "index.mjs"), "utf8");

test("automation center exposes scan, publish and name lookup as peer modules", () => {
  for (const moduleName of ["scan", "publish", "kuaishou", "data", "name"]) {
    assert.match(html, new RegExp(`data-automation-module="${moduleName}"`));
    assert.match(html, new RegExp(`data-automation-module-panel="${moduleName}"`));
  }
});

test("browser wiring uses the public automation APIs", () => {
  assert.match(app, /\/api\/v1\/user\/automation\/xhs-publish-tasks/);
  assert.match(app, /\/api\/v1\/user\/automation\/alipay-name-sessions/);
  assert.match(app, /alipay-name-sessions\/\$\{encodeURIComponent\(session\.sessionId\)\}\/queries/);
  assert.match(app, /alipay-name-sessions\/\$\{encodeURIComponent\(session\.sessionId\)\}\/end/);
});

test("server keeps a lookup session reusable when Alipay requires human verification", () => {
  assert.match(server, /needsHumanVerification/);
  assert.match(server, /session\.status = "ready"/);
  assert.match(server, /needs_human_verification/);
  assert.match(server, /alipay_human_verification_required/);
});

test("automation forms override the legacy hidden scan field without leaking inactive modules", () => {
  assert.match(styles, /\[data-automation-module-panel\]\.hidden[\s\S]{0,100}display: none/);
  assert.match(styles, /\.automation-form-card \.scan-field[\s\S]{0,80}display: grid/);
});

test("publish and name lookup render as dedicated task consoles", () => {
  assert.match(html, /class="panel action-rail-card automation-form-card publish-compose-card hidden"/);
  assert.match(html, /class="panel action-rail-card automation-form-card lookup-console-card hidden"/);
  assert.match(html, /class="lookup-phone-station"/);
  assert.match(html, /class="publish-compose-grid"/);
  assert.match(styles, /Automation center — industrial task consoles/);
});

test("dynamic state rendering preserves the designed action-button structure", () => {
  assert.match(app, /userPublishSubmitButton\.innerHTML = `<span>/);
  assert.match(app, /userLookupStartButton\.innerHTML = `<span>/);
  assert.doesNotMatch(app, /userPublishSubmitButton\.textContent/);
  assert.doesNotMatch(app, /userLookupStartButton\.textContent/);
});

test("lookup startup exposes elapsed progress and a ready-to-query message", () => {
  assert.match(app, /已等待 \$\{startingSeconds\} 秒/);
  assert.match(app, /查询会话已就绪，可以输入手机号/);
  assert.match(html, /app\.js\?v=20261013-xhs-data-rc2/);
});

test("lookup results provide tail-copy controls inside a bounded scroll stream", () => {
  assert.match(html, /尾字 \/ 复制/);
  assert.match(app, /data-lookup-copy-result-id/);
  assert.match(app, /async function copyLookupTailToClipboard/);
  assert.match(app, /navigator\.clipboard\?\.writeText/);
  assert.match(app, /document\.execCommand\("copy"\)/);
  assert.match(app, /previousScrollTop/);
  assert.match(styles, /\.lookup-result-list[\s\S]*max-height: min\(430px, 54vh\)/);
  assert.match(styles, /overflow-y: auto/);
  assert.match(styles, /\.lookup-tail-copy\.is-copied/);
});

test("lookup query renders a server-backed running row and cancellable progress", () => {
  assert.match(server, /upsertLookupResult\(session, job/);
  assert.match(server, /status: "queued"/);
  assert.match(server, /lookupProgressStage/);
  assert.match(server, /accountSwitched: Boolean\(job\.result\.accountSwitched\)/);
  assert.match(app, /class="lookup-result-spinner"/);
  assert.match(app, /status: "submitting"/);
  assert.match(app, /status: "cancelling"/);
  assert.match(styles, /@keyframes lookup-spin/);
});

test("lookup polling cannot erase a locally submitted running row", () => {
  assert.match(app, /let userLookupSyncVersion = 0/);
  assert.match(app, /let userLookupRefreshPromise = null/);
  assert.match(app, /function canApplyLookupRefresh\(syncVersion\)/);
  assert.match(app, /syncVersion === userLookupSyncVersion && !state\.userLookupBusy && !state\.userLookupEnding/);
  assert.match(app, /const lookupSyncVersionAtStart = userLookupSyncVersion/);
  assert.match(app, /if \(userLookupRefreshPromise\) return userLookupRefreshPromise/);
  assert.match(app, /if \(lookup\.status === "fulfilled" && canApplyLookupRefresh\(lookupSyncVersionAtStart\)\)/);
  assert.match(app, /state\.userLookupSessions = lookup\.value\.sessions \|\| \[\]/);
  assert.match(app, /upsertUserLookupSession\(payload\.session, \{ preserveStopping: true \}\)/);
  assert.match(app, /refreshUserLookupSessionsOnly\(\{ force: true \}\)\.catch/);
});

test("lookup uses an independent one-second refresh and renders no-name as a completed result", () => {
  assert.match(app, /const USER_LOOKUP_REFRESH_MS = 1_000/);
  assert.match(app, /async function refreshUserLookupSessionsOnly\(options = \{\}\)/);
  assert.match(app, /refreshUserLookupSessionsOnly\(\)\.catch/);
  assert.match(app, /result\.status === "not_found"/);
  assert.match(app, /未查询到姓名/);
  assert.match(server, /job\.result\.notFound === true/);
  assert.match(server, /status: "not_found"/);
  assert.match(server, /input\.notFound !== undefined/);
});

test("an active lookup reloads when the deployed frontend version changes", () => {
  assert.match(app, /const CLIENT_UPDATE_CHECK_MS = 15_000/);
  assert.match(app, /async function reloadActiveLookupAfterClientUpdate\(\)/);
  assert.match(app, /client-version-check=/);
  assert.match(app, /if \(lookupActive\) window\.location\.reload\(\)/);
  assert.match(html, /app\.js\?v=20261013-xhs-data-rc2/);
});

test("lookup end can interrupt an already-running Windows automation task", () => {
  assert.match(server, /cancelledTaskIds/);
  assert.match(app, /state\.userLookupEnding/);
  assert.match(html, /styles\.css\?v=20261013-xhs-data-rc2/);
});
