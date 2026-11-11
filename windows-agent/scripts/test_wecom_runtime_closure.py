"""Import only the release's runtime files, without the source-tree QA helpers."""
import json
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[2]
# The immutable rc.1 list defines the exact 20-file boundary that exposed the
# missing dependency. Copy current reviewed bytes; release hashes are checked
# separately. No whole scripts directory or site-packages fallback is allowed.
MANIFEST = ROOT / 'releases/wecom-cleanup-agent-20261102-rc.1/MANIFEST.json'


class RuntimeClosureTests(unittest.TestCase):
    def packed(self, folder, omit=None):
        manifest = json.loads(MANIFEST.read_text())
        self.assertEqual(len(manifest['runtimeFiles']), 20)
        for relative in manifest['runtimeFiles']:
            if relative == omit:
                continue
            target = folder / relative
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(ROOT / relative, target)
        for relative in manifest['qaOnlyExcludedFromProduction']:
            self.assertFalse((folder / relative).exists())

    def imported(self, folder):
        code = '''
import importlib,json,pathlib,socket,subprocess,sys,threading,urllib.request
scripts=pathlib.Path(sys.argv[1])
sys.path.insert(0,str(scripts))
def forbidden(*args,**kwargs):raise AssertionError('runtime_import_side_effect')
socket.socket=forbidden
socket.create_connection=forbidden
subprocess.Popen=forbidden
threading.Thread.start=forbidden
modules=sorted(p.stem for p in scripts.glob('*.py'))
for name in modules:importlib.import_module(name)
assert not any(name.startswith(('poco','airtest','wecom_screen_lease','wecom_standalone','wecom_private_observation')) for name in sys.modules)
print(json.dumps({'imported':modules,'phoneActions':0,'sdkImported':False}))
'''
        return subprocess.run(
            [sys.executable, '-I', '-S', '-B', '-c', code,
             str(folder / 'windows-agent/scripts')],
            cwd=str(folder), capture_output=True, text=True, timeout=5)

    def test_exact_runtime_package_imports_without_qa_sdk_or_actions(self):
        with tempfile.TemporaryDirectory(prefix='wecom-runtime-only-') as name:
            folder = Path(name)
            self.packed(folder)
            result = self.imported(folder)
            self.assertEqual(result.returncode, 0, result.stderr)
            receipt = json.loads(result.stdout)
            self.assertEqual(len(receipt['imported']), 15)
            self.assertIn('wecom_platform_preview', receipt['imported'])
            self.assertIn('wecom_cleanup_verify', receipt['imported'])
            self.assertFalse(receipt['sdkImported'])
            self.assertEqual(receipt['phoneActions'], 0)

    def test_missing_runtime_dependency_cannot_fall_back_to_source_tree(self):
        with tempfile.TemporaryDirectory(prefix='wecom-runtime-missing-') as name:
            folder = Path(name)
            self.packed(folder, omit='windows-agent/scripts/wecom_rpc_budget.py')
            result = self.imported(folder)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn('ModuleNotFoundError', result.stderr)
            self.assertIn('wecom_rpc_budget', result.stderr)


if __name__ == '__main__':
    unittest.main()
