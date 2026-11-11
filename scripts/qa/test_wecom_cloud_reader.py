import io
import json
import queue
import threading
import unittest
from unittest.mock import Mock,patch
from wecom_qa_access import CloudReader

class CloudReaderDeliveryTests(unittest.TestCase):
    def fixture(self,rows):
        r=CloudReader.__new__(CloudReader);r.rows=rows;r.lock=threading.Lock();r.sequence=0;r.failed=False
        r.child=Mock();r.child.stdin=io.StringIO();r.child.poll.return_value=None
        return r
    def test_exact_sequence_is_returned_without_credentials_or_reroute(self):
        rows=queue.Queue();rows.put(dict(seq=1,result={'devices':[]}));r=self.fixture(rows)
        self.assertEqual(r.state({'deviceId':'adb:fixture','serial':'fixture'}),{'devices':[]})
        request=json.loads(r.child.stdin.getvalue());self.assertEqual(request['seq'],1);self.assertNotIn('token',request)
    def test_wrong_id_fails_closed_and_next_request_cannot_consume_late_response(self):
        rows=queue.Queue();rows.put(dict(seq=2,result={'devices':[]}));r=self.fixture(rows)
        with self.assertRaises(RuntimeError):r.state({})
        self.assertTrue(r.failed);r.child.terminate.assert_called_once()
        rows.put(dict(seq=1,result={'devices':[]}));before=r.child.stdin.getvalue()
        with self.assertRaises(RuntimeError):r.state({})
        self.assertEqual(r.child.stdin.getvalue(),before)
    def test_timeout_closes_only_owned_client_and_does_not_reuse_pending_sequence(self):
        rows=Mock();rows.get.side_effect=queue.Empty();r=self.fixture(rows)
        with self.assertRaises(RuntimeError):r.state({})
        self.assertTrue(r.failed);r.child.terminate.assert_called_once()
        with self.assertRaises(RuntimeError):r.state({})
        self.assertEqual(rows.get.call_count,1)

    def test_mutex_timeout_closes_own_client_without_writing_a_new_request(self):
        r=self.fixture(queue.Queue());r.lock=Mock();r.lock.acquire.return_value=False
        with self.assertRaises(RuntimeError):r.state({})
        self.assertTrue(r.failed);r.child.terminate.assert_called_once();self.assertEqual(r.child.stdin.getvalue(),'')
    def test_time_queued_for_single_flight_consumes_response_budget(self):
        r=self.fixture(Mock())
        with patch('time.monotonic',side_effect=[0,3]):
            with self.assertRaises(RuntimeError):r.state({})
        self.assertTrue(r.failed);self.assertEqual(r.child.stdin.getvalue(),'');r.rows.get.assert_not_called()
    def test_background_and_foreground_requests_share_one_correlated_stream(self):
        import time
        r=self.fixture(queue.Queue());requests=[];out=[]
        class Input:
            def write(self,line):
                q=json.loads(line);requests.append(q)
                threading.Timer(.03,lambda:r.rows.put(dict(seq=q['seq'],result=dict(deviceId=q['target']['deviceId'])))).start()
            def flush(self):pass
        r.child.stdin=Input()
        threads=[threading.Thread(target=lambda n=n:out.append(r.state(dict(deviceId=n))))for n in ('background','foreground')]
        for t in threads:t.start()
        for t in threads:t.join(2)
        self.assertTrue(all(not t.is_alive()for t in threads));self.assertEqual([x['seq']for x in requests],[1,2])
        self.assertEqual({x['deviceId']for x in out},{'background','foreground'});self.assertFalse(r.failed)

if __name__=='__main__':unittest.main()
