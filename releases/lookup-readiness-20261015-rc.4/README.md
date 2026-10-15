# Read-only lookup transport patch rc.4

Runtime commit 66e1faf, based on production deployed.3 and Windows rc.2 overlay. Two Python files only; no cloud, Node, ADB, media, schema or dependency changes.

130: observed transient device-not-found and a separate empty screenshot causing OpenCV assertion. Retry exact focus/screenshot reads once within original timeout budget. Persistent failure remains an explicit unconfirmed result, never empty name. Never repeat a tap, input, account action or app launch. Underlying intermittent USB cause remains unconfirmed.

155: historical pre-input RPC timeout was followed by the designed restart/reattach stages. A new worker exited after screen_size response but before workerReady. Truncated historical stderr cannot prove its complete underlying cause. Add one same-service read-only bootstrap retry for transient transport errors and explicit diagnostics; no new instrumentation or business payload replay. Do not claim all historical exit causes fixed.

Validation: old ten cases had four failures/two errors; new 10/10, Python 363/363, runners 163/163, Node screen suite 741/741, native Windows 10/10. Native staging only, no live files replaced yet.

Deployment: verify production hashes, D-075 live, target idleness and backup; preserve ACL and existing visual-result overlay. Only refresh idle lookup workers on 130/155, never shared Agent/ADB/USB/media or other devices. Rollback these two files and target idle workers, retaining all request/result/cooldown data. Real post-patch acceptance pending.

Source commit/tag precedes metadata: initial metadata generation failed due encoding; metadata prepared separately without moving the immutable rc.4 tag.
