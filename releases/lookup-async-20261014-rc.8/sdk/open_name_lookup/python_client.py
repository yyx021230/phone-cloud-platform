"""Dependency-free client for the Phone Cloud external name-lookup API."""

from __future__ import annotations

import http.client
import contextlib
import socket
import threading
from email.utils import parsedate_to_datetime
import hashlib
import hmac
import json
import time
import uuid
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen, build_opener, HTTPHandler, HTTPSHandler
from urllib.parse import quote


TERMINAL_QUERY_STATUSES = {
    "succeeded", "not_found", "limit_reached", "failed", "cancelled"
}


class OpenNameLookupApiError(RuntimeError):
    def __init__(self, message, *, status=0, code="open_name_lookup_request_failed", payload=None, retry_after_seconds=None):
        super().__init__(message)
        self.status = status
        self.code = code
        self.payload = payload
        self.retry_after_seconds = retry_after_seconds


class OpenNameLookupClient:
    def __init__(self, *, base_url, client_id, secret, request_timeout=30, opener=urlopen):
        if not base_url or not client_id or not secret:
            raise ValueError("base_url, client_id and secret are required")
        self.base_url = str(base_url).rstrip("/")
        self.client_id = str(client_id)
        self.secret = str(secret)
        self.request_timeout = max(1, float(request_timeout))
        self.opener = opener

    def lookup_name(self, phone_number, *, idempotency_key=None, request_timeout=190):
        key = idempotency_key or str(uuid.uuid4())
        for attempt in range(2):
            try:
                return self._request("POST", "/api/v1/open/name-lookups/query", body={"phoneNumber": phone_number}, idempotency_key=key, request_timeout=request_timeout)
            except OpenNameLookupApiError as error:
                if error.code != "network_error" or attempt == 1:
                    raise

    def submit_lookup(self, phone_number, *, idempotency_key=None, request_timeout=None):
        key = idempotency_key or str(uuid.uuid4())
        for attempt in range(2):
            try:
                return self._request("POST", "/api/v1/open/name-lookups/tasks", body={"phoneNumber": phone_number}, idempotency_key=key, request_timeout=request_timeout)
            except OpenNameLookupApiError as error:
                if error.code != "network_error" or attempt == 1:
                    raise

    def get_lookup_result(self, lookup_id, *, request_timeout=None):
        if not lookup_id:
            raise ValueError("lookup_id is required")
        return self._request("GET", "/api/v1/open/name-lookups/tasks/" + quote(str(lookup_id), safe=""), request_timeout=request_timeout)

    def list_devices(self):
        return self._request("GET", "/api/v1/open/name-lookups/devices")

    def create_session(self, device_id, *, idempotency_key=None):
        return self._request(
            "POST", "/api/v1/open/name-lookups/sessions",
            body={"deviceId": device_id}, idempotency_key=idempotency_key or str(uuid.uuid4())
        )

    def get_session(self, session_id):
        return self._request("GET", f"/api/v1/open/name-lookups/sessions/{session_id}")

    def enqueue_query(self, session_id, query, *, idempotency_key=None):
        return self._request(
            "POST", f"/api/v1/open/name-lookups/sessions/{session_id}/queries",
            body=query, idempotency_key=idempotency_key or str(uuid.uuid4())
        )

    def enqueue_many(self, session_id, queries):
        accepted = []
        # Deliberately sequential: server queue order is request-arrival order.
        for item in queries:
            query = dict(item)
            key = query.pop("idempotencyKey", None) or str(uuid.uuid4())
            accepted.append(self.enqueue_query(session_id, query, idempotency_key=key))
        return accepted

    def get_query(self, session_id, query_id):
        return self._request(
            "GET", f"/api/v1/open/name-lookups/sessions/{session_id}/queries/{query_id}"
        )

    def resume(self, session_id, query_id, *, idempotency_key=None):
        return self._request(
            "POST", f"/api/v1/open/name-lookups/sessions/{session_id}/resume",
            body={"queryId": query_id}, idempotency_key=idempotency_key or str(uuid.uuid4())
        )

    def end_session(self, session_id):
        return self._request(
            "POST", f"/api/v1/open/name-lookups/sessions/{session_id}/end", body={}
        )

    def wait_for_queries(self, session_id, query_ids, *, poll_interval=3, timeout=0, on_update=None):
        expected = list(dict.fromkeys(str(value) for value in query_ids if value))
        if not expected:
            raise ValueError("query_ids must not be empty")
        started_at = time.monotonic()
        while True:
            session = self.get_session(session_id)["session"]
            if on_update:
                on_update(session)
            selected = self._complete_query_selection(session_id, session, expected)
            if session.get("humanAction", {}).get("required"):
                return {"state": "human_action_required", "session": session, "queries": selected}
            if session.get("queueState", {}).get("status") == "paused":
                return {"state": "queue_paused", "session": session, "queries": selected}
            if len(selected) == len(expected) and all(
                query.get("status") in TERMINAL_QUERY_STATUSES for query in selected
            ):
                return {"state": "completed", "session": session, "queries": selected}
            if timeout and time.monotonic() - started_at >= timeout:
                return {"state": "timeout", "session": session, "queries": selected}
            time.sleep(max(0.25, float(poll_interval)))

    def _complete_query_selection(self, session_id, session, query_ids):
        selected = _select_queries(session, query_ids)
        found = {str(query.get("queryId")) for query in selected}
        selected.extend(
            self.get_query(session_id, query_id)["query"]
            for query_id in query_ids if query_id not in found
        )
        by_id = {str(query.get("queryId")): query for query in selected}
        return [by_id[query_id] for query_id in query_ids if query_id in by_id]

    def _request(self, method, pathname, *, body=None, idempotency_key=None, request_timeout=None):
        raw_body = b"" if body is None else json.dumps(
            body, ensure_ascii=False, separators=(",", ":")
        ).encode("utf-8")
        timestamp = str(int(time.time() * 1000))
        nonce = str(uuid.uuid4())
        body_hash = hashlib.sha256(raw_body).hexdigest()
        canonical = "\n".join((method, pathname, timestamp, nonce, body_hash)).encode("utf-8")
        signature = hmac.new(self.secret.encode("utf-8"), canonical, hashlib.sha256).hexdigest()
        headers = {
            "X-Client-Id": self.client_id,
            "X-Timestamp": timestamp,
            "X-Nonce": nonce,
            "X-Signature": signature,
        }
        if body is not None:
            headers["Content-Type"] = "application/json"
        if idempotency_key:
            headers["Idempotency-Key"] = idempotency_key
        request = Request(self.base_url + pathname, data=raw_body if body is not None else None,
                          headers=headers, method=method)
        timeout = float(request_timeout or self.request_timeout)
        deadline = time.monotonic() + timeout
        try:
            with (_deadline_urlopen(request, timeout) if self.opener is urlopen else self.opener(request, timeout=timeout)) as response:
                raw = _read_response(response, deadline)
                payload = _decode_response(raw)
                if not isinstance(payload, dict):
                    raise OpenNameLookupApiError("Invalid API JSON response", status=getattr(response, "status", 200), code="invalid_response")
                return payload
        except HTTPError as error:
            # An HTTP failure remains an HTTP failure if its body breaks.
            try:
                payload = _decode_response(_read_response(error, deadline))
            except (URLError, OSError, http.client.HTTPException):
                payload = None
            finally:
                error.close()
            code = str((payload.get("code") or payload.get("error")) if isinstance(payload, dict) else "") or f"http_{error.code}"
            raise OpenNameLookupApiError(code, status=error.code, code=code, payload=payload,
                                         retry_after_seconds=_retry_after(error.headers)) from error
        except (URLError, OSError, http.client.HTTPException) as error:
            raise OpenNameLookupApiError(str(error), code="network_error") from error


