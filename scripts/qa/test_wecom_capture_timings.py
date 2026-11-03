import io
import json
from pathlib import Path
import tempfile
import unittest
from wecom_single_capture import ResourcePipe


class CallSummaryTests(unittest.TestCase):
    def test_only_fixed_numeric_durations_are_retained_without_tail_duplication(self):
        rows=[dict(kind='call',call='qa.proof_request',state='end',durationMs=7,private='secret customer'),
              dict(kind='tail',record=dict(kind='call',call='qa.proof_request',state='end',durationMs=7)),
              dict(kind='call',call='qa.proof_request',state='error',durationMs=9),
              dict(kind='call',call='private customer',state='end',durationMs=11),
              dict(kind='call',call='rpc.transport',state='end',durationMs=True),
              dict(kind='lifecycle',event='before_final_json')]
        with tempfile.TemporaryDirectory()as stage:
            pipe=ResourcePipe(io.StringIO(''.join('WECOM_CALL '+json.dumps(r)+'\n'for r in rows)),stage,[])
            while pipe.read(8192):pass
            text=(Path(stage)/'qa-call-summary.json').read_text();x=json.loads(text)
            self.assertEqual(x['calls'],{'qa.proof_request':dict(count=2,totalMs=16,maxMs=9,errors=1)})
            self.assertNotIn('private',text);self.assertNotIn('secret',text)
            self.assertIsNone(pipe.failure)


if __name__=='__main__':unittest.main()
