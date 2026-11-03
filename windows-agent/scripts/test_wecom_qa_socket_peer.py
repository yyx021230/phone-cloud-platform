import socket
import unittest
from types import SimpleNamespace as Row
from unittest.mock import patch

from wecom_qa_socket_peer import SocketPeerGuard, PeerDenied, PeerUnavailable


class Runtime:
    def __init__(self):
        self.birth = 123.25
        self.owner = r'NT AUTHORITY\SYSTEM'
        self.peer_pid = 41
        self.connections = []
        self.process_reads = 0

    def Process(self, pid):
        self.process_reads += 1
        if pid != 41:
            raise RuntimeError('missing')
        return Row(create_time=lambda: self.birth, username=lambda: self.owner,
                   exe=lambda: r'D:\PhoneCloud\tools\android-sdk\platform-tools\adb.exe')

    def net_connections(self, kind):
        return self.connections


class Wire:
    def __init__(self, port=5037):
        self.local = ('127.0.0.1', 45001)
        self.peer = ('127.0.0.1', port)

    def getsockname(self): return self.local
    def getpeername(self): return self.peer
    def fileno(self): return 99


def fixture():
    runtime = Runtime()
    binding = dict(adbPid=41, adbCreatedAt=123.25,
                   brokerUrl='http://127.0.0.1:41001')
    wire = Wire()
    runtime.connections = [Row(status='ESTABLISHED', pid=41,
                               laddr=wire.peer, raddr=wire.local)]
    guard = SocketPeerGuard(binding, runtime=runtime, forwards=lambda: [(42001, 10081)])
    return runtime, wire, guard


