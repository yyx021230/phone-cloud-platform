"""Run existing WeCom SCRIPT tests offline, with an extra parent audit boundary.

Tests have synthetic device/SDK adapters; this is never native acceptance.
Only local ephemeral loopback sockets and own Python/Node test children may run.
"""
import datetime
import json
import os
from pathlib import Path
import shutil
import sys
import unittest

ROOT = Path(__file__).resolve().parents[2]
SCRIPTS = ROOT / 'windows-agent' / 'scripts'
OUT = Path(__file__).resolve().parent

def main():
    if sys.argv[1:] != ['--offline']:
        raise SystemExit('explicit --offline required')
    os.chdir(ROOT)
    # No inherited live API/database/Agent credentials in test children.
    keep = {'PATH', 'LANG', 'LC_ALL', 'TMPDIR', 'SYSTEMROOT', 'WINDIR', 'HOME'}
    original = dict(os.environ)
    os.environ.clear()
    os.environ.update({key: value for key, value in original.items() if key in keep})
    os.environ['PYTHONDONTWRITEBYTECODE'] = '1'
    allowed_executables = {str(Path(sys.executable).resolve())}
    if shutil.which('node'):
        allowed_executables.add(str(Path(shutil.which('node')).resolve()))
    audit = {'allowedLoopbackConnections': 0, 'ownedTestChildren': 0, 'blockedActions': 0}
    reserved = {22, 80, 443, 4723, 5037, 5432, 6379, 8787, 8796}
    def reject():
        audit['blockedActions'] += 1
        raise RuntimeError('offline_suite_forbidden_external_or_native_action')
    def hook(event, args):
        if event in ('socket.connect', 'socket.bind'):
            address = args[1]
            if (not isinstance(address, tuple) or len(address) < 2
                    or address[0] not in ('127.0.0.1', '::1', 'localhost')
                    or not isinstance(address[1], int) or address[1] in reserved):
                reject()
            if event == 'socket.connect':
                audit['allowedLoopbackConnections'] += 1
        elif event == 'subprocess.Popen':
            executable = str(args[0])
            resolved = shutil.which(executable) or executable
            if str(Path(resolved).resolve()) not in allowed_executables:
                reject()
            audit['ownedTestChildren'] += 1
        elif event in ('os.system', 'os.exec', 'os.posix_spawn'):
            reject()
    sys.addaudithook(hook)
    suite = unittest.defaultTestLoader.discover(str(SCRIPTS), pattern='test_wecom*.py')
    ids = []
    class Result(unittest.TextTestResult):
        def startTest(self, test):
            ids.append(test.id())
            super().startTest(test)
    with (OUT / 'PYTHON_OUTPUT.txt').open('w', encoding='utf8') as log:
        result = unittest.TextTestRunner(stream=log, verbosity=2, resultclass=Result).run(suite)
    receipt = {'atUtc': datetime.datetime.now(datetime.timezone.utc).isoformat(),
               'scope': 'actual WeCom script functions with offline fixtures; no native devices',
               'testsRun': result.testsRun, 'uniqueTestIds': len(set(ids)),
               'failures': len(result.failures), 'errors': len(result.errors), 'skipped': len(result.skipped),
               'successful': result.wasSuccessful(), 'audit': audit,
               'childBoundary': 'Python/Node fixture children are code-audited; parent audit is not a system sandbox',
               'nativeAcceptance': False, 'testIds': ids}
    (OUT / 'PYTHON_RECEIPT.json').write_text(json.dumps(receipt, indent=2) + '\n', encoding='utf8')
    print(json.dumps({key: value for key, value in receipt.items() if key != 'testIds'}))
    raise SystemExit(0 if result.wasSuccessful() else 1)

if __name__ == '__main__':
    main()
