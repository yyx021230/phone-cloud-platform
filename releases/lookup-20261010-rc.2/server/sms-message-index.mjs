const EMPTY_MESSAGES = Object.freeze([]);

export function createSmsMessageIndex(messages = []) {
  let allMessages = [];
  let messagesByDevice = new Map();
  let messagesByBusinessKey = new Map();

  const replace = (nextMessages = []) => {
    allMessages = Array.isArray(nextMessages) ? nextMessages : [];
    messagesByDevice = new Map();
    messagesByBusinessKey = new Map();
    for (const message of allMessages) addToIndexes(message);
  };

  const addToIndexes = (message) => {
    if (!message || typeof message !== "object") return;
    const deviceId = normalizedDeviceId(message.deviceId);
    if (deviceId) {
      const deviceMessages = messagesByDevice.get(deviceId);
      if (deviceMessages) deviceMessages.push(message);
      else messagesByDevice.set(deviceId, [message]);
    }
    const key = businessKey(message.deviceId, message.messageKey);
    if (key) messagesByBusinessKey.set(key, message);
  };

  const removeFromIndexes = (message, previous = {}) => {
    const deviceId = normalizedDeviceId(previous.deviceId ?? message?.deviceId);
    if (deviceId) {
      const deviceMessages = messagesByDevice.get(deviceId);
      if (deviceMessages) {
        const index = deviceMessages.indexOf(message);
        if (index >= 0) deviceMessages.splice(index, 1);
        if (!deviceMessages.length) messagesByDevice.delete(deviceId);
      }
    }
    const key = businessKey(previous.deviceId ?? message?.deviceId, previous.messageKey ?? message?.messageKey);
    if (key && messagesByBusinessKey.get(key) === message) messagesByBusinessKey.delete(key);
  };

  const api = {
    replace,
    all() {
      return allMessages;
    },
    forDevice(deviceId) {
      return messagesByDevice.get(normalizedDeviceId(deviceId)) || EMPTY_MESSAGES;
    },
    countForDevice(deviceId) {
      return messagesByDevice.get(normalizedDeviceId(deviceId))?.length || 0;
    },
    find(deviceId, messageKey) {
      return messagesByBusinessKey.get(businessKey(deviceId, messageKey)) || null;
    },
    add(message) {
      addToIndexes(message);
    },
    reindex(message, previous = {}) {
      removeFromIndexes(message, previous);
      addToIndexes(message);
    }
  };

  replace(messages);
  return api;
}

export function sortSmsMessagesNewestFirst(messages = []) {
  return messages.sort((left, right) => smsMessageTime(right) - smsMessageTime(left));
}

export function smsMessageTime(message) {
  const time = new Date(message?.messageAt || message?.receivedAt || message?.createdAt || 0).getTime();
  return Number.isFinite(time) ? time : 0;
}

function businessKey(deviceId, messageKey) {
  const normalizedDevice = normalizedDeviceId(deviceId);
  const normalizedMessage = String(messageKey || "").trim();
  return normalizedDevice && normalizedMessage ? `${normalizedDevice}\u0000${normalizedMessage}` : "";
}

function normalizedDeviceId(value) {
  return String(value || "").trim();
}
