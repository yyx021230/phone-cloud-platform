"""Read a complete native XHS tree; temporary process, exact foreground, no images."""
from hashlib import sha256
from pathlib import Path
import re
import uuid
import xml.etree.ElementTree as ET

ASSET_SHA256 = '15b043f5f78c17855b08d354dc5af4004216bc7ce14b5d03fa9e05f72e8d57c7'
PAIR_SHA256 = '9e696792b37dd269803d230ef1e97754bf895b1d2b852e8d23ae838c757cbed3'


class NativePairUnavailable(RuntimeError):
    """Read rejected after a normal process exit; finally must still prove cleanup."""


def read(adb_path, serial, run, read_focus, guard, expected_focus, asset=None, pair=False):
    if not re.search(r'\bu\d+\s+com\.xingin\.xhs/(?:com\.xingin\.xywebview\.activity\.WebViewActivityV2|\.xywebview\.activity\.WebViewActivityV2)(?:[}\s]|$)', expected_focus):
        raise RuntimeError('native elements require the proven XHS WebView foreground')
    asset = Path(asset) if asset is not None else Path(__file__).parent/('native/xhs-native-pair.jar' if pair else 'native/xhs-native-window.jar')
    if sha256(asset.read_bytes()).hexdigest() != (PAIR_SHA256 if pair else ASSET_SHA256):
        raise RuntimeError('native elements asset hash mismatch')
    guard()
    if read_focus() != expected_focus:
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
        if read_focus() != expected_focus:
            raise RuntimeError('native elements foreground changed before read')
        output = command('shell', 'CLASSPATH='+remote+':/system/framework/uiautomator.jar '
                         '/system/bin/timeout 20 /system/bin/app_process /system/bin '
                         + ('NativeWindowPair' if pair else 'NativeWindowReader'), timeout=25,
                         allow_pair_rejection=pair)
        guard()
        if read_focus() != expected_focus:
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
                    or any(n.get('package') != 'com.xingin.xhs' for n in tree.iter('node'))):
                # Foreign content never becomes an automatic retry.
                raise RuntimeError('native elements complete hierarchy is unproven')
        return tuple(roots) if pair else root
    finally:
        command('shell', 'rm', '-f', remote)
        absent = run(adb_path, serial, 'shell', 'ls', remote, timeout=8)
        if not absent.returncode or b'No such file' not in absent.stdout+absent.stderr:
            raise RuntimeError('native elements temporary file cleanup is unproven')
