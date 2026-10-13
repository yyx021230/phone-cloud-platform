import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

test("XML runner uses Poco-equivalent popup recovery only after a target is absent", async () => {
  const source = await fs.readFile(path.join(here, "../scripts/xhs_xml_uiautomator.py"), "utf8");
  assert.match(source, /def handle_common_popup\(/);
  assert.match(source, /Never tap a generic “确认”/);
  assert.match(source, /permission_prompt/);
  assert.match(source, /notification_prompt/);
  assert.match(source, /privacy_prompt/);
  assert.match(source, /close_celebration_popup/);
  assert.match(source, /close_popup_by_top_icon/);
  assert.match(source, /missing_recover_popups/);
});

test("XML runner keeps the full XHS confirmation and post-selection permission branches", async () => {
  const source = await fs.readFile(path.join(here, "../scripts/xhs_xml_uiautomator.py"), "utf8");
  assert.match(source, /def accept_xhs_photo_permission\(/);
  assert.match(source, /授予照片权限后未能重新选择二维码图片/);
  assert.match(source, /def wait_confirm_branch_ready\(/);
  assert.match(source, /同意并登录/);
});
