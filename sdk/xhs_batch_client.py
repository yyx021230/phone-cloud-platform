"""Python 3.9+ client. No automatic retries; reuse request_id after a lost batch reply."""
import hashlib
import hmac
import json
import time
import uuid
from urllib.parse import urlsplit
from urllib.request import Request, build_opener, HTTPRedirectHandler


class _NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


class XhsBatchClient:
    def __init__(self, base_url, client_id, secret):
        parsed = urlsplit(base_url)
        if parsed.username or parsed.password or parsed.query or parsed.fragment or parsed.path not in ("", "/"):
            raise ValueError("invalid base URL")
        if parsed.scheme != "https" and not (parsed.scheme == "http" and parsed.hostname in ("localhost", "127.0.0.1", "::1")):
            raise ValueError("HTTPS required")
        self.base = base_url.rstrip("/")
        self.client_id = client_id
        self.secret = secret
        self.opener = build_opener(_NoRedirect)

    def _request(self, method, suffix, value=None):
        target = "/api/v1/open/xhs-data" + suffix
        raw = b"" if value is None else json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode()
        timestamp, nonce = str(int(time.time() * 1000)), str(uuid.uuid4())
        canonical = "\n".join((method, target, timestamp, nonce, hashlib.sha256(raw).hexdigest()))
        signature = hmac.new(self.secret.encode(), canonical.encode(), hashlib.sha256).hexdigest()
        request = Request(self.base + target, data=raw if value is not None else None, method=method, headers={
            "Content-Type": "application/json", "X-Client-Id": self.client_id,
            "X-Timestamp": timestamp, "X-Nonce": nonce, "X-Signature": signature,
        })
        with self.opener.open(request, timeout=40) as response:
            return json.load(response)

    def schedule(self):
        return self._request("GET", "/schedule")

    def configure(self, enabled=False, at="02:00", window_minutes=240, concurrency=5):
        return self._request("PUT", "/schedule", {"enabled": enabled, "time": at,
            "windowMinutes": window_minutes, "concurrency": concurrency})

    def create_batch(self, request_id):
        return self._request("POST", "/batches", {"requestId": request_id})

    def batches(self, offset=0):
        return self._request("GET", "/batches?offset=" + str(int(offset)))

    def results(self, run_id, offset=0, limit=10):
        if len(run_id) != 64 or any(c not in "0123456789abcdef" for c in run_id):
            raise ValueError("invalid run ID")
        return self._request("GET", "/batches/{}?offset={}&limit={}".format(run_id, int(offset), int(limit)))
