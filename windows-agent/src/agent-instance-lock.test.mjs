import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { acquireAgentInstanceLock } from "./agent-instance-lock.mjs";

test("rejects a second active Agent process for the same installation", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "phone-cloud-agent-lock-"));
  const lockPath = path.join(directory, "agent.lock");
  const lock = await acquireAgentInstanceLock({ lockPath, agentId: "agent-1", ownerId: "first" });

  await assert.rejects(
    acquireAgentInstanceLock({ lockPath, agentId: "agent-1", ownerId: "second", processAlive: () => true }),
    (error) => error?.code === "agent_already_running"
  );

  await lock.release();
});

test("replaces a stale Agent lock left by a stopped process", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "phone-cloud-agent-lock-"));
  const lockPath = path.join(directory, "agent.lock");
  await writeFile(lockPath, JSON.stringify({ pid: 12345, agentId: "agent-1", ownerId: "stale" }), "utf8");

  const lock = await acquireAgentInstanceLock({
    lockPath,
    agentId: "agent-1",
    ownerId: "replacement",
    processAlive: () => false
  });

  assert.equal(lock.agentId, "agent-1");
  await lock.release();
});
