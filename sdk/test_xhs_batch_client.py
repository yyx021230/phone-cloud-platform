"""Isolated HTTP/signing tests; no platform or real account connections."""
import hashlib
import hmac
import json
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from unittest.mock import patch
from urllib.error import HTTPError

from sdk.xhs_batch_client import XhsBatchClient


class BatchHttpTests(unittest.TestCase):
    def test_public_http_and_https_are_accepted_without_contacting_them(self):
        for url in ("http://platform.example", "http://192.0.2.10:8080", "https://platform.example", "http://[::1]:8080"):
            self.assertEqual(XhsBatchClient(url, "fixture", "fixture").base, url)

    def test_invalid_urls_cannot_be_used(self):
        for url in ("ftp://example.test", "file:///tmp/test", "http:///missing", "http://user:pass@example.test",
                    "http://example.test/path", "http://example.test?token=x", "http://example.test#x", "http://example.test:broken"):
            with self.subTest(url=url), self.assertRaises(ValueError):
                XhsBatchClient(url, "fixture", "fixture")

    def test_real_http_keeps_signature_query_order_nonce_and_post_no_replay(self):
        calls = []
        secret = "synthetic-test-secret"

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass

            def do_GET(self):
                self.handle_request()

            def do_POST(self):
                self.handle_request()

            def handle_request(self):
                body = self.rfile.read(int(self.headers.get("Content-Length", "0")))
                canonical = "\n".join((self.command, self.path, self.headers["X-Timestamp"],
                                       self.headers["X-Nonce"], hashlib.sha256(body).hexdigest()))
                expected = hmac.new(secret.encode(), canonical.encode(), hashlib.sha256).hexdigest()
                calls.append((self.command, self.path, body, self.headers["X-Nonce"]))
                if self.headers["X-Signature"] != expected or self.headers["X-Client-Id"] != "fixture":
                    self.send_response(401)
                    self.end_headers()
                    return
                if self.command == "POST":
                    self.send_response(307)
                    self.send_header("Location", "/unexpected-replay")
                    self.end_headers()
                    return
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(json.dumps({"items": [], "nextOffset": None}).encode())

        server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            with patch.dict("os.environ", {"no_proxy": "127.0.0.1", "NO_PROXY": "127.0.0.1"}):
                client = XhsBatchClient("http://127.0.0.1:" + str(server.server_port), "fixture", secret)
                self.assertEqual(client.results("a" * 64, 10, 20)["items"], [])
                client.results("a" * 64, 10, 20)
                with self.assertRaises(HTTPError) as caught:
                    client.create_batch("fixture-original-id")
                self.assertEqual(caught.exception.code, 307)
            self.assertEqual(len(calls), 3)
            self.assertTrue(calls[0][1].endswith("?offset=10&limit=20"))
            self.assertEqual(len({c[3] for c in calls}), 3)
            self.assertEqual(json.loads(calls[2][2]), {"requestId": "fixture-original-id"})
        finally:
            server.shutdown()
            server.server_close()
            thread.join(timeout=2)


if __name__ == "__main__":
    unittest.main()
