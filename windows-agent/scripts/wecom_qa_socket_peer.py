"""Single staged preview only: attest the actual TCP peer before sending bytes.

No server creation, ADB client, identity change, or shared Agent imports. The
process-local socket class is restored on exit. Production entry points never
import this helper. Missing Windows connection-owner evidence is a hard stop.
"""
import contextlib
import math
import socket
import urllib.parse
import weakref
from pathlib import PureWindowsPath

from wecom_invite_preview import StopPreview


class PeerDenied(StopPreview):
    pass


class SocketPeerGuard:
    def __init__(self, binding, *, forwards, runtime=None):
        if runtime is None:
            import psutil
            runtime = psutil
        self.runtime, self.forwards = runtime, forwards
        self.pid, self.birth = binding['adbPid'], binding['adbCreatedAt']
        url = urllib.parse.urlsplit(binding['brokerUrl'])
        if (type(self.pid) is not int or self.pid <= 0 or type(self.birth) not in (int, float)
                or not math.isfinite(self.birth) or self.birth <= 0 or url.scheme != 'http' or url.hostname != '127.0.0.1'
                or not url.port or url.port == 5037):
            raise PeerDenied('qa_socket_binding_invalid')
        self.broker_port = url.port
        self.revoked = False
        self._states = weakref.WeakKeyDictionary()
        self._installed = False
        self._connections = 0
        self._checks = 0

    def deny(self):
        self.revoked = True
        raise PeerDenied('qa_socket_peer_unconfirmed') from None

    def allow_address(self, address):
        if self.revoked:
            self.deny()
        if (not isinstance(address, tuple) or len(address) != 2
                or address[0] != '127.0.0.1' or type(address[1]) is not int):
            self.deny()
        port = address[1]
        try:
            mappings = list(self.forwards())
            if any(len(p) != 2 or type(p[0]) is not int or not 1024 < p[0] < 65536
                   or p[0] in (5037, self.broker_port) or p[1] not in (10080, 10081)
                   for p in mappings):
                self.deny()
            allowed = {5037, self.broker_port, *(p[0] for p in mappings)}
            if port not in allowed:
                self.deny()
        except PeerDenied:
            raise
        except Exception:
            self.deny()
        return port

    def process_identity(self):
        process = self.runtime.Process(self.pid)
        if (process.create_time() != self.birth or process.username() != r'NT AUTHORITY\SYSTEM'
                or PureWindowsPath(process.exe()) != PureWindowsPath(
                    r'D:\PhoneCloud\tools\android-sdk\platform-tools\adb.exe')):
            self.deny()

    def attest(self, wire, *, scan):
        try:
            if self.revoked:
                self.deny()
            local, peer = tuple(wire.getsockname()), tuple(wire.getpeername())
            port = self.allow_address(peer)
            if local[0] != '127.0.0.1' or not 0 < local[1] < 65536 or wire.fileno() < 0:
                self.deny()
            state = (local, peer, wire.fileno())
            prior = self._states.get(wire)
            if prior is not None and prior != state:
                self.deny()
            # Broker traffic is independently authenticated by ScreenAuthority.
            # It is not evidence about the ADB execution peer.
            if port != self.broker_port:
                self.process_identity()
                if scan:
                    owners = [row.pid for row in self.runtime.net_connections(kind='tcp')
                              if row.status == 'ESTABLISHED' and tuple(row.laddr) == peer
                              and tuple(row.raddr) == local]
                    if owners != [self.pid]:
                        self.deny()
                    # Catch PID reuse while the connection table was read.
                    self.process_identity()
                self._checks += 1
            return state, port
        except PeerDenied:
            raise
        except Exception:
            self.deny()

    def connected(self, wire, requested):
        self.allow_address(requested)
        if tuple(wire.getpeername()) != requested:
            self.deny()
        state, port = self.attest(wire, scan=True)
        self._states[wire] = state
        if port != self.broker_port:
            self._connections += 1

    def before_io(self, wire, *, write=True):
        if wire not in self._states:
            self.deny()
        self.attest(wire, scan=write)

    def summary(self):
        return dict(executionConnections=self._connections, peerChecks=self._checks,
                    revoked=self.revoked)

    @contextlib.contextmanager
    def install(self):
        if self._installed:
            raise PeerDenied('qa_socket_guard_already_installed')
        original = socket.socket
        guard = self

        class BoundSocket(original):
            def connect(self, address):
                guard.allow_address(address)
                try:
                    super().connect(address)
                    guard.connected(self, address)
                except Exception:
                    self.close()
                    raise

            def connect_ex(self, address):
                # This runner uses blocking HTTP/ADB. Do not grant authority to
                # an unobserved asynchronous connection or a later reused fd.
                self.connect(address)
                return 0

            def sendall(self, *args, **kwargs):
                guard.before_io(self)
                return super().sendall(*args, **kwargs)

            def send(self, *args, **kwargs):
                guard.before_io(self)
                return super().send(*args, **kwargs)

            def recv(self, *args, **kwargs):
                guard.before_io(self, write=False)
                return super().recv(*args, **kwargs)

            def recv_into(self, *args, **kwargs):
                guard.before_io(self, write=False)
                return super().recv_into(*args, **kwargs)

            def sendto(self, *args, **kwargs):
                guard.deny()

        self._installed = True
        socket.socket = BoundSocket
        try:
            yield self
        finally:
            # Never overwrite a second mutation made by other code.
            if socket.socket is not BoundSocket:
                self.revoked = True
                raise PeerDenied('qa_socket_class_changed')
            socket.socket = original
            self._installed = False
