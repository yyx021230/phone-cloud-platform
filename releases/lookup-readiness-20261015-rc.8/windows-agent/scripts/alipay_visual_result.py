"""Local, read-only OCR for a result card hidden from accessibility.

Callers supply screenshot bytes. Windows inference runs in a private OCR process;
no device control or HTTP requests are performed here.
Nothing guesses a character, a phone digit, or a missing result.
"""
import math
import re

_ENGINE = None
_NAME = re.compile(r"[\(（]\*+(?:·\*+)*([^\(\)（）\s])[\)）]$")
_SIMPLE_NAME = re.compile(r"^\*+([\u4e00-\u9fff])$")
_EMAIL_PHONE = re.compile(
    r"[A-Za-z0-9._%+*\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}"
    r"[\(（](1\d{10})[\)）]"
)
_PROTECTED = ("安全验证", "请完成下方验证", "拖动滑块", "滑动验证", "操作频繁", "访问异常",
              "访问被拒绝", "设备可能存在风险", "检查或切换设备", "请输入验证码", "您请求次数过于频繁")


def recognize(raw, timeout=10):
    from lookup_ocr_runtime import interpreter, recognize_isolated
    executable = interpreter()
    if executable:
        return recognize_isolated(raw, executable, timeout)
    return _recognize_local(raw)


def _prepare_local():
    global _ENGINE
    import cv2
    import numpy as np
    from rapidocr_onnxruntime import RapidOCR
    if _ENGINE is None:
        # Model files are packaged by the pinned wheel; tasks never download
        # models or send screenshots to a service. Keep CPU use per worker low.
        _ENGINE = RapidOCR(intra_op_num_threads=1, inter_op_num_threads=1)
    return cv2, np


def _recognize_local(raw):
    cv2, np = _prepare_local()
    image = cv2.imdecode(np.frombuffer(raw, dtype=np.uint8), cv2.IMREAD_COLOR)
    if image is None or image.shape[0] * image.shape[1] > 8_000_000:
        raise ValueError("invalid_screenshot")
    rows, _ = _ENGINE(image, return_word_box=True)
    return _result_rows(rows or []), (image.shape[1], image.shape[0])


def _result_rows(rows):
    """For an inline email/phone row, score the phone's weakest digit.

    RapidOCR's pinned word-box result includes aligned character confidences.
    Email punctuation must not lower a certain phone, and a high row average
    must not hide an uncertain digit. All other row scores remain unchanged.
    """
    result = []
    for row in rows:
        box, text, score = row[:3]
        compact = re.sub(r"\s+", "", str(text or ""))
        match = _EMAIL_PHONE.fullmatch(compact)
        if match:
            verified_score = 0
            try:
                if (len(row) == 6 and .96 <= float(score) <= 1
                        and "".join(row[4]) == text and len(row[4]) == len(row[5])
                        and all(isinstance(c, str) and len(c) == 1 for c in row[4])):
                    confidences = [float(s) for c, s in zip(row[4], row[5]) if not c.isspace()]
                    digits = confidences[match.start(1):match.end(1)]
                    if len(digits) == 11 and all(math.isfinite(s) and 0 <= s <= 1 for s in digits):
                        verified_score = min(digits)
            except (TypeError, ValueError):
                pass  # Missing/misaligned evidence cannot promote this row.
            score = verified_score
        result.append((box, text, score))
    return result


def _entries(rows, size):
    width, height = size
    if width <= 0 or height <= 0:
        raise ValueError("invalid_size")
    entries = []
    for box, raw_text, raw_score in rows:
        text = re.sub(r"\s+", "", str(raw_text or ""))
        score = float(raw_score)
        points = [(float(p[0]), float(p[1])) for p in box]
        if not text or len(points) != 4 or not math.isfinite(score):
            continue
        if any(not math.isfinite(x) or not math.isfinite(y) or not (0 <= x <= width and 0 <= y <= height)
               for x, y in points):
            continue
        x = sum(p[0] for p in points) / (4 * width)
        y = sum(p[1] for p in points) / (4 * height)
        entries.append((text, score, x, y))
    return entries


def protection(rows, size):
    entries = _entries(rows, size)
    texts = [t for t, confidence, _, _ in entries if confidence >= .90]
    if (any(t in {"安全验证", "请完成下方验证"} for t in texts)
            and any("拼图" in t or "拖动滑块" in t for t in texts)):
        return "human"
    if any(token in t for t in texts for token in _PROTECTED):
        return "protected"
    return ""


