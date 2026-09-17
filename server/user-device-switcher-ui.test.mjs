import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const serverDir = path.dirname(fileURLToPath(import.meta.url));
const projectDir = path.dirname(serverDir);
const html = fs.readFileSync(path.join(projectDir, "public", "index.html"), "utf8");
const app = fs.readFileSync(path.join(projectDir, "public", "app.js"), "utf8");
const styles = fs.readFileSync(path.join(projectDir, "public", "styles.css"), "utf8");

test("device detail exposes a searchable and accessible phone switcher", () => {
  assert.match(html, /id="userDeviceSwitcherButton"[^>]*aria-haspopup="dialog"[^>]*aria-controls="userDeviceSwitcherPanel"/);
  assert.match(html, /id="userDeviceSwitcherPanel"[^>]*role="dialog"[^>]*hidden/);
  assert.match(html, /id="userDeviceSwitcherSearch"[^>]*type="search"/);
  assert.match(html, /搜索编号 \/ 型号 \/ 手机号 \/ 账号/);
  assert.match(html, /id="userDeviceSwitcherList"[^>]*role="listbox"/);
});

test("switcher reuses the stable inventory and sorts number-like names naturally", () => {
  assert.match(app, /new Intl\.Collator\("zh-CN", \{\s*numeric: true/);
  assert.match(app, /state\.userDevices\s*\.filter\(\(device\) => !query \|\| userDeviceSearchText\(device\)\.includes\(query\)\)/);
  assert.match(app, /compareUserDeviceSwitcherOptions\(left, right, query\)/);
  assert.match(app, /userDeviceSwitcherStatus\(device\)/);
  assert.match(app, /data-user-device-switch-id=/);
});

test("choosing another phone follows the existing safe detail transition", () => {
  const openDetailStart = app.indexOf("async function openUserDeviceDetail(deviceId)");
  const openDetail = app.slice(openDetailStart, app.indexOf("window.__openUserDeviceDetail", openDetailStart));
  assert.match(openDetail, /state\.userScreenDeviceId !== deviceId\) await stopUserScreenSession\(\)/);
  assert.match(openDetail, /latestUserSmsRequestId\+\+/);
  assert.match(openDetail, /state\.userDeviceSmsMessages = \[\]/);
  assert.match(openDetail, /state\.userSelectedDeviceId = deviceId/);
  assert.match(openDetail, /await loadAll\(\)/);
  assert.match(app, /await openUserDeviceDetail\(deviceId\)/);
});

test("switcher closes without navigation and keeps its result list bounded", () => {
  assert.match(app, /document\.addEventListener\("pointerdown"/);
  assert.match(app, /event\.key !== "Escape"/);
  assert.match(app, /els\.userDeviceSwitcherButton\?\.focus\(\)/);
  assert.match(styles, /\.user-device-switcher-list\s*\{[^}]*max-height: min\(430px, 58vh\);[^}]*overflow-y: auto;/);
  assert.match(styles, /\.user-device-switch-option\.is-current/);
  assert.match(styles, /\.user-device-switcher-panel\[hidden\]\s*\{\s*display: none;/);
});
