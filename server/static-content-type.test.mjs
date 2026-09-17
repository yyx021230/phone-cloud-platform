import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("./index.mjs", import.meta.url), "utf8");

test("serves browser ES modules with a JavaScript MIME type", () => {
  const contentType = source.match(/function contentType\(file\) \{[\s\S]*?\n\}/)?.[0] || "";
  assert.match(contentType, /file\.endsWith\("\.mjs"\)/);
  assert.match(contentType, /text\/javascript; charset=utf-8/);
});
