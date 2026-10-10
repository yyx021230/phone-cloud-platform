import crypto from "node:crypto";
import fs from "node:fs";
import fsPromises from "node:fs/promises";

export async function acquireAgentInstanceLock({
  lockPath,
  agentId,
  ownerId = crypto.randomUUID(),
  processAlive = isProcessAlive
}) {
  const normalizedPath = String(lockPath || "").trim();
  const normalizedAgentId = String(agentId || "").trim();
  if (!normalizedPath) throw new Error("agent_lock_path_required");
  if (!normalizedAgentId) throw new Error("agent_lock_agent_id_required");

  const payload = JSON.stringify({
    pid: process.pid,
    agentId: normalizedAgentId,
    ownerId,
    startedAt: new Date().toISOString()
  });

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const handle = await fsPromises.open(normalizedPath, "wx");
      await handle.writeFile(payload, "utf8");
      return createLock({ lockPath: normalizedPath, handle, ownerId, agentId: normalizedAgentId });
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      const existing = await readLock(normalizedPath);
      if (existing?.pid && processAlive(existing.pid)) {
        const duplicate = new Error(`phone_cloud_agent_already_running:${existing.pid}`);
        duplicate.code = "agent_already_running";
        duplicate.existing = existing;
        throw duplicate;
      }
      await fsPromises.unlink(normalizedPath).catch((unlinkError) => {
        if (unlinkError?.code !== "ENOENT") throw unlinkError;
      });
    }
  }

  throw new Error("agent_lock_acquire_failed");
}

function createLock({ lockPath, handle, ownerId, agentId }) {
  let released = false;
  const belongsToThisProcess = () => {
    try {
      const value = JSON.parse(fs.readFileSync(lockPath, "utf8"));
      return value?.ownerId === ownerId && Number(value?.pid) === process.pid;
    } catch {
      return false;
    }
  };
  const release = async () => {
    if (released) return;
    released = true;
    await handle.close().catch(() => {});
    if (belongsToThisProcess()) await fsPromises.unlink(lockPath).catch(() => {});
  };
  const releaseSync = () => {
    if (released) return;
    released = true;
    try { handle.close(); } catch {}
    try {
      if (belongsToThisProcess()) fs.unlinkSync(lockPath);
    } catch {}
  };
  return { agentId, lockPath, release, releaseSync };
}

async function readLock(lockPath) {
  try {
    return JSON.parse(await fsPromises.readFile(lockPath, "utf8"));
  } catch {
    return null;
  }
}

function isProcessAlive(pid) {
  const target = Math.max(1, Math.round(Number(pid || 0)));
  if (!target) return false;
  try {
    process.kill(target, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}
