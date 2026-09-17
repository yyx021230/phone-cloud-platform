#!/usr/bin/env sh
set -eu

# D-075: the stock installer would silently remove native viewer pacing.
# No override flag: both fresh installation and replacement require the
# separately reviewed custom build / deployment and an approved media window.
printf '%s\n' 'BLOCKED: stock MediaMTX installation would violate the D-075 production baseline.' >&2
printf '%s\n' 'Use deploy/mediamtx-pacing/build.mjs and the D-075 runbook. Preserve 8Mbps / 2-packet pacing; obtain approval before replacing or restarting media.' >&2
exit 2
