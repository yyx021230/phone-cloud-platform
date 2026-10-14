"""Local Windows OCR for a proven XHS works list; no phone input or network."""
import base64
import json
import hashlib
import math
import re
import subprocess
import tempfile
import unicodedata
import xml.etree.ElementTree as ET
from pathlib import Path
from decimal import Decimal

ICON_PNGS = {'view': 'iVBORw0KGgoAAAANSUhEUgAAAC4AAAAvCAAAAAC5jqdOAAADrklEQVRIDZXB6VMbBRgH4N+b3Q2JOUjCkZBwJQXKUUFto6XodHrhTGfq+MkZp3+eftFvjjpDqUdbKxRtQRlok4KFcIQkJJCDBJLdzevucqX9ts9DDDOIYQYxzCCGGcQwgxhmEMMMYrytXivXqmodFkmwOZvwDmI0qpZye5mDoixDsls9/laPV0AjYpxTs4mdnQrjFNmD4aBXwDlinCmvx5I1SG6nSxKgVo8KRRn2UKTXhTPEOKHuxlcKcAb8rc5mSYRSPcxnM5kCXH2DfgEniHFM3Z7fqtqD4ZBXwCk1n15dU6TOKyEBx4hhULf/3lRbhiJeEY3q+/H4ntAVDQkwEEOnJue22D8WsUNTSKcqcHvDNmgO1//doc5rHQQdMXT5P1fU7mjQCkBZX9ovyWiytw/1igDk5IsEXfjUCx0xNJWFhWrbeEQAoMzHcnXoLL6hj0QA6tpsxhods0NDDKCemKp4ooNWaFaf7nHLSIs19WaTfBP90NSWnxeb73RZABADOHjyShy63gTN0fQb9WLUI1lqxWdxS89NDzRHM8ty7203AGKgvvmD3DnphW55ttB1y0cAOPtzzjMxCF3qtx1hckAEiIHK7zHHlcsE3ZPF6o33JejkxUfSpZvQ1Z8uVkeu2wFioPBdyT/ZDsNPcdwPwMBb32PgHgyZ6bTtvgcgBvLf1AKft8Lw42t81UkwpL9F/xcw5KZSjq+bAWKg8uiV7YMJGH5dUm4PS9ApLx9aR6/DsPDXwYU7DoAYUGLTHLrVBt3LmUL7PQ90xV/WXFdHoSs9SFi+7LEAxADyU0lpdEKEZv/hFl8adwhcP5hdpt67NmiUx0tK/w0XAGIA9cSDsufjYQGa2EyewwPB2u4/GWq+NgSNGp/bs94NWwAQQ1OZf6EEJrotAJS5WLEOHbkHr4oA6omZlDQadUBDDF3ucQKRaLsIQFlZ2qvKEO3usX4RgLz7bM0S+cwHHTF0vP1HCl0fdjZBc/g6l4cjFPRBU00sJBEY7xKgI4ZB3ZhLqW0jfS4LGqml9cVdIfBJtwADMY6piec7ijTQ3+oUcEotpf/bKEsdl3sEHCPGCTW5lCjDGwp4XU1WEapyUN5PbhXhDA93CDhBjDP51bV0FVavz26TIMv54n4NUtvFPjfOEOOckt3YyBwxTpG9rT3cIeIcMRop2d1ctigfKRAl53stPr/HhkbEeMdhoazICgTRbnPbLHgbMcwghhnEMIMYZhDDDGKYQQwziGEGMcwghhn/A0XAixC2vVmbAAAAAElFTkSuQmCC', 'like': 'iVBORw0KGgoAAAANSUhEUgAAACoAAAAvCAAAAACwZQc0AAAC50lEQVQ4EY3B22/bZBgH4N/72WnZojTKRprGDU3jQTdAHC4WpwqDG0CIu0n8f0hwCRIgcYE0qJAg9OBWk7ZqqFAtbrLiOs1Ur0vXNsvn78VpmqXHyM9DjKiIERUxoiJGVMSIihgD3DlsSwVtZPQqAQjaBx3FFBu5GkOIGH3c9re2mnsdFU+lzVQSftNzdzoyNnY9P5EcBYhxTPmP17cVel4zb2oPHImeWHrmzYQgRo9q3l/vaPHkFY1fHvhtvqK3ELsWHyF50NoLYrc+fJ0YR/ipva4Sk7ns2Ih60dqsuxJ6djKXiovDVrP+33Px1m1idPGu/TePv2uOocf7ZxXvzWTRs1dd3aabxOh6ufpXMHG7oKOv/RDvj6JPOnZDJ0aId+65SesdHQMBNAzIhystYoTk2py68Wkcl2tV1okR2v99LVH6AMM8WiBGqPVjM/NFGsM07xEj9OzbTv6ujmEOfyZGyP8a019hKP6BGKFn38j8XR3DyJ+IEXr+3W72yxSG8X8hRmh/7t/kR29jmNVFYoQ6j+a0mc9juNzBH2vE6Hr6/X6qfAuXW5v3idHVflBh45NJXKb+p0fEOLLz2ybn7hiEi7Bb2aQCMY7wk193+Y2yIXCecuefUPIzYvQE1YrPU7OGhrOCrcUape6YxDgmq/O+ypVyOk6T7vKGSJVNnRh98vHSTmBYeR0nyZrtatetGzqI8Yp0VhqBYU3FMNCp266WKU0LgBgDyln2AsPK6+iTNdvVMlZBACDGCcpZ9gLDyuvokTXb1TJFUyBEjJNUdcULDCuvo0vWbFfLFE2BLmKcopxlL8iWpjUAwcbSlpYpmgJHiHGacuxGkC0VBJSz6GkZqyDQQ4wz1MaSpyZmTVQXGiIzOy1wjBhnqdpCQ42XMb8txst5gT5inKPqlaZKo0npj6cEXiHGeWrzvqMgCsWswAAxLqD8xSpmitdwEjEutPsCiQROIUZUxIiKGFERIypiREWMqP4HxBFOHrh5gjwAAAAASUVORK5CYII=', 'comment': 'iVBORw0KGgoAAAANSUhEUgAAADQAAAAvCAAAAACJArZvAAAD0ElEQVRIDZXBy1MTBxwH8O8vG3bzzobIs4AZyqMgDFYIVKyOhQvSA53h0JMX/zAvnnqoVacVOuM42k5TVLDDq4OTdhILCAIhgc2DPHZ/3d3wlISZfD7EqBwxKkeMyhHjHLVQKDCDLIJQJaAEYpzF2fRW7ONONgfR5aluqLXZLPgUMU7jTDy6ssc4Inha2v0OC84ixinZ2L8r+7A4JMlqgVbIp7IqnB2dNSLOIMaJTHhhWxNlX2O17KxCPq1sbm/v5ax1Pa0OnEaMI7y/spQQ/M2fN1hxJL8e+S+uyt1dXsIJYhxJvF3JOJu6m0Scll1dWUtJ3f1enCDGocz8bNbdfUUmnMWJ5b8Ve3+vA8eIUZQLzyTcvT1unKcsLilysFPCEWKYtI3f1509fW6UoswvpWpHGwiHiGFKvlngths+lBYPhbl/wIFDxDBoq9PJS8NthNI48seW+9tGQhExDOnQvNgzLKGcXGgx91W/DUXEMOw+itfcCqC81Zcf5e/8KCKGTg1Po3NURHmF6TCPtwswEUN3MDPnGAjiIn+9Tg4FJZiIoUtNR2tGmnCR6ItYYMwJEzF0+z/uNt6RcZHE1Af3916YiKFLPMi1TIgwbMxstH7tQlEytFo/WAND/vF78a4MEzF08fsITMKQeRZm6rthgyH7apaF7m+qYHgYwT0fTMTQxe8jMAlD/HkUaB53wZB8ugoERnwwPIzgng8mYugSD3ItEyJ0hZdLqmUgKMFwEJrXLB2jNujyj9+Ld2WYiKHb+0FpGJdh2JnbbBpyoSgVitYN1sOQmPpQPemBiRi61K8R/+0ALrL2fPvymAsmYuiyszOu4DVcZHY2de26DSZi6NTwU2ofs6K8/LN3GGsXYCKGYfenRN3tJpQX/W3bN+FHETEMB3MzYu+wiHIOQsu5vutOFBHDwBs/K/W3mlGGFv4z5rzTbEERMUzp2Tdi/zDKiIfC1DvowiFimNR3U3R1BKUpC0vJz242WHCIGKb06zl7MIiSlMUlRR7qEHGEGKadqa26m5dRghZfXlFcX/Y4cIwYBjXyi9oxasd5ubXltbS956oHJ4hhSL966+gfRCGZ1iS5CscKm/+sxlT5SpeHcIIYhviTHU+nYy+dybPV6a/xSh5CLp2IryfiOUttX6sDpxFDp0WfqFa7llUZAEl2ySIS1EI2m9bg7mrziziDGDot8ggGweYVFEXFMfJ+EfDZCWcRw5B4EZVrZY9ss1JhL7YbU1IMUfLXXapxSoRPEcOgZXKCVRAEAqAV1IKmMRFZrVYBJRCjcsSoHDEqR4zK/Q9OQI4QDQLmoQAAAABJRU5ErkJggg=='}
COMMENT_ICONS_720 = ('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')
UNIT_GLYPHS = {'万': ('iVBORw0KGgoAAAANSUhEUgAAACAAAAAwCAAAAABVxyezAAABvElEQVQ4EX3BS0tUcQDG4d876XhhNiVammmZY83CI5GErSxzUZu+Rt+siKCIyhZCRleMggobhUo0tbQbhol4Gd/mjOdMIvJ/HpkwmTCZMJkwmTCZMJkwmTCZMJkwmTCZMBkorpbYzwAgA6PzG+znGiADMytblC18bcxn2eUMIAPbJvZuommwgV0OADJVbyZahurYQ6ZqvNh2qYY9ZKqeT3UMiz1kqsZmOwapUoaYTNX9ucYjVLWdylImk9q8/SvbQGJ1rediPWUyqeW7tLeQmF3oHMpSJpOaGz0cHSPxqtg2nKFMJvV+vCc6SOLZdMcFYjKpsamzUT2JR4snzhOT2eHNGzrXkyHxcDnfT0xmx+bv64W+VlJ31gt9xGQq/Lf4cqgrR6J0s6a3QEymorQ4wtXmDIm1W7mom5hMxbe3xStd9aR+PGiJ2onJxJYmPzVdrsuQ+vjkeNRMTAb8ffJLzUAX/z390NuXIyYDM9PztfkoS5kXJHn9xUb/6VpiMnBvKZcvNBLbfrxBprTy82TUSoUMjGS7j9ay4/XnP1vKdkaHaqiQCZMJkwmTCZMJkwmTCZMJkwmTCZMJkwn7BwFcmQFgix01AAAAAElFTkSuQmCC', 'iVBORw0KGgoAAAANSUhEUgAAACAAAAAwCAAAAABVxyezAAABLUlEQVQ4EX3BIZZaQRRF0XPnEI9G8yw6vm1av7bRHZtmDoWPzUgojWYS2JuuD7/CYvV6e8vUZGoyNZmaTE2mJlOTqcnUZGoyNZmazKfofMWADMT5ylcMyMCRxeGyf+VRAjJT9Gw8k5miZ+OZzBQ9G89kpujZeCYzRc/GM5kp+nbPtH9lkJmi8yAbg8wU/duGu/M1G4PMFD0bd9GzMcisREtW0bMxyKxES1bRszHIrERLVtGzMcis9PJzzyp6NgaZm+s5Tjum6NkYZG56cNoxRc/GILM4vmEeRM/GIDMcjhfMg/ieGwaZTx9/zpv35L+3vx/JQgaOh8v2xy8WR4Y3WrKQAbHJd27EYvv7hYUMiJbcicVpx41MTaYmU5OpydRkajI1mZpMTaYmU5Op/QOQmXkBtZ7TOgAAAABJRU5ErkJggg==')}
PACKAGE = "com.xingin.xhs"
COUNTER = re.compile(r"^\d+(?:\.\d+)?(?:万|亿)?$")
DIGIT_COUNTS = (10, 12, 12, 14, 14, 12, 8, 8, 12, 8)
DIGIT_ATLAS_SHA256 = "cda54de06b60eef1a33cfbd218fb7b2eda0982bc0e3724afd8cf0392a4ca4164"


