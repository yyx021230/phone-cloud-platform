"""Local sockets demonstrate bounded waits and no replay after uncertain UI."""
import http.server
import socket
import threading
import time
import types
import unittest
import urllib.request
import wecom_invite_preview as w
from wecom_rpc_budget import bound_rpc_transport
from test_wecom_invite_preview import HOME, PHONE


class BudgetTests(unittest.TestCase):
    def test_real_http_wait_stops_and_uncertain_action_is_not_replayed(self):
        entered=threading.Event();release=threading.Event();calls=[]
        class Handler(http.server.BaseHTTPRequestHandler):
            def do_POST(self):
                self.rfile.read(int(self.headers.get('Content-Length','0')))
                calls.append('accepted');entered.set();release.wait(3)
                try:self.send_response(200);self.end_headers();self.wfile.write(b'{}')
                except (BrokenPipeError,ConnectionResetError,ConnectionAbortedError):pass
            def log_message(self,*args):pass
        server=http.server.ThreadingHTTPServer(('127.0.0.1',0),Handler);server.daemon_threads=True
        thread=threading.Thread(target=server.serve_forever,daemon=True);thread.start()
        class Transport:
            def send(self,request,timeout=None):
                req=urllib.request.Request('http://127.0.0.1:%d/'%server.server_port,data=b'{}')
                with urllib.request.urlopen(req,timeout=timeout) as response:return response.read()
        client=types.SimpleNamespace(transport=Transport());bound_rpc_transport(client,.15)
        class Driver:
            def snapshot(self):return HOME
            def apply(self,action,expected,phone,check_budget):
                check_budget();client.transport.send({'method':'uncertain UI operation'},timeout=None)
        try:
            started=time.monotonic();out=w.run_preview(Driver(),{'phoneNumber':PHONE},sleep=lambda _:None)
            self.assertTrue(entered.is_set());self.assertEqual(out['code'],'executor_error_no_replay')
            self.assertEqual(calls,['accepted']);self.assertLess(time.monotonic()-started,1.5)
            self.assertFalse(out['invitationSent'])
        finally:release.set();server.shutdown();server.server_close();thread.join(2)

    def test_shorter_async_timeout_and_other_instance_are_preserved(self):
        calls=[]
        class Transport:
            def send(self,request,timeout=None):calls.append(timeout);return 'ok'
        a=types.SimpleNamespace(transport=Transport());b=types.SimpleNamespace(transport=Transport())
        bound_rpc_transport(a,3)
        a.transport.send({},timeout=.3);a.transport.send({},timeout=8);b.transport.send({},timeout=None)
        self.assertEqual(calls,[.3,3,None])

    def test_transport_failure_is_not_retried_and_bad_budgets_are_rejected(self):
        calls=[]
        class Transport:
            def send(self,request,timeout=None):calls.append(1);raise TimeoutError('private details')
        for value in (0,-1,True,float('nan'),11):
            with self.assertRaises(ValueError):bound_rpc_transport(types.SimpleNamespace(transport=Transport()),value)
        client=types.SimpleNamespace(transport=Transport());bound_rpc_transport(client)
        with self.assertRaises(TimeoutError):client.transport.send({})
        self.assertEqual(calls,[1])
        with self.assertRaises(ValueError):bound_rpc_transport(client)
        for value in (0,-1,True,float('inf')):
            with self.assertRaises(ValueError):client.transport.send({},timeout=value)
        self.assertEqual(calls,[1])


if __name__=='__main__':unittest.main()
