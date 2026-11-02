"""Read-only WeCom physical verification primitives; no cleanup mutations.

These internal observations are deliberately not a wire protocol. The fixed
server contract supplies intent/owner/generation and serializes final proof.
No SDK import, installation, ADB CLI, server startup, key or identity changes.
"""
from dataclasses import dataclass
import math
import re
import socket
import time
from wecom_cleanup import MAIN, TEST, pid_command, parse_pids


class VerifyStop(RuntimeError):pass


@dataclass(frozen=True)
class HostRef:
    pid: int
    created_at: float

    def __post_init__(self):
        if type(self.pid)is not int or self.pid<=0 or type(self.created_at)not in(int,float)or not math.isfinite(self.created_at)or self.created_at<=0:
            raise VerifyStop('wecom_original_host_unconfirmed')


@dataclass(frozen=True)
class HostObservation:
    expected: HostRef
    observed_created_at: object
    state: str


@dataclass(frozen=True)
class ToolSnapshot:
    hosts: tuple
    main_pids: tuple
    test_pids: tuple
    forwards: tuple
    captured_at: float
    observed_at: float


def observe_exited_hosts(hosts, process_created_at):
    if not isinstance(hosts,(list,tuple))or not 1<=len(hosts)<=8 or any(not isinstance(h,HostRef)for h in hosts)or len({h.pid for h in hosts})!=len(hosts):
        raise VerifyStop('wecom_original_host_unconfirmed')
    result=[]
    for ref in hosts:
        try:value=process_created_at(ref.pid)
        except Exception:raise VerifyStop('wecom_original_host_unconfirmed')from None
        if value is not None and(type(value)not in(int,float)or not math.isfinite(value)or value<=0):
            raise VerifyStop('wecom_original_host_unconfirmed')
        if value==ref.created_at:raise VerifyStop('wecom_original_host_still_alive')
        result.append(HostObservation(ref,value,'absent'if value is None else 'replaced'))
    return tuple(result)


def parse_forwards(raw, serial):
    if not isinstance(raw,str)or not re.fullmatch(r'[A-Za-z0-9_.:-]{1,128}',serial):raise VerifyStop('wecom_forward_proof_invalid')
    rows=[]
    for line in raw.splitlines():
        if not line.strip():continue
        values=line.split()
        if len(values)!=3 or not re.fullmatch(r'[A-Za-z0-9_.:-]{1,128}',values[0])or any(not re.fullmatch(r'[A-Za-z0-9_.:/@-]{1,512}',v)for v in values[1:]):
            raise VerifyStop('wecom_forward_proof_invalid')
        if values[0]==serial:rows.append(tuple(values))
    return tuple(rows)


def verify_empty(*, serial, hosts, process_created_at, pids, forwards,
                 guard, check_budget, sleep=time.sleep, clock=time.monotonic,wall_clock=time.time):
    """Two fresh snapshots; any target forward (including media) denies proof.

    This function has no stop/remove callback. A live/replaced/unknown resource
    cannot cause a kill, forward deletion, UI input or a shared recovery.
    """
    observations=[]
    # Take wall first, then monotonic: the translation is conservative, never
    # newer than the actual observation. One origin covers both frames and wire
    # timestamps; completion or proof upload must never restamp old facts.
    wall_origin=wall_clock();monotonic_origin=clock()
    if not all(type(v)in(int,float)and math.isfinite(v)for v in (wall_origin,monotonic_origin)):
        raise VerifyStop('wecom_clock_unconfirmed')
    def check():
        check_budget()
        if guard()is not True:raise VerifyStop('wecom_cleanup_lease_lost')
        check_budget()
    for index in range(2):
        check();started=clock();observed_at=wall_origin+(started-monotonic_origin)
        if not math.isfinite(started)or started<monotonic_origin:raise VerifyStop('wecom_clock_unconfirmed')
        origin=observe_exited_hosts(hosts,process_created_at)
        check();main=pids(MAIN)
        check();test=pids(TEST)
        check();mappings=forwards()
        if not isinstance(main,(list,tuple))or not isinstance(test,(list,tuple))or any(not isinstance(p,str)or not re.fullmatch(r'[1-9]\d{0,19}',p)for p in tuple(main)+tuple(test)):
            raise VerifyStop('wecom_pid_proof_invalid')
        if not isinstance(mappings,(list,tuple))or any(not isinstance(row,(list,tuple))or len(row)!=3 or row[0]!=serial for row in mappings):
            raise VerifyStop('wecom_forward_proof_invalid')
        if main or test:raise VerifyStop('wecom_reader_still_present')
        if mappings:raise VerifyStop('wecom_forward_still_present')
        check();observe_exited_hosts(hosts,process_created_at)
        observations.append(ToolSnapshot(origin,tuple(main),tuple(test),tuple(mappings),started,observed_at))
        if index==0:sleep(.25)
    check()
    if not 0<=clock()-observations[0].captured_at<=3:raise VerifyStop('wecom_tool_proof_stale')
    return tuple(observations)


