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
