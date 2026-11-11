# WeCom causal context lifecycle — local rc.2

Base rc.1 `8080be8bdc0bfec44a72dd25a2d7ff8fdf1630f4`; keep its commit/tag/evidence unchanged. This stage addresses the root review's confirmed in-memory accumulation of leases/challenges. Still no production, remote, Windows, ADB or phone action.

## Minimal correction

- Default finite quota1024 **per purpose** (factory accepts1..10000, no new environment/config setting). Mark reserves its own business/verification quota before creation; full quota throws fixed503 before sampling. Separate quota keeps space for an original pending business's verification. No LRU, wall-based deletion, eviction, new generation or authority renewal.
- Unconsumed mark is explicitly released in a `finally` covering create-job/acquire-lock/queue/bind and persistence/return. Only the **unapplied** revised shared hook proposes that wrapper. A consumed/bound mark cannot be released by this cleanup; unknown bound creation remains counted, and future creation gets backpressure.
- After the original proof transaction is known persisted, its duty released and no physical duty remains for the device/serial, the service retires the exact original verification and business contexts. Pending/throwing persistence never reaches retirement. Changed/archived scope cannot be reconstructed for cleanup; retain its bounded slot.
- Exact lost-ACK proof replay still replies from saved original proof, including after epoch loss, without recreating live tickets. Dedicated phone authority never resumes from that ACK.
- Active ID membership uses a bounded Set instead of scanning historical challenges. A bounded safe integer sequence suffix prevents retired-ID reuse even with a repeated random source; exhaustion denies instead of wrapping. There is no growing ID tombstone collection.

## Actual verification

```sh
/opt/homebrew/bin/node --test --test-reporter=spec windows-agent/src/wecom-*.test.mjs server/wecom-causal-*.test.mjs server/wecom-physical-cleanup.test.mjs server/wecom-preview.test.mjs
```

`NODE_REGRESSIONS.txt`:148 collected Node tests pass. Earlier147/76 subset runs retained, not additive. The nine new cases cover full quota before sampling/no overwrite, separate verification quota, repeated pre-bind failures reclaim marks,1000 repeated exact retirement cycles, bound unknown creation at finite capacity, repeated-ID nonrevival, known proof retirement plus exact lost ACK/restart ACK, pending/unknown persistence retention, another pending duty retention, and100 normal service lifecycle iterations (some checks share a test case). No new failure output in this stage. rc.1 Python486 executions remain prior evidence; Python code is unchanged and was not rerun here.

The revised proposed shared server bytes pass syntax-only parse. Actual shared files remain unchanged at `INDEX_SOURCES.json` hashes. Full staged diff check may flag mandatory unified-diff blank-context spaces; exact artifact hash/line exceptions are recorded separately, without trimming patch bytes or claiming a full green.

## Limits / next gate

Bound unknown creation, known terminal records whose safe retirement has not been integrated, archived/drifted scope or a proof completed while another duty remains may retain finite slots indefinitely and cause conservative503 backpressure. They are not silently dropped to regain availability. This stage does not invent a new known-terminal persistence receipt or generic recovery transaction. Failed unbound marks require the proposed full creation-finally hook, which is not applied yet.

Root still must review/apply shared hooks and run authenticated HTTP/persistence/control regressions. Parent-side independent OS/token and actual socket bridge, Windows startup/network inside3s and main/clone native acceptance remain unverified; strict3s is unchanged. No invitation sent, no old43 duty migrated/released, no shared SDK, screen/media or SYSTEM ADB identity change. Production stays the rollback point; never load these leaves alone or clear duties as rollback.