class ReadOnlyAdb:
    """Smart-socket reads against the already-attested fixed shared listener."""
    def __init__(self,serial,guard,check_budget,*,connect=socket.create_connection,operation_guard=None):
        if not re.fullmatch(r'[A-Za-z0-9_.:-]{1,128}',serial):raise VerifyStop('wecom_serial_invalid')
        self.serial,self.guard,self.budget,self.connect=serial,guard,check_budget,connect
        self.operation_guard=operation_guard

    def check(self):
        self.budget()
        if self.guard()is not True:raise VerifyStop('wecom_cleanup_lease_lost')
        self.budget()

    def exact(self,connection,size):
        data=b''
        while len(data)<size:
            self.check();part=connection.recv(size-len(data))
            if not part:raise VerifyStop('wecom_adb_response_incomplete')
            data+=part
        return data

    def command(self,connection,value):
        allowed=('host:transport:'+self.serial,'host:list-forward','shell:'+pid_command(MAIN),'shell:'+pid_command(TEST))
        if value not in allowed:raise VerifyStop('wecom_adb_read_command_invalid')
        self.check()
        if self.operation_guard is not None and self.operation_guard()is not True:raise VerifyStop('wecom_cleanup_lease_lost')
        self.check();raw=value.encode('ascii')
        connection.sendall(('%04x'%len(raw)).encode('ascii')+raw)
        if self.exact(connection,4)!=b'OKAY':raise VerifyStop('wecom_adb_read_rejected')

    def open(self):
        self.check()
        if self.operation_guard is not None and self.operation_guard()is not True:raise VerifyStop('wecom_cleanup_lease_lost')
        self.check();connection=self.connect(('127.0.0.1',5037),timeout=2)
        try:connection.settimeout(2);self.check();return connection
        except Exception:connection.close();raise

    def pids(self,package):
        command=pid_command(package)  # Closed two-package allowlist.
        connection=self.open();raw=b''
        try:
            self.command(connection,'host:transport:'+self.serial)
            self.command(connection,'shell:'+command)
            while True:
                self.check();part=connection.recv(4096)
                if not part:break
                raw+=part
                if len(raw)>4096:raise VerifyStop('wecom_pid_proof_invalid')
        finally:connection.close()
        self.check()
        try:return parse_pids(raw.decode('ascii'))
        except(ValueError,UnicodeError):raise VerifyStop('wecom_pid_proof_invalid')from None

    def forwards(self):
        connection=self.open()
        try:
            self.command(connection,'host:list-forward')
            header=self.exact(connection,4)
            if not re.fullmatch(rb'[0-9a-fA-F]{4}',header):raise VerifyStop('wecom_forward_proof_invalid')
            length=int(header,16)
            raw=self.exact(connection,length)
        finally:connection.close()
        self.check()
        try:return parse_forwards(raw.decode('ascii'),self.serial)
        except UnicodeError:raise VerifyStop('wecom_forward_proof_invalid')from None
