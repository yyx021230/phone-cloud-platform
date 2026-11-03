"""Controlled QA runner: no SSH, ADB, phone or production HTTP in these tests."""
import contextlib
import ast
import copy
import hashlib
import io
import json
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import time
import threading
import unittest
import urllib.request
from types import SimpleNamespace
from unittest.mock import patch

import wecom_single_candidate as runner
from wecom_single_capture import ResourcePipe, original_hosts


class Keeper:
    def __init__(self):
        self.stdin = io.StringIO(); self.stdout = io.StringIO('ready\n'); self.done = False
    def poll(self): return 0 if self.done else None
    def terminate(self): self.done = True
    def wait(self, timeout): return 0


class RunnerTests(unittest.TestCase):
    def execute(self, failure=None):
        session = '11111111-1111-4111-8111-111111111111'
        live = dict(listing='listed', marker=None, locked=False, cleanup=0, natives=0, reads=0)
        events = []; saved_folders = []
        resources = dict(readerStarted=True, pid='123', startToken='456',
                         forwards=[[42001, 10080], [42002, 10081]], cleanupConfirmed=True)
        identity = dict(agentPid=1, agentCreatedAt=1.0, agentExe='agent',
                        adbPid=41, adbCreatedAt=2.0, adbExe='adb', files={'a':'a'})
        files = {'windows-agent/scripts/wecom_preview_devices.json': b'{"59":{"serial":"fixture"}}'}
        expected = {n:hashlib.sha256(v).hexdigest() for n,v in files.items()}
        server_class=runner.http.server.ThreadingHTTPServer
        def make_server(*args,**kwargs):
            server=server_class(*args,**kwargs);live['brokerPort']=server.server_port;return server

        class Reader:
            def __init__(self, target): self.target = target
            def state(self, requested=None):
                live['reads']+=1
                if failure=='temporary_read'and live['reads']==4:raise RuntimeError('qa_transport_unknown')
                marker = live['marker']
                if failure == 'marker_drift' and live['cleanup'] == 2: marker = 'other-maintainer'
                d = dict(deviceId='adb:fixture', deviceName='59', listingStatus=live['listing'],
                         unlistedAt=marker, updatedAt='initial', adb=dict(serial='fixture', agentId='physical', state='device'))
                locks = [dict(lock_id='lock', status='active', type='screen_control',
                              task_id=session, owner='other'if failure=='wrong_redis_owner'else'operator')] if live['locked'] else []
                result = dict(devices=[d], locks=locks, tasks=[], jobs=[], sessions=[], lookupExcluded=True,
                              readStartedMono=time.monotonic(), expiresInSeconds=1000,
                              runtime=dict(online=True, listed=live['listing']=='listed',
                                           available=not live['locked'] and live['listing']=='listed',
                                           occupancy=dict(type='screen_control') if live['locked'] else None))
                if requested: result['session']=dict(sessionId=session, deviceId='adb:fixture', status='ready',userId='operator',agentId='physical',adbSerial='fixture')
                if failure == 'competing_work' and live['locked']: result['jobs']=[{'job_id':'other'}]
                if failure=='late_competing_work'and live['reads']>=4:result['jobs']=[{'job_id':'other'}]
                return result

        def request(route, method='GET', body=None):
            events.append(method)
            if method == 'POST':
                live['locked']=True
                return dict(status=201, body=dict(session=dict(sessionId=session,userId='operator'),browserToken='fixture-only'))
            if method=='GET':return dict(status=200,body=dict(session=dict(sessionId=session,deviceId='adb:fixture',userId='operator')))
            live['locked']=False
            return dict(status=200)

        def listing(target, status):
            events.append(status)
            live['listing']=status
            if status == 'unlisted': live['marker']='owned-marker'
            return dict(deviceId='adb:fixture',deviceName='59',listingStatus=status,unlistedAt=live['marker'])

        def win(code, timeout=12):
            compile(code, '<remote-python>', 'exec')
            if 'p.stat().st_mtime' in code:return dict(ready=True,ageSeconds=1,matchingRows=1)
            if 's.bind' in code: return 43001
            if 'base64.b64decode' in code:
                if failure == 'upload_failed': raise RuntimeError('qa_stage_upload_unknown')
                return expected
            if 'capture_owned' in code:
                events.append('native'); live['natives']+=1
                self.assertEqual(live['listing'],'unlisted')
                self.assertLess(code.index('original_hosts('),code.index('p.stdin.write('))
                tree=ast.parse(code)
                write=next(n for n in ast.walk(tree) if isinstance(n,ast.Call)
                           and isinstance(n.func,ast.Attribute) and n.func.attr=='write')
                actual=eval(compile(ast.Expression(write.args[0]),'<stdin-expression>','eval'),{'chr':chr})
                self.assertTrue(actual.endswith(chr(10)))
                envelope=json.loads(actual);self.assertEqual(envelope['task']['mode'],'preview')
                lease=envelope['reservation']
                request=urllib.request.Request('http://127.0.0.1:'+str(live['brokerPort'])+'/guard',
                    data=json.dumps({k:lease[k]for k in('taskId','purpose','authorityGeneration','proofVersion')}|{'nonce':'a'*32}).encode(),
                    headers={'Authorization':'Bearer '+lease['brokerToken'],'Content-Type':'application/json'},method='POST')
                with urllib.request.urlopen(request,timeout=2)as response:
                    self.assertIsNotNone(response.headers.get('Content-Length'))
                    self.assertTrue(json.load(response)['allowed'])
                if failure == 'native_unknown': raise RuntimeError('qa_native_transport_unknown')
                return dict(pending=False,hostExitCode=0,pipeDrainComplete=True,resourceRecordFailure=None,
                            originalHosts=[dict(pid=10,createdAt=1),dict(pid=11,createdAt=2)],
                            answer=dict(previewStatus='ready_before_send',previewCode='ready_before_send',
                                        isolation=dict(resources=resources)))
            if 'standalone_peer_cleanup.py' in code:
                events.append('cleanup'); live['cleanup']+=1
                return dict(exitCode=0,result=dict(cleanupConfirmed=failure!='cleanup_unknown'))
            self.fail('unreviewed remote action')

        stdout=io.StringIO()
        with patch.object(runner,'candidate_files',return_value=files), \
             patch.object(runner,'Reader',Reader), patch.object(runner,'listing',listing), \
             patch.object(runner,'transport',return_value={'status':'observed_not_admitted'}), \
             patch.object(runner,'capacity',return_value={'pids':[],'limit':8}), \
             patch.object(runner.q,'attest',return_value=copy.deepcopy(identity)), \
             patch.object(runner.q,'request',side_effect=request), patch.object(runner.q,'win',side_effect=win), \
             patch.object(runner.subprocess,'Popen',side_effect=lambda *a,**k:Keeper()), \
             patch.object(runner.subprocess,'run',return_value=SimpleNamespace(returncode=0)), \
             patch.object(runner.http.server,'ThreadingHTTPServer',side_effect=make_server), \
             patch.object(sys,'stdin',io.StringIO(json.dumps(dict(deviceNumber='59',phoneNumber='13800006441',sourceRef='a'*40))+'\n')), \
             contextlib.redirect_stdout(stdout):
            runner.main()
        result=json.loads(stdout.getvalue());folder=Path(result['evidence'])
        try:
            journal=json.loads((folder/'maintenance-journal.json').read_text())
        finally: shutil.rmtree(folder)
        return result, journal, events, live

    def test_normal_requires_two_cleanup_reads_before_release_and_relist(self):
        result,journal,events,live=self.execute()
        self.assertEqual(result['status'],'ready_before_send')
        self.assertEqual(events,['POST','unlisted','native','cleanup','cleanup','DELETE','listed'])
        self.assertEqual(journal['phase'],'complete_restored')
        self.assertEqual(live['natives'],1)

    def test_unknown_never_retries_or_restores_listing(self):
        for failure in ('native_unknown','cleanup_unknown','marker_drift'):
            with self.subTest(failure=failure):
                result,journal,events,live=self.execute(failure)
                self.assertTrue(result['keepUnlisted'])
                self.assertEqual(live['listing'],'unlisted')
                self.assertNotIn('listed',events)
                self.assertEqual(live['natives'],1)
                self.assertEqual(journal['phase'],'unknown_keep_unlisted')

    def test_competitor_after_screen_is_detected_before_unlist_or_ui(self):
        _,_,events,live=self.execute('competing_work')
        self.assertEqual(events,['POST','GET','DELETE'])
        self.assertEqual(live['natives'],0)

    def test_wrong_redis_owner_does_not_grant_native_or_unlist(self):
        _,journal,events,live=self.execute('wrong_redis_owner')
        self.assertEqual(events,['POST','GET','DELETE'])
        self.assertEqual(live['natives'],0)
        self.assertEqual(journal['phase'],'known_not_started_screen_closed')

    def test_unavailable_read_is_not_a_grant_and_new_complete_read_can_recover(self):
        result,journal,events,live=self.execute('temporary_read')
        self.assertEqual(result['status'],'ready_before_send')
        self.assertEqual(live['natives'],1)
        self.assertEqual(journal['phase'],'complete_restored')

    def test_observed_competitor_remains_a_hard_stop(self):
        result,_,events,live=self.execute('late_competing_work')
        self.assertEqual(live['natives'],0)
        self.assertEqual(live['listing'],'unlisted')
        self.assertNotIn('listed',events)

    def test_known_not_started_can_restore_only_its_own_marker(self):
        result,journal,events,live=self.execute('upload_failed')
        self.assertFalse(result['nativeStarted'])
        self.assertEqual(events,['POST','unlisted','DELETE','listed'])
        self.assertEqual(journal['phase'],'known_not_started_restored')
        self.assertEqual(live['natives'],0)

    def test_agent_cache_timeout_is_known_unstarted_and_runs_no_refresh(self):
        now=[0]
        calls=[]
        def win(code,timeout):
            calls.append(code)
            return dict(ready=False,ageSeconds=1,matchingRows=1)
        def sleep(seconds):now[0]+=seconds
        binding=dict(deviceId='adb:fixture',serial='fixture',deviceNumber='59',physicalAgentId='agent',sessionId='session')
        with patch.object(runner.q,'win',side_effect=win):
            with self.assertRaisesRegex(RuntimeError,'qa_inventory_wait_timeout'):
                runner.inventory_owned(binding,clock=lambda:now[0],sleep=sleep)
        self.assertTrue(calls)
        self.assertTrue(all('read_text' in c and 'subprocess' not in c and 'socket' not in c for c in calls))

    def test_capacity_access_denied_is_not_treated_as_free_slot(self):
        class Missing(Exception):pass
        class Denied(Exception):pass
        def denied():raise Denied()
        process=SimpleNamespace(pid=7,info={'name':'python.exe'},cmdline=denied)
        psutil=SimpleNamespace(process_iter=lambda attrs:[process],NoSuchProcess=Missing,AccessDenied=Denied)
        def win(code):
            namespace={}
            with patch.dict(sys.modules,psutil=psutil),patch.object(Path,'read_text',return_value='{"airtestMaxResidentWorkers":12}'):
                exec(compile(code,'<capacity-read>','exec'),namespace)
        with patch.object(runner.q,'win',side_effect=win):
            with self.assertRaisesRegex(RuntimeError,'qa_reader_capacity_unknown'):runner.capacity()

    def test_typed_sidecar_keeps_original_births_and_never_raw_ui(self):
        hosts=[dict(pid=1,createdAt=1.5),dict(pid=2,createdAt=2.5)]
        resources=dict(readerStarted=True,pid='123',startToken='456',forwards=[[42001,10080]],cleanupConfirmed=None)
        with tempfile.TemporaryDirectory() as stage:
            original_hosts(stage,hosts)
            text='private SDK raw\nWECOM_CALL '+json.dumps(dict(kind='resources',resources=resources))+'\n'
            pipe=ResourcePipe(io.StringIO(text),stage,hosts)
            while pipe.read(7): pass
            self.assertIsNone(pipe.failure)
            record=json.loads((Path(stage)/'qa-owned-resources.json').read_text())
            self.assertEqual(record,dict(originalHosts=hosts,resources=resources))
            self.assertNotIn('private SDK',json.dumps(record))

    def test_real_child_resource_is_durable_before_child_may_exit(self):
        hosts=[dict(pid=1,createdAt=1.5),dict(pid=2,createdAt=2.5)]
        resources=dict(readerStarted=True,pid='123',startToken='456',forwards=[[42001,10080]],cleanupConfirmed=None)
        frame='WECOM_CALL '+json.dumps(dict(kind='resources',resources=resources))+'\n'
        source='import sys;sys.stderr.write('+repr(frame)+');sys.stderr.flush();sys.stdin.readline()'
        with tempfile.TemporaryDirectory() as stage:
            p=subprocess.Popen([sys.executable,'-c',source],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
            pipe=ResourcePipe(p.stderr,stage,hosts)
            thread=threading.Thread(target=lambda:pipe.read(8192));thread.start()
            try:
                until=time.monotonic()+2
                sidecar=Path(stage)/'qa-owned-resources.json'
                while not sidecar.exists() and time.monotonic()<until:time.sleep(.01)
                self.assertTrue(sidecar.exists(),'short flushed frame waited for child EOF')
                self.assertIsNone(p.poll(),'child must still be waiting for parent permission')
                self.assertEqual(json.loads(sidecar.read_text())['resources'],resources)
            finally:
                p.stdin.write(chr(10));p.stdin.flush();p.wait(timeout=2);thread.join(2)
                for stream in (p.stdin,p.stdout,p.stderr):stream.close()
            self.assertFalse(thread.is_alive())


if __name__=='__main__': unittest.main()
