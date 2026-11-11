"""Local candidate: explicit Win32 API-set contract; read-only, no authority.

Not wired to production. The old 20882a6 survey and observations stay intact.
"""
import ctypes
import json
import os
import sys

KERNEL = 'kernel32.dll'
REALTIME = 'api-ms-win-core-realtime-l1-1-1.dll'
UNBIASED = 'QueryUnbiasedInterruptTimePrecise'
NAMES = ('GetTickCount64', UNBIASED, 'GetSystemTimePreciseAsFileTime',
         'QueryPerformanceCounter', 'QueryPerformanceFrequency', 'GetCurrentProcess',
         'GetProcessTimes', 'GetSystemTimeAdjustment')
POLICY = {name: REALTIME if name == UNBIASED else KERNEL for name in NAMES}
BOOL_APIS = {'QueryPerformanceCounter','QueryPerformanceFrequency','GetProcessTimes','GetSystemTimeAdjustment'}


class FILETIME(ctypes.Structure):
    _fields_ = [('low',ctypes.c_uint32),('high',ctypes.c_uint32)]


def integer(value):
    return (value.high << 32) | value.low


def error_kind(error):
    for kind in (AttributeError,OSError,TypeError):
        if isinstance(error,kind):
            return kind.__name__
    return 'UnexpectedError'


class ApiFailure(Exception):
    def __init__(self,name,module,phase,error):
        super().__init__('readonly_clock_api_failure')
        self.name,self.module,self.phase,self.original = name,module,phase,error

    def fields(self):
        return {'failedApi':self.name,'failedModule':self.module,'apiPhase':self.phase,
                'errorType':error_kind(self.original)}


def bind_apis(loader=None):
    """Exactly two specified system contracts, no probing order or fallback."""
    loader = ctypes.WinDLL if loader is None else loader
    ptr = ctypes.POINTER
    u64,i64,u32,boolean = ctypes.c_uint64,ctypes.c_int64,ctypes.c_uint32,ctypes.c_int
    signatures = {
        'GetTickCount64':([],u64), UNBIASED:([ptr(u64)],None),
        'GetSystemTimePreciseAsFileTime':([ptr(FILETIME)],None),
        'QueryPerformanceCounter':([ptr(i64)],boolean), 'QueryPerformanceFrequency':([ptr(i64)],boolean),
        'GetCurrentProcess':([],ctypes.c_void_p),
        'GetProcessTimes':([ctypes.c_void_p]+[ptr(FILETIME)]*4,boolean),
        'GetSystemTimeAdjustment':([ptr(u32),ptr(u32),ptr(boolean)],boolean)}
    libraries,result = {},{}
    for name in NAMES:
        module,phase = POLICY[name],'load_module'
        try:
            if module not in libraries:
                libraries[module] = loader(module,use_last_error=True,winmode=0x800)
            phase = 'resolve_symbol'
            function = getattr(libraries[module],name)
            phase = 'set_signature'
            if not callable(function):
                raise TypeError('not_a_function')
            function.argtypes,function.restype = signatures[name]
            result[name] = function
        except Exception as error:
            raise ApiFailure(name,module,phase,error) from error
    return result


