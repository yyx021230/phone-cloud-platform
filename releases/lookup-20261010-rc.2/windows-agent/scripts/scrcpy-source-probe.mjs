import { writeFile } from "node:fs/promises";

import { AdbServerClient } from "@yume-chan/adb";
import { AdbScrcpyClient } from "@yume-chan/adb-scrcpy";
import { AdbServerNodeTcpConnector } from "@yume-chan/adb-server-node-tcp";

import { createScreenScrcpyOptions } from "../src/screen-stream.mjs";

const [serial = "", resultPath = "", durationArg = "115000", controlArg = ""] = process.argv.slice(2);
const durationMs = Math.max(5_000, Math.min(180_000, Number(durationArg) || 115_000));
const control = controlArg === "control";
const result = { serial, control, startedAt: new Date().toISOString(), durationMs, frames: 0, keyframes: 0, eof: false, error: "" };
let client;
let reader;

async function persist() {
  result.endedAt = new Date().toISOString();
  await writeFile(resultPath, `${JSON.stringify(result, null, 2)}\n`, "utf8");
}

try {
  if (!serial || !resultPath) throw new Error("usage: serial resultPath [durationMs]");
  const adbServer = new AdbServerClient(new AdbServerNodeTcpConnector({ host: "127.0.0.1", port: 5037 }));
  const adb = await adbServer.createAdb({ serial });
  const options = createScreenScrcpyOptions({
    sessionId: "1abcdef-probe",
    maxSize: 960,
    video: true,
    control,
    requestedOptions: { maxFps: 40, videoBitRate: 2_000_000 },
    config: { screenMaxFps: 40, screenVideoBitRate: 2_000_000, screenIFrameIntervalSeconds: 1, screenEncoderBitrateMode: 2 }
  });
  client = await AdbScrcpyClient.start(adb, "/data/local/tmp/phone-cloud-scrcpy-server-v3.3.4.jar", options);
  const video = await client.videoStream;
  reader = video.stream.getReader();
  const deadline = Date.now() + durationMs;
  while (Date.now() < deadline) {
    const timeout = Math.max(1, Math.min(1_000, deadline - Date.now()));
    const packet = await Promise.race([
      reader.read(),
      new Promise((resolve) => setTimeout(() => resolve(null), timeout))
    ]);
    if (!packet) continue;
    if (packet.done) {
      result.eof = true;
      break;
    }
    if (packet.value?.type === "data") {
      result.frames += 1;
      if (packet.value.keyframe) result.keyframes += 1;
    }
  }
} catch (error) {
  result.error = error?.stack || error?.message || String(error);
} finally {
  try { await reader?.cancel(); } catch {}
  try { await client?.close(); } catch {}
  await persist().catch(() => {});
}
