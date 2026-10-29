"""Exact optional Home dialogs. OCR labels are proof, never tap targets."""
import math
import re


def optional_home_modal(rows, size, close):
    w, h = size
    if w <= 0 or h <= 0 or not close:
        return None
    cx, cy = close
    if not (abs(cx - w / 2) < w * .045 and h * .68 <= cy <= h * .88):
        return None
    entries = []
    for box, text, score in rows:
        try:
            coords = [float(v) for point in box for v in point]
            if not all(math.isfinite(v) for v in coords) or not .93 <= float(score) <= 1:
                continue
            xs, ys = coords[::2], coords[1::2]
            if not (0 <= min(xs) < max(xs) <= w and 0 <= min(ys) < max(ys) <= h):
                continue
            entries.append((re.sub(r'\s+', '', text), (min(xs)+max(xs))/2, (min(ys)+max(ys))/2))
        except (TypeError, ValueError, IndexError):
            continue
    text = ''.join(e[0] for e in entries)
    if any(v in text for v in ('拼图', '滑动验证', '安全验证', '访问被拒绝', '操作频繁', '请输入验证码', '登录支付宝')):
        return None
    variants = [
        ('coupon', '通用和闪购券包', ('网上购物、闪购外卖可用',), '点击领取'),
        ('coupon', '20元通用和闪购券包', ('网上购物、外卖到店都能用',), '去领取'),
        ('real_name', '仅需两步完成实名认证', ('信息填写', '身份认证'), '下一步'),
    ]
    def one(label):
        matches = [e for e in entries if e[0] == label]
        return matches[0] if len(matches) == 1 else None
    for kind, title, hints, action in variants:
        t, a = one(title), one(action)
        hs = [one(hint) for hint in hints]
        if not t or not a or not all(hs):
            continue
        if not (abs(t[1]-w/2) < w*.10 and abs(a[1]-w/2) < w*.10
                and h*.30 <= t[2] <= h*.55 and h*.55 <= a[2] <= h*.76
                and h*.10 <= a[2]-t[2] <= h*.35 and h*.06 <= cy-a[2] <= h*.22
                and all(t[2] < e[2] < a[2] and w*.15 < e[1] < w*.85 for e in hs)):
            continue
        return kind
    return None
