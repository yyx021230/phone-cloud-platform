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

    def test_submitted_result_wakes_only_keyguard_over_original_search(self):
        r=self.runner();search=lookup.ALIPAY_PACKAGE+'/com.alipay.android.phone.businesscommon.globalsearch.ui.MainSearchActivity'
        r.focus_components.side_effect=[('mCurrentFocus=Window{x u0 NotificationShade}',search),(search,search)]
        r.exact_search_activity_visible=lookup.Runner.exact_search_activity_visible
        r.wake_before_query_if_asleep=mock.Mock(return_value=True)
        r.poco_result_snapshot=mock.Mock(side_effect=RuntimeError('fixture-result-reobserve'))
        with self.assertRaisesRegex(RuntimeError,'fixture-result-reobserve'):
            r.poco_visual_result_readonly(mock.Mock(),'13800000000',time.perf_counter()+60)
        r.wake_before_query_if_asleep.assert_called_once_with(deadline=mock.ANY)
        r.poco_result_snapshot.assert_called_once()
        r.adb.assert_not_called()
        r.emit.assert_any_call('lookup_result_display_recovered',resubmitsInput=False,
                              resubmitsSearch=False,beforeInput=False)

    def test_result_does_not_dismiss_awake_drawer_or_restore_other_app(self):
        search=lookup.ALIPAY_PACKAGE+'/com.alipay.android.phone.businesscommon.globalsearch.ui.MainSearchActivity'
        for under,awake in [(search,True),('other.app/.Main',False)]:
            r=self.runner();r.focus_components.return_value=('mCurrentFocus=Window{x u0 NotificationShade}',under)
            r.exact_search_activity_visible=lookup.Runner.exact_search_activity_visible
            r.wake_before_query_if_asleep=mock.Mock(return_value=not awake)
            with self.assertRaisesRegex(RuntimeError,'foreground_changed'):
                r.poco_visual_result_readonly(mock.Mock(),'13800000000',time.perf_counter()+60)
            self.assertEqual(r.wake_before_query_if_asleep.call_count,1 if awake else 0)
            r.adb.assert_not_called()

    def test_sleep_cleared_focused_app_is_not_permission_to_accept_other_page(self):
        search=lookup.ALIPAY_PACKAGE+'/com.alipay.android.phone.businesscommon.globalsearch.ui.MainSearchActivity'
        for revealed in [search, 'other.app/.Main', 'mCurrentFocus=null']:
            r=self.runner()
            states=iter([('mCurrentFocus=Window{x u0 NotificationShade}', 'mFocusedApp=null')])
            r.focus_components.side_effect=lambda *_:next(states,(revealed,revealed))
            r.exact_search_activity_visible=lookup.Runner.exact_search_activity_visible
            r.wake_before_query_if_asleep=mock.Mock(return_value=True)
            r.poco_result_snapshot=mock.Mock(side_effect=RuntimeError('fixture-recheck-original-number'))
            expected='fixture-recheck-original-number' if revealed==search else 'foreground_changed'
            with self.assertRaisesRegex(RuntimeError,expected):
                r.poco_visual_result_readonly(mock.Mock(),'13800000000',time.perf_counter()+60)
            r.wake_before_query_if_asleep.assert_called_once()
            self.assertEqual(r.poco_result_snapshot.call_count,1 if revealed==search else 0)
            r.adb.assert_not_called()

    def test_wake_observes_transient_keyguard_until_original_search_without_navigation(self):
        search=lookup.ALIPAY_PACKAGE+'/com.alipay.android.phone.businesscommon.globalsearch.ui.MainSearchActivity'
        shade=('mCurrentFocus=Window{x u0 NotificationShade}','mFocusedApp=null')
        r=self.runner();r.focus_components.side_effect=[shade,shade,('mCurrentFocus=null','mFocusedApp=null'),(search,search)]
        r.exact_search_activity_visible=lookup.Runner.exact_search_activity_visible
        r.wake_before_query_if_asleep=mock.Mock(return_value=True)
        r.poco_result_snapshot=mock.Mock(side_effect=RuntimeError('fixture-check-same-number'))
        with mock.patch.object(lookup.time,'sleep'),self.assertRaisesRegex(RuntimeError,'fixture-check-same-number'):
            r.poco_visual_result_readonly(mock.Mock(),'13800000000',time.perf_counter()+60)
        r.wake_before_query_if_asleep.assert_called_once()
        self.assertEqual(r.focus.call_count,4)
        r.adb.assert_not_called()

    def test_result_also_recovers_sleep_that_occurs_during_ocr(self):
        r=self.runner();search=lookup.ALIPAY_PACKAGE+'/com.alipay.android.phone.businesscommon.globalsearch.ui.MainSearchActivity'
        r.focus_components.side_effect=[(search,search),('mCurrentFocus=Window{x u0 NotificationShade}',search),(search,search)]
        r.exact_search_activity_visible=lookup.Runner.exact_search_activity_visible
        r.wake_before_query_if_asleep=mock.Mock(return_value=True)
        r.poco_result_snapshot=mock.Mock(side_effect=[object(),RuntimeError('fixture-post-ocr-reobserve')])
        with mock.patch.object(visual,'recognize',return_value=([],(720,1600))),mock.patch.object(visual,'parse_rows',return_value={'notFound':False,'realNameTailCharacter':'甲'}),mock.patch.object(visual,'protection',return_value=None):
            with self.assertRaisesRegex(RuntimeError,'fixture-post-ocr-reobserve'):
                r.poco_visual_result_readonly(mock.Mock(),'13800000000',time.perf_counter()+60)
        r.wake_before_query_if_asleep.assert_called_once_with(deadline=mock.ANY)
        self.assertEqual(r.poco_result_snapshot.call_count,2)
        r.adb.assert_called_once()
        self.assertEqual(r.adb.call_args.args[0],['exec-out','screencap','-p'])

    def test_display_may_sleep_again_during_ocr_without_reinput_or_new_deadline(self):
        r=self.runner();search=lookup.ALIPAY_PACKAGE+'/com.alipay.android.phone.businesscommon.globalsearch.ui.MainSearchActivity'
        shade=('mCurrentFocus=Window{x u0 NotificationShade}','mFocusedApp=null')
        r.focus_components.side_effect=[shade,(search,search),shade,(search,search)]
        r.exact_search_activity_visible=lookup.Runner.exact_search_activity_visible
        r.wake_before_query_if_asleep=mock.Mock(return_value=True)
        r.poco_result_snapshot=mock.Mock(side_effect=[object(),RuntimeError('fixture-recheck-after-second-wake')])
        deadline=time.perf_counter()+60
        with mock.patch.object(visual,'recognize',return_value=([],(720,1600))),mock.patch.object(visual,'parse_rows',return_value={'notFound':False,'realNameTailCharacter':'甲'}),mock.patch.object(visual,'protection',return_value=None):
            with self.assertRaisesRegex(RuntimeError,'fixture-recheck-after-second-wake'):
                r.poco_visual_result_readonly(mock.Mock(),'13800000000',deadline)
        self.assertEqual(r.wake_before_query_if_asleep.call_args_list,[mock.call(deadline=deadline)]*2)
        self.assertEqual(r.adb.call_count,1)
        self.assertEqual(r.adb.call_args.args[0],['exec-out','screencap','-p'])

    def test_repeated_sleep_has_three_wake_limit_and_cannot_return_a_result(self):
        r=self.runner();search=lookup.ALIPAY_PACKAGE+'/com.alipay.android.phone.businesscommon.globalsearch.ui.MainSearchActivity'
        shade=('mCurrentFocus=Window{x u0 NotificationShade}','mFocusedApp=null')
        r.focus_components.side_effect=[shade,(search,search)]*3+[shade]
        r.exact_search_activity_visible=lookup.Runner.exact_search_activity_visible
        r.wake_before_query_if_asleep=mock.Mock(return_value=True)
        r.poco_result_snapshot=mock.Mock(return_value=object())
        with mock.patch.object(visual,'recognize',return_value=([],(720,1600))),mock.patch.object(visual,'parse_rows',return_value={'notFound':False,'realNameTailCharacter':'甲'}),mock.patch.object(visual,'protection',return_value=None),mock.patch.object(lookup.time,'sleep'):
            with self.assertRaisesRegex(RuntimeError,'foreground_changed'):
                r.poco_visual_result_readonly(mock.Mock(),'13800000000',time.perf_counter()+60)
        self.assertEqual(r.wake_before_query_if_asleep.call_count,3)
        self.assertTrue(all(c.args[0]==['exec-out','screencap','-p'] for c in r.adb.call_args_list))

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

    def test_failure_frames_contain_code_locations_without_source_or_locals(self):
        with mock.patch.object(lookup.Runner, "run_poco", side_effect=RuntimeError("fixture")):
            result = lookup.run_poco_operation({"serial": "fixture"}, mock.Mock())
        frames = result["log"][-1]["failureFrames"]
        self.assertTrue(frames)
        self.assertLessEqual(len(frames), 12)
        for frame in frames:
            self.assertEqual(set(frame), {"file", "function", "line"})
            self.assertNotIn("/", frame["file"])
            self.assertIsInstance(frame["line"], int)

    def test_initial_home_budget_is_once_and_restored_before_other_reads(self):
        from types import SimpleNamespace
        seen=[]
        def original(request, timeout=None): seen.append(timeout)
        transport=SimpleNamespace(send=original)
        p=SimpleNamespace(_agent=SimpleNamespace(client=SimpleNamespace(transport=transport)))
        class Target:
            def __len__(self):
                transport.send("query")
                transport.send("async", timeout=.1)
                return 1
        r=lookup.Runner({"serial":"fixture"})
        self.assertEqual(r.poco_initial_home_search_count(p,Target()),1)
        self.assertIs(transport.send,original)
        self.assertEqual(r.poco_initial_home_search_count(p,Target()),1)
        self.assertEqual(seen,[4.0,.1,None,.1])

    def test_initial_home_budget_restores_on_timeout_without_retrying(self):
        from types import SimpleNamespace
        calls=[]
        def original(request, timeout=None):
            calls.append(timeout)
            raise TimeoutError("Read timed out")
        transport=SimpleNamespace(send=original)
        p=SimpleNamespace(_agent=SimpleNamespace(client=SimpleNamespace(transport=transport)))
        class Target:
            def __len__(self): transport.send("query");return 1
        r=lookup.Runner({"serial":"fixture"})
        with self.assertRaises(TimeoutError):r.poco_initial_home_search_count(p,Target())
        self.assertIs(transport.send,original)
        self.assertEqual(calls,[4.0])

    def test_query_wake_only_for_confirmed_asleep_or_dozing(self):
        for state in ["Asleep", "Dozing"]:
            r=lookup.Runner({"serial":"fixture"})
            r.adb=mock.Mock(side_effect=["mWakefulness="+state,"mWakefulness=Awake"])
            r.wake_and_unlock_for_lookup_start=mock.Mock()
            self.assertTrue(r.wake_before_query_if_asleep())
            r.wake_and_unlock_for_lookup_start.assert_called_once()
            self.assertTrue(all(c.args[0]==["shell","dumpsys","power"] for c in r.adb.call_args_list))
        r=lookup.Runner({"serial":"fixture"})
        r.adb=mock.Mock(return_value="mWakefulness=Awake")
        r.wake_and_unlock_for_lookup_start=mock.Mock()
        self.assertFalse(r.wake_before_query_if_asleep())
        r.wake_and_unlock_for_lookup_start.assert_not_called()

    def test_unknown_wakefulness_or_unconfirmed_wake_cannot_continue(self):
        for outputs in [["unknown"],["mWakefulness=Dreaming"],["mWakefulness=Dozing","mWakefulness=Dozing"]]:
            r=lookup.Runner({"serial":"fixture"})
            r.adb=mock.Mock(side_effect=outputs)
            r.wake_and_unlock_for_lookup_start=mock.Mock()
            with self.assertRaisesRegex(RuntimeError,"wakefulness_unconfirmed"):
                r.wake_before_query_if_asleep()
            self.assertEqual(r.wake_and_unlock_for_lookup_start.call_count,1 if len(outputs)==2 else 0)

    def test_result_wake_respects_original_deadline_without_starting_late_commands(self):
        r=lookup.Runner({'serial':'fixture'});r.adb=mock.Mock(return_value='mWakefulness=Awake')
        with mock.patch.object(lookup.time,'perf_counter',return_value=100):
            with self.assertRaisesRegex(RuntimeError,'observation_budget_exhausted'):
                r.wake_before_query_if_asleep(deadline=100.1)
            r.adb.assert_not_called()
            self.assertFalse(r.wake_before_query_if_asleep(deadline=100.75))
            r.adb.assert_called_once_with(['shell','dumpsys','power'],timeout=.75)

    def test_missing_dependency_requires_successful_empty_package_list(self):
        with mock.patch.object(worker, "run_adb", side_effect=[RuntimeError("adb exited 1"), ""]) as call:
            with self.assertRaisesRegex(RuntimeError, "^poco_service_not_installed$"):
                worker.verify_poco_service_installed("adb", "fixture")
        self.assertEqual(call.call_count, 2)
        self.assertEqual(call.call_args.args[2], ["shell", "pm", "list", "packages", "com.netease.open.pocoservice"])
        self.assertTrue(all(c.kwargs["timeout"] == 4 for c in call.call_args_list))

    def test_dependency_transport_errors_do_not_become_missing_package(self):
        for error in [RuntimeError("device unauthorized"), RuntimeError("device offline"), subprocess.TimeoutExpired([], 4)]:
            with mock.patch.object(worker, "run_adb", side_effect=error) as call:
                with self.assertRaises(type(error)) as caught:
                    worker.verify_poco_service_installed("adb", "fixture")
            self.assertIs(caught.exception, error)
            self.assertEqual(call.call_count, 1)
        for listed in ["package:com.netease.open.pocoservice", "Error: package manager unavailable"]:
            with mock.patch.object(worker, "run_adb", side_effect=[RuntimeError("adb exited 1"), listed]):
                with self.assertRaisesRegex(RuntimeError, "^adb exited 1$"):
                    worker.verify_poco_service_installed("adb", "fixture")
        with mock.patch.object(worker, "run_adb", side_effect=[RuntimeError("adb exited 1"), subprocess.TimeoutExpired([], 4)]):
            with self.assertRaises(subprocess.TimeoutExpired):
                worker.verify_poco_service_installed("adb", "fixture")

    def test_existing_dependency_and_unconfirmed_path(self):
        with mock.patch.object(worker, "run_adb", return_value="package:/data/app/fixture/base.apk") as call:
            worker.verify_poco_service_installed("adb", "fixture")
        self.assertEqual(call.call_count, 1)
        with mock.patch.object(worker, "run_adb", return_value=""):
            with self.assertRaisesRegex(RuntimeError, "poco_service_path_unconfirmed"):
                worker.verify_poco_service_installed("adb", "fixture")

    def test_instrumentation_failure_keeps_precise_safe_stage(self):
        for error, cause in [(RuntimeError("poco_service_not_installed"), "dependency_missing"), (RuntimeError("adb exited 1"), "command_failed")]:
            with contextlib.redirect_stderr(io.StringIO()):
                with self.assertRaisesRegex(RuntimeError, "^poco_worker_bootstrap_failed:instrumentation:" + cause + "$"):
                    worker.reader_bootstrap_stage("instrumentation", mock.Mock(side_effect=error))

