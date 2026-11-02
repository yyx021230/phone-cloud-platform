import json
import base64
import unittest
import tempfile
from pathlib import Path
from wecom_invite_preview import Screen,Node,PACKAGE
from wecom_invite_preview import StopPreview
from wecom_private_observation import structural_page,writer

class PrivateObservationTests(unittest.TestCase):
    def test_only_fixed_ui_labels_resource_ids_and_target_match_survive(self):
        phone='19900000001';page=Screen(PACKAGE,(Node('android.widget.TextView',text='private contact',desc='private token',name='com.tencent.wework:id/abc'),Node('android.widget.TextView',text=phone),Node('android.widget.TextView',text='个人信息')))
        value=structural_page(page,phone,'unknown_home');raw=json.dumps(value)
        for secret in ('private contact','private token',phone):self.assertNotIn(secret,raw)
        self.assertEqual(value['nodes'][0]['resource'],'com.tencent.wework:id/abc');self.assertTrue(value['nodes'][1]['authorizedTarget']);self.assertEqual(value['nodes'][2]['text'],'个人信息')
    def test_observation_cannot_emit_arbitrary_kind_or_unbounded_nodes(self):
        page=Screen(PACKAGE,tuple(Node('private_class',text='private')for _ in range(600)))
        v=structural_page(page,'19900000001','home');self.assertTrue(v['truncated']);self.assertEqual(len(v['nodes']),512);self.assertNotIn('private',json.dumps(v))
        with self.assertRaises(ValueError):structural_page(page,'19900000001','private')

    def test_fixed_diff_identifies_order_only_without_saving_unknown_text(self):
        phone='19900000001';a=Node('android.widget.EditText',text='手机号',name='com.tencent.wework:id/input');b=Node('android.widget.TextView',text='private contact',desc='private token',name='com.tencent.wework:id/other')
        with tempfile.TemporaryDirectory()as tmp:
            folder=Path(tmp)/'staging/wecom-qa-observation';folder.mkdir(parents=True)
            observe=writer(folder,phone);observe('home',Screen(PACKAGE,(a,b)))
            observe.difference('enter_phone',Screen(PACKAGE,(a,b)),Screen(PACKAGE,(b,a)))
            files=list(folder.iterdir());self.assertEqual(len(files),2)
            value=json.loads((folder/'ui-last-sanitized.json').read_text());self.assertTrue(value['sameNodeMultiset']);self.assertTrue(value['orderChanged'])
            for f in files:
                raw=f.read_text();self.assertLessEqual(len(f.read_bytes()),131072)
                for secret in (phone,'private contact','private token'):self.assertNotIn(secret,raw)

    def test_startup_observation_only_fixed_states_no_raw_dump_or_extra_queries(self):
        with tempfile.TemporaryDirectory()as tmp:
            folder=Path(tmp)/'staging/wecom-qa-observation';folder.mkdir(parents=True)
            observe=writer(folder,'19900000001')
            observe.startup('power_before','mWakefulness=Asleep\nprivate secret 19900000001',0)
            observe.startup('power_after','mWakefulness=Awake\nmWakefulnessChanging=true\nprivate',0)
            observe.startup('keyguard','KeyguardServiceDelegate\n secure=false\n mIsShowing=false\n mCurrentUserId=0\nprivate',0)
            for _ in range(20):observe.startup('power_after','unrecognized private 19900000001',0)
            observe.startup('private','secret',0)
            raw=(folder/'startup-sanitized.json').read_text();value=json.loads(raw)
            self.assertEqual(len(value['observations']),3);self.assertEqual(len(list(folder.iterdir())),1)
            for secret in ('private','secret','19900000001'):self.assertNotIn(secret,raw)
            self.assertEqual(value['observations'][1]['wakefulness'],'unknown')

    def test_foreground_only_technical_component_and_fixed_user_match_saved(self):
        with tempfile.TemporaryDirectory()as tmp:
            folder=Path(tmp)/'staging/wecom-qa-observation';folder.mkdir(parents=True)
            observe=writer(folder,'19900000001')
            observe.startup('power_before','mWakefulness=Awake',0)
            for _ in range(20):observe.startup('foreground','mResumedActivity: ActivityRecord{private u0 com.tencent.wework/.MainActivity private secret}',0)
            raw=(folder/'startup-sanitized.json').read_text();v=json.loads(raw)['observations']
            self.assertEqual(len(v),2);self.assertEqual(v[1]['component'],'com.tencent.wework/.MainActivity');self.assertTrue(v[1]['userMatches'])
            for secret in ('private','secret','19900000001'):self.assertNotIn(secret,raw)

    def test_private_blank_capture_once_bounded_not_part_of_json_observation(self):
        with tempfile.TemporaryDirectory()as tmp:
            folder=Path(tmp)/'staging/wecom-qa-observation';folder.mkdir(parents=True)
            observe=writer(folder,'19900000001');calls=[]
            def capture():calls.append(1);return base64.b64encode(b'\xff\xd8private-image\xff\xd9'),'jpg'
            observe.capture_blank_screen(capture);observe.capture_blank_screen(capture)
            self.assertEqual(len(calls),1);self.assertEqual(len(list(folder.iterdir())),2)
            self.assertEqual((folder/'unknown-page-private.jpg').stat().st_mode&0o777,0o600)

    def test_failed_unknown_or_oversized_private_capture_never_replayed(self):
        for data in (b'bad',base64.b64encode(b'\xff\xd8'+b'x'*262145+b'\xff\xd9')):
            with tempfile.TemporaryDirectory()as tmp:
                folder=Path(tmp)/'staging/wecom-qa-observation';folder.mkdir(parents=True)
                observe=writer(folder,'19900000001');calls=[]
                def capture():calls.append(1);return data,'jpg'
                with self.assertRaisesRegex(StopPreview,'qa_private_capture_invalid'):observe.capture_blank_screen(capture)
                observe.capture_blank_screen(capture);self.assertEqual(len(calls),1)
                self.assertEqual([p.name for p in folder.iterdir()],['capture-sanitized.json'])

    def test_android_wrapped_base64_and_true_png_format_are_validated_once(self):
        for image,reported,actual in ((b'\xff\xd8private-image\xff\xd9','jpg','jpg'),(b'\x89PNG\r\n\x1a\nprivate-imageIEND\xaeB`\x82','jpg','png')):
            with tempfile.TemporaryDirectory()as tmp:
                folder=Path(tmp)/'staging/wecom-qa-observation';folder.mkdir(parents=True)
                observe=writer(folder,'19900000001');encoded=base64.b64encode(image)
                self.assertTrue(observe.capture_blank_screen(lambda:(encoded[:8]+b'\r\n'+encoded[8:]+b'\n',reported)))
                self.assertEqual((folder/('unknown-page-private.'+actual)).read_bytes(),image)
                facts=json.loads((folder/'capture-sanitized.json').read_text())
                self.assertTrue(facts['asciiWhitespace']);self.assertEqual(facts['actualFormat'],actual)

    def test_capture_error_fixed_category_does_not_save_exception_or_retry(self):
        with tempfile.TemporaryDirectory()as tmp:
            folder=Path(tmp)/'staging/wecom-qa-observation';folder.mkdir(parents=True)
            observe=writer(folder,'19900000001');calls=[]
            def capture():calls.append(1);raise RuntimeError('private secret 19900000001')
            with self.assertRaisesRegex(StopPreview,'qa_private_capture_unavailable'):observe.capture_blank_screen(capture)
            observe.capture_blank_screen(capture);self.assertEqual(len(calls),1)
            raw=(folder/'capture-sanitized.json').read_text();self.assertEqual(json.loads(raw)['errorCategory'],'capture_unavailable')
            for secret in ('private','secret','19900000001'):self.assertNotIn(secret,raw)

    def test_power_and_command_response_diagnostics_never_save_raw_text(self):
        with tempfile.TemporaryDirectory()as tmp:
            folder=Path(tmp)/'staging/wecom-qa-observation';folder.mkdir(parents=True)
            observe=writer(folder,'19900000001')
            observe.startup('wake_response','Permission denied private 19900000001',0)
            observe.startup('dismiss_response','',0)
            observe.startup('power_after','mWakefulness=Asleep\nmScreenState=OFF\nmProximity=Positive\nmScreenOffBecauseOfProximity=true\nmRequestWaitForNegativeProximity=false\nprivate 19900000001',0)
            raw=(folder/'startup-sanitized.json').read_text();v=json.loads(raw)['observations']
            self.assertEqual(v[0]['response'],'denied');self.assertEqual(v[1]['response'],'empty')
            self.assertEqual(v[2]['displayState'],'OFF');self.assertEqual(v[2]['proximity'],'Positive')
            for secret in ('private','19900000001','Permission denied'):self.assertNotIn(secret,raw)

if __name__=='__main__':unittest.main()
