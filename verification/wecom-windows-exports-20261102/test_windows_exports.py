"""Local fake-library inspection; no DLL loading, SSH or clock APIs."""
import json
import sys
import unittest
from unittest.mock import patch
import windows_exports as probe


class FakeLibrary:
    def __init__(self, faults=None):
        self.faults, self.resolved, self.calls = faults or {}, [], 0

    def __getattr__(self, name):
        if name not in probe.NAMES:
            raise AssertionError('unreviewed_export')
        self.resolved.append(name)
        fault = self.faults.get(name)
        if isinstance(fault, Exception):
            raise fault
        if fault == 'noncallable':
            return 3
        def forbidden():
            self.calls += 1
            raise AssertionError('clock_api_was_invoked')
        return forbidden


class ExportTests(unittest.TestCase):
    def setUp(self):
        for target in ('subprocess.Popen', 'socket.create_connection'):
            guard = patch(target, side_effect=AssertionError('no_transport'))
            guard.start()
            self.addCleanup(guard.stop)

    def test_exact_eight_exports_are_resolved_without_calling_any(self):
        library = FakeLibrary()
        rows = probe.inspect_exports(library)
        self.assertEqual(library.resolved, list(probe.NAMES))
        self.assertEqual(rows, [dict(name=n, present=True, errorType='none') for n in probe.NAMES])
        self.assertEqual(library.calls, 0)

    def test_missing_export_is_named_but_never_replaced_or_called(self):
        name = probe.NAMES[1]
        library = FakeLibrary({name:AttributeError('private fixture detail')})
        rows = probe.inspect_exports(library)
        self.assertEqual(rows[1], dict(name=name,present=False,errorType='AttributeError'))
        self.assertEqual(library.resolved,list(probe.NAMES))
        self.assertEqual(library.calls,0)
        self.assertNotIn('private',json.dumps(rows))

    def test_oserror_keeps_finite_type_without_raw_error_message(self):
        library = FakeLibrary({probe.NAMES[0]:OSError('private fixture error')})
        rows = probe.inspect_exports(library)
        self.assertEqual(rows[0]['errorType'],'OSError')
        self.assertFalse(rows[0]['present'])
        self.assertNotIn('private',json.dumps(rows))
        self.assertEqual(library.calls,0)

    def test_unexpected_getter_exception_is_a_controlled_observation(self):
        library = FakeLibrary({probe.NAMES[0]:RuntimeError('private')})
        rows = probe.inspect_exports(library)
        self.assertEqual(rows[0]['errorType'],'UnexpectedError')
        self.assertFalse(rows[0]['present'])
        self.assertEqual(library.calls,0)

    def test_non_function_attribute_is_not_reported_as_a_resolved_function(self):
        library = FakeLibrary({probe.NAMES[0]:'noncallable'})
        self.assertEqual(probe.inspect_exports(library)[0],
                         dict(name=probe.NAMES[0],present=False,errorType='UnexpectedError'))

    @unittest.skipIf(sys.platform=='win32','This local negative case requires non-Windows')
    def test_actual_non_windows_path_does_not_load_a_dll_or_resolve_exports(self):
        with patch.object(probe,'inspect_exports',side_effect=AssertionError('must_not_resolve')):
            value = probe.observe()
        self.assertEqual(value['status'],'unsupported_platform')
        self.assertEqual(value['exports'],[])
        self.assertEqual(value['pythonVersion']['major'],sys.version_info.major)
        self.assertEqual(value['pythonVersion']['minor'],sys.version_info.minor)
        self.assertFalse(value['nativeExecutionPermitted'])

    def test_cli_cannot_select_an_alternative_module_or_omit_explicit_operation(self):
        for args in ([],['--module','other'],['--inspect-exports','--fallback']):
            with patch.object(probe.sys,'argv',['fixture']+args),self.assertRaises(SystemExit):
                probe.main()