@contextlib.contextmanager
def _deadline_urlopen(request, timeout):
    # urllib's socket timeout alone resets as headers/body bytes arrive. Interrupt
    # the connected socket at the original deadline, including trickling headers.
    sockets = []
    lock = threading.Lock()
    expired = threading.Event()

    def close_socket(sock):
        try:
            sock.shutdown(socket.SHUT_RDWR)
        except OSError:
            pass
        try:
            sock.close()
        except OSError:
            pass

    def abort():
        expired.set()
        with lock:
            for sock in sockets:
                close_socket(sock)

    class ConnectionDeadline:
        def connect(self):
            super().connect()
            with lock:
                if expired.is_set():
                    close_socket(self.sock)
                    raise TimeoutError("Open name lookup request timed out")
                sockets.append(self.sock)

    class HTTPConnection(ConnectionDeadline, http.client.HTTPConnection):
        pass

    class HTTPSConnection(ConnectionDeadline, http.client.HTTPSConnection):
        pass

    class HttpHandler(HTTPHandler):
        def http_open(self, req):
            return self.do_open(HTTPConnection, req)

    class HttpsHandler(HTTPSHandler):
        def https_open(self, req):
            return self.do_open(HTTPSConnection, req, context=self._context)

    timer = threading.Timer(timeout, abort)
    timer.daemon = True
    timer.start()
    try:
        with build_opener(HttpHandler(), HttpsHandler()).open(request, timeout=timeout) as response:
            yield response
    finally:
        timer.cancel()


def _read_response(response, deadline):
    # urlopen returns an HTTPResponse. Keep one budget across headers and chunks;
    # read1 does at most one socket read, so trickling bytes cannot reset the budget.
    # Custom openers may provide a simpler read-only test/transport object.
    if isinstance(response, HTTPError):
        response = response.fp
    reader = getattr(response, "read1", None)
    if reader is None:
        return response.read()
    chunks = []
    expected = getattr(response, "length", None)
    size = 0
    while True:
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise TimeoutError("Open name lookup request timed out")
        # CPython urllib exposes the socket through its buffered HTTP response.
        sock = getattr(getattr(getattr(response, "fp", None), "raw", None), "_sock", None)
        if sock is not None:
            sock.settimeout(remaining)
        chunk = reader(65536)
        if not chunk:
            if expected is not None and size < expected:
                raise http.client.IncompleteRead(b"", expected - size)
            return b"".join(chunks)
        chunks.append(chunk)
        size += len(chunk)


def _decode_response(raw):
    try:
        return json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError):
        return None


def _retry_after(headers):
    value = headers.get("Retry-After") if headers else None
    if not value:
        return None
    try:
        if value.isdigit():
            return int(value)
        return max(0, int(parsedate_to_datetime(value).timestamp() - time.time() + .999))
    except (ValueError, TypeError, OverflowError):
        return None


def _select_queries(session, query_ids):
    by_id = {str(query.get("queryId")): query for query in session.get("results", [])}
    return [by_id[query_id] for query_id in query_ids if query_id in by_id]
