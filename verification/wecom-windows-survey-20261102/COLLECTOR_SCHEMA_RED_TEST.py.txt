"""Offline regression for the collector's lost-failure-body defect. No SSH."""
import json
import contextlib
import io
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
from collect_clock_supplement import classify
import collect_clock_supplement as collector


def base():
    value = dict(scope='readonly-clock-observation', authoritySupported=False,
                 nativeExecutionPermitted=False, physicalCleanupVerified=False,
                 pid=1234, sampleLimit=16,
                 executionContext='inherited-SSH-user; not a SYSTEM worker test')
    return value


def header():
    return dict(windowsVersion={'major':10,'minor':0,'build':19045}, pointerBits=64,
        ownCreationFileTime100ns='133000000000000000', qpcFrequency='10000000',
        adjustmentObservation={'amount100ns':'156250','increment100ns':'156250','periodicAdjustmentDisabled':True},
        selectedApis=['GetTickCount64','QueryUnbiasedInterruptTimePrecise','GetSystemTimePreciseAsFileTime'],
        bootIdentityConfirmed=False, physicalOrVmConfirmed=False,
        units={'boot':'milliseconds','work':'100ns','wall':'FILETIME-100ns-since-1601','qpc':'ticks; frequency-per-second'})


def failure(**changes):
    value = dict(base(), status='unsupported_api_or_read_failure', failedStage='bind_readonly_apis',
                 errorType='AttributeError', windowsError=127)
    value.update(changes)
    return value


def response(**changes):
    value = dict(base(), **header(), status='observed_not_authority', samples=[],anomalies=[],
        limitations=['Sixteen back-to-back reads, not drift/error calibration.',
                     'Nominal increment/resolution is not a hard uncertainty bound.',
                     'No suspend, hibernation, VM freeze or migration test.',
                     'No cross-process journal, SYSTEM child or socket-peer proof.',
                     'Current-process birth is audit data, not an old task repair.'])
    value.update(changes)
    return value


