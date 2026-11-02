import unittest
from wecom_cleanup import MAIN,TEST,ABSENT
from wecom_physical_verify import HostRef,VerifyStop,observe_exited_hosts,parse_forwards,verify_empty,ReadOnlyAdb


class Socket:
    def __init__(self,reply):self.reply=reply;self.sent=[];self.closed=False
    def recv(self,n):part=self.reply[:n];self.reply=self.reply[n:];return part
    def sendall(self,data):self.sent.append(data)
    def settimeout(self,value):self.timeout=value
    def close(self):self.closed=True


class PhysicalVerifyTests(unittest.TestCase):
    def args(self):
        return dict(serial='fixture',hosts=[HostRef(123,10)],process_created_at=lambda _:None,pids=lambda _:[],forwards=lambda:[],guard=lambda:True,check_budget=lambda:None,sleep=lambda _:None)

    def test_two_read_only_snapshots_prove_hosts_and_both_packages_empty(self):
        args=self.args();calls=[]
        args['pids']=lambda p:(calls.append(p)or[])
        args['forwards']=lambda:(calls.append('forward')or[])
        proof=verify_empty(**args)
        self.assertEqual(calls,[MAIN,TEST,'forward']*2);self.assertEqual(len(proof),2)
        self.assertEqual(proof[0].hosts[0].state,'absent')

    def test_no_host_or_alive_unknown_host_never_touches_phone(self):
        for hosts,process in (([],lambda _:None),([HostRef(123,10)],lambda _:10),([HostRef(123,10)],lambda _:float('nan'))):
            args=self.args();args.update(hosts=hosts,process_created_at=process,pids=lambda _:self.fail('must not touch phone'))
            with self.assertRaises(VerifyStop):verify_empty(**args)
        def denied(_):raise PermissionError('private')
        with self.assertRaisesRegex(VerifyStop,'wecom_original_host_unconfirmed'):observe_exited_hosts([HostRef(123,10)],denied)

    def test_reused_pid_is_old_host_absence_never_a_kill_request(self):
        args=self.args();args['process_created_at']=lambda _:11
        self.assertEqual(verify_empty(**args)[0].hosts[0].state,'replaced')
        for values in ((True,10),(123,True),(123,float('nan')),(0,10),(123,-1)):
            with self.assertRaises(VerifyStop):HostRef(*values)

    def test_contract_allows_up_to_eight_real_hosts_without_creating_any(self):
        for count in (1,5,8):
            hosts=[HostRef(100+i,10+i)for i in range(count)]
            self.assertEqual(len(observe_exited_hosts(hosts,lambda _:None)),count)
        with self.assertRaisesRegex(VerifyStop,'wecom_original_host_unconfirmed'):
            observe_exited_hosts([HostRef(100+i,10+i)for i in range(9)],lambda _:None)

    def test_either_package_or_any_target_forward_including_media_denies(self):
        for package in (MAIN,TEST):
            args=self.args();args['pids']=lambda p:['456']if p==package else[]
            with self.assertRaisesRegex(VerifyStop,'wecom_reader_still_present'):verify_empty(**args)
        args=self.args();args['forwards']=lambda:[('fixture','tcp:40000','localabstract:scrcpy')]
        with self.assertRaisesRegex(VerifyStop,'wecom_forward_still_present'):verify_empty(**args)

    def test_late_residual_in_second_snapshot_is_not_confirmed(self):
        args=self.args();calls=[]
        def read(package):calls.append(package);return['456']if len(calls)==4 else[]
        args['pids']=read
        with self.assertRaisesRegex(VerifyStop,'wecom_reader_still_present'):verify_empty(**args)

    def test_slow_first_reads_cannot_be_made_fresh_by_completion_timestamp(self):
        now=[0.];reads=[];forward_reads=[];args=self.args()
        def pids(package):
            reads.append(package)
            if len(reads)<=2:now[0]+=1.9
            return[]
        def forwards():
            forward_reads.append(1)
            if len(forward_reads)==1:now[0]+=1.9
            return[]
        args.update(pids=pids,forwards=forwards,clock=lambda:now[0],sleep=lambda seconds:now.__setitem__(0,now[0]+seconds))
        with self.assertRaisesRegex(VerifyStop,'wecom_tool_proof_stale'):verify_empty(**args)

    def test_wire_time_uses_same_earliest_fact_origin_not_upload_time(self):
        now=[0.];args=self.args()
        def pids(_):now[0]+=.1;return[]
        args.update(pids=pids,clock=lambda:now[0],wall_clock=lambda:1000.,sleep=lambda s:now.__setitem__(0,now[0]+s))
        proof=verify_empty(**args)
        self.assertEqual(proof[0].captured_at,0);self.assertEqual(proof[0].observed_at,1000)
        self.assertAlmostEqual(proof[1].captured_at,.45);self.assertAlmostEqual(proof[1].observed_at,1000.45)
        now[0]+=10;self.assertEqual(proof[0].observed_at,1000)

    def test_lost_lease_budget_or_stale_observations_stop_without_more_reads(self):
        args=self.args();args.update(guard=lambda:False,pids=lambda _:self.fail('no phone'))
        with self.assertRaisesRegex(VerifyStop,'wecom_cleanup_lease_lost'):verify_empty(**args)
        args=self.args();args['clock']=iter((0,0,4,4)).__next__
        with self.assertRaisesRegex(VerifyStop,'wecom_tool_proof_stale'):verify_empty(**args)
        def expired():raise VerifyStop('expired')
        args=self.args();args.update(check_budget=expired,pids=lambda _:self.fail('no phone'))
        with self.assertRaisesRegex(VerifyStop,'expired'):verify_empty(**args)

    def test_bad_pid_response_is_not_absence(self):
        for raw in (b'',b'private',b'__WECOM_PID_ABSENT_',b'123\n'+ABSENT.encode()):
            sock=Socket(b'OKAYOKAY'+raw)
            adb=ReadOnlyAdb('fixture',lambda:True,lambda:None,connect=lambda *a,**k:sock)
            with self.assertRaisesRegex(VerifyStop,'wecom_pid_proof_invalid'):adb.pids(MAIN)
            self.assertTrue(sock.closed)

    def test_exact_absence_marker_and_fixed_commands_only(self):
        sock=Socket(b'OKAYOKAY'+ABSENT.encode()+b'\n');addresses=[]
        def connect(address,**kwargs):addresses.append(address);return sock
        adb=ReadOnlyAdb('fixture',lambda:True,lambda:None,connect=connect)
        self.assertEqual(adb.pids(TEST),[]);self.assertEqual(addresses,[('127.0.0.1',5037)])
        commands=b''.join(sock.sent)
        self.assertIn(b'pidof com.netease.open.pocoservice.test',commands)
        for forbidden in (b'force-stop',b'killforward',b'install',b'input ',b'start-server'):self.assertNotIn(forbidden,commands)
        with self.assertRaises(ValueError):adb.pids('com.tencent.wework')

    def test_forward_empty_requires_complete_ack_and_length(self):
        for raw in (b'OKAY000',b'OKAY0010short',b'FAIL0000',b'OKAYgarb'):
            sock=Socket(raw);adb=ReadOnlyAdb('fixture',lambda:True,lambda:None,connect=lambda *a,**k:sock)
            with self.assertRaises(VerifyStop):adb.forwards()
            self.assertTrue(sock.closed)
        sock=Socket(b'OKAY0000');adb=ReadOnlyAdb('fixture',lambda:True,lambda:None,connect=lambda *a,**k:sock)
        self.assertEqual(adb.forwards(),())

    def test_forward_projection_preserves_target_and_rejects_malformed_global_rows(self):
        self.assertEqual(parse_forwards('other tcp:4444 tcp:10080\nfixture tcp:40000 localabstract:scrcpy','fixture'),(('fixture','tcp:40000','localabstract:scrcpy'),))
        for raw in ('fixture tcp:40000','other bad row extra','fixture tcp:40000 private!'):
            with self.assertRaisesRegex(VerifyStop,'wecom_forward_proof_invalid'):parse_forwards(raw,'fixture')

    def test_first_guard_failure_never_opens_a_socket(self):
        adb=ReadOnlyAdb('fixture',lambda:False,lambda:None,connect=lambda *a,**k:self.fail('no socket'))
        with self.assertRaisesRegex(VerifyStop,'wecom_cleanup_lease_lost'):adb.forwards()

    def test_operation_authority_is_fresh_before_open_and_each_command(self):
        calls=[];sock=Socket(b'OKAY0000')
        adb=ReadOnlyAdb('fixture',lambda:True,lambda:None,connect=lambda *a,**k:(calls.append('open')or sock),operation_guard=lambda:False)
        with self.assertRaisesRegex(VerifyStop,'wecom_cleanup_lease_lost'):adb.forwards()
        self.assertFalse(calls)
        permissions=iter((True,False))
        adb=ReadOnlyAdb('fixture',lambda:True,lambda:None,connect=lambda *a,**k:sock,operation_guard=lambda:next(permissions))
        with self.assertRaisesRegex(VerifyStop,'wecom_cleanup_lease_lost'):adb.forwards()
        self.assertFalse(sock.sent);self.assertTrue(sock.closed)

    def test_closed_read_allowlist_cannot_send_a_phone_or_server_mutation(self):
        sock=Socket(b'');adb=ReadOnlyAdb('fixture',lambda:True,lambda:None)
        for command in ('shell:input keyevent 224','host:kill','host-serial:fixture:killforward:tcp:40000'):
            with self.assertRaisesRegex(VerifyStop,'wecom_adb_read_command_invalid'):adb.command(sock,command)
        self.assertFalse(sock.sent)

if __name__=='__main__':unittest.main()
