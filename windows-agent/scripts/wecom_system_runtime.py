"""Read-only identity guard for the original SYSTEM Agent and shared ADB.

Never starts a process or connects to ADB. Any missing/unconfirmed identity
stops before the caller is allowed to open the fixed smart-socket endpoint.
"""
from dataclasses import dataclass
import os
from wecom_physical_verify import HostRef,VerifyStop

SYSTEM='NT AUTHORITY\\SYSTEM'
AGENT_EXE='d:/phonecloud/tools/node/node.exe'
AGENT_ENTRY='d:/phonecloud/agent/src/index.mjs'
ADB_EXE='d:/phonecloud/tools/android-sdk/platform-tools/adb.exe'
PYTHON_EXE='d:/phonecloud/tools/python39/python.exe'


def path_key(value):return str(value).replace('\\','/').lower()


@dataclass(frozen=True)
class ProcessIdentity:
    host: HostRef
    exe: str
    owner: str


def process_identity(runtime,pid,expected_path):
    process=runtime.Process(pid)
    value=ProcessIdentity(HostRef(pid,process.create_time()),path_key(process.exe()),process.username())
    if value.owner!=SYSTEM or value.exe!=expected_path:raise VerifyStop('wecom_system_identity_unconfirmed')
    return value


class SystemRuntimeGuard:
    def __init__(self,*,runtime=None,agent_pid=None,current_pid=None,parent_pid=None,platform=None):
        if (os.name if platform is None else platform)!='nt':raise VerifyStop('wecom_windows_system_required')
        if runtime is None:import psutil;runtime=psutil
        self.runtime=runtime;self.current_pid=os.getpid()if current_pid is None else current_pid
        self.parent_pid=os.getppid()if parent_pid is None else parent_pid
        self.agent_pid=self.parent_pid if agent_pid is None else agent_pid
        if type(self.agent_pid)is not int or self.agent_pid<=0 or self.agent_pid!=self.parent_pid:
            raise VerifyStop('wecom_agent_parent_unconfirmed')
        try:self.worker,self.agent,self.adb=self._capture()
        except VerifyStop:raise
        except Exception:raise VerifyStop('wecom_system_identity_unconfirmed')from None

    def _capture(self):
        worker=process_identity(self.runtime,self.current_pid,PYTHON_EXE)
        agent=process_identity(self.runtime,self.agent_pid,AGENT_EXE)
        if not any(path_key(a)==AGENT_ENTRY for a in self.runtime.Process(self.agent_pid).cmdline()):
            raise VerifyStop('wecom_agent_entry_unconfirmed')
        if self.runtime.Process(self.current_pid).ppid()!=self.agent_pid:raise VerifyStop('wecom_agent_parent_unconfirmed')
        listeners={c.pid for c in self.runtime.net_connections(kind='tcp')if c.status=='LISTEN'and c.laddr.port==5037}
        if len(listeners)!=1 or None in listeners:raise VerifyStop('wecom_adb_listener_unconfirmed')
        adb=process_identity(self.runtime,next(iter(listeners)),ADB_EXE)
        return worker,agent,adb

    def check(self):
        try:
            if self._capture()!=(self.worker,self.agent,self.adb):raise VerifyStop('wecom_system_runtime_changed')
        except VerifyStop:raise
        except Exception:raise VerifyStop('wecom_system_identity_unconfirmed')from None
        return True
