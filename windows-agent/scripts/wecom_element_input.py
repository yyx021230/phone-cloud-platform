"""Element-derived taps for opted-in WeCom device profiles.

The existing driver resolves and rechecks the live element first. This adapter
changes only its click transport; it has no server lifecycle or retry operation.
"""
import math
import re
from wecom_invite_preview import StopPreview


def tap_command(x, y, wm_size, poco_size):
    if (type(x) not in (int, float) or type(y) not in (int, float)
            or not math.isfinite(x) or not math.isfinite(y)
            or not 0 < x < 1 or not 0 < y < 1):
        raise StopPreview('wecom_element_geometry_unconfirmed')
    rows = [line.strip() for line in wm_size.splitlines() if line.strip()]
    sizes = {}
    for line in rows:
        match = re.fullmatch(r'(Physical|Override) size: (\d+)x(\d+)', line)
        if not match or match[1] in sizes:
            raise StopPreview('wecom_element_display_unconfirmed')
        sizes[match[1]] = tuple(map(int, match.group(2, 3)))
    if 'Physical' not in sizes:
        raise StopPreview('wecom_element_display_unconfirmed')
    size = sizes.get('Override', sizes['Physical'])
    if (not isinstance(poco_size, (list, tuple)) or len(poco_size) != 2
            or any(type(v) is not int for v in poco_size)
            or tuple(poco_size) != size or not all(100 <= v <= 8192 for v in size)):
        raise StopPreview('wecom_element_display_unconfirmed')
    return 'input tap %d %d' % (int(x * size[0]), int(y * size[1]))


class ElementAdbInput:
    def __init__(self, original, *, authorize, shell, screen_size, tap):
        if not all(callable(v) for v in (authorize, shell, screen_size, tap)):
            raise ValueError('invalid_element_input_callbacks')
        self.original = original
        self.authorize, self.shell = authorize, shell
        self.screen_size, self.tap = screen_size, tap

    def __getattr__(self, name):
        return getattr(self.original, name)

    def click(self, x, y):
        if self.authorize() is not True:
            raise StopPreview('device_lease_lost')
        command = tap_command(x, y, self.shell('wm size'), self.screen_size())
        if self.authorize() is not True:
            raise StopPreview('device_lease_lost')
        # Unknown delivery is never repeated, including a rejected response.
        response = self.tap(command)
        if not isinstance(response, str) or response.strip():
            raise StopPreview('wecom_element_tap_delivery_unknown')
        return True
