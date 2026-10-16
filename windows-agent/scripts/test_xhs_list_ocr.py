"""Image-reader provenance, ambiguity and safety checks using synthetic data."""
import base64
import copy
import importlib.util
import json
import subprocess
import tempfile
import unittest
from contextlib import ExitStack
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch

import cv2
import numpy as np
import xhs_list_ocr as ocr

spec = importlib.util.spec_from_file_location("xhs_data_sync_ocr_tests", Path(__file__).with_name("小红书数据同步.py"))
sync = importlib.util.module_from_spec(spec)
spec.loader.exec_module(sync)


def line(text, box):
    x, y, right, bottom = box
    return {"text": text, "words": [{"x": x, "y": y, "width": right-x, "height": bottom-y}]}


def result():
    return {"width": 1080, "height": 2400, "leadingClip": False, "scope": None,
            "headers": {"数据中心": (430, 120, 650, 170), "作品分析": (330, 200, 500, 250),
                        "全部笔记": (40, 300, 200, 350)}, "markers": {"到底了": (500, 1000, 580, 1030)},
            "cards": [{"date": "10-14", "title": "合成测试作品", "status": "笔记状态正常",
                       "counts": ["49", "0", "8"], "imageHint": "0123456789abcdef",
                       "titleBox": (300, 500, 900, 550), "dateBox": (50, 690, 200, 740),
                       "numberBoxes": [(340, 680, 430, 730), (500, 680, 600, 730), (700, 680, 800, 730)],
                       "box": (30, 500, 1079, 740)}]}


