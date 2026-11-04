import contextlib
from pathlib import Path
from types import SimpleNamespace
import textwrap
import unittest
import wecom_platform_preview as host
import wecom_invite_preview as w
import wecom_startup_guards as startup
from test_wecom_invite_preview import HOME

BLANK=w.Screen(w.PACKAGE,())
SPLASH=(w.PACKAGE,0,w.PACKAGE+'/.launch.LaunchSplashActivity')


class SplashWaitTests(unittest.TestCase):
    def run_navigation(self,*,number='25',home_after=6,activity_change=None):
        raw=Path(host.__file__).read_text()
        start=raw.index('        with trace.phase("home_navigation", 60, "home_navigation_timeout"):')
        end=raw.index('        remaining=min(120',start)
        block=textwrap.dedent(raw[start:end]);clock=[0.];reads=[];last=[BLANK];captures=[]
        def snapshot():
            reads.append(1);clock[0]+=1
            last[0]=HOME if home_after is not None and len(reads)>home_after else BLANK
            return last[0]
        def fg():
            if activity_change and len(reads)>=activity_change:return(w.PACKAGE,0,w.PACKAGE+'/.OtherActivity')
            return(w.PACKAGE,0,w.PACKAGE+'/.MainActivity')if last[0]is HOME else SPLASH
        def capture(*args):captures.append(1);return True
        def no_write(*args):self.fail('no key, click or startup replay permitted')
        env=dict(trace=SimpleNamespace(phase=lambda*a:contextlib.nullcontext()),deadline=210,
            time=SimpleNamespace(monotonic=lambda:clock[0],sleep=lambda s:clock.__setitem__(0,clock[0]+s)),
            budget=lambda:None,driver=SimpleNamespace(snapshot=snapshot),any_snapshot=lambda p:last[0],poco=object(),
            authority=SimpleNamespace(observe_page=lambda*a:None,observe_blank_screen=capture),
            w=w,startup=startup,config={'deviceNumber':number,'phoneNumber':'19900000001'},selected_user=0,
            foreground_info=fg,foreground=lambda:w.PACKAGE,SafeStop=host.SafeStop,
            startup_click=no_write,mutate=no_write,calls=SimpleNamespace(call=lambda*a:contextlib.nullcontext()))
        return lambda:exec(compile(block,'<actual-home-navigation>','exec'),env),env,reads,captures,clock

    def test_actual_loop_allows_confirmed25_splash_to_settle_without_empty_frame_abort(self):
        run,env,reads,captures,_=self.run_navigation()
        run();self.assertTrue(env['home']);self.assertGreater(len(reads),6);self.assertFalse(captures)

    def test_permanent_splash_still_expires_in_original60_second_budget(self):
        run,_,_,captures,clock=self.run_navigation(home_after=None)
        with self.assertRaisesRegex(w.StopPreview,'home_navigation_timeout'):run()
        self.assertFalse(captures);self.assertLess(clock[0],62)

    def test_other_device_or_activity_change_retains_original_unknown_page_stop(self):
        for kwargs in [dict(number='145',home_after=None),dict(home_after=None,activity_change=4)]:
            run,_,_,captures,_=self.run_navigation(**kwargs)
            with self.assertRaisesRegex(w.StopPreview,'qa_empty_page_captured'):run()
            self.assertEqual(captures,[1])

    def test_only_exact25_main_blank_splash_is_recognized(self):
        self.assertTrue(startup.is_observed_25_loading('25',0,SPLASH,BLANK))
        for number,user,current,page in [('25',999,SPLASH,BLANK),('145',0,SPLASH,BLANK),
            ('25',0,(w.PACKAGE,999,SPLASH[2]),BLANK),('25',0,SPLASH,HOME),
            ('25',0,(w.PACKAGE,0,w.PACKAGE+'/.OtherActivity'),BLANK)]:
            self.assertFalse(startup.is_observed_25_loading(number,user,current,page))


if __name__=='__main__':unittest.main()