def compact(value):
    return re.sub(r"\s+", "", unicodedata.normalize("NFKC", str(value)))


def line_box(line):
    words = line.get("words", [])
    if not words:
        raise RuntimeError("OCR line has no word positions")
    boxes = []
    for w in words:
        values = [w.get(k) for k in ("x", "y", "width", "height")]
        if any(isinstance(v, bool) or not isinstance(v, (int, float)) or not math.isfinite(v) for v in values):
            raise RuntimeError("OCR word position is invalid")
        x, y, width, height = values
        if x < 0 or y < 0 or width <= 0 or height <= 0:
            raise RuntimeError("OCR word position is invalid")
        boxes.append((x, y, x+width, y+height))
    return tuple(map(int, (min(b[0] for b in boxes), min(b[1] for b in boxes),
                           max(b[2] for b in boxes), max(b[3] for b in boxes))))


def date_text(value):
    raw = compact(value).strip(",，、‘’'\"")
    match = re.fullmatch(r"(\d{2})[-−—‐‑．.·一](\d{2})", raw)
    if not match or not 1 <= int(match[1]) <= 12 or not 1 <= int(match[2]) <= 31:
        raise RuntimeError("OCR date is not a proven MM-DD label")
    return match[1] + "-" + match[2]


def counter_text(value):
    raw = compact(value)
    if not COUNTER.fullmatch(raw):
        raise RuntimeError("OCR count is missing or nonnumeric")
    return raw


