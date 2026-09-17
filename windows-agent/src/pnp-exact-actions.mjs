const EXACT_USB_INSTANCE_PATTERN = /^USB\\[A-Za-z0-9&_.\\:-]{4,500}$/i;

export function assertExactUsbInstanceId(value) {
  const target = String(value || "").trim();
  if (!EXACT_USB_INSTANCE_PATTERN.test(target)) throw new Error("unsafe exact PnP instance id");
  return target;
}

export function assertDistinctExactUsbInstances(targetValue, scanValue, message = "unsafe exact PnP relationship") {
  const target = assertExactUsbInstanceId(targetValue);
  const scan = assertExactUsbInstanceId(scanValue);
  if (target.toUpperCase() === scan.toUpperCase()) throw new Error(message);
  return { target, scan };
}

export function buildRemoveExactPnpArgs(instanceId, options = {}) {
  const args = ["/remove-device", assertExactUsbInstanceId(instanceId)];
  if (options.subtree === true) args.push("/subtree");
  return args;
}
