import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);

async function read(relativePath) {
  return readFile(new URL(relativePath, root), "utf8");
}

test("production deployment rejects a three-minute screen inactivity baseline", async () => {
  const [guard, dockerfile, cachedDockerfile, preflight] = await Promise.all([
    read("public/screen-inactivity-guard.js"),
    read("Dockerfile"),
    read("Dockerfile.cached-base"),
    read("deploy/scripts/preflight-production.sh")
  ]);

  assert.match(guard, /^export const SCREEN_IDLE_TIMEOUT_MS = 10 \* 60 \* 1000;$/m);
  assert.match(dockerfile, /screen inactivity default|SCREEN_IDLE_TIMEOUT_MS = 10/);
  assert.match(cachedDockerfile, /SCREEN_IDLE_TIMEOUT_MS = 10/);
  assert.match(preflight, /screen inactivity default must remain 10 minutes/);
});