class OcrParsingTests(unittest.TestCase):
    def test_dates_require_two_processed_values_and_reject_disagreement(self):
        images = {"r0_date_"+v: {"language": "zh-Hans-CN", "lines": [{"text": t}]}
                  for v, t in zip(("color", "binary", "contrast"), ("10·14", "10-14", "garbled"))}
        self.assertEqual(ocr.equal_variants(images, "r0_date", ocr.date_text), "10-14")
        images["r0_date_contrast"]["lines"][0]["text"] = "10-13"
        with self.assertRaisesRegex(RuntimeError, "disagree"):
            ocr.equal_variants(images, "r0_date", ocr.date_text)
        images["r0_date_binary"]["lines"] = []
        images["r0_date_contrast"]["lines"] = []
        with self.assertRaisesRegex(RuntimeError, "two independently"):
            ocr.equal_variants(images, "r0_date", ocr.date_text)

    def test_missing_or_wrong_language_crop_is_not_a_zero(self):
        for raw in ("", "O", "-1", "1/2", "nan"):
            with self.subTest(raw=raw), self.assertRaises(RuntimeError):
                ocr.counter_text(raw)
        with self.assertRaises(RuntimeError):
            ocr.equal_variants({"r0_date_color": {"language": "en-US"}}, "r0_date", ocr.date_text)

    def test_dates_do_not_use_the_pixelated_variant_that_changed_six_to_five(self):
        images = {"r0_date_"+variant:{"language":"zh-Hans-CN","lines":[{"text":value}]}
                  for variant,value in (("color","09-16"),("binary","09-16"),("contrast","09-16"),("nearest","09-15"))}
        self.assertEqual(ocr.equal_variants(images,"r0_date",ocr.date_text),"09-16")
        images["r0_date_binary"]["lines"] = []
        images["r0_date_nearest"]["lines"][0]["text"] = "09-16"
        self.assertEqual(ocr.equal_variants(images,"r0_date",ocr.date_text),"09-16")
        images["r0_date_contrast"]["lines"] = []
        with self.assertRaisesRegex(RuntimeError,"two independently"):
            ocr.equal_variants(images,"r0_date",ocr.date_text)

    def test_positions_are_finite_positive_and_within_the_frame(self):
        for box in ((0, 0, 0, 10), (-1, 0, 5, 10), (0, 0, float("nan"), 10)):
            with self.subTest(box=box), self.assertRaises(RuntimeError):
                ocr.line_box(line("测试", box))

    def test_blank_numeral_ink_and_unknown_glyph_fail(self):
        frame = np.full((80, 180, 3), 255, np.uint8)
        with self.assertRaisesRegex(RuntimeError, "no proven numeral"):
            ocr.numeric_cell(frame, (0, 0, 180, 80))
        cv2.putText(frame, "X", (20, 50), cv2.FONT_HERSHEY_SIMPLEX, 1, (0, 0, 0), 2)
        with self.assertRaisesRegex(RuntimeError, "unproven or ambiguous"):
            ocr.numeric_cell(frame, (0, 0, 180, 80))

    def test_verified_digit_atlas_detects_49_without_turning_it_into_40(self):
        atlas = cv2.imread(str(Path(ocr.__file__).with_name("xhs_ocr_digits.png")), 0)
        gray = np.full((80, 120), 255, np.uint8)
        # Synthetic composition contains only numeral glyphs, no user screenshot.
        for digit, left in ((4, 10), (9, 50)):
            glyph = atlas[digit*48:(digit+1)*48, 0:32]
            ys, xs = np.where(glyph < 220)
            glyph = glyph[ys.min():ys.max()+1, xs.min():xs.max()+1]
            physical = cv2.resize(glyph, (round(glyph.shape[1]*33/glyph.shape[0]), 33), interpolation=cv2.INTER_AREA)
            gray[20:53, left:left+physical.shape[1]] = physical
        frame = cv2.cvtColor(gray, cv2.COLOR_GRAY2BGR)
        self.assertEqual(ocr.numeric_cell(frame, (0, 0, 120, 80)), "49")

    def test_numeral_atlas_identity_is_checked(self):
        with patch.object(ocr.hashlib, "sha256", return_value=SimpleNamespace(hexdigest=lambda: "wrong")):
            with self.assertRaisesRegex(RuntimeError, "atlas identity"):
                ocr.numeric_cell(np.full((80, 120, 3), 255, np.uint8), (0, 0, 120, 80))

    def test_wrong_tab_duplicate_header_and_overlay_fail(self):
        frame = np.full((2400, 1080, 3), 255, np.uint8)
        rows = [line(t, b) for t, b in result()["headers"].items()]
        full = {"width": 1080, "height": 2400, "language": "zh-Hans-CN", "lines": rows}
        with self.assertRaisesRegex(RuntimeError, "selected works"):
            ocr.prepare_frame(frame, full)
        frame[254:261, 330:500] = (40, 30, 240)
        for extra in (line("作品分析", (700, 200, 870, 250)), line("同意", (500, 1300, 600, 1340))):
            with self.subTest(extra=extra), self.assertRaises(RuntimeError):
                ocr.prepare_frame(frame, {**full, "lines": rows+[extra]})

    def test_post_title_cannot_supply_centered_footer_marker(self):
        frame = np.full((2400, 1080, 3), 255, np.uint8)
        frame[254:261, 330:500] = (40, 30, 240)
        rows = [line(t, b) for t, b in result()["headers"].items()]
        full = {"width": 1080, "height": 2400, "language": "zh-Hans-CN", "lines": rows+[line("到底了", (300, 500, 430, 545))]}
        with self.assertRaisesRegex(RuntimeError, "no proven complete"):
            ocr.prepare_frame(frame, full)
        full["lines"][-1] = line("到底了", (500, 1000, 580, 1030))
        self.assertEqual(set(ocr.prepare_frame(frame, full)["markers"]), {"到底了"})
        full["lines"][2]["text"] = "全 部 笔 记 。"
        self.assertIn("全部笔记", ocr.prepare_frame(frame, full)["headers"])

    def test_normalized_hierarchy_has_all_six_fields_and_no_default_counts(self):
        root = ocr.hierarchy_for_frame(result())
        item = ocr.cards_from_hierarchy(root)[0][1]
        self.assertEqual([item[k] for k in ("list_view_count", "list_like_count", "list_comment_count")], [49, 0, 8])
        row = next(n for n in root.iter("node") if n.get("data-ocr-card"))
        row.remove(row[-1])
        with self.assertRaisesRegex(RuntimeError, "incomplete"):
            ocr.cards_from_hierarchy(root)

    def test_duplicate_crop_identity_fails(self):
        with self.assertRaisesRegex(RuntimeError, "duplicated"):
            ocr.resolve_frame({"rows": []}, [{"id": "same"}, {"id": "same"}])

    def test_lower_confidence_count_requires_two_native_values_matching_both_glyph_reads(self):
        row = {"verifiedCounts":["49","0","0"],"weakCountFields":[0]}
        images = [{"id":"r0_"+field+"_"+variant,"language":"zh-Hans-CN","lines":[{"text":text}]}
                  for field,text in (("date","10-14"),("view","4949")) for variant in ("color","binary")]
        self.assertEqual(ocr.resolve_frame({"rows":[row]},images)["cards"][0]["counts"][0],"49")
        for image in images:
            if image["id"].startswith("r0_view"):image["lines"][0]["text"] = "40"
        with self.assertRaisesRegex(RuntimeError,"disagrees with both"):
            ocr.resolve_frame({"rows":[row]},images)
        with self.assertRaisesRegex(RuntimeError,"missing"):
            ocr.resolve_frame({"rows":[row]},images[:2])

    def test_native_single_digit_proof_unwraps_only_an_exact_repeated_value(self):
        row = {"verifiedCounts":["1","6","0"],"weakCountFields":[1]}
        images = [{"id":"r0_"+field+"_"+variant,"language":"zh-Hans-CN","lines":[{"text":text}]}
                  for field,text in (("date","10-14"),("like","6 6 6 6")) for variant in ("color","binary")]
        self.assertEqual(ocr.resolve_frame({"rows":[row]},images)["cards"][0]["counts"][1],"6")
        for image in images:
            if image["id"].startswith("r0_like"):image["lines"][0]["text"] = "88"
        with self.assertRaisesRegex(RuntimeError,"disagrees with both"):
            ocr.resolve_frame({"rows":[row]},images)

    def test_outside_window_date_is_a_boundary_without_reading_or_faking_counts(self):
        prepared = {"height":2400,"markers":{},"cards":[{"date":"09-14","dateBox":(100,700,200,750),"numberBoxes":[]} ]}
        with patch.object(ocr,"numeric_cell") as numeric:
            result = ocr.prepare_count_reading(None,prepared,lambda raw:False)
        numeric.assert_not_called()
        self.assertEqual(result["cards"][0]["counts"],[None,None,None])
        self.assertTrue(result["cards"][0]["boundaryOnly"])
        with patch.object(ocr,"numeric_cell",side_effect=RuntimeError("OCR numeral glyph is unproven or ambiguous")),self.assertRaises(RuntimeError):
            ocr.prepare_count_reading(None,{**prepared,"cards":[{**prepared["cards"][0],"numberBoxes":[(1,1,2,2)]}]},lambda raw:True)

    def test_displayed_unit_requires_native_agreement_and_decimal_conversion_is_exact(self):
        row = {"verifiedCounts":["2.4万","0","0"],"weakCountFields":[0]}
        images = [{"id":"r0_"+field+"_"+variant,"language":"zh-Hans-CN","lines":[{"text":text}]}
                  for field,text in (("date","10-14"),("view","2.4 万")) for variant in ("color","binary")]
        self.assertEqual(ocr.resolve_frame({"rows":[row]},images)["cards"][0]["counts"][0],"2.4万")
        changed = result();changed["cards"][0]["counts"][0] = "2.01万"
        item = ocr.cards_from_hierarchy(ocr.hierarchy_for_frame(changed))[0][1]
        self.assertEqual(item["list_view_count"],20100)
        self.assertTrue(item["_displayed_unit"])
        self.assertEqual(sync.count("2.01万"),20100)
        for image in images:
            if image["id"].startswith("r0_view"):image["lines"][0]["text"] = "24万"
        with self.assertRaisesRegex(RuntimeError,"disagrees with both"):
            ocr.resolve_frame({"rows":[row]},images)

    def test_bottom_card_hidden_by_navigation_is_deferred_without_an_end_claim(self):
        frame = np.full((2400,1080,3),255,np.uint8);frame[254:261,330:500] = (40,30,240)
        lines = [line(t,b) for t,b in result()["headers"].items()]
        lines += [line("首条测试",(300,500,800,550)),line("笔记状态正常",(300,600,700,640)),
                  line("底部测试",(300,2110,800,2150)),line("笔记状态正常",(300,2200,700,2240))]
        full = {"width":1080,"height":2400,"language":"zh-Hans-CN","lines":lines}
        icons = [(300,660,340,695),(420,660,460,695),(560,660,600,695)]
        with patch.object(ocr,"metric_icons",side_effect=[icons,RuntimeError("OCR metric icon is not proven: view")]), patch.object(ocr,"numeric_cell",return_value=("0",False)):
            prepared = ocr.prepare_frame(frame,full)
        self.assertEqual(len(prepared["rows"]),1)
        self.assertTrue(prepared["trailingClip"])
        self.assertFalse(prepared["markers"])
        full["lines"].append(line("到底了",(500,2300,580,2330)))
        with patch.object(ocr,"metric_icons",side_effect=[icons,RuntimeError("OCR metric icon is not proven: view")]), patch.object(ocr,"numeric_cell",return_value=("0",False)), self.assertRaises(RuntimeError):
            ocr.prepare_frame(frame,full)

    def test_bottom_date_without_two_readings_is_deferred_until_the_next_scroll(self):
        prepared = {"height":2400,"markers":{},"rows":[{"dateBox":(100,700,200,750),"verifiedCounts":["1","0","0"]},
                    {"dateBox":(100,2200,200,2250),"verifiedCounts":["2","0","0"]}]}
        images = [{"id":f"r{i}_date_{variant}","language":"zh-Hans-CN","lines":[{"text":"10-14"}] if i == 0 else []}
                  for i in (0,1) for variant in ("color","binary")]
        resolved = ocr.resolve_frame(prepared,images)
        self.assertEqual(len(resolved["cards"]),1)
        self.assertTrue(resolved["trailingClip"])
        prepared["markers"] = {"到底了":(500,2300,580,2330)}
        with self.assertRaisesRegex(RuntimeError,"date unproven"):
            ocr.resolve_frame(prepared,images)

    def test_date_ink_crop_removes_colored_cover_prices(self):
        frame = np.full((100,160,3),(90,80,120),np.uint8)
        frame[20:40,20:50] = (180,90,240)  # Colored price over the cover.
        frame[50:65,60:80] = (255,255,255) # White date ink.
        frame[85:90,:] = (255,255,255) # White cover footer, not a date glyph.
        with tempfile.TemporaryDirectory() as directory:
            ocr.crop_requests(frame,{"rows":[{"dateBox":(0,0,160,100)}]},directory)
            binary = cv2.imread(str(Path(directory)/"r0_date_binary.png"),0)
            self.assertEqual(int(binary[150,150]),255)
            self.assertEqual(int(binary[275,350]),0)
            self.assertEqual(int(binary[437,350]),255)

    def test_native_protocol_rejects_wrong_image_and_does_not_change_policy(self):
        payload = {"protocol": "windows_native_ocr_v1", "images": [{"id": "other"}]}
        with tempfile.TemporaryDirectory() as directory, patch.object(ocr.subprocess, "run", return_value=SimpleNamespace(returncode=0, stdout=json.dumps(payload).encode())) as run:
            with self.assertRaisesRegex(RuntimeError, "identities"):
                ocr.windows_ocr([{"id": "whole", "path": str(Path(directory)/"image.png")}], directory)
            args = run.call_args.args[0]
            self.assertNotIn("-ExecutionPolicy", args)
            command = base64.b64decode(args[-1]).decode("utf-16-le")
            self.assertNotIn("Set-ExecutionPolicy", command)

    def test_private_temporary_images_are_removed_after_failure(self):
        _, png = cv2.imencode(".png", np.full((900, 500, 3), 255, np.uint8))
        paths = []
        def failed(images, directory):
            paths.append(Path(directory))
            self.assertTrue(paths[-1].is_dir())
            raise RuntimeError("failed OCR")
        with patch.object(ocr, "windows_ocr", side_effect=failed), self.assertRaises(RuntimeError):
            ocr.read_works_image(png.tobytes())
        self.assertTrue(paths)
        self.assertTrue(all(not p.exists() for p in paths))


