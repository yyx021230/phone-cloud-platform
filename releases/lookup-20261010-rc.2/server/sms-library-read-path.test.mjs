import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("./index.mjs", import.meta.url), "utf8");
const routeStart = source.indexOf('const userDeviceSmsLibraryMatch = url.pathname.match');
const routeEnd = source.indexOf('const userDeviceSmsRefreshMatch = url.pathname.match', routeStart);
const smsLibraryRoute = source.slice(routeStart, routeEnd);

test("admin SMS library reads defer audit persistence instead of blocking the response", () => {
  assert.ok(routeStart > -1 && routeEnd > routeStart, "SMS library route must exist");
  assert.match(smsLibraryRoute, /addAudit\("admin_user_sms_library_preview"/);
  assert.match(smsLibraryRoute, /scheduleStateSave\(\)/);
  assert.doesNotMatch(smsLibraryRoute, /await saveState\(\)/);
});
