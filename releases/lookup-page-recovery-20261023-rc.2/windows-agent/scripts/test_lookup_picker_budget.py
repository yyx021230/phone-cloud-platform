import unittest
import subprocess
from unittest import mock
import alipay_name_lookup as lookup
from test_lookup_account_picker_transition import tree

class PickerBudgetTests(unittest.TestCase):
    def test_slow_first_sample_cannot_consume_second_sample_budget(self):
        r=lookup.Runner({'serial':'SYNTHETIC','taskId':'budget'});clock=[0.0];calls=[];root=tree()
        def dump(token,**kw):
            calls.append(kw);clock[0]+=7.5
            return root,{c:p for p in root.iter() for c in p}
        r.dump=dump;r.emit=mock.Mock();r.adb=mock.Mock()
        with mock.patch.object(lookup.time,'monotonic',side_effect=lambda:clock[0]),mock.patch.object(lookup.time,'sleep',side_effect=lambda n:clock.__setitem__(0,clock[0]+n)):
            rows=r.wait_account_picker('budget',timeout=24)
        self.assertEqual(len(rows),2);self.assertEqual(len(calls),2)
        self.assertTrue(all(x['total_timeout']<=8 for x in calls));r.adb.assert_not_called()

    def test_full_dump_budget_bounds_mkdir_command_and_read(self):
        r=lookup.Runner({'serial':'SYNTHETIC','taskId':'budget'});clock=[0.0];seen=[]
        def adb(args,**kw):
            seen.append(kw['timeout']);clock[0]+=kw['timeout'];return b'' if kw.get('binary') else ''
        r.adb=adb
        with mock.patch.object(lookup.time,'monotonic',side_effect=lambda:clock[0]):
            with self.assertRaisesRegex(RuntimeError,'sample_timeout'):r.dump('budget',total_timeout=4)
        self.assertEqual(seen,[4]);self.assertEqual(clock[0],4)

    def test_one_valid_frame_followed_by_timeout_never_clicks(self):
        r=lookup.Runner({'serial':'SYNTHETIC','taskId':'budget'});clock=[0.0];n=[0];root=tree()
        def dump(token,**kw):
            n[0]+=1;clock[0]+=kw['total_timeout']
            if n[0]>1:raise subprocess.TimeoutExpired('synthetic',kw['total_timeout'])
            return root,{c:p for p in root.iter() for c in p}
        r.dump=dump;r.emit=mock.Mock();r.adb=mock.Mock()
        with mock.patch.object(lookup.time,'monotonic',side_effect=lambda:clock[0]),mock.patch.object(lookup.time,'sleep',side_effect=lambda n:clock.__setitem__(0,clock[0]+n)):
            with self.assertRaisesRegex(RuntimeError,'picker_not_stable'):r.wait_account_picker('budget',timeout=8)
        r.adb.assert_not_called();self.assertLessEqual(clock[0],8)

    def test_transport_failure_is_not_hidden_as_unstable_list(self):
        r=lookup.Runner({'serial':'SYNTHETIC'});r.dump=mock.Mock(side_effect=RuntimeError('device offline'));r.emit=mock.Mock()
        with self.assertRaisesRegex(RuntimeError,'device offline'):r.wait_account_picker('offline')

    def test_timed_out_dump_is_followed_by_two_complete_reads_without_reopening(self):
        import xml.etree.ElementTree as ET
        r=lookup.Runner({'serial':'SYNTHETIC','taskId':'budget'});clock=[0.0];commands=[];hung=[False]
        raw=ET.tostring(tree())
        def adb(args,**kw):
            commands.append(args)
            if args[:3]==['shell','uiautomator','dump']:
                if not hung[0]:
                    hung[0]=True;clock[0]+=kw['timeout'];raise subprocess.TimeoutExpired('synthetic',kw['timeout'])
                clock[0]+=2.5;return ''
            clock[0]+=.1
            return raw if args[:2]==['exec-out','cat'] else ''
        r.adb=adb;r.emit=mock.Mock()
        with mock.patch.object(lookup.time,'monotonic',side_effect=lambda:clock[0]),mock.patch.object(lookup.time,'sleep',side_effect=lambda n:clock.__setitem__(0,clock[0]+n)):
            rows=r.wait_account_picker('budget',timeout=24)
        self.assertEqual(len(rows),2);self.assertLess(clock[0],24)
        self.assertEqual(sum(a[:3]==['shell','uiautomator','dump'] for a in commands),3)
        self.assertFalse(any('input' in a for a in commands))
