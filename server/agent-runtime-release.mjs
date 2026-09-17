import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

export const AGENT_RUNTIME_RELEASE_FILE = "phone-cloud-agent-update.zip";

export async function readAgentRuntimeRelease(releaseDir, { maxBytes = 50_000_000 } = {}) {
  const filePath = path.join(path.resolve(releaseDir), AGENT_RUNTIME_RELEASE_FILE);
  let stat;
  try {
    stat = await fs.stat(filePath);
  } catch (error) {
    if (error?.code === "ENOENT") throw releaseError("agent_runtime_release_not_found", 404);
    throw error;
  }
  if (!stat.isFile()) throw releaseError("agent_runtime_release_not_found", 404);
  if (stat.size <= 0 || stat.size > maxBytes) throw releaseError("agent_runtime_release_invalid", 500);
  const bytes = await fs.readFile(filePath);
  return {
    bytes,
    fileName: AGENT_RUNTIME_RELEASE_FILE,
    sizeBytes: bytes.length,
    sha256: crypto.createHash("sha256").update(bytes).digest("hex")
  };
}

function releaseError(message, statusCode) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}
