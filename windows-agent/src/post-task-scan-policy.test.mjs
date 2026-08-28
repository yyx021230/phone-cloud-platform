import assert from "node:assert/strict";
import test from "node:test";
import { shouldRunPostTaskDeviceScan } from "./post-task-scan-policy.mjs";

test("stateful Alipay lookup commands do not force a full device inventory scan", () => {
  for (const taskType of ["alipay_name_start", "alipay_name_query", "alipay_name_stop"]) {
    assert.equal(shouldRunPostTaskDeviceScan(taskType), false, taskType);
  }
});

test("tasks that can change inventory or use the existing lifecycle keep the post-task scan", () => {
  for (const taskType of ["adb_install_apk", "sms_sync_now", "xhs_qr_appium", "xhs_publish", "unknown_task"]) {
    assert.equal(shouldRunPostTaskDeviceScan(taskType), true, taskType);
  }
});
