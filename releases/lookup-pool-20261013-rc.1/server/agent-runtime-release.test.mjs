import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { AGENT_RUNTIME_RELEASE_FILE, readAgentRuntimeRelease } from "./agent-runtime-release.mjs";

test("loads the fixed Agent runtime release and returns its digest", async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "phone-cloud-agent-release-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  await fs.writeFile(path.join(dir, AGENT_RUNTIME_RELEASE_FILE), Buffer.from("runtime-update"));
  const release = await readAgentRuntimeRelease(dir);
  assert.equal(release.fileName, AGENT_RUNTIME_RELEASE_FILE);
  assert.equal(release.sizeBytes, 14);
  assert.equal(release.sha256, "59fbe10043d8af874c1c9b0b39f570a134683ff38e53a441ac51b505320fa005");
});

test("rejects a missing or oversized Agent runtime release", async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "phone-cloud-agent-release-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  await assert.rejects(readAgentRuntimeRelease(dir), /agent_runtime_release_not_found/);
  await fs.writeFile(path.join(dir, AGENT_RUNTIME_RELEASE_FILE), Buffer.alloc(8));
  await assert.rejects(readAgentRuntimeRelease(dir, { maxBytes: 4 }), /agent_runtime_release_invalid/);
});
