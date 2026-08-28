import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const source = fs.readFileSync(path.resolve(here, "../scripts/xhs_airtest_poco.py"), "utf8");
const agentSource = fs.readFileSync(path.resolve(here, "index.mjs"), "utf8");

test("Poco selector RPCs have a bounded per-call timeout", () => {
  assert.match(source, /PHONE_CLOUD_POCO_RPC_TIMEOUT_SECONDS/);
  assert.match(source, /client\.set_timeout\(timeout_seconds\)/);
  assert.match(source, /max\(0\.5, min\(timeout_seconds, 5\.0\)\)/);
});

test("hierarchy-wide element scans use one frozen snapshot", () => {
  const albumFunction = source.match(/def click_first_album_image[\s\S]*?\ndef accept_xhs_photo_permission/)?.[0] || "";
  const textFunction = source.match(/def list_texts[\s\S]*?\ndef poco_ui_snapshot/)?.[0] || "";
  assert.match(albumFunction, /poco\.freeze\(\)\(type="android\.widget\.ImageView"\)/);
  assert.match(textFunction, /poco\.freeze\(\)\(type="android\.widget\.TextView"\)/);
});

test("resolved Poco elements never fall back to an unbounded RPC click", () => {
  const tapNode = source.match(/def tap_node\(node, post_wait=0\.5\):[\s\S]*?\n\ndef focus/)?.[0] || "";
  assert.match(tapNode, /run_adb\([\s\S]*?timeout=5\)/);
  assert.match(tapNode, /return\n    node\.click\(\)/);
  assert.doesNotMatch(tapNode, /except Exception:\n\s+pass[\s\S]*?node\.click\(\)/);
});

