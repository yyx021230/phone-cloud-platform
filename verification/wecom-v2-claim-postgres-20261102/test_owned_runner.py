"""No PG, network or service is started by these runner safety unit tests."""
import importlib.util
from pathlib import Path
import os
import json
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

RUNNER = Path(__file__).with_name('run-owned-postgres.py')
spec = importlib.util.spec_from_file_location('owned_fixture_runner', RUNNER)
runner = importlib.util.module_from_spec(spec)
spec.loader.exec_module(runner)


class GuardTests(unittest.TestCase):
    def test_no_flag_returns_before_execute(self):
        with patch.object(runner, 'execute', side_effect=AssertionError('must not execute')):
            self.assertEqual(runner.main([]), 2)
            self.assertEqual(runner.main(['--anything']), 2)

    def test_subprocess_no_flag_starts_no_fixture(self):
        p = subprocess.run([sys.executable, '-I', '-B', str(RUNNER)], env={'PATH': '/usr/bin:/bin'}, capture_output=True, text=True, timeout=5)
        self.assertEqual(p.returncode, 2)
        self.assertIn('explicit_reviewed_invocation_required', p.stdout)

    def test_environment_does_not_inherit_database_or_node_options(self):
        with patch.dict(os.environ, {'DATABASE_URL': 'fixture-must-not-inherit', 'PGHOST': 'fixture-must-not-inherit', 'NODE_OPTIONS': 'fixture-must-not-inherit'}):
            self.assertEqual(set(runner.minimal_env()), {'PATH', 'LC_ALL', 'LANG'})
            self.assertNotIn('fixture-must-not-inherit', str(runner.minimal_env()))

    def test_known_exited_node_group_is_never_signaled(self):
        class Child:
            returncode = 0
            pid = 12345
        with patch.object(runner, 'group_exists', return_value=False), patch.object(runner.os, 'killpg', side_effect=AssertionError('no signal after reap')):
            self.assertTrue(runner.stop_owned_node(Child())['groupAbsent'])

    def test_root_rejects_before_manifest_or_process(self):
        with patch.object(runner.os, 'geteuid', return_value=0), patch.object(runner, 'verify_sources', side_effect=AssertionError('must not read/start')):
            with self.assertRaisesRegex(RuntimeError, 'nonroot_required'):
                runner.execute()

    def test_changed_source_hash_rejects_before_binary_or_service(self):
        with tempfile.TemporaryDirectory(prefix='wecom-runner-unit-') as name:
            root = Path(name); (root / 'source.txt').write_text('fixture source')
            (root / 'RUNNER_SOURCE_HASHES.json').write_text(json.dumps({'sourceSha256': {'source.txt': '0' * 64}}))
            with patch.object(runner, 'HERE', root), patch.object(runner, 'PROJECT', root):
                with self.assertRaisesRegex(RuntimeError, 'source_hash_changed'):
                    runner.verify_sources()


if __name__ == '__main__':
    unittest.main()
