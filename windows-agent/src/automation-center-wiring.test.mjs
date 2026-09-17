import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));
const source = fs.readFileSync(path.join(root, "index.mjs"), "utf8");
const config = fs.readFileSync(path.join(root, "config.mjs"), "utf8");
const publishFunction = source.match(/async function taskXhsPublish\(task\) \{([\s\S]*?)\n\}\n\nfunction /)?.[1] || "";

test("dispatches publish and all lookup commands", () => {
  for (const taskType of ["xhs_publish", "alipay_name_start", "alipay_name_query", "alipay_name_switch", "alipay_name_stop"]) {
    assert.match(source, new RegExp(`task\\.type === \\"${taskType}\\"|\\[\\"alipay_name_start\\"`));
  }
});

test("human verification resume observes first and only account limits enter account rotation", () => {
  assert.match(source, /task\.payload\?\.resumeAfterHumanVerification === true/);
  assert.match(source, /\? "query_resume"/);
  assert.match(source, /resumeAfterHumanVerification: operation === "query_resume"/);
  assert.match(source, /resubmitsInput: operation === "query_resume" \? false/);
  assert.match(source, /if \(operation === "query_resume" && !automaticAccountSwitchReason\) \{/);
  assert.match(source, /operation === "query_resume"[\s\S]*poco_query_result_channel_timeout_after_input/);
  assert.match(source, /observationOnlyResume: true/);
  assert.match(source, /maxResumeAttempts: 1/);
  assert.match(source, /resubmitsSearch: false/);
  assert.match(source, /poco_query_resume_result_channel_timeout/);
  assert.match(source, /runnerError\.diagnostic = \{ \.\.\.diagnostic, resumeAfterHumanVerification: true, resubmitsInput: false \}/);
  assert.match(source, /const automaticAccountSwitchReason = \["query", "query_resume"\]\.includes\(operation\)/);
  assert.match(source, /resumedAfterHumanVerification: operation === "query_resume"/);
  assert.match(source, /payload\.operation = "query"/);
});

test("lookup retries are bounded to two and publish keeps element runner paths configurable", () => {
  assert.match(source, /Math\.min\(2, Math\.max\(0, Number\(task\.payload\?\.maxRecoveryAttempts/);
  assert.match(config, /xhsPublishRunnerPath/);
  assert.match(config, /alipayNameLookupRunnerPath/);
});

test("XHS publish does not reference Alipay lookup-only variables", () => {
  assert.ok(publishFunction, "taskXhsPublish function was not found");
  assert.doesNotMatch(publishFunction, /\boperation\b/);
  assert.doesNotMatch(publishFunction, /\baccountSwitchDue\b/);
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
  assert.match(source, /alipay_login_required/);
  assert.match(source, /runnerError\.diagnostic = diagnostic/);
});

test("Alipay uses a bounded Poco fast path and reserves XML account navigation for manual switching", () => {
  assert.match(source, /const accountOperation = \["list_accounts", "switch"\]\.includes\(operation\)/);
  assert.match(source, /preferredDriver: accountOperation \? "xml_uiautomator_account_switch" : "poco_fast_path"/);
  assert.match(source, /runXhsAirtestPocoWorker\(payload/);
  assert.match(source, /shouldFallbackAlipayPocoFailure\(error\)/);
  assert.match(source, /Poco 快路径异常，正在切换 XML 兜底/);
  assert.match(source, /await ensureXmlUiAutomatorReady\(task\.adbSerial\)/);
  assert.match(source, /readyTimeoutMs: 25_000/);
  assert.match(source, /const pocoColdStartAttempts = operation === "start" \? 3 : 2/);
  assert.match(source, /Poco 启动阶段异常，正在重建 Poco 后重试/);
  assert.match(source, /operation === "start"[\s\S]*Airtest\/Poco worker 执行超时/);
  assert.match(source, /operation === "start"[\s\S]*Airtest\/Poco worker 探活未通过/);
  assert.match(source, /: "worker_probe_failed"/);
  assert.match(source, /stopAirtestWorker\(task\.adbSerial, `poco_start_\$\{retryReason\}`\)/);
  assert.match(source, /isRetryableAlipayPocoStartFailure\(parsed\.error\)/);
  assert.match(source, /Poco 启动传输超时，正在重建 Poco 后重试/);
  assert.match(source, /retryOperation: "start"/);
  assert.match(source, /reason: "poco_transport_timeout"/);
  assert.match(source, /poco_start_transport_timeout/);
  assert.match(source, /operation === "stop"/);
  assert.match(source, /Poco 结束清理异常，已直接释放查名字会话/);
  assert.match(source, /fallbackSkipped: "xml_uiautomator"/);
  assert.match(source, /retryOperation: "query_resume"/);
  assert.match(source, /const maxQueryResumeAttempts = 2/);
  assert.match(source, /allowEmptyInputRecovery/);
  assert.match(source, /only_after_confirmed_empty/);
  assert.match(source, /poco_query_resume_failed/);
});

test("Alipay jigsaw stays manual while exact account limits auto-switch and retry the current phone", () => {
  assert.match(source, /alipay_access_denied_account_switch_required/);
  assert.match(source, /alipay_account_restriction_switch_required/);
  assert.match(source, /device_risk/);
  assert.match(source, /frequent_or_abnormal_access/);
  assert.match(source, /requiresAccountSwitch: true/);
  assert.match(source, /limitReached: true/);
  assert.match(source, /const accountSwitchRequested = operation === "switch"/);
  assert.match(source, /targetAccount: String\(task\.payload\?\.targetAccount/);
  assert.match(source, /savedAccounts: Array\.isArray\(parsed\.savedAccounts\)/);
  assert.match(source, /检测到账号查询限制，正在自动切换已保存账号并重试当前号码/);
  assert.match(source, /retryCurrentPhone: true/);
  assert.match(source, /xml_uiautomator_account_rotation/);
  assert.doesNotMatch(source, /payload\.forceAccountSwitchReason/);
  assert.doesNotMatch(source, /accountSwitchDue/);
  assert.match(source, /timeoutMs: payload\.operation === "query" \? 1_800_000/);
  assert.match(source, /diagnostic\.savedAccountCount = Math\.max\(0, Number\(failed\.savedAccountCount/);
});

test("exhausted automatic account rotation pauses the external queue", () => {
  assert.match(source, /alipay_all_saved_accounts_restricted:\(\[a-z_\]\+\)/);
  assert.match(source, /code: "alipay_all_saved_accounts_restricted",[\s\S]*limitReached: true,[\s\S]*requiresAccountSwitch: true,[\s\S]*limitReason: reason/);
});

test("successful Alipay lookup fields survive the Windows status transport", () => {
  assert.match(source, /realNameTailCharacter: String\(result\.realNameTailCharacter/);
  assert.match(source, /alipayDisplayName: String\(result\.alipayDisplayName/);
  assert.match(source, /currentAccount: String\(result\.currentAccount/);
  assert.match(source, /accountSwitchReason: String\(parsed\.accountSwitchReason/);
  assert.match(source, /accountSwitchCount: Math\.max\(0, Number\(parsed\.accountSwitchCount/);
  assert.match(source, /restrictedAccounts: Array\.isArray\(parsed\.restrictedAccounts/);
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
