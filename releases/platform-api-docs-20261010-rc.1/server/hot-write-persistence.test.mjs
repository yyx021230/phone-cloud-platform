import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("./index.mjs", import.meta.url), "utf8");

test("SMS batch ingestion uses structured persistence instead of a route-time snapshot", () => {
  const route = sliceRoute('const smsLibraryBatchMatch =', 'if (req.method === "GET" && url.pathname === "/api/v1/xhs/qr-scan-tasks")');
  assert.match(route, /persistencePolicy\.persist/);
  assert.match(route, /structuredRepos\.persistSmsBatch/);
  assert.doesNotMatch(route, /await saveState\(\)/);
});

test("Windows task status and event ingestion use atomic structured persistence", () => {
  const statusRoute = sliceRoute('const taskStatusMatch =', 'const taskEventsMatch =');
  const eventRoute = sliceRoute('if (req.method === "POST" && taskEventsMatch)', 'if (req.method === "GET" && url.pathname === "/api/v1/devices")');

  for (const route of [statusRoute, eventRoute]) {
    assert.match(route, /persistencePolicy\.persist/);
    assert.match(route, /structuredRepos\.persistTaskMutation/);
    assert.doesNotMatch(route, /await saveState\(\)/);
  }
});

function sliceRoute(startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start);
  assert.ok(start >= 0 && end > start, `route markers must exist: ${startMarker}`);
  return source.slice(start, end);
}
