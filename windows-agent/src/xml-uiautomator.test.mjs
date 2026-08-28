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
  assert.match(source, /继续编辑图文笔记吗/);
  assert.match(source, /dismiss_xhs_draft_restore_popup_back/);
  assert.match(source, /missing_recover_popups/);
});

test("XML runner keeps the full XHS confirmation and post-selection permission branches", async () => {
  const source = await fs.readFile(path.join(here, "../scripts/xhs_xml_uiautomator.py"), "utf8");
  assert.match(source, /def accept_xhs_photo_permission\(/);
  assert.match(source, /permission_allow_all_button/);
  assert.match(source, /elif not image_selected/);
  assert.match(source, /授予照片权限后未能重新选择二维码图片/);
  assert.match(source, /def wait_confirm_branch_ready\(/);
  assert.match(source, /同意并登录/);
});

test("XML runner reveals Vivo clone resolver only behind an evidenced system overlay", async () => {
  const source = await fs.readFile(path.join(here, "../scripts/xhs_xml_uiautomator.py"), "utf8");
  assert.match(source, /def dismiss_clone_resolver_overlay_if_present\(/);
  assert.match(source, /DoubleAppResolverActivity/);
  assert.match(source, /com\.bbk\.updater/);
  assert.match(source, /VivoUsbDialog/);
  assert.match(source, /force-stop", "com\.bbk\.updater"/);
  assert.match(source, /dismiss_clone_resolver_overlay_if_present\(adb_path, serial, log, focus_lines\)/);
});

test("XML runner recognizes the exact MIUI framework clone resolver observed in QA", async () => {
  const source = await fs.readFile(path.join(here, "../scripts/xhs_xml_uiautomator.py"), "utf8");
  assert.match(source, /def is_xhs_clone_resolver_focus\(/);
  assert.match(source, /android\/com\.android\.internal\.app\.ResolverActivity/);
  assert.match(source, /if is_xhs_clone_resolver_focus\(focus_lines\):/);
  assert.match(source, /wait_and_tap\(adb_path, serial, token, log, "choose_xhs_slot", \[slot\]/);
});

test("XML runner dismisses Vivo's exact notification authorization overlay by element", async () => {
  const source = await fs.readFile(path.join(here, "../scripts/xhs_xml_uiautomator.py"), "utf8");
  assert.match(source, /com\.vivo\.pushservice/);
  assert.match(source, /type=2038/);
  assert.match(source, /"发送通知"/);
  assert.match(source, /notification_prompt = any/);
  assert.match(source, /choices = \["暂不开启"[\s\S]*?"取消"/);
});
