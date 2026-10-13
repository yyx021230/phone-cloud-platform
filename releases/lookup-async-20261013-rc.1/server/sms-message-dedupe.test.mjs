import assert from "node:assert/strict";
import test from "node:test";
import { findSemanticSmsDuplicate, isSemanticSmsDuplicate, mergeCrossSourceSms } from "./sms-message-dedupe.mjs";

const notification = {
  messageId: "message-original",
  deviceId: "adb:one",
  messageKey: "notification:abc",
  address: "1069 0000",
  body: "验证码 123456，5 分钟内有效",
  messageAt: "2026-08-14T10:00:00.000Z",
  source: "windows-agent-notification",
  createdAt: "2026-08-14T10:00:01.000Z",
  slotIndex: null
};

const provider = {
  messageId: "message-new",
  deviceId: "adb:one",
  messageKey: "sms:144",
  smsId: "144",
  address: "10690000",
  body: "验证码 123456，5 分钟内有效",
  messageAt: "2026-08-14T10:00:30.000Z",
  source: "windows-agent-adb",
  subscriptionId: 2,
  slotIndex: 1
};

test("recognizes only a close cross-source semantic duplicate", () => {
  assert.equal(isSemanticSmsDuplicate(notification, provider), true);
  assert.equal(isSemanticSmsDuplicate(notification, { ...provider, source: "android-agent" }), true);
  assert.equal(isSemanticSmsDuplicate(notification, { ...provider, body: "another message" }), false);
  assert.equal(isSemanticSmsDuplicate(notification, { ...provider, messageAt: "2026-08-14T10:03:00.001Z" }), false);
  assert.equal(isSemanticSmsDuplicate(provider, { ...provider, messageKey: "sms:145" }), false);
  assert.equal(findSemanticSmsDuplicate([provider], notification)?.smsId, "144");
});

test("merges a ColorOS-compressed OTP notification with its full provider row", () => {
  const compressed = {
    ...notification,
    address: "小红书",
    body: "验证码 123456，请勿泄露",
    messageAt: "2026-08-14T10:00:02.024Z"
  };
  assert.equal(isSemanticSmsDuplicate(compressed, provider), true);
  assert.equal(isSemanticSmsDuplicate(compressed, { ...provider, body: "验证码 654321，5 分钟内有效" }), false);
  assert.equal(isSemanticSmsDuplicate(compressed, { ...provider, messageAt: "2026-08-14T10:00:32.025Z" }), false);
  assert.equal(isSemanticSmsDuplicate(
    { ...notification, address: "小红书", messageAt: "2026-08-14T10:00:02.024Z" },
    provider
  ), true);
  assert.equal(isSemanticSmsDuplicate(
    { ...compressed, body: "验证码 123456，备用码 888888" },
    provider
  ), false);
  assert.equal(isSemanticSmsDuplicate(compressed, { ...provider, source: "android-agent" }), true);
});

test("keeps two provider rows distinct even when the OTP and time are identical", () => {
  assert.equal(isSemanticSmsDuplicate(provider, { ...provider, messageKey: "sms:145" }), false);
});

test("merges provider authority without changing the existing platform identity", () => {
  const merged = mergeCrossSourceSms(notification, provider);
  assert.equal(merged.messageId, "message-original");
  assert.equal(merged.messageKey, "sms:144");
  assert.equal(merged.smsId, "144");
  assert.equal(merged.slotIndex, 1);
  assert.equal(merged.source, "windows-agent-adb");
  assert.deepEqual(merged.sourceAliases, ["windows-agent-notification", "windows-agent-adb"]);
});

test("a later notification cannot erase provider SIM metadata", () => {
  const merged = mergeCrossSourceSms(provider, notification);
  assert.equal(merged.messageId, "message-new");
  assert.equal(merged.messageKey, "sms:144");
  assert.equal(merged.subscriptionId, 2);
  assert.equal(merged.slotIndex, 1);
  assert.equal(merged.source, "windows-agent-adb");
});

test("matches an identical notification to the nearest of two real provider messages", () => {
  const earlier = { ...provider, messageId: "earlier", messageKey: "sms:200", smsId: "200", messageAt: "2026-08-14T10:00:00.000Z" };
  const later = { ...provider, messageId: "later", messageKey: "sms:201", smsId: "201", messageAt: "2026-08-14T10:01:00.000Z" };
  const incoming = { ...notification, messageAt: "2026-08-14T10:00:55.000Z" };
  assert.equal(findSemanticSmsDuplicate([earlier, later], incoming)?.messageId, "later");
});

test("matches a compressed OTP notification to the nearest provider row only", () => {
  const earlier = { ...provider, messageId: "earlier", messageKey: "sms:300", smsId: "300", messageAt: "2026-08-14T10:00:05.000Z" };
  const later = { ...provider, messageId: "later", messageKey: "sms:301", smsId: "301", messageAt: "2026-08-14T10:00:20.000Z" };
  const incoming = {
    ...notification,
    address: "小红书",
    body: "验证码 123456，请勿泄露",
    messageAt: "2026-08-14T10:00:18.000Z"
  };
  assert.equal(findSemanticSmsDuplicate([earlier, later], incoming)?.messageId, "later");
});
