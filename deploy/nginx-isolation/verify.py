#!/usr/bin/env python3
"""Bounded Nginx regression test; synthetic data and private Unix sockets only.

Never run this as root. No production config, ports, payloads or credentials are
accepted. In particular, `nginx -p` alone does NOT isolate compiled temp paths.
"""
import argparse
import gzip
import hashlib
import http.client
import http.server
import json
import os
from pathlib import Path
import re
import socket
import socketserver
import stat
import subprocess
import tempfile
import threading
import time
import traceback

TEMP_PATHS = {
    "client_body_temp_path": "body", "proxy_temp_path": "proxy",
    "fastcgi_temp_path": "fastcgi", "uwsgi_temp_path": "uwsgi",
    "scgi_temp_path": "scgi",
}
PRODUCTION_PATHS = tuple(Path("/var/lib/nginx") / p for p in TEMP_PATHS.values())


def require_unprivileged(uid=None, status=None):
    uid = os.geteuid() if uid is None else uid
    if uid == 0:
        raise RuntimeError("ROOT_FORBIDDEN: use an unprivileged test identity")
    if status is None:
        status = Path("/proc/self/status").read_text() if Path("/proc/self/status").exists() else ""
    caps = re.search(r"^CapEff:\s*([0-9a-fA-F]+)$", status, re.M)
    if caps and int(caps[1], 16):
        raise RuntimeError("CAPABILITIES_FORBIDDEN")


def metadata(paths=PRODUCTION_PATHS):
    result = {}
    for path in paths:
        try:
            s = path.lstat()
            result[str(path)] = {"uid": s.st_uid, "gid": s.st_gid,
                                 "mode": stat.S_IMODE(s.st_mode), "inode": s.st_ino}
        except FileNotFoundError:
            result[str(path)] = None
    # Do not compare mtime/ctime: active requests legitimately create temp files.
    return result


def require_no_production_write_access(paths=PRODUCTION_PATHS):
    # A non-root production worker identity could still own these directories.
    # Use an unrelated test identity, not www-data or a writable shared group.
    if any(path.exists() and os.access(path, os.W_OK) for path in paths):
        raise RuntimeError("PRODUCTION_WRITE_ACCESS_FORBIDDEN")


def render_config(root):
    root = Path(root)
    if not root.is_absolute() or not re.fullmatch(r"/[A-Za-z0-9_./-]+", str(root)) or ".." in root.parts:
        raise ValueError("unsafe test path")
    paths = "\n".join(f"  {key} {root / value};" for key, value in TEMP_PATHS.items())
    return f"""daemon off;
master_process off;
pid {root}/nginx.pid;
lock_file {root}/nginx.lock;
error_log {root}/error.log notice;
events {{ worker_connections 32; }}
http {{
{paths}
  access_log off;
  client_body_buffer_size 1k;
  client_max_body_size 128k;
  server {{
    listen unix:{root}/front.sock;
    location = /inventory-fixture {{
      gzip on;
      gzip_types application/json;
      gzip_comp_level 1;
      gzip_min_length 1024;
      proxy_pass http://unix:{root}/upstream.sock:;
    }}
    location / {{ proxy_pass http://unix:{root}/upstream.sock:; }}
  }}
}}
"""


class UnixClient(http.client.HTTPConnection):
    def connect(self):
        self.sock = socket.socket(socket.AF_UNIX)
        self.sock.settimeout(self.timeout)
        self.sock.connect(self.host)


class UnixServer(socketserver.ThreadingMixIn, socketserver.UnixStreamServer):
    daemon_threads = True


