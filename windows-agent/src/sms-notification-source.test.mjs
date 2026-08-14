import assert from "node:assert/strict";
import test from "node:test";
import {
  buildLegacyDefaultSmsPackageArgs,
  buildSmsNotificationDumpArgs,
  buildSmsRoleHolderArgs,
  parseDefaultSmsRoleHolders,
  parseLegacyDefaultSmsPackage,
  parseSmsNotificationDump
} from "./sms-notification-source.mjs";

test("discovers the default SMS package without accepting shell syntax", () => {
  assert.equal(parseDefaultSmsRoleHolders("com.android.mms\n"), "com.android.mms");
  assert.equal(parseDefaultSmsRoleHolders(`ROLE STATE (dumpsys role):
    { name=android.app.role.SYSTEM_CONTACTS holders=com.android.contacts }
    { name=android.app.role.SMS holders=com.google.android.apps.messaging }
  `), "com.google.android.apps.messaging");
  assert.equal(parseDefaultSmsRoleHolders("ROLE STATE (dumpsys role):\n{ name=android.app.role.SMS }"), "");
  assert.equal(parseLegacyDefaultSmsPackage("com.bbk.mms\r\n"), "com.bbk.mms");
  assert.equal(parseLegacyDefaultSmsPackage("null"), "");
  assert.deepEqual(buildSmsRoleHolderArgs(), ["shell", "dumpsys", "role"]);
  assert.deepEqual(buildLegacyDefaultSmsPackageArgs(), ["shell", "settings", "get", "secure", "sms_default_application"]);
  assert.throws(() => buildSmsNotificationDumpArgs("com.android.mms; id"), /invalid_default_sms_package/);
});

test("builds a package-filtered notification dump command", () => {
  assert.deepEqual(buildSmsNotificationDumpArgs("com.android.mms"), [
    "shell", "dumpsys", "notification", "--noredact", "--package", "com.android.mms"
  ]);
});

test("parses ColorOS text and bigText once without inventing a SIM slot", () => {
  const output = `
    NotificationRecord(0x1: pkg=com.android.mms user=UserHandle{0} id=42 key=0|com.android.mms|42|null|1000)
      mCreationTimeMs=1786540000000
      mUpdateTimeMs=1786540000887
        android.title=String (小红书)
        android.text=String (验证码 123456，5 分钟内有效)
        android.bigText=String (验证码 123456，5 分钟内有效)
    NotificationRecord(0x2: pkg=com.example.other id=9 key=other)
        android.text=String (private other notification)
  `;
  const messages = parseSmsNotificationDump(output, { packageName: "com.android.mms", nowMs: 1_786_540_001_000 });
  assert.equal(messages.length, 1);
  assert.equal(messages[0].address, "小红书");
  assert.equal(messages[0].body, "验证码 123456，5 分钟内有效");
  assert.equal(messages[0].slotIndex, null);
  assert.equal(messages[0].source, "windows-agent-notification");
  assert.match(messages[0].messageKey, /^notification:[a-f0-9]{40}$/);
  assert.doesNotMatch(JSON.stringify(messages[0]), /private other notification/);
});

test("parses text values exposed through android.messages", () => {
  const output = `
    NotificationRecord(0x1: pkg=com.google.android.apps.messaging id=7 key=message-key)
      postTime=1786540000123
        android.title=String (10690000)
        android.messages=ParcelableArray ({text=String (Your code is 884422), time=1786540000123})
  `;
  const messages = parseSmsNotificationDump(output, { packageName: "com.google.android.apps.messaging", nowMs: 1_786_540_001_000 });
  assert.equal(messages.length, 1);
  assert.equal(messages[0].address, "10690000");
  assert.equal(messages[0].body, "Your code is 884422");
});

test("ignores records with no usable body", () => {
  const output = `NotificationRecord(0x1: pkg=com.android.mms id=1 key=x)\n android.title=String (短信)`;
  assert.deepEqual(parseSmsNotificationDump(output, { packageName: "com.android.mms", nowMs: 1_786_540_000_000 }), []);
});

test("keeps two identical SMS notifications received inside two minutes", () => {
  const output = `
    NotificationRecord(0x1: pkg=com.android.mms id=1 key=first)
      mUpdateTimeMs=1786540000000
      android.title=String (10690000)
      android.text=String (验证码 123456)
    NotificationRecord(0x2: pkg=com.android.mms id=2 key=second)
      mUpdateTimeMs=1786540060000
      android.title=String (10690000)
      android.text=String (验证码 123456)
  `;
  const messages = parseSmsNotificationDump(output, {
    packageName: "com.android.mms",
    nowMs: 1_786_540_061_000
  });
  assert.equal(messages.length, 2);
  assert.notEqual(messages[0].messageKey, messages[1].messageKey);
  assert.deepEqual(
    parseSmsNotificationDump(`${output}\n${output}`, { packageName: "com.android.mms", nowMs: 1_786_540_061_000 }).map((item) => item.messageKey),
    messages.map((item) => item.messageKey)
  );
});
