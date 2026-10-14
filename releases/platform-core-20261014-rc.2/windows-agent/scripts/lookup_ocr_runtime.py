"""Bounded, local OCR subprocess. The Airtest interpreter never imports OCR DLLs."""
import atexit
import base64
import json
import os
from pathlib import Path
import queue
import subprocess
import threading
import time

MAX_IMAGE_BYTES = 16 * 1024 * 1024
MAX_REPLY_BYTES = 8 * 1024 * 1024


def interpreter():
    configured = os.environ.get("PHONE_CLOUD_LOOKUP_OCR_PYTHON", "")
    if not configured and os.name != "nt":
        return None
    target = Path(configured) if configured else Path(__file__).resolve().parent.parent / "runtime" / "lookup-ocr" / "Scripts" / "python.exe"
    if not target.is_absolute() or not target.is_file():
        raise RuntimeError("lookup_ocr_runtime_missing")
    return str(target)


class OcrProcess:
    def __init__(self, executable, worker=None):
        self.executable = executable
        self.worker = str(worker or Path(__file__).with_name("lookup_ocr_worker.py"))
        self.process = None
        self.responses = None
        self.sequence = 0
        self.lock = threading.Lock()

    def close(self):
        process, self.process = self.process, None
        if process is None:
            return
        if process.poll() is None:
            process.terminate()
            try:
                process.wait(timeout=1)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(timeout=1)
        for pipe in (process.stdin, process.stdout):
            if pipe:
                pipe.close()

    def start(self):
        if self.process is not None and self.process.poll() is None:
            return
        self.close()
        self.responses = queue.Queue(maxsize=1)
        self.process = subprocess.Popen([self.executable, "-I", "-u", self.worker],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
        process, responses = self.process, self.responses

        def read():
            try:
                while True:
                    line = process.stdout.readline(MAX_REPLY_BYTES + 1)
                    if not line or len(line) > MAX_REPLY_BYTES:
                        responses.put_nowait(None)
                        return
                    responses.put_nowait(line)
            except (OSError, ValueError, queue.Full):
                try:
                    responses.put_nowait(None)
                except queue.Full:
                    pass
        threading.Thread(target=read, daemon=True).start()

    def recognize(self, raw, timeout=10):
        if not isinstance(raw, bytes) or not raw or len(raw) > MAX_IMAGE_BYTES:
            raise ValueError("invalid_screenshot")
        with self.lock:
            deadline = time.monotonic() + max(.05, min(30, timeout))
            self.start()
            self.sequence += 1
            request = {"id": self.sequence, "image": base64.b64encode(raw).decode("ascii")}
            try:
                process, responses = self.process, self.responses
                encoded = json.dumps(request).encode("ascii") + b"\n"
                def write():
                    try:
                        process.stdin.write(encoded)
                        process.stdin.flush()
                    except (OSError, ValueError):
                        try:
                            responses.put_nowait(None)
                        except queue.Full:
                            pass
                threading.Thread(target=write, daemon=True).start()
                line = responses.get(timeout=max(.001, deadline - time.monotonic()))
                if line is None:
                    raise RuntimeError("lookup_ocr_worker_exited")
                reply = json.loads(line)
                if reply.get("id") != self.sequence or reply.get("error"):
                    raise RuntimeError("lookup_ocr_worker_failed")
                if not isinstance(reply.get("rows"), list) or len(reply["rows"]) > 2000 or len(reply.get("size", [])) != 2:
                    raise RuntimeError("lookup_ocr_worker_invalid_reply")
                return reply["rows"], tuple(reply["size"])
            except queue.Empty:
                self.close()
                raise RuntimeError("lookup_ocr_worker_timeout") from None
            except Exception:
                self.close()
                raise


_CLIENT = None


def recognize_isolated(raw, executable, timeout=10):
    global _CLIENT
    if _CLIENT is None or _CLIENT.executable != executable:
        if _CLIENT is not None:
            _CLIENT.close()
        _CLIENT = OcrProcess(executable)
    return _CLIENT.recognize(raw, timeout)


def close():
    if _CLIENT is not None:
        _CLIENT.close()


atexit.register(close)
