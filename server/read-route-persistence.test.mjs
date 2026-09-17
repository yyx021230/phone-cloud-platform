import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("./index.mjs", import.meta.url), "utf8");

test("read-only inventory and operations routes never block on a full snapshot save", () => {
  for (const [name, start, end] of [
    ["overview", 'if (req.method === "GET" && url.pathname === "/api/v1/overview")', 'if (req.method === "GET" && url.pathname === "/api/v1/users")'],
    ["device locks", 'if (req.method === "GET" && url.pathname === "/api/v1/device-locks")', 'const releaseLockMatch ='],
    ["operations metrics", 'if (req.method === "GET" && url.pathname === "/api/v1/metrics/operations")', 'const evidenceMatch ='],
    ["user devices", 'if (req.method === "GET" && url.pathname === "/api/v1/user/devices")', 'const userDeviceScreenSessionMatch =']
  ]) {
    const route = sliceRoute(start, end);
    assert.doesNotMatch(route, /await saveState\(\)/, `${name} GET must not synchronously save the snapshot`);
  }
});

test("legacy device polling does not save the snapshot when there is no work", () => {
  const xhsNext = sliceRoute('const xhsTaskNextMatch =', 'const deviceCommandNextMatch =');
  const commandNext = sliceRoute('const deviceCommandNextMatch =', 'const deviceCommandStatusMatch =');
  const commandRead = sliceRoute('if (req.method === "GET" && deviceCommandMatch)', 'if (req.method === "POST" && deviceCommandStatusMatch)');
  const activationWindows = sliceRoute('const activationWindowsMatch =', 'if (req.method === "GET" && url.pathname === "/api/v1/sms-orders")');

  assert.doesNotMatch(noTaskBranch(xhsNext, "task"), /await saveState\(\)/);
  assert.doesNotMatch(noTaskBranch(commandNext, "command"), /await saveState\(\)/);
  assert.doesNotMatch(commandRead, /await saveState\(\)/);
  assert.doesNotMatch(activationWindows, /await saveState\(\)/);
});

test("Windows Agent empty task polling defers maintenance persistence", () => {
  const route = sliceRoute('const nextTaskMatch =', 'if (req.method === "POST" && url.pathname === "/api/v1/windows-agent-tasks")');
  assert.doesNotMatch(route, /if \(maintenanceChanged\) await saveState\(\)/);
  assert.match(route, /if \(maintenanceChanged\) runtimeSaveScheduler\.mark\(\)/);
});

function sliceRoute(startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start);
  assert.ok(start >= 0 && end > start, `route markers must exist: ${startMarker}`);
  return source.slice(start, end);
}

function noTaskBranch(route, responseKey) {
  const match = route.match(new RegExp(`if \\(!task\\) \\{([\\s\\S]*?)return json\\(res, 200, \\{ ${responseKey}: null \\}\\);`));
  assert.ok(match, `missing no-task ${responseKey} branch`);
  return match[1];
}
