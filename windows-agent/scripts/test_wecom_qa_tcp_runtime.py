import ctypes
import socket
import struct
import unittest
from types import SimpleNamespace
from wecom_qa_tcp_runtime import parse_table,fetch_table,WindowsTcpRuntime,identity_scope,MAX_BYTES
from wecom_qa_socket_peer import SocketPeerGuard,PeerDenied
from wecom_screen_lease import ScreenAuthority
from test_wecom_qa_socket_peer import Runtime,Wire
from test_wecom_screen_lease import fixture


def v4(pid=41,*,state=5,local=('127.0.0.1',5037),remote=('127.0.0.1',45001)):
    ip=lambda s:struct.unpack('<I',socket.inet_aton(s))[0]
    return struct.pack('<IIIIII',state,ip(local[0]),socket.htons(local[1]),ip(remote[0]),socket.htons(remote[1]),pid)

def v6(pid=41,port=5037,state=2):
    return struct.pack('<16sII16sIIII',socket.inet_pton(socket.AF_INET6,'::1'),0,socket.htons(port),bytes(16),0,0,state,pid)

def table(*rows):return struct.pack('<I',len(rows))+b''.join(rows)


class TcpParserTests(unittest.TestCase):
    def test_ipv4_ports_endpoints_states_and_duplicate_owners_are_preserved(self):
        rows=parse_table(table(v4(state=2),v4(),v4(),v4(state=11)),2)
        self.assertEqual([r.status for r in rows],['LISTEN','ESTABLISHED','ESTABLISHED'])
        self.assertEqual(rows[0].laddr.port,5037)
        self.assertEqual(rows[1].laddr,('127.0.0.1',5037))
        self.assertEqual(rows[1].raddr,('127.0.0.1',45001))
        self.assertEqual([r.pid for r in rows[1:]],[41,41])

    def test_ipv6_listener_owner_is_not_dropped(self):
        row=parse_table(table(v6(pid=55)),23)[0]
        self.assertEqual(row.status,'LISTEN');self.assertEqual(row.laddr,('::1',5037));self.assertEqual(row.pid,55)

    def test_truncated_oversize_or_wrong_state_tables_are_not_empty_facts(self):
        for raw,family in ((b'',2),(table(v4())[:-1],2),(table(v4())+b'X',2),(struct.pack('<I',100001),2),
                           (table(v4(state=99)),2),(table(v6(state=5)),23),(table(),99)):
            with self.assertRaises(ValueError):parse_table(raw,family)

    def test_kernel_errors_and_excessive_growth_never_return_partial_data(self):
        with self.assertRaises(OSError):fetch_table(2,5,lambda *args:5)
        def huge(buf,size,*args):size._obj.value=MAX_BYTES+1;return 122
        with self.assertRaises(ValueError):fetch_table(2,5,huge)
        def growing(buf,size,*args):size._obj.value+=1;return 122
        with self.assertRaisesRegex(RuntimeError,'changed_too_often'):fetch_table(2,5,growing)

    def test_buffer_growth_reads_new_snapshot_and_keeps_read_only_api_arguments(self):
        calls=[];raw=table(v4());first=[True]
        def call(buf,size,order,family,kind,reserved):
            calls.append((order,family,kind,reserved))
            if first[0]:first[0]=False;size._obj.value=300000;return 122
            ctypes.memmove(buf,raw,len(raw));size._obj.value=len(raw);return 0
        self.assertEqual(fetch_table(2,5,call),raw)
        self.assertEqual(calls,[(False,2,5,0)]*2)

    def test_each_query_reads_both_families_without_connection_fact_cache(self):
        calls=[];owner=[41]
        def read(family,kind):calls.append((family,kind));return table(v4(owner[0]))if family==2 else table()
        runtime=WindowsTcpRuntime(process=lambda pid:None,read_table=read)
        self.assertEqual(runtime.net_connections(kind='tcp')[0].pid,41);owner[0]=42
        self.assertEqual(runtime.net_connections(kind='tcp')[0].pid,42)
        self.assertEqual(calls,[(2,5),(23,3)]*2)
        with self.assertRaises(ValueError):runtime.net_connections(kind='all')


