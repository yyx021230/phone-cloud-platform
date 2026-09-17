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
  for (const moduleName of ["scan", "publish", "name"]) {
    assert.match(html, new RegExp(`data-automation-module="${moduleName}"`));
    assert.match(html, new RegExp(`data-automation-module-panel="${moduleName}"`));
  }
});

test("browser wiring uses the public automation APIs", () => {
  assert.match(app, /\/api\/v1\/user\/automation\/xhs-publish-tasks/);
  assert.match(app, /\/api\/v1\/user\/automation\/alipay-name-sessions/);
  assert.match(app, /alipay-name-sessions\/\$\{encodeURIComponent\(session\.sessionId\)\}\/queries/);
  assert.match(app, /alipay-name-sessions\/\$\{encodeURIComponent\(session\.sessionId\)\}\/switch-account/);
  assert.match(app, /alipay-name-sessions\/\$\{encodeURIComponent\(session\.sessionId\)\}\/end/);
});

test("the lookup initiator can open screen control without relaxing other busy devices", () => {
  assert.match(server, /activeDeviceLockForScreenControl\(deviceId, screenOwnerUserId, \{\s*allowAdminOverride: ctx\.role === "admin"\s*\}\)/);
  assert.match(server, /screenControlConcurrentLookupAllowed/);
  assert.match(server, /screenControlNeedsHumanAction/);
  assert.match(server, /ctx\.role === "admin" \|\| session\.userId === ctx\.userId/);
  assert.match(server, /item\.userId === ctx\.userId \|\| ctx\.role === "admin"/);
  assert.match(server, /operatorMode: session\.userId === ctx\.userId \? "owner" : "admin_override"/);
  assert.match(server, /lookup_screen_control_active/);
  assert.match(app, /device\.busy && !ownsActiveSession && !device\.screenControlConcurrentLookupAllowed/);
  assert.match(app, /session\?\.operatorMode === "admin_override"/);
  assert.match(app, /控屏期间脚本暂停使用 Poco/);
  assert.match(app, /检测到拼图或人工验证；可立即开始控屏处理/);
  assert.match(app, /实时控屏中；结束控屏后可继续提交查名字或切换账号/);
});

test("human verification can be explicitly checked and resumed after screen control ends", () => {
  assert.match(html, /id="userLookupHumanResumeButton"/);
  assert.match(server, /resume-after-human-verification/);
  assert.match(server, /resumableLookupHumanVerificationResult\(session\)/);
  assert.match(server, /resumeAfterHumanVerification: true/);
  assert.match(app, /验证完成，继续获取本号码结果/);
  assert.match(app, /系统不会跳过或重新输入这个号码/);
  assert.match(server, /resultId: sourceResult\.resultId/);
  assert.match(server, /const resultId = String\(job\.resultId \|\| job\.jobId\)/);
  assert.match(server, /人工验证后当前号码查询完成/);
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
  assert.match(html, /id="userLookupSwitchButton"/);
  assert.match(html, /id="userLookupAccountChooser"/);
  assert.match(html, /id="userLookupAccountList"/);
  assert.doesNotMatch(html, /200 次切换账号/);
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
  assert.match(html, /app\.js\?v=20260909-lookup-human-resume-v2/);
});

test("lookup account switching waits for an explicit user choice", () => {
  assert.match(app, /status === "choosing_account"/);
  assert.match(app, /data-lookup-account-choice/);
  assert.match(app, /JSON\.stringify\(targetAccount \? \{ targetAccount \} : \{\}\)/);
  assert.match(app, /选择切换账号/);
  assert.match(styles, /\.lookup-account-chooser/);
  assert.match(styles, /\.lookup-account-choice\.is-current/);
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

test("lookup reports an evidenced account restriction before the failed task finishes", () => {
  assert.match(server, /isPostQueryLookupRestrictionEvent\(event\)/);
  assert.match(server, /已检测到当前账号查询受限，正在返回切号提示/);
  assert.match(server, /upsertLookupRestrictionHistory\(session/);
  assert.match(server, /restrictionHistory: \[\]/);
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
  assert.match(app, /result\.stage \|\| "未查询到姓名"/);
  assert.match(server, /job\.result\.notFound === true/);
  assert.match(server, /job\.result\.message === "account_not_real_named"/);
  assert.match(server, /支付宝账户未实名/);
  assert.match(server, /status: "not_found"/);
  assert.match(server, /input\.notFound !== undefined/);
});

test("an active lookup reloads when the deployed frontend version changes", () => {
  assert.match(app, /const CLIENT_UPDATE_CHECK_MS = 15_000/);
  assert.match(app, /async function reloadActiveLookupAfterClientUpdate\(\)/);
  assert.match(app, /client-version-check=/);
  assert.match(app, /if \(lookupActive\) window\.location\.reload\(\)/);
  assert.match(html, /app\.js\?v=20260909-lookup-human-resume-v2/);
});

test("lookup end can interrupt an already-running Windows automation task", () => {
  assert.match(server, /cancelledTaskIds/);
  assert.match(app, /state\.userLookupEnding/);
  assert.match(html, /styles\.css\?v=20260909-lookup-human-resume-v1/);
});
