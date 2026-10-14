"""Private OCR interpreter entrypoint; stdin/stdout only, no ADB or networking."""
import base64
import contextlib
import json
import importlib.util
import os
from pathlib import Path
import queue
import sys
import threading

sys.path.insert(0, str(Path(__file__).resolve().parent))
from alipay_visual_result import _recognize_local, _prepare_local


def verify_isolation():
    if sys.prefix == sys.base_prefix or importlib.util.find_spec("airtest") is not None:
        raise RuntimeError("lookup_ocr_runtime_not_isolated")


def verify():
    verify_isolation()
    import cv2
    import numpy as np
    image = np.full((120, 1000, 3), 255, dtype=np.uint8)
    cv2.putText(image, "1234567890", (20, 85), cv2.FONT_HERSHEY_SIMPLEX, 2, (0, 0, 0), 3)
    ok, encoded = cv2.imencode(".png", image)
    assert ok
    rows, size = _recognize_local(encoded.tobytes())
    assert any("1234567890" in str(row[1]).replace(" ", "") for row in rows), "ocr_inference_failed"
    print(json.dumps({"ok": True, "inference": "synthetic-digits", "size": size}))


def serve():
    verify_isolation()
    # Import native DLLs before a receiver thread can block in Windows stdin.
    # Loading numpy with that thread already reading can stall indefinitely.
    # Initialization remains inside the parent's bounded, private worker call.
    with contextlib.redirect_stdout(sys.stderr):
        _prepare_local()
    requests = queue.Queue(maxsize=1)
    def receive():
        while True:
            line = sys.stdin.buffer.readline(23 * 1024 * 1024)
            # Parent termination closes the private pipe even during native
            # inference. This worker owns no phone resources or mutable files.
            if not line:
                os._exit(0)
            if not line.endswith(b"\n"):
                os._exit(2)
            requests.put(line)
    threading.Thread(target=receive, daemon=True).start()
    while True:
        line = requests.get()
        request = {}
        try:
            if not line.endswith(b"\n"):
                return
            request = json.loads(line)
            raw = base64.b64decode(request["image"], validate=True)
            if not raw or len(raw) > 16 * 1024 * 1024:
                raise ValueError("invalid_image")
            with contextlib.redirect_stdout(sys.stderr):
                rows, size = _recognize_local(raw)
            reply = {"id": request["id"], "rows": rows, "size": size}
        except Exception:
            reply = {"id": request.get("id"), "error": "ocr_failed"}
        encoded = json.dumps(reply, default=lambda v: v.tolist() if hasattr(v, "tolist") else float(v))
        if len(encoded.encode("utf-8")) > 8 * 1024 * 1024:
            encoded = json.dumps({"id": request.get("id"), "error": "ocr_output_too_large"})
        print(encoded, flush=True)


if __name__ == "__main__":
    verify() if sys.argv[1:] == ["--verify-runtime"] else serve()
