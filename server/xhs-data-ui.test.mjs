import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import vm from "node:vm";
import { renderXhsDataResult, renderXhsDataTask, xhsDataTargetsForDevice, xhsDataUnavailableReason } from "../public/xhs-data-collection-ui.js";

test("enabled unbound test slots can collect without requiring Poco readiness", () => {
  const device = { adbOnline: true, busy: false, xhsDataCollectionReady: true,
    xhsAccounts: [{ appSlot: "app1", enabled: true }] };
  assert.equal(xhsDataTargetsForDevice(device).length, 1);
  assert.equal(xhsDataUnavailableReason(device), "");
  assert.match(xhsDataUnavailableReason({ ...device, busy: true }), /使用中/);
  assert.match(xhsDataUnavailableReason({ ...device, xhsDataCollectionReady: false }), /更新/);
});

test("result table escapes titles and reports unknown counts, zero and incomplete coverage", () => {
  const html = renderXhsDataResult({ jobId: "task-1", result: { collection: {
    complete: false, captured_at: "2026-10-13T02:00:00Z", window_start_date: "2026-09-14", window_end_date: "2026-10-13",
    notes: [{ title: '<img onerror="alert(1)">', list_like_count: 0, list_view_count: null, list_comment_count: 1 }]
  } } });
  assert.match(html, /未确认完整/);
  assert.match(html, /&lt;img/);
  assert.doesNotMatch(html, /<img/);
  assert.match(html, /<td>—<\/td><td>0<\/td><td>1<\/td>/);
  assert.match(renderXhsDataTask({ jobId: "j", status: "running", cancellable: true }), /data-xhs-data-cancel/);
});

test("a late result from the previous login cannot repopulate collection data", async () => {
  const source = await fs.readFile(new URL("../public/app.js", import.meta.url), "utf8");
  const begin = source.indexOf("function clearUserDataSession(");
  const end = source.indexOf("async function applyUserDataTasks(", begin);
  let resolve;
  const state = { userSelectedDeviceId: "fixture102", userDataTasks: ["old"], userDataDetail: { jobId: "old" } };
  const functions = vm.runInNewContext(`let userDataSessionVersion = 0; ${source.slice(begin, end)}; ({ clearUserDataSession, loadUserDataDetail })`, {
    state, api: () => new Promise((done) => { resolve = done; })
  });
  const pending = functions.loadUserDataDetail("old");
  functions.clearUserDataSession();
  resolve({ task: { jobId: "old", deviceId: "fixture102", status: "succeeded", result: { message: "old private snapshot" } } });
  await pending;
  assert.equal(state.userDataDetail, null);
  assert.equal(state.userDataTasks.length, 0);
});
