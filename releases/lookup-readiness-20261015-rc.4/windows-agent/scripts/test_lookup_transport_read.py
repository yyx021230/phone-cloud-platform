import unittest, subprocess
from unittest import mock
from types import SimpleNamespace
import alipay_name_lookup as lookup
import xhs_airtest_poco as poco

class ReadTransportTests(unittest.TestCase):
    def runner(self):
        r=lookup.Runner({'serial':'SYNTHETIC','taskId':'TEST'});r.emit=mock.Mock();return r
    def result(self,out='',err='',rc=0):return SimpleNamespace(stdout=out,stderr=err,returncode=rc)
    def test_focus_transport_error_then_success(self):
        r=self.runner()
        with mock.patch.object(lookup.subprocess,'run',side_effect=[self.result(err="error: device 'SYNTHETIC' not found",rc=1),self.result('mCurrentFocus=Window{1 p/.Home}')]) as run, mock.patch.object(lookup.time,'sleep'):
            self.assertIn('p/.Home',r.focus()[0]);self.assertEqual(run.call_count,2)
    def test_empty_screenshot_retry_is_readonly(self):
        r=self.runner();args=['exec-out','screencap','-p']
        with mock.patch.object(lookup.subprocess,'run',side_effect=[self.result(b'',b''),self.result(b'PNG-DATA',b'')]) as run,mock.patch.object(lookup.time,'sleep'):
            self.assertEqual(r.adb(args,binary=True),b'PNG-DATA');self.assertEqual(run.call_count,2)
            self.assertTrue(all(c.args[0][-3:]==args for c in run.call_args_list))
    def test_permanent_empty_screenshot_is_never_empty_result(self):
        r=self.runner()
        with mock.patch.object(lookup.subprocess,'run',return_value=self.result(b'',b'')) as run,mock.patch.object(lookup.time,'sleep'):
            with self.assertRaisesRegex(RuntimeError,'local_lookup_result_unconfirmed:adb_read_empty'):r.adb(['exec-out','screencap','-p'],binary=True)
            self.assertEqual(run.call_count,2)
    def test_permanent_focus_disconnect_is_not_empty_focus(self):
        r=self.runner()
        with mock.patch.object(lookup.subprocess,'run',return_value=self.result(err='error: device offline',rc=1)) as run,mock.patch.object(lookup.time,'sleep'):
            with self.assertRaisesRegex(RuntimeError,'local_lookup_result_unconfirmed:adb_read_unavailable'):r.focus()
            self.assertEqual(run.call_count,2)
    def test_click_input_launch_are_never_retried(self):
        for args in [['shell','input','tap','10','20'],['shell','input','text','SYNTHETIC'],['shell','am','start','-n','p/.Home']]:
            with self.subTest(args=args),mock.patch.object(lookup.subprocess,'run',return_value=self.result(err='error: device offline',rc=1)) as run:
                with self.assertRaises(RuntimeError):self.runner().adb(args)
                self.assertEqual(run.call_count,1)
    def test_timeout_does_not_double_existing_budget(self):
        with mock.patch.object(lookup.subprocess,'run',side_effect=subprocess.TimeoutExpired('adb',1)) as run:
            with self.assertRaises(subprocess.TimeoutExpired):self.runner().adb(['exec-out','screencap','-p'],timeout=1,binary=True)
            self.assertEqual(run.call_count,1)
    def test_normal_read_has_no_extra_call(self):
        with mock.patch.object(lookup.subprocess,'run',return_value=self.result('mCurrentFocus=null')) as run:
            self.assertEqual(self.runner().focus(),['mCurrentFocus=null']);self.assertEqual(run.call_count,1)

class BootstrapTransportTests(unittest.TestCase):
    def test_transient_timeout_does_not_exit_worker(self):
        node=mock.Mock();node.exists.side_effect=[TimeoutError('timed out'),False];p=mock.Mock(return_value=node)
        with mock.patch.object(poco.time,'sleep'),mock.patch.object(poco,'emit') as emit:
            self.assertGreaterEqual(poco.verify_poco_transport_ready(p),0)
            self.assertEqual(node.exists.call_count,2);self.assertTrue(emit.called)
    def test_permanent_failure_has_bounded_attempts_and_diagnostic(self):
        p=mock.Mock(side_effect=TimeoutError('timed out'))
        with mock.patch.object(poco.time,'sleep'),mock.patch.object(poco,'emit') as emit:
            with self.assertRaisesRegex(RuntimeError,'poco_worker_transport_probe_failed:timed out'):poco.verify_poco_transport_ready(p)
            self.assertEqual(p.call_count,2);self.assertIn('poco_worker_transport_probe_failed',[c.args[1] for c in emit.call_args_list])
    def test_programming_error_not_retried(self):
        p=mock.Mock(side_effect=TypeError('invalid selector'))
        with mock.patch.object(poco.time,'sleep'):
            with self.assertRaisesRegex(RuntimeError,'invalid selector'):poco.verify_poco_transport_ready(p)
            self.assertEqual(p.call_count,1)

if __name__=='__main__':unittest.main()
