"""Isolated QA entry point, never installed as the shared Agent's runner.

Requires a separate broker proving the real production screen lease before every
ADB command, including native staging/cleanup and settings restoration. It never
changes the production inventory. Lost ownership blocks writes and retains the
caller's settings ledger instead of changing a subsequent owner's phone.
"""
import hashlib
import importlib.util
import json
import math
import os
import re
import subprocess
import sys
import time
import urllib.request
import urllib.error
import uuid
from pathlib import Path
from types import SimpleNamespace
from xhs_isolated_guard import validate_file


def read_proof(c, opener=urllib.request.urlopen, sleep=time.sleep, clock=time.monotonic):
    deadline=clock()+5
    while clock()<deadline:
        nonce=uuid.uuid4().hex;started=clock()
        request=urllib.request.Request(c['brokerUrl']+'/guard',data=json.dumps({'jobId':c['jobId'],'nonce':nonce}).encode(),
                                       headers={'Authorization':'Bearer '+c['brokerToken'],'Content-Type':'application/json'})
        try:
            with opener(request,timeout=min(2,max(.1,deadline-started))) as r: proof=json.load(r)
            if proof.get('nonce')!=nonce:raise RuntimeError('qa_broker_reply_nonce_mismatch')
            proof['localObservedAt']=clock();proof['roundTripSeconds']=proof['localObservedAt']-started
            age=proof.get('brokerProofAgeSeconds')
            if (not proof.get('allowed') or isinstance(age,bool) or not isinstance(age,(int,float))
                    or not math.isfinite(age) or age<0):
                raise RuntimeError('qa_broker_proof_invalid')
            # HTTP 200 can already be stale after transport. Pause and ask for a
            # new snapshot within the same five-second budget; never renew its age.
            if (0<=proof['roundTripSeconds']<=3
                    and age+proof['roundTripSeconds']+clock()-proof['localObservedAt']<=3
                    and clock()<deadline):
                return proof
        except urllib.error.HTTPError as error:
            if error.code!=503:raise  # A real ownership conflict is never retried.
        except (urllib.error.URLError,TimeoutError,OSError):
            pass
        if clock()>=deadline:break
        sleep(min(.2,deadline-clock()))  # No device operation is started while awaiting a fresh proof.
    raise RuntimeError('qa_fresh_lease_proof_unavailable')


def attest(config):
    import psutil
    listeners = {c.pid for c in psutil.net_connections(kind='tcp') if c.status == 'LISTEN' and c.laddr.port == 5037}
    if len(listeners) != 1 or None in listeners:
        raise RuntimeError('qa_adb_listener_unproven')
    p = psutil.Process(next(iter(listeners)))
    if p.pid != config['adbPid'] or p.username().upper() != r'NT AUTHORITY\SYSTEM' or p.exe().lower() != config['adbPath'].lower():
        raise RuntimeError('qa_adb_identity_changed')
    p = psutil.Process(config['agentPid'])
    if p.username().upper() != r'NT AUTHORITY\SYSTEM' or p.create_time() != config['agentCreatedAt']:
        raise RuntimeError('qa_agent_identity_changed')


