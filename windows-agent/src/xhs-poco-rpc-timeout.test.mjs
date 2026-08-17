import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const source = fs.readFileSync(path.resolve(here, "../scripts/xhs_airtest_poco.py"), "utf8");

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