def equal_variants(images, prefix, parser):
    values = []
    by_variant = {}
    variants = ("color", "binary", "contrast", "small", "double", "nearest") if parser is date_text else ("color", "binary", "contrast", "nearest")
    for variant in variants:
        item = images.get(prefix + "_" + variant)
        if variant in ("contrast", "nearest", "small", "double") and item is None:
            continue
        if not item or item.get("language") != "zh-Hans-CN":
            raise RuntimeError("OCR crop result or language is missing")
        lines = item.get("lines", [])
        texts = [line.get("text", "") for line in lines]
        if len(texts) != 1:
            continue
        try:
            value = parser(texts[0]);values.append(value);by_variant[variant] = value
        except RuntimeError:
            continue
    if parser is date_text:
        # White-date ink is the primary evidence. Original cover colors and
        # pixelated enlargement can confuse dates; use them only to back up
        # one primary value, never to overturn two agreeing primary values.
        primary = [by_variant[v] for v in ("binary","contrast","small","double") if v in by_variant]
        if len(set(primary)) > 1:raise RuntimeError("OCR primary date values disagree")
        if len(primary) >= 2:return primary[0]
        if len(primary) == 1 and any(by_variant.get(v) == primary[0] for v in ("color","nearest")):
            return primary[0]
        raise RuntimeError("OCR crop must have two independently processed numeric/date values")
    if len(values) < 2:
        raise RuntimeError("OCR crop must have two independently processed numeric/date values")
    if len(set(values)) != 1:
        raise RuntimeError("OCR color/binary values disagree")
    return values[0]


