"""Offline Canvas prompt regression: no network, phones or authentication."""
import contextlib
import importlib.util
import io
import os
import pathlib
import sys
import unittest
import xml.etree.ElementTree as ET
from unittest import mock
import cv2
import numpy as np

HERE = pathlib.Path(__file__).resolve().parent
SOURCE = pathlib.Path(os.environ.get('LOOKUP_TEST_SOURCE', str(HERE.parent / 'windows-agent/scripts/alipay_name_lookup.py')))
spec = importlib.util.spec_from_file_location('lookup_canvas_test', SOURCE)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
MODAL = cv2.imread(str(HERE / 'optional-realname-modal.png'))
HOME_COMPONENT = module.ALIPAY_PACKAGE + '/.AlipayLogin'
FOCUS = ([], 'mCurrentFocus=' + HOME_COMPONENT, 'mFocusedApp=' + HOME_COMPONENT)
HOME = ET.fromstring(f'''<hierarchy>
<node resource-id="{module.TAB_SELECTED_FRAME_ID}" content-desc="首页" selected="true"/>
<node resource-id="{module.TAB_DESCRIPTION_ID}" text="我的" selected="false" bounds="[576,1496][720,1604]"/>
</hierarchy>''')


def png(image):
    ok, data = cv2.imencode('.png', image)
    assert ok
    return data.tobytes()


