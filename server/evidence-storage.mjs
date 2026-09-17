import fs from "node:fs/promises";
import path from "node:path";

export async function cleanupEvidenceStorage(options = {}) {
  const rootDir = path.resolve(String(options.rootDir || ""));
  const retained = new Set((options.retainedPaths || []).map((item) => path.resolve(String(item || ""))));
  const candidates = new Set();
  const nowMs = Number.isFinite(Number(options.nowMs)) ? Number(options.nowMs) : Date.now();
  const orphanMinAgeMs = Math.max(0, Number(options.orphanMinAgeMs) || 0);
  let skippedUnsafe = 0;
  const errors = [];

  for (const item of options.removedPaths || []) {
    const filePath = path.resolve(String(item || ""));
    if (!isInside(rootDir, filePath)) {
      skippedUnsafe += 1;
      continue;
    }
    if (!retained.has(filePath)) candidates.add(filePath);
  }

  for (const file of await listFiles(rootDir)) {
    if (retained.has(file.path)) continue;
    if (nowMs - file.mtimeMs >= orphanMinAgeMs) candidates.add(file.path);
  }

  let deletedFiles = 0;
  for (const filePath of candidates) {
    try {
      await fs.unlink(filePath);
      deletedFiles += 1;
    } catch (error) {
      if (error.code !== "ENOENT") errors.push({ filePath, error: error.message });
    }
  }

  return { deletedFiles, skippedUnsafe, errors };
}

async function listFiles(rootDir) {
  const files = [];
  async function walk(dir) {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch (error) {
      if (error.code === "ENOENT") return;
      throw error;
    }
    for (const entry of entries) {
      const entryPath = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        await walk(entryPath);
        continue;
      }
      if (!entry.isFile()) continue;
      const stat = await fs.stat(entryPath);
      files.push({ path: path.resolve(entryPath), mtimeMs: stat.mtimeMs });
    }
  }
  await walk(rootDir);
  return files;
}

function isInside(rootDir, filePath) {
  const relative = path.relative(rootDir, filePath);
  return Boolean(relative) && !relative.startsWith("..") && !path.isAbsolute(relative);
}
