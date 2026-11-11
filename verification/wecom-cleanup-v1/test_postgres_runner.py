"""Startup-diagnostic negative cases; no PostgreSQL server is started."""
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

RUNNER = Path(__file__).with_name('run-postgres.py')


class StartupDiagnosticTests(unittest.TestCase):
    def run_failed_start(self, write_log):
        with tempfile.TemporaryDirectory(prefix='pc-pg-runner-negative-') as base:
            root = Path(base)
            for name in ('initdb', 'pg_ctl', 'createdb', 'dropdb', 'node'):
                executable = root / name
                source = f'#!{sys.executable}\nimport sys, os\nfrom pathlib import Path\n'
                source += "assert os.environ.get('LC_ALL') == 'C' and os.environ.get('LANG') == 'C'\n"
                if name == 'initdb':
                    source += 'sys.exit(0)\n'
                elif name == 'pg_ctl':
                    source += "args=sys.argv[1:]\nassert args[-1]=='start'\nlog=Path(args[args.index('-l')+1])\n"
                    source += f"Path({str(root / 'cluster-path')!r}).write_text(str(log.parent))\n"
                    if write_log:
                        source += "log.write_text('synthetic startup failure: fixture-only cause\\n')\n"
                    source += 'sys.exit(1)\n'
                else:
                    source += "raise AssertionError('must not reach tests after startup failure')\n"
                executable.write_text(source)
                executable.chmod(0o700)
            result = subprocess.run([sys.executable, str(RUNNER)], env={'PATH': str(root)}, capture_output=True, text=True, timeout=10)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn('FIXTURE_POSTGRES_START_FAILED', result.stdout)
            if write_log:
                self.assertIn('synthetic startup failure: fixture-only cause', result.stdout)
            else:
                self.assertIn('Fixture startup log unavailable: FileNotFoundError', result.stdout)
            self.assertFalse(Path((root / 'cluster-path').read_text()).exists())

    def test_preserves_original_startup_cause_before_cleanup(self):
        self.run_failed_start(True)

    def test_missing_log_is_explicit_and_still_fails(self):
        self.run_failed_start(False)


if __name__ == '__main__':
    unittest.main()
