import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createAtomicJsonWriter } from "./atomic-json-writer.mjs";

test("serializes concurrent atomic writes and keeps the last snapshot", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "phone-cloud-json-writer-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const target = path.join(directory, "sms-cursors.json");
  const write = createAtomicJsonWriter(target);

  await Promise.all(Array.from({ length: 40 }, (_, index) => write({ revision: index })));

  assert.deepEqual(JSON.parse(await fs.readFile(target, "utf8")), { revision: 39 });
  assert.deepEqual((await fs.readdir(directory)).sort(), ["sms-cursors.json"]);
});

test("a failed write does not poison the next queued write", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "phone-cloud-json-writer-retry-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const target = path.join(directory, "sms-cursors.json");
  let failNextRename = true;
  const fileSystem = {
    ...fs,
    async rename(source, destination) {
      if (failNextRename) {
        failNextRename = false;
        const error = new Error("injected rename failure");
        error.code = "EIO";
        throw error;
      }
      return fs.rename(source, destination);
    }
  };
  const write = createAtomicJsonWriter(target, { fileSystem });

  await assert.rejects(write({ revision: 1 }), /injected rename failure/);
  await write({ revision: 2 });

  assert.deepEqual(JSON.parse(await fs.readFile(target, "utf8")), { revision: 2 });
  assert.deepEqual((await fs.readdir(directory)).sort(), ["sms-cursors.json"]);
});
