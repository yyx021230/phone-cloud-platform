# WeCom v1 causal timing — local leaf candidate

Base `0c7ded6541d3fc2d386e4d19a14510a34e837169`, branch `codex/wecom-v1-causal-fix-20261103`. Last root-observed production source: `32c0091a534aa7f9038deb91aa33f202f72e0e6b`. No production, remote, Windows, ADB or phone action occurred here. Do not load the leaves alone.

## Scope and wire

Protocol `wecom-causal-v1` preserves the original v1 ten-field binding. A private 48-hex pipe nonce and original binding nonce associate ready/registration/close with the actual Node child PID and original reported OS birth token. Python retains its actual SYSTEM/runtime checks. Known durable host ACK precedes UI configuration; actual close precedes host-closed/proof. Independent parent OS/token and actual socket-peer bridge remain unintegrated; this candidate does not claim complete execution identity proof.

Cloud holds original creation-time monotonic business300s/verification120s contexts. Reply ticket is exactly `{protocol,epoch,leaseId,purpose}`. Python consumes full HTTP RTT and never extends its earliest local deadline. Missing epoch cannot reconstruct authority from audit UTC. Parent230s/child210s budgets remain. Unknown persistence keeps existing physical/checkpoint/committing fences.

Each verification has one `{protocol,epoch,verificationLeaseId,challengeId}` challenge; retries never reset age. Cloud checks issue→authorization ≤3s inside the per-device gate, after complete proof validation and immediately before the first release candidate. Network, decoding, queueing and actual child close count. Existing transaction/fence remains until known persistence; asynchronous database commit is not advertised as interruptible within3s. Double frames require exact scope, seq1/2 and increasing elapsedMs≤3000. UTC is audit only. Original43 and other unresolved obligations are neither migrated nor invented/released.

`INDEX_HOOKS.patch.txt` is an **unapplied proposal** against hashes in `INDEX_SOURCES.json`: original creation mark, capability `wecomCausalProtocol=wecom-causal-v1`, lease fields/challenge route, pickup and dedicated monotonic expiry. Both index files remain unchanged. Proposed server bytes passed syntax-only parsing, without imports or service startup. Root must review/integrate and test these shared hooks.

## Actual commands and results

From repository root:

```sh
/opt/homebrew/bin/node --test --test-reporter=spec windows-agent/src/wecom-*.test.mjs server/wecom-causal-*.test.mjs server/wecom-physical-cleanup.test.mjs server/wecom-preview.test.mjs
python3 -m unittest discover -s windows-agent/scripts -p 'test_wecom*.py'
/opt/homebrew/bin/npm run check
```

- `NODE_REGRESSIONS_FIRST.txt`:139 collected tests passed. Includes earlier57 and migrated56 subsets; counts are not additive.
- `PYTHON_REGRESSIONS_FINAL.txt`:486 collected unittest executions passed. Discovery imports some classes again;486 is not unique scenarios or phones.
- `ROOT_CHECK.txt`:root syntax check passed; differs from Agent package full check.
- New actual local subprocess tests cover bootstrap before business input, ACK gating, wrong PID/private nonce, cancellation, close, early exit and exhausted ACKs. A real loopback HTTP fixture fsyncs a synthetic registration receipt, drops first ACK, then verifies exact-body retry before UI input. A real verify child delayed >3s cannot submit proof. This handler is not production auth/repositories.
- Clock/service tests cover ±300ms/±5min audit offsets, fixed original budgets, exact3s/+1ns or +1ms, queue delay, pending/failed storage, epoch loss, legacy duty rejection, original context/content drift, and no expired verification renewal. Service persistence is injected; no actual PG or original JSON store was exercised.
- Immutable `verification/wecom-cleanup-v1/fixtures.json` stays unchanged. Tests derive new envelopes. Agent historical ID casing remains; new formal creation still follows existing strict previewTarget mapping.

## Failures retained

`LEGACY_VERIFY_NODE_RED.txt`, `LEGACY_VERIFY_PY_RED.txt`, `LEGACY_REGRESSIONS_RED.txt` preserve old-wire failures; original input copies are retained. Old pending contexts fail closed, with no old-wire fallback.

`VERIFY_NODE_FIXTURE_SHADOW_RED.txt`/source preserve an adaptation counter shadowing the proof fixture; corrected to proofPosts, separate final8/8 retained. `PYTHON_REGRESSIONS_FIRST.txt` records two collected failures from a lease fixture missing causal authority. Its first adaptation referenced a function-local class as a module attribute; original error/source are in `PYTHON_FIXTURE_IMPORT_RED.txt`/source. Correct contract import yields final486 pass. A temporary hook-generator ambiguous-range assertion stopped before writing shared/proposal files; the final unique-range proposal parses. A manifest attempt referenced an absent historical poco_forward_owner.py path and stopped before writing; that file is not claimed as a current dependency.

## Remaining / rollback

Shared hooks are unapplied. Authenticated full HTTP integration, original JSON persistence/restart pipeline, PG, full repository regression and Agent full check are unverified. Existing server HTTP/E2E fixtures still target old capability/wire and need root-coordinated adaptation after hook integration. No new screen regression execution; shared/control files match base, and root must run control regression upon shared integration.

Windows SYSTEM/actual socket bridge, Windows startup/network under3s, SDK, fresh occupancy and main/clone phone traversal remain unverified. No invitation was sent. External customer-invitations POST sends and must not be used for this no-send acceptance; use internal preview only after identity/exclusivity readiness.

Production remains the rollback point. Revert only this scoped candidate in a separate checkout if needed, never clear physical obligations/data. Loading/maintenance follows existing authorization, D-075 and frozen SYSTEM ADB identity. Do not treat this candidate tag as a deployed version.

Original diagnostic whitespace and mandatory patch blank-context spaces are preserved. Full staged diff check is red (`DIFF_CHECK_RAW_RED.txt`); only exact file/hash/line exceptions in `WHITESPACE_EXCEPTIONS.json` are accepted. Scoped check excluding these five exact artifacts passes; this is not a full diff-check green claim.
