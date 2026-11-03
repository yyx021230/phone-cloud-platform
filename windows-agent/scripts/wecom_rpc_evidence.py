"""Isolated QA only: bounded read-only RPC failure evidence, no raw UI/logs."""
import datetime
import json
import os
from pathlib import Path
import re
import socket
import time
from wecom_rpc_budget import safe_rpc_failure

PACKAGE='com.netease.open.pocoservice'
UID_COMMAND='pm list packages --user 0 -U '+PACKAGE
DATE_COMMAND="date '+%Y-%m-%d %H:%M:%S.000'"
LOG_TAGS='OplusHansManager:V OplusBinderProxy:V OAppNetControlService:V AndroidRuntime:E ActivityManager:I'


def log_command(start):
    if not isinstance(start,str)or not re.fullmatch(r'\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3}',start):
        raise ValueError('qa_probe_time_invalid')
    datetime.datetime.strptime(start,'%Y-%m-%d %H:%M:%S.%f')
    return "logcat -d -T '"+start[5:]+"' -v threadtime "+LOG_TAGS+" '*:S'"


def background_events(raw,uid,pid,start):
    """Positive freeze requires this UID, package, original PID and task window."""
    if type(uid)is not int or uid<=0 or not re.fullmatch(r'[1-9]\d{0,19}',pid):
        raise ValueError('qa_probe_identity_invalid')
    origin=datetime.datetime.strptime(start,'%Y-%m-%d %H:%M:%S.%f');events=[];active=None
    for line in raw.splitlines():
        stamp=re.match(r'(\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3})',line)
        if not stamp or not re.search(r'(?<!\d)'+str(uid)+r'(?!\d)',line):continue
        try:
            month=int(stamp[1][:2]);year=origin.year+(1 if origin.month==12 and month==1 else 0)
            moment=datetime.datetime.strptime(str(year)+'-'+stamp[1],'%Y-%m-%d %H:%M:%S.%f')
        except ValueError:continue
        if not 0<=(moment-origin).total_seconds()<=240:continue
        kind=None;pids=[]
        if PACKAGE in line:
            thaw=re.search(r'\bunfreeze uid:\s*'+str(uid)+r'\s+'+re.escape(PACKAGE)+r'\s+pids:\s*\[([0-9, ]*)\]',line)
            freeze=re.search(r'(?<!un)\bfreeze uid:\s*'+str(uid)+r'\s+'+re.escape(PACKAGE)+r'\s+pids:\s*\[([0-9, ]*)\]',line)
            matched=thaw or freeze
            if matched:
                pids=re.findall(r'\d+',matched[1]);kind='unfreeze'if thaw else'freeze'
            elif 'OplusBinderProxy'in line and 'proxy: true'in line:kind='binder_freeze'
            elif 'OplusBinderProxy'in line and 'proxy: false'in line:kind='binder_unfreeze'
        if 'OAppNetControlService'in line and re.search(r'Hans update:\['+str(uid)+r'=true\]',line):kind='network_block'
        if 'OAppNetControlService'in line and re.search(r'Hans update:\['+str(uid)+r'=false\]',line):kind='network_unblock'
        if kind:
            event={'deviceTime':moment.isoformat(timespec='milliseconds'),'kind':kind,'uid':uid,'pids':pids}
            events.append(event)
            if pid in pids:
                active=event if kind=='freeze'else None
    return {'events':events[-80:],'activeFreezeForOwnedPid':active is not None,'matchedFreeze':active}


def read_shell(serial,command):
    if not isinstance(serial,str)or not re.fullmatch(r'[A-Za-z0-9_.:-]{1,100}',serial):raise ValueError('qa_probe_serial_invalid')
    if not isinstance(command,str):raise ValueError('qa_probe_command_invalid')
    allowed=command in(UID_COMMAND,DATE_COMMAND)
    if command.startswith("logcat -d -T '"):
        match=re.fullmatch(r"logcat -d -T '(\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3})' -v threadtime "+re.escape(LOG_TAGS)+r" '\*:S'",command)
        allowed=bool(match)
    if not allowed:raise ValueError('qa_probe_command_invalid')
    until=time.monotonic()+3
    def remaining():
        left=until-time.monotonic()
        if left<=0:raise TimeoutError('qa_probe_deadline')
        return min(1,left)
    wire=socket.create_connection(('127.0.0.1',5037),remaining())
    def exact(size):
        raw=b''
        while len(raw)<size:
            wire.settimeout(remaining());part=wire.recv(size-len(raw))
            if not part:raise OSError('qa_probe_incomplete')
            raw+=part
        return raw
    try:
        for value in('host:transport:'+serial,'shell:'+command):
            wire.settimeout(remaining());raw=value.encode('ascii');wire.sendall(('%04x'%len(raw)).encode('ascii')+raw)
            if exact(4)!=b'OKAY':raise OSError('qa_probe_rejected')
        raw=b''
        while True:
            wire.settimeout(remaining());part=wire.recv(4096)
            if not part:break
            raw+=part
            if len(raw)>262144:raise ValueError('qa_probe_output_budget')
        return raw.decode('utf-8','replace')
    finally:wire.close()


class RpcEvidenceProbe:
    def __init__(self,serial,folder,*,read=read_shell):
        self.serial,self.folder,self.read=serial,Path(folder),read
        if '/staging/wecom-qa-'not in str(self.folder).replace('\\','/'):
            raise ValueError('qa_probe_path_invalid')
        self.uid=None;self.start=None;self.captured=False;self.value={'version':1,'rawRetained':False,'rpcFailureObserved':False}

    def save(self):
        path=self.folder/'qa-rpc-evidence.json';temporary=path.with_suffix('.tmp')
        with temporary.open('w',encoding='ascii')as handle:
            json.dump(self.value,handle,ensure_ascii=True);handle.flush();os.fsync(handle.fileno())
        os.replace(temporary,path)

    def prepare(self):
        try:
            raw=self.read(self.serial,UID_COMMAND)
            uids=re.findall(r'(?m)^package:'+re.escape(PACKAGE)+r' uid:(\d+)\s*$',raw)
            if len(uids)!=1:raise ValueError('qa_probe_uid_unknown')
            self.uid=int(uids[0]);self.start=self.read(self.serial,DATE_COMMAND).strip();log_command(self.start)
            self.value.update(baselineAvailable=True,uid=self.uid,deviceStart=self.start)
        except Exception:self.value.update(baselineAvailable=False)
        try:self.save()
        except OSError:pass

    def capture(self,details,resources):
        if self.captured:return
        self.captured=True;self.value.update(rpcFailureObserved=True,transportFailure=safe_rpc_failure(details))
        try:
            pid=resources.get('pid','')
            if self.uid is None or self.start is None:raise ValueError('qa_probe_baseline_unknown')
            raw=self.read(self.serial,log_command(self.start))
            self.value.update(available=True,ownedPid=pid,**background_events(raw,self.uid,pid,self.start))
        except Exception as error:
            self.value.update(available=False,evidenceError='read_timeout'if isinstance(error,TimeoutError)else'unavailable')
        try:self.save()
        except OSError:pass
