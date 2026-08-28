import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));
const source = fs.readFileSync(path.join(root, "index.mjs"), "utf8");
const config = fs.readFileSync(path.join(root, "config.mjs"), "utf8");

test("dispatches publish and the three lookup commands", () => {
  for (const taskType of ["xhs_publish", "alipay_name_start", "alipay_name_query", "alipay_name_stop"]) {
    assert.match(source, new RegExp(`task\\.type === \\"${taskType}\\"|\\[\\"alipay_name_start\\"`));
  }
});

test("lookup retries are bounded to two and publish keeps element runner paths configurable", () => {
  assert.match(source, /Math\.min\(2, Math\.max\(0, Number\(task\.payload\?\.maxRecoveryAttempts/);
  assert.match(config, /xhsPublishRunnerPath/);
  assert.match(config, /alipayNameLookupRunnerPath/);
});

test("automation paths do not mutate the screen stream implementation", () => {
  assert.doesNotMatch(source, /taskXhsPublish[\s\S]{0,3000}screenStreamManager/);
  assert.doesNotMatch(source, /taskAlipayNameLookup[\s\S]{0,3000}screenStreamManager/);
});

test("unresolved Alipay verification remains reportable for human action", () => {
  assert.match(source, /alipay_human_verification_required/);
  assert.match(source, /requiresHumanAction: true/);
});

test("Alipay runner errors keep a specific diagnostic instead of generic command failure", () => {
  assert.match(source, /classifyAlipayNameLookupFailure/);
  assert.match(source, /alipay_search_input_not_stable/);
  assert.match(source, /runnerError\.diagnostic = diagnostic/);
});

test("Alipay uses a bounded Poco fast path with XML fallback and a defined account switch gate", () => {
  assert.match(source, /const accountSwitchDue = operation === "query"/);
  assert.match(source, /preferredDriver: accountSwitchDue \? "xml_uiautomator_account_switch" : "poco_fast_path"/);
  assert.match(source, /runXhsAirtestPocoWorker\(payload/);
  assert.match(source, /shouldFallbackAlipayPocoFailure\(error\)/);
  assert.match(source, /Poco 快路径异常，正在切换 XML 兜底/);
  assert.match(source, /await ensureXmlUiAutomatorReady\(task\.adbSerial\)/);
  assert.match(source, /readyTimeoutMs: 12_000/);
});

test("Alipay access denial switches accounts once and retries the current number", () => {
  assert.match(source, /alipay_access_denied_account_switch_required/);
  assert.match(source, /payload\.forceAccountSwitchReason = "access_denied"/);
  assert.match(source, /正在切换账号并重试当前号码/);
  assert.match(source, /const accountSwitchRequested = accountSwitchDue \|\| accessDeniedSwitchRequired/);
  assert.match(source, /alipay_access_denied_after_account_switch/);
});

test("successful Alipay lookup fields survive the Windows status transport", () => {
  assert.match(source, /realNameTailCharacter: String\(result\.realNameTailCharacter/);
  assert.match(source, /alipayDisplayName: String\(result\.alipayDisplayName/);
  assert.match(source, /currentAccount: String\(result\.currentAccount/);
  assert.match(source, /accountSwitchReason: String\(parsed\.accountSwitchReason/);
  assert.match(source, /notFound: Boolean\(parsed\.notFound\)/);
  assert.match(source, /notFound: Boolean\(result\.notFound\)/);
});

test("server cancellation can abort an active lookup child process", () => {
  assert.match(source, /activeTaskIds/);
  assert.match(source, /abortCancelledAutomationTasks/);
  assert.match(source, /signal: options\.signal/);
  assert.match(source, /automation_task_cancelled/);
});

test("stateful Alipay lookup commands skip the expensive post-task device inventory scan", () => {
  assert.match(source, /shouldRunPostTaskDeviceScan\(task\.type\)/);
  assert.match(source, /reason: "device_inventory_unchanged"/);
});