def normalized_digit(glyph):
    import cv2
    import numpy as np
    h,w = glyph.shape
    scale = min(24/w,40/h)
    resized = cv2.resize(glyph,(max(1,round(w*scale)),max(1,round(h*scale))),interpolation=cv2.INTER_AREA)
    canvas = np.full((48,32),255,np.uint8)
    left,top = (32-resized.shape[1])//2,(48-resized.shape[0])//2
    canvas[top:top+resized.shape[0],left:left+resized.shape[1]] = resized
    return canvas


def numeric_cell(frame,box,allow_candidate=False):
    """Match visible numeral ink; missing ink is an error, never a zero value."""
    import cv2
    import numpy as np
    path = Path(__file__).with_name("xhs_ocr_digits.png")
    if not path.is_file() or hashlib.sha256(path.read_bytes()).hexdigest() != DIGIT_ATLAS_SHA256:
        raise RuntimeError("verified OCR numeral atlas identity is unproven")
    atlas = cv2.imread(str(path),cv2.IMREAD_GRAYSCALE)
    if atlas is None or atlas.shape != (480,32*max(DIGIT_COUNTS)):
        raise RuntimeError("verified OCR numeral atlas is unavailable")
    x1,y1,x2,y2 = box
    gray = cv2.cvtColor(frame[y1:y2,x1:x2],cv2.COLOR_BGR2GRAY)
    if float(gray.mean()) < 128:gray = 255-gray
    texts = []
    needs_native_proof = False
    for binary in (False,True):
        image = cv2.threshold(gray,210,255,cv2.THRESH_BINARY)[1] if binary else gray
        mask = (image < 220).astype(np.uint8)*255
        contours,_ = cv2.findContours(mask,cv2.RETR_EXTERNAL,cv2.CHAIN_APPROX_SIMPLE)
        boxes = sorted((cv2.boundingRect(c) for c in contours if cv2.contourArea(c) > 1),key=lambda b:b[0])
        if not 1 <= len(boxes) <= 13 or max(b[3] for b in boxes) < 7:
            raise RuntimeError("OCR numeric cell has no proven numeral ink")
        unit = ""
        x,y,gw,gh = boxes[-1]
        last_glyph = normalized_digit(image[y:y+gh,x:x+gw])
        unit_matches = []
        for name,templates in UNIT_GLYPHS.items():
            for encoded in templates:
                template = cv2.imdecode(np.frombuffer(base64.b64decode(encoded),np.uint8),0)
                if float(cv2.matchTemplate(last_glyph,template,cv2.TM_CCOEFF_NORMED)[0,0]) >= .965:
                    unit_matches.append(name)
        if unit_matches:
            if len(set(unit_matches)) != 1:raise RuntimeError("OCR displayed unit is ambiguous")
            unit = unit_matches[0];boxes = boxes[:-1];needs_native_proof = True
            if not boxes:raise RuntimeError("OCR displayed unit has no numeral prefix")
        height = max(b[3] for b in boxes)
        text = []
        for x,y,w,h in boxes:
            if h <= height*.22 and w <= height*.22 and y+h > max(b[1]+b[3] for b in boxes)-height*.25:
                text.append(".");continue
            if abs(h-height) > max(2,height*.12):
                raise RuntimeError("OCR numeric glyph heights are inconsistent")
            glyph = normalized_digit(image[y:y+h,x:x+w])
            scored = []
            for digit,number in enumerate(DIGIT_COUNTS):
                scores = [float(cv2.matchTemplate(glyph,atlas[digit*48:(digit+1)*48,j*32:(j+1)*32],cv2.TM_CCOEFF_NORMED)[0,0]) for j in range(number)]
                scored.append((max(scores),str(digit)))
            scored.sort(reverse=True)
            if scored[0][0] < .965 or scored[0][0]-scored[1][0] < .06:
                if not allow_candidate or scored[0][0] < .9 or scored[0][0]-scored[1][0] < .12:
                    raise RuntimeError("OCR numeral glyph is unproven or ambiguous")
                needs_native_proof = True
            text.append(scored[0][1])
        texts.append(counter_text("".join(text)+unit))
    if texts[0] != texts[1]:raise RuntimeError("OCR numeric color/binary glyphs disagree")
    if needs_native_proof and not allow_candidate:
        raise RuntimeError("OCR displayed count requires native corroboration")
    return (texts[0],needs_native_proof) if allow_candidate else texts[0]


def selected_works_underline(frame, box):
    import numpy as np
    h, w = frame.shape[:2]
    x1, y1, x2, y2 = box
    bottom = min(h, y2 + max(12, int(w*.045)))
    patch = frame[y2:bottom, max(0, x1-5):min(w, x2+5)]
    if not patch.size:
        return False
    blue, green, red = (patch[:, :, i].astype(np.int16) for i in range(3))
    mask = (red > 180) & (red-green > 90) & (red-blue > 65)
    columns = np.where(mask.sum(axis=0) >= max(2, int(w/540)))[0]
    if not len(columns):
        return False
    runs = np.split(columns, np.where(np.diff(columns) > 1)[0]+1)
    return max(map(len, runs)) >= (x2-x1)*.65


