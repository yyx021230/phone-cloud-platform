import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("./index.mjs", import.meta.url), "utf8");

test("administrator device edits use structured device persistence", () => {
  const routes = [
    sliceRoute("if (req.method === \"PUT\" && deviceUpdateMatch)", "if (req.method === \"POST\" && url.pathname === \"/api/v1/devices/bulk-listing\")"),
    sliceRoute("if (req.method === \"POST\" && url.pathname === \"/api/v1/devices/bulk-listing\")", "const deviceBindSimMatch ="),
    sliceRoute("if (req.method === \"PUT\" && deviceBindSimMatch)", "const deviceXhsAccountMatch ="),
    sliceRoute("if (req.method === \"PUT\" && deviceXhsAccountMatch)", "if (req.method === \"POST\" && url.pathname === \"/api/v1/devices/heartbeat\")")
  ];

  for (const route of routes) {
    assert.match(route, /persistencePolicy\.persist/);
    assert.match(route, /structuredRepos\.persistDevice/);
    assert.doesNotMatch(route, /await saveState\(\)/);
  }
});

test("screen gallery import queues its Windows task without a full snapshot", () => {
  const route = sliceRoute(
    "if (req.method === \"POST\" && screenGalleryImportMatch)",
    "const screenGalleryImportTaskMatch ="
  );
  assert.match(route, /structuredRepos\.persistTaskMutation/);
  assert.doesNotMatch(route, /await saveState\(\)/);
});

function sliceRoute(startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start);
  assert.ok(start >= 0 && end > start, `route markers must exist: ${startMarker}`);
  return source.slice(start, end);
}
