"""Fake DLL binding differences only. No Windows, SSH, SDK or clock imports."""
import ctypes
import json
import sys
import types
import unittest
from unittest.mock import patch
import survey


class Function:
    def __init__(self,name,calls):self.name,self.calls=name,calls
    def __call__(self,*args):
        self.calls.append(self.name)
        if self.name=='GetCurrentProcess':return 1
        if self.name=='GetProcessTimes':
            for value in args[1:]:value._obj.low=100;value._obj.high=1
        elif self.name=='QueryPerformanceFrequency':args[0]._obj.value=10000000
        elif self.name=='QueryPerformanceCounter':args[0]._obj.value=len(self.calls)*100
        elif self.name==survey.UNBIASED:args[0]._obj.value=len(self.calls)*100
        elif self.name=='GetTickCount64':return 100000
        elif self.name=='GetSystemTimePreciseAsFileTime':args[0]._obj.low=100;args[0]._obj.high=1
        elif self.name=='GetSystemTimeAdjustment':
            args[0]._obj.value=156250;args[1]._obj.value=156250;args[2]._obj.value=1
        return 1


class Library:
    def __init__(self,names,calls):self.names,self.calls,self.requested=names,calls,[]
    def __getattr__(self,name):
        self.requested.append(name)
        if name not in self.names:raise AttributeError('fixture_private_symbol_error')
        return Function(name,self.calls)


class BindingTests(unittest.TestCase):
    def setUp(self):
        self.calls=[];self.kernel=Library(set(survey.NAMES)-{survey.UNBIASED},self.calls)
        self.realtime=Library({survey.UNBIASED},self.calls);self.loaded=[]
        for target in ('subprocess.Popen','socket.create_connection'):
            guard=patch(target,side_effect=AssertionError('offline_no_transport'));guard.start();self.addCleanup(guard.stop)
    def loader(self,name,**options):
        self.loaded.append((name,options))
        self.assertEqual(options,dict(use_last_error=True,winmode=0x800))
        return {survey.KERNEL:self.kernel,survey.REALTIME:self.realtime}[name]

    def test_old_kernel_only_resolution_fails_while_explicit_contract_binds_without_calls(self):
        with self.assertRaises(AttributeError):getattr(self.kernel,survey.UNBIASED)
        self.kernel.requested=[]
        functions=survey.bind_apis(self.loader)
        self.assertEqual(list(functions),list(survey.NAMES))
        self.assertNotIn(survey.UNBIASED,self.kernel.requested)
        self.assertEqual(self.realtime.requested,[survey.UNBIASED])
        self.assertEqual([name for name,_ in self.loaded],[survey.KERNEL,survey.REALTIME])
        self.assertEqual(self.calls,[])
        self.assertIsNone(functions[survey.UNBIASED].restype)
        self.assertIs(functions[survey.UNBIASED].argtypes[0]._type_,ctypes.c_uint64)
        self.assertEqual(ctypes.sizeof(survey.FILETIME),8)

    def test_contract_load_failure_stops_without_fallback_and_keeps_first_cause(self):
        cause=OSError('fixture_private_loader_error')
        def fail(name,**options):
            if name==survey.REALTIME:raise cause
            return self.loader(name,**options)
        with self.assertRaises(survey.ApiFailure) as captured:survey.bind_apis(fail)
        error=captured.exception
        self.assertIs(error.__cause__,cause)
        self.assertEqual(error.fields(),dict(failedApi=survey.UNBIASED,failedModule=survey.REALTIME,
                                             apiPhase='load_module',errorType='OSError'))
        self.assertNotIn('private',json.dumps(error.fields()));self.assertEqual(self.calls,[])

    def test_missing_contract_symbol_is_named_without_trying_kernel(self):
        self.realtime.names=set()
        with self.assertRaises(survey.ApiFailure) as captured:survey.bind_apis(self.loader)
        self.assertEqual(captured.exception.fields(),dict(failedApi=survey.UNBIASED,failedModule=survey.REALTIME,
            apiPhase='resolve_symbol',errorType='AttributeError'))
        self.assertNotIn(survey.UNBIASED,self.kernel.requested);self.assertEqual(self.calls,[])

    def test_non_function_export_cannot_be_bound(self):
        self.realtime=types.SimpleNamespace(**{survey.UNBIASED:3})
        with self.assertRaises(survey.ApiFailure) as captured:survey.bind_apis(self.loader)
        self.assertEqual(captured.exception.phase,'set_signature')
        self.assertEqual(captured.exception.fields()['errorType'],'TypeError')

    def test_fake_successful_read_path_is_still_not_clock_authority(self):
        fake_os=types.SimpleNamespace(name='nt',getpid=lambda:1234)
        fake_sys=types.SimpleNamespace(version_info=sys.version_info,
            getwindowsversion=lambda:types.SimpleNamespace(major=10,minor=0,build=19045))
        with patch.object(survey,'os',fake_os),patch.object(survey,'sys',fake_sys),\
             patch.object(survey.ctypes,'WinDLL',self.loader,create=True):
            value=survey.observe()
        self.assertEqual(value['status'],'observed_not_authority');self.assertEqual(len(value['samples']),16)
        self.assertEqual(self.calls.count(survey.UNBIASED),16)
        self.assertEqual(value['bindingPolicy'][survey.UNBIASED],survey.REALTIME)
        self.assertFalse(value['authoritySupported']);self.assertFalse(value['nativeExecutionPermitted'])

    def test_fake_read_failure_reports_exact_api_without_publishing_exception_text(self):
        functions=survey.bind_apis(self.loader)
        functions['GetProcessTimes']=lambda *args:0
        fake_os=types.SimpleNamespace(name='nt',getpid=lambda:1234)
        fake_sys=types.SimpleNamespace(version_info=sys.version_info)
        with patch.object(survey,'os',fake_os),patch.object(survey,'sys',fake_sys),\
             patch.object(survey,'bind_apis',return_value=functions):
            value=survey.observe()
        self.assertEqual(value['status'],'unsupported_api_or_read_failure')
        self.assertEqual(value['failedStage'],'read_current_process_times')
        self.assertEqual(value['failedApi'],'GetProcessTimes')
        self.assertEqual(value['failedModule'],survey.KERNEL)
        self.assertEqual(value['apiPhase'],'invalid_return')
        self.assertFalse(value['nativeExecutionPermitted'])

    @unittest.skipIf(sys.platform=='win32','Local non-Windows rejection case')
    def test_actual_non_windows_path_never_loads_or_binds(self):
        with patch.object(survey,'bind_apis',side_effect=AssertionError('must_not_bind')):
            value=survey.observe()
        self.assertEqual(value['status'],'unsupported_platform');self.assertFalse(value['nativeExecutionPermitted'])

    def test_cli_cannot_select_modules_or_enable_fallback(self):
        for args in ([],['--observe-contract','--fallback'],['--module','other']):
            with patch.object(survey.sys,'argv',['fixture']+args),self.assertRaises(SystemExit):survey.main()
