import unittest
import wecom_startup_guards as g
import wecom_invite_preview as w
from unittest.mock import patch
import wecom_platform_preview as host

class WakeSettlingTests(unittest.TestCase):
    def test_delayed_awake_only_repeats_reads_not_wake_or_dismiss(self):
        states=iter(('mWakefulness=Asleep','mWakefulness=Dozing','mWakefulness=Awake'));reads=[];sleeps=[]
        def read():reads.append(1);return next(states)
        self.assertTrue(g.confirm_awake(read,lambda:True,sleep=sleeps.append))
        self.assertEqual(len(reads),3);self.assertEqual(sleeps,[.2,.2])
    def test_unknown_state_stops_without_wait_or_other_read(self):
        reads=[]
        def read():reads.append(1);return 'unknown'
        with self.assertRaisesRegex(w.StopPreview,'screen_wake_not_confirmed'):g.confirm_awake(read,lambda:True,sleep=lambda _:self.fail('no wait'))
        self.assertEqual(len(reads),1)
    def test_sleep_is_bounded_to_four_reads(self):
        reads=[]
        def read():reads.append(1);return 'mWakefulness=Asleep'
        with self.assertRaisesRegex(w.StopPreview,'screen_wake_not_confirmed'):g.confirm_awake(read,lambda:True,sleep=lambda _:None)
        self.assertEqual(len(reads),4)
    def test_cancel_expired_budget_or_lost_lease_stops_observation(self):
        for code in ('cancelled','screen_prepare_timeout'):
            def budget():raise w.StopPreview(code)
            with self.assertRaisesRegex(w.StopPreview,code):g.confirm_awake(lambda:self.fail('no read'),lambda:True,check_budget=budget)
        with self.assertRaisesRegex(w.StopPreview,'device_lease_lost'):g.confirm_awake(lambda:self.fail('no read'),lambda:False)

    def test_real_host_one_wake_waits_for_delayed_power_confirmation(self):
        calls=[];states=iter(('mWakefulness=Asleep','mWakefulness=Asleep','mWakefulness=Awake'))
        def shell(command):
            calls.append(command)
            return next(states)if command=='dumpsys power'else ''
        with patch.object(host,'config',{'deviceNumber':'43'},create=True),patch.object(host,'external_authority',None),patch.object(host,'shell',side_effect=shell),patch.object(host,'lease_valid',return_value=True),patch.object(host,'budget'):
            self.assertTrue(host.prepare_screen_before_poco())
        self.assertEqual(calls.count('input keyevent 224'),1);self.assertEqual(calls.count('wm dismiss-keyguard'),1)
        self.assertEqual(calls.count('dumpsys power'),3)

if __name__=='__main__':unittest.main()