class ImageCaptureGuardTests(unittest.TestCase):
    current = "mCurrentFocus=Window{x u0 com.xingin.xhs/com.xingin.xywebview.activity.WebViewActivityV2}"

    def test_wrong_user_missing_slot_and_unknown_clone_never_capture(self):
        for events, current in (([], self.current), (["collection_slot_requested:app2", "clone_user_requested:999"], self.current),
                                (["collection_slot_requested:app2", "clone_user_requested:666"], self.current.replace("u0", "u666"))):
            with self.subTest(events=events), patch.object(sync.subprocess, "run") as run, self.assertRaises(RuntimeError):
                sync.image_navigation_capture("adb", "serial", lambda: None, events, current)
            run.assert_not_called()

    def test_occupancy_cancel_and_foreground_change_stop_before_capture(self):
        for guard, focus in ((Mock(side_effect=RuntimeError("occupied")), self.current), (lambda: None, "changed")):
            with patch.object(sync, "focus", return_value=focus), patch.object(sync.subprocess, "run") as run, self.assertRaises(RuntimeError):
                sync.image_navigation_capture("adb", "serial", guard, ["collection_slot_requested:app1"], self.current)
            run.assert_not_called()

    def capture(self, frames, events=None):
        events = ["collection_slot_requested:app1"] if events is None else events
        with patch.object(sync, "focus", return_value=self.current), patch.object(sync.subprocess, "run", return_value=SimpleNamespace(returncode=0, stdout=b"png")) as run, patch.object(ocr, "read_works_image", side_effect=frames):
            root = sync.image_navigation_capture("adb", "serial", lambda: None, events, self.current)
        self.assertEqual(run.call_count, 2)
        return root, events

    def test_two_fresh_frames_must_agree_on_fields_and_leading_clip(self):
        for change in ("counts", "leadingClip", "imageHint"):
            second = copy.deepcopy(result())
            if change == "counts":second["cards"][0]["counts"][0] = "40"
            elif change == "leadingClip":second[change] = True
            else:second["cards"][0][change] = "ffffffffffffffff"
            with self.subTest(change=change), self.assertRaises(sync.ImageListReadError):
                self.capture([result(), second])

    def test_agreeing_frames_mark_image_source_and_numeric_fields(self):
        root, events = self.capture([result(), result()])
        self.assertEqual(root.get("data-source"), "windows_native_ocr")
        self.assertIn("works_list_image_reader_active", events)
        self.assertEqual(sync.note_cards(root)[0][1]["list_view_count"], 49)

    def test_non_webview_hierarchy_failure_does_not_try_image_reader(self):
        with patch.object(sync.os, "name", "nt"), patch.object(sync, "capture", side_effect=RuntimeError("UIAutomator did not return an XML hierarchy")), patch.object(sync, "focus", return_value="u0 other.app/.WebViewActivityV2"), patch.object(sync, "image_navigation_capture") as image:
            with self.assertRaises(RuntimeError):sync.navigation_capture("adb", "serial", lambda: None, [])
        image.assert_not_called()

    def test_confirmed_webview_xml_timeout_can_use_guarded_image_reader(self):
        with patch.object(sync.os, "name", "nt"), patch.object(sync, "capture", side_effect=subprocess.TimeoutExpired("adb", 15)), patch.object(sync, "focus", return_value=self.current), patch.object(sync, "image_navigation_capture", return_value="proven") as image:
            self.assertEqual(sync.navigation_capture("adb", "serial", lambda: None, ["collection_slot_requested:app1"]), "proven")
        image.assert_called_once()

    def test_active_image_mode_allows_xml_navigation_and_loading_headers(self):
        for root in (sync.ET.fromstring('<hierarchy><node text="创作中心"/></hierarchy>'),
                     sync.ET.fromstring('<hierarchy><node text="数据中心"/><node text="作品分析"/></hierarchy>')):
            with patch.object(sync.os, "name", "nt"), patch.object(sync, "capture", return_value=root), patch.object(sync, "image_navigation_capture") as image:
                self.assertIs(sync.navigation_capture("adb","serial",lambda:None,["works_list_image_reader_active"]),root)
            image.assert_not_called()

    def test_empty_xml_works_tab_tries_images_but_retains_bounded_loading_wait(self):
        root = sync.ET.fromstring('<hierarchy><node text="数据中心" bounds="[0,0][300,80]"/><node text="作品分析" bounds="[0,80][200,120]"/><node text="全部笔记" bounds="[0,120][200,160]"/></hierarchy>')
        with patch.object(sync.os,"name","nt"),patch.object(sync,"capture",return_value=root),patch.object(sync,"focus",return_value=self.current),patch.object(sync,"image_navigation_capture",side_effect=sync.ImageListReadError("no proven cards")) as image:
            self.assertIs(sync.navigation_capture("adb","serial",lambda:None,[]),root)
        image.assert_called_once()
        self.assertEqual(sync.note_cards(root),[])

    def test_partial_data_center_xml_header_can_try_images_without_claiming_a_list(self):
        header = '<node package="com.xingin.xhs" class="android.webkit.WebView" text="数据中心" bounds="[0,0][1080,2400]">'
        header += ''.join(f'<node package="com.xingin.xhs" class="android.widget.TextView" text="{text}" bounds="[{x},200][{x+150},250]"/>' for x,text in zip((20,300,550,800),("账号概览","作品分析","粉丝数据","收入数据"))) + '</node>'
        root = sync.ET.fromstring('<hierarchy>'+header+'</hierarchy>')
        self.assertTrue(sync.data_center_tab_header(root))
        self.assertFalse(sync.creator_list(root))
        with patch.object(sync.os,"name","nt"),patch.object(sync,"capture",return_value=root),patch.object(sync,"focus",return_value=self.current),patch.object(sync,"image_navigation_capture",return_value="verified") as image:
            self.assertEqual(sync.navigation_capture("adb","serial",lambda:None,[]),"verified")
        image.assert_called_once()
        root[0].append(copy.deepcopy(root[0][1]))
        self.assertFalse(sync.data_center_tab_header(root))


