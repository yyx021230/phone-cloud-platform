import json
import os
import subprocess
from pathlib import Path
import sys
import tempfile
import time
import unittest
from unittest.mock import patch
from lookup_ocr_runtime import OcrProcess, interpreter


class IsolatedOcrTest(unittest.TestCase):
    def worker(self, source):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        script = Path(directory.name)/'worker.py';script.write_text(source)
        client = OcrProcess(sys.executable, script);self.addCleanup(client.close)
        return client

    def test_same_worker_serves_two_images_without_reloading_engine(self):
        client = self.worker('import sys,json,os\nfor line in sys.stdin:\n r=json.loads(line);print(json.dumps({"id":r["id"],"rows":[[[],str(os.getpid()),1]],"size":[10,20]}),flush=True)\n')
        a = client.recognize(b'image',1);b = client.recognize(b'image2',1)
        self.assertEqual(a,b);self.assertEqual(a[1],(10,20))
        process=client.process;client.close();self.assertIsNotNone(process.poll())

    def test_unread_large_stdin_has_bounded_timeout_and_reaps_only_child(self):
        client=self.worker('import time\ntime.sleep(30)\n');start=time.monotonic()
        with self.assertRaisesRegex(RuntimeError,'timeout'):
            client.recognize(b'x'*1024*1024,.1)
        self.assertLess(time.monotonic()-start,2);self.assertIsNone(client.process)

    def test_wrong_request_identity_is_rejected_and_worker_closed(self):
        client=self.worker('import sys,json\nfor line in sys.stdin: print(json.dumps({"id":999,"rows":[],"size":[1,1]}),flush=True)\n')
        with self.assertRaisesRegex(RuntimeError,'failed'):client.recognize(b'image',1)
        self.assertIsNone(client.process)

    def test_unexpected_worker_exit_is_not_empty_name(self):
        client=self.worker('raise SystemExit(2)\n')
        with self.assertRaises((RuntimeError,BrokenPipeError)):client.recognize(b'image',1)
        self.assertIsNone(client.process)

    def test_worker_error_does_not_expose_image_or_result(self):
        client=self.worker('import sys,json\nfor line in sys.stdin:\n r=json.loads(line);print(json.dumps({"id":r["id"],"error":"private-ocr-output"}),flush=True)\n')
        with self.assertRaisesRegex(RuntimeError,'^lookup_ocr_worker_failed$'):client.recognize(b'private-image',1)

    def test_invalid_images_never_start_process(self):
        client=self.worker('raise AssertionError("must not start")\n')
        for raw in [b'',b'x'*(16*1024*1024+1),'string']:
            with self.assertRaises(ValueError):client.recognize(raw)
        self.assertIsNone(client.process)

    def test_parent_pipe_close_exits_worker_even_during_stuck_inference(self):
        import shutil
        with tempfile.TemporaryDirectory() as directory:
            folder = Path(directory)
            shutil.copyfile(Path(__file__).with_name("lookup_ocr_worker.py"), folder / "worker.py")
            (folder / "alipay_visual_result.py").write_text("def _prepare_local():\n import threading\n assert threading.active_count()==1\n\ndef _recognize_local(raw):\n import time\n time.sleep(30)\n")
            # Test the production receiver/EOF path; isolation is checked by the real venv probe.
            code = "import sys;sys.path.insert(0,sys.argv[1]);import worker;worker.verify_isolation=lambda:None;worker.serve()"
            child = subprocess.Popen([sys.executable, "-I", "-c", code, directory], stdin=subprocess.PIPE, stdout=subprocess.PIPE)
            try:
                child.stdin.write(b'{"id":1,"image":"eA=="}\n'); child.stdin.flush()
                time.sleep(.1); child.stdin.close()
                self.assertEqual(child.wait(timeout=2), 0)
            finally:
                if child.poll() is None: child.kill(); child.wait()
                child.stdout.close()

    def test_configured_interpreter_must_be_absolute_and_exist(self):
        for value in ['relative/python','/definitely/not/a/python']:
            with patch.dict(os.environ,{'PHONE_CLOUD_LOOKUP_OCR_PYTHON':value}):
                with self.assertRaisesRegex(RuntimeError,'runtime_missing'):interpreter()
        with patch.dict(os.environ,{'PHONE_CLOUD_LOOKUP_OCR_PYTHON':sys.executable}):
            self.assertEqual(interpreter(),sys.executable)


if __name__=='__main__':unittest.main()