test("post-selection confirmation uses bounded XML instead of Poco freeze", () => {
  assert.match(source, /def dump_confirm_xml\(/);
  assert.match(source, /uiautomator", "dump"/);
  assert.match(source, /"\/dev\/tty"/);
  assert.match(source, /timeout=8/);
  const waitBlock = source.match(/def wait_confirm\([\s\S]*?\n\ndef click_confirm_button/)?.[0] || "";
  assert.match(waitBlock, /dump_confirm_xml/);
  assert.doesNotMatch(waitBlock, /list_texts\(poco/);
  assert.match(source, /decoded\.find\("<hierarchy"\)/);
  assert.match(source, /decoded\.rfind\("<\/hierarchy>"\)/);
  assert.match(source, /def release_poco_for_confirm_xml/);
  assert.match(source, /"com\.netease\.open\.pocoservice\.test"/);
  assert.match(source, /release_poco_for_confirm_xml\(adb_path, serial, log\)/);
  assert.match(source, /def click_first_album_image_xml/);
  assert.match(source, /click_album_first_thumbnail_xml/);
  assert.match(source, /accept_xhs_photo_permission_xml/);
  const clickBlock = source.match(/def click_confirm\([\s\S]*?\n\ndef run_preflight/)?.[0] || "";
  assert.match(clickBlock, /tap_xml_label/);
  const failureBlock = source.match(/except Exception as exc:\n        ui_snapshot[\s\S]*?emit\(log, "error"/)?.[0] || "";
  assert.match(failureBlock, /dump_confirm_xml/);
  assert.doesNotMatch(failureBlock, /poco_ui_snapshot/);
});

test("scanner album recovery handles the exact Android permission activity through XML", () => {
  assert.match(source, /def system_media_permission_prompt_present\(/);
  assert.match(source, /GrantPermissionsActivity/);
  assert.match(source, /def click_album_entry_xml\(/);
  assert.match(source, /resource_id\.endswith\(":id\/llMyPhoto"\)/);
  assert.match(source, /album_permission_prompt_detected/);
  assert.match(source, /accept_xhs_photo_permission_xml/);
  assert.match(source, /permission_allow_all_button/);
  assert.match(source, /album_permission_prompt_detected_after_open/);
  assert.match(source, /elif not image_selected/);
  assert.match(source, /permission_allow_foreground_only_button/);
  assert.match(source, /使用应用时允许/);
  assert.match(source, /授予照片权限后仍未找到扫码页“相册”入口/);
});

test("scanner recovery safely dismisses Vivo's exact notification overlay", () => {
  assert.match(source, /com\.vivo\.pushservice/);
  assert.match(source, /type=2038/);
  assert.match(source, /"发送通知"/);
  assert.match(source, /dismiss_notification_prompt_safely/);
});

test("clone resolver compatibility is bounded to proven system surfaces", () => {
  assert.match(source, /def dismiss_known_resolver_system_overlay\(/);
  assert.match(source, /"com\.bbk\.updater" in joined/);
  assert.match(source, /"com\.oplus\.ota" in joined/);
  assert.match(source, /"VivoUsbDialog" in joined/);
  assert.match(source, /package_from_focus\(lines\) != "com\.android\.intentresolver"/);
  assert.match(source, /overlay_package = "com\.bbk\.updater"/);
  assert.match(source, /overlay_package = "com\.oplus\.ota"/);
  assert.match(source, /"am", "force-stop", overlay_package/);
  assert.match(source, /choose_slot_system_overlay_still_present/);
  assert.match(source, /choose_slot_vendor_resolver_defer_to_xml/);
  assert.match(source, /com\.android\.intentresolver\.ChooserActivityLauncher/);
  assert.match(source, /com\.android\.intentresolver\/\.ChooserActivityLauncher/);
  assert.match(source, /com\.android\.intentresolver\/\.DoubleAppResolverActivity/);
  assert.match(source, /any\("VivoUsbDialog" in line for line in lines\)/);
  assert.match(source, /def click_xhs_slot_xml\(/);
  assert.match(source, /release_poco_for_confirm_xml\(adb_path, serial, log\)[\s\S]*?click_xhs_slot_xml/);
  assert.match(source, /poco_recreated_after_clone_slot_xml/);
  assert.match(source, /post_slot_keyguard_detected/);
  assert.match(source, /poco_recreated_after_post_slot_unlock/);
});

test("missing scan entry closes the evidenced profile-search surface by element", () => {
  const helper = source.match(/def dismiss_profile_search_overlay_if_present[\s\S]*?\n\ndef ensure_xhs_session_available/)?.[0] || "";
  assert.match(helper, /搜索我的笔记\/收藏\/赞过/);
  assert.match(helper, /poco\(text="取消"\)/);
  const waitBlock = source.match(/def click_scan_entry_wait[\s\S]*?\n\ndef click_album_entry/)?.[0] || "";
  assert.match(waitBlock, /dismiss_profile_search_overlay_if_present/);
  assert.match(waitBlock, /wait_scan_entry_after_profile_search/);
});

test("vendor XML clone resolution keeps scanner lookup bounded and element based", () => {
  const helper = source.match(/def click_scan_entry_xml[\s\S]*?\n\ndef click_xhs_slot_xml/)?.[0] || "";
  assert.match(helper, /text != "扫一扫" and desc != "扫一扫"/);
  assert.match(helper, /dump_confirm_xml/);
  assert.match(helper, /dismiss_profile_search_cancel_xml/);
  assert.doesNotMatch(helper, /input", "tap", "\d+/);
  assert.match(source, /if slot_selected_via_xml:[\s\S]*?release_poco_for_confirm_xml[\s\S]*?click_scan_entry_xml/);
  assert.match(source, /if scan_entry_via_xml:[\s\S]*?click_album_entry_xml/);
});

test("profile navigation checks its target before expensive focus recovery", () => {
  const meBlock = source.match(/def click_me_entry[\s\S]*?\n\ndef click_scan_entry_wait/)?.[0] || "";
  assert.ok(meBlock.indexOf("click_labeled_element_in_region") < meBlock.indexOf("current_focus ="));
  assert.match(meBlock, /back_from_stale_album_before_me/);
  assert.match(meBlock, /dismiss_xhs_draft_restore_popup_if_present/);
});

test("evidenced XHS business popups use bounded Back recovery in Poco and XML paths", () => {
  const draftHelper = source.match(/def dismiss_xhs_draft_restore_popup_if_present[\s\S]*?\n\ndef dismiss_vivo_proximity_overlay_if_present/)?.[0] || "";
  assert.match(draftHelper, /继续编辑图文笔记吗/);
  assert.match(draftHelper, /存草稿/);
  assert.match(draftHelper, /去编辑/);
  assert.match(draftHelper, /keyevent", "4"/);
  const xmlHelper = source.match(/def click_scan_entry_xml[\s\S]*?\n\ndef click_xhs_slot_xml/)?.[0] || "";
  assert.match(xmlHelper, /赞和收藏/);
  assert.match(xmlHelper, /继续编辑图文笔记吗/);
  assert.match(xmlHelper, /dismiss_xhs_business_popup_back_xml/);
  assert.match(xmlHelper, /keyevent", "4"/);
});

test("unfinished draft recovery covers every Poco scanner navigation boundary", () => {
  const scanBlock = source.match(/def click_scan_entry_wait[\s\S]*?\n\ndef click_album_entry/)?.[0] || "";
  const albumBlock = source.match(/def click_album_entry[\s\S]*?\n\ndef list_texts/)?.[0] || "";
  assert.match(scanBlock, /dismiss_xhs_draft_restore_popup_if_present/);
  assert.match(scanBlock, /wait_scan_entry_after_draft_restore/);
  assert.ok(
    scanBlock.indexOf("dismiss_xhs_draft_restore_popup_if_present") < scanBlock.indexOf("clear_popups_rounds"),
    "draft business sheet must be handled before the generic popup sweep"
  );
  assert.match(albumBlock, /dismiss_xhs_draft_restore_popup_if_present/);
  assert.match(albumBlock, /wait_album_entry_after_draft_restore/);
  assert.ok(
    albumBlock.indexOf("dismiss_xhs_draft_restore_popup_if_present") < albumBlock.indexOf("clear_popups_rounds"),
    "album recovery must preserve the Back-only draft policy"
  );
});

test("slow Android PackageManager is not mislabeled as XHS missing", () => {
  const block = agentSource.match(/async function isPackageInstalled[\s\S]*?\n}\n\nasync function prepareAdbInstallPolicy/)?.[0] || "";
  assert.match(block, /timeoutMs: 25_000/);
  assert.match(block, /"cmd", "package", "path"/);
  assert.match(block, /package_manager_unresponsive/);
  assert.doesNotMatch(block, /catch\(\(\) => ""\)/);
});
