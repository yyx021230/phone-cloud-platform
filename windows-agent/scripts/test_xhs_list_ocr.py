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
            if image["id"].startswith("r0_view"):image["lines"][0]["text"] = "4040"
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
            if image["id"].startswith("r0_like"):image["lines"][0]["text"] = "8888"
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






class MissingBodyAnchorTests(unittest.TestCase):
    def native_line(self,text,box):
        item=line(text,box);item['words'][0]['text']=text;return item

    def whole(self):
        # Real 141/app2 geometry, with all note text replaced by synthetic text.
        rows=[self.native_line(t,b) for t,b in [('数据中心',(299,111,421,139)),('作品分析',(218,198,326,225)),('全部笔记',(32,283,144,309))]]
        for i,y in enumerate([422,629,836,1040,1251]):
            rows.append(self.native_line('笔记状态正常',(165 if i==3 else 194,y,363,y+24)))
            if i<3:rows.append(self.native_line('合成原始标题'+str(i),(193,y-62,650,y-33)))
        return {'width':720,'height':1600,'language':'zh-Hans-CN','textAngle':0,'lines':rows}

    def crops(self,requests,directory):
        out=[]
        for request in requests:
            parts=request['id'].split('_');index=int(parts[-2]);y=932 if index==0 else 1143
            image=cv2.imread(request['path']);h,w=image.shape[:2]
            title='合成修复标题甲' if index==0 else '合成修复标题乙'
            title_y=982 if index==0 else 1190;status_y=1043 if index==0 else 1251
            def crop_line(text,box):
                x1,y1,x2,y2=box
                return self.native_line(text,((x1-172)*3,(y1-y)*3,(x2-172)*3,(y2-y)*3))
            out.append({'id':request['id'],'width':w,'height':h,'language':'zh-Hans-CN','lines':[crop_line(title,(193,title_y,650,title_y+27)),crop_line('笔记状态正常',(194,status_y,363,status_y+23))]})
        return out

    def test_missing_whole_frame_titles_and_a_left_shifted_status_are_recovered_from_ink(self):
        frame=np.full((1600,720,3),255,np.uint8);whole=self.whole();original=json.dumps(whole,ensure_ascii=False)
        def icons(frame,y1,y2,left):return [(195,y1,220,y1+22),(296,y1,320,y1+22),(375,y1,400,y1+22)]
        with patch.object(ocr,'selected_works_underline',return_value=True),patch.object(ocr,'metric_icons',side_effect=icons),patch.object(ocr,'title_has_unread_suffix',return_value=False):
            with self.assertRaisesRegex(RuntimeError,'title is not visible'):ocr.prepare_frame(frame,whole,read_counts=False)
            with tempfile.TemporaryDirectory() as directory,patch.object(ocr,'windows_ocr',side_effect=self.crops) as native:
                repaired=ocr.refine_missing_body_anchors(frame,whole,directory,lambda:None)
            prepared=ocr.prepare_frame(frame,repaired,read_counts=False)
        self.assertEqual(len(prepared['rows']),5)
        self.assertEqual([r['title'] for r in prepared['rows']][-2:],['合成修复标题甲','合成修复标题乙'])
        self.assertEqual(repaired['bodyAnchorRecoveryCount'],2)
        self.assertEqual(native.call_count,1)
        self.assertEqual(json.dumps(whole,ensure_ascii=False),original)

    def test_complete_native_anchors_do_not_invoke_an_extra_ocr(self):
        whole=self.whole();whole['lines']=[l for l in whole['lines'] if ocr.line_box(l)[1]<900]
        with tempfile.TemporaryDirectory() as directory,patch.object(ocr,'windows_ocr') as native:
            self.assertIs(ocr.refine_missing_body_anchors(np.zeros((1600,720,3),np.uint8),whole,directory,lambda:None),whole)
        native.assert_not_called()

    def test_title_hidden_by_the_fixed_header_keeps_existing_leading_clip_handling(self):
        whole=self.whole();whole['lines']=[l for l in whole['lines'] if ocr.line_box(l)[1]<900 and ocr.line_box(l)[1]!=360]
        first=next(l for l in whole['lines'] if ocr.status_text(l['text']))
        first['words'][0].update(y=330,height=24)
        frame=np.full((1600,720,3),255,np.uint8)
        with tempfile.TemporaryDirectory() as directory,patch.object(ocr,'windows_ocr') as native:
            repaired=ocr.refine_missing_body_anchors(frame,whole,directory,lambda:None)
        self.assertIs(repaired,whole);native.assert_not_called()
        def icons(frame,y1,y2,left):return [(195,y1,220,y1+22),(296,y1,320,y1+22),(375,y1,400,y1+22)]
        with patch.object(ocr,'selected_works_underline',return_value=True),patch.object(ocr,'metric_icons',side_effect=icons),patch.object(ocr,'title_has_unread_suffix',return_value=False):
            prepared=ocr.prepare_frame(frame,repaired,read_counts=False)
        self.assertTrue(prepared['leadingClip']);self.assertEqual(len(prepared['rows']),2)

    def test_disagreement_foreign_dimensions_missing_status_and_duplicate_results_still_fail(self):
        for case in ('title','language','dimensions','status','duplicate'):
            def invalid(requests,directory):
                results=self.crops(requests,directory)
                if case=='title':results[1]['lines'][0]=self.native_line('另一个合成标题',(63,150,1434,231))
                if case=='language':results[1]['language']='en-US'
                if case=='dimensions':results[1]['width']+=1
                if case=='status':results[1]['lines']=results[1]['lines'][:1]
                if case=='duplicate':results[-1]=results[0]
                return results
            with tempfile.TemporaryDirectory() as directory,patch.object(ocr,'windows_ocr',side_effect=invalid),self.assertRaises(RuntimeError):
                ocr.refine_missing_body_anchors(np.zeros((1600,720,3),np.uint8),self.whole(),directory,lambda:None)

if __name__ == "__main__":
    unittest.main()
