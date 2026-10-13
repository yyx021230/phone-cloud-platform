"""Dependency-free client for the Phone Cloud external name-lookup API."""

from __future__ import annotations

import hashlib
import hmac
import json
import time
import uuid
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen


TERMINAL_QUERY_STATUSES = {
    "succeeded", "not_found", "limit_reached", "failed", "cancelled"
}


class OpenNameLookupApiError(RuntimeError):
    def __init__(self, message, *, status=0, code="open_name_lookup_request_failed", payload=None):
        super().__init__(message)
        self.status = status
        self.code = code
        self.payload = payload


class OpenNameLookupClient:
    def __init__(self, *, base_url, client_id, secret, request_timeout=30, opener=urlopen):
        if not base_url or not client_id or not secret:
            raise ValueError("base_url, client_id and secret are required")
        self.base_url = str(base_url).rstrip("/")
        self.client_id = str(client_id)
        self.secret = str(secret)
        self.request_timeout = max(1, float(request_timeout))
        self.opener = opener

    def lookup_name(self, phone_number, *, idempotency_key=None, request_timeout=130):
        key = idempotency_key or str(uuid.uuid4())
        for attempt in range(2):
            try:
                return self._request("POST", "/api/v1/open/name-lookups/query", body={"phoneNumber": phone_number}, idempotency_key=key, request_timeout=request_timeout)
            except OpenNameLookupApiError as error:
                if error.code != "network_error" or attempt == 1:
                    raise

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
        try:
            with self.opener(request, timeout=request_timeout or self.request_timeout) as response:
                return _decode_response(response.read())
        except HTTPError as error:
            payload = _decode_response(error.read())
            code = str(payload.get("code") or payload.get("error", f"http_{error.code}"))
            raise OpenNameLookupApiError(
                code, status=error.code, code=code, payload=payload
            ) from error
        except (URLError, TimeoutError, OSError) as error:
            raise OpenNameLookupApiError(str(error), code="network_error") from error


def _decode_response(raw):
    if not raw:
        return {}
    try:
        return json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError):
        return {"raw": raw.decode("utf-8", errors="replace")}


def _select_queries(session, query_ids):
    by_id = {str(query.get("queryId")): query for query in session.get("results", [])}
    return [by_id[query_id] for query_id in query_ids if query_id in by_id]
