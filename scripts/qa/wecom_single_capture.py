"""Persist only original owned process births and typed reader resources."""
import json
import os
from pathlib import Path
import re

from wecom_staging_process import capture_process

TIMED_CALLS=frozenset(('qa.host_identity','qa.inventory','qa.proof_request','rpc.transport',
                       'rpc.freeze','hierarchy.snapshot','hierarchy.snapshot_any',
                       'ui.fill_remark','ui.fill_description','ui.save_remark','ui.observed_click'))
PROGRESS_PHASES=frozenset(('configuration','adb_identity','device_preflight','screen_prepare',
    'poco_launch','poco_health','wecom_launch','rpc_setup','startup_guards','foreground_wait',
    'selector_observe','selector_click','home_navigation','recipient_search','remark_edit',
    'remark_save','send_claim','invitation_send','cleanup','complete'))

def durable(path, value):
    path = Path(path)
    tmp = path.with_suffix('.tmp')
    with tmp.open('w', encoding='utf-8') as stream:
        json.dump(value, stream, ensure_ascii=True)
        stream.flush()
        os.fsync(stream.fileno())
    os.replace(tmp, path)


def original_hosts(stage, hosts):
    # Called before writing the UI envelope into the child's private stdin.
    durable(Path(stage)/'qa-original-hosts.json', dict(originalHosts=hosts))


def safe_resources(value):
    if not isinstance(value, dict) or set(value) != {'readerStarted', 'pid', 'startToken', 'forwards', 'cleanupConfirmed'}:
        return None
    if type(value['readerStarted']) is not bool or value['cleanupConfirmed'] not in (True, False, None): return None
    if any(not isinstance(value[k], str) or value[k] and not re.fullmatch(r'[1-9]\d{0,19}', value[k]) for k in ('pid', 'startToken')): return None
    pairs = value['forwards']
    if not isinstance(pairs, list) or len(pairs) > 2 or any(not isinstance(p, list) or len(p) != 2
            or type(p[0]) is not int or not 1024 < p[0] < 65536 or p[0] == 5037
            or type(p[1]) is not int or p[1] not in (10080, 10081) for p in pairs): return None
    return value


class ResourcePipe:
    def __init__(self, stream, stage, hosts):
        self.stream, self.stage, self.hosts = stream, Path(stage), hosts
        self.line = ''
        self.discard = False
        self.failure = None
        self.timings = {}
        self.progress_count = 0

    def read(self, size):
        # A flushed short resource frame must reach fsync while the child is
        # alive; TextIO.read(8192) can wait until EOF or a full buffer.
        value = self.stream.readline(size)
        for char in value:
            if char == '\n':
                if not self.discard and self.line.startswith('WECOM_DIAGNOSTIC '):
                    try:
                        row=json.loads(self.line[len('WECOM_DIAGNOSTIC '):]);phase=row.get('phase')
                        if (isinstance(phase,str)and phase in PROGRESS_PHASES and row.get('state')in('begin','end','error')
                                and type(row.get('elapsedMs'))is int and 0<=row['elapsedMs']<=900000
                                and self.progress_count<80):
                            self.progress_count+=1
                            durable(self.stage/'qa-latest-progress.json',dict(version=1,phase=phase,state=row['state'],elapsedMs=row['elapsedMs']))
                    except Exception:pass  # Optional progress cannot change resource/authority outcomes.
                if not self.discard and self.line.startswith('WECOM_CALL '):
                    try:
                        row = json.loads(self.line[len('WECOM_CALL '):])
                        label=row.get('call');duration=row.get('durationMs')
                        if (row.get('kind')=='call'and row.get('state')in('end','error')
                                and isinstance(label,str)and label in TIMED_CALLS and type(duration)is int and 0<=duration<=300000):
                            stat=self.timings.setdefault(label,dict(count=0,totalMs=0,maxMs=0,errors=0))
                            if stat['count']<8000:
                                stat['count']+=1;stat['totalMs']+=duration;stat['maxMs']=max(stat['maxMs'],duration)
                                stat['errors']+=int(row['state']=='error')
                        if row.get('kind')=='lifecycle'and row.get('event')=='before_final_json':
                            durable(self.stage/'qa-call-summary.json',dict(version=1,calls=self.timings,overlappingDurations=True))
                        if row.get('kind') == 'resources':
                            resources = safe_resources(row.get('resources'))
                            if resources is None: raise ValueError()
                            durable(self.stage/'qa-owned-resources.json', dict(originalHosts=self.hosts, resources=resources))
                    except Exception:
                        # Never replace a prior valid journal with partial/raw UI.
                        # A recording failure makes this run ineligible to restore.
                        self.failure = 'qa_resource_record_unknown'
                self.line = ''; self.discard = False
            elif not self.discard:
                self.line += char
                if len(self.line) > 16384: self.line = ''; self.discard = True
        return value


def capture_owned(process, stage, hosts):
    pipe = ResourcePipe(process.stderr, stage, hosts)
    process.stderr = pipe
    answer = capture_process(process, inspect_node=lambda pid: hosts[0],
                             observe_native=lambda pid: hosts[1])
    answer['resourceRecordFailure'] = pipe.failure
    return answer
