import unittest,io,json
from unittest import mock
from types import SimpleNamespace
import alipay_name_lookup as lookup

class FailureDiagnosticTests(unittest.TestCase):
    def run_failure(self,focus_error):
        r=lookup.Runner({'serial':'SYNTHETIC','taskId':'TEST'})
        r.run=mock.Mock(side_effect=RuntimeError('local_lookup_result_unconfirmed:adb_read_unavailable'))
        r.focus=mock.Mock(side_effect=focus_error) if focus_error else mock.Mock(return_value=['mCurrentFocus=null'])
        output=io.StringIO()
        with mock.patch.object(lookup,'Runner',return_value=r),mock.patch.object(lookup.argparse.ArgumentParser,'parse_args',return_value=SimpleNamespace(payload='fixture.json')),mock.patch('builtins.open',mock.mock_open(read_data='{}')),mock.patch('sys.stdout',output):
            code=lookup.main()
        result=json.loads(output.getvalue().splitlines()[-1]);return code,result,r
    def test_disconnected_evidence_does_not_hide_original_failure(self):
        code,result,r=self.run_failure(RuntimeError('secondary focus read failed'))
        self.assertEqual(code,1);self.assertEqual(result['error'],'local_lookup_result_unconfirmed:adb_read_unavailable');self.assertFalse(result['ok']);self.assertNotIn('notFound',result);r.run.assert_called_once();r.focus.assert_called_once()
        self.assertTrue(result['log'][-1]['focusUnavailable'])
    def test_available_focus_is_retained(self):
        code,result,_=self.run_failure(None);self.assertEqual(code,1);self.assertEqual(result['log'][-1]['focus'],['mCurrentFocus=null']);self.assertFalse(result['log'][-1].get('focusUnavailable',False))

if __name__=='__main__':unittest.main()
