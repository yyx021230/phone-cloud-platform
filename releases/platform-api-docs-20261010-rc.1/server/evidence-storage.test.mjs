import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { cleanupEvidenceStorage } from "./evidence-storage.mjs";

test("deletes pruned and old orphan evidence while retaining referenced files", async () => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "phone-cloud-evidence-"));
  const retained = path.join(rootDir, "task-a", "retained.png");
  const pruned = path.join(rootDir, "task-b", "pruned.xml");
  const orphan = path.join(rootDir, "task-c", "orphan.log");
  await Promise.all([
    fs.mkdir(path.dirname(retained), { recursive: true }),
    fs.mkdir(path.dirname(pruned), { recursive: true }),
    fs.mkdir(path.dirname(orphan), { recursive: true })
  ]);
  await Promise.all([
    fs.writeFile(retained, "keep"),
    fs.writeFile(pruned, "remove"),
    fs.writeFile(orphan, "remove")
  ]);
  const old = new Date(Date.now() - 2 * 60 * 60 * 1000);
  await fs.utimes(orphan, old, old);

  const result = await cleanupEvidenceStorage({
    rootDir,
    retainedPaths: [retained],
    removedPaths: [pruned],
    orphanMinAgeMs: 60 * 60 * 1000
  });

  assert.equal(await exists(retained), true);
  assert.equal(await exists(pruned), false);
  assert.equal(await exists(orphan), false);
  assert.equal(result.deletedFiles, 2);
  await fs.rm(rootDir, { recursive: true, force: true });
});

test("never deletes a path outside the evidence directory", async () => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "phone-cloud-evidence-"));
  const outside = path.join(path.dirname(rootDir), `${path.basename(rootDir)}-outside.txt`);
  await fs.writeFile(outside, "keep");

  const result = await cleanupEvidenceStorage({ rootDir, removedPaths: [outside] });

  assert.equal(await exists(outside), true);
  assert.equal(result.skippedUnsafe, 1);
  await fs.rm(rootDir, { recursive: true, force: true });
  await fs.rm(outside, { force: true });
});

async function exists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}
