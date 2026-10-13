import hashlib
import hmac
import json
import unittest
from urllib.error import URLError

from .python_client import OpenNameLookupClient


class FakeResponse:
    def __init__(self, payload):
        self.payload = payload

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return False

    def read(self):
        return json.dumps(self.payload).encode("utf-8")


class ClientTest(unittest.TestCase):
    def test_managed_phone_only_retry_preserves_key_with_new_nonce(self):
        requests = []
        def opener(request, timeout):
            requests.append((request, timeout))
            if len(requests) == 1:
                from urllib.error import URLError
                raise URLError("synthetic connection reset")
            return FakeResponse({"ok": True, "name": "test*"})
        client = OpenNameLookupClient(base_url="http://127.0.0.1:1", client_id="fixture", secret="s" * 32, opener=opener)
        result = client.lookup_name("13800000000", idempotency_key="fixture-request-1")
        self.assertEqual(result["name"], "test*")
        self.assertEqual(json.loads(requests[0][0].data), {"phoneNumber": "13800000000"})
        headers = [{key.lower(): value for key, value in request.header_items()} for request, _ in requests]
        self.assertEqual(headers[0]["idempotency-key"], headers[1]["idempotency-key"])
        self.assertNotEqual(headers[0]["x-nonce"], headers[1]["x-nonce"])
        self.assertEqual(requests[0][1], 190)

    def test_signs_transmitted_body_and_preserves_batch_order(self):
        requests = []
        secret = "s" * 32

        def opener(request, timeout):
            requests.append((request, timeout))
            return FakeResponse({"queryId": f"query-{len(requests)}"})

        client = OpenNameLookupClient(
            base_url="https://phone.example.test/", client_id="partner-a",
            secret=secret, opener=opener
        )
        accepted = client.enqueue_many("session-1", [
            {"phoneNumber": "13800000000", "clientReference": "order-000001", "consentReference": "consent-000001"},
            {"phoneNumber": "13900000000", "clientReference": "order-000002", "consentReference": "consent-000002"},
        ])
        self.assertEqual([item["queryId"] for item in accepted], ["query-1", "query-2"])
        self.assertEqual(
            [json.loads(request.data)["clientReference"] for request, _ in requests],
            ["order-000001", "order-000002"]
        )
        request, timeout = requests[0]
        self.assertEqual(timeout, 30)
        headers = {key.lower(): value for key, value in request.header_items()}
        body_hash = hashlib.sha256(request.data).hexdigest()
        canonical = "\n".join((
            "POST", "/api/v1/open/name-lookups/sessions/session-1/queries",
            headers["x-timestamp"], headers["x-nonce"], body_hash
        )).encode("utf-8")
        expected = hmac.new(secret.encode("utf-8"), canonical, hashlib.sha256).hexdigest()
        self.assertEqual(headers["x-signature"], expected)
        self.assertTrue(headers["idempotency-key"])


    def test_async_submit_retry_and_readonly_get(self):
        requests = []
        def opener(request, timeout):
            requests.append((request, timeout))
            if len(requests) == 1:
                raise URLError("response lost")
            return FakeResponse({"ok": True, "lookupId": "id-one", "status": "processing"})
        client = OpenNameLookupClient(base_url="http://127.0.0.1:1", client_id="fixture", secret="s" * 32, opener=opener)
        self.assertEqual(client.submit_lookup("13800000001", idempotency_key="saved-key-0001")["lookupId"], "id-one")
        headers = [dict((k.lower(), v) for k, v in r.header_items()) for r, _ in requests]
        self.assertEqual(headers[0]["idempotency-key"], headers[1]["idempotency-key"])
        self.assertNotEqual(headers[0]["x-nonce"], headers[1]["x-nonce"])
        client.get_lookup_result("id/one")
        self.assertEqual(requests[-1][0].get_method(), "GET")
        self.assertTrue(requests[-1][0].full_url.endswith("/tasks/id%2Fone"))
        self.assertIsNone(requests[-1][0].data)

if __name__ == "__main__":
    unittest.main()
