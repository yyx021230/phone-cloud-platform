import { execFile } from "node:child_process";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const PACKAGE_NAME = "com.ztqc.smsrelay";
const MIN_SDK = 23;
const MAX_VALIDATED_SDK = 36;
const MIN_FREE_DATA_KB = 32 * 1024;

function text(value) {
  return String(value ?? "").replaceAll("\r", "").trim();
}

export function parseAdbDevices(output) {
  return String(output || "")
    .replaceAll("\r", "")
    .split("\n")
    .slice(1)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const match = line.match(/^(\S+)\s+(\S+)/);
      return match ? { serial: match[1], state: match[2] } : null;
    })
    .filter(Boolean);
}

export function parseMarkedSections(output) {
  const sections = new Map();
  let active = "";
  for (const rawLine of String(output || "").replaceAll("\r", "").split("\n")) {
    const marker = rawLine.match(/^__([A-Z0-9_]+)__$/);
    if (marker) {
      active = marker[1];
      if (!sections.has(active)) sections.set(active, []);
      continue;
    }
    if (active) sections.get(active).push(rawLine);
  }
  return Object.fromEntries([...sections.entries()].map(([key, lines]) => [key, text(lines.join("\n"))]));
}

export function parseFreeDataKb(output) {
  const lines = String(output || "").replaceAll("\r", "").split("\n").map((line) => line.trim()).filter(Boolean);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const fields = lines[index].split(/\s+/);
    if (fields.length < 4 || !/^\d+$/.test(fields[3])) continue;
    return Number(fields[3]);
  }
  return null;
}

export function evaluateDeviceProbe(device) {
  const failures = [];
  const warnings = [];
  if (device.state !== "device") failures.push(`adb_${device.state || "unknown"}`);
  if (!Number.isInteger(device.sdk) || device.sdk < MIN_SDK) failures.push("android_sdk_below_minimum");
  if (Number.isInteger(device.sdk) && device.sdk > MAX_VALIDATED_SDK) warnings.push("android_sdk_newer_than_validated_matrix");
  if (!device.telephony) failures.push("telephony_feature_missing");
  if (!device.roleService && !device.defaultSmsHandler) failures.push("sms_role_and_default_handler_missing");
  else if (!device.roleService) warnings.push("role_service_missing_legacy_default_handler_only");
  if (!device.defaultSmsHandler) warnings.push("default_sms_handler_not_resolved");
  if (device.freeDataKb == null) warnings.push("data_free_space_unknown");
  else if (device.freeDataKb < MIN_FREE_DATA_KB) failures.push("insufficient_data_space");
  if (!device.abi) warnings.push("primary_abi_unknown");
  if (device.installed) warnings.push("smsrelay_already_installed");
  return {
    ...device,
    compatible: failures.length === 0,
    status: failures.length ? "fail" : warnings.length ? "warning" : "pass",
    failures,
    warnings
  };
}

export function shellProbeScript() {
  return [
    "echo __MANUFACTURER__", "getprop ro.product.manufacturer",
    "echo __BRAND__", "getprop ro.product.brand",
    "echo __MODEL__", "getprop ro.product.model",
    "echo __DEVICE__", "getprop ro.product.device",
    "echo __SDK__", "getprop ro.build.version.sdk",
    "echo __ANDROID__", "getprop ro.build.version.release",
    "echo __PATCH__", "getprop ro.build.version.security_patch",
    "echo __ABI__", "getprop ro.product.cpu.abi",
    "echo __ABILIST__", "getprop ro.product.cpu.abilist",
    "echo __FEATURES__", "pm list features",
    "echo __ROLE_SERVICE__", "service check role",
    "echo __ROLE_HOLDERS__", "cmd role get-role-holders --user 0 android.app.role.SMS 2>/dev/null",
    "echo __SMS_HANDLER__", "cmd package resolve-activity --brief -a android.intent.action.SENDTO -d smsto:10086 2>/dev/null",
    "echo __DATA_DF__", "df -k /data 2>/dev/null",
    "echo __INSTALLED__", `pm path ${PACKAGE_NAME} 2>/dev/null`,
    // Optional probes such as `pm path` legitimately return non-zero when the
    // package is absent. Keep that from turning a completed probe into an ADB
    // transport failure.
    "true"
  ].join("; ");
}

