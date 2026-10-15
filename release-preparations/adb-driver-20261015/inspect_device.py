"""Read-only exact-device compatible-driver preview. Never installs/restarts a device."""
import ctypes as C
from ctypes import wintypes as W
import hashlib
import json
from pathlib import Path
import sys


def choose_adb_driver(rows):
    """Require the built-in ADB section, not generic WinUSB without the ADB GUID."""
    found = [r for r in rows if r['provider'] == 'Microsoft'
             and r['inf'].replace('\\', '/').lower() == 'c:/windows/inf/winusb.inf'
             and r['section'].upper() == 'ADB'
             and r['hardwareId'].upper() == r'USB\CLASS_FF&SUBCLASS_42&PROT_01']
    if len(found) != 1:
        raise ValueError('Exactly one compatible Microsoft ADB driver is required')
    return found[0]


def inspect(instance_id):
    if sys.platform != 'win32' or C.sizeof(C.c_void_p) != 8:
        raise RuntimeError('64-bit Windows required')
    if not instance_id.upper().startswith('USB\\') or len(instance_id.split('\\')) != 3:
        raise ValueError('Exact USB instance ID required')

    class GUID(C.Structure):
        _fields_ = [('a', W.DWORD), ('b', W.WORD), ('c', W.WORD), ('d', C.c_byte * 8)]
    class Device(C.Structure):
        _fields_ = [('cbSize', W.DWORD), ('ClassGuid', GUID), ('DevInst', W.DWORD), ('Reserved', C.c_size_t)]
    class Driver(C.Structure):
        _fields_ = [('cbSize', W.DWORD), ('DriverType', W.DWORD), ('Reserved', C.c_size_t),
                    ('Description', W.WCHAR * 256), ('MfgName', W.WCHAR * 256),
                    ('ProviderName', W.WCHAR * 256), ('DriverDate', W.FILETIME), ('DriverVersion', C.c_ulonglong)]
    class Detail(C.Structure):
        _fields_ = [('cbSize', W.DWORD), ('InfDate', W.FILETIME), ('CompatIDsOffset', W.DWORD),
                    ('CompatIDsLength', W.DWORD), ('Reserved', C.c_size_t), ('SectionName', W.WCHAR * 256),
                    ('InfFileName', W.WCHAR * 260), ('DrvDescription', W.WCHAR * 256), ('HardwareID', W.WCHAR * 1)]

    setup = C.WinDLL('setupapi', use_last_error=True)
    api = {
        'SetupDiCreateDeviceInfoList': ([C.c_void_p, W.HWND], C.c_void_p),
        'SetupDiOpenDeviceInfoW': ([C.c_void_p, W.LPCWSTR, W.HWND, W.DWORD, C.POINTER(Device)], W.BOOL),
        'SetupDiBuildDriverInfoList': ([C.c_void_p, C.POINTER(Device), W.DWORD], W.BOOL),
        'SetupDiEnumDriverInfoW': ([C.c_void_p, C.POINTER(Device), W.DWORD, W.DWORD, C.POINTER(Driver)], W.BOOL),
        'SetupDiGetDriverInfoDetailW': ([C.c_void_p, C.POINTER(Device), C.POINTER(Driver), C.POINTER(Detail), W.DWORD, C.POINTER(W.DWORD)], W.BOOL),
        'SetupDiDestroyDriverInfoList': ([C.c_void_p, C.POINTER(Device), W.DWORD], W.BOOL),
        'SetupDiDestroyDeviceInfoList': ([C.c_void_p], W.BOOL),
    }
    for name, (args, result) in api.items():
        fn = getattr(setup, name); fn.argtypes = args; fn.restype = result
    def checked(value):
        if not value: raise C.WinError(C.get_last_error())
    handle = setup.SetupDiCreateDeviceInfoList(None, None)
    if handle == C.c_void_p(-1).value: raise C.WinError(C.get_last_error())
    dev = Device(); dev.cbSize = C.sizeof(dev)
    built = False
    try:
        checked(setup.SetupDiOpenDeviceInfoW(handle, instance_id, None, 0, C.byref(dev)))
        checked(setup.SetupDiBuildDriverInfoList(handle, C.byref(dev), 2)); built = True
        rows = []
        for index in range(128):
            driver = Driver(); driver.cbSize = C.sizeof(driver)
            if not setup.SetupDiEnumDriverInfoW(handle, C.byref(dev), 2, index, C.byref(driver)):
                if C.get_last_error() == 259: break
                raise C.WinError(C.get_last_error())
            buffer = C.create_string_buffer(32768)
            detail = C.cast(buffer, C.POINTER(Detail)); detail.contents.cbSize = C.sizeof(Detail)
            needed = W.DWORD()
            checked(setup.SetupDiGetDriverInfoDetailW(handle, C.byref(dev), C.byref(driver), detail, len(buffer), C.byref(needed)))
            d = detail.contents
            rows.append({'index': index, 'provider': driver.ProviderName, 'description': driver.Description,
                         'inf': d.InfFileName, 'section': d.SectionName,
                         'hardwareId': C.wstring_at(C.addressof(buffer) + Detail.HardwareID.offset)})
        else:
            raise RuntimeError('Unexpected compatible-driver count')
        chosen = choose_adb_driver(rows)
        raw = Path(chosen['inf']).read_bytes()
        return {'instanceId': instance_id, 'compatibleDrivers': rows, 'selected': chosen,
                'infSha256': hashlib.sha256(raw).hexdigest(), 'readOnly': True, 'installCalled': False}
    finally:
        if built: setup.SetupDiDestroyDriverInfoList(handle, C.byref(dev), 2)
        setup.SetupDiDestroyDeviceInfoList(handle)


if __name__ == '__main__':
    print(json.dumps(inspect(sys.argv[1]), ensure_ascii=True))
