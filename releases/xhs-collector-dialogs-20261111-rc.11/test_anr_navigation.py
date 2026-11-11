import importlib.util
from pathlib import Path
import unittest
from unittest.mock import Mock, patch

R=Path(__file__).resolve().parent
ROOT=R.parents[1]
spec=importlib.util.spec_from_file_location('anr_navigation_candidate',(Path(__file__).resolve().parents[2] / "windows-agent/scripts/小红书数据同步.py"))
sync=importlib.util.module_from_spec(spec);spec.loader.exec_module(sync)
ANR='mCurrentFocus=Window{x u0 Application Not Responding: com.xingin.xhs}'
READY='mCurrentFocus=Window{x u0 com.xingin.xhs/.index.v2.IndexActivityV2}'

class AnrNavigationTests(unittest.TestCase):
    def test_native_mode_preserves_the_existing_element_backed_wait_path(self):
        root=sync.ET.parse(ROOT/'windows-agent/scripts/fixtures/xhs/miui-xhs-anr.xml').getroot()
        events=['collection_slot_requested:app1','native_window_elements_enabled']
        with patch.object(sync,'focus',return_value=ANR),patch.object(sync,'capture',return_value=root) as stock,patch.object(sync,'native_window_capture') as native:
            observed=sync.navigation_capture('fixture','fixture',Mock(),events)
            self.assertIs(observed,root)
            stock.assert_called_once()
            native.assert_not_called()
        with patch.object(sync,'focus',side_effect=[ANR,ANR,READY]),patch.object(sync,'adb') as adb,patch.object(sync.time,'sleep'):
            self.assertTrue(sync.recover_known_overlay('fixture','fixture',observed,Mock(),events))
            adb.assert_called_once_with('fixture','fixture','shell','input','tap','201','1395',timeout=7)
        self.assertIn('xhs_anr_wait_selected',events)

    def test_failed_system_dialog_export_is_an_app_failure_without_any_replay(self):
        events=['collection_slot_requested:app1','native_window_elements_enabled']
        with patch.object(sync,'focus',return_value=ANR),patch.object(sync,'capture',side_effect=RuntimeError('UIAutomator did not return an XML hierarchy')) as stock,patch.object(sync,'native_window_capture') as native,patch.object(sync,'adb') as adb:
            with self.assertRaisesRegex(RuntimeError,'app is not responding'):
                sync.navigation_capture('fixture','fixture',Mock(),events)
            stock.assert_called_once();native.assert_not_called();adb.assert_not_called()

    def test_foreign_user_or_foreign_app_is_not_labeled_as_owner_xhs_anr(self):
        for current in (ANR.replace('u0','u999'),ANR.replace('com.xingin.xhs','com.other')):
            events=['collection_slot_requested:app1','native_window_elements_enabled']
            with self.subTest(current=current),patch.object(sync,'focus',return_value=current),patch.object(sync,'capture',side_effect=RuntimeError('UIAutomator did not return an XML hierarchy')),patch.object(sync,'native_window_capture') as native:
                with self.assertRaisesRegex(RuntimeError,'UIAutomator did not return an XML hierarchy'):
                    sync.navigation_capture('fixture','fixture',Mock(),events)
                native.assert_not_called()

if __name__=='__main__':unittest.main()
