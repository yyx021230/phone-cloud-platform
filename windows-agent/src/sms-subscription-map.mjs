export function parseSubscriptionSlotMap(output) {
  const text = String(output || "");
  const bySubscriptionId = new Map();

  for (const match of text.matchAll(/sSlotIndexToSubId\[(\d+)\]:[^\n]*?\[(\d+)\]/g)) {
    rememberMapping(bySubscriptionId, match[2], match[1]);
  }

  for (const match of text.matchAll(/\{id=(\d+)\b[^\n]*?\bsimSlotIndex=(\d+)\b/g)) {
    rememberMapping(bySubscriptionId, match[1], match[2]);
  }

  return bySubscriptionId;
}

export function assignSmsSlotIndexes(messages, sims = [], authoritativeMap = new Map()) {
  const fallbackMap = new Map();
  for (const sim of Array.isArray(sims) ? sims : []) {
    rememberMapping(fallbackMap, sim?.subscriptionId, sim?.slotIndex);
  }

  return (Array.isArray(messages) ? messages : []).map((message) => {
    const subscriptionId = finiteInteger(message?.subscriptionId);
    if (subscriptionId === null) return message;
    const slotIndex = authoritativeMap.get(subscriptionId) ?? fallbackMap.get(subscriptionId);
    return Number.isInteger(slotIndex) ? { ...message, slotIndex } : message;
  });
}

function rememberMapping(target, subscriptionIdValue, slotIndexValue) {
  const subscriptionId = finiteInteger(subscriptionIdValue);
  const slotIndex = finiteInteger(slotIndexValue);
  if (subscriptionId === null || slotIndex === null || subscriptionId < 0 || slotIndex < 0) return;
  target.set(subscriptionId, slotIndex);
}

function finiteInteger(value) {
  const number = Number(value);
  return Number.isInteger(number) ? number : null;
}