async function runAdb(adbPath, args, timeout = 12_000) {
  const { stdout = "" } = await execFileAsync(adbPath, args, {
    timeout,
    maxBuffer: 2 * 1024 * 1024,
    windowsHide: true
  });
  return String(stdout || "");
}

async function probeOne(adbPath, entry) {
  if (entry.state !== "device") return evaluateDeviceProbe({ ...entry });
  try {
    // Pass the complete program as adb shell's single command argument. Using
    // `sh -c` with the program as a following argv is not portable across the
    // Windows adb client and OEM shells: only the first token can reach `-c`.
    const sections = parseMarkedSections(await runAdb(adbPath, ["-s", entry.serial, "shell", shellProbeScript()]));
    const sdk = Number(sections.SDK);
    const handlerLines = String(sections.SMS_HANDLER || "").split("\n").map((line) => line.trim()).filter(Boolean);
    const defaultSmsHandler = handlerLines.find((line) => line.includes("/")) || "";
    return evaluateDeviceProbe({
      ...entry,
      manufacturer: sections.MANUFACTURER || "",
      brand: sections.BRAND || "",
      model: sections.MODEL || "",
      device: sections.DEVICE || "",
      sdk: Number.isFinite(sdk) ? sdk : null,
      android: sections.ANDROID || "",
      patch: sections.PATCH || "",
      abi: sections.ABI || "",
      abilist: sections.ABILIST || "",
      telephony: /(?:^|\n)feature:android\.hardware\.telephony(?:\.|\n|$)/.test(sections.FEATURES || ""),
      roleService: /Service role: found/i.test(sections.ROLE_SERVICE || ""),
      roleHolders: String(sections.ROLE_HOLDERS || "").split("\n").map((line) => line.trim()).filter(Boolean),
      defaultSmsHandler,
      freeDataKb: parseFreeDataKb(sections.DATA_DF),
      installed: /package:/i.test(sections.INSTALLED || "")
    });
  } catch (error) {
    return evaluateDeviceProbe({
      ...entry,
      probeError: text(error?.message || error),
      sdk: null,
      telephony: false,
      roleService: false,
      defaultSmsHandler: "",
      freeDataKb: null,
      installed: false
    });
  }
}

async function runLimited(items, limit, worker) {
  const result = new Array(items.length);
  let next = 0;
  async function consume() {
    while (true) {
      const index = next;
      next += 1;
      if (index >= items.length) return;
      result[index] = await worker(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(Math.max(1, limit), Math.max(1, items.length)) }, consume));
  return result;
}

function option(name, fallback = "") {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

export async function runFleetPreflight({ adbPath = "adb", concurrency = 8 } = {}) {
  const entries = parseAdbDevices(await runAdb(adbPath, ["devices", "-l"]));
  const devices = await runLimited(entries, concurrency, (entry) => probeOne(adbPath, entry));
  const profileMap = new Map();
  for (const device of devices) {
    const key = [device.manufacturer, device.model, device.sdk, device.android, device.abi].join("|");
    const current = profileMap.get(key) || { profile: key, count: 0, pass: 0, warning: 0, fail: 0 };
    current.count += 1;
    current[device.status] += 1;
    profileMap.set(key, current);
  }
  return {
    schemaVersion: 1,
    capturedAt: new Date().toISOString(),
    packageName: PACKAGE_NAME,
    policy: { minSdk: MIN_SDK, maxValidatedSdk: MAX_VALIDATED_SDK, minFreeDataKb: MIN_FREE_DATA_KB, nativeCode: false },
    summary: {
      total: devices.length,
      pass: devices.filter((item) => item.status === "pass").length,
      warning: devices.filter((item) => item.status === "warning").length,
      fail: devices.filter((item) => item.status === "fail").length,
      compatible: devices.filter((item) => item.compatible).length,
      uniqueProfiles: profileMap.size,
      installed: devices.filter((item) => item.installed).length
    },
    profiles: [...profileMap.values()].sort((left, right) => right.count - left.count || left.profile.localeCompare(right.profile)),
    devices
  };
}

async function main() {
  const adbPath = option("--adb", process.env.ADB_PATH || "adb");
  const concurrency = Number(option("--concurrency", "8"));
  const result = await runFleetPreflight({ adbPath, concurrency: Number.isInteger(concurrency) ? concurrency : 8 });
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (result.summary.fail > 0) process.exitCode = 2;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`${text(error?.stack || error)}\n`);
    process.exitCode = 1;
  });
}
