import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

// Exercise the actual status serializer without starting the Agent or ADB.
const source = fs.readFileSync(new URL("./index.mjs", import.meta.url), "utf8");
const body = source.match(/^function compactTaskResultForStatus\(result = \{\}\) \{[\s\S]*?^\}/m)?.[0];
assert.ok(body);
const compact = new Function("compactEventDetail", `${body}; return compactTaskResultForStatus;`)((value) => value);

test("lookup identity and rotation survive the Agent status transport", () => {
  const result = compact({ currentAccount: "synthetic-B", accountIdentityVerified: true,
    savedAccounts: [{ account: "synthetic-A", current: false }, { account: "synthetic-B", current: true }],
    accountSwitched: true, accountSwitchCount: 2, accountSwitchReason: "access_denied" });
  const wire = JSON.parse(JSON.stringify(result));
  assert.equal(wire.accountIdentityVerified, true);
  assert.equal(wire.currentAccount, "synthetic-B");
  assert.equal(wire.savedAccounts.find((row) => row.current).account, wire.currentAccount);
  assert.equal(wire.accountSwitched, true);
  assert.equal(wire.accountSwitchCount, 2);
  assert.equal(wire.accountSwitchReason, "access_denied");
});

test("status transport cannot promote unverified identity and leaves unrelated results unchanged", () => {
  for (const value of [false, "true", 1, null]) {
    assert.equal(compact({ accountIdentityVerified: value }).accountIdentityVerified, false);
  }
  const unrelated = compact({ action: "synthetic unrelated task" });
  assert.equal(Object.hasOwn(unrelated, "accountIdentityVerified"), false);
  assert.equal(Object.hasOwn(unrelated, "accountSwitchCount"), false);
  assert.equal(Object.hasOwn(unrelated, "accountSwitchReason"), false);
});
