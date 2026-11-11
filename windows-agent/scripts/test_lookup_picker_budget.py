import unittest
import subprocess
from unittest import mock
import alipay_name_lookup as lookup
from test_lookup_account_picker_transition import tree

class PickerBudgetTests(unittest.TestCase):
    def test_slow_first_sample_cannot_consume_second_sample_budget(self):
        r=lookup.Runner({'serial':'SYNTHETIC','taskId':'budget'});clock=[0.0];calls=[];root=tree()
        def dump(token,**kw):
            calls.append(kw);clock[0]+=7.5
            return root,{c:p for p in root.iter() for c in p}
        r.dump=dump;r.emit=mock.Mock();r.adb=mock.Mock()
        with mock.patch.object(lookup.time,'monotonic',side_effect=lambda:clock[0]),mock.patch.object(lookup.time,'sleep',side_effect=lambda n:clock.__setitem__(0,clock[0]+n)):
            rows=r.wait_account_picker('budget',timeout=24)
        self.assertEqual(len(rows),2);self.assertEqual(len(calls),2)
        self.assertTrue(all(x['total_timeout']<=10 for x in calls));r.adb.assert_not_called()

    def test_full_dump_budget_bounds_mkdir_command_and_read(self):
        r=lookup.Runner({'serial':'SYNTHETIC','taskId':'budget'});clock=[0.0];seen=[]
        def adb(args,**kw):
            seen.append(kw['timeout']);clock[0]+=kw['timeout'];return b'' if kw.get('binary') else ''
        r.adb=adb
        with mock.patch.object(lookup.time,'monotonic',side_effect=lambda:clock[0]):
            with self.assertRaisesRegex(RuntimeError,'sample_timeout'):r.dump('budget',total_timeout=4)
        self.assertEqual(seen,[4]);self.assertEqual(clock[0],4)

    def test_one_valid_frame_followed_by_timeout_never_clicks(self):
        r=lookup.Runner({'serial':'SYNTHETIC','taskId':'budget'});clock=[0.0];n=[0];root=tree()
        def dump(token,**kw):
            n[0]+=1;clock[0]+=kw['total_timeout']
            if n[0]>1:raise subprocess.TimeoutExpired('synthetic',kw['total_timeout'])
            return root,{c:p for p in root.iter() for c in p}
        r.dump=dump;r.emit=mock.Mock();r.adb=mock.Mock()
        with mock.patch.object(lookup.time,'monotonic',side_effect=lambda:clock[0]),mock.patch.object(lookup.time,'sleep',side_effect=lambda n:clock.__setitem__(0,clock[0]+n)):
            with self.assertRaisesRegex(RuntimeError,'picker_not_stable'):r.wait_account_picker('budget',timeout=8)
        r.adb.assert_not_called();self.assertLessEqual(clock[0],8)

    def test_transport_failure_is_not_hidden_as_unstable_list(self):
        r=lookup.Runner({'serial':'SYNTHETIC'});r.dump=mock.Mock(side_effect=RuntimeError('device offline'));r.emit=mock.Mock()
        with self.assertRaisesRegex(RuntimeError,'device offline'):r.wait_account_picker('offline')

    def test_timed_out_dump_is_followed_by_two_complete_reads_without_reopening(self):
        import xml.etree.ElementTree as ET
        r=lookup.Runner({'serial':'SYNTHETIC','taskId':'budget'});clock=[0.0];commands=[];hung=[False]
        raw=ET.tostring(tree())
        def adb(args,**kw):
            commands.append(args)
            if args[:3]==['shell','uiautomator','dump']:
                if not hung[0]:
                    hung[0]=True;clock[0]+=kw['timeout'];raise subprocess.TimeoutExpired('synthetic',kw['timeout'])
                clock[0]+=2.5;return ''
            clock[0]+=.1
            return raw if args[:2]==['exec-out','cat'] else ''
        r.adb=adb;r.emit=mock.Mock()
        with mock.patch.object(lookup.time,'monotonic',side_effect=lambda:clock[0]),mock.patch.object(lookup.time,'sleep',side_effect=lambda n:clock.__setitem__(0,clock[0]+n)):
            rows=r.wait_account_picker('budget',timeout=24)
        self.assertEqual(len(rows),2);self.assertLess(clock[0],24)
        self.assertEqual(sum(a[:3]==['shell','uiautomator','dump'] for a in commands),3)
        self.assertFalse(any('input' in a for a in commands))

    def test_actual_dump_with_seven_second_command_produces_two_stable_frames(self):
        import xml.etree.ElementTree as ET
        r=lookup.Runner({'serial':'SYNTHETIC','taskId':'slow-picker'});clock=[0.0];commands=[];raw=ET.tostring(tree())
        def adb(args,**kw):
            commands.append(args)
            elapsed=7.5 if args[:3]==['shell','uiautomator','dump'] else .1
            if kw['timeout']<elapsed:
                clock[0]+=kw['timeout'];raise subprocess.TimeoutExpired('synthetic',kw['timeout'])
            clock[0]+=elapsed
            return raw if args[:2]==['exec-out','cat'] else ''
        r.adb=adb;r.emit=mock.Mock()
        with mock.patch.object(lookup.time,'monotonic',side_effect=lambda:clock[0]),mock.patch.object(lookup.time,'sleep',side_effect=lambda n:clock.__setitem__(0,clock[0]+n)):
            rows=r.wait_account_picker('slow',timeout=24)
        self.assertEqual(len(rows),2);self.assertLess(clock[0],24)
        self.assertEqual(sum(a[:3]==['shell','uiautomator','dump'] for a in commands),2)
        self.assertFalse(any('input' in a for a in commands))

    def test_no_completed_frame_reports_read_timeout_not_unstable_accounts(self):
        r=lookup.Runner({'serial':'SYNTHETIC'});clock=[0.0]
        def dump(*a,**kw):
            clock[0]+=kw['total_timeout'];raise subprocess.TimeoutExpired('synthetic',kw['total_timeout'])
        r.dump=dump;r.emit=mock.Mock();r.adb=mock.Mock()
        with mock.patch.object(lookup.time,'monotonic',side_effect=lambda:clock[0]),mock.patch.object(lookup.time,'sleep',side_effect=lambda n:clock.__setitem__(0,clock[0]+n)):
            with self.assertRaisesRegex(RuntimeError,'alipay_account_picker_read_timeout'):r.wait_account_picker('slow',timeout=24)
        self.assertLessEqual(clock[0],24);r.adb.assert_not_called()

    def test_transitional_frame_does_not_halve_next_real_dump_budget(self):
        import xml.etree.ElementTree as ET
        r=lookup.Runner({'serial':'SYNTHETIC'});clock=[0.0];calls=[];root=tree()
        def dump(token,**kw):
            calls.append(kw['total_timeout']);duration=7.5
            if kw['total_timeout']<duration:
                clock[0]+=kw['total_timeout'];raise subprocess.TimeoutExpired('synthetic',kw['total_timeout'])
            clock[0]+=duration
            page=ET.fromstring('<hierarchy/>') if len(calls)==1 else root
            return page,{c:p for p in page.iter() for c in p}
        r.dump=dump;r.emit=mock.Mock();r.page_overlay_kind=lambda **kw:None;r.recover_page_mismatch=lambda *a,**kw:False;r.adb=mock.Mock()
        with mock.patch.object(lookup.time,'monotonic',side_effect=lambda:clock[0]),mock.patch.object(lookup.time,'sleep',side_effect=lambda n:clock.__setitem__(0,clock[0]+n)):
            self.assertEqual(len(r.wait_account_picker('transition',timeout=24)),2)
        self.assertEqual(len(calls),3);self.assertGreaterEqual(min(calls),7.5);self.assertLess(clock[0],24);r.adb.assert_not_called()

