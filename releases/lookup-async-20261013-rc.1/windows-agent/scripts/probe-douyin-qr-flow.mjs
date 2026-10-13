import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";

// Experimental probe only. Douyin QR automation is not part of the current
// production workflow; keep this script out of user-facing task dispatch.
const serial = argValue("--serial") || process.env.ADB_SERIAL || "10HFB8FE4A000R3";
const qrPath = argValue("--qr") || "";
const adbPath = argValue("--adb") || process.env.ADB_PATH || "adb";
const screenshotDir = argValue("--screenshots") || path.resolve("/private/tmp");
const albumIndex = Number(argValue("--album-index") || "0");
const shouldConfirmLogin = process.argv.includes("--confirm-login");
const qrExt = path.extname(qrPath).replace(/^\./, "").toLowerCase() || "png";
const qrRunId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const remoteQrPath = `/sdcard/Pictures/PhoneCloud/douyin_qr_${qrRunId}.${qrExt}`;
const douyinPackage = "com.ss.android.ugc.aweme";

if (!qrPath) {
  throw new Error("Usage: node scripts/probe-douyin-qr-flow.mjs --serial <adbSerial> --qr <localQrImage>");
}

await fs.access(qrPath);
await fs.mkdir(screenshotDir, { recursive: true });

await step("准备二维码图片", async () => {
  await adb(["shell", "mkdir", "-p", "/sdcard/Pictures/PhoneCloud"]);
  await adb(["push", qrPath, remoteQrPath], { timeoutMs: 60_000 });
  await adb(["shell", "am", "broadcast", "-a", "android.intent.action.MEDIA_SCANNER_SCAN_FILE", "-d", `file://${remoteQrPath}`]);
  console.log(JSON.stringify({ pushedQrImage: { localPath: qrPath, remotePath: remoteQrPath } }, null, 2));
  await delay(2000);
});

await step("冷启动抖音", async () => {
  await adb(["shell", "am", "force-stop", douyinPackage]);
  await adb(["shell", "monkey", "-p", douyinPackage, "-c", "android.intent.category.LAUNCHER", "1"]);
  await delay(5000);
  await assertCurrentPackage(douyinPackage);
});

await step("进入我的页面", async () => {
  await tapText("我", { timeoutMs: 20_000 });
  await waitForText("添加朋友", { timeoutMs: 20_000, allowDumpFailure: false });
});

await step("打开右上菜单", async () => {
  await tapText("更多", { timeoutMs: 10_000 });
  await waitForText("扫一扫", { timeoutMs: 10_000 });
});

await step("进入扫一扫", async () => {
  await tapText("扫一扫", { timeoutMs: 10_000 });
  await waitForActivity(/ScanNewActivity|scan/i, { timeoutMs: 15_000 });
});

await step("打开相册", async () => {
  await tapText("相册", { timeoutMs: 10_000 });
  await waitForText("所有照片", { timeoutMs: 15_000 });
  await waitForAlbumImages({ timeoutMs: 15_000 });
  await screenshot("douyin-album-before-select.png");
});

await step(`选择相册第 ${albumIndex + 1} 张二维码`, async () => {
  const images = await waitForAlbumImages({ timeoutMs: 15_000 });
  const image = images[albumIndex];
  if (!image) throw new Error(`相册只有 ${images.length} 张可选图片，无法选择第 ${albumIndex + 1} 张`);
  console.log(JSON.stringify({
    selectedAlbumImage: {
      index: albumIndex,
      bounds: [image.left, image.top, image.right, image.bottom],
      center: [image.x, image.y]
    },
    albumImageCount: images.length
  }, null, 2));
  await tap(image.x, image.y);
  await waitForLoginConfirm({ timeoutMs: 35_000 });
  await screenshot("douyin-login-confirm.png");
  const focus = await focusedWindow();
  console.log(JSON.stringify({ loginConfirmFocus: focus }, null, 2));
});

await step("确认登录页处理", async () => {
  if (!shouldConfirmLogin) {
    console.log("[skip] 已到达确认登录页；传入 --confirm-login 才会点击确认登录");
    return;
  }
  await tapText("确认登录", { timeoutMs: 15_000 });
  await delay(4000);
  await screenshot("douyin-after-confirm-login.png");
  const focus = await focusedWindow();
  console.log(JSON.stringify({ afterConfirmFocus: focus }, null, 2));
});

