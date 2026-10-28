import unittest,time,subprocess,io,contextlib
from unittest import mock
import alipay_name_lookup as lookup
import alipay_visual_result as visual
import xhs_airtest_poco as worker

class ReaderBoundaryTests(unittest.TestCase):
    def runner(self):
        r=lookup.Runner({"serial":"fixture","phoneNumber":"13800000000"})
        r.focus=mock.Mock(return_value=[])
        r.focus_components=mock.Mock(return_value=("search","search"))
        r.exact_search_activity_visible=mock.Mock(return_value=True)
        r.poco_raise_if_account_restricted=mock.Mock()
        r.poco_verification_evidence=mock.Mock(return_value=False)
        r.poco_nodes=mock.Mock(return_value=["13800000000"])
        r.poco_text=lambda x:x
        r.adb=mock.Mock(return_value=b"png-fixture")
        r.emit=mock.Mock()
        return r

    def test_timeout_before_or_after_frame_keeps_submitted_boundary(self):
        for step in [1,2]:
            r=self.runner();p=mock.Mock()
            p.freeze.side_effect=([object()] if step==2 else [])+[TimeoutError("Read timed out. (read timeout=2.0)")]
            with mock.patch.object(visual,"recognize",return_value=([],(720,1600))),mock.patch.object(visual,"parse_rows",return_value={"notFound":False,"realNameTailCharacter":"甲"}),mock.patch.object(visual,"protection",return_value=None):
                with self.assertRaisesRegex(RuntimeError,"^poco_query_result_channel_timeout_after_input:visual_"):
                    r.poco_visual_result_readonly(p,"13800000000",time.perf_counter()+60)
            self.assertEqual(r.adb.call_count,step-1)
            self.assertEqual(p.freeze.call_count,step)
            self.assertTrue(any(c.args[0]=="lookup_reader_failure" for c in r.emit.call_args_list))
            self.assertFalse(any(c.args[0]=="query_result" for c in r.emit.call_args_list))

    def test_protected_human_state_remains_human(self):
        r=self.runner();r.poco_verification_evidence.return_value=True
        with self.assertRaisesRegex(RuntimeError,"human_verification_required"):
            r.poco_visual_result_readonly(mock.Mock(),"13800000000",time.perf_counter()+60)
        r.adb.assert_not_called()

    def test_bootstrap_error_preserves_stage_without_argv_or_secrets(self):
        cases=[(subprocess.TimeoutExpired(["adb","-s","private-serial"],4),"timeout"),(RuntimeError("device private-serial offline"),"device_unavailable"),(subprocess.CalledProcessError(1,["sensitive"]),"command_failed")]
        for exc,reason in cases:
            with contextlib.redirect_stderr(io.StringIO()) as output:
                with self.assertRaisesRegex(RuntimeError,"^poco_worker_bootstrap_failed:adb_probe:"+reason+"$"):
                    worker.reader_bootstrap_stage("adb_probe",mock.Mock(side_effect=exc))
            self.assertNotIn("private-serial",output.getvalue());self.assertNotIn("sensitive",output.getvalue())

    def test_stop_verification_does_not_accept_silent_pid_read_failure(self):
        p=mock.Mock(_keep_running_thread=None,_instrument_proc=None,forward_list=[])
        def call(adb,serial,args,**kw):
            if args[0]=="shell" and "LOOKUP_READER_ABSENT" in args[-1]:raise subprocess.TimeoutExpired([],2)
            return ""
        with mock.patch.object(worker,"run_adb",side_effect=call),mock.patch.object(worker.time,"sleep"):
            with self.assertRaises(subprocess.TimeoutExpired):worker.stop_stable_poco(p,"adb","fixture",verify=True)

if __name__=="__main__":unittest.main()
