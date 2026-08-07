import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("./screen-load-test.mjs", import.meta.url), "utf8");

test("the real-device load probe can include safe tap and text controls", () => {
  assert.match(source, /const includeTap/);
  assert.match(source, /const probeText/);
  assert.match(source, /async function sendTap\(\)/);
  assert.match(source, /type: "text", text: probeText/);
});