class PickerImmediateProofTests(unittest.TestCase):
    def setUp(self):
        self.r=lookup.Runner({'serial':'SYNTHETIC','taskId':'picker-proof'})
        self.clock=0.0;self.frames=[];self.calls=0
        self.r.emit=mock.Mock();self.r.page_overlay_kind=lambda **kw:None
        self.r.recover_page_mismatch=lambda *a,**kw:False
        def dump(*args,**kw):
            self.calls+=1;self.clock+=7.0
            frame=self.frames.pop(0) if self.frames else tree()
            if isinstance(frame,Exception):raise frame
            return frame,{c:p for p in frame.iter() for c in p}
        self.r.dump=dump
        self.time=mock.patch.object(lookup.time,'monotonic',side_effect=lambda:self.clock)
        self.sleep=mock.patch.object(lookup.time,'sleep',side_effect=lambda n:setattr(self,'clock',self.clock+n))
        self.time.start();self.sleep.start();self.addCleanup(self.time.stop);self.addCleanup(self.sleep.stop)

    def verified(self):
        self.assertEqual(len(self.r.wait_account_picker('first')),2)
        self.assertEqual(self.calls,2)

    def test_immediate_rotation_matches_one_new_complete_frame(self):
        self.verified();self.r.reuse_open_account_picker('rotation')
        self.assertEqual(self.calls,3)

    def test_separate_invocation_still_requires_two_fresh_frames(self):
        self.r.reuse_open_account_picker('manual')
        self.assertEqual(self.calls,2)

    def test_expired_proof_requires_two_fresh_frames(self):
        self.verified();self.clock+=1.01;self.r.reuse_open_account_picker('expired')
        self.assertEqual(self.calls,4)

    def test_intervening_adb_call_invalidates_even_when_it_fails(self):
        self.verified()
        with mock.patch.object(lookup.subprocess,'run',side_effect=subprocess.TimeoutExpired('synthetic',1)):
            with self.assertRaises(subprocess.TimeoutExpired):self.r.adb(['shell','echo','observation'],timeout=1)
        self.r.reuse_open_account_picker('after-command');self.assertEqual(self.calls,4)

    def test_changed_current_marker_or_positions_requires_two_new_matching_frames(self):
        for changed in (tree(current='B'),tree(y=400)):
            self.calls=0;self.r._account_picker_proof=None;self.verified()
            self.frames=[changed,changed];self.r.reuse_open_account_picker('changed')
            self.assertEqual(self.calls,4)

    def test_incomplete_frame_discards_prior_proof(self):
        self.verified();self.frames=[tree(rows=False),tree(),tree()]
        self.r.reuse_open_account_picker('partial');self.assertEqual(self.calls,5)

    def test_failed_reuse_cannot_leave_a_proof_for_next_attempt(self):
        self.verified();self.frames=[subprocess.TimeoutExpired('synthetic',7)]
        with self.assertRaises(RuntimeError):self.r.reuse_open_account_picker('timeout',timeout=8)
        self.assertIsNone(self.r._account_picker_proof)
        before=self.calls;self.r.reuse_open_account_picker('retry');self.assertEqual(self.calls-before,2)

    def test_regular_wait_does_not_consume_prior_proof(self):
        self.verified();self.r.wait_account_picker('independent');self.assertEqual(self.calls,4)