console.log("Douyin QR probe finished");

function argValue(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : "";
}

async function step(label, fn) {
  console.log(`\n[step] ${label}`);
  await fn();
  console.log(`[ok] ${label}`);
}

async function adb(args, options = {}) {
  return run(adbPath, ["-s", serial, ...args], options);
}

async function run(command, args, options = {}) {
  const timeoutMs = options.timeoutMs || 30_000;
  return new Promise((resolve, reject) => {
    const child = execFile(command, args, {
      timeout: timeoutMs,
      maxBuffer: 20 * 1024 * 1024,
      encoding: options.binary ? "buffer" : "utf8"
    }, (error, stdout, stderr) => {
      if (error) {
        const message = [error.message, stdout, stderr].filter(Boolean).join("\n");
        reject(new Error(message));
        return;
      }
      if (options.binary) {
        resolve(stdout);
        return;
      }
      resolve(String(stdout || stderr || ""));
    });
    child.stdin?.end();
  });
}

async function tap(x, y) {
  await adb(["shell", "input", "tap", String(Math.round(x)), String(Math.round(y))]);
  await delay(800);
}

async function dumpXml() {
  const remotePath = "/sdcard/phone_cloud_douyin_probe.xml";
  await adb(["shell", "uiautomator", "dump", "--compressed", remotePath], { timeoutMs: 10_000 });
  return adb(["shell", "cat", remotePath], { timeoutMs: 10_000 });
}

async function waitForText(text, options = {}) {
  const bounds = await waitForTextBounds(text, options);
  return Boolean(bounds || options.allowNoBounds);
}

async function tapText(text, options = {}) {
  const bounds = await waitForTextBounds(text, options);
  if (!bounds) throw new Error(`元素存在但没有可点击 bounds：${text}`);
  await tap(bounds.x, bounds.y);
  return bounds;
}

async function waitForTextBounds(text, options = {}) {
  const timeoutMs = options.timeoutMs || 10_000;
  const deadline = Date.now() + timeoutMs;
  let lastError = "";
  while (Date.now() <= deadline) {
    try {
      const xml = await dumpXml();
      const bounds = findUiTextBounds(xml, text);
      if (bounds) return bounds;
      if (xml.includes(`text="${text}"`) || xml.includes(`content-desc="${text}"`) || xml.includes(text)) return null;
      lastError = summarizeXml(xml);
    } catch (error) {
      lastError = error.message;
      if (options.allowDumpFailure === false) await delay(1000);
    }
    await delay(1000);
  }
  if (options.optional) return null;
  await screenshot(`douyin-missing-${safeName(text)}.png`);
  throw new Error(`未找到元素：${text}; last=${lastError.slice(0, 500)}`);
}

async function waitForActivity(pattern, options = {}) {
  const timeoutMs = options.timeoutMs || 10_000;
  const deadline = Date.now() + timeoutMs;
  let last = "";
  while (Date.now() <= deadline) {
    last = await focusedWindow();
    if (pattern.test(last)) return true;
    await delay(1000);
  }
  await screenshot("douyin-activity-timeout.png");
  throw new Error(`未进入目标 Activity: ${pattern}; last=${last}`);
}

async function waitForLoginConfirm(options = {}) {
  const timeoutMs = options.timeoutMs || 20_000;
  const deadline = Date.now() + timeoutMs;
  let lastSummary = "";
  let lastFocus = "";
  while (Date.now() <= deadline) {
    const xml = await dumpXml().catch((error) => {
      lastSummary = error.message;
      return "";
    });
    const confirm = findUiTextBounds(xml, "确认登录");
    if (confirm) return confirm;
    lastSummary = summarizeXml(xml);
    lastFocus = await focusedWindow().catch((error) => error.message);
    await delay(1000);
  }
  await screenshot("douyin-login-confirm-timeout.png");
  throw new Error(`未进入抖音网页登录确认页；focus=${lastFocus}; last=${lastSummary.slice(0, 700)}`);
}

async function assertCurrentPackage(packageName) {
  const focus = await focusedWindow();
  if (!focus.includes(packageName)) throw new Error(`当前不在抖音：${focus}`);
}

