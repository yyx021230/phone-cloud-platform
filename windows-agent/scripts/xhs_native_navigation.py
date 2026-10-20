"""Exact native XHS profile/menu actions using a temporary shell Java process.

No APK/service installation, screenshots, image coordinates or input replay.
The caller owns the device/slot guard and the existing SDK ADB connection.
"""
from hashlib import sha256
from pathlib import Path
import uuid

ASSET_SHA256 = '910f03a9c4cd6963b89ce1dd4bf4a6ad21b6f888029970401134fdcf820af754'


def perform(action, adb_path, serial, run, read_focus, guard, expected_focus, asset=None):
    if action not in ('profile', 'menu'):
        raise RuntimeError('unsupported native navigation action')
    asset = Path(asset) if asset is not None else Path(__file__).parent/'native/xhs-native-navigation.jar'
    if sha256(asset.read_bytes()).hexdigest() != ASSET_SHA256:
        raise RuntimeError('native navigation asset hash mismatch')
    guard()
    if read_focus() != expected_focus:
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
        if read_focus() != expected_focus:
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
