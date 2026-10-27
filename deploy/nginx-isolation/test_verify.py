import importlib.util
from pathlib import Path
import stat
import tempfile
import unittest
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location("nginx_safe_verify", Path(__file__).with_name("verify.py"))
guard = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(guard)


class IsolationTests(unittest.TestCase):
    def test_root_refused_before_any_resource_or_command(self):
        with patch.object(guard.os, "geteuid", return_value=0), \
             patch.object(guard.tempfile, "TemporaryDirectory") as tmp, \
             patch.object(guard.subprocess, "run") as run, \
             patch.object(guard.subprocess, "Popen") as process:
            with self.assertRaisesRegex(RuntimeError, "ROOT_FORBIDDEN"):
                guard.verify("/nonexistent/nginx")
            tmp.assert_not_called()
            run.assert_not_called()
            process.assert_not_called()

    def test_capabilities_refused(self):
        with self.assertRaisesRegex(RuntimeError, "CAPABILITIES_FORBIDDEN"):
            guard.require_unprivileged(65534, "CapEff:\t0000000000000001\n")

    def test_normal_nonroot_allowed(self):
        guard.require_unprivileged(65534, "CapEff:\t0000000000000000\n")

    def test_all_five_temp_paths_are_explicit(self):
        config = guard.render_config(Path("/tmp/pc-nginx-safe-fixture"))
        for key, value in guard.TEMP_PATHS.items():
            self.assertEqual(config.count(f"{key} /tmp/pc-nginx-safe-fixture/{value};"), 1)

    def test_only_private_unix_sockets_no_include_or_production_paths(self):
        config = guard.render_config(Path("/tmp/pc-nginx-safe-fixture"))
        self.assertEqual(config.count("listen "), 1)
        self.assertIn("listen unix:/tmp/pc-nginx-safe-fixture/front.sock;", config)
        for forbidden in ["include ", "/etc/nginx", "/var/lib/nginx", "/var/log/nginx", "127.0.0.1", "8787", "8889", "user "]:
            self.assertNotIn(forbidden, config)

    def test_request_spills_and_pid_logs_are_private(self):
        config = guard.render_config(Path("/tmp/pc-nginx-safe-fixture"))
        for value in ["client_body_buffer_size 1k", "client_max_body_size 128k", "pid /tmp/pc-nginx-safe-fixture/", "error_log /tmp/pc-nginx-safe-fixture/", "lock_file /tmp/pc-nginx-safe-fixture/"]:
            self.assertIn(value, config)

    def test_path_injection_and_relative_paths_rejected(self):
        for path in ["relative", "/tmp/a;b", "/tmp/a\nb", "/tmp/a b", "/tmp/a/../b", "/tmp/a{b"]:
            with self.subTest(path=path), self.assertRaises(ValueError):
                guard.render_config(Path(path))

    def test_metadata_ignores_normal_request_timestamps(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder)
            before = guard.metadata((path,))
            (path / "synthetic").touch()
            self.assertEqual(before, guard.metadata((path,)))

    def test_metadata_detects_permission_drift(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder)
            before = guard.metadata((path,))
            path.chmod(0o750)
            self.assertNotEqual(before, guard.metadata((path,)))

    def test_missing_path_is_explicit(self):
        self.assertEqual(guard.metadata((Path("/nonexistent/nginx-safe-test"),)), {"/nonexistent/nginx-safe-test": None})

    def test_worker_identity_with_production_write_access_refused(self):
        with tempfile.TemporaryDirectory() as folder:
            with self.assertRaisesRegex(RuntimeError, "PRODUCTION_WRITE_ACCESS_FORBIDDEN"):
                guard.require_no_production_write_access((Path(folder),))

    def test_no_production_write_access_allowed(self):
        with patch.object(guard.os, "access", return_value=False):
            guard.require_no_production_write_access((Path(__file__),))

    def test_privileged_binary_refused(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "not-nginx"
            path.touch()
            path.chmod(stat.S_ISUID | 0o700)
            with patch.object(guard, "require_unprivileged"), self.assertRaisesRegex(RuntimeError, "PRIVILEGED_BINARY_FORBIDDEN"):
                guard.verify(str(path))


if __name__ == "__main__":
    unittest.main()
