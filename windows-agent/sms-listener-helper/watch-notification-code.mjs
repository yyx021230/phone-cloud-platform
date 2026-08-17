import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { appendFileSync } from "node:fs";

const adbPath = process.argv[2];
const serial = process.argv[3];
const requestedTimeoutMs = Number(process.argv[4] ?? 90_000);
const eventLogPath = process.argv[5] || null;
const persistent = requestedTimeoutMs === 0;
const timeoutMs = persistent
  ? Number.POSITIVE_INFINITY
  : Math.min(Math.max(requestedTimeoutMs, 5_000), 120_000);
const pollMs = 1_000;

if (!adbPath || !serial) {
  process.stderr.write("usage: node watch-notification-code.mjs <adb-path> <serial> [timeout-ms]\n");
  process.exit(2);
}

const emit = (event) => {
  const line = `${JSON.stringify(event)}\n`;
  if (eventLogPath) appendFileSync(eventLogPath, line, { encoding: "utf8" });
  else process.stdout.write(line);
};

const hash = (value, length = 24) =>
  createHash("sha256").update(value, "utf8").digest("hex").slice(0, length);

function readMmsNotifications() {
  const result = spawnSync(
    adbPath,
    ["-s", serial, "shell", "dumpsys", "notification", "--noredact", "--package", "com.android.mms"],
    { encoding: "utf8", maxBuffer: 16 * 1024 * 1024, windowsHide: true, timeout: 15_000 },
  );
  if (result.status !== 0) throw new Error(`notification_dump_failed:${result.status ?? "spawn"}`);

  const input = result.stdout;
  const starts = [...input.matchAll(/^\s*NotificationRecord\(/gm)].map((match) => match.index);
  const records = [];
  for (let index = 0; index < starts.length; index += 1) {
    const block = input.slice(starts[index], starts[index + 1] ?? input.length);
    if (!/\bpkg=com\.android\.mms\b/.test(block)) continue;

    const text = block.match(/^\s*android\.text\s*=\s*(?:String\s*)?\((.*)\)\s*$/m)?.[1] ?? "";
    const bigText = block.match(/^\s*android\.bigText\s*=\s*(?:String\s*)?\((.*)\)\s*$/m)?.[1] ?? "";
    const body = bigText || text;
    const codes = [...new Set(body.match(/(?<!\d)\d{4,8}(?!\d)/g) ?? [])];
    const codeMetadata = codes.map((code) => ({
      length: code.length,
      sha256: hash(code),
    }));

    records.push({
      creationTimeMs: Number(block.match(/\bmCreationTimeMs=(\d+)/)?.[1] ?? 0),
      updateTimeMs: Number(block.match(/\bmUpdateTimeMs=(\d+)/)?.[1] ?? 0),
      hasCopyVerificationCodeAction: block.includes("复制验证码"),
      bodyLength: [...body].length,
      bodySha256: hash(body),
      codes: codeMetadata,
      fingerprint: hash(`${body}\n${block.match(/\bmUpdateTimeMs=(\d+)/)?.[1] ?? "0"}`, 32),
    });
  }
  return records;
}

const baseline = new Set(readMmsNotifications().map((record) => record.fingerprint));
emit({
  event: "ready",
  baselineRecords: baseline.size,
  persistent,
  timeoutMs: persistent ? null : timeoutMs,
  processId: process.pid,
});

const startedAt = Date.now();
let consecutiveErrors = 0;
while (persistent || Date.now() - startedAt < timeoutMs) {
  await new Promise((resolve) => setTimeout(resolve, pollMs));
  try {
    const records = readMmsNotifications();
    consecutiveErrors = 0;
    const detected = records.find((record) => !baseline.has(record.fingerprint));
    if (!detected) continue;
    const { fingerprint, ...safeRecord } = detected;
    baseline.add(fingerprint);
    emit({
      event: "verification_notification_detected",
      detectedAtMs: Date.now(),
      ...safeRecord,
    });
    if (!persistent) process.exit(0);
  } catch {
    consecutiveErrors += 1;
    if (consecutiveErrors >= 5) {
      emit({ event: "failed", reason: "five_consecutive_reads_failed" });
      process.exit(1);
    }
  }
}

emit({ event: "timeout", waitedMs: Date.now() - startedAt });
process.exit(3);