class TcpGuardTests(unittest.TestCase):
    def test_owner_change_after_connect_still_denies_before_send(self):
        process=Runtime();owner=[41]
        runtime=WindowsTcpRuntime(process=process.Process,read_table=lambda family,kind:table(v4(owner[0]))if family==2 else table())
        guard=SocketPeerGuard(dict(adbPid=41,adbCreatedAt=123.25,brokerUrl='http://127.0.0.1:41001'),forwards=lambda:[],runtime=runtime)
        wire=Wire();guard.connected(wire,wire.peer);owner[0]=42
        with self.assertRaises(PeerDenied):guard.before_io(wire)
        self.assertTrue(guard.revoked)

    def test_ipv6_read_error_is_unknown_not_an_ipv4_only_grant(self):
        process=Runtime()
        def read(family,kind):
            if family==23:raise OSError(5,'denied')
            return table(v4())
        runtime=WindowsTcpRuntime(process=process.Process,read_table=read)
        guard=SocketPeerGuard(dict(adbPid=41,adbCreatedAt=123.25,brokerUrl='http://127.0.0.1:41001'),forwards=lambda:[],runtime=runtime)
        with self.assertRaises(PeerDenied):guard.connected(Wire(),('127.0.0.1',5037))
        self.assertTrue(guard.revoked)

    def test_second_ipv6_adb_listener_still_breaks_unique_owner(self):
        c,_,_=fixture();c.update(agentPid=1,agentCreatedAt=1,agentExe='agent.exe',adbPid=41,adbCreatedAt=2)
        def process(pid):return SimpleNamespace(username=lambda:r'NT AUTHORITY\SYSTEM',create_time=lambda:1 if pid==1 else 2,exe=lambda:'agent.exe'if pid==1 else r'D:\PhoneCloud\tools\android-sdk\platform-tools\adb.exe')
        runtime=WindowsTcpRuntime(process=process,read_table=lambda family,kind:table(v4(state=2))if family==2 else table(v6(pid=55)))
        authority=ScreenAuthority(c,runtime=runtime)
        with self.assertRaisesRegex(ValueError,'qa_adb_listener_changed'):authority.host_identity()
        runtime.read_table=lambda family,kind:table(v4(state=2))if family==2 else table()
        authority.host_identity()


class IdentityScopeTests(unittest.TestCase):
    def test_every_identity_read_checks_current_authority_and_restores_on_error(self):
        original=lambda:-1;host=SimpleNamespace(adb_identity=original,observed=lambda name:lambda fn:fn)
        calls=[];authority=SimpleNamespace(binding={'adbPid':41},host_identity=lambda:calls.append(True))
        with self.assertRaisesRegex(ValueError,'body_stopped'):
            with identity_scope(host,authority):
                self.assertEqual(host.adb_identity(),41);self.assertEqual(host.adb_identity(),41)
                raise ValueError('body_stopped')
        self.assertIs(host.adb_identity,original);self.assertEqual(len(calls),2)

    def test_identity_failure_never_returns_cached_binding_pid(self):
        original=lambda:-1;host=SimpleNamespace(adb_identity=original,observed=lambda name:lambda fn:fn)
        def denied():raise ValueError('identity_changed')
        authority=SimpleNamespace(binding={'adbPid':41},host_identity=denied)
        with identity_scope(host,authority):
            with self.assertRaisesRegex(ValueError,'identity_changed'):host.adb_identity()
        self.assertIs(host.adb_identity,original)

    def test_foreign_hook_is_not_silently_overwritten(self):
        host=SimpleNamespace(adb_identity=lambda:-1,observed=lambda name:lambda fn:fn)
        authority=SimpleNamespace(binding={'adbPid':41},host_identity=lambda:None);foreign=lambda:-2
        with self.assertRaisesRegex(RuntimeError,'qa_identity_hook_changed'):
            with identity_scope(host,authority):host.adb_identity=foreign
        self.assertIs(host.adb_identity,foreign)


if __name__=='__main__':unittest.main()
