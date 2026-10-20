"""Read a complete native XHS tree; temporary process, exact foreground, no images."""
from hashlib import sha256
from pathlib import Path
import re
import uuid
import xml.etree.ElementTree as ET

ASSET_SHA256 = '15b043f5f78c17855b08d354dc5af4004216bc7ce14b5d03fa9e05f72e8d57c7'


def read(adb_path, serial, run, read_focus, guard, expected_focus, asset=None):
    if not re.search(r'\bu\d+\s+com\.xingin\.xhs/(?:com\.xingin\.xywebview\.activity\.WebViewActivityV2|\.xywebview\.activity\.WebViewActivityV2)(?:[}\s]|$)', expected_focus):
        raise RuntimeError('native elements require the proven XHS WebView foreground')
    asset = Path(asset) if asset is not None else Path(__file__).parent/'native/xhs-native-window.jar'
    if sha256(asset.read_bytes()).hexdigest() != ASSET_SHA256:
        raise RuntimeError('native elements asset hash mismatch')
    guard()
    if read_focus() != expected_focus:
        raise RuntimeError('native elements foreground changed before staging')
    remote = '/data/local/tmp/pc-xhs-elements-' + uuid.uuid4().hex + '.jar'

    def command(*args, timeout=8):
        result = run(adb_path, serial, *args, timeout=timeout)
        if result.returncode:
            detail = result.stderr.decode('utf-8', 'replace').strip()[:300]
            raise RuntimeError('native elements command failed: ' + detail)
        return result.stdout

    try:
        command('push', str(asset), remote, timeout=12)
        guard()
        if read_focus() != expected_focus:
            raise RuntimeError('native elements foreground changed before read')
        output = command('shell', 'CLASSPATH='+remote+':/system/framework/uiautomator.jar '
                         '/system/bin/timeout 20 /system/bin/app_process /system/bin '
                         'NativeWindowReader', timeout=25)
        guard()
        if read_focus() != expected_focus:
            raise RuntimeError('native elements foreground changed during read')
        if len(output) > 4_000_000:
            raise RuntimeError('native elements output bound exceeded')
        root = ET.fromstring(output.decode('utf-8').strip())
        if (root.tag != 'hierarchy' or root.get('data-source') != 'xml'
                or root.get('native-window-reader') != '1' or not list(root.iter('node'))
                or any(n.get('package') != 'com.xingin.xhs' for n in root.iter('node'))):
            raise RuntimeError('native elements complete hierarchy is unproven')
        return root
    finally:
        command('shell', 'rm', '-f', remote)
        absent = run(adb_path, serial, 'shell', 'ls', remote, timeout=8)
        if not absent.returncode or b'No such file' not in absent.stdout+absent.stderr:
            raise RuntimeError('native elements temporary file cleanup is unproven')
