"""Loopback wire failures against the distributed Python client; synthetic data."""
import importlib.util,sys,threading,time,json,unittest,os
from pathlib import Path
from http.server import ThreadingHTTPServer,BaseHTTPRequestHandler
spec=importlib.util.spec_from_file_location('client',os.environ.get('LOOKUP_PYTHON_SDK_UNDER_TEST') or Path(__file__).resolve().parents[1]/'sdk/open_name_lookup/python_client.py');mod=importlib.util.module_from_spec(spec);spec.loader.exec_module(mod)
class Transport(unittest.TestCase):
 def setUp(self):
  self.calls=[];case=self
  class Handler(BaseHTTPRequestHandler):
   def log_message(self,*args):pass
   def do_GET(self):self.do_POST()
   def do_POST(self):
    self.rfile.read(int(self.headers.get('Content-Length','0')));case.calls.append(dict(self.headers));n=len(case.calls)
    status=503 if case.mode in ['broken-error','slow-error'] else 429 if case.mode=='rate-limit' else 202
    body=b'{"ok":true,"lookupId":"synthetic","status":"processing"}'
    if case.mode=='invalid-json':body=b'<html>upstream error</html>'
    if case.mode=='array-json':body=b'[]'
    if case.mode=='rate-limit':body=b'{"ok":false,"code":"lookup_queue_full"}'
    if case.mode=='slow-headers':
     try:
      self.wfile.write(b'HTTP/1.0 202 Accepted\r\nX-Slow: ');self.wfile.flush()
      for _ in range(30):self.wfile.write(b'.');self.wfile.flush();time.sleep(.05)
      self.wfile.write(b'\r\nContent-Length: '+str(len(body)).encode()+b'\r\n\r\n'+body);self.wfile.flush()
     except (BrokenPipeError,ConnectionResetError):pass
     self.close_connection=True;return
    self.send_response(status);self.send_header('Content-Length',str(len(body)));self.send_header('Retry-After','7');self.end_headers()
    try:
     if case.mode in ['broken-error','retry-broken'] and (case.mode=='broken-error' or n==1):
      self.wfile.write(body[:5]);self.wfile.flush();self.close_connection=True;return
     if case.mode in ['slow-body','slow-error']:
      for b in body:self.wfile.write(bytes([b]));self.wfile.flush();time.sleep(.05)
     else:self.wfile.write(body)
    except (BrokenPipeError,ConnectionResetError):pass
  self.server=ThreadingHTTPServer(('127.0.0.1',0),Handler);self.thread=threading.Thread(target=self.server.serve_forever,daemon=True);self.thread.start()
  self.client=mod.OpenNameLookupClient(base_url='http://127.0.0.1:'+str(self.server.server_port),client_id='synthetic',secret='synthetic',request_timeout=1)
 def tearDown(self):self.server.shutdown();self.server.server_close();self.thread.join()
 def test_broken_success_retries_same_key_new_nonce(self):
  self.mode='retry-broken';self.assertTrue(self.client.submit_lookup('13800000001',idempotency_key='saved-original-key')['ok']);self.assertEqual(len(self.calls),2)
  self.assertEqual(self.calls[0]['Idempotency-Key'],self.calls[1]['Idempotency-Key']);self.assertNotEqual(self.calls[0]['X-Nonce'],self.calls[1]['X-Nonce'])
 def test_broken_error_keeps_http_and_does_not_retry(self):
  self.mode='broken-error'
  with self.assertRaises(mod.OpenNameLookupApiError) as e:self.client.submit_lookup('13800000001')
  self.assertEqual((e.exception.status,e.exception.code),(503,'http_503'));self.assertEqual(len(self.calls),1)
 def test_slow_body_whole_deadline_and_client_config(self):
  self.mode='slow-body';start=time.monotonic()
  with self.assertRaises(mod.OpenNameLookupApiError) as e:self.client.get_lookup_result('synthetic')
  self.assertEqual(e.exception.code,'network_error');self.assertLess(time.monotonic()-start,1.7);self.assertEqual(len(self.calls),1)
 def test_error_body_also_obeys_whole_deadline(self):
  self.mode='slow-error';start=time.monotonic()
  with self.assertRaises(mod.OpenNameLookupApiError) as e:self.client.submit_lookup('13800000001')
  self.assertEqual((e.exception.status,e.exception.code),(503,'http_503'));self.assertLess(time.monotonic()-start,1.7);self.assertEqual(len(self.calls),1)
 def test_trickling_headers_do_not_extend_deadline(self):
  self.mode='slow-headers';start=time.monotonic()
  with self.assertRaises(mod.OpenNameLookupApiError) as e:self.client.get_lookup_result('synthetic',request_timeout=.2)
  self.assertEqual(e.exception.code,'network_error');self.assertLess(time.monotonic()-start,.7);self.assertEqual(len(self.calls),1)
 def test_per_call_override(self):
  self.mode='slow-body';start=time.monotonic()
  with self.assertRaises(mod.OpenNameLookupApiError):self.client.get_lookup_result('synthetic',request_timeout=.2)
  self.assertLess(time.monotonic()-start,.6)
 def test_invalid_json_not_success_or_automatic_new_query(self):
  self.mode='invalid-json'
  with self.assertRaises(mod.OpenNameLookupApiError) as e:self.client.submit_lookup('13800000001')
  self.assertEqual(e.exception.code,'invalid_response');self.assertEqual(len(self.calls),1)
 def test_array_json_not_object(self):
  self.mode='array-json'
  with self.assertRaises(mod.OpenNameLookupApiError) as e:self.client.get_lookup_result('synthetic')
  self.assertEqual(e.exception.code,'invalid_response')
 def test_retry_after_exposed(self):
  self.mode='rate-limit'
  with self.assertRaises(mod.OpenNameLookupApiError) as e:self.client.submit_lookup('13800000001')
  self.assertEqual(e.exception.code,'lookup_queue_full');self.assertEqual(e.exception.retry_after_seconds,7);self.assertEqual(len(self.calls),1)
if __name__=='__main__':unittest.main()
