import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("./index.mjs", import.meta.url), "utf8");

test("creates device actors before the initial health probe reads them", () => {
  const actorsAt = source.indexOf("const deviceActors = createDeviceActorManager()");
  const healthAt = source.indexOf('let health = await buildHealth("starting", null)');
  assert.ok(actorsAt >= 0 && healthAt >= 0);
  assert.ok(actorsAt < healthAt, "deviceActors must be initialized before buildHealth");
});
