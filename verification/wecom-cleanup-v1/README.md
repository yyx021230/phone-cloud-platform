# WeCom physical-cleanup v1 local cross-component fixture

`agent-http-pipe.mjs` tests an isolated platform HTTP server and the supplied
Agent source. It extracts the actual Agent functions into a VM; it does not
start the Agent bootstrap, registration, scanning or any production service.
Python child processes use real OS pipes/PIDs/birth tokens, with **synthetic
machine identity and package/forward facts**. No phone, ADB or invitation action
is performed. Passing is not Windows SYSTEM, native-phone or production acceptance.

Requirements: Node matching the project engine, Python 3 with `psutil`, and the
existing server dependencies available in the isolated source tree. Missing
Python dependencies fail explicitly. `WECOM_TEST_PYTHON` may select a local test
interpreter; it does not change a production identity or entry point.

Pass absolute paths to an exported server tree, Agent tree and new private
evidence folder. The two source roots may be the same reviewed combination tree.
Do not use production data or a server tree containing `.env`; the fixture
rejects `.env`, supplies an explicit local environment, generates credentials
only in memory, and binds its server to loopback on an ephemeral port.

```sh
node verification/wecom-cleanup-v1/agent-http-pipe.mjs \
  /absolute/isolated/server-source /absolute/isolated/agent-source \
  /absolute/private/evidence proof-ack-once
```

Run each mode with a separate evidence folder:

| Mode | Injected fault |
| --- | --- |
| `proof-ack-once` | First proof reply lost after server commit |
| `host-network-and-close-ack` | First host request not delivered; first host-close reply lost; first proof reply lost |
| `proof-ack-always` | Both proof replies lost after server commit |

Each case asserts device discovery → submit → result, original failed result
retention, same-device blocking, real isolated JSON-server restart, automatic
verification dispatch, top-level pickup timestamp, verification proof after real
child close, exact request retry, and a new task accepted only after committed
proof. Verification cannot use generic success/failure downgrade, evidence
capture or device scanning. Two lost proof replies leave the Agent pending while
the committed server verification remains successful.

Only `sanitized-receipt.json` / `sanitized-failure.json` are release evidence.
Private server logs and generated data stay outside Git. The test stops only
its own server; its stop waits are bounded. This runner does not cover PostgreSQL
transaction failure, actual SYSTEM guards, native package observation, phone
navigation, invitation delivery, or automatic recovery of missing host metadata.
