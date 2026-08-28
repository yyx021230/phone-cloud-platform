import assert from "node:assert/strict";
import test from "node:test";
import { selectSmsOrderMatch } from "./sms-order-matcher.mjs";

const startedAt = "2026-08-20T01:00:00.000Z";
const expiresAt = "2026-08-20T01:05:00.000Z";
const messageTime = new Date("2026-08-20T01:00:20.000Z").getTime();

function order(overrides = {}) {
  return {
    orderId: "order-1",
    status: "waiting",
    source: "open-api",
    clientId: "xhs-backend",
    deviceId: "device-1",
    phoneNumber: "13800000001",
    subscriptionId: 1,
    slotIndex: 1,
    platform: "小红书",
    matchMode: "first_new_sms",
    startedAt,
    expiresAt,
    ...overrides
  };
}

function message(overrides = {}) {
  return {
    deviceId: "device-1",
    phoneNumber: "",
    subscriptionId: 4,
    slotIndex: null,
    platform: "小红书",
    body: "【小红书】验证码为123456，请勿泄露",
    ...overrides
  };
}

test("accepts a stale platform subscription when one logical device target is waiting", () => {
  const selected = selectSmsOrderMatch([order()], message(), messageTime);
  assert.equal(selected?.order.orderId, "order-1");
  assert.equal(selected?.strategy, "unique_device_stale_sim");
});

test("does not guess between two different SIM phone targets on one device", () => {
  const selected = selectSmsOrderMatch([
    order(),
    order({ orderId: "order-2", phoneNumber: "13800000002", subscriptionId: 2, slotIndex: 0 })
  ], message(), messageTime);
  assert.equal(selected, null);
});

test("live subscription metadata selects the correct one of two waiting SIMs", () => {
  const selected = selectSmsOrderMatch([
    order(),
    order({ orderId: "order-2", phoneNumber: "13800000002", subscriptionId: 4, slotIndex: 0 })
  ], message(), messageTime);
  assert.equal(selected?.order.orderId, "order-2");
  assert.equal(selected?.strategy, "exact_sim");
});

test("a retry for the same logical target supersedes the older waiting attempt", () => {
  const selected = selectSmsOrderMatch([
    order({ orderId: "old", startedAt: "2026-08-20T01:00:00.000Z" }),
    order({ orderId: "new", startedAt: "2026-08-20T01:00:10.000Z" })
  ], message(), messageTime);
  assert.equal(selected?.order.orderId, "new");
});

test("an open Xiaohongshu request cannot consume a bank verification SMS", () => {
  const selected = selectSmsOrderMatch([
    order()
  ], message({ platform: "招商银行", body: "【招商银行】验证码为123456" }), messageTime);
  assert.equal(selected, null);
});

test("an open Xiaohongshu request cannot consume an unclassified verification SMS", () => {
  const selected = selectSmsOrderMatch([
    order()
  ], message({ platform: "", body: "您的验证码为123456，请勿泄露" }), messageTime);
  assert.equal(selected, null);
});

test("message text can safely identify Xiaohongshu when the platform field is absent", () => {
  const selected = selectSmsOrderMatch([
    order()
  ], message({ platform: "", body: "[小红书] 验证码为123456" }), messageTime);
  assert.equal(selected?.order.orderId, "order-1");
  assert.equal(selected?.code, "123456");
});

test("an ordinary Xiaohongshu notification cannot consume a verification order", () => {
  const selected = selectSmsOrderMatch([
    order()
  ], message({
    code: "",
    body: "【小红书】聚光平台提醒您，有用户打开了您的私信聊天窗口"
  }), messageTime);
  assert.equal(selected, null);
});

test("a Xiaohongshu message with unrelated digits is not treated as a code", () => {
  const selected = selectSmsOrderMatch([
    order()
  ], message({
    code: "",
    body: "【小红书】聚光平台2026年度提醒，您有1条新消息"
  }), messageTime);
  assert.equal(selected, null);
});

test("only a numeric four-to-eight digit verification code is accepted", () => {
  assert.equal(selectSmsOrderMatch([
    order()
  ], message({ code: "AB12CD", body: "【小红书】验证码为AB12CD" }), messageTime), null);
  const selected = selectSmsOrderMatch([
    order()
  ], message({ code: "", body: "【小红书】123456 是您的验证码，请勿泄露" }), messageTime);
  assert.equal(selected?.code, "123456");
});

test("unknown SIM metadata remains ambiguous for two different phone targets", () => {
  const selected = selectSmsOrderMatch([
    order(),
    order({ orderId: "order-2", phoneNumber: "13800000002", subscriptionId: 2, slotIndex: 0 })
  ], message({ subscriptionId: null, slotIndex: null }), messageTime);
  assert.equal(selected, null);
});

test("replays the stale SIM metadata shapes observed in production incidents", () => {
  const observedMessages = [
    { subscriptionId: 4, slotIndex: null },
    { subscriptionId: 2, slotIndex: null },
    { subscriptionId: 1, slotIndex: 1 },
    { subscriptionId: 4, slotIndex: null }
  ];
  for (const observed of observedMessages) {
    const selected = selectSmsOrderMatch([order()], message(observed), messageTime);
    assert.equal(selected?.order.orderId, "order-1");
    assert.match(selected?.strategy || "", /^(exact_sim|unique_device_stale_sim)$/);
  }
});