class PickerPreparationRetryTests(unittest.TestCase):
    def runner(self, cooling=False):
        from test_lookup_account_cooldown import AccountCooldownTests
        r=AccountCooldownTests().runner(**({'accountCooldowns':[{'account':'A','cooldownUntil':'2099-01-01T00:00:00Z'}]} if cooling else {}))
        root=tree();r.dump.return_value=(root,{c:p for p in root.iter() for c in p})
        picker=lookup.ALIPAY_PACKAGE+'/com.alipay.mobile.security.accountmanager.ui.AccountManagerV2Activity'
        r.focus_state=mock.Mock(return_value=('', 'mCurrentFocus=Window{a u0 '+picker+'}', 'mFocusedApp=ActivityRecord{a u0 '+picker+'}'))
        return r

    @mock.patch.object(lookup.time,'sleep')
    def test_visible_picker_retry_revalidates_without_relaunching_entry(self,_):
        r=self.runner();r.prepare_available_account()
        self.assertEqual(r.dump.call_count,3)
        r.open_account_picker.assert_not_called()
        r.launch.assert_called_once_with('account-preflight-complete')

    @mock.patch.object(lookup.time,'sleep')
    def test_visible_picker_does_not_skip_current_cooldown(self,_):
        r=self.runner(True);r.prepare_available_account()
        r.switch_account.assert_called_once_with(reason='cooldown',excluded_accounts={'A'},reuse_open_picker=True,verify_current_marker=True)
        r.open_account_picker.assert_not_called()

    @mock.patch.object(lookup.time,'sleep')
    def test_mismatched_foreground_cannot_reuse_underlying_rows(self,_):
        r=self.runner();r.focus_state.return_value=('', 'mCurrentFocus=Window{a u0 com.android.systemui/.Overlay}', '')
        r.prepare_available_account()
        r.open_account_picker.assert_called_once_with('preflight')
        self.assertEqual(r.dump.call_count,1)
