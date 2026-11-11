import importlib.util
from pathlib import Path
import subprocess
import unittest
from unittest.mock import Mock,patch

RELEASE=Path(__file__).resolve().parent
spec=importlib.util.spec_from_file_location("clean_root_candidate",(Path(__file__).resolve().parents[2] / "windows-agent/scripts/小红书数据同步.py"))
sync=importlib.util.module_from_spec(spec);spec.loader.exec_module(sync)
ERROR="native elements command failed: native_elements_unproven:IllegalStateException:native root missing"
INDEX="mCurrentFocus=Window{x u0 com.xingin.xhs/.index.v2.IndexActivityV2}"

class CleanRootExitTests(unittest.TestCase):
    def reject(self, code, error=ERROR):
        def read(adb, serial, run, *_):
            run(adb,serial,"shell","CLASSPATH=owned NativeWindowReader",timeout=25)
            raise RuntimeError(error)
        with patch("xhs_native_window.read",side_effect=read),patch.object(sync,"assert_no_poco"), \
             patch.object(sync,"adb_process",return_value=subprocess.CompletedProcess([],code,b"",b"")):
            return sync.native_window_capture("adb","fixture",INDEX,Mock(),["collection_slot_requested:app1"])

    def test_only_normal_exit_one_with_exact_error_can_mark_cleanup_complete(self):
        with self.assertRaises(sync.CleanNativeRootUnavailable):self.reject(1)

    def test_timeout_signal_and_unknown_exit_never_mark_clean_root_rejection(self):
        for code in [124,-9,0,2]:
            try:self.reject(code)
            except RuntimeError as error:self.assertNotIsInstance(error,sync.CleanNativeRootUnavailable)
            else:self.fail("reader must reject")

    def test_disconnect_and_temp_file_cleanup_errors_are_never_retryable(self):
        for error in [ERROR+"\nnative_disconnect_failed","native elements temporary file cleanup is unproven"]:
            try:self.reject(1,error)
            except RuntimeError as caught:self.assertNotIsInstance(caught,sync.CleanNativeRootUnavailable)
            else:self.fail("reader must reject")

if __name__=="__main__":unittest.main()