def metric_icons(frame, y1, y2, body_left):
    import cv2
    import numpy as np
    h, w = frame.shape[:2]
    left = max(0, body_left-int(w*.02))
    top, bottom = max(0, y1), min(h, y2)
    region = cv2.cvtColor(frame[top:bottom, left:w], cv2.COLOR_BGR2GRAY)
    found = []
    for name in ("view", "like", "comment"):
        templates = [(ICON_PNGS[name],1080)]
        if name == "comment":templates.extend((icon,720) for icon in COMMENT_ICONS_720)
        candidates = []
        for encoded,reference_width in templates:
            glyph = cv2.imdecode(np.frombuffer(base64.b64decode(encoded), np.uint8), 0)
            for step in range(16, 26):
                scale = w/reference_width * step/20
                template = cv2.resize(glyph, None, fx=scale, fy=scale, interpolation=cv2.INTER_AREA)
                gh, gw = template.shape
                if gh > region.shape[0] or gw >= region.shape[1]:
                    continue
                for variant in (template, 255-template):
                    scores = cv2.matchTemplate(region, variant, cv2.TM_CCOEFF_NORMED)
                    ys, xs = np.where(scores >= .92)
                    for y, x in zip(ys, xs):
                        candidates.append((float(scores[y, x]), left+int(x), top+int(y), gw, gh))
        if not candidates:
            raise RuntimeError("OCR metric icon is not proven: " + name)
        candidates.sort(reverse=True)
        best = candidates[0]
        bx, by = best[1]+best[3]/2, best[2]+best[4]/2
        if any(abs(c[1]+c[3]/2-bx)+abs(c[2]+c[4]/2-by) > max(c[3], c[4], best[3], best[4])*.6 for c in candidates[1:]):
            raise RuntimeError("OCR metric icon matches multiple locations: " + name)
        found.append((best[1], best[2], best[1]+best[3], best[2]+best[4]))
    if not (found[0][2] < found[1][0] and found[1][2] < found[2][0]) or max((b[1]+b[3])/2 for b in found)-min((b[1]+b[3])/2 for b in found) > w*.012:
        raise RuntimeError("OCR metric icon order/row is not proven")
    return found


def prepare_frame(frame, full, read_counts=True):
    h, w = frame.shape[:2]
    if full.get("width") != w or full.get("height") != h or full.get("language") != "zh-Hans-CN":
        raise RuntimeError("OCR frame dimensions/language disagree")
    angle = full.get("textAngle")
    if angle is not None and abs(angle) > 1:
        raise RuntimeError("OCR frame is rotated")
    lines = full.get("lines", [])
    if len(lines) > 800:
        raise RuntimeError("OCR frame line budget exceeded")
    parsed = [(compact(l.get("text", "")), line_box(l)) for l in lines]
    # On the observed 720px layout native OCR joins the adjacent filter icon
    # as a trailing Chinese full stop; normalize only this exact header label.
    parsed = [("全部笔记" if s == "全部笔记。" and b[1] < h*.28 else s,b) for s,b in parsed]
    if any(b[2] > w or b[3] > h for _, b in parsed):
        raise RuntimeError("OCR text lies outside its screenshot")
    headers = {}
    for text in ("数据中心", "作品分析", "全部笔记"):
        matches = [(s,b) for s,b in parsed if s == text and b[1] < h*.28]
        if len(matches) != 1:
            raise RuntimeError("OCR works-list header is not unique: " + text)
        headers[text] = matches[0][1]
    center, works, all_notes = (headers[t] for t in ("数据中心", "作品分析", "全部笔记"))
    if not (abs((center[0]+center[2])/2-w/2) < w*.2 and center[3] < works[1] < works[3] < all_notes[1]
            and all_notes[0] < w*.3 and selected_works_underline(frame, works)):
        raise RuntimeError("OCR selected works-list tab is not proven")
    if any(s in ("确认", "同意", "不同意", "允许", "拒绝", "收起", "立即更新") for s,_ in parsed):
        raise RuntimeError("OCR works list is covered by an unhandled overlay")
    markers = {s:b for s,b in parsed if s in ("到底了", "暂无笔记") and b[1] > all_notes[3]
               and abs((b[0]+b[2])/2-w/2) < w*.12 and b[3]-b[1] < w*.06}
    statuses = [(s[s.index("笔记状态"):],b) if "笔记状态" in s else (s,b) for s,b in parsed
                if b[0] >= w*.24 and b[1] > all_notes[3]
                and ("笔记状态" in s or s == "该篇笔记已不可被他人查看")]
    statuses.sort(key=lambda row:row[1][1])
    rows = []
    leading_clip = False
    trailing_clip = False
    for status_index,(status, sb) in enumerate(statuses):
        titles = [(s,b) for s,b in parsed if b[0] >= w*.24 and max(all_notes[3],sb[1]-h*.13) < b[1]
                  and b[3] < sb[1] and "笔记状态" not in s and not COUNTER.fullmatch(s)
                  and (re.search(r"[\u4e00-\u9fff]",s) or len(re.findall(r"[A-Za-z]",s)) >= 2)]
        if not titles:
            if status_index == 0 and sb[1]-all_notes[3] < w*.25:
                leading_clip = True
                continue
            raise RuntimeError("OCR card title is not visible")
        title, tb = max(titles,key=lambda row:row[1][1])
        if not 1 <= len(title) <= 180:
            raise RuntimeError("OCR card title length is invalid")
        y1 = sb[3] + int(w*.012)
        y2 = min(h-20, sb[3] + int(w*.15))
        if sb[3] + int(w*.08) >= h-20:
            if markers:
                raise RuntimeError("OCR end marker accompanies an incomplete card")
            trailing_clip = True
            continue
        try:
            icons = metric_icons(frame, y1, y2, min(tb[0], sb[0]))
        except RuntimeError as error:
            if (status_index == len(statuses)-1 and sb[1] > h*.84 and not markers
                    and str(error).startswith("OCR metric icon is not proven:")):
                # A bottom card can be behind the Android navigation bar.
                # Read it after scrolling; this clipped card proves no boundary.
                trailing_clip = True
                continue
            raise
        middle = (icons[0][1]+icons[0][3])/2
        date_box = (int(w*.1), int(middle+w*.006), int(w*.18), int(middle+w*.05))
        if date_box[3] >= h or date_box[1] < all_notes[3]:
            raise RuntimeError("OCR date crop is outside its card")
        number_boxes = []
        for i, icon in enumerate(icons):
            right = icons[i+1][0]-max(2,int(w*.002)) if i < 2 else w-1
            number_boxes.append((icon[2]+max(2,int(w*.002)), icon[1]-2, right, icon[3]+2))
        try:
            recognized_counts = [numeric_cell(frame,box,allow_candidate=True) for box in number_boxes] if read_counts else []
            verified_counts = [value for value,_ in recognized_counts]
            weak_fields = [i for i,(_,weak) in enumerate(recognized_counts) if weak]
        except RuntimeError as error:
            if (status_index == len(statuses)-1 and sb[1] > h*.84 and not markers
                    and str(error).startswith(("OCR numeric", "OCR numeral"))):
                trailing_clip = True
                continue
            raise
        # This is only an overlap hint within one snapshot, never a post ID.
        import cv2
        thumbnail = frame[max(all_notes[3],tb[1]-int(w*.015)):int(middle-w*.045),int(w*.03):int(w*.23)]
        if not thumbnail.size:raise RuntimeError("OCR card thumbnail overlap hint is unavailable")
        small = cv2.resize(cv2.cvtColor(thumbnail,cv2.COLOR_BGR2GRAY),(9,8),interpolation=cv2.INTER_AREA)
        bits = small[:,1:] > small[:,:-1]
        hint = f"{int(''.join('1' if v else '0' for v in bits.flat),2):016x}"
        rows.append({"title":title,"status":status,"titleBox":tb,"dateBox":date_box,"numberBoxes":number_boxes,
                     "verifiedCounts":verified_counts,"imageHint":hint,
                     "weakCountFields":weak_fields,
                     "box":(int(w*.03),tb[1],w-1,max(date_box[3],*(b[3] for b in number_boxes)))})
    if not rows and not markers:
        raise RuntimeError("OCR works list has no proven complete cards or empty/end marker")
    if rows and any(COUNTER.fullmatch(s) and b[0] >= w*.24 and all_notes[3] < b[1]
                    and b[3] < rows[0]["titleBox"][1] for s,b in parsed):
        leading_clip = True
    if len(rows) > 16:
        raise RuntimeError("OCR works-list card budget exceeded")
    scope = next((("仅统计近半年内笔记",b) for s,b in parsed if s.startswith("仅统计近半年内笔记") and abs(b[1]-all_notes[1]) < w*.03),None)
    return {"width":w,"height":h,"headers":headers,"markers":markers,"rows":rows,
            "leadingClip":leading_clip,"trailingClip":trailing_clip,"scope":scope}


