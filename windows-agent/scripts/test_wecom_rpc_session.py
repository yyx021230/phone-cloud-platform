"""Loopback fixtures only: keepalive, bounded failure, no redirects or replay."""
import http.server
import json
import os
import socket
import threading
import time
import types
import unittest
from unittest.mock import patch
from wecom_rpc_budget import bound_rpc_transport, RpcDeliveryUnknown
from wecom_rpc_session import LocalRpcSession
from wecom_invite_preview import StopPreview


class RpcSessionTests(unittest.TestCase):
    def fixture(self, mode='ok'):
        accepted, requests, release = [], [], threading.Event()
        class Handler(http.server.BaseHTTPRequestHandler):
            protocol_version = 'HTTP/1.1'
            def setup(self):
                super().setup();accepted.append(self.client_address)
            def do_POST(self):
                payload=json.loads(self.rfile.read(int(self.headers['Content-Length'])))
                requests.append(payload)
                if mode=='disconnect':
                    self.close_connection=True;self.connection.shutdown(socket.SHUT_RDWR);return
                if mode=='hang':release.wait(2)
                raw=b'{"id":1,"result":"ok"}' if mode!='invalid' else b'invalid'
                try:
                    self.send_response(302 if mode=='redirect' else 200)
                    if mode=='redirect':self.send_header('Location','/unexpected')
                    self.send_header('Content-Length',str(len(raw)));self.end_headers();self.wfile.write(raw)
                except (BrokenPipeError,ConnectionResetError):pass
            def log_message(self,*args):pass
        server=http.server.ThreadingHTTPServer(('127.0.0.1',0),Handler);server.daemon_threads=True
        thread=threading.Thread(target=server.serve_forever,daemon=True);thread.start()
        responses=[]
        client=types.SimpleNamespace(put_response=responses.append)
        client.transport=types.SimpleNamespace(endpoint='http://127.0.0.1:%d'%server.server_port,
            session_id='fixture-session',rpc_client=client)
        session=LocalRpcSession(client);bound_rpc_transport(client,.5)
        def cleanup():
            release.set();session.close();server.shutdown();server.server_close();thread.join(2)
        self.addCleanup(cleanup)
        return client,session,accepted,requests,responses

    def test_many_rpc_calls_reuse_one_connection_without_mutating_input(self):
        client,session,accepted,requests,responses=self.fixture()
        original={'id':1,'method':'fixture'}
        for _ in range(60):client.transport.send(original)
        self.assertEqual(len(accepted),1);self.assertEqual(len(requests),60)
        self.assertEqual(len(responses),60);self.assertNotIn('session_id',original)
        self.assertTrue(all(r['session_id']=='fixture-session'for r in requests))
        self.assertFalse(session.session.trust_env)
        self.assertEqual(session.session.adapters['http://'].max_retries.total,0)

    def test_loopback_does_not_use_environment_proxy(self):
        client,session,accepted,requests,responses=self.fixture()
        with patch.dict(os.environ,{'http_proxy':'http://127.0.0.1:1','HTTP_PROXY':'http://127.0.0.1:1','NO_PROXY':'','no_proxy':''}):
            client.transport.send({'id':1})
        self.assertEqual(len(requests),1);self.assertEqual(len(responses),1)

    def test_distinct_clients_never_share_connection_or_response_state(self):
        first,session,accepted,requests,responses=self.fixture()
        other_responses=[];other=types.SimpleNamespace(put_response=other_responses.append)
        other.transport=types.SimpleNamespace(endpoint=first.transport.endpoint,session_id='second-session',rpc_client=other)
        second_session=LocalRpcSession(other);self.addCleanup(second_session.close);bound_rpc_transport(other,.5)
        first.transport.send({'id':1});other.transport.send({'id':2});first.transport.send({'id':3})
        self.assertEqual(len(accepted),2)
        self.assertEqual([r['session_id']for r in requests],['fixture-session','second-session','fixture-session'])
        self.assertEqual(len(responses),2);self.assertEqual(len(other_responses),1)

    def test_redirect_disconnect_and_invalid_response_never_replay(self):
        for mode in ('redirect','disconnect','invalid'):
            with self.subTest(mode=mode):
                client,session,accepted,requests,responses=self.fixture(mode)
                with self.assertRaises(RpcDeliveryUnknown):client.transport.send({'id':1,'method':'setAttr'})
                self.assertEqual(len(requests),1);self.assertFalse(responses)

    def test_wait_timeout_keeps_shorter_budget_and_one_accepted_write(self):
        client,session,accepted,requests,responses=self.fixture('hang')
        began=time.monotonic()
        with self.assertRaises(RpcDeliveryUnknown):client.transport.send({'id':1,'method':'setAttr'},timeout=.1)
        self.assertLess(time.monotonic()-began,1)
        self.assertEqual(len(requests),1);self.assertFalse(responses)

    def test_context_change_and_close_stop_before_any_request(self):
        for field,value in [('endpoint','http://127.0.0.1:1'),('session_id','changed'),('rpc_client',object())]:
            client,session,accepted,requests,responses=self.fixture()
            setattr(client.transport,field,value)
            with self.assertRaises(RpcDeliveryUnknown):client.transport.send({'id':1})
            self.assertFalse(requests)
        client,session,accepted,requests,responses=self.fixture();session.close();session.close()
        with self.assertRaises(RpcDeliveryUnknown):client.transport.send({'id':1})
        self.assertFalse(requests)

    def test_unknown_remote_endpoints_and_install_order_are_rejected(self):
        for endpoint in ('http://example.invalid:1234','https://127.0.0.1:1234','http://localhost:1234',
                         'http://u:p@127.0.0.1:1234','http://127.0.0.1:1234/path','http://127.0.0.1:1234?x=1'):
            client=types.SimpleNamespace();client.transport=types.SimpleNamespace(endpoint=endpoint,session_id='s',rpc_client=client)
            with self.assertRaises(StopPreview):LocalRpcSession(client)
        client,session,accepted,requests,responses=self.fixture()
        with self.assertRaises(StopPreview):LocalRpcSession(client)
        self.assertFalse(requests)

    def test_waiting_for_busy_client_cannot_send_after_budget(self):
        client,session,accepted,requests,responses=self.fixture()
        session.lock.acquire()
        try:
            began=time.monotonic()
            with self.assertRaises(RpcDeliveryUnknown):client.transport.send({'id':1},timeout=.05)
            self.assertLess(time.monotonic()-began,1);self.assertFalse(requests)
        finally:session.lock.release()


if __name__=='__main__':unittest.main()
