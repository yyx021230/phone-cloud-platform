"""Local OS observation only. No characterized authority or production grants."""
import json
import sys
import time

if sys.argv[1:] != ['--observe-only']:
    raise SystemExit('observe_only_required')
result = {'scope': 'local-os-observation-only', 'platform': sys.platform,
          'authoritySupported': False, 'nativeExecutionPermitted': False}
if sys.platform == 'linux' and all(hasattr(time, name) for name in (
        'CLOCK_BOOTTIME', 'CLOCK_MONOTONIC', 'CLOCK_REALTIME', 'clock_gettime_ns')):
    # Resolution is recorded as a nominal API property, NEVER an error/rate or
    # hypervisor-pause bound. This one-shot child cannot establish continuity.
    wall_before = time.clock_gettime_ns(time.CLOCK_REALTIME)
    boot_before = time.clock_gettime_ns(time.CLOCK_BOOTTIME)
    work = time.clock_gettime_ns(time.CLOCK_MONOTONIC)
    boot_after = time.clock_gettime_ns(time.CLOCK_BOOTTIME)
    wall_after = time.clock_gettime_ns(time.CLOCK_REALTIME)
    result.update(reason='uncharacterized_bounds_and_hypervisor', observationsNs={
        'wallBefore': str(wall_before), 'bootBefore': str(boot_before),
        'work': str(work), 'bootAfter': str(boot_after), 'wallAfter': str(wall_after)})
else:
    result['reason'] = 'unsupported_os_or_paired_clock_api'
print(json.dumps(result))