def search_rate_limit(rows, phone, size):
    """Exact rate-limit card for this submitted input, never a refresh action."""
    if not re.fullmatch(r"1\d{10}", str(phone)):
        return None
    entries = _entries(rows, size)
    if any(token in text for text, confidence, _, _ in entries if confidence >= .90
           for token in _PROTECTED if token != "您请求次数过于频繁"):
        return None
    inputs = [e for e in entries if re.fullmatch(r"1\d{10}", e[0]) and e[3] < .14 and e[1] >= .98]
    if len(inputs) != 1 or inputs[0][0] != phone:
        return None
    markers = []
    for label in ("您请求次数过于频繁", "待会来试试", "刷新"):
        matches = [e for e in entries if e[0] == label and e[1] >= .96
                   and .25 < e[2] < .75 and .20 < e[3] < .46]
        if len(matches) != 1:
            return None
        markers.append(matches[0])
    if not all(0 < b[3] - a[3] < .10 and abs(b[2] - a[2]) < .12
               for a, b in zip(markers, markers[1:])):
        return None
    return {"reason": "frequent_or_abnormal_access",
            "title": "您请求次数过于频繁", "hint": "待会来试试"}


def search_loading(rows, phone, size):
    """Positive loading evidence for this exact input, never a result."""
    if not re.fullmatch(r"1\d{10}", str(phone)) or protection(rows, size):
        return False
    entries = _entries(rows, size)
    inputs = [e for e in entries if re.fullmatch(r"1\d{10}", e[0]) and e[3] < .14 and e[1] >= .98]
    return (len(inputs) == 1 and inputs[0][0] == phone
            # Animated dots lower the whole OCR row score. This marker only
            # permits bounded waiting; all name/phone result thresholds remain.
            and any(((t == "搜索中" and c >= .96)
                     or (re.fullmatch(r"搜索中[.·•…]{1,3}", t) and c >= .85))
                    and .20 < x < .80 and .10 < y < .25
                    for t, c, x, y in entries))


def search_network_busy(rows, phone, size):
    """Recognize the search error card; this never authorizes a refresh."""
    if not re.fullmatch(r"1\d{10}", str(phone)) or protection(rows, size):
        return False
    entries = _entries(rows, size)
    inputs = [e for e in entries if re.fullmatch(r"1\d{10}", e[0]) and e[3] < .14 and e[1] >= .98]
    if len(inputs) != 1 or inputs[0][0] != phone:
        return False
    markers = []
    for label in ("网络有点忙", "刷新试试", "刷新"):
        matches = [e for e in entries if e[0] == label and e[1] >= .96
                   and .20 < e[2] < .80 and .20 < e[3] < .45]
        if len(matches) != 1:
            return False
        markers.append(matches[0])
    return all(0 < b[3] - a[3] < .12 and abs(b[2] - a[2]) < .15
               for a, b in zip(markers, markers[1:]))


def _exact_card_phone(text):
    if re.fullmatch(r"1\d{10}", text):
        return text
    # Some result cards put the phone after an email account in one OCR row.
    # Match that complete structure, never a number inside an arbitrary label.
    match = _EMAIL_PHONE.fullmatch(text)
    return match[1] if match else ""


def parse_rows(rows, phone, size):
    """Require one high-confidence name/phone/two-action card, not input text."""
    if not re.fullmatch(r"1\d{10}", str(phone)) or protection(rows, size):
        return None
    entries = _entries(rows, size)
    top_inputs = [e for e in entries if re.fullmatch(r"1\d{10}", e[0]) and e[3] < .14 and e[1] >= .98]
    if len(top_inputs) != 1 or top_inputs[0][0] != phone:
        return None
    phones = [e for e in entries if e[1] >= .98 and _exact_card_phone(e[0]) == phone]
    names = []
    for entry in entries:
        text, confidence, _, _ = entry
        match = _NAME.search(text) or _SIMPLE_NAME.fullmatch(text)
        unverified = re.fullmatch(r"(\d{3})\*+(\d{2})[\(（]未实名[\)）]", text)
        if confidence >= .96 and ((match and match[1].isalpha())
                                 or (unverified and phone.startswith(unverified[1]) and phone.endswith(unverified[2]))):
            names.append((entry, match[1] if match else "", bool(unverified)))
    candidates = []
    for (display, _, name_x, name_y), tail, unverified in names:
        for _, _, phone_x, phone_y in phones:
            if not (0 < phone_y - name_y < .10 and abs(phone_x - name_x) < .20):
                continue
            actions = [e for e in entries if e[0] in {"转账", "加好友"} and e[1] >= .96
                       and 0 < e[3] - phone_y < .12]
            friend = [e for e in actions if e[0] == "加好友"]
            if len(friend) != 1:
                continue
            # Lower search recommendations can repeat "转账" beneath a
            # complete card. Only the card's action row can pair with its
            # unique friend button. Earlier/same-row duplicates stay ambiguous.
            transfer = [e for e in actions if e[0] == "转账"
                        and e[3] < friend[0][3] + .025]
            if len(transfer) != 1:
                continue
            if not (transfer[0][2] < friend[0][2] and abs(transfer[0][3] - friend[0][3]) < .025):
                continue
            candidates.append({"alipayDisplayName": display, "realNameTailCharacter": tail,
                               "matchedPhone": phone, "notFound": unverified,
                               "message": "account_not_real_named" if unverified else "",
                               "matchMethod": "visual_ocr_exact_phone_actions_two_frames"})
    # Even identical duplicate result cards are ambiguous, not extra votes.
    return candidates[0] if len(candidates) == 1 else None