class CanvasPromptTests(unittest.TestCase):
    def detect(self, image):
        return module.real_name_canvas_evidence(png(image))

    def runner(self, images=None):
        r = module.Runner({'serial': 'OFFLINE', 'taskId': 'canvas-fixture'})
        r.focus_state = mock.Mock(return_value=FOCUS)
        r.dump = mock.Mock(return_value=(HOME, {}))
        queue = iter(images or [MODAL, MODAL, np.full_like(MODAL, 70)])
        r.commands = []
        def adb(args, **kwargs):
            r.commands.append(args)
            if args == ['exec-out', 'screencap', '-p']:
                return png(next(queue))
            return ''
        r.adb = mock.Mock(side_effect=adb)
        return r

    def taps(self, r):
        return [a for a in r.commands if a[:3] == ['shell', 'input', 'tap']]

    def test_actual177_modal_unique_circle_x(self):
        self.assertEqual(self.detect(MODAL)['close'], [360, 1254])

    def test_resized177_modal_540_and1080(self):
        for width in (540, 1080):
            with self.subTest(width=width):
                image = cv2.resize(MODAL, (width, round(MODAL.shape[0] * width / 720)))
                point = self.detect(image)['close']
                self.assertIsNotNone(point)
                self.assertLessEqual(abs(point[0] - width / 2), 1)
                self.assertLessEqual(abs(point[1] - 1254 * width / 720), 2)

    def test_blank_and_random_images_do_not_match(self):
        for image in (np.zeros_like(MODAL), np.full_like(MODAL, 255), np.random.default_rng(3).integers(0, 256, MODAL.shape, dtype=np.uint8)):
            self.assertIsNone(self.detect(image)['close'])

    def test_missing_title_action_or_close_never_selects_a_point(self):
        for rect in ((185,645,540,704), (275,1010,445,1065), (320,1210,400,1300)):
            with self.subTest(rect=rect):
                image = MODAL.copy(); x0,y0,x1,y1 = rect
                image[y0:y1,x0:x1] = 70
                self.assertIsNone(self.detect(image)['close'])

    def test_duplicate_circle_x_is_ambiguous(self):
        image = MODAL.copy()
        image[1220:1289,120:190] = MODAL[1220:1289,325:395]
        self.assertEqual(self.detect(image)['closeCount'], 2)
        self.assertIsNone(self.detect(image)['close'])

    def test_duplicate_title_is_ambiguous(self):
        image = MODAL.copy()
        image[730:777,194:528] = MODAL[651:698,194:528]
        self.assertEqual(self.detect(image)['titleCount'], 2)
        self.assertIsNone(self.detect(image)['close'])

    def test_unrelated_x_position_cannot_be_tapped(self):
        image = MODAL.copy()
        image[1220:1289,325:395] = 70
        image[1220:1289,120:190] = MODAL[1220:1289,325:395]
        self.assertIsNone(self.detect(image)['close'])

    def test_action_label_on_nonblue_button_rejected(self):
        image = MODAL.copy()
        area=image[989:1086,177:545]
        blue=(area[:,:,0]>180)&(area[:,:,2]<100)
        area[blue] = (0,0,0)
        self.assertIsNone(self.detect(image)['close'])

    def test_invalid_screenshot_fails_without_a_point(self):
        with self.assertRaisesRegex(RuntimeError, 'screenshot_invalid'):
            module.real_name_canvas_evidence(b'not a screenshot')

    def test_close_once_then_observe_and_keep_account_state(self):
        r=self.runner();r.current_account_after_switch='already-confirmed';r.account_identity_verified=True
        with mock.patch.object(module.time, 'sleep'):
            self.assertTrue(r.dismiss_canvas_real_name_prompt(HOME, 'prepare'))
        self.assertEqual(self.taps(r), [['shell','input','tap','360','1254']])
        self.assertEqual(r.current_account_after_switch, 'already-confirmed')
        self.assertTrue(r.account_identity_verified)
        self.assertFalse(r.log[0]['authenticationStarted'])
        self.assertEqual(r.log[-1]['step'], 'alipay_canvas_real_name_prompt_dismissed')

    def test_persistent_prompt_stops_after_one_close(self):
        r=self.runner([MODAL]*5)
        with mock.patch.object(module.time, 'sleep'), self.assertRaisesRegex(RuntimeError, 'not_dismissed'):
            r.dismiss_canvas_real_name_prompt(HOME, 'prepare')
        self.assertEqual(len(self.taps(r)),1)

    def test_selected_my_or_unknown_home_does_not_capture_or_tap(self):
        for xml in ('<hierarchy/>', ET.tostring(HOME,encoding='unicode').replace('text="我的" selected="false"','text="我的" selected="true"')):
            r=self.runner()
            self.assertFalse(r.dismiss_canvas_real_name_prompt(ET.fromstring(xml), 'prepare'))
            r.adb.assert_not_called()

    def test_captcha_and_limit_evidence_are_protected(self):
        for protect in ('verification_evidence', 'account_restriction_evidence'):
            r=self.runner();setattr(r,protect,mock.Mock(return_value={'reason':'protected'}))
            self.assertFalse(r.dismiss_canvas_real_name_prompt(HOME,'prepare'))
            r.adb.assert_not_called()

    def test_unselected_home_and_duplicate_my_tabs_do_not_capture(self):
        for xml in (ET.tostring(HOME,encoding='unicode').replace('content-desc="首页" selected="true"','content-desc="首页" selected="false"'),
                    ET.tostring(HOME,encoding='unicode').replace('</hierarchy>',f'<node resource-id="{module.TAB_DESCRIPTION_ID}" text="我的" selected="false"/></hierarchy>')):
            r=self.runner()
            self.assertFalse(r.dismiss_canvas_real_name_prompt(ET.fromstring(xml),'prepare'))
            r.adb.assert_not_called()

    def test_focus_on_other_package_or_search_never_taps(self):
        for component in ('other.app/.AlipayLogin', module.ALIPAY_PACKAGE+'/.MainSearchActivity'):
            r=self.runner();r.focus_state.return_value=([], 'mCurrentFocus='+component, '')
            self.assertFalse(r.dismiss_canvas_real_name_prompt(HOME,'prepare'))
            r.adb.assert_not_called()

    def test_focus_changes_between_image_and_click_fail_closed(self):
        r=self.runner();r.focus_state.side_effect=[FOCUS,([], 'mCurrentFocus=other.app/.Page','')]
        with self.assertRaisesRegex(RuntimeError, 'foreground_changed'):
            r.dismiss_canvas_real_name_prompt(HOME, 'prepare')
        self.assertEqual(self.taps(r),[])

    def test_screenshot_changes_before_click_fail_closed(self):
        r=self.runner([MODAL,np.full_like(MODAL,70)])
        with self.assertRaisesRegex(RuntimeError, 'evidence_changed'):
            r.dismiss_canvas_real_name_prompt(HOME, 'prepare')
        self.assertEqual(self.taps(r),[])

    def test_captcha_appearing_after_close_keeps_human_pause(self):
        r=self.runner();r.verification_evidence=mock.Mock(side_effect=[None,None,{'manual':True}])
        with mock.patch.object(module.time,'sleep'),self.assertRaisesRegex(RuntimeError,'human_verification_required'):
            r.dismiss_canvas_real_name_prompt(HOME,'prepare')
        self.assertEqual(len(self.taps(r)),1)

    def test_orientation_change_is_not_a_dismissal_confirmation(self):
        r=self.runner([MODAL,MODAL,np.zeros((720,1604,3),np.uint8)])
        with mock.patch.object(module.time,'sleep'),self.assertRaisesRegex(RuntimeError,'evidence_changed'):
            r.dismiss_canvas_real_name_prompt(HOME,'prepare')
        self.assertEqual(len(self.taps(r)),1)

    def test_navigation_continues_after_verified_canvas_close(self):
        r=self.runner();r.dismiss_known_overlay=mock.Mock(return_value=False)
        r.dismiss_canvas_real_name_prompt=mock.Mock(return_value=True)
        settings=ET.fromstring(f'<hierarchy><node resource-id="{module.SETTINGS_ENTRY_ID}" content-desc="设置" bounds="[648,78][696,174]"/></hierarchy>')
        r.dump.side_effect=[(HOME,{}),(HOME,{}),(HOME,{}),(settings,{})]
        # Two attempts, first My-tab remains blocked. Do not spend real time.
        clock=iter([0,0,0,0,7,7,7,7,7])
        with mock.patch.object(module.time,'time',side_effect=lambda:next(clock)),mock.patch.object(module.time,'sleep'):
            r.enter_my_settings('prepare')
        r.dismiss_canvas_real_name_prompt.assert_called_once()
        self.assertEqual(r.log[-1]['step'],'open_settings')


if __name__ == '__main__':
    with contextlib.redirect_stdout(io.StringIO()):
        result=unittest.TextTestRunner(verbosity=2).run(unittest.defaultTestLoader.loadTestsFromTestCase(CanvasPromptTests))
    sys.exit(not result.wasSuccessful())
