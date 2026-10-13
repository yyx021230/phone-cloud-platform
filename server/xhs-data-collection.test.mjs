import assert from "node:assert/strict";
import test from "node:test";
import { hasXhsDataCollectionCapability, sanitizeXhsDataCollection } from "./xhs-data-collection.mjs";

const snapshot = () => ({ schema_version: 3, window_days: 30,
  window_start_date: "2026-09-14", window_end_date: "2026-10-13", complete: true,
  stop_reason: "list_end_visible", app_slot: "app1", notes: [{ title: "作品", published_date: "2026-10-12",
    list_view_count: 10, list_like_count: 0, list_comment_count: 1, secret: "discard" }] });

test("collection schema preserves zero and missing counts without exposing unrecognized fields", () => {
  const result = sanitizeXhsDataCollection(snapshot());
  assert.equal(result.complete, true);
  assert.equal(result.notes[0].list_like_count, 0);
  assert.equal(result.notes[0].secret, undefined);
  assert.equal(result.totals.list_view_count, 10);
  const missing = snapshot(); missing.notes[0].list_like_count = null;
  assert.equal(sanitizeXhsDataCollection(missing).totals.list_like_count, null);
});

test("invalid dates, excessive notes and unsupported window are rejected", () => {
  for (const patch of [{ window_days: 180 }, { window_start_date: "2026-02-30" },
    { window_end_date: "2026-10-14" }, { notes: Array(1001).fill(snapshot().notes[0]) }]) {
    assert.throws(() => sanitizeXhsDataCollection({ ...snapshot(), ...patch }), /invalid_xhs_collection_result/);
  }
  const bad = snapshot(); bad.notes[0].published_date = "2026-08-01";
  assert.throws(() => sanitizeXhsDataCollection(bad), /invalid_xhs_collection_note/);
});

test("unproven boundary cannot become a complete snapshot", () => {
  assert.equal(sanitizeXhsDataCollection({ ...snapshot(), stop_reason: "max_scrolls" }).complete, false);
  assert.equal(sanitizeXhsDataCollection({ ...snapshot(), complete: false }).complete, false);
});

test("old or unhealthy agents cannot receive collection jobs", () => {
  assert.equal(hasXhsDataCollectionCapability({ health: { airtest: { ok: true } } }), false);
  assert.equal(hasXhsDataCollectionCapability({ health: { xhsDataCollect: { protocol: "xhs_data_collect_v1", ready: true } } }), true);
  assert.equal(hasXhsDataCollectionCapability({ health: { xhsDataCollect: { protocol: "other", ready: true } } }), false);
});
