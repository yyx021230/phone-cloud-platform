import assert from "node:assert/strict";
import test from "node:test";

import { smsRefreshRatePolicy } from "./sms-refresh-rate.mjs";

test("limits automatic SMS panel refreshes separately from manual refreshes", () => {
  assert.deepEqual(smsRefreshRatePolicy("sms_panel_open"), { scope: "auto", cooldownMs: 300_000 });
  assert.deepEqual(smsRefreshRatePolicy("auto_user_sms_panel"), { scope: "auto", cooldownMs: 300_000 });
  assert.deepEqual(smsRefreshRatePolicy(""), { scope: "auto", cooldownMs: 300_000 });
  assert.deepEqual(smsRefreshRatePolicy("manual_user_request"), { scope: "manual", cooldownMs: 10_000 });
});