class GuardedCommands:
    def __init__(self, config, prove, identity=attest, popen=subprocess.Popen):
        self.config, self.prove, self.identity, self.popen = config, prove, identity, popen
        self.paths = set()
        self.native_commands = {}

    def trace(self, event, **fields):
        if not self.config.get('stage'):return
        try:
            p=Path(self.config['stage'])/'qa-trace.jsonl'
            if p.exists() and p.stat().st_size>2*1024*1024:return
            with p.open('a',encoding='utf-8') as f:f.write(json.dumps({'at':time.time(),'event':event,**fields})+'\n')
        except OSError:pass

    def allowed(self, args):
        a = tuple(args)
        if a in (('get-state',), ('shell','ps','-A'), ('shell','dumpsys','window'),
                 ('shell','dumpsys','window','policy'), ('shell','dumpsys','power'),
                 ('shell','wm','dismiss-keyguard'), ('shell','wm','size'), ('shell','pm','list','users')):
            return True
        if len(a)==3 and a[:2]==('shell','getprop') and a[2] in ('ro.product.manufacturer','ro.build.version.sdk'): return True
        if len(a)==4 and a[:3]==('shell','input','keyevent') and a[3] in ('3','4','24','26','82','224'): return True
        if a[:3] in (('shell','input','tap'),('shell','input','swipe')):
            return len(a)==(5 if a[2]=='tap' else 8) and all(re.fullmatch(r'\d{1,5}',s) for s in a[3:])
        if a[:2]==('shell','settings') and len(a) in (5,6):
            return a[3:5] in (('system','screen_off_timeout'),('global','enable_screen_on_proximity_sensor')) and (
                len(a)==5 and a[2]=='get' or len(a)==6 and a[2]=='put' and bool(re.fullmatch(r'\d{1,10}',a[5])))
        if a[:3]==('shell','pm','list') and len(a)>=5 and a[3]=='packages':
            return a[4:]==('com.xingin.xhs',) or len(a)==7 and a[4]=='--user' and a[5].isdigit() and a[6]=='com.xingin.xhs'
        if a[:5]==('shell','cmd','package','resolve-activity','--brief'):
            rest=a[5:]
            return rest==('com.xingin.xhs',) or len(rest)==3 and rest[0]=='--user' and rest[1].isdigit() and rest[2]=='com.xingin.xhs'
        if a[:2]==('shell','am') and len(a)>=4:
            rest=list(a[3:])
            if a[2]=='start' and rest[:1]==['-W']: rest=rest[1:]
            if rest[:1]==['--user'] and len(rest)>=3 and rest[1].isdigit(): rest=rest[2:]
            return (a[2]=='force-stop' and rest in (['com.xingin.xhs'],['com.netease.open.pocoservice'])
                    or a[2]=='start' and len(rest)==2 and rest[0]=='-n' and bool(re.fullmatch(r'com\.xingin\.xhs/[\w.$]+',rest[1])))
        if a in (('exec-out','uiautomator','dump','/dev/tty'),('exec-out','uiautomator','dump','--compressed','/dev/tty')): return True
        if len(a)==4 and a[:3]==('shell','uiautomator','dump') and re.fullmatch(r'/sdcard/phonecloud-xhs-capture-[a-f0-9]{32}\.xml',a[3]):
            self.paths.add(a[3]); return True
        if len(a)==3 and a[:2] in (('exec-out','cat'),('shell','ls')): return a[2] in self.paths
        if len(a)==4 and a[:3]==('shell','rm','-f'): return a[3] in self.paths
        if len(a)==3 and a[0]=='push':
            for path_key,sha_key,prefix,commands in (
                    ('nativeAsset','nativeAssetSha256','pc-xhs-elements-',('20 /system/bin/app_process /system/bin NativeWindowReader',)),
                    ('nativePairAsset','nativePairSha256','pc-xhs-elements-',('20 /system/bin/app_process /system/bin NativeWindowPair',)),
                    ('nativeNavigationAsset','nativeNavigationSha256','pc-xhs-nav-',(
                        '15 /system/bin/app_process /system/bin NativeNavigationAction profile',
                        '15 /system/bin/app_process /system/bin NativeNavigationAction menu'))):
                if (path_key in self.config and Path(a[1])==Path(self.config[path_key])
                        and re.fullmatch('/data/local/tmp/'+prefix+r'[a-f0-9]{32}\.jar',a[2])):
                    if hashlib.sha256(Path(a[1]).read_bytes()).hexdigest()!=self.config[sha_key]:return False
                    self.paths.add(a[2])
                    self.native_commands[a[2]]=tuple('CLASSPATH='+a[2]+':/system/framework/uiautomator.jar /system/bin/timeout '+cmd for cmd in commands)
                    return True
        if len(a)==2 and a[0]=='shell':
            return any(a[1] in commands for commands in self.native_commands.values())
        return False

    def guard(self):
        self.identity(self.config)
        return validate_file(self.config, self.prove)

    def run(self, args, capture_output=True, timeout=12, check=False, **kwargs):
        c = self.config
        if kwargs or not capture_output or args[:3] != [c['adbPath'], '-s', c['serial']]:
            raise RuntimeError('qa_process_outside_exact_adb_target')
        if not self.allowed(args[3:]):
            raise RuntimeError('qa_adb_command_not_allowlisted')
        started=time.monotonic();self.trace('command_start',operation=' '.join(args[3:6]))
        self.guard()
        self.trace('command_authorized',guardMs=round((time.monotonic()-started)*1000))
        child = self.popen(args, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        deadline = time.monotonic() + timeout
        try:
            while True:
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    raise subprocess.TimeoutExpired(args, timeout)
                try:
                    stdout, stderr = child.communicate(timeout=min(0.75, remaining))
                    break
                except subprocess.TimeoutExpired:
                    self.guard()
            self.guard()
            result = subprocess.CompletedProcess(args, child.returncode, stdout, stderr)
            if check:
                result.check_returncode()
            return result
        finally:
            if child.poll() is None:
                child.kill()  # Only this adapter's exact ADB client, never the server.
                child.communicate()
            self.trace('command_end',elapsedMs=round((time.monotonic()-started)*1000))


def main():
    c = json.loads(Path(os.environ['XHS_QA_CONFIG']).read_text(encoding='utf-8'))
    if not c['brokerUrl'].startswith('http://127.0.0.1:'):
        raise RuntimeError('qa_broker_must_be_loopback_tunnel')
    commands = GuardedCommands(c, lambda:read_proof(c))
    if sys.argv[1:2] == ['--qa-adb']:
        r = commands.run([c['adbPath'], '-s', c['serial']] + sys.argv[2:], timeout=8)
        sys.stdout.buffer.write(r.stdout); sys.stderr.buffer.write(r.stderr)
        raise SystemExit(r.returncode)
    p = Path(c['collectorPath'])
    if hashlib.sha256(p.read_bytes()).hexdigest() != c['collectorSha256']:
        raise RuntimeError('qa_collector_hash_changed')
    if hashlib.sha256((p.parent/'xhs_native_window.py').read_bytes()).hexdigest() != c['nativeHelperSha256']:
        raise RuntimeError('qa_native_helper_hash_changed')
    if hashlib.sha256((p.parent/'xhs_native_navigation.py').read_bytes()).hexdigest() != c['nativeNavigationHelperSha256']:
        raise RuntimeError('qa_native_navigation_helper_hash_changed')
    sys.path.insert(0, str(p.parent))
    spec = importlib.util.spec_from_file_location('xhs_candidate_collector', p)
    collector = importlib.util.module_from_spec(spec); spec.loader.exec_module(collector)
    def own_screen_guard(cache, serial, name, task_id='', app_slot='', cancel_path=''):
        if str(cache) != c['inventoryPath'] or serial != c['serial'] or name != c['deviceName'] or task_id != c['jobId'] or app_slot != c['appSlot']:
            raise RuntimeError('qa_collector_invocation_mismatch')
        if cancel_path and Path(cancel_path).exists():
            raise RuntimeError('automation_task_cancelled')
        return commands.guard()
    # Only this separate imported candidate instance accepts the verified screen
    # lease. The collector file and the shared Agent remain byte-for-byte intact.
    collector.assert_idle = own_screen_guard
    # A module-local facade, not an assignment on the shared stdlib module.
    # The pinned native helper receives collector.adb_process as its run callback.
    collector.subprocess = SimpleNamespace(run=commands.run, TimeoutExpired=subprocess.TimeoutExpired)
    for name in ('collect_once','ensure_creator_list','wait_data_center_loading','read_scrolled_content'):
        fn=getattr(collector,name)
        def traced(*args,_fn=fn,_name=name,**kwargs):
            commands.trace('phase_start',phase=_name)
            try:return _fn(*args,**kwargs)
            finally:commands.trace('phase_end',phase=_name)
        setattr(collector,name,traced)
    raise SystemExit(collector.main())


if __name__ == '__main__':
    main()
