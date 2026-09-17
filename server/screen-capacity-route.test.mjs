import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("./index.mjs", import.meta.url), "utf8");

test("rejects new screen sessions before exceeding configured platform capacity", () => {
  const start = source.indexOf("const userDeviceScreenSessionMatch =");
  const end = source.indexOf("const screenSessionMatch =", start);
  assert.ok(start >= 0 && end > start);
  const route = source.slice(start, end);
  assert.match(route, /SCREEN_MAX_CONCURRENT_SESSIONS/);
  assert.match(route, /screen_capacity_exhausted/);
});