class ImageCollectionTests(unittest.TestCase):
    def collect(self, first, following=None, reopened=None):
        args = SimpleNamespace(adb="adb", serial="serial", device_name="test", task_id="test",
                               app_slot="app1", device_cache="unused", cancel_file="", days=30,
                               max_scrolls=2, min_scrolls=0, stagnant_rounds=3)
        def start(*arguments):
            arguments[-1].extend(["collection_slot_requested:app1", "works_list_image_reader_active"])
            return first
        with ExitStack() as stack:
            for name in ("release_idle_poco", "verify_collection_slot", "assert_no_poco", "swipe"):
                stack.enter_context(patch.object(sync, name))
            stack.enter_context(patch.object(sync, "assert_idle", return_value={"xhsAccounts": [{"appSlot": "app1", "enabled": True}]}))
            stack.enter_context(patch.object(sync, "adb", return_value="device"))
            stack.enter_context(patch.object(sync, "start_xhs", side_effect=start))
            stack.enter_context(patch.object(sync, "ensure_creator_list", side_effect=lambda a,b,r,*rest:r))
            stack.enter_context(patch.object(sync, "wait_creator_content", side_effect=lambda a,b,r,*rest:r))
            stack.enter_context(patch.object(sync, "reopen_creator_list", side_effect=[first]+([reopened] if reopened is not None else [])))
            stack.enter_context(patch.object(sync, "refresh_scrolled_webview", side_effect=lambda a,b,r,*rest:r))
            stack.enter_context(patch.object(sync, "navigation_capture", side_effect=following or []))
            if first.get("data-source") != "windows_native_ocr":
                real_cards = sync.note_cards
                stack.enter_context(patch.object(sync, "note_cards", side_effect=lambda r:real_cards(r) if r.get("data-source") else [(None,{"title":"old XML item","published_at_raw":"10-14","status_raw":"正常","list_view_count":1,"list_like_count":0,"list_comment_count":0})]))
            return sync.collect(args)

    def test_unreadable_newest_card_is_not_a_complete_scan(self):
        first = result();first["leadingClip"] = True
        with self.assertRaisesRegex(sync.ImageListReadError, "leading card"):
            self.collect(ocr.hierarchy_for_frame(first))

    def test_boundary_only_card_is_excluded_and_cannot_hide_a_recent_count(self):
        first = result();first["cards"][0].update(date="09-14",counts=[None,None,None],boundaryOnly=True)
        collected = self.collect(ocr.hierarchy_for_frame(first))
        self.assertTrue(collected["complete"])
        self.assertEqual(collected["notes"],[])
        first["cards"][0]["date"] = "10-14"
        with self.assertRaisesRegex(sync.ImageListReadError,"requested collection window"):
            self.collect(ocr.hierarchy_for_frame(first))

    def test_image_error_after_swipe_keeps_prior_notes_as_incomplete(self):
        first = result();first["markers"] = {}
        collected = self.collect(ocr.hierarchy_for_frame(first), [sync.ImageListReadError("unproven glyph")])
        self.assertFalse(collected["complete"])
        self.assertEqual(collected["stop_reason"], "image_list_read_unproven")
        self.assertEqual(len(collected["notes"]), 1)
        self.assertNotIn("_image_hint", collected["notes"][0])
        self.assertNotIn("_displayed_unit", collected["notes"][0])

    def test_overlap_is_not_duplicated_and_two_ambiguous_visible_notes_fail(self):
        first = result();first["markers"] = {}
        collected = self.collect(ocr.hierarchy_for_frame(first), [ocr.hierarchy_for_frame(result())])
        self.assertTrue(collected["complete"])
        self.assertEqual(len(collected["notes"]), 1)
        duplicate = result();duplicate["cards"].append(copy.deepcopy(duplicate["cards"][0]))
        with self.assertRaisesRegex(sync.ImageListReadError, "two visible"):
            self.collect(ocr.hierarchy_for_frame(duplicate))

    def test_changed_counts_in_an_overlapping_post_do_not_create_another_post(self):
        first = result();first["markers"] = {}
        second = result();second["cards"][0]["counts"][0] = "50"
        collected = self.collect(ocr.hierarchy_for_frame(first),[ocr.hierarchy_for_frame(second)])
        self.assertEqual(len(collected["notes"]),1)
        self.assertEqual(collected["notes"][0]["list_view_count"],50)

    def test_xml_to_image_restart_removes_mixed_notes_and_rechecks_newest(self):
        old = ocr.hierarchy_for_frame(result());old.attrib.pop("data-source");
        for n in list(old[0]):
            if n.get("text") == "到底了":old[0].remove(n)
        image = ocr.hierarchy_for_frame(result())
        collected = self.collect(old, [image], image)
        self.assertEqual([n["title"] for n in collected["notes"]], ["合成测试作品"])
        self.assertIn("works_image_scan_restarted_at_newest", collected["recovery_events"])
        clipped = result();clipped["leadingClip"] = True
        with self.assertRaisesRegex(sync.ImageListReadError, "leading card"):
            self.collect(old, [image], ocr.hierarchy_for_frame(clipped))


if __name__ == "__main__":
    unittest.main()
