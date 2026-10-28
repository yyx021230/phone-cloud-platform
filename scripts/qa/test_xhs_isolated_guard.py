import copy
import json
import subprocess
import tempfile
import time
import unittest
from pathlib import Path
from xhs_isolated_guard import validate, validate_file
from xhs_isolated_runner import GuardedCommands, read_proof
from xhs_candidate_live import settings_recovery_source, staging_source, wait_cached_proof, candidate_files, validate_target_names, completed_results, completion_payload, collection_succeeded, main as live_main


class LeaseBoundary(unittest.TestCase):
    def setUp(self):
        self.c = dict(deviceId='d', serial='s', deviceName='47', appSlot='app1', xhsId='x', accountName='name',
                      jobId='j', sessionId='session', lockId='lock', ownerUserId='owner', adbPath='fixture-adb')
        self.p = dict(self.c, allowed=True, localObservedAt=100, roundTripSeconds=.2, brokerProofAgeSeconds=0, activeLockCount=1, sessionAlive=True, lookupReserved=False)
        self.d = dict(deviceId='d', deviceName='47', adb={'serial': 's', 'state': 'device'},
                      occupancy={'kind': 'screen_control', 'sessionId': 'session'},
                      xhsAccounts=[{'appSlot': 'app1', 'xhsId': 'x', 'accountName': 'name', 'enabled': True}])

    def test_exact_lease_preserves_real_inventory(self):
        before = copy.deepcopy(self.d)
        self.assertIs(validate(self.c, self.p, [self.d], 1, 101), self.d)
        self.assertEqual(self.d, before)

    def test_every_identity_field_is_bound(self):
        for key in ('deviceId', 'serial', 'deviceName', 'appSlot', 'xhsId', 'accountName', 'jobId', 'sessionId', 'lockId', 'ownerUserId'):
            p = dict(self.p); p[key] = 'other'
            with self.subTest(key=key), self.assertRaises(RuntimeError): validate(self.c, p, [self.d], 1, 101)

    def test_stale_future_revoked_and_shared_proofs(self):
        for delta in ({'localObservedAt': 90}, {'localObservedAt': 102}, {'roundTripSeconds':4}, {'brokerProofAgeSeconds':2}, {'allowed': False}, {'activeLockCount': 2},
                      {'sessionAlive': False}, {'lookupReserved': True}):
            with self.subTest(delta=delta), self.assertRaises(RuntimeError): validate(self.c, dict(self.p, **delta), [self.d], 1, 101)
        missing=dict(self.p);missing.pop('brokerProofAgeSeconds')
        with self.assertRaises(RuntimeError):validate(self.c,missing,[self.d],1,101)

    def test_real_inventory_cannot_be_replaced_by_fake_xhs_occupancy(self):
        for occupancy in (None, {'kind': 'xhs_data_collect', 'taskId': 'j', 'appSlot': 'app1'},
                          {'kind': 'screen_control', 'sessionId': 'other'}):
            d = dict(self.d, occupancy=occupancy)
            with self.subTest(occupancy=occupancy), self.assertRaises(RuntimeError): validate(self.c, self.p, [d], 1, 101)

    def test_stale_offline_duplicate_disabled_or_changed_slot(self):
        with self.assertRaises(RuntimeError): validate(self.c, self.p, [self.d], 91, 101)
        with self.assertRaises(RuntimeError): validate(self.c, self.p, [self.d, self.d], 1, 101)
        for field, value in [('state', 'offline'), ('serial', 'another')]:
            d = copy.deepcopy(self.d); d['adb'][field] = value
            with self.assertRaises(RuntimeError): validate(self.c, self.p, [d], 1, 101)
        for key, value in [('enabled', False), ('appSlot', 'app2'), ('xhsId', 'changed')]:
            d = copy.deepcopy(self.d); d['xhsAccounts'][0][key] = value
            with self.assertRaises(RuntimeError): validate(self.c, self.p, [d], 1, 101)

    def test_lost_lease_kills_only_owned_client_and_blocks_late_restore(self):
        class Child:
            killed = False
            returncode = None
            def communicate(self, timeout=None):
                if self.killed: return b'', b''
                raise subprocess.TimeoutExpired('fixture', timeout)
            def poll(self): return -9 if self.killed else None
            def kill(self): self.killed = True
        with tempfile.TemporaryDirectory() as tmp:
            p = Path(tmp)/'cache.json'; p.write_text(json.dumps([self.d])); self.c['inventoryPath'] = str(p)
            child = Child(); calls = []
            def proof():
                calls.append(1)
                return dict(self.p, localObservedAt=time.monotonic(), allowed=len(calls) == 1)
            command = GuardedCommands(self.c, proof, identity=lambda c: None, popen=lambda *a, **k: child)
            with self.assertRaises(RuntimeError): command.run(['fixture-adb', '-s', 's', 'shell', 'input', 'tap', '1', '2'])
            self.assertTrue(child.killed)
            with self.assertRaises(RuntimeError): command.run(['fixture-adb', '-s', 's', 'shell', 'settings', 'put', 'system', 'screen_off_timeout', '1'])

    def test_wrong_target_or_identity_never_starts_process(self):
        def refuse(*a, **kw): raise AssertionError('must not start')
        command = GuardedCommands(self.c, refuse, identity=lambda c: (_ for _ in ()).throw(RuntimeError('identity')), popen=refuse)
        with self.assertRaises(RuntimeError): command.run(['fixture-adb', '-s', 'other', 'shell'])
        with self.assertRaises(RuntimeError): command.run(['fixture-adb', '-s', 's', 'shell'])

    def test_global_commands_and_shell_injection_are_rejected(self):
        command=GuardedCommands(self.c,lambda:None)
        for a in (['kill-server'],['start-server'],['reboot'],['tcpip','5555'],['usb'],['shell','reboot'],
                  ['shell','input','tap','1','2;reboot'],['shell','am','force-stop','another.app'],
                  ['shell','rm','-f','/sdcard/other'],['shell','settings','put','global','adb_enabled','0']):
            with self.subTest(a=a): self.assertFalse(command.allowed(a))

    def test_owned_temporary_paths_and_settings_are_explicit(self):
        command=GuardedCommands(self.c,lambda:None)
        name='/sdcard/phonecloud-xhs-capture-'+'a'*32+'.xml'
        self.assertFalse(command.allowed(['shell','rm','-f',name]))
        self.assertTrue(command.allowed(['shell','uiautomator','dump',name]))
        self.assertTrue(command.allowed(['exec-out','cat',name]))
        self.assertTrue(command.allowed(['shell','rm','-f',name]))
        self.assertTrue(command.allowed(['shell','settings','put','system','screen_off_timeout','30000']))

    def test_pinned_reader_has_no_alternative_process_entry(self):
        import ast
        root=Path(__file__).resolve().parents[2]
        for name in ('小红书数据同步.py','xhs_native_window.py','xhs_native_navigation.py'):
            tree=ast.parse((root/'windows-agent/scripts'/name).read_text())
            calls=[n for n in ast.walk(tree) if isinstance(n,ast.Call) and isinstance(n.func,ast.Attribute)
                   and isinstance(n.func.value,ast.Name) and n.func.value.id in ('os','subprocess')
                   and not (n.func.value.id=='os' and n.func.attr=='replace')]
            self.assertEqual([(n.func.value.id,n.func.attr) for n in calls], [('subprocess','run')] if name.startswith('小') else [])

    def test_real_child_is_stopped_when_proof_is_lost(self):
        with tempfile.TemporaryDirectory() as tmp:
            p=Path(tmp)/'cache.json';p.write_text(json.dumps([self.d]));self.c['inventoryPath']=str(p)
            binary=Path(tmp)/'fixture-client';binary.write_text('#!/usr/bin/env python3\nimport time\ntime.sleep(20)\n');binary.chmod(0o700)
            self.c['adbPath']=str(binary);children=[];calls=[]
            def spawn(*a,**k):
                child=subprocess.Popen(*a,**k);children.append(child);return child
            def prove():
                calls.append(1);return dict(self.p,localObservedAt=time.monotonic(),allowed=len(calls)==1)
            command=GuardedCommands(self.c,prove,identity=lambda c:None,popen=spawn)
            with self.assertRaises(RuntimeError):command.run([str(binary),'-s','s','get-state'])
            self.assertEqual(len(children),1);self.assertIsNotNone(children[0].poll())

    def test_transient_proof_waits_but_conflict_and_replay_never_retry(self):
        import io,urllib.error
        c=dict(self.c,brokerUrl='http://127.0.0.1:1',brokerToken='fixture');calls=[]
        def open_after_one_failure(req,**kw):
            calls.append(1)
            if len(calls)==1:raise urllib.error.HTTPError(req.full_url,503,'unavailable',{},None)
            return io.BytesIO(json.dumps({'nonce':json.loads(req.data)['nonce'],'allowed':True,'brokerProofAgeSeconds':0}).encode())
        p=read_proof(c,open_after_one_failure,sleep=lambda _:None)
        self.assertTrue(p['allowed']);self.assertEqual(len(calls),2)
        def conflict(req,**kw):raise urllib.error.HTTPError(req.full_url,409,'lost',{},None)
        with self.assertRaises(urllib.error.HTTPError):read_proof(c,conflict,sleep=lambda _:self.fail('must not retry'))
        with self.assertRaises(RuntimeError):read_proof(c,lambda *a,**k:io.BytesIO(b'{"nonce":"old"}'),sleep=lambda _:self.fail('must not retry'))

    def test_http_200_transport_expiry_pauses_then_uses_new_proof(self):
        import io
        c=dict(self.c,brokerUrl='http://127.0.0.1:1',brokerToken='fixture')
        now=[0.0];calls=[];sleeps=[]
        def sleep(delay):sleeps.append(delay);now[0]+=delay
        def opener(req,**kw):
            calls.append(json.loads(req.data)['nonce']);now[0]+=.75 if len(calls)==1 else .1
            return io.BytesIO(json.dumps(dict(self.p,nonce=calls[-1],brokerProofAgeSeconds=2.4 if len(calls)==1 else .2)).encode())
        proof=read_proof(c,opener,sleep,clock=lambda:now[0])
        self.assertEqual(len(calls),2);self.assertNotEqual(*calls);self.assertEqual(sleeps,[.2])
        self.assertEqual(proof['brokerProofAgeSeconds'],.2);self.assertAlmostEqual(proof['roundTripSeconds'],.1)
        self.assertEqual(proof['localObservedAt'],now[0])

    def test_persistent_stale_200_exhausts_original_budget_without_start(self):
        import io
        c=dict(self.c,brokerUrl='http://127.0.0.1:1',brokerToken='fixture')
        now=[0.0];calls=[]
        def sleep(delay):now[0]+=delay
        def opener(req,**kw):
            calls.append(kw['timeout']);now[0]+=min(.8,kw['timeout'])
            return io.BytesIO(json.dumps(dict(self.p,nonce=json.loads(req.data)['nonce'],brokerProofAgeSeconds=3)).encode())
        with tempfile.TemporaryDirectory() as tmp:
            p=Path(tmp)/'cache.json';p.write_text(json.dumps([self.d]));c['inventoryPath']=str(p)
            command=GuardedCommands(c,lambda:read_proof(c,opener,sleep,clock=lambda:now[0]),identity=lambda _:None,
                                    popen=lambda *a,**k:self.fail('stale proof must never start a client'))
            with self.assertRaisesRegex(RuntimeError,'qa_fresh_lease_proof_unavailable'):
                command.run(['fixture-adb','-s','s','get-state'])
        self.assertAlmostEqual(now[0],5);self.assertGreater(len(calls),1);self.assertTrue(all(x<=2 for x in calls))

    def test_stale_response_followed_by_real_conflict_is_not_retried(self):
        import io,urllib.error
        c=dict(self.c,brokerUrl='http://127.0.0.1:1',brokerToken='fixture');calls=[];now=[0.0]
        def opener(req,**kw):
            calls.append(1);now[0]+=.2
            if len(calls)==2:raise urllib.error.HTTPError(req.full_url,409,'lost',{},None)
            return io.BytesIO(json.dumps(dict(self.p,nonce=json.loads(req.data)['nonce'],brokerProofAgeSeconds=3)).encode())
        with self.assertRaises(urllib.error.HTTPError):read_proof(c,opener,sleep=lambda _:None,clock=lambda:now[0])
        self.assertEqual(len(calls),2)

    def test_age_boundary_and_malformed_evidence(self):
        import io
        c=dict(self.c,brokerUrl='http://127.0.0.1:1',brokerToken='fixture')
        for age in (None,-1,float('nan'),float('inf'),True,'0'):
            def opener(req,**kw):return io.BytesIO(json.dumps(dict(self.p,nonce=json.loads(req.data)['nonce'],brokerProofAgeSeconds=age)).encode())
            with self.subTest(age=age),self.assertRaisesRegex(RuntimeError,'qa_broker_proof_invalid'):
                read_proof(c,opener,sleep=lambda _:self.fail('invalid proof is terminal'))
        now=[0.0]
        def exact_boundary(req,**kw):
            now[0]+=.5
            return io.BytesIO(json.dumps(dict(self.p,nonce=json.loads(req.data)['nonce'],brokerProofAgeSeconds=2.5)).encode())
        proof=read_proof(c,exact_boundary,clock=lambda:now[0]);self.assertEqual(proof['brokerProofAgeSeconds'],2.5)
        self.assertIs(validate(c,proof,[self.d],1,now[0]),self.d)
        with self.assertRaisesRegex(RuntimeError,'qa_lease_not_fresh'):validate(c,proof,[self.d],1,now[0]+.001)

    def test_slow_inventory_read_precedes_proof_and_does_not_refresh_inventory_age(self):
        from unittest.mock import patch
        with tempfile.TemporaryDirectory() as tmp:
            p=Path(tmp)/'cache.json';p.write_text(json.dumps([self.d]));c=dict(self.c,inventoryPath=str(p))
            events=[];now=[100.0];real_read=Path.read_text
            def read(path,**kw):
                events.append('inventory');now[0]+=4;return real_read(path,**kw)
            def proof():
                events.append('proof');return dict(self.p,localObservedAt=now[0])
            with patch.object(Path,'read_text',read),patch('xhs_isolated_guard.time.monotonic',lambda:now[0]):
                self.assertEqual(validate_file(c,proof),self.d)
            self.assertEqual(events,['inventory','proof'])
            import os
            os.utime(p,(time.time()-100,time.time()-100))
            def proof_after_file_replacement():
                p.write_text(json.dumps([self.d]))
                return proof()
            with self.assertRaisesRegex(RuntimeError,'qa_inventory_stale'):validate_file(c,proof_after_file_replacement)

    def test_host_preserves_bounded_raw_partial_before_original_consumer_cleanup(self):
        import os,sys,shutil,hashlib
        repo=Path(__file__).resolve().parents[2]
        with tempfile.TemporaryDirectory() as tmp:
            stage=Path(tmp)
            shutil.copyfile(repo/'scripts/qa/xhs_candidate_host.mjs',stage/'host.mjs')
            shutil.copyfile(repo/'windows-agent/src/xhs-data-collection.mjs',stage/'xhs-data-collection.mjs')
            output={'schema_version':3,'serial':'fixture','device_name':'47','app_slot':'app1','window_days':30,
                    'complete':False,'notes':[],'stop_reason':'two_pass_unproven'}
            code="import sys,json\nfrom pathlib import Path\nif '--qa-adb' in sys.argv:\n print('null' if sys.argv[-1]=='enable_screen_on_proximity_sensor' else '60000');sys.exit(0)\np=Path(sys.argv[sys.argv.index('--output')+1]);p.write_text(json.dumps("+repr(output)+"));sys.exit(2)\n"
            (stage/'xhs_isolated_runner.py').write_text(code)
            c={'stage':tmp,'pythonPath':sys.executable,'serial':'fixture','adbPath':'must-not-run','inventoryPath':str(stage/'unused')}
            task={'taskId':'fixture-task','adbSerial':'fixture','payload':{'automationJobId':'fixture-job','xhsAppSlot':'app1','deviceName':'47'}}
            (stage/'config.json').write_text(json.dumps(c));(stage/'task.json').write_text(json.dumps(task))
            p=subprocess.run(['node',str(stage/'host.mjs'),str(stage/'config.json'),str(stage/'task.json')],capture_output=True,timeout=10)
            self.assertEqual(p.returncode,0,p.stderr.decode());answer=json.loads(p.stdout)
            self.assertTrue(answer['ok']);self.assertFalse(answer['result']['collection']['complete']);self.assertTrue(answer['settingsRestored'])
            raw=(stage/'collector-output-private.json').read_bytes();meta=json.loads((stage/'collector-output-meta.json').read_text())
            self.assertEqual(json.loads(raw),output);self.assertEqual(meta['exitCode'],2);self.assertEqual(meta['sha256'],hashlib.sha256(raw).hexdigest())
            self.assertFalse((stage/'cache/xhs-data-collection/fixture-task.json').exists())
            self.assertEqual(list((stage/'cache/xhs-data-collection').glob('*.settings.json')),[])
            self.assertEqual(completion_payload(answer)['status'],'failed')

    def test_partial_collection_is_reported_failed_with_data_retained(self):
        answer={'ok':True,'settingsRestored':True,'result':{'collection':{'complete':False,'notes':[{'title':'partial'}]}}}
        payload=completion_payload(answer)
        self.assertEqual(payload['status'],'failed');self.assertIs(payload['result'],answer['result']);self.assertFalse(collection_succeeded(answer))
        answer['result']['collection']['complete']=True
        self.assertEqual(completion_payload(answer)['status'],'succeeded')
        self.assertEqual(completion_payload(answer,1)['status'],'failed')

    def test_real_runner_preserves_collector_success_partial_and_exception_exit_codes(self):
        import os,sys,hashlib
        runner=Path(__file__).with_name('xhs_isolated_runner.py')
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);empty=hashlib.sha256(b'').hexdigest()
            for name in ('xhs_native_window.py','xhs_native_navigation.py'):(root/name).write_text('')
            for result,code in [('return 0',0),('return 2',2),("raise RuntimeError('fixture_failure')",1)]:
                source='def main(): '+result+'\n'+''.join('def '+name+'(*a,**k): pass\n' for name in ('collect_once','ensure_creator_list','wait_data_center_loading','read_scrolled_content'))
                collector=root/('collector-'+str(code)+'.py');collector.write_text(source)
                c={'brokerUrl':'http://127.0.0.1:1','collectorPath':str(collector),'collectorSha256':hashlib.sha256(collector.read_bytes()).hexdigest(),
                   'nativeHelperSha256':empty,'nativeNavigationHelperSha256':empty}
                config=root/'config.json';config.write_text(json.dumps(c))
                env={k:v for k,v in os.environ.items() if k not in ('PYTHONOPTIMIZE','XHS_QA_CONFIG')};env['XHS_QA_CONFIG']=str(config)
                p=subprocess.run([sys.executable,str(runner)],capture_output=True,env=env,timeout=5)
                with self.subTest(result=result):self.assertEqual(p.returncode,code,p.stderr.decode())

    def test_fast_second_result_is_available_before_first_task_finishes(self):
        import concurrent.futures
        slow=concurrent.futures.Future();fast=concurrent.futures.Future();fast.set_result('fast')
        results=completed_results([slow,fast])
        with concurrent.futures.ThreadPoolExecutor(max_workers=1) as pool:
            first=pool.submit(next,results)
            try:
                self.assertEqual(first.result(timeout=1),'fast');self.assertFalse(slow.done())
            finally:slow.set_result('slow')
        self.assertEqual(next(results),'slow')
        with self.assertRaises(StopIteration):next(results)

    def test_cli_refuses_excess_or_excluded_targets_before_private_access(self):
        import os
        from unittest.mock import patch
        validate_target_names(['180','129','102','141','140'])
        for names in ([],['1','2','3','4','5','6'],['47','47'],['47','152'],['18'],['155'],['185'],['-1']):
            with self.subTest(names=names),patch.dict(os.environ,{},clear=True),patch('sys.argv',['qa']+names):
                with self.assertRaisesRegex(ValueError,'qa_requires_one_to_five'):live_main()

    def test_staged_dependency_closure_reaches_guard_with_all_native_assets(self):
        import ast,importlib.util,shutil
        files=candidate_files()
        tree=ast.parse(files['scripts/小红书数据同步.py'].read_text())
        imports={n.module for n in ast.walk(tree) if isinstance(n,ast.ImportFrom) and (n.module or '').startswith('xhs_')}
        self.assertTrue(all('scripts/'+name+'.py' in files for name in imports))
        class AtGuard(Exception):pass
        def guard():raise AtGuard()
        def never(*a,**k):self.fail('fixture must never invoke ADB')
        with tempfile.TemporaryDirectory() as tmp:
            for name,src in files.items():
                dst=Path(tmp)/name;dst.parent.mkdir(parents=True,exist_ok=True);shutil.copyfile(src,dst)
            for name in ('xhs_native_window','xhs_native_navigation'):
                spec=importlib.util.spec_from_file_location('fixture_'+name,Path(tmp)/'scripts'/(name+'.py'))
                mod=importlib.util.module_from_spec(spec);spec.loader.exec_module(mod)
                if name.endswith('window'):
                    for pair in (False,True):
                        with self.subTest(pair=pair),self.assertRaises(AtGuard):
                            mod.read('adb','s',never,never,guard,'u0 com.xingin.xhs/.xywebview.activity.WebViewActivityV2}',pair=pair)
                else:
                    with self.assertRaises(AtGuard):mod.perform('menu','adb','s',never,never,guard,'focus')

    def test_native_commands_bind_asset_hash_remote_name_and_action(self):
        import hashlib
        files=candidate_files();config=dict(self.c)
        specs=[('nativeAsset','nativeAssetSha256','xhs-native-window.jar','pc-xhs-elements-','20 /system/bin/app_process /system/bin NativeWindowReader'),
               ('nativePairAsset','nativePairSha256','xhs-native-pair.jar','pc-xhs-elements-','20 /system/bin/app_process /system/bin NativeWindowPair'),
               ('nativeNavigationAsset','nativeNavigationSha256','xhs-native-navigation.jar','pc-xhs-nav-','15 /system/bin/app_process /system/bin NativeNavigationAction menu')]
        for pathkey,hashkey,asset,prefix,cmd in specs:
            p=files['scripts/native/'+asset];config[pathkey]=str(p);config[hashkey]=hashlib.sha256(p.read_bytes()).hexdigest()
            guard=GuardedCommands(config,lambda:None);remote='/data/local/tmp/'+prefix+'a'*32+'.jar'
            shell='CLASSPATH='+remote+':/system/framework/uiautomator.jar /system/bin/timeout '+cmd
            self.assertFalse(guard.allowed(['shell',shell]));self.assertFalse(guard.allowed(['shell','rm','-f',remote]))
            self.assertTrue(guard.allowed(['push',str(p),remote]));self.assertTrue(guard.allowed(['shell',shell]))
            self.assertFalse(guard.allowed(['shell',shell+';reboot']));self.assertFalse(guard.allowed(['shell',shell.replace('menu','publish')+' x']))
            self.assertTrue(guard.allowed(['shell','rm','-f',remote]))
            wrong=dict(config);wrong[hashkey]='0'*64
            self.assertFalse(GuardedCommands(wrong,lambda:None).allowed(['push',str(p),remote]))
            if pathkey=='nativePairAsset':self.assertFalse(guard.allowed(['shell',shell.replace('NativeWindowPair','NativeWindowReader')]))

    def test_controller_uses_fresh_pooled_proof_and_preserves_expiry(self):
        now=[10.0];cache={'j':{'at':6.0,'proof':{'id':'old'}}};slept=[]
        def sleep(delay):
            slept.append(delay);now[0]+=delay
            cache['j']={'at':now[0]-.5,'proof':{'id':'new'}}
        self.assertEqual(wait_cached_proof(cache,'j',clock=lambda:now[0],sleep=sleep),{'id':'new'})
        self.assertEqual(len(slept),1);self.assertEqual(cache['j']['at'],9.7)
        cache['j']={'denied':'another_owner'}
        with self.assertRaisesRegex(RuntimeError,'qa_lease_lost'):
            wait_cached_proof(cache,'j',clock=lambda:now[0],sleep=lambda _:self.fail('lost lease is terminal'))
        cache.clear();started=now[0]
        def advance(delay):now[0]+=delay
        with self.assertRaisesRegex(RuntimeError,'qa_fresh_lease_proof_unavailable'):
            wait_cached_proof(cache,'j',clock=lambda:now[0],sleep=advance)
        self.assertAlmostEqual(now[0]-started,5)

    def test_ascii_staging_preserves_unicode_names_and_binary_content(self):
        import base64,contextlib,io
        with tempfile.TemporaryDirectory() as tmp:
            stage=Path(tmp)/'隔离候选';name='scripts/小红书数据同步.py';data='中文内容'.encode()+b'\x00\xff'
            source=staging_source(str(stage),{name:base64.b64encode(data).decode()})
            self.assertTrue(source.isascii())
            with contextlib.redirect_stdout(io.StringIO()):exec(source,{})
            self.assertEqual((stage/name).read_bytes(),data)
        self.assertTrue(settings_recovery_source({'stage':'隔离','accountName':'中文'}).isascii())

    def test_recovery_generated_script_compiles_and_restores_exact_ledger(self):
        import contextlib,io
        from unittest.mock import patch
        with tempfile.TemporaryDirectory(prefix='CONFIG-test-') as tmp:
            folder=Path(tmp)/'cache/xhs-data-collection';folder.mkdir(parents=True)
            ledger=folder/'own.settings.json'
            ledger.write_text(json.dumps({'serial':'fixture','taskId':'task','settings':[
                {'scope':'system','key':'screen_off_timeout','original':'30000'},
                {'scope':'global','key':'enable_screen_on_proximity_sensor','original':'null'}]}))
            c={'stage':tmp,'serial':'fixture','windowsTaskId':'task','pythonPath':'fixture-python'}
            code=settings_recovery_source(c);compile(code,'recovery-fixture','exec')
            self.assertIn('XHS_QA_CONFIG=',code);self.assertNotIn('__QA_CONFIG_LITERAL__',code)
            current=['600000'];calls=[]
            def run(args,**kwargs):
                self.assertEqual(kwargs['env']['XHS_QA_CONFIG'],str(Path(tmp)/'config.json'))
                calls.append(args)
                if args[-4]=='put':current[0]=args[-1]
                return subprocess.CompletedProcess(args,0,current[0].encode(),b'')
            with patch('subprocess.run',run),contextlib.redirect_stdout(io.StringIO()):exec(code,{})
            self.assertFalse(ledger.exists());self.assertEqual(len(calls),3)
            self.assertTrue(all('enable_screen_on_proximity_sensor' not in a for a in calls))


if __name__ == '__main__': unittest.main()
