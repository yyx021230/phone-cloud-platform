import importlib.util
from pathlib import Path
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch
from contextlib import ExitStack
import xml.etree.ElementTree as ET

RELEASE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("root_candidate", (Path(__file__).resolve().parents[2] / "windows-agent/scripts/小红书数据同步.py"))
sync = importlib.util.module_from_spec(spec)
spec.loader.exec_module(sync)
INDEX = "mCurrentFocus=Window{x u0 com.xingin.xhs/.index.v2.IndexActivityV2}"
ERROR = "native elements command failed: native_elements_unproven:IllegalStateException:native root missing"

def profile():
    root = ET.Element("hierarchy")
    ET.SubElement(root, "node", {"package":sync.XHS_PACKAGE,"content-desc":"我","selected":"true","bounds":"[1,1][2,2]"})
    return root

class ProfileRootRecheckTests(unittest.TestCase):
    def run_profile(self, errors, changed_focus=None):
        empty=ET.Element("hierarchy");tree=profile();focus=[INDEX]
        readings=iter([empty,*errors,tree,tree]);events=["collection_slot_requested:app1"]
        def read(*args):
            value=next(readings)
            if isinstance(value,Exception):
                if changed_focus:focus[0]=changed_focus
                raise value
            return value
        with ExitStack() as stack:
            for name,kwargs in [("focus",{"side_effect":lambda *_:focus[0]}),
                                ("resume_vivo_update_entry",{"return_value":None}),
                                ("login_element_evidence",{"return_value":None}),
                                ("recover_known_overlay",{"return_value":False}),
                                ("profile_header_identity",{"return_value":"fixture_id"}),
                                ("identity_proof",{"return_value":{"sample_count":2}})]:
                stack.enter_context(patch.object(sync,name,**kwargs))
            stack.enter_context(patch.object(sync.time,"sleep"))
            reader=stack.enter_context(patch.object(sync,"native_window_capture",side_effect=read))
            action=stack.enter_context(patch.object(sync,"native_index_navigation"))
            try:
                args=SimpleNamespace(adb="adb",serial="fixture",app_slot="app1")
                answer=sync.prove_profile_identity(args,empty,Mock(),events,"fixture_id")
                return answer,events,reader.call_count,action.call_count,args.verified_account_identity
            finally:
                self.assertEqual(action.call_count,1)

    def test_exact_post_profile_error_discards_samples_and_requires_two_new_reads(self):
        answer,events,reads,actions,proof=self.run_profile([sync.CleanNativeRootUnavailable(ERROR)])
        self.assertEqual(reads,4)
        self.assertEqual(actions,1)
        self.assertEqual(proof["sample_count"],2)
        self.assertIn("identity_native_root_recheck_once",events)

    def test_repeated_root_missing_or_disconnect_cleanup_errors_stop(self):
        for errors in ([sync.CleanNativeRootUnavailable(ERROR),sync.CleanNativeRootUnavailable(ERROR)],
                       [RuntimeError(ERROR+"\nnative_disconnect_failed")],
                       [RuntimeError("native elements temporary file cleanup is unproven")]):
            with self.assertRaises(RuntimeError):
                self.run_profile(errors)

    def test_changed_foreground_is_not_retried(self):
        for current in [INDEX.replace("u0","u999"),INDEX.replace(".IndexActivityV2",".OtherActivity"),""]:
            with self.assertRaises(RuntimeError):
                self.run_profile([sync.CleanNativeRootUnavailable(ERROR)],changed_focus=current or "mCurrentFocus=null")

if __name__ == "__main__":
    unittest.main()