class PeerTests(unittest.TestCase):
    def test_closed_forward_never_sends_and_does_not_revoke_other_connections(self):
        runtime, _, guard = fixture()
        original = socket.socket
        with original() as listener:
            listener.bind(('127.0.0.1',0));listener.listen()
            port=listener.getsockname()[1];guard.forwards=lambda:[(port,10080)]
            runtime.connections=[]
            with original() as client:
                client.connect(('127.0.0.1',port));peer,_=listener.accept();peer.close()
                # Observe the actual FIN first; MSG_PEEK does not consume data.
                client.settimeout(.5);self.assertEqual(client.recv(1,socket.MSG_PEEK),b'')
                with self.assertRaises(PeerUnavailable):guard.connected(client,('127.0.0.1',port))
            self.assertFalse(guard.revoked)
            self.assertEqual(guard.summary()['closedForwardCount'],1)
            wire=Wire();runtime.connections=[Row(status='ESTABLISHED',pid=41,laddr=wire.peer,raddr=wire.local)]
            guard.connected(wire,wire.peer);guard.before_io(wire)

    def test_forward_owner_can_appear_before_bounded_deadline_without_sending(self):
        runtime,wire,guard=fixture();wire.peer=('127.0.0.1',42001)
        row=Row(status='ESTABLISHED',pid=41,laddr=wire.peer,raddr=wire.local)
        replies=iter([[],[row]])
        runtime.net_connections=lambda kind:next(replies)
        guard.connected(wire,wire.peer)
        self.assertFalse(guard.revoked)

    def test_wrong_forward_owner_still_revokes_even_when_peer_is_closed(self):
        runtime,wire,guard=fixture();wire.peer=('127.0.0.1',42001)
        runtime.connections=[Row(status='ESTABLISHED',pid=42,laddr=wire.peer,raddr=wire.local)]
        with patch.object(guard,'peer_closed',return_value=True):
            with self.assertRaises(PeerDenied):guard.connected(wire,wire.peer)
        self.assertTrue(guard.revoked)
        self.assertEqual(guard.summary()['closedForwardCount'],0)

    def test_first_denial_records_fixed_facts_and_is_not_overwritten(self):
        runtime, wire, guard = fixture()
        runtime.connections[0].pid = 42
        with self.assertRaises(PeerDenied): guard.connected(wire, wire.peer)
        first=dict(guard.summary()['firstDenial'])
        self.assertEqual(first,dict(reason='connection_owner',operation='connect',portClass='adb',ownerCount=1,expectedOwnerPresent=False))
        with self.assertRaises(PeerDenied): guard.before_io(wire)
        self.assertEqual(guard.summary()['firstDenial'],first)

    def test_inspection_exception_never_records_its_raw_text(self):
        runtime, wire, guard = fixture()
        def failure(kind):raise ValueError('private exception text must not be logged')
        runtime.net_connections=failure
        with self.assertRaises(PeerDenied): guard.connected(wire, wire.peer)
        first=guard.summary()['firstDenial']
        self.assertEqual(first['errorType'],'ValueError')
        self.assertEqual(first['stage'],'connection_owner')
        self.assertNotIn('private',str(first))

    def test_actual_reverse_tuple_not_listener_is_required(self):
        runtime, wire, guard = fixture()
        runtime.connections = [Row(status='LISTEN', pid=41, laddr=wire.peer, raddr=())]
        with self.assertRaises(PeerDenied): guard.connected(wire, wire.peer)
        self.assertTrue(guard.revoked)

    def test_server_pid_birth_owner_and_actual_tuple_are_bound(self):
        for mutation in ('pid', 'birth', 'owner', 'tuple', 'duplicate'):
            with self.subTest(mutation=mutation):
                runtime, wire, guard = fixture()
                if mutation == 'pid': runtime.connections[0].pid = 42
                if mutation == 'birth': runtime.birth += 1
                if mutation == 'owner': runtime.owner = 'Administrator'
                if mutation == 'tuple': runtime.connections[0].raddr = ('127.0.0.1', 45002)
                if mutation == 'duplicate': runtime.connections *= 2
                with self.assertRaises(PeerDenied): guard.connected(wire, wire.peer)

    def test_retained_socket_rechecks_birth_and_never_recovers(self):
        runtime, wire, guard = fixture()
        guard.connected(wire, wire.peer)
        guard.before_io(wire)
        runtime.birth += 1
        with self.assertRaises(PeerDenied): guard.before_io(wire)
        runtime.birth -= 1
        with self.assertRaises(PeerDenied): guard.before_io(wire)

    def test_fd_or_peer_change_cannot_reuse_connection_proof(self):
        _, wire, guard = fixture()
        guard.connected(wire, wire.peer)
        wire.peer = ('127.0.0.1', 42001)
        with self.assertRaises(PeerDenied): guard.before_io(wire)

    def test_forward_ports_are_owned_and_broker_is_separate(self):
        runtime, wire, guard = fixture()
        wire.peer = ('127.0.0.1', 42001)
        runtime.connections[0].laddr = wire.peer
        guard.connected(wire, wire.peer)
        guard.before_io(wire)
        self.assertEqual(guard.summary()['executionConnections'], 1)
        broker = Wire(41001)
        guard.connected(broker, broker.peer)
        guard.before_io(broker)
        self.assertEqual(guard.summary()['executionConnections'], 1)

    def test_unexpected_remote_or_unregistered_forward_is_denied(self):
        for address in [('127.0.0.1', 42002), ('192.0.2.1', 5037), ('localhost', 5037)]:
            with self.subTest(address=address):
                _, _, guard = fixture()
                with self.assertRaises(PeerDenied): guard.allow_address(address)

    def test_revoked_forward_stops_retained_socket(self):
        runtime, wire, guard = fixture()
        wire.peer = ('127.0.0.1', 42001)
        runtime.connections[0].laddr = wire.peer
        guard.connected(wire, wire.peer)
        guard.forwards = lambda: []
        with self.assertRaises(PeerDenied): guard.before_io(wire)

    def test_real_local_connect_is_checked_before_first_byte_and_restored(self):
        runtime, _, guard = fixture()
        original = socket.socket
        with original() as listener:
            listener.bind(('127.0.0.1', 0)); listener.listen()
            port = listener.getsockname()[1]
            guard.forwards = lambda: [(port, 10081)]
            # A real TCP connection without an attributable server-side OS row
            # must close without sending even one request byte.
            runtime.connections = []
            with guard.install():
                with self.assertRaises(PeerDenied):
                    socket.create_connection(('127.0.0.1', port), .5)
            self.assertIs(socket.socket, original)
            accepted, _ = listener.accept()
            with accepted:
                accepted.settimeout(.5)
                self.assertEqual(accepted.recv(1), b'')

    def test_nested_install_is_denied_and_socket_class_restored(self):
        _, _, guard = fixture()
        old_class = socket.socket
        with guard.install():
            with self.assertRaises(PeerDenied):
                with guard.install(): pass
        self.assertIs(socket.socket, old_class)

    def test_real_connected_send_and_http_makefile_reads_are_guarded(self):
        runtime, _, guard = fixture()
        original = socket.socket
        with original() as listener:
            listener.bind(('127.0.0.1', 0)); listener.listen()
            port = listener.getsockname()[1]
            guard.forwards = lambda: [(port, 10081)]
            accepted = []
            def rows(kind):
                if not accepted:
                    fd, _ = listener._accept()
                    accepted.append(original(fileno=fd))
                peer = accepted[0]
                return [Row(status='ESTABLISHED', pid=41,
                            laddr=peer.getsockname(), raddr=peer.getpeername())]
            runtime.net_connections = rows
            with guard.install():
                with socket.create_connection(('127.0.0.1', port), .5) as client:
                    client.sendall(b'preview')
                    self.assertEqual(accepted[0].recv(7), b'preview')
                    accepted[0].sendall(b'OK\n')
                    with client.makefile('rb') as response:
                        self.assertEqual(response.readline(), b'OK\n')
                    runtime.birth += 1
                    with self.assertRaises(PeerDenied): client.sendall(b'forbidden')
            accepted[0].settimeout(.5)
            self.assertEqual(accepted[0].recv(1), b'')
            accepted[0].close()


if __name__ == '__main__': unittest.main()