def crop_requests(frame, prepared, directory, dates=True):
    import cv2
    import numpy as np
    images = []
    for i,row in enumerate(prepared["rows"]):
        fields = ([("date",row["dateBox"])] if dates else []) + [(name,row["numberBoxes"][i]) for i,name in enumerate(("view","like","comment")) if i in row.get("weakCountFields",[])]
        for name,box in fields:
            x1,y1,x2,y2 = box
            if x2 <= x1 or y2 <= y1:
                raise RuntimeError("OCR crop is empty")
            original = frame[y1:y2,x1:x2]
            if name != "date" and len(row["verifiedCounts"][("view","like","comment").index(name)]) == 1:
                # Windows OCR can omit a one-character word. Repeat the same
                # visible ink twice and require exactly that repeated value.
                gray = cv2.cvtColor(original,cv2.COLOR_BGR2GRAY)
                if float(gray.mean()) < 128:original = 255-original;gray = 255-gray
                ys,xs = np.where(gray < 220)
                if not len(xs):raise RuntimeError("OCR count crop has no numeral ink")
                glyph = original[ys.min():ys.max()+1,xs.min():xs.max()+1]
                gh,gw = glyph.shape[:2];gap = max(4,gw//2)
                copied = np.full((gh+16,gw*2+gap+16,3),255,np.uint8)
                copied[8:8+gh,8:8+gw] = glyph
                copied[8:8+gh,8+gw+gap:8+gw*2+gap] = glyph
                original = copied
            variants = ("color","binary","contrast","small","double","nearest") if name == "date" else ("color","binary","contrast","nearest")
            for variant in variants:
                scale = {"nearest":3,"small":1,"double":2}.get(variant,5)
                roi = cv2.resize(original,None,fx=scale,fy=scale,
                                 interpolation=cv2.INTER_NEAREST if variant == "nearest" else cv2.INTER_CUBIC)
                pixel = roi
                if variant != "color":
                    # The proven thumbnail date is white over a dark gradient.
                    # Isolate this ink so colored cover prices cannot become dates.
                    if name == "date":
                        minimum, maximum = roi.min(axis=2), roi.max(axis=2)
                        white = (minimum > (230 if variant in ("contrast","small","double") else 210)) & (maximum.astype(np.int16)-minimum.astype(np.int16) < 50)
                        pixel = np.where(white,0,255).astype(np.uint8)
                        # A white cover footer becomes a broad black bar and
                        # can suppress date characters in native OCR. Remove
                        # only components much wider and shorter than a digit.
                        number,labels,stats,_ = cv2.connectedComponentsWithStats(255-pixel)
                        for component in range(1,number):
                            x,y,width,height,area = stats[component]
                            if width > pixel.shape[1]*.65 and height < pixel.shape[0]*.25:
                                pixel[labels == component] = 255
                        if variant in ("small","double"):
                            pixel = cv2.copyMakeBorder(pixel,20,20,20,20,cv2.BORDER_CONSTANT,value=255)
                    else:
                        pixel = cv2.threshold(cv2.cvtColor(roi,cv2.COLOR_BGR2GRAY),185 if variant == "contrast" else 210,255,cv2.THRESH_BINARY)[1]
                key = f"r{i}_{name}_{variant}"
                path = Path(directory)/(key+".png")
                if not cv2.imwrite(str(path),pixel):
                    raise RuntimeError("OCR private crop write failed")
                images.append({"id":key,"path":str(path)})
    return images


def corroborate_counts(row, i, results):
    counts = row["verifiedCounts"]
    for field in row.get("weakCountFields",[]):
        name = ("view","like","comment")[field]
        try:
            corroborated = equal_variants(results,f"r{i}_{name}",counter_text)
        except RuntimeError as error:
            raise RuntimeError(f"OCR row {i} {name} unproven: {error}") from error
        expected = counts[field]*2 if len(counts[field]) == 1 else counts[field]
        if corroborated != expected:
            raise RuntimeError("OCR native count disagrees with both numeral-image readings")
    return counts


def resolve_frame(prepared, images, dates_only=False):
    results = {}
    for r in images:
        if r.get("id") in results:
            raise RuntimeError("OCR crop result identity is duplicated")
        results[r.get("id")] = r
    cards = []
    for i,row in enumerate(prepared["rows"]):
        try:
            date = equal_variants(results,f"r{i}_date",date_text)
        except RuntimeError as error:
            if (i == len(prepared["rows"])-1 and prepared.get("height")
                    and row["dateBox"][1] > prepared["height"]*.84 and not prepared["markers"]
                    and "two independently processed" in str(error)):
                prepared["trailingClip"] = True
                continue
            raise RuntimeError(f"OCR row {i} date unproven: {error}") from error
        card = {**row,"date":date}
        if not dates_only:card["counts"] = corroborate_counts(row,i,results)
        cards.append(card)
    if not cards and prepared.get("rows") and not prepared.get("markers"):
        raise RuntimeError("OCR works list has no proven complete dated cards")
    return {**prepared,"cards":cards}


def prepare_count_reading(frame, result, recent_date):
    cards = []
    for i,card in enumerate(result["cards"]):
        if not recent_date(card["date"]):
            cards.append({**card,"counts":[None,None,None],"boundaryOnly":True,"weakCountFields":[]})
            continue
        try:
            recognized = [numeric_cell(frame,box,allow_candidate=True) for box in card["numberBoxes"]]
        except RuntimeError as error:
            if (i == len(result["cards"])-1 and card["dateBox"][1] > result["height"]*.84
                    and not result["markers"] and str(error).startswith(("OCR numeric","OCR numeral"))):
                result["trailingClip"] = True
                continue
            raise
        cards.append({**card,"verifiedCounts":[value for value,_ in recognized],
                      "weakCountFields":[j for j,(_,weak) in enumerate(recognized) if weak]})
    if not cards and not result["markers"]:raise RuntimeError("OCR works list has no proven complete dated cards")
    return {**result,"cards":cards}


def windows_ocr(images, directory):
    request = Path(directory)/"request.json"
    request.write_text(json.dumps({"images":images}),encoding="utf-8")
    helper = Path(__file__).with_name("xhs_native_ocr.ps1")
    if not helper.is_file():
        raise RuntimeError("native OCR helper is unavailable")
    # Execute only this reviewed local command body, without changing the
    # machine/user/process execution policy or installing a language package.
    source = helper.read_text(encoding="utf-8-sig")
    if not source.startswith("param([Parameter(Mandatory=$true)][string]$RequestPath)"):
        raise RuntimeError("native OCR helper entry point is unproven")
    quoted_path = str(request).replace("'", "''")
    command = "$RequestPath = '" + quoted_path + "'\n" + "\n".join(source.splitlines()[1:])
    encoded = base64.b64encode(command.encode("utf-16-le")).decode("ascii")
    result = subprocess.run(["powershell","-NoProfile","-NonInteractive","-EncodedCommand",encoded],
                            capture_output=True,timeout=20)
    if result.returncode:
        raise RuntimeError("Windows native OCR failed; check its Chinese language component and local script execution policy")
    try:
        payload = json.loads(result.stdout.decode("utf-8-sig"))
    except (ValueError,UnicodeError) as error:
        raise RuntimeError("Windows native OCR returned an invalid result") from error
    if payload.get("protocol") != "windows_native_ocr_v1" or not isinstance(payload.get("images"),list):
        raise RuntimeError("Windows native OCR protocol is unproven")
    if len(payload['images']) != len(images) or {r.get('id') for r in payload['images']} != {r['id'] for r in images}:
        raise RuntimeError("Windows native OCR image identities disagree")
    return payload["images"]


def read_works_image(png, checkpoint=lambda: None, recent_date=lambda raw: True):
    import cv2
    import numpy as np
    frame = cv2.imdecode(np.frombuffer(png,np.uint8),cv2.IMREAD_COLOR)
    if frame is None or not 400 <= frame.shape[1] <= 3000 or not 700 <= frame.shape[0] <= 6000:
        raise RuntimeError("OCR screenshot dimensions are invalid")
    with tempfile.TemporaryDirectory(prefix="phonecloud-xhs-ocr-") as directory:
        full_path = Path(directory)/"whole.png"
        full_path.write_bytes(png)
        checkpoint()
        full = windows_ocr([{"id":"whole","path":str(full_path)}],directory)[0]
        checkpoint()
        prepared = prepare_frame(frame,full,read_counts=False)
        crops = crop_requests(frame,prepared,directory)
        checkpoint()
        recognized = []
        for offset in range(0,len(crops),64):
            checkpoint()
            recognized.extend(windows_ocr(crops[offset:offset+64],directory))
        resolved = prepare_count_reading(frame,resolve_frame(prepared,recognized,dates_only=True),recent_date)
        requests = crop_requests(frame,{"rows":resolved["cards"]},directory,dates=False)
        recognized = []
        for offset in range(0,len(requests),64):
            checkpoint();recognized.extend(windows_ocr(requests[offset:offset+64],directory))
        indexed = {r["id"]:r for r in recognized}
        if len(indexed) != len(recognized):raise RuntimeError("OCR count crop result identity is duplicated")
        for i,card in enumerate(resolved["cards"]):
            if not card.get("boundaryOnly"):card["counts"] = corroborate_counts(card,i,indexed)
        checkpoint()
        return resolved


def hierarchy_for_frame(result):
    root = ET.Element("hierarchy",{"rotation":"0","data-source":"windows_native_ocr",
                                    "data-leading-clip":str(result["leadingClip"]).lower()})
    w,h = result["width"],result["height"]
    def node(parent,text,box,**attrs):
        x1,y1,x2,y2 = box
        return ET.SubElement(parent,"node",{"package":PACKAGE,"class":"android.widget.TextView","text":text,
            "bounds":f"[{x1},{y1}][{x2},{y2}]","enabled":"true","clickable":"false",**attrs})
    view = node(root,"数据中心",(0,0,w,h),**{"class":"android.webkit.WebView","scrollable":"true"})
    for text,box in result["headers"].items():node(view,text,box)
    if result.get("scope"):node(view,result["scope"][0],result["scope"][1])
    for text,box in result["markers"].items():node(view,text,box)
    for card in result["cards"]:
        row = node(view,"",card["box"],**{"class":"android.view.View","data-ocr-card":"true","data-image-hint":card["imageHint"],
            "data-boundary-only":str(bool(card.get("boundaryOnly"))).lower()})
        node(row,card["date"],card["dateBox"],**{"data-field":"date"})
        node(row,card["title"],card["titleBox"],**{"data-field":"title"})
        node(row,card["status"],card["titleBox"],**{"data-field":"status"})
        for name,value,box in zip(("view","like","comment"),card["counts"],card["numberBoxes"]):
            node(row,value if value is not None else "",box,**{"data-field":name})
    return root


def cards_from_hierarchy(root):
    cards = []
    for row in root.iter("node"):
        if row.get("data-ocr-card") != "true":continue
        fields = {n.get("data-field"):n.get("text") for n in row}
        if set(fields) != {"title","date","status","view","like","comment"} or len(list(row)) != 6:
            raise RuntimeError("OCR card fields are incomplete")
        date_text(fields["date"])
        if not fields["title"] or not fields["status"] or not re.fullmatch(r"[0-9a-f]{16}",row.get("data-image-hint", "")):
            raise RuntimeError("OCR card title/status/overlap hint is invalid")
        values = []
        boundary_only = row.get("data-boundary-only") == "true"
        if boundary_only:
            if any(fields[name] != "" for name in ("view","like","comment")):raise RuntimeError("OCR date boundary has unexpected numeric data")
            values = [None,None,None]
        else:
            for name in ("view","like","comment"):
                raw = counter_text(fields[name]);factor = 100000000 if raw.endswith("亿") else 10000 if raw.endswith("万") else 1
                values.append(int(Decimal(raw.rstrip("万亿"))*factor))
        cards.append((row,{"title":fields["title"],"published_at_raw":fields["date"],"status_raw":fields["status"],
                           "_image_hint":row.get("data-image-hint"),
                           "_boundary_only":boundary_only,
                           "_displayed_unit":any(fields[name].endswith(("万","亿")) for name in ("view","like","comment")),
                           **dict(zip(("list_view_count","list_like_count","list_comment_count"),values))}))
    return cards