if __name__=="__main__":unittest.main()

class FullTreeBudgetTests(unittest.TestCase):
    def fixture(self):
        from types import SimpleNamespace
        r=lookup.Runner({'serial':'fixture'});r.emit=mock.Mock()
        send=mock.Mock(return_value='reply')
        t=SimpleNamespace(send=send)
        p=SimpleNamespace(_agent=SimpleNamespace(client=SimpleNamespace(transport=t)))
        return r,p,t,send

    def test_multiple_snapshot_rpcs_share_budget_and_restore_selector_transport(self):
        r,p,t,send=self.fixture();now=[100.]
        def freeze():
            t.send('first');now[0]+=3;t.send('second',timeout=9);return 'tree'
        with mock.patch.object(lookup.time,'perf_counter',side_effect=lambda:now[0]):
            self.assertEqual(r.poco_bounded_full_snapshot(p,freeze),'tree')
        self.assertEqual(send.call_args_list,[mock.call('first',timeout=5.),mock.call('second',timeout=2.)])
        self.assertIs(t.send,send);t.send('selector');self.assertEqual(send.call_args,mock.call('selector'))

    def test_original_query_deadline_shorter_than_tree_budget_is_respected(self):
        r,p,t,send=self.fixture();r._query_snapshot_deadline=101.
        with mock.patch.object(lookup.time,'perf_counter',return_value=100.):
            r.poco_bounded_full_snapshot(p,lambda:t.send('tree'))
        send.assert_called_once_with('tree',timeout=1.);self.assertIs(t.send,send)

    def test_expired_query_does_not_send_or_retry(self):
        r,p,t,send=self.fixture();r._query_snapshot_deadline=99.
        with mock.patch.object(lookup.time,'perf_counter',return_value=100.),self.assertRaisesRegex(TimeoutError,'snapshot budget exhausted'):
            r.poco_bounded_full_snapshot(p,lambda:t.send('tree'))
        send.assert_not_called();self.assertIs(t.send,send)

    def test_transport_failure_is_propagated_without_retry_and_restores(self):
        r,p,t,send=self.fixture();send.side_effect=TimeoutError('fixture')
        with self.assertRaisesRegex(TimeoutError,'fixture'):
            r.poco_bounded_full_snapshot(p,lambda:t.send('tree',timeout=.2))
        send.assert_called_once_with('tree',timeout=.2);self.assertIs(t.send,send)

    def test_operation_wrapper_restores_freeze_on_success_and_failure(self):
        from types import SimpleNamespace
        for failure in [False,True]:
            freeze=mock.Mock(return_value='tree');p=SimpleNamespace(freeze=freeze)
            def operation(r,poco):
                self.assertEqual(poco.freeze(),'tree')
                if failure:raise RuntimeError('fixture')
                return {'ok':True}
            with mock.patch.object(lookup.Runner,'run_poco',operation):
                result=lookup.run_poco_operation({'serial':'fixture'},p)
            self.assertEqual(result['ok'],not failure);self.assertIs(p.freeze,freeze);freeze.assert_called_once()

    def test_late_tree_cannot_be_accepted_after_query_deadline(self):
        r,p,t,send=self.fixture();r._query_snapshot_deadline=101.;now=[100.]
        def freeze():now[0]=102.;return 'late-tree'
        with mock.patch.object(lookup.time,'perf_counter',side_effect=lambda:now[0]),self.assertRaisesRegex(TimeoutError,'completed after deadline'):
            r.poco_bounded_full_snapshot(p,freeze)
        self.assertIs(t.send,send)
