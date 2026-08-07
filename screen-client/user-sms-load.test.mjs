import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const app = await readFile(new URL("../public/app.js", import.meta.url), "utf8");

function sourceFor(name) {
  return app.match(new RegExp(`async function ${name}\\([\\s\\S]*?\\n\\}`))?.[0] || "";
}

test("loads user SMS independently instead of reloading the whole workbench", () => {
  assert.match(app, /async function loadUserSmsLibrary\(/);
  assert.match(sourceFor("reloadUserSmsFirstPage"), /loadUserSmsLibrary\(/);
  assert.doesNotMatch(sourceFor("reloadUserSmsFirstPage"), /loadAll\(/);
  assert.doesNotMatch(sourceFor("refreshCurrentUserSmsLibrary"), /await reloadUserSmsFirstPage\(\)/);
});

test("does not turn a transient SMS request failure into an empty inbox", () => {
  const loader = sourceFor("loadUserSmsLibrary");
  assert.doesNotMatch(loader, /catch\(\(\) => \(\{ messages: \[\], total: 0 \}\)\)/);
  assert.match(loader, /userSmsLoadError/);
});