def observe():
    version = sys.version_info
    result = {'scope':'readonly-clock-contract-observation','authoritySupported':False,
        'nativeExecutionPermitted':False,'physicalCleanupVerified':False,'pid':os.getpid(),'sampleLimit':16,
        'executionContext':'inherited-SSH-user; not a SYSTEM worker test',
        'pythonVersion':{'major':version.major,'minor':version.minor,'micro':version.micro,
                         'releaselevel':version.releaselevel,'serial':version.serial},
        'pointerBits':ctypes.sizeof(ctypes.c_void_p)*8,'bindingPolicy':dict(POLICY)}
    if os.name != 'nt':
        return dict(result,status='unsupported_platform')
    stage = 'bind_readonly_apis'
    try:
        functions = bind_apis()
        def call(name,*args):
            try:
                value = functions[name](*args)
            except Exception as error:
                raise ApiFailure(name,POLICY[name],'invoke_api',error) from error
            if name in BOOL_APIS and not value:
                raise ApiFailure(name,POLICY[name],'invalid_return',OSError('api_returned_failure'))
            return value
        def qpc():
            value = ctypes.c_int64();call('QueryPerformanceCounter',ctypes.byref(value));return value.value
        def wall():
            value = FILETIME();call('GetSystemTimePreciseAsFileTime',ctypes.byref(value));return integer(value)
        stage = 'read_current_process_times'
        created,exited,kernel_time,user_time = FILETIME(),FILETIME(),FILETIME(),FILETIME()
        call('GetProcessTimes',call('GetCurrentProcess'),ctypes.byref(created),ctypes.byref(exited),
             ctypes.byref(kernel_time),ctypes.byref(user_time))
        frequency = ctypes.c_int64();call('QueryPerformanceFrequency',ctypes.byref(frequency))
        if frequency.value <= 0:
            raise ApiFailure('QueryPerformanceFrequency',KERNEL,'invalid_return',OSError('nonpositive_frequency'))
        amount,increment,disabled = ctypes.c_uint32(),ctypes.c_uint32(),ctypes.c_int()
        call('GetSystemTimeAdjustment',ctypes.byref(amount),ctypes.byref(increment),ctypes.byref(disabled))
        win = sys.getwindowsversion()
        result.update(windowsVersion={'major':win.major,'minor':win.minor,'build':win.build},
            ownCreationFileTime100ns=str(integer(created)),qpcFrequency=str(frequency.value),
            adjustmentObservation={'amount100ns':str(amount.value),'increment100ns':str(increment.value),
                                   'periodicAdjustmentDisabled':bool(disabled.value)},
            bootIdentityConfirmed=False,physicalOrVmConfirmed=False,
            units={'boot':'milliseconds','work':'100ns','wall':'FILETIME-100ns-since-1601','qpc':'ticks; frequency-per-second'})
        stage = 'sample_paired_clocks'
        rows,anomalies,start = [],[],qpc()
        for sequence in range(1,17):
            if qpc()-start > 2*frequency.value:
                anomalies.append('survey_elapsed_over_2s');break
            before = qpc();wall_before = wall();boot_before = call('GetTickCount64')
            work = ctypes.c_uint64();call(UNBIASED,ctypes.byref(work))
            boot_after = call('GetTickCount64');wall_after = wall();after = qpc()
            if boot_after < boot_before or wall_after < wall_before or after < before:
                anomalies.append('counter_regression_in_bracket')
            rows.append({'sequence':sequence,'qpcBefore':str(before),'qpcAfter':str(after),
                'bootBeforeMs':str(boot_before),'bootAfterMs':str(boot_after),'work100ns':str(work.value),
                'wallBefore100ns':str(wall_before),'wallAfter100ns':str(wall_after)})
        result.update(status='observed_not_authority',samples=rows,anomalies=anomalies,
            limitations=['Back-to-back observations, not a hard error/drift/pause bound.',
                         'No sleep/VM migration test, SYSTEM reader, socket-peer or journal recovery proof.'])
    except ApiFailure as error:
        result.update(status='unsupported_api_or_read_failure',failedStage=stage,**error.fields(),
                      windowsError=getattr(ctypes,'get_last_error',lambda:0)())
    except Exception as error:
        result.update(status='unconfirmed_observation',failedStage=stage,errorType=error_kind(error))
    return result


def main():
    if sys.argv[1:] != ['--observe-contract']:
        raise SystemExit('explicit_contract_observation_required')
    sys.stdout.buffer.write((json.dumps(observe(),ensure_ascii=True)+'\n').encode('ascii'))


if __name__ == '__main__':
    main()
