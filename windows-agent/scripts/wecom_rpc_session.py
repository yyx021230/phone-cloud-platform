"""One bounded HTTP connection pool for one already connected local Poco client.

No global requests patch, environment proxy, redirect, retry or ADB lifecycle.
Install before bound_rpc_transport so its unknown-delivery guard stays outside.
"""
import json
import math
import threading
import time
from urllib.parse import urlsplit
from wecom_invite_preview import StopPreview


class LocalRpcSession:
    def __init__(self, client):
        transport = client.transport
        parsed = urlsplit(transport.endpoint)
        try:
            port = parsed.port
        except ValueError:
            port = None
        if (parsed.scheme != 'http' or parsed.hostname != '127.0.0.1'
                or type(port) is not int or not 1024 <= port <= 65535
                or parsed.netloc != '127.0.0.1:%d' % port
                or parsed.path not in ('', '/') or parsed.query or parsed.fragment
                or getattr(transport, '_wecom_bounded', False)
                or getattr(transport, '_wecom_session', False)
                or not isinstance(transport.session_id, str) or not transport.session_id
                or transport.rpc_client is not client):
            raise StopPreview('wecom_rpc_session_context_unconfirmed')
        import requests
        from requests.adapters import HTTPAdapter
        self.client, self.transport = client, transport
        self.endpoint, self.session_id = transport.endpoint, transport.session_id
        self.session = requests.Session()
        self.session.trust_env = False
        self.session.mount('http://', HTTPAdapter(max_retries=0, pool_connections=1,
                                                pool_maxsize=1, pool_block=True))
        self.lock, self.closed = threading.Lock(), False
        transport.send = self.send
        transport._wecom_session = True

    def send(self, request, timeout=None):
        if (type(timeout) not in (int, float) or not math.isfinite(timeout)
                or not 0 < timeout <= 10):
            raise StopPreview('invalid_rpc_timeout')
        began = time.monotonic()
        if not self.lock.acquire(timeout=timeout):
            raise TimeoutError('wecom_rpc_session_busy')
        try:
            if (self.closed or self.transport.endpoint != self.endpoint
                    or self.transport.session_id != self.session_id
                    or self.transport.rpc_client is not self.client):
                raise StopPreview('wecom_rpc_session_context_unconfirmed')
            remaining = timeout - (time.monotonic() - began)
            if remaining <= 0:
                raise TimeoutError('wecom_rpc_session_busy')
            payload = dict(request, session_id=self.session_id)
            with self.session.post(self.endpoint, data=json.dumps(payload),
                                   headers={'Content-Type': 'application/json'},
                                   timeout=remaining, allow_redirects=False) as response:
                if response.status_code != 200:
                    raise StopPreview('wecom_rpc_http_response_unconfirmed')
                result = response.json()
            self.client.put_response(result)
        finally:
            self.lock.release()

    def close(self):
        self.closed = True
        self.session.close()
