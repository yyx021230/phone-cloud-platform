import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const html = fs.readFileSync(path.join(root, "public", "index.html"), "utf8");
const app = fs.readFileSync(path.join(root, "public", "app.js"), "utf8");
const styles = fs.readFileSync(path.join(root, "public", "styles.css"), "utf8");

test("Windows management includes a read-only recovery operations console", () => {
  assert.match(html, /id="windowsRecoveryConsole"/);
  assert.match(app, /function renderWindowsRecoveryConsole\(/);
  assert.match(app, /USB · ADB 恢复控制台/);
  assert.match(app, /逐设备恢复队列/);
  assert.match(app, /恢复事件记录/);
  assert.match(app, /data-recovery-countdown/);
  assert.match(app, /自动处理：精确 ADB reconnect \/ 单设备 PnP 重启/);
  assert.doesNotMatch(app, /data-recovery-action="(?:restart|remove|reset-hub|kill-adb)"/);
});

test("recovery console renders bounded-attempt and safety-state affordances", () => {
  assert.match(app, /recoveryAttemptClass/);
  assert.match(app, /达到单设备自动尝试上限/);
  assert.match(app, /Windows 设备安装器正在工作/);
  assert.match(app, /请在手机确认 USB 调试/);
  assert.match(styles, /\.recovery-attempt-rail/);
  assert.match(styles, /\.recovery-flight-recorder/);
  assert.match(styles, /prefers-reduced-motion/);
});

test("Windows management can be opened as a direct page link", () => {
  assert.match(app, /new URLSearchParams\(window\.location\.search\)\.get\("page"\)/);
});
