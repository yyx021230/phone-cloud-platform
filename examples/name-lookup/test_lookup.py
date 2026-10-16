import hashlib
import hmac
import json
import os
import sqlite3
import subprocess
import sys
import tempfile
import threading
import unittest
from concurrent.futures import ThreadPoolExecutor
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from lookup import ApiError, query_name, open_state, load_job
from contextlib import contextmanager
from types import SimpleNamespace
from unittest.mock import patch

READY = {"ok": True, "ready": True, "status": "ready"}
ACCEPTED = {"ok": True, "lookupId": "mock-query-1", "status": "queued"}


def completed(name):
    return dict(ACCEPTED, status="completed", name=name)


class FlowTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.db = str(Path(self.temp.name) / "state.sqlite3")
        self.time = 0
        self.calls = []

    def tearDown(self):
        self.temp.cleanup()

    def sleep(self, seconds):
        self.time += seconds

    @contextmanager
    def client(self, handler):
        def request(method, pathname, body, key, base, client_id, secret, timeout):
            db = open_state(self.db)
            try:
                row = db.execute("SELECT * FROM lookup_jobs").fetchone()
                self.assertTrue(row["submit_key"], "首次网络调用前必须持久化")
            finally:
                db.close()
            self.calls.append((method, pathname, body, key))
            return handler(method, pathname, body, key)
        with patch("lookup.http_request", request):
            yield SimpleNamespace(lookup=lambda phone, business: query_name(
                phone, business, "mock-client", "mock-secret", "http://example.invalid",
                self.db, clock=lambda: self.time, sleep=self.sleep))

    def test_full_flow(self):
        replies = iter([{"ok": True, "status": "preparing"}, READY, ACCEPTED, ACCEPTED,
                        dict(ACCEPTED, status="processing"), completed("**某")])
        with self.client(lambda *args: next(replies)) as client:
            self.assertEqual(client.lookup("13800000000", "order-1")["name"], "**某")
        self.assertEqual(self.calls[0][3], self.calls[1][3])
        self.assertEqual(self.calls[2][2], {"phoneNumber": "13800000000"})
        self.assertIsNone(self.calls[-1][2])

    def test_empty_name(self):
        replies = iter([READY, ACCEPTED, completed("")])
        with self.client(lambda *args: next(replies)) as client:
            self.assertEqual(client.lookup("13800000000", "order-1")["name"], "")

    def test_120_second_restart_only_get(self):
        with self.client(lambda m, p, *_: READY if p.endswith("prepare") else ACCEPTED) as client:
            self.assertEqual(client.lookup("13800000000", "order-1"), {"status": "pending", "lookupId": "mock-query-1"})
        self.assertEqual(self.time, 120)
        count = len(self.calls)
        with self.client(lambda *args: completed("**某")) as client:
            self.assertEqual(client.lookup("13800000000", "order-1")["name"], "**某")
        self.assertEqual([c[0] for c in self.calls[count:]], ["GET"])

    def test_submission_network_loss_same_key(self):
        replies = iter([READY, ApiError("network_error", True), ACCEPTED, completed("")])
        def handler(*args):
            value = next(replies)
            if isinstance(value, Exception):
                raise value
            return value
        with self.client(handler) as client:
            client.lookup("13800000000", "order-1")
        self.assertEqual(self.calls[1][3], self.calls[2][3])

    def test_429_and_503_same_business_key(self):
        replies = iter([READY, ApiError("lookup_inflight_limit", True, 7), ApiError("lookup_not_ready", True), READY, ACCEPTED, completed("")])
        def handler(*args):
            value = next(replies)
            if isinstance(value, Exception):
                raise value
            return value
        with self.client(handler) as client:
            client.lookup("13800000000", "order-1")
        self.assertEqual(self.time, 12)
        self.assertEqual(len({c[3] for c in self.calls if c[1].endswith("/tasks")}), 1)

    def test_prepare_expired_both_forms(self):
        for index, expiry in enumerate([{"ok": True, "status": "expired"}, ApiError("lookup_preparation_expired")]):
            with self.subTest(index=index):
                self.calls = []
                replies = iter([expiry, READY, ACCEPTED, completed("")])
                def handler(*args):
                    value = next(replies)
                    if isinstance(value, Exception):
                        raise value
                    return value
                with self.client(handler) as client:
                    client.lookup("13800000000", "expire-" + str(index))
                self.assertNotEqual(self.calls[0][3], self.calls[1][3])

    def test_failures_not_empty_name(self):
        for index, failure in enumerate([dict(ACCEPTED, status="failed", ok=False, code="test_failure"), completed(None), ApiError("invalid_signature")]):
            with self.subTest(index=index):
                replies = iter([READY, ACCEPTED, failure])
                def handler(*args):
                    value = next(replies)
                    if isinstance(value, Exception):
                        raise value
                    return value
                with self.client(handler) as client:
                    with self.assertRaises(ApiError):
                        client.lookup("13800000000", "fail-" + str(index))

    def test_wrong_phone_rejected_before_http(self):
        replies = iter([READY, ACCEPTED, completed("")])
        with self.client(lambda *args: next(replies)) as client:
            client.lookup("13800000000", "order-1")
            count = len(self.calls)
            with self.assertRaises(ValueError):
                client.lookup("13900000000", "order-1")
            self.assertEqual(len(self.calls), count)

    def test_concurrent_same_business_shares_key(self):
        def create(_):
            db = open_state(self.db)
            try:
                return load_job(db, "13800000000", "same-order", "http://example.invalid", "mock-client")["submit_key"]
            finally:
                db.close()
        with ThreadPoolExecutor(max_workers=5) as executor:
            self.assertEqual(len(set(executor.map(create, range(10)))), 1)

    def test_cli_http_signature_persistence_and_resume(self):
        owner = self
        ready_flag = [False]
        requests, nonces, failures = [], set(), []
        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass

            def do_POST(self):
                self.handle_api()

            def do_GET(self):
                self.handle_api()

            def handle_api(self):
                raw = self.rfile.read(int(self.headers.get("Content-Length", 0)))
                canonical = "\n".join([self.command, self.path, self.headers["X-Timestamp"], self.headers["X-Nonce"], hashlib.sha256(raw).hexdigest()])
                expected = hmac.new(b"mock-secret", canonical.encode(), hashlib.sha256).hexdigest()
                if expected != self.headers["X-Signature"] or self.headers["X-Nonce"] in nonces:
                    failures.append("invalid signature or duplicate nonce")
                nonces.add(self.headers["X-Nonce"])
                requests.append((self.command, self.path))
                value = READY if self.path.endswith("prepare") else completed("**某") if self.command == "GET" and ready_flag[0] else ACCEPTED
                body = json.dumps(value).encode()
                self.send_response(200)
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)
        server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            env = {"CLIENT_ID": "mock-client", "CLIENT_SECRET": "mock-secret", "BASE_URL": "http://127.0.0.1:" + str(server.server_port), "LOOKUP_STATE_DB": self.db, "WAIT_SECONDS": "0.3"}
            command = [sys.executable, str(Path(__file__).with_name("lookup.py")), "13800000000", "cli-order"]
            first = subprocess.run(command, env=env, capture_output=True, text=True, timeout=10)
            self.assertEqual(first.returncode, 2, first.stderr)
            self.assertEqual(json.loads(first.stdout)["status"], "pending")
            count = len(requests)
            ready_flag[0] = True
            second = subprocess.run(command, env=env, capture_output=True, text=True, timeout=10)
            self.assertEqual(second.returncode, 0, second.stderr)
            self.assertEqual(json.loads(second.stdout)["name"], "**某")
            self.assertEqual(requests[count:], [("GET", "/api/v1/open/name-lookups/tasks/mock-query-1")])
            self.assertEqual(failures, [])
            content = Path(self.db).read_bytes()
            self.assertNotIn(b"mock-secret", content)
            self.assertNotIn(b"13800000000", content)
        finally:
            server.shutdown()
            server.server_close()
            thread.join()


if __name__ == "__main__":
    unittest.main()
