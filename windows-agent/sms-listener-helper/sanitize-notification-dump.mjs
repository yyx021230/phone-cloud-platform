import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";

let input = "";
if (process.argv[2] === "--adb") {
  const adbPath = process.argv[3];
  const serial = process.argv[4];
  if (!adbPath || !serial) throw new Error("usage: --adb <adb-path> <serial>");
  const result = spawnSync(
    adbPath,
    ["-s", serial, "shell", "dumpsys", "notification", "--noredact"],
    { encoding: "utf8", maxBuffer: 16 * 1024 * 1024, windowsHide: true },
  );
  if (result.status !== 0) {
    throw new Error(`notification_dump_failed:${result.status ?? "spawn"}`);
  }
  input = result.stdout;
} else {
  for await (const chunk of process.stdin) input += chunk;
}

const starts = [...input.matchAll(/^\s*NotificationRecord\(/gm)].map((match) => match.index);
const records = [];
for (let index = 0; index < starts.length; index += 1) {
  const block = input.slice(starts[index], starts[index + 1] ?? input.length);
  if (!/\bpkg=com\.android\.mms\b/.test(block)) continue;

  const hashValue = (value) =>
    createHash("sha256").update(value, "utf8").digest("hex").slice(0, 24);
  const metadata = [];
  const privateKeys = new Set();
  const lines = block.split(/\r?\n/);

  for (const line of lines) {
    const keyMatch = line.match(/^\s*(android\.[\w.]+)\s*=/);
    if (keyMatch) privateKeys.add(keyMatch[1]);

    const textMatch = line.match(
      /^\s*(android\.(?:text|bigText|title|subText|summaryText|infoText))\s*=\s*(?:String\s*)?\((.*)\)\s*$/,
    );
    if (!textMatch) continue;
    const value = textMatch[2];
    metadata.push({
      key: textMatch[1],
      length: [...value].length,
      sha256: hashValue(value),
      hasVerificationCodeShape: /(?<!\d)\d{4,8}(?!\d)/.test(value),
    });
  }

  records.push({
    packageName: "com.android.mms",
    notificationKey: block.match(/\bkey=([^:\s]+(?:\|[^:\s]+)*)/)?.[1] ?? null,
    creationTimeMs: Number(block.match(/\bmCreationTimeMs=(\d+)/)?.[1] ?? 0),
    updateTimeMs: Number(block.match(/\bmUpdateTimeMs=(\d+)/)?.[1] ?? 0),
    hasCopyVerificationCodeAction: block.includes("复制验证码"),
    privateExtraKeys: [...privateKeys].sort(),
    textMetadata: metadata,
  });
}

process.stdout.write(`${JSON.stringify({ records }, null, 2)}\n`);
