import assert from "node:assert/strict";
import test from "node:test";

import { sanitizePostgresText, stringifyPostgresJson } from "./postgres-json.mjs";

test("removes NUL characters from nested JSON strings", () => {
  const input = {
    smsMessages: [{ body: "拒收请回复R\u0000", address: "10010\u0000" }],
    detail: { values: ["a\u0000b", 3, null] }
  };
  const encoded = stringifyPostgresJson(input);
  assert.doesNotMatch(encoded, /\\u0000/i);
  assert.deepEqual(JSON.parse(encoded), {
    smsMessages: [{ body: "拒收请回复R", address: "10010" }],
    detail: { values: ["ab", 3, null] }
  });
  assert.equal(input.smsMessages[0].body, "拒收请回复R\u0000");
});

test("sanitizes text before it enters in-memory state", () => {
  assert.equal(sanitizePostgresText("a\u0000b\u0000c", 4), "abc");
  assert.equal(sanitizePostgresText("abcdef", 4), "abcd");
});