async function focusedWindow() {
  return adb(["shell", "dumpsys", "window"], { timeoutMs: 10_000 }).then((output) => {
    return (output.match(/mCurrentFocus=.*|mFocusedApp=.*/g) || []).slice(0, 4).join("\n");
  });
}

async function screenshot(name) {
  const target = path.join(screenshotDir, name);
  const bytes = await run(adbPath, ["-s", serial, "exec-out", "screencap", "-p"], { timeoutMs: 20_000, binary: true });
  await fs.writeFile(target, bytes);
  console.log(`[screenshot] ${target}`);
}

async function waitForAlbumImages(options = {}) {
  const timeoutMs = options.timeoutMs || 10_000;
  const deadline = Date.now() + timeoutMs;
  let lastSummary = "";
  while (Date.now() <= deadline) {
    const xml = await dumpXml();
    const images = findAlbumImageCandidates(xml);
    if (images.length) {
      await fs.writeFile(path.join(screenshotDir, "douyin-album.xml"), xml);
      console.log(JSON.stringify({
        albumImageCount: images.length,
        albumImages: images.slice(0, 8).map((image, index) => ({
          index,
          bounds: [image.left, image.top, image.right, image.bottom],
          center: [image.x, image.y]
        }))
      }, null, 2));
      return images;
    }
    lastSummary = summarizeXml(xml);
    await delay(1000);
  }
  await screenshot("douyin-album-no-image.png");
  throw new Error(`相册已打开但没有找到可点图片元素；last=${lastSummary.slice(0, 700)}`);
}

function findUiTextBounds(xml, text) {
  const pattern = new RegExp(`\\b(?:text|content-desc)="${escapeRegExp(text)}"[^>]*\\bbounds="\\[(\\d+),(\\d+)\\]\\[(\\d+),(\\d+)\\]"`);
  const match = String(xml || "").match(pattern);
  if (!match) return null;
  const [, left, top, right, bottom] = match.map(Number);
  return { x: Math.round((left + right) / 2), y: Math.round((top + bottom) / 2) };
}

function findAlbumImageCandidates(xml) {
  if (!String(xml || "").includes("所有照片")) return [];
  return parseUiNodes(xml)
    .filter((node) => {
      const width = node.right - node.left;
      const height = node.bottom - node.top;
      const aspectRatio = width / Math.max(height, 1);
      if (!node.clickable) return false;
      if (!node.resourceId.endsWith(":id/root_view")) return false;
      if (node.top < 220 || width < 100 || height < 100) return false;
      if (width > 320 || height > 320) return false;
      if (aspectRatio < 0.75 || aspectRatio > 1.35) return false;
      if (/添加|设置|允许|所有照片|照片更便捷/.test(`${node.text} ${node.contentDesc}`)) return false;
      return true;
    })
    .sort((a, b) => (a.top - b.top) || (a.left - b.left))
    .map((node) => ({
      ...node,
      x: Math.round((node.left + node.right) / 2),
      y: Math.round((node.top + node.bottom) / 2)
    }));
}

function parseUiNodes(xml) {
  return [...String(xml || "").matchAll(/<node\b[^>]*>/g)]
    .map((match) => {
      const tag = match[0];
      const bounds = tag.match(/\bbounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/);
      if (!bounds) return null;
      return {
        tag,
        text: attr(tag, "text"),
        contentDesc: attr(tag, "content-desc"),
        className: attr(tag, "class"),
        resourceId: attr(tag, "resource-id"),
        clickable: attr(tag, "clickable") === "true",
        left: Number(bounds[1]),
        top: Number(bounds[2]),
        right: Number(bounds[3]),
        bottom: Number(bounds[4])
      };
    })
    .filter(Boolean);
}

function attr(tag, name) {
  const match = String(tag || "").match(new RegExp(`\\b${escapeRegExp(name)}="([^"]*)"`));
  return match ? match[1] : "";
}

function summarizeXml(xml) {
  return [...String(xml || "").matchAll(/\b(?:text|content-desc)="([^"]{1,80})"/g)]
    .map((match) => match[1])
    .filter(Boolean)
    .slice(0, 20)
    .join(" | ");
}

function safeName(value) {
  return String(value || "unknown").replace(/[^\w.-]+/g, "_").slice(0, 60);
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
