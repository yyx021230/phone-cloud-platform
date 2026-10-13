import hashlib
import hmac
import json
import unittest

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


if __name__ == "__main__":
    unittest.main()
