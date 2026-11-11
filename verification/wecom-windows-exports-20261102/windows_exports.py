"""Proposed Kernel32 export inspection only; no clock-function invocation."""
import ctypes
import json
import os
import sys

NAMES = ('GetTickCount64', 'QueryUnbiasedInterruptTimePrecise', 'GetSystemTimePreciseAsFileTime',
         'QueryPerformanceCounter', 'QueryPerformanceFrequency', 'GetCurrentProcess',
         'GetProcessTimes', 'GetSystemTimeAdjustment')


def inspect_exports(library):
    rows = []
    for name in NAMES:
        try:
            symbol = getattr(library, name)
            present = callable(symbol)
            kind = 'none' if present else 'UnexpectedError'
        except AttributeError:
            present, kind = False, 'AttributeError'
        except OSError:
            present, kind = False, 'OSError'
        except Exception:
            present, kind = False, 'UnexpectedError'
        rows.append({'name': name, 'present': present, 'errorType': kind})
    return rows


def observe():
    version = sys.version_info
    result = {'scope': 'readonly-kernel32-export-inspection', 'module': 'kernel32.dll',
              'searchPolicy': 'System32Only', 'pid': os.getpid(),
              'pythonVersion': {'major': version.major, 'minor': version.minor, 'micro': version.micro,
                                'releaselevel': version.releaselevel, 'serial': version.serial},
              'pointerBits': ctypes.sizeof(ctypes.c_void_p) * 8,
              'sampleFunctionsCalled': 0, 'authoritySupported': False,
              'nativeExecutionPermitted': False, 'physicalCleanupVerified': False}
    if os.name != 'nt':
        return dict(result, status='unsupported_platform', exports=[])
    try:
        # Same fixed system module/search policy as the previously reviewed probe.
        # getattr resolves symbols; the returned function pointers are NOT called.
        library = ctypes.WinDLL('kernel32.dll', use_last_error=True, winmode=0x800)
        return dict(result, status='exports_observed_not_authority', exports=inspect_exports(library))
    except AttributeError:
        return dict(result, status='module_load_unconfirmed', errorType='AttributeError', exports=[])
    except OSError:
        return dict(result, status='module_load_unconfirmed', errorType='OSError', exports=[])
    except Exception:
        return dict(result, status='module_load_unconfirmed', errorType='UnexpectedError', exports=[])


def main():
    if sys.argv[1:] != ['--inspect-exports']:
        raise SystemExit('explicit_inspect_exports_required')
    sys.stdout.buffer.write((json.dumps(observe(), ensure_ascii=True) + '\n').encode('ascii'))


if __name__ == '__main__':
    main()
