import hashlib
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import zipfile

from verify_bundle import safe_member, verify_archive, verify_bundle
from capture_final_state import assert_runtime_unchanged, capture, stable_bytes


class MigrationSafetyTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)

    def zip(self, name='test.zip', content=b'test'):
        p = self.root / name
        with zipfile.ZipFile(p, 'w') as z:
            z.writestr('D/PhoneCloud/agent/src/index.mjs', content)
        return p, [{'path': 'D/PhoneCloud/agent/src/index.mjs', 'bytes': len(content),
                    'sha256': hashlib.sha256(content).hexdigest()}]

    def test_full_file_validation(self):
        p, entries = self.zip()
        self.assertEqual(verify_archive(p, entries), 1)

    def test_content_corruption_fails(self):
        p, entries = self.zip()
        entries[0]['sha256'] = '0' * 64
        with self.assertRaisesRegex(ValueError, 'hash_mismatch'):
            verify_archive(p, entries)

    def test_unexpected_entry_fails(self):
        p, entries = self.zip()
        with zipfile.ZipFile(p, 'a') as z:
            z.writestr('extra', b'new')
        with self.assertRaises(ValueError):
            verify_archive(p, entries)

    def test_missing_entry_fails(self):
        p, entries = self.zip()
        entries.append({'path': 'missing', 'bytes': 1, 'sha256': '0'*64})
        with self.assertRaisesRegex(ValueError, 'entries_missing'):
            verify_archive(p, entries)

    def test_path_escape_rejected(self):
        for name in ('../x', '/x', 'D:/x', 'x\\y', 'x/../y', 'x//y'):
            with self.subTest(name=name), self.assertRaises(ValueError):
                safe_member(name)

    def test_case_collision_rejected_on_mac_as_windows(self):
        p, _ = self.zip()
        with zipfile.ZipFile(p, 'a') as z:
            z.writestr('d/phonecloud/agent/src/index.mjs', b'collision')
        with self.assertRaisesRegex(ValueError, 'duplicate'):
            verify_archive(p)

    def test_archive_symlink_rejected(self):
        p = self.root / 'link.zip'
        info = zipfile.ZipInfo('link')
        info.create_system = 3
        info.external_attr = (0o120777 << 16)
        with zipfile.ZipFile(p, 'w') as z:
            z.writestr(info, '/outside')
        with self.assertRaisesRegex(ValueError, 'symlink'):
            verify_archive(p)

    def test_package_metadata_hash_checked(self):
        f = self.root / 'MANIFEST.private.json'
        f.write_text('{}')
        (self.root/'PACKAGE_MANIFEST.json').write_text(json.dumps({'files': {
            f.name: {'bytes': 2, 'sha256': '0'*64}}}))
        with self.assertRaisesRegex(ValueError, 'package_file_hash_mismatch'):
            verify_bundle(self.root)

    def baseline(self):
        p = self.root / 'agent/src/index.mjs'
        p.parent.mkdir(parents=True)
        p.write_bytes(b'original')
        return {'entries': [{'path': 'D/PhoneCloud/agent/src/index.mjs',
                            'sha256': hashlib.sha256(b'original').hexdigest()}]}

    def test_unchanged_runtime_passes(self):
        assert_runtime_unchanged(self.root, self.baseline())

    def test_changed_runtime_stops_final_capture(self):
        m = self.baseline()
        (self.root/'agent/src/index.mjs').write_bytes(b'changed')
        with self.assertRaisesRegex(ValueError, 'runtime_changed'):
            assert_runtime_unchanged(self.root, m)

    def test_added_runtime_stops_final_capture(self):
        m = self.baseline()
        (self.root/'agent/src/new.mjs').write_bytes(b'new')
        with self.assertRaisesRegex(ValueError, 'runtime_added'):
            assert_runtime_unchanged(self.root, m)

    def test_capture_is_archival_and_excludes_instance_lock_and_keys(self):
        (self.root/'agent/data').mkdir(parents=True)
        (self.root/'agent/config.json').write_text('{}')
        (self.root/'agent/data/state.json').write_text('{"value":1}')
        (self.root/'agent/data/agent-instance.lock').write_text('old PID')
        (self.root/'adbkey').write_text('not copied')
        out = self.root/'backup'
        receipt = capture(self.root, out)
        with zipfile.ZipFile(out/'final-state.private.zip') as z:
            self.assertEqual(set(z.namelist()), {'agent/config.json','agent/data/state.json'})
        self.assertFalse(receipt['keysCopied'])
        self.assertTrue((self.root/'agent/data/agent-instance.lock').exists())
        with self.assertRaises(FileExistsError):
            capture(self.root, out)

    def test_changing_state_fails_closed(self):
        p = self.root/'state'
        p.write_bytes(b'one')
        with patch.object(Path, 'read_bytes', side_effect=[b'one', b'two']):
            with self.assertRaisesRegex(ValueError, 'not_quiescent'):
                stable_bytes(p)


if __name__ == '__main__':
    unittest.main()
