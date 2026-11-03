import copy
import json
import unittest
from unittest.mock import patch,Mock
from wecom_screen_lease import validate, ScreenAuthority, INVENTORY_PATH,read_inventory_payload


def fixture():
    config=dict(taskId='job', deviceId='adb:fixture', serial='fixture', deviceNumber='23',
        appSlot='main', androidUser=0, agentId='agent', physicalAgentId='live-agent', sessionId='session', lockId='lock',
        ownerUserId='owner', purpose='preview', authorityGeneration='a'*32, scopeFingerprint='0'*64, operationFingerprint='0'*64, brokerUrl='http://127.0.0.1:40001',
        brokerToken='t'*48, inventoryPath=INVENTORY_PATH)
    proof=dict(config, version=1, allowed=True, nonce='a'*32, brokerAgeSeconds=.2,
        expiresInSeconds=100, activeLockCount=1, sessionAlive=True, lookupExcluded=True)
    inventory=[dict(deviceId='adb:fixture',deviceName='23',adb=dict(serial='fixture',agentId='live-agent',state='device'),
        occupancy=dict(kind='screen_control',sessionId='session'))]
    return config,proof,inventory


class ScreenLeaseTests(unittest.TestCase):
    def verify(self, config, proof, inventory, **changes):
        return validate(config,proof,inventory,**dict(dict(nonce='a'*32,round_trip=.1,local_age=0,inventory_age=1),**changes))

    def test_exact_owned_reservation_is_allowed_without_rewriting_inventory(self):
        c,p,i=fixture();old=copy.deepcopy(i)
        self.assertTrue(self.verify(c,p,i));self.assertEqual(i,old)

    def test_inventory_sharing_denial_only_retries_fresh_reads_without_writes(self):
        _,_,inventory=fixture();path=Mock();path.read_text.side_effect=[PermissionError(),PermissionError(),json.dumps(inventory)]
        with patch('wecom_screen_lease.time.sleep')as sleep:
            self.assertEqual(read_inventory_payload(path),inventory)
        self.assertEqual(path.read_text.call_count,3);self.assertEqual(sleep.call_count,2)
        self.assertEqual(set(name for name,_,_ in path.mock_calls),{'read_text'})

    def test_permanent_inventory_denial_is_bounded_and_other_errors_do_not_retry(self):
        path=Mock();path.read_text.side_effect=PermissionError()
        with patch('wecom_screen_lease.time.sleep')as sleep:
            with self.assertRaises(PermissionError):read_inventory_payload(path)
        self.assertEqual(path.read_text.call_count,3);self.assertEqual(sleep.call_count,2)
        for error in(FileNotFoundError(),json.JSONDecodeError('fixture','',0)):
            path=Mock();path.read_text.side_effect=error
            with patch('wecom_screen_lease.time.sleep')as sleep:
                with self.assertRaises(type(error)):read_inventory_payload(path)
            self.assertEqual(path.read_text.call_count,1);sleep.assert_not_called()

    def test_inventory_after_sharing_retry_still_requires_exact_scope(self):
        c,p,i=fixture();wrong=[dict(i[0],occupancy={'kind':'screen_control','sessionId':'other'})]
        path=Mock();path.read_text.side_effect=[PermissionError(),json.dumps(wrong)]
        with patch('wecom_screen_lease.time.sleep'):
            observed=read_inventory_payload(path)
        with self.assertRaises(ValueError):self.verify(c,p,observed)

    def test_every_identity_and_generation_is_bound(self):
        c,p,i=fixture()
        for key in ('taskId','deviceId','serial','deviceNumber','appSlot','androidUser','agentId','physicalAgentId','sessionId','lockId','ownerUserId','operationFingerprint','purpose','authorityGeneration'):
            with self.subTest(key=key),self.assertRaises(ValueError):self.verify(c,dict(p,**{key:'changed'}),i)

    def test_wrong_or_reused_request_nonce_denied(self):
        c,p,i=fixture()
        with self.assertRaises(ValueError):self.verify(c,p,i,nonce='b'*32)

    def test_total_proof_age_includes_network_and_local_delay(self):
        c,p,i=fixture()
        with self.assertRaises(ValueError):self.verify(c,dict(p,brokerAgeSeconds=2.8),i,round_trip=.3)
        with self.assertRaises(ValueError):self.verify(c,p,i,local_age=3)
        for age in (-1,float('nan'),float('inf'),True):
            with self.subTest(age=age),self.assertRaises(ValueError):self.verify(c,p,i,round_trip=age)

    def test_real_reverse_tunnel_delay_does_not_justify_a_stale_proof(self):
        c,p,i=fixture()
        with self.assertRaises(ValueError):self.verify(c,dict(p,brokerAgeSeconds=2.5),i,round_trip=1.313)
        self.assertTrue(self.verify(c,dict(p,brokerAgeSeconds=.75),i,round_trip=1.313))

    def test_v2_fresh_read_inside_rtt_is_counted_once_and_versions_do_not_mix(self):
        c,p,i=fixture();c=dict(c,proofVersion=2)
        # 1.413s server query is inside the measured 1.952s RTT.
        p=dict(p,version=2,ageReference='request_received',brokerAgeSeconds=0)
        self.assertTrue(self.verify(c,p,i,round_trip=1.952))
        with self.assertRaises(ValueError):self.verify(c,p,i,round_trip=3.01)
        with self.assertRaises(ValueError):self.verify(c,p,i,round_trip=1.952,local_age=1.1)
        with self.assertRaises(ValueError):self.verify(c,dict(p,brokerAgeSeconds=2.5),i,round_trip=1.313)
        with self.assertRaises(ValueError):self.verify(c,dict(p,brokerAgeSeconds=1.2),i,round_trip=1.952)
        with self.assertRaises(ValueError):self.verify(c,dict(p,version=1),i)
        with self.assertRaises(ValueError):self.verify(c,dict(p,ageReference='send_time'),i)
        old=fixture()[0]
        with self.assertRaises(ValueError):self.verify(old,p,i)
        with self.assertRaises(ValueError):self.verify(old,dict(p,version=True),i)

    def test_expired_or_malformed_expiry_is_not_authority(self):
        c,p,i=fixture()
        for value in (0,15,float('nan'),float('inf'),True):
            with self.subTest(expiry=value),self.assertRaises(ValueError):self.verify(c,dict(p,expiresInSeconds=value),i)

    def test_lookup_enabled_multiple_locks_and_stopped_session_denied(self):
        c,p,i=fixture()
        for change in ({'lookupExcluded':False},{'activeLockCount':2},{'activeLockCount':True},{'sessionAlive':False},{'allowed':False},{'androidUser':False}):
            with self.subTest(change=change),self.assertRaises(ValueError):self.verify(c,dict(p,**change),i)

    def test_missing_other_and_stale_real_inventory_denied(self):
        c,p,i=fixture()
        for inventory in ([],i+i,[dict(i[0],occupancy=None)],[dict(i[0],occupancy={'kind':'screen_control','sessionId':'other'})]):
            with self.assertRaises(ValueError):self.verify(c,p,inventory)
        with self.assertRaises(ValueError):self.verify(c,p,i,inventory_age=91)

    def test_broker_cannot_redirect_to_arbitrary_service_or_adb(self):
        c,_,_=fixture()
        for url in ('http://example.invalid:40001','http://127.0.0.1:5037','http://user:pass@127.0.0.1:40001','http://127.0.0.1:40001/path'):
            with self.subTest(url=url),self.assertRaises(ValueError):ScreenAuthority(dict(c,brokerUrl=url))
        with self.assertRaises(ValueError):ScreenAuthority(dict(c,inventoryPath='fake-inventory.json'))

    def test_send_or_operation_changes_revoke_before_network_or_device(self):
        c,_,_=fixture();authority=ScreenAuthority(c)
        with patch.object(authority,'host_identity',side_effect=AssertionError('no device or network')):
            self.assertFalse(authority.check(dict(c,mode='send',previewOnly=False)))
        self.assertTrue(authority.revoked)
        self.assertFalse(authority.check({}))

    def test_cleanup_generation_cannot_issue_preview_inputs(self):
        c,_,_=fixture();cleanup=ScreenAuthority(dict(c,purpose='cleanup',authorityGeneration='b'*32))
        with patch.object(cleanup,'host_identity',side_effect=AssertionError('no device or network')):
            self.assertFalse(cleanup.check(dict(c,mode='preview',previewOnly=True)))
        self.assertTrue(cleanup.revoked)
        self.assertFalse(cleanup.check_cleanup({}))

    def test_broker_loss_latches_old_input_but_fresh_cleanup_generation_can_prove(self):
        import hashlib
        import types
        from test_wecom_platform_preview import HostGuardTests
        import wecom_platform_preview as host
        request=host.validate_config(HostGuardTests().config('23'))
        c,_,_=fixture();c.update(**{k:request[k]for k in ('taskId','deviceId','serial','deviceNumber','androidUser','agentId')})
        c['operationFingerprint']=host.operation_fingerprint(request);c['scopeFingerprint']=c['operationFingerprint']
        inventory=[dict(deviceId=c['deviceId'],deviceName=c['deviceNumber'],adb=dict(serial=c['serial'],agentId=c['physicalAgentId'],state='device'),occupancy=dict(kind='screen_control',sessionId=c['sessionId']))]
        class FakePath:
            def read_text(self,**kwargs):return json.dumps(inventory)
            def stat(self):return types.SimpleNamespace(st_mtime=10)
        calls=[]
        class Opener:
            def open(self,req,**kwargs):
                calls.append(json.loads(req.data))
                if len(calls)==1:raise OSError('injected broker timeout')
                proof=dict(cleanup.binding,version=1,allowed=True,nonce=calls[-1]['nonce'],brokerAgeSeconds=0,expiresInSeconds=100,activeLockCount=1,sessionAlive=True,lookupExcluded=True)
                class Response:
                    def __enter__(self):return self
                    def __exit__(self,*args):pass
                    def read(self,n):return json.dumps(proof).encode()
                return Response()
        old=ScreenAuthority(c,clock=lambda:0,wall=lambda:10)
        cleanup=ScreenAuthority(dict(c,purpose='cleanup',authorityGeneration='b'*32),clock=lambda:0,wall=lambda:10)
        with patch('wecom_screen_lease.Path',return_value=FakePath()),patch('wecom_screen_lease.urllib.request.build_opener',return_value=Opener()),patch.object(old,'host_identity'),patch.object(cleanup,'host_identity'):
            self.assertFalse(old.check(dict(request,appSlot='main')))
            self.assertEqual(old.last_failure,'qa_authority_os_error')
            self.assertEqual(old.last_failure_stage,'proof_request')
            self.assertFalse(old.check(dict(request,appSlot='main')))
            self.assertEqual(len(calls),1)
            self.assertTrue(cleanup.check_cleanup(dict(request,appSlot='main')))
            self.assertEqual(len(calls),2)
            self.assertEqual(calls[-1]['purpose'],'cleanup')
            self.assertNotEqual(calls[0]['authorityGeneration'],calls[1]['authorityGeneration'])
            self.assertNotEqual(calls[0]['nonce'],calls[1]['nonce'])
            self.assertFalse(old.check(dict(request,appSlot='main')))

    def test_platform_request_cannot_inject_standalone_authority(self):
        import wecom_platform_preview as host
        from test_wecom_platform_preview import HostGuardTests
        request=HostGuardTests().config('23')
        with patch.object(host,'adb_identity',side_effect=AssertionError('no device')):
            with self.assertRaises(host.SafeStop):host.run_host(dict(request,authority={'allowed':True}))
            with self.assertRaises(host.SafeStop):host.run_host(request,authority=lambda:True)

if __name__=='__main__':unittest.main()
