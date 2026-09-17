import assert from "node:assert/strict";
import test from "node:test";
import { assignSmsSlotIndexes, parseSubscriptionSlotMap } from "./sms-subscription-map.mjs";

test("parses ColorOS SubscriptionController slot mappings", () => {
  const output = `
SubscriptionController:
 sSlotIndexToSubId[0]: subIds=0=[1]
 sSlotIndexToSubId[1]: subIds=1=[2]
  {id=1 iccId=masked simSlotIndex=0 carrierId=1436}
  {id=2 iccId=masked simSlotIndex=1 carrierId=1436}
`;

  assert.deepEqual([...parseSubscriptionSlotMap(output)], [[1, 0], [2, 1]]);
});

test("authoritative subscription map corrects stale platform SIM metadata", () => {
  const messages = [
    { smsId: "1", subscriptionId: 1 },
    { smsId: "2", subscriptionId: 2 },
    { smsId: "3" }
  ];
  const staleSims = [
    { subscriptionId: 0, slotIndex: 0 },
    { subscriptionId: 1, slotIndex: 1 }
  ];

  assert.deepEqual(assignSmsSlotIndexes(messages, staleSims, new Map([[1, 0], [2, 1]])), [
    { smsId: "1", subscriptionId: 1, slotIndex: 0 },
    { smsId: "2", subscriptionId: 2, slotIndex: 1 },
    { smsId: "3" }
  ]);
});

test("falls back to the platform SIM mapping when dumpsys is unavailable", () => {
  assert.deepEqual(assignSmsSlotIndexes(
    [{ smsId: "1", subscriptionId: 7 }],
    [{ subscriptionId: 7, slotIndex: 1 }]
  ), [{ smsId: "1", subscriptionId: 7, slotIndex: 1 }]);
});
