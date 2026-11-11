"""Exact native XHS navigation actions using a temporary shell Java process.

No APK/service installation, screenshots, image coordinates or input replay.
The caller owns the device/slot guard and the existing SDK ADB connection.
Only the existing own-profile and menu actions are supported.
Permission and experimental data-header actions are deliberately rejected.
"""
from hashlib import sha256
from pathlib import Path
import uuid
try:
    from xhs_native_window import same_foreground, foreground_identity
except ImportError:
    # An in-flight old collector may already have cached the previous window
    # helper. Do not replace that module or its fixed-path asset expectations.
    import re
    def foreground_identity(value):
        windows=re.findall(r'^\s*mCurrentFocus=Window\{[^\n}]*\}',value,re.MULTILINE)
        if len(windows)!=1:return None
        matches=re.findall(r'^\s*mCurrentFocus=Window\{[^\n}]*\bu(\d+)\s+'
            r'(com\.xingin\.xhs)/([\w.$]+)(?=[}\s])',windows[0],re.MULTILINE)
        if len(matches)!=1:return None
        user,package,activity=matches[0]
        return user,package,package+activity if activity.startswith('.') else activity
    def same_foreground(expected,observed):
        identity=foreground_identity(expected)
        return identity is not None and identity==foreground_identity(observed)

ASSET_SHA256 = 'b17657420d9545dc824b777dff3b139f0587b4865a08b1dde7fa6b59c418a10e'


def default_asset_path():
    folder=Path(__file__).parent/'native'
    versioned=folder/('xhs-native-navigation-'+ASSET_SHA256+'.jar')
    return versioned if versioned.is_file() else folder/'xhs-native-navigation.jar'


def perform(action, adb_path, serial, run, read_focus, guard, expected_focus, asset=None):
    if action not in ('profile', 'menu'):
        raise RuntimeError('unsupported native navigation action')
    asset = Path(asset) if asset is not None else default_asset_path()
    if sha256(asset.read_bytes()).hexdigest() != ASSET_SHA256:
        raise RuntimeError('native navigation asset hash mismatch')
    guard()
    if not same_foreground(expected_focus, read_focus()):
        raise RuntimeError('native navigation foreground changed before staging')
    remote = '/data/local/tmp/pc-xhs-nav-' + uuid.uuid4().hex + '.jar'

    def command(*args, timeout=8):
        result = run(adb_path, serial, *args, timeout=timeout)
        if result.returncode:
            detail = result.stderr.decode('utf-8', 'replace').strip()[:300]
            raise RuntimeError('native navigation command failed: ' + detail)
        return result.stdout

    try:
        command('push', str(asset), remote, timeout=12)
        guard()
        if not same_foreground(expected_focus, read_focus()):
            raise RuntimeError('native navigation foreground changed before action')
        output = command('shell', 'CLASSPATH='+remote+':/system/framework/uiautomator.jar '
                         '/system/bin/timeout 15 /system/bin/app_process /system/bin '
                         'NativeNavigationAction '+action, timeout=20)
        if output.decode('utf-8').strip() != 'native_navigation_action_completed':
            raise RuntimeError('native navigation action result is unproven')
    finally:
        # Only our unique temporary file is removed, including after an
        # unknown command outcome. Never retry the action or kill another app.
        command('shell', 'rm', '-f', remote)
        absent = run(adb_path, serial, 'shell', 'ls', remote, timeout=8)
        if not absent.returncode or b'No such file' not in absent.stdout+absent.stderr:
            raise RuntimeError('native navigation temporary file cleanup is unproven')