def parse_empty_rows(rows, phone, size):
    """Recognize a complete recharge-only response, not a blank/loading frame.

    Only the prepared-account caller may use this result, and it must observe
    two identical full frames with matching native phone and foreground guards.
    This means no name displayed in this query, not permanent non-registration.
    """
    if not re.fullmatch(r"1\d{10}", str(phone)) or protection(rows, size) or search_loading(rows, phone, size) or search_network_busy(rows, phone, size) or search_rate_limit(rows, phone, size):
        return None
    entries = _entries(rows, size)
    top = [e for e in entries if re.fullmatch(r"1\d{10}", e[0]) and e[3] < .14 and e[1] >= .98]
    if len(top) != 1 or top[0][0] != phone:
        return None
    # Missing/low-confidence content must not hide another account card.
    body = [e for e in entries if .18 < e[3] < .85]
    # This clipboard control exists both with and without suggestions.
    # Its exact lower-right position is outside the result card.
    icons = [e for e in body if e[0] == "自" and e[2] > .9 and .8 < e[3] < .85]
    if len(icons) > 1:
        return None
    body = [e for e in body if e not in icons]
    # A complete recharge response may contain the fixed two-column search
    # suggestions panel. Recognize that whole layout, never arbitrary text.
    suggestions = [e for e in body if e[0] == "大家都在搜"]
    if suggestions:
        if len(suggestions) != 1 or suggestions[0][1] < .93:
            return None
        heading = suggestions[0]
        labels = {"查询快递", "看账单记录", "支付宝账号信息", "查名字",
                  "用户信息", "查询名字", "账户信息", "客户信息"}
        cells = sorted((e for e in body if e[0] in labels), key=lambda e: (e[3], e[2]))
        if len(cells) != 6 or len({e[0] for e in cells}) != 6:
            return None
        panel = [heading]
        previous_y = heading[3]
        for offset in range(0, 6, 2):
            a, b = sorted(cells[offset:offset + 2], key=lambda e: e[2])
            if (min(a[1], b[1]) < .96 or not (.05 < a[2] < .4 < .5 < b[2] < .85)
                    or abs(a[3] - b[3]) > .012 or not (.025 < a[3] - previous_y < .09)):
                return None
            panel.extend((a, b)); previous_y = a[3]
        if not (.3 < heading[3] < .5 and heading[2] < .35):
            return None
        body = [e for e in body if e not in panel]
        if any(e[3] >= heading[3] for e in body):
            return None
    if not body or any(e[1] < .96 for e in body):
        return None
    joined = "".join(e[0] for e in body)
    if any(x in joined for x in ["未实名", "转账", "加好友", "加载", "重试", "网络", "失败", "验证", "登录", "限制", "频繁"]):
        return None
    headers = [e for e in body if e[0] == "快捷功能"]
    recharge = [e for e in body if re.fullmatch(r"手机充值[:：]?"+re.escape(phone), e[0])]
    # The label and phone are sometimes separate OCR rows on the same line.
    if not recharge:
        labels=[e for e in body if e[0] in ("手机充值", "手机充值:", "手机充值：")]
        numbers=[e for e in body if e[0] == phone and e[1] >= .98]
        if len(labels)==1 and len(numbers)==1 and abs(labels[0][3]-numbers[0][3])<.025 and labels[0][2]<numbers[0][2]:
            recharge=[numbers[0]]
    allowed={"快捷功能","手机充值","手机充值:","手机充值：",phone,"手机充值:"+phone,"手机充值："+phone,"手机充值"+phone}
    if len(headers)!=1 or len(recharge)!=1 or not (0 < recharge[0][3]-headers[0][3]<.15) or any(e[0] not in allowed for e in body):
        return None
    return {"alipayDisplayName":"", "realNameTailCharacter":"", "matchedPhone":phone,
            "notFound":True,"message":"no_name_in_completed_search",
            "matchMethod":"prepared_recharge_only_two_frames"}
