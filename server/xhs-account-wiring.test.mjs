import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const [serverSource, appSource] = await Promise.all([
  readFile(new URL("./index.mjs", import.meta.url), "utf8"),
  readFile(new URL("../public/app.js", import.meta.url), "utf8")
]);

test("both account update routes validate stable IDs and cross-device uniqueness", () => {
  assert.ok((serverSource.match(/validateXhsAccounts\(xhsAccounts\)/g) || []).length >= 2);
  assert.ok((serverSource.match(/findXhsIdConflict\(state\.devices, deviceId, xhsAccounts\)/g) || []).length >= 2);
});

test("task records and Windows task payload snapshot Xiaohongshu ID", () => {
  assert.match(serverSource, /xhsAccountId: normalizeXhsId\(input\.xhsAccountId\)/);
  assert.match(serverSource, /xhsAccountId: xhsTask\.xhsAccountId \|\| ""/);
  assert.match(serverSource, /xhsAccountId: task\.xhsAccountId \|\| ""/);
});

test("admin UI edits and submits Xiaohongshu ID separately from display name", () => {
  assert.match(appSource, /data-role="xhs-account-id" data-slot="app1"/);
  assert.match(appSource, /data-role="xhs-account-id" data-slot="app2"/);
  assert.match(appSource, /xhsId: String\(idInput\?\.value \|\| ""\)/);
});