class ClassificationTests(unittest.TestCase):
    def setUp(self):
        for name in ('subprocess.Popen', 'subprocess.run', 'socket.create_connection'):
            guard = patch(name, side_effect=AssertionError('offline_no_transport'))
            guard.start()
            self.addCleanup(guard.stop)

    def test_valid_failure_retains_body_and_exact_phase_before_stopping(self):
        value = failure()
        result, retained = classify(json.dumps(value).encode())
        self.assertEqual(retained, value)
        self.assertEqual(result, dict(classification='observed_unsupported_or_api_failure',
                                     failedStage='bind_readonly_apis', errorType='AttributeError', windowsError=127))

    def test_success_is_still_observation_without_a_native_permit(self):
        value = response()
        result, retained = classify(json.dumps(value).encode())
        self.assertEqual(result['classification'], 'observed_not_authority')
        self.assertFalse(retained['nativeExecutionPermitted'])

    def test_non_json_has_distinct_classification_not_api_unsupported(self):
        result, retained = classify(b'fixture shell banner\n')
        self.assertEqual(result['classification'], 'not_json')
        self.assertIn('errorLine', result)
        self.assertIsNone(retained)

    def test_invalid_encoding_has_its_own_reason(self):
        self.assertEqual(classify(b'\xff')[0]['classification'], 'invalid_utf8')

    def test_json_null_array_and_primitives_are_rejected_without_exceptions(self):
        for value in (None, [], True, 3, 'fixture'):
            result, retained = classify(json.dumps(value).encode())
            self.assertEqual(result['classification'], 'non_whitelisted_shape')
            self.assertIsNone(retained)

    def test_unknown_fields_cannot_enter_saved_body(self):
        value = response(unexpected='fixture')
        self.assertEqual(classify(json.dumps(value).encode())[0]['classification'], 'non_whitelisted_shape')

    def test_permission_or_scope_change_cannot_enter_saved_body(self):
        for change in ({'nativeExecutionPermitted':True}, {'authoritySupported':True}, {'scope':'other'}):
            result, retained = classify(json.dumps(response(**change)).encode())
            self.assertEqual(result['classification'], 'unexpected_scope_or_permission')
            self.assertIsNone(retained)

    def test_unknown_status_stays_unconfirmed(self):
        self.assertEqual(classify(json.dumps(response(status='fixture')).encode())[0]['classification'], 'unknown_status')

    def test_wrong_failure_and_base_types_or_unreviewed_values_are_not_retained(self):
        for change in ({'failedStage':{}}, {'failedStage':'unreviewed'}, {'errorType':42},
                       {'errorType':'unreviewed'}, {'windowsError':[]}, {'windowsError':True},
                       {'pid':'not_an_integer'}, {'pid':True}, {'pid':-1}, {'pid':2**40},
                       {'sampleLimit':17}, {'sampleLimit':True}, {'executionContext':'unreviewed'}):
            with self.subTest(field=next(iter(change))):
                result,retained=classify(json.dumps(failure(**change)).encode())
                self.assertEqual(result['classification'],'invalid_field_type_or_value')
                self.assertIsNone(retained)

    def test_malformed_nested_success_values_are_not_retained(self):
        row={'sequence':1,'qpcBefore':'1','qpcAfter':'2','bootBeforeMs':'3','bootAfterMs':'3',
             'work100ns':'4','wallBefore100ns':'5','wallAfter100ns':'6'}
        for change in ({'windowsVersion':[]}, {'pointerBits':True}, {'ownCreationFileTime100ns':str(2**64)},
                       {'qpcFrequency':'NaN'}, {'selectedApis':['unreviewed']}, {'units':{'boot':'other'}},
                       {'adjustmentObservation':{'amount100ns':'1','increment100ns':'1','periodicAdjustmentDisabled':'true'}},
                       {'samples':[dict(row,sequence=True)]}, {'samples':[dict(row,unknown='value')]},
                       {'samples':[dict(row,work100ns={})]}, {'samples':[dict(row,sequence=n+1) for n in range(17)]},
                       {'limitations':['unreviewed']}, {'anomalies':['unreviewed']}):
            with self.subTest(field=next(iter(change))):
                result,retained=classify(json.dumps(response(**change)).encode())
                self.assertEqual(result['classification'],'invalid_field_type_or_value')
                self.assertIsNone(retained)

    def test_api_failure_after_header_reads_retains_only_complete_typed_header(self):
        value=failure(failedStage='sample_paired_clocks',**header())
        result,retained=classify(json.dumps(value).encode())
        self.assertEqual(result['classification'],'observed_unsupported_or_api_failure')
        self.assertEqual(retained,value)

    def test_actual_supplement_entry_saves_failure_before_exit_and_cannot_retry(self):
        with tempfile.TemporaryDirectory(prefix='wecom-collector-test-') as folder:
            destination=Path(folder);original=b'{"fixture_original":true}\n'
            (destination/'EXECUTION_RECEIPT.json').write_bytes(original)
            source=Path(__file__).with_name('windows_clock_survey.py').read_bytes()
            transport={'exitCode':0,'failure':'','remoteCompletion':'ssh_exit_reported',
                       'stdoutBytes':1,'stderrBytes':0,'stderrSha256':'fixture','rawStderrStored':False}
            with patch.object(collector,'HERE',destination),patch.object(collector.sys,'argv',['fixture','--execute-reviewed-clock-once']),\
                 patch.object(collector.subprocess,'check_output',return_value=source),\
                 patch.object(collector,'bounded',return_value=({'stdout':json.dumps(failure()).encode(),'stderr':b''},transport)) as command,\
                 contextlib.redirect_stdout(io.StringIO()):
                with self.assertRaises(SystemExit):collector.main()
                self.assertEqual(json.loads((destination/'CLOCK_SUPPLEMENT_BODY.json').read_text()),failure())
                receipt=json.loads((destination/'CLOCK_SUPPLEMENT_RECEIPT.json').read_text())
                self.assertEqual(receipt['classification'],'observed_unsupported_or_api_failure')
                self.assertEqual((destination/'EXECUTION_RECEIPT.json').read_bytes(),original)
                with self.assertRaises(SystemExit):collector.main()
                command.assert_called_once()


if __name__ == '__main__':
    unittest.main()
