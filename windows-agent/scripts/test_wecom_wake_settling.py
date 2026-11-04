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


class Observed25WakeTests(unittest.TestCase):
    asleep='mWakefulness=Asleep\nmWakefulnessChanging=false\n'
    clear='KeyguardServiceDelegate\n secure=false\n mIsShowing=false\n mCurrentUserId=0\nLooper state:'
    def call(self,read,press,**kw):
        return g.wake_observed_25_once('25',0,read,lambda:self.clear,kw.pop('lease',lambda:True),press,sleep=lambda _:None,**kw)
    def test_two_stable_frames_then_one_short_power_and_fresh_awake_confirmation(self):
        frames=iter([self.asleep,self.asleep,'mWakefulness=Awake']);keys=[]
        self.assertTrue(self.call(lambda:next(frames),lambda:keys.append('POWER')))
        self.assertEqual(keys,['POWER'])
    def test_other_device_or_android_user_has_no_reads_or_keys(self):
        for number,user in [('145',0),('25',999)]:
            with self.assertRaisesRegex(w.StopPreview,'screen_wake_not_confirmed'):
                g.wake_observed_25_once(number,user,lambda:self.fail('no read'),lambda:self.fail('no policy'),lambda:True,lambda:self.fail('no key'))
    def test_awake_or_changing_unknown_and_conflicting_power_states_never_toggle(self):
        for frames in [[self.asleep,'mWakefulness=Awake'],['mWakefulness=Awake'],['unknown'],['mWakefulness=Asleep\nmWakefulnessChanging=true'],[self.asleep+'mWakefulness=Awake']]:
            values=iter(frames)
            try:self.call(lambda:next(values),lambda:self.fail('no toggle'))
            except w.StopPreview:pass
    def test_secure_locked_or_wrong_user_never_gets_power(self):
        for text in [self.clear.replace('secure=false','secure=true'),self.clear.replace('mIsShowing=false','mIsShowing=true'),self.clear.replace('mCurrentUserId=0','mCurrentUserId=999')]:
            with self.assertRaisesRegex(w.StopPreview,'device_unlock_requires_user'):
                g.wake_observed_25_once('25',0,lambda:self.asleep,lambda:text,lambda:True,lambda:self.fail('no key'),sleep=lambda _:None)
    def test_lost_lease_or_budget_never_toggles(self):
        with self.assertRaisesRegex(w.StopPreview,'device_lease_lost'):self.call(lambda:self.asleep,lambda:self.fail('no key'),lease=lambda:False)
        def expired():raise w.StopPreview('screen_prepare_timeout')
        with self.assertRaisesRegex(w.StopPreview,'screen_prepare_timeout'):self.call(lambda:self.asleep,lambda:self.fail('no key'),check_budget=expired)
    def test_uncertain_power_delivery_and_ineffective_power_are_never_repeated(self):
        keys=[]
        def uncertain():keys.append('POWER');raise TimeoutError('fixture delivery unknown')
        with self.assertRaises(TimeoutError):self.call(lambda:self.asleep,uncertain)
        self.assertEqual(keys,['POWER']);keys=[]
        with self.assertRaisesRegex(w.StopPreview,'screen_wake_not_confirmed'):self.call(lambda:self.asleep,lambda:keys.append('POWER'))
        self.assertEqual(keys,['POWER'])
    def test_actual_host_25_uses_fallback_only_after_original_wakeup_settles_unsuccessfully(self):
        calls=[]
        def shell(command):
            calls.append(command)
            if command=='dumpsys power':return 'mWakefulness=Awake'if'input keyevent 26'in calls else self.asleep
            if command=='dumpsys window policy':return self.clear
            return ''
        with patch.object(host,'config',{'deviceNumber':'25'},create=True),patch.object(host,'selected_user',0,create=True),patch.object(host,'external_authority',None),patch.object(host,'shell',side_effect=shell),patch.object(host,'lease_valid',return_value=True),patch.object(host,'budget'),patch.object(g.time,'sleep'):
            self.assertTrue(host.prepare_screen_before_poco())
        self.assertEqual([c for c in calls if c.startswith('input keyevent')],['input keyevent 224','input keyevent 26'])
        self.assertEqual(calls.count('wm dismiss-keyguard'),1)

if __name__=='__main__':unittest.main()
