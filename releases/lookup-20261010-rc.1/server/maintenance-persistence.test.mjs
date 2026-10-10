import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("./index.mjs", import.meta.url), "utf8");

test("maintenance defers snapshot persistence while realtime sessions are active", () => {
  const start = source.indexOf("const maintenanceTimer = setInterval");
  const end = source.indexOf("const server = http.createServer", start);
  assert.ok(start >= 0 && end > start);
  const block = source.slice(start, end);
  assert.match(block, /runtimeSaveScheduler\.mark\(\)/);
  assert.match(block, /screenSessions\.activeCount\(\)/);
  assert.doesNotMatch(block, /saveState\(\)\.catch/);
});
