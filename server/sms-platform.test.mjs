import assert from "node:assert/strict";
import test from "node:test";
import { detectPlatform, normalizePlatform, resolveSmsPlatform } from "./sms-platform.mjs";
import { selectSmsOrderMatch } from "./sms-order-matcher.mjs";
import { parseSmsNotificationDump } from "../windows-agent/src/sms-notification-source.mjs";
import { findSemanticSmsDuplicate, filterMaskedVerificationDuplicates } from "./sms-message-dedupe.mjs";

// Synthetic fixtures only: never fetch real SMS or send a verification request.
const now = Date.parse("2026-09-08T01:00:20Z");
const order = (extra = {}) => ({
  orderId: "douyin-order", clientId: "synthetic-client", status: "waiting",
  deviceId: "synthetic-device", phoneNumber: "13800000006", platform: "抖音",
  startedAt: "2026-09-08T01:00:00Z", expiresAt: "2026-09-08T01:05:00Z", ...extra
});
const message = (extra = {}) => ({
  deviceId: "synthetic-device", address: "10600000000",
  body: "【抖音】验证码 123456，请勿泄露。", ...extra
});

test("normalizes Douyin aliases without conflating other ByteDance products", () => {
  for (const value of ["抖音", "douyin", "DouYin", " DOUYIN ", "ｄｏｕｙｉｎ"]) {
    assert.equal(normalizePlatform(value), "抖音");
  }
  for (const value of ["TikTok", "字节跳动", "今日头条", "懂车帝", "dy", "my-douyin-service"]) {
    assert.equal(normalizePlatform(value), value);
  }
  for (const value of ["小红书", "xhs", "XiaoHongShu", "redbook"]) {
    assert.equal(normalizePlatform(value), "小红书");
  }
});

test("identifies Douyin from a complete SMS brand tag at either end", () => {
  for (const body of [
    "【抖音】验证码 123456", "验证码 123456【抖音】",
    "[抖音] 验证码 123456", "［Ｄｏｕｙｉｎ］Verification code: 123456"
  ]) assert.equal(detectPlatform(body, "10600000000"), "抖音");
});

test("identifies a shortened SMS notification using its exact brand title", () => {
  for (const sender of ["抖音", "Douyin", "【抖音】", "[Douyin]"]) {
    assert.equal(detectPlatform("验证码 123456", sender), "抖音");
  }
  for (const sender of ["【抖音", "抖音]", "抖音用户消息", "notdouyin"]) {
    assert.notEqual(detectPlatform("验证码 123456", sender), "抖音");
  }
});

test("does not infer Douyin from incidental mentions or another product's tag", () => {
  for (const body of [
    "【银行】验证码123456，用于抖音付款", "【TikTok】验证码123456",
    "【字节跳动】验证码123456", "【今日头条】验证码123456",
    "验证码123456，请勿发给抖音好友", "【抖音商城店铺】验证码123456"
  ]) assert.notEqual(detectPlatform(body, "10600000000"), "抖音");
  assert.equal(detectPlatform("【抖音】【小红书】验证码123456"), "未知平台");
});

test("ingestion and matching share platform resolution, including legacy numeric labels", () => {
  for (const explicit of [undefined, "", "未知平台", "10600000000", "douyin"]) {
    const raw = message({ platform: explicit });
    assert.equal(resolveSmsPlatform(raw), "抖音");
    assert.equal(selectSmsOrderMatch([order({ platform: "Douyin" })], raw, now)?.code, "123456");
  }
  assert.equal(resolveSmsPlatform(message({ platform: "银行" })), "银行");
  assert.equal(selectSmsOrderMatch([order()], message({ platform: "银行" }), now), null);
});

test("Douyin and Xiaohongshu waiting orders never consume each other's code", () => {
  const orders = [order({ orderId: "xhs", platform: "小红书" }), order()];
  assert.equal(selectSmsOrderMatch(orders, message(), now)?.order.orderId, "douyin-order");
  assert.equal(selectSmsOrderMatch(orders, message({ body: "【小红书】验证码654321" }), now)?.order.orderId, "xhs");
});

test("ordinary, masked and unclassified messages leave a Douyin order waiting", () => {
  for (const body of [
    "【抖音】您有2026条新消息", "【抖音】验证码******", "【抖音】验证码ABCDEF",
    "您的验证码123456", "【TikTok】验证码123456"
  ]) assert.equal(selectSmsOrderMatch([order()], message({ body }), now), null);
});

test("Douyin retains device, time, terminal-state and multi-SIM ambiguity guards", () => {
  assert.equal(selectSmsOrderMatch([order()], message({ deviceId: "other-device" }), now), null);
  assert.equal(selectSmsOrderMatch([order()], message(), now - 120_000), null);
  assert.equal(selectSmsOrderMatch([order()], message(), now + 600_000), null);
  for (const status of ["received", "cancelled", "expired", "failed"]) {
    assert.equal(selectSmsOrderMatch([order({ status })], message(), now), null);
  }
  const orders = [order({ subscriptionId: 1, slotIndex: 0 }), order({
    orderId: "sim2", phoneNumber: "13800000007", subscriptionId: 2, slotIndex: 1
  })];
  assert.equal(selectSmsOrderMatch(orders, message(), now), null);
  assert.equal(selectSmsOrderMatch(orders, message({ subscriptionId: 2, slotIndex: 1 }), now)?.order.orderId, "sim2");
});

test("does not consume numeric fragments of long, mixed or masked verification codes", () => {
  for (const [body, code] of [
    ["【抖音】验证码123456789", "12345678"], ["【抖音】验证码AB123456", "AB123456"],
    ["【抖音】验证码123456AB", "123456"], ["【抖音】验证码***", "123456"],
    ["【抖音】验证码123", ""], ["【抖音】验证码123456", "654321"]
  ]) assert.equal(selectSmsOrderMatch([order()], message({ body, code }), now), null);
  for (const body of ["【抖音】验证码1234", "【抖音】12345678是您的验证码", "[Douyin] Your code is 123456"]) {
    assert.ok(selectSmsOrderMatch([order()], message({ body }), now));
  }
});

test("default SMS app notification parser feeds the same Douyin matcher", () => {
  const dump = `NotificationRecord(0x0: pkg=com.android.mms user=UserHandle{0} id=1 tag=null key=0|com.android.mms|1|null|1000)
    postTime=${now}
    extras={
      android.title=String (抖音)
      android.text=String (验证码 123456，请勿泄露)
    }`;
  const messages = parseSmsNotificationDump(dump, { packageName: "com.android.mms", nowMs: now });
  assert.equal(messages.length, 1);
  const raw = { ...messages[0], deviceId: "synthetic-device" };
  assert.equal(resolveSmsPlatform(raw), "抖音");
  assert.equal(selectSmsOrderMatch([order()], raw, now)?.code, "123456");
});

test("equal OTP digits from different supported platforms are not cross-source duplicates", () => {
  const provider = message({ platform: "小红书", body: "验证码123456", messageAt: new Date(now).toISOString(), source: "windows-agent-adb" });
  const notification = message({ platform: "抖音", body: "验证码123456", messageAt: new Date(now + 1000).toISOString(), source: "windows-agent-notification" });
  assert.equal(findSemanticSmsDuplicate([provider], notification), null);
  assert.equal(findSemanticSmsDuplicate([notification], provider), null);
  const masked = { ...notification, body: "验证码******" };
  assert.equal(filterMaskedVerificationDuplicates([provider, masked]).length, 2);
  assert.ok(findSemanticSmsDuplicate([{ ...provider, platform: "抖音" }], notification));
});
