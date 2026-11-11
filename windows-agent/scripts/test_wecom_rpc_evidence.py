import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
from wecom_rpc_evidence import background_events,log_command,read_shell,RpcEvidenceProbe,UID_COMMAND,DATE_COMMAND

START='2026-11-03 15:00:00.000'
FREEZE='11-03 15:00:10.000 1 2 I OplusHansManager : freeze uid: 10318 com.netease.open.pocoservice pids: [123] scene: LcdOn'
THAW=FREEZE.replace('15:00:10','15:00:11').replace('freeze uid:','unfreeze uid:')


class EvidenceTests(unittest.TestCase):
    def test_current_uid_package_pid_and_time_are_all_required(self):
        self.assertTrue(background_events(FREEZE,10318,'123',START)['activeFreezeForOwnedPid'])
        for raw,uid,pid in((FREEZE,10319,'123'),(FREEZE,10318,'124'),(FREEZE.replace('15:00:10','14:59:59'),10318,'123'),
                           (FREEZE.replace('15:00:10','15:09:10'),10318,'123'),(FREEZE.replace('pocoservice ','pocoservice.other '),10318,'123')):
            self.assertFalse(background_events(raw,uid,pid,START)['activeFreezeForOwnedPid'])

    def test_unfreeze_clears_positive_evidence_and_raw_text_never_retained(self):
        value=background_events(FREEZE+' private UI data\n'+THAW,10318,'123',START)
        self.assertFalse(value['activeFreezeForOwnedPid']);self.assertNotIn('private',json.dumps(value))

    def test_year_boundary_and_fixed_command_allowlist(self):
        raw=FREEZE.replace('11-03 15:00:10','01-01 00:00:10')
        self.assertTrue(background_events(raw,10318,'123','2026-12-31 23:59:50.000')['activeFreezeForOwnedPid'])
        self.assertIn("-T '11-03 15:00:00.000'",log_command(START))
        for value in("2026-11-03 15:00:00.000';input tap 1 1",'unknown'):
            with self.assertRaises(ValueError):log_command(value)
        with patch('wecom_rpc_evidence.socket.create_connection')as connect:
            with self.assertRaises(ValueError):read_shell('fixture','am force-stop com.tencent.wework')
            connect.assert_not_called()

    def test_probe_records_only_once_and_never_retries_rpc_or_shell(self):
        calls=[]
        def read(serial,command):
            calls.append(command)
            if command==UID_COMMAND:return 'package:com.netease.open.pocoservice uid:10318'
            if command==DATE_COMMAND:return START
            return FREEZE+' private customer details'
        with tempfile.TemporaryDirectory()as folder:
            root=Path(folder)/'staging/wecom-qa-unit';root.mkdir(parents=True)
            probe=RpcEvidenceProbe('fixture',root,read=read);probe.prepare()
            probe.capture({'reason':'read_timeout','errorType':'ReadTimeout','elapsedMs':12000},{'pid':'123'})
            probe.capture({'secret':'private'},{'pid':'123'})
            value=json.loads((root/'qa-rpc-evidence.json').read_text())
            self.assertTrue(value['activeFreezeForOwnedPid']);self.assertEqual(len(calls),3)
            self.assertNotIn('private',json.dumps(value));self.assertFalse(value['rawRetained'])

    def test_missing_baseline_never_invents_freeze_or_queries_log(self):
        calls=[]
        def read(serial,command):calls.append(command);raise TimeoutError('private')
        with tempfile.TemporaryDirectory()as folder:
            root=Path(folder)/'staging/wecom-qa-unit';root.mkdir(parents=True)
            probe=RpcEvidenceProbe('fixture',root,read=read);probe.prepare();probe.capture({}, {'pid':'123'})
            value=json.loads((root/'qa-rpc-evidence.json').read_text());self.assertFalse(value['available'])
            self.assertEqual(len(calls),1);self.assertNotIn('private',json.dumps(value))


if __name__=='__main__':unittest.main()