def verify(binary):
    # This must precede mkdtemp, a subprocess, or an Nginx configuration check.
    require_unprivileged()
    executable = Path(binary).resolve(strict=True)
    if executable.stat().st_mode & (stat.S_ISUID | stat.S_ISGID):
        raise RuntimeError("PRIVILEGED_BINARY_FORBIDDEN")
    if hasattr(os, "listxattr") and "security.capability" in os.listxattr(executable):
        raise RuntimeError("PRIVILEGED_BINARY_FORBIDDEN")
    require_no_production_write_access()
    before = metadata()
    result = None
    try:
        # Explicit /var/tmp avoids inheriting an operator's TMPDIR. The live
        # host's /tmp is root-only; do not weaken it to make a test work.
        with tempfile.TemporaryDirectory(prefix="pc-nginx-safe-", dir="/var/tmp") as folder:
            root = Path(folder)
            request = b"synthetic-request-only-" * 2900
            reply = json.dumps({"fixture": "synthetic-response-only-" * 12000}).encode()
            received = []

            class Handler(http.server.BaseHTTPRequestHandler):
                def do_POST(self):
                    body = self.rfile.read(int(self.headers["Content-Length"]))
                    received.append(hashlib.sha256(body).hexdigest())
                    self.send_response(200)
                    self.send_header("Content-Type", "application/json")
                    self.send_header("Content-Length", str(len(reply)))
                    self.end_headers()
                    self.wfile.write(reply)

                def log_message(self, *_args):
                    pass

            server = UnixServer(str(root / "upstream.sock"), Handler)
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()
            process = None
            try:
                config = root / "nginx.conf"
                config.write_text(render_config(root))
                args = [str(executable), "-p", folder, "-c", str(config)]
                check = subprocess.run(args + ["-t"], capture_output=True, timeout=5)
                if check.returncode:
                    raise RuntimeError("ISOLATED_CONFIG_CHECK_FAILED")
                if before != metadata():
                    raise RuntimeError("PRODUCTION_DIRECTORY_DRIFT: stop; do not auto-repair")
                # stderr can contain startup diagnostics; never inherit a terminal
                # or allow an unread PIPE to deadlock the test child.
                with (root / "startup.log").open("wb") as output:
                    process = subprocess.Popen(args, stdout=subprocess.DEVNULL, stderr=output)
                    deadline = time.monotonic() + 5
                    while not (root / "front.sock").exists():
                        if process.poll() is not None or time.monotonic() >= deadline:
                            raise RuntimeError("ISOLATED_NGINX_START_FAILED")
                        time.sleep(.05)
                    cases = []
                    for route, encoding in [("/inventory-fixture", "gzip"),
                                            ("/inventory-fixture", "identity"),
                                            ("/inventory-fixture", "gzip;q=0"),
                                            ("/unrelated-fixture", "gzip")]:
                        client = UnixClient(str(root / "front.sock"), timeout=5)
                        try:
                            client.request("POST", route, body=request,
                                           headers={"Accept-Encoding": encoding, "Host": "fixture.invalid"})
                            response = client.getresponse()
                            raw = response.read()
                            compressed = response.getheader("Content-Encoding") == "gzip"
                            decoded = gzip.decompress(raw) if compressed else raw
                            expected_compression = route == "/inventory-fixture" and encoding == "gzip"
                            if response.status != 200 or decoded != reply or compressed != expected_compression:
                                raise RuntimeError("ISOLATED_RESPONSE_MISMATCH")
                            cases.append({"route": route, "acceptEncoding": encoding, "status": response.status,
                                          "gzip": compressed, "requestBytes": len(request), "responseBytes": len(raw),
                                          "decodedBytes": len(decoded), "byteIdentical": True})
                        finally:
                            client.close()
                    if received != [hashlib.sha256(request).hexdigest()] * 4:
                        raise RuntimeError("ISOLATED_REQUEST_BODY_MISMATCH")
                    spilled = "request body is buffered to a temporary file" in (root / "error.log").read_text()
                    if not spilled:
                        raise RuntimeError("REQUEST_SPILL_NOT_EXERCISED")
                    result = {"uid": os.geteuid(), "cases": cases, "requestBodySpillExercised": True}
            finally:
                if process is not None and process.poll() is None:
                    process.terminate()  # only the child PID created above, never a service PID
                    try:
                        process.wait(timeout=5)
                    except subprocess.TimeoutExpired:
                        process.kill()
                        process.wait(timeout=5)
                server.shutdown()
                server.server_close()
                thread.join(timeout=2)
    finally:
        if before != metadata():
            raise RuntimeError("PRODUCTION_DIRECTORY_DRIFT: stop; do not auto-repair")
    return {**result, "productionDirectoryMetadataUnchanged": True, "productionDirectoryWritable": False,
            "productionConfigLoaded": False,
            "tcpListeners": 0, "productionRequests": 0, "cleanupComplete": True}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--nginx", default="/usr/sbin/nginx")
    args = parser.parse_args()
    try:
        print(json.dumps(verify(args.nginx), sort_keys=True))
        return 0
    except (OSError, RuntimeError, subprocess.TimeoutExpired) as exc:
        # Only fixed diagnostic codes; do not dump response bodies or environment.
        code = str(exc) if isinstance(exc, RuntimeError) else type(exc).__name__
        site = traceback.extract_tb(exc.__traceback__)[-1]
        print(json.dumps({"passed": False, "error": code, "function": site.name, "line": site.lineno}))
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
