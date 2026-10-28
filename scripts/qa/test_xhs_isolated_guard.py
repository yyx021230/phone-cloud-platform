import copy
import json
import subprocess
import tempfile
import time
import unittest
from pathlib import Path
from xhs_isolated_guard import validate
from xhs_isolated_runner import GuardedCommands


class LeaseBoundary(unittest.TestCase):
    def setUp(self):
        self.c = dict(deviceId='d', serial='s', deviceName='47', appSlot='app1', xhsId='x', accountName='name',
                      jobId='j', sessionId='session', lockId='lock', ownerUserId='owner', adbPath='fixture-adb')
        self.p = dict(self.c, allowed=True, checkedAt=100, activeLockCount=1, sessionAlive=True, lookupReserved=False)
        self.d = dict(deviceId='d', deviceName='47', adb={'serial': 's', 'state': 'device'},
                      occupancy={'kind': 'screen_control', 'sessionId': 'session'},
                      xhsAccounts=[{'appSlot': 'app1', 'xhsId': 'x', 'accountName': 'name', 'enabled': True}])

    def test_exact_lease_preserves_real_inventory(self):
        before = copy.deepcopy(self.d)
        self.assertIs(validate(self.c, self.p, [self.d], 1, 101), self.d)
        self.assertEqual(self.d, before)

    def test_every_identity_field_is_bound(self):
        for key in ('deviceId', 'serial', 'deviceName', 'appSlot', 'xhsId', 'accountName', 'jobId', 'sessionId', 'lockId', 'ownerUserId'):
            p = dict(self.p); p[key] = 'other'
            with self.subTest(key=key), self.assertRaises(RuntimeError): validate(self.c, p, [self.d], 1, 101)

    def test_stale_future_revoked_and_shared_proofs(self):
        for delta in ({'checkedAt': 90}, {'checkedAt': 102}, {'allowed': False}, {'activeLockCount': 2},
                      {'sessionAlive': False}, {'lookupReserved': True}):
            with self.subTest(delta=delta), self.assertRaises(RuntimeError): validate(self.c, dict(self.p, **delta), [self.d], 1, 101)

    def test_real_inventory_cannot_be_replaced_by_fake_xhs_occupancy(self):
        for occupancy in (None, {'kind': 'xhs_data_collect', 'taskId': 'j', 'appSlot': 'app1'},
                          {'kind': 'screen_control', 'sessionId': 'other'}):
            d = dict(self.d, occupancy=occupancy)
            with self.subTest(occupancy=occupancy), self.assertRaises(RuntimeError): validate(self.c, self.p, [d], 1, 101)

    def test_stale_offline_duplicate_disabled_or_changed_slot(self):
        with self.assertRaises(RuntimeError): validate(self.c, self.p, [self.d], 91, 101)
        with self.assertRaises(RuntimeError): validate(self.c, self.p, [self.d, self.d], 1, 101)
        for field, value in [('state', 'offline'), ('serial', 'another')]:
            d = copy.deepcopy(self.d); d['adb'][field] = value
            with self.assertRaises(RuntimeError): validate(self.c, self.p, [d], 1, 101)
        for key, value in [('enabled', False), ('appSlot', 'app2'), ('xhsId', 'changed')]:
            d = copy.deepcopy(self.d); d['xhsAccounts'][0][key] = value
            with self.assertRaises(RuntimeError): validate(self.c, self.p, [d], 1, 101)

    def test_lost_lease_kills_only_owned_client_and_blocks_late_restore(self):
        class Child:
            killed = False
            returncode = None
            def communicate(self, timeout=None):
                if self.killed: return b'', b''
                raise subprocess.TimeoutExpired('fixture', timeout)
            def poll(self): return -9 if self.killed else None
            def kill(self): self.killed = True
        with tempfile.TemporaryDirectory() as tmp:
            p = Path(tmp)/'cache.json'; p.write_text(json.dumps([self.d])); self.c['inventoryPath'] = str(p)
            child = Child(); calls = []
            def proof():
                calls.append(1)
                return dict(self.p, checkedAt=time.time(), allowed=len(calls) == 1)
            command = GuardedCommands(self.c, proof, identity=lambda c: None, popen=lambda *a, **k: child)
            with self.assertRaises(RuntimeError): command.run(['fixture-adb', '-s', 's', 'shell', 'input', 'tap', '1', '2'])
            self.assertTrue(child.killed)
            with self.assertRaises(RuntimeError): command.run(['fixture-adb', '-s', 's', 'shell', 'settings', 'put', 'system', 'screen_off_timeout', '1'])

    def test_wrong_target_or_identity_never_starts_process(self):
        def refuse(*a, **kw): raise AssertionError('must not start')
        command = GuardedCommands(self.c, refuse, identity=lambda c: (_ for _ in ()).throw(RuntimeError('identity')), popen=refuse)
        with self.assertRaises(RuntimeError): command.run(['fixture-adb', '-s', 'other', 'shell'])
        with self.assertRaises(RuntimeError): command.run(['fixture-adb', '-s', 's', 'shell'])

    def test_global_commands_and_shell_injection_are_rejected(self):
        command=GuardedCommands(self.c,lambda:None)
        for a in (['kill-server'],['start-server'],['reboot'],['tcpip','5555'],['usb'],['shell','reboot'],
                  ['shell','input','tap','1','2;reboot'],['shell','am','force-stop','another.app'],
                  ['shell','rm','-f','/sdcard/other'],['shell','settings','put','global','adb_enabled','0']):
            with self.subTest(a=a): self.assertFalse(command.allowed(a))

    def test_owned_temporary_paths_and_settings_are_explicit(self):
        command=GuardedCommands(self.c,lambda:None)
        name='/sdcard/phonecloud-xhs-capture-'+'a'*32+'.xml'
        self.assertFalse(command.allowed(['shell','rm','-f',name]))
        self.assertTrue(command.allowed(['shell','uiautomator','dump',name]))
        self.assertTrue(command.allowed(['exec-out','cat',name]))
        self.assertTrue(command.allowed(['shell','rm','-f',name]))
        self.assertTrue(command.allowed(['shell','settings','put','system','screen_off_timeout','30000']))

    def test_pinned_reader_has_no_alternative_process_entry(self):
        import ast
        root=Path(__file__).resolve().parents[2]
        for name in ('小红书数据同步.py','xhs_native_window.py'):
            tree=ast.parse((root/'windows-agent/scripts'/name).read_text())
            calls=[n for n in ast.walk(tree) if isinstance(n,ast.Call) and isinstance(n.func,ast.Attribute)
                   and isinstance(n.func.value,ast.Name) and n.func.value.id in ('os','subprocess')
                   and not (n.func.value.id=='os' and n.func.attr=='replace')]
            self.assertEqual([(n.func.value.id,n.func.attr) for n in calls], [('subprocess','run')] if name.startswith('小') else [])

    def test_real_child_is_stopped_when_proof_is_lost(self):
        with tempfile.TemporaryDirectory() as tmp:
            p=Path(tmp)/'cache.json';p.write_text(json.dumps([self.d]));self.c['inventoryPath']=str(p)
            binary=Path(tmp)/'fixture-client';binary.write_text('#!/usr/bin/env python3\nimport time\ntime.sleep(20)\n');binary.chmod(0o700)
            self.c['adbPath']=str(binary);children=[];calls=[]
            def spawn(*a,**k):
                child=subprocess.Popen(*a,**k);children.append(child);return child
            def prove():
                calls.append(1);return dict(self.p,checkedAt=time.time(),allowed=len(calls)==1)
            command=GuardedCommands(self.c,prove,identity=lambda c:None,popen=spawn)
            with self.assertRaises(RuntimeError):command.run([str(binary),'-s','s','get-state'])
            self.assertEqual(len(children),1);self.assertIsNotNone(children[0].poll())


if __name__ == '__main__': unittest.main()
