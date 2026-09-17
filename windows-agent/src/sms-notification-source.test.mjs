import assert from "node:assert/strict";
import test from "node:test";
import {
  buildDefaultSmsSendToResolveArgs,
  buildLegacyDefaultSmsPackageArgs,
  buildSmsNotificationDumpArgs,
  buildSmsPackageDumpArgs,
  buildSmsRelatedPackageListArgs,
  buildSmsRoleHolderArgs,
  parseInstalledPackageNames,
  parseDefaultSmsRoleHolders,
  parseLegacyDefaultSmsPackage,
  parseResolvedDefaultSmsPackage,
  parseSmsPackageTrustEvidence,
  parseSmsNotificationDump,
  isMaskedVerificationNotification,
  selectTrustedSmsNotificationPackages,
  selectUnsentSmsNotifications
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
  assert.equal(parseResolvedDefaultSmsPackage(`priority=0 preferredOrder=0 match=0x208000 specificIndex=-1 isDefault=true
com.android.mms/.ui.ComposeMessageActivity`), "com.android.mms");
  assert.equal(parseResolvedDefaultSmsPackage("No activity found\n"), "");
  assert.deepEqual(buildSmsRoleHolderArgs(), ["shell", "dumpsys", "role"]);
  assert.deepEqual(buildLegacyDefaultSmsPackageArgs(), ["shell", "settings", "get", "secure", "sms_default_application"]);
  assert.deepEqual(buildDefaultSmsSendToResolveArgs(), [
    "shell", "cmd", "package", "resolve-activity", "--brief",
    "-a", "android.intent.action.SENDTO", "-d", "smsto:10086"
  ]);
  assert.throws(() => buildSmsNotificationDumpArgs("com.android.mms; id"), /invalid_default_sms_package/);
});

test("builds a package-filtered notification dump command", () => {
  assert.deepEqual(buildSmsNotificationDumpArgs("com.android.mms"), [
    "shell", "dumpsys", "notification", "--noredact", "--package", "com.android.mms"
  ]);
  assert.deepEqual(buildSmsRelatedPackageListArgs("com.android.mms"), [
    "shell", "pm", "list", "packages", "com.android.mms"
  ]);
  assert.deepEqual(buildSmsPackageDumpArgs("com.android.mms.service"), [
    "shell", "dumpsys", "package", "com.android.mms.service"
  ]);
});

test("trusts only installed system SMS subpackages with the same signing certificate", () => {
  assert.deepEqual(parseInstalledPackageNames(`package:com.android.mms.service\npackage:com.android.mms\ninvalid`), [
    "com.android.mms.service",
    "com.android.mms"
  ]);
  const primary = parseSmsPackageTrustEvidence(`
    signatures=PackageSignatures{x version:3, signatures:[abd0c91b]}
    pkgFlags=[ SYSTEM HAS_CODE ]
    privatePkgFlags=[ PRIVILEGED ]
  `);
  const service = parseSmsPackageTrustEvidence(`
    signatures=PackageSignatures{y version:3, signatures:[abd0c91b]}
    pkgFlags=[ SYSTEM HAS_CODE ]
    privatePkgFlags=[ PRIVILEGED ]
  `);
  assert.deepEqual(selectTrustedSmsNotificationPackages("com.android.mms", [
    "com.android.mms",
    "com.android.mms.service",
    "com.android.mms.untrusted",
    "com.example.samecert"
  ], {
    "com.android.mms": primary,
    "com.android.mms.service": service,
    "com.android.mms.untrusted": { ...service, signature: "different" },
    "com.example.samecert": service
  }), ["com.android.mms", "com.android.mms.service"]);
});

test("parses a signed vivo SMS service notification only when its trusted alias is supplied", () => {
  const output = `
    NotificationRecord(0x1: pkg=com.android.mms.service user=UserHandle{0} id=7 key=service-key)
      mCreationTimeMs=1787305652852
      android.title=String (小红书)
      android.text=String (【小红书】您的验证码是: 136463，3分钟内有效。)
  `;
  assert.deepEqual(parseSmsNotificationDump(output, {
    packageName: "com.android.mms",
    nowMs: 1_787_305_653_000
  }), []);
  const messages = parseSmsNotificationDump(output, {
    packageName: "com.android.mms",
    packageNames: ["com.android.mms", "com.android.mms.service"],
    nowMs: 1_787_305_653_000
  });
  assert.equal(messages.length, 1);
  assert.equal(messages[0].sourcePackage, "com.android.mms.service");
  assert.match(messages[0].body, /136463/);
});

test("rejects a masked OTP notification because hidden digits cannot be recovered safely", () => {
  assert.equal(isMaskedVerificationNotification("【小红书】您的验证码是: ******，3分钟内有效。"), true);
  assert.equal(isMaskedVerificationNotification("Your verification code is ●●●●●●"), true);
  assert.equal(isMaskedVerificationNotification("【小红书】您的验证码是: 101826，3分钟内有效。"), false);
  const output = `
    NotificationRecord(0x1: pkg=com.android.mms.service user=UserHandle{0} id=7 key=masked-key)
      mCreationTimeMs=1787534397072
      android.title=String (小红书)
      android.text=String (【小红书】您的验证码是: ******，3分钟内有效。)
  `;
  assert.deepEqual(parseSmsNotificationDump(output, {
    packageName: "com.android.mms",
    packageNames: ["com.android.mms", "com.android.mms.service"],
    nowMs: 1_787_534_398_000
  }), []);
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

test("background notification polling skips keys already uploaded but manual reconciliation replays them", () => {
  const messages = [
    { messageKey: "notification:one" },
    { messageKey: "notification:two" },
    { messageKey: "" }
  ];
  const uploaded = new Set(["notification:one"]);
  assert.deepEqual(
    selectUnsentSmsNotifications(messages, uploaded).map((item) => item.messageKey),
    ["notification:two", ""]
  );
  assert.deepEqual(selectUnsentSmsNotifications(messages, uploaded, { forceFull: true }), messages);
});
