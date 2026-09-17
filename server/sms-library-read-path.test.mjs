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

test("SMS library reads use the per-device index and preserve its newest-first order", () => {
  assert.match(source, /smsMessageIndex\.countForDevice\(device\.deviceId\)/);
  assert.match(source, /deviceId \? smsMessagesForDevice\(deviceId\) : repos\.sms\.allMessages\(\)/);
  assert.doesNotMatch(smsLibraryRoute, /\.sort\(/);

  const adminRouteStart = source.indexOf('if (req.method === "GET" && url.pathname === "/api/v1/sms-library")');
  const adminRouteEnd = source.indexOf('if (req.method === "POST" && url.pathname === "/api/v1/sms-events")', adminRouteStart);
  const adminRoute = source.slice(adminRouteStart, adminRouteEnd);
  assert.ok(adminRouteStart > -1 && adminRouteEnd > adminRouteStart, "admin SMS library route must exist");
  assert.doesNotMatch(adminRoute, /\.sort\(/);
});

test("empty SMS batches return before sorting the 50k-message compatibility collection", () => {
  const upsertStart = source.indexOf("function upsertSmsLibraryMessages");
  const upsertEnd = source.indexOf("function normalizeSmsLibraryMessage", upsertStart);
  const upsert = source.slice(upsertStart, upsertEnd);
  const earlyReturn = upsert.indexOf("if (!inserted && !updated) return");
  const sort = upsert.indexOf("sortSmsMessagesNewestFirst");
  assert.ok(earlyReturn > -1 && sort > earlyReturn, "empty batches must return before the global sort");
  assert.doesNotMatch(upsert, /state\.smsMessages\.find\(/);
  assert.match(upsert, /findSemanticSmsDuplicate\(smsMessageIndex\.forDevice\(message\.deviceId\), message\)/);
});
