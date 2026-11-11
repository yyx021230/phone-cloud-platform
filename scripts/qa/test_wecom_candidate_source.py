import unittest
import uuid
from wecom_candidate_source import ROOT,candidate_files

class ImmutableSourceTests(unittest.TestCase):
    def test_old_ref_bundle_ignores_new_untracked_worktree_module(self):
        ref='55590757f80cff3c2c15833b2ca1a5c116d5363b';before=candidate_files(ref)
        path=ROOT/'windows-agent/scripts'/('wecom_untracked_probe_'+uuid.uuid4().hex+'.py');data=b'# local test only; never imported\n'
        with path.open('xb')as out:out.write(data)
        try:self.assertEqual(candidate_files(ref),before)
        finally:
            if path.read_bytes()!=data:raise AssertionError('parallel change preserved')
            path.unlink()

if __name__=='__main__':unittest.main()
