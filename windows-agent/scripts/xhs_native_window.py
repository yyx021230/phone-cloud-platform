"""Read a complete native XHS tree; temporary process, exact foreground, no images."""
from hashlib import sha256
from pathlib import Path
import re
import uuid
import xml.etree.ElementTree as ET

ASSET_SHA256 = '21d844ef1b9437b8011d0b08768e9e11f65473e87cc2685a11eab1fcc101edd1'
PAIR_SHA256 = 'e9a54a8b7e5ecaeb258c62896fa45d96ad9109eaad60f9baf801c893a5e40272'


def default_asset_path(pair=False):
    kind='pair' if pair else 'window'
    digest=PAIR_SHA256 if pair else ASSET_SHA256
    folder=Path(__file__).parent/'native'
    versioned=folder/('xhs-native-'+kind+'-'+digest+'.jar')
    # Dev/legacy layouts may contain the matching bytes at the fixed path.
    # The caller always verifies the selected file against this exact digest.
    return versioned if versioned.is_file() else folder/('xhs-native-'+kind+'.jar')


class NativePairUnavailable(RuntimeError):
    """Read rejected after a normal process exit; finally must still prove cleanup."""


def foreground_identity(value):
    """Window handles may rotate; only a single focused user/component is evidence."""
    windows = re.findall(r'^\s*mCurrentFocus=Window\{[^\n}]*\}', value, re.MULTILINE)
    if len(windows) != 1:
        return None
    matches = re.findall(r'^\s*mCurrentFocus=Window\{[^\n}]*\bu(\d+)\s+'
                         r'(com\.xingin\.xhs)/([\w.$]+)(?=[}\s])', windows[0], re.MULTILINE)
    if len(matches) != 1:
        return None
    user, package, activity = matches[0]
    return user, package, package + activity if activity.startswith('.') else activity


def same_foreground(expected, observed):
    expected_identity = foreground_identity(expected)
    return expected_identity is not None and expected_identity == foreground_identity(observed)


def readable_foreground(value, pair=False):
    identity = foreground_identity(value)
    if identity is None:
        return False
    activity = identity[2]
    webviews = {'com.xingin.xywebview.activity.WebViewActivityV2',
                'com.xingin.xhs.xywebview.activity.WebViewActivityV2'}
    navigation = {'com.xingin.xhs.index.v2.IndexActivityV2',
                  'com.xingin.reactnative.ui.XhsReactActivity',
                  'com.xingin.login.halfwelcome.HalfWelcomeActivity',
                  'com.xingin.login.activity.WelcomeActivity',
                  'com.xingin.login.device.offline.DeviceOfflineRemindActivity'}
    return activity in (webviews if pair else webviews | navigation)


def honor_owner_foreground(value):
    windows = re.findall(r'^\s*mCurrentFocus=Window\{[^\n}]*\}', value, re.MULTILINE)
    return len(windows) == 1 and bool(re.search(
        r'\bu0\s+com\.hihonor\.android\.internal\.app/'
        r'(?:com\.hihonor\.android\.internal\.app\.|\.)HwChooserActivity(?=[}\s])', windows[0]))


def read(adb_path, serial, run, read_focus, guard, expected_focus, asset=None, pair=False):
    return _read_snapshot(adb_path,serial,run,read_focus,guard,expected_focus,asset,pair)


def read_honor_owner(adb_path, serial, run, read_focus, guard, expected_focus, asset=None):
    return _read_snapshot(adb_path,serial,run,read_focus,guard,expected_focus,asset,False,True)


def _read_snapshot(adb_path, serial, run, read_focus, guard, expected_focus, asset, pair, honor=False):
    valid = honor_owner_foreground(expected_focus) if honor else readable_foreground(expected_focus, pair)
    if not valid:
        raise RuntimeError('native elements require the proven XHS WebView or navigation foreground')
    expected_package = 'com.hihonor.android.internal.app' if honor else 'com.xingin.xhs'
    same = (lambda a,b: honor_owner_foreground(a) and honor_owner_foreground(b)) if honor else same_foreground
    asset = Path(asset) if asset is not None else default_asset_path(pair)
    if sha256(asset.read_bytes()).hexdigest() != (PAIR_SHA256 if pair else ASSET_SHA256):
        raise RuntimeError('native elements asset hash mismatch')
    guard()
    if not same(expected_focus, read_focus()):
        raise RuntimeError('native elements foreground changed before staging')
    remote = '/data/local/tmp/pc-xhs-elements-' + uuid.uuid4().hex + '.jar'

    def command(*args, timeout=8, allow_pair_rejection=False):
        result = run(adb_path, serial, *args, timeout=timeout)
        if result.returncode:
            stderr = result.stderr.decode('utf-8', 'replace')
            detail = stderr.strip()[:300]
            if (allow_pair_rejection and result.returncode == 1
                    and any(line.startswith('native_pair_unproven:') for line in stderr.splitlines())
                    and 'native_disconnect_failed' not in stderr):
                raise NativePairUnavailable('native pair rejected: ' + detail)
            raise RuntimeError('native elements command failed: ' + detail)
        return result.stdout

    try:
        command('push', str(asset), remote, timeout=12)
        guard()
        if not same(expected_focus, read_focus()):
            raise RuntimeError('native elements foreground changed before read')
        output = command('shell', 'CLASSPATH='+remote+':/system/framework/uiautomator.jar '
                         '/system/bin/timeout 20 /system/bin/app_process /system/bin '
                         + ('NativeWindowReader honor-owner-chooser' if honor else
                            'NativeWindowPair' if pair else 'NativeWindowReader'), timeout=25,
                         allow_pair_rejection=pair)
        guard()
        if not same(expected_focus, read_focus()):
            raise RuntimeError('native elements foreground changed during read')
        if len(output) > (8_000_128 if pair else 4_000_000):
            raise RuntimeError('native elements output bound exceeded')
        root = ET.fromstring(output.decode('utf-8').strip())
        roots = list(root) if pair and root.tag == 'native-pair' else [root]
        if pair and (root.tag != 'native-pair' or len(roots) != 2):
            raise NativePairUnavailable('native pair framing is unproven')
        for tree in roots:
            if (tree.tag != 'hierarchy' or tree.get('data-source') != 'xml'
                    or tree.get('native-window-reader') != '1' or not list(tree.iter('node'))
                    or any(n.get('package') != expected_package for n in tree.iter('node'))):
                # Foreign content never becomes an automatic retry.
                raise RuntimeError('native elements complete hierarchy is unproven')
        return tuple(roots) if pair else root
    finally:
        command('shell', 'rm', '-f', remote)
        absent = run(adb_path, serial, 'shell', 'ls', remote, timeout=8)
        if not absent.returncode or b'No such file' not in absent.stdout+absent.stderr:
            raise RuntimeError('native elements temporary file cleanup is unproven')
