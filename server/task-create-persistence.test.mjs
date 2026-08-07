import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("./index.mjs", import.meta.url), "utf8");

test("user QR task creation persists only task records and its device lock", () => {
  const route = sliceRoute(
    'if (req.method === "POST" && url.pathname === "/api/v1/user/xhs/qr-scan-tasks")',
    "const userXhsTaskCancelMatch ="
  );
  assert.match(route, /persistencePolicy\.persist/);
  assert.match(route, /structuredRepos\.persistTaskMutation/);
  assert.match(route, /deviceLock/);
  assert.doesNotMatch(route, /await saveState\(\)/);
});

test("admin QR task creation persists only task records and its device lock", () => {
  const route = sliceRoute(
    'if (req.method === "POST" && url.pathname === "/api/v1/xhs/qr-scan-tasks")',
    "const xhsTaskNextMatch ="
  );
  assert.match(route, /persistencePolicy\.persist/);
  assert.match(route, /structuredRepos\.persistTaskMutation/);
  assert.match(route, /deviceLock/);
  assert.doesNotMatch(route, /await saveState\(\)/);
});

function sliceRoute(startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start);
  assert.ok(start >= 0 && end > start, `route markers must exist: ${startMarker}`);
  return source.slice(start, end);
}
