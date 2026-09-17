import assert from "node:assert/strict";
import test from "node:test";

import { createSmsMessageIndex, sortSmsMessagesNewestFirst } from "./sms-message-index.mjs";

test("indexes SMS messages by device and business key without rescanning the full collection", () => {
  const first = { messageId: "1", deviceId: "device-a", messageKey: "sms:1" };
  const second = { messageId: "2", deviceId: "device-b", messageKey: "sms:2" };
  const index = createSmsMessageIndex([first, second]);

  assert.deepEqual(index.forDevice("device-a"), [first]);
  assert.equal(index.countForDevice("device-b"), 1);
  assert.equal(index.find("device-a", "sms:1"), first);
  assert.equal(index.find("device-a", "sms:2"), null);
});

test("tracks an inserted message and a semantic merge that changes its business key", () => {
  const index = createSmsMessageIndex([]);
  const message = { messageId: "1", deviceId: "device-a", messageKey: "notification:1" };
  index.add(message);

  const previous = { deviceId: message.deviceId, messageKey: message.messageKey };
  message.messageKey = "provider:7";
  index.reindex(message, previous);

  assert.equal(index.find("device-a", "notification:1"), null);
  assert.equal(index.find("device-a", "provider:7"), message);
  assert.deepEqual(index.forDevice("device-a"), [message]);
});

test("rebuilds after retention or device reassignment replaces the source collection", () => {
  const moved = { messageId: "1", deviceId: "device-b", messageKey: "sms:1" };
  const index = createSmsMessageIndex([{ messageId: "old", deviceId: "device-a", messageKey: "old" }]);
  index.replace([moved]);

  assert.equal(index.countForDevice("device-a"), 0);
  assert.equal(index.find("device-b", "sms:1"), moved);
  assert.deepEqual(index.all(), [moved]);
});

test("sorts SMS messages newest first once so read paths can preserve indexed order", () => {
  const messages = [
    { messageId: "old", messageAt: "2026-09-01T00:00:00.000Z" },
    { messageId: "new", receivedAt: "2026-09-02T00:00:00.000Z" },
    { messageId: "unknown" }
  ];

  sortSmsMessagesNewestFirst(messages);
  assert.deepEqual(messages.map((message) => message.messageId), ["new", "old", "unknown"]);
});
