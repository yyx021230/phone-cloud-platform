import assert from "node:assert/strict";
import test from "node:test";

import { userSmsRefreshAction } from "./user-sms-refresh-policy.mjs";

test("requests a device sync only once for an opened SMS panel", () => {
  assert.equal(userSmsRefreshAction({ deviceSyncRequested: false }), "device_sync");
  assert.equal(userSmsRefreshAction({ deviceSyncRequested: true }), "database_refresh");
});
