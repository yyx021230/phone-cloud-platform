import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

test("batch refuses invalid listener configuration before reading private config or connecting DB", () => {
  for (const change of [{ XHS_BATCH_HOST: "remote.example" }, { XHS_BATCH_PORT: "0" }, { XHS_BATCH_PORT: "65536" }, { XHS_BATCH_PORT: "8791.5" }]) {
    const r = spawnSync(process.execPath, [new URL("./main.mjs", import.meta.url).pathname], {
      env: { PATH: process.env.PATH, ...change }, encoding: "utf8", timeout: 5000
    });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /invalid_batch_listen_address/);
    assert.doesNotMatch(r.stderr, /ECONNREFUSED|batch_config_required/);
  }
});
