"""Local, read-only OCR for a result card hidden from accessibility.

No device, HTTP or filesystem operations here. Callers supply screenshot bytes.
Nothing guesses a character, a phone digit, or a missing result.
"""
import math
import re

_ENGINE = None
_NAME = re.compile(r"[\(（]\*+(?:·\*+)*([^\(\)（）\s])[\)）]$")
_SIMPLE_NAME = re.compile(r"^\*+([\u4e00-\u9fff])$")
_PROTECTED = ("安全验证", "请完成下方验证", "拖动滑块", "滑动验证", "操作频繁", "访问异常",
              "访问被拒绝", "设备可能存在风险", "检查或切换设备", "请输入验证码")


def recognize(raw):
    global _ENGINE
    import cv2
    import numpy as np
    from rapidocr_onnxruntime import RapidOCR
    image = cv2.imdecode(np.frombuffer(raw, dtype=np.uint8), cv2.IMREAD_COLOR)
    if image is None or image.shape[0] * image.shape[1] > 8_000_000:
        raise ValueError("invalid_screenshot")
    if _ENGINE is None:
        # Model files are packaged by the pinned wheel; tasks never download
        # models or send screenshots to a service. Keep CPU use per worker low.
        _ENGINE = RapidOCR(intra_op_num_threads=1, inter_op_num_threads=1)
    rows, _ = _ENGINE(image)
    return rows or [], (image.shape[1], image.shape[0])


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


def search_loading(rows, phone, size):
    """Positive loading evidence for this exact input, never a result."""
    if not re.fullmatch(r"1\d{10}", str(phone)) or protection(rows, size):
        return False
    entries = _entries(rows, size)
    inputs = [e for e in entries if re.fullmatch(r"1\d{10}", e[0]) and e[3] < .14 and e[1] >= .98]
    return (len(inputs) == 1 and inputs[0][0] == phone
            and any(t == "搜索中" and c >= .96 and .20 < x < .80 and .10 < y < .25
                    for t, c, x, y in entries))


def parse_rows(rows, phone, size):
    """Require one high-confidence name/phone/two-action card, not input text."""
    if not re.fullmatch(r"1\d{10}", str(phone)) or protection(rows, size):
        return None
    entries = _entries(rows, size)
    top_inputs = [e for e in entries if re.fullmatch(r"1\d{10}", e[0]) and e[3] < .14 and e[1] >= .98]
    if len(top_inputs) != 1 or top_inputs[0][0] != phone:
        return None
    phones = [e for e in entries if e[0] == phone and e[1] >= .98]
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
            transfer = [e for e in actions if e[0] == "转账"]
            friend = [e for e in actions if e[0] == "加好友"]
            if len(transfer) != 1 or len(friend) != 1:
                continue
            if not (transfer[0][2] < friend[0][2] and abs(transfer[0][3] - friend[0][3]) < .025):
                continue
            candidates.append({"alipayDisplayName": display, "realNameTailCharacter": tail,
                               "matchedPhone": phone, "notFound": unverified,
                               "message": "account_not_real_named" if unverified else "",
                               "matchMethod": "visual_ocr_exact_phone_actions_two_frames"})
    # Even identical duplicate result cards are ambiguous, not extra votes.
    return candidates[0] if len(candidates) == 1 else None
