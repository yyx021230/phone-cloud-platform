"""Proposed read-only Win32 survey. Review required before remote execution.

Uses stdlib and current-process Kernel32 reads only. No authority is issued.
Remote proposal: fixed Python 3.9 -I -B - --observe, this source on stdin.
"""
import ctypes
import json
import os
import sys


class FILETIME(ctypes.Structure):
    _fields_ = [('low', ctypes.c_uint32), ('high', ctypes.c_uint32)]


def integer(value):
    return (value.high << 32) | value.low


def survey():
    result = {'scope': 'readonly-clock-observation', 'authoritySupported': False,
              'nativeExecutionPermitted': False, 'physicalCleanupVerified': False,
              'pid': os.getpid(), 'sampleLimit': 16,
              'executionContext': 'inherited-SSH-user; not a SYSTEM worker test'}
    if os.name != 'nt':
        return dict(result, status='unsupported_platform')
    stage = 'load_system_kernel32'
    try:
        # LOAD_LIBRARY_SEARCH_SYSTEM32; no DLL path/env modification.
        kernel = ctypes.WinDLL('kernel32.dll', use_last_error=True, winmode=0x800)
        u64, i64, u32, boolean = ctypes.c_uint64, ctypes.c_int64, ctypes.c_uint32, ctypes.c_int
        ptr = ctypes.POINTER

        def bind(name, args, returns):
            function = getattr(kernel, name)
            function.argtypes, function.restype = args, returns
            return function

        stage = 'bind_readonly_apis'
        tick = bind('GetTickCount64', [], u64)
        unbiased = bind('QueryUnbiasedInterruptTimePrecise', [ptr(u64)], None)
        wall = bind('GetSystemTimePreciseAsFileTime', [ptr(FILETIME)], None)
        qpc = bind('QueryPerformanceCounter', [ptr(i64)], boolean)
        qpf = bind('QueryPerformanceFrequency', [ptr(i64)], boolean)
        current = bind('GetCurrentProcess', [], ctypes.c_void_p)
        process_times = bind('GetProcessTimes', [ctypes.c_void_p] + [ptr(FILETIME)] * 4, boolean)
        adjustment = bind('GetSystemTimeAdjustment', [ptr(u32), ptr(u32), ptr(boolean)], boolean)

        def read_qpc():
            value = i64()
            if not qpc(ctypes.byref(value)):
                raise OSError('qpc_failed')
            return value.value

        def read_wall():
            value = FILETIME()
            wall(ctypes.byref(value))
            return integer(value)

        stage = 'read_current_process_times'
        created, exited, kernel_time, user_time = FILETIME(), FILETIME(), FILETIME(), FILETIME()
        if not process_times(current(), ctypes.byref(created), ctypes.byref(exited),
                             ctypes.byref(kernel_time), ctypes.byref(user_time)):
            raise OSError('current_process_times_failed')
        frequency = i64()
        if not qpf(ctypes.byref(frequency)) or frequency.value <= 0:
            raise OSError('qpc_frequency_failed')
        amount, increment, disabled = u32(), u32(), boolean()
        if not adjustment(ctypes.byref(amount), ctypes.byref(increment), ctypes.byref(disabled)):
            raise OSError('time_adjustment_read_failed')
        version = sys.getwindowsversion()
        result.update(windowsVersion={'major': version.major, 'minor': version.minor, 'build': version.build},
                      pointerBits=ctypes.sizeof(ctypes.c_void_p) * 8,
                      ownCreationFileTime100ns=str(integer(created)),
                      qpcFrequency=str(frequency.value),
                      adjustmentObservation={'amount100ns': str(amount.value),
                                             'increment100ns': str(increment.value),
                                             'periodicAdjustmentDisabled': bool(disabled.value)},
                      selectedApis=['GetTickCount64', 'QueryUnbiasedInterruptTimePrecise',
                                    'GetSystemTimePreciseAsFileTime'],
                      bootIdentityConfirmed=False, physicalOrVmConfirmed=False,
                      units={'boot': 'milliseconds', 'work': '100ns', 'wall': 'FILETIME-100ns-since-1601',
                             'qpc': 'ticks; frequency-per-second'})
        stage = 'sample_paired_clocks'
        rows, anomalies, start = [], [], read_qpc()
        for sequence in range(1, 17):
            if read_qpc() - start > 2 * frequency.value:
                anomalies.append('survey_elapsed_over_2s')
                break
            before = read_qpc()
            wall_before = read_wall()
            boot_before = tick()
            work = u64()
            unbiased(ctypes.byref(work))
            boot_after = tick()
            wall_after = read_wall()
            after = read_qpc()
            if boot_after < boot_before or wall_after < wall_before or after < before:
                anomalies.append('counter_regression_in_bracket')
            rows.append({'sequence': sequence, 'qpcBefore': str(before), 'qpcAfter': str(after),
                         'bootBeforeMs': str(boot_before), 'bootAfterMs': str(boot_after),
                         'work100ns': str(work.value), 'wallBefore100ns': str(wall_before),
                         'wallAfter100ns': str(wall_after)})
        result.update(status='observed_not_authority', samples=rows, anomalies=anomalies,
                      limitations=['Sixteen back-to-back reads, not drift/error calibration.',
                                   'Nominal increment/resolution is not a hard uncertainty bound.',
                                   'No suspend, hibernation, VM freeze or migration test.',
                                   'No cross-process journal, SYSTEM child or socket-peer proof.',
                                   'Current-process birth is audit data, not an old task repair.'])
    except (AttributeError, OSError) as error:
        result.update(status='unsupported_api_or_read_failure', failedStage=stage,
                      errorType=type(error).__name__, windowsError=ctypes.get_last_error())
    return result


if __name__ == '__main__':
    if sys.argv[1:] != ['--observe']:
        raise SystemExit('explicit_observe_required')
    sys.stdout.buffer.write((json.dumps(survey(), ensure_ascii=True) + '\n').encode('ascii'))
