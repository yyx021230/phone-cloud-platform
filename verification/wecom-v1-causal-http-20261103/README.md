# WeCom causal v1 — integrated local HTTP candidate

Branch `codex/wecom-v1-causal-http-20261103`, base `3caba67de5762213ca374afa87760fddadbeca53` (immutable causal rc.2). This candidate applies the root-approved shared hook `81e3afc1e34f4d1d7fca17d11b72a08ed001c31306cae56960d382390a3e0d08` plus the separately approved narrow startup guards. No production, remote push, Windows, ADB, USB, media or real phone operations occurred. No real invitation was sent.

## Changes and actual fault

The approved creation/pickup/lease/challenge/capability/expiry hooks are now applied locally. The Agent entry changes only one WeCom task-poll query parameter. Screen/control, shared ADB lifecycle, identities/keys and shared SDK code stay byte-identical to base. Full screen and Agent regressions below passed; they do not prove production/native behavior.

Actual restored JSON exposed a startup bug: `logStartupDiagnostics` runs before `wecomCleanup` is constructed. Calling its new method crashed startup with unfinished tasks. The approved guards preserve only causal WeCom tasks and correctly linked causal business locks during this initialization interval, instead of invoking null or falling back to audit UTC. Other tasks and legacy/unrelated locks retain ordinary expiry. After initialization, unknown old epochs cannot grant execution. A real JSON restart case covers both running/queued causal records with expired audit lock timestamps, legacy and unrelated expiry, no new host/verification, and no replay.

The clock's fixed context rejection now has HTTP409 rather than generic500; capacity remains503. Neither condition clears a duty, refreshes a challenge or authorizes work.

Old helper and immutable legacy synthetic worker remain unchanged. New `server/wecom-causal-fixture.mjs` and this directory's `simulated_worker.py` adapt fake UI/resources to private bootstrap, original ticket, one challenge and sequential elapsed frames. Existing API tests now negotiate the new capability; old capability remains an explicit negative. The prior physical cleanup HTTP test is preserved under `legacy-inputs/`; it assumed restart could issue fresh verification after archived evidence. New cases split same-epoch completion from restart/unknown-epoch isolation. This stage's replacement fixture explicitly supports JSON only; no PG opt-in acceptance is claimed.

## Actual commands and results

`run_local.py` rejects a real `.env`, allowlists only path/home/system/temp environment values, clears DB/Redis, excludes credentials and model-upstream variables, assigns owned temporary storage, and invokes fixed local commands. HTTP child services explicitly bind loopback ephemeral ports and use synthetic credentials/data. Final runs record536 source hashes before/after with no drift. HOME is passed through unchanged; no authorization keys are read/copied/modified by this work.

|Launcher target / final record|Actual command|Result|
|---|---|---|
|screen / SCREEN_FINAL|`/opt/homebrew/bin/npm run test:screen`|2252/2252 passed|
|agent / AGENT_FINAL|`/opt/homebrew/bin/npm run check --prefix windows-agent`|675/675 passed|
|http / HTTP_FINAL|Node test runner, concurrency1, four WeCom HTTP/E2E files (full argv in JSON)|16/16 passed|
|python / PYTHON_FINAL|`python3 -m unittest discover -s windows-agent/scripts -p 'test_wecom*.py'`|486 collected executions passed; imports duplicate some classes|
|sdk / SDK_FINAL|`/opt/homebrew/bin/node --test examples/wecom-integration/client.test.mjs`|4/4 passed|
|check / ROOT_CHECK_FINAL|`/opt/homebrew/bin/npm run check`|syntax check passed|

These runs overlap and must not be summed. Root syntax check and Agent full check differ. Exact commands, sanitized environment keys, exit status, timestamps and source maps are in each corresponding JSON file. The current HTTP target is included in the final2252 as well.

Authenticated real HTTP/JSON cases cover old capability rejection, main/clone, wrong binding/scope, no generic verification success, actual host/proof reply loss with same original IDs, original proof ACK after restart, real filesystem write failure/rollback, no unknown-epoch renewal, original persisted main/clone send claims with no worker replay, strict3.1s challenge rejection, and unrelated phone dispatch. The E2E uses actual Node/Python pipes and the actual remark/invitation algorithms against fake Poco pages: four synthetic searches/saves, three synthetic send clicks, **zero real phones/invitations**. External client uses only the documented three endpoints, with six simultaneous identical submissions, lost accepted response, unknown claim response and restart deduplication.

## Red evidence and fixture changes

First HTTP/Agent runs failed because this checkout lacked pg/@yume/ws dependencies. `npm ci --ignore-scripts --no-audit --no-fund` at root and Agent installed exactly the lockfiles; both locks remain unchanged. Raw initial logs retained. After dependencies, `HTTP_PROTOCOL_RED` captured old capability/wire failures before adapting fixtures.

`HTTP_ADAPTED_FIRST` retained old physical-test/restart failures. `HTTP_ADAPTED_SECOND` retained a test-only POST-instead-of-GET lease error405, two real null-service restart failures and real context500; original source snapshots retained before correction. `HTTP_STARTUP_FIXED` passed15 before the extra full startup case; final16 is separate. Early runs predate source-map capture in the launcher and are not represented as complete before/after source proofs.

`SCREEN_FIRST` ran2252 with2251 pass/one old VM fixture failure: it omitted the new startup globals (`wecomCleanup`, `WECOM_PREVIEW_KIND`). Only that test context now declares the actual startup null instance/constant; product guards were not relaxed. Targeted case and full `SCREEN_FINAL` pass. All initial/failed/subset outputs remain, without aggregating their counts.

Verbatim diagnostic and unified-diff whitespace is preserved. Exact staged artifact hash/line exceptions are recorded in `DIFF_CHECK.json`; full check red versus scoped code/artifact check green is distinguished, not hidden or normalized away.

## Limits, rollback and next gate

This is a local integrated candidate, not a deployed version. Native Windows SYSTEM/actual socket-peer binding, Windows initialization/network within strict3s, SDK against real devices, fresh occupancy and main/clone phone acceptance remain unverified. Neither local simulations nor full regression replace those checks. No actual PG, production D-075 live host verification, real media/control interruption or Agent reload occurred. Public sending POST is never a real no-send preview endpoint.

Keep production unchanged until reviewed loading/maintenance authorization. Root must review/import only the fixed scoped commit, then coordinate runtime identity, fresh complete occupancy and per-device internal preview to the pre-send boundary. Do not bypass original43 or other unresolved duties, lookup reservations or runtime owners. Revert only the candidate code to base in an isolated checkout before loading; never clear physical obligations or phone data as rollback. Existing conservative finite-context backpressure limits in rc.2 still apply.
