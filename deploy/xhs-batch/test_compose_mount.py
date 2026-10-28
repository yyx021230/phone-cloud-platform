"""Validate Compose's parsed mount, including the previous unquoted regression."""
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]


class ComposeMountTest(unittest.TestCase):
    def test_tmpfs_is_one_mount_with_options(self):
        compose = shutil.which('docker-compose')
        if not compose:
            self.skipTest('docker-compose required for parsed configuration test')
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory)
            (path / '.env').write_text('')
            (path / 'base.yml').write_text((ROOT / 'docker-compose.yml').read_text())
            candidate = (ROOT / 'deploy/xhs-batch/compose.override.yml').read_text()
            env = {**os.environ, 'POSTGRES_PASSWORD': 'synthetic-only',
                   'XHS_BATCH_IMAGE': 'synthetic:test',
                   'XHS_BATCH_CONFIG_PATH': str(path / 'private.json'),
                   'XHS_BATCH_DATABASE_URL': 'postgres://synthetic:synthetic@postgres/test'}
            def parsed(text):
                (path / 'overlay.yml').write_text(text)
                result = subprocess.run([compose, '-f', str(path / 'base.yml'),
                    '-f', str(path / 'overlay.yml'), '--profile', 'xhs-batch',
                    'config', '--format', 'json'], env=env, capture_output=True, text=True, check=True)
                return json.loads(result.stdout)['services']['xhs-batch']['tmpfs']
            self.assertEqual(parsed(candidate), ['/tmp:size=16m,mode=1777'])
            broken = candidate.replace('["/tmp:size=16m,mode=1777"]', '[/tmp:size=16m,mode=1777]')
            self.assertEqual(parsed(broken), ['/tmp:size=16m', 'mode=1777'])


if __name__ == '__main__':
    unittest.main()
