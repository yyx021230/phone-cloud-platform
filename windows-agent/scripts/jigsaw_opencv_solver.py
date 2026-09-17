#!/usr/bin/env python3
"""OpenCV-based Alipay jigsaw-slider (拼图) solver — offline self-test + live ADB.

This is an experiment companion to ``alipay_name_lookup.py``. Today a name
lookup that hits the "请拖动滑块完成拼图" surface is classified as
``jigsaw_verification`` and ends in an account switch. This module instead
tries to *solve* the puzzle with the well-known open-source OpenCV technique so
we can measure whether completing the verification is a viable alternative.

Approach (see e.g. the many GitHub "slide-captcha / jigsaw captcha" solvers):
  1. Capture one screenshot of the verification dialog.
  2. Crop two regions from it:
     - ``bg``   : the large picture that contains the notch (缺口).
     - ``piece``: the movable jigsaw piece at the bottom-left (it carries the
                  same texture that was cut out of the background).
  3. Primary detection — template matching. Run ``cv2.matchTemplate``
     (``TM_CCOEFF_NORMED``) of ``piece`` against ``bg``; the best match's x
     coordinate is the gap position.
  4. Fallback detection — notch geometry. When the piece texture is not a
     reliable template (confidence too low), isolate the notch with Canny
     edges + contour grouping and read its left edge instead.
  5. Convert the gap x from image pixels to a screen drag distance using the
     background region's screen bounds, then perform a human-like drag.

Nothing here is wired into the production task flow: it is a standalone
test/diagnostic tool. Run ``--selftest`` with no phone to validate the
detector against synthesized puzzles, ``--image`` to analyse a saved
screenshot, and ``--serial ... --drag`` to capture + drag on a live device.

Dependencies: ``opencv-python`` and ``numpy`` (already imported elsewhere in
this repo, e.g. ``alipay_name_lookup.py``).
"""
import argparse
import json
import subprocess
import time

import cv2
import numpy as np


# --------------------------------------------------------------------------- #
# Region configuration
# --------------------------------------------------------------------------- #
# All bounds are relative fractions of the *decoded* screenshot so the tool
# survives different device resolutions. Tune them for the real Alipay dialog
# once a screenshot is available. ``piece`` is the movable jigsaw square at the
# bottom-left; ``bg`` is the picture with the notch.
DEFAULT_REGIONS = {
    "bg":    [0.06, 0.28, 0.94, 0.60],   # x1, y1, x2, y2 (fractions)
    "piece": [0.10, 0.63, 0.30, 0.86],
    "track": [0.06, 0.78, 0.94, 0.88],   # horizontal rail the piece slides on
}
TEMPLATE_MIN_SCORE = 0.45  # TM_CCOEFF_NORMED values are in [-1, 1]


# --------------------------------------------------------------------------- #
# ADB helpers (mirror the patterns used in alipay_name_lookup.py)
# --------------------------------------------------------------------------- #
def adb_exec(serial, adb_path, args, timeout=15, binary=False):
    proc = subprocess.run(
        [adb_path, "-s", serial, *args], capture_output=True,
        text=not binary, encoding=None if binary else "utf-8",
        errors=None if binary else "ignore", timeout=timeout,
    )
    if proc.returncode:
        detail = proc.stderr if binary else (proc.stderr or proc.stdout)
        if isinstance(detail, bytes):
            detail = detail.decode("utf-8", "ignore")
        raise RuntimeError((detail or f"adb exited {proc.returncode}").strip())
    return proc.stdout


def screencap(serial, adb_path):
    raw = adb_exec(serial, adb_path, ["exec-out", "screencap", "-p"], binary=True)
    image = cv2.imdecode(np.frombuffer(raw, dtype=np.uint8), cv2.IMREAD_COLOR)
    if image is None:
        raise RuntimeError("screencap_decode_failed")
    return image


def region_pixels(shape, rel, clamp=True):
    """Convert a relative [x1,y1,x2,y2] rect into integer pixel bounds."""
    height, width = shape[:2]
    x1, y1, x2, y2 = rel
    out = [int(round(x1 * width)), int(round(y1 * height)),
           int(round(x2 * width)), int(round(y2 * height))]
    if clamp:
        out[0] = max(0, min(width - 1, out[0]))
        out[1] = max(0, min(height - 1, out[1]))
        out[2] = max(out[0] + 1, min(width, out[2]))
        out[3] = max(out[1] + 1, min(height, out[3]))
    return out


def crop(image, rel, regions):
    x1, y1, x2, y2 = region_pixels(image.shape, regions[rel])
    return image[y1:y2, x1:x2]


# --------------------------------------------------------------------------- #
# Detection
# --------------------------------------------------------------------------- #
def template_match_gap(bg, piece):
    """Return (gap_x_in_bg_px, score, method) or None.

    ``gap_x_in_bg_px`` is the left edge of the gap measured inside ``bg``.
    """
    if bg is None or piece is None or bg.size == 0 or piece.size == 0:
        return None
    if piece.shape[0] > bg.shape[0] or piece.shape[1] > bg.shape[1]:
        return None
    bg_gray = cv2.cvtColor(bg, cv2.COLOR_BGR2GRAY)
    piece_gray = cv2.cvtColor(piece, cv2.COLOR_BGR2GRAY)
    res = cv2.matchTemplate(bg_gray, piece_gray, cv2.TM_CCOEFF_NORMED)
    _, max_val, _, max_loc = cv2.minMaxLoc(res)
    return int(max_loc[0]), float(max_val), "template_match"


def edge_notch_gap(bg):
    """Fallback: detect the notch's left edge with Canny + contour grouping.

    Returns (gap_x_in_bg_px, confidence, method) or None. Only intended for
    backgrounds whose notch is a solid, contrasty block on a cleaner field.
    """
    if bg is None or bg.size == 0:
        return None
    gray = cv2.cvtColor(bg, cv2.COLOR_BGR2GRAY)
    blur = cv2.GaussianBlur(gray, (5, 5), 0)
    edges = cv2.Canny(blur, 50, 150)
    edges = cv2.dilate(edges, np.ones((3, 3), np.uint8), iterations=1)
    contours, _ = cv2.findContours(edges, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    height, width = gray.shape[:2]
    candidates = []
    for contour in contours:
        x, y, w, h = cv2.boundingRect(contour)
        if h < height * 0.12 or w < 4:
            continue
        if w > width * 0.85 or h > height * 0.9:
            continue  # skip the full-frame border
        if y > height * 0.5:
            continue  # the notch sits in the upper portion typically
        candidates.append((x, w, h, cv2.contourArea(contour)))
    if not candidates:
        return None
    # Prefer a mid-width notch with the largest vertical extent, then area.
    candidates.sort(key=lambda c: (abs(c[1] - width * 0.18), -c[2]))
    x, w, h, area = candidates[0]
    confidence = min(0.9, 0.4 + (area / (width * height)) * 40.0)
    return int(x), float(confidence), "edge_notch"


def detect_gap(image, regions=None):
    """Detect the gap and return a dict of measurements.

    ``drag_dx`` is the horizontal drag distance in *screenshot* pixels, i.e.
    how far the piece's grab point must move right to fill the gap.
    """
    regions = regions or DEFAULT_REGIONS
    bg_rel, piece_rel = regions["bg"], regions["piece"]
    bg = crop(image, "bg", regions)
    piece = crop(image, "piece", regions)

    # Trim a solid border off the piece so the template is the texture only.
    piece_trim = trim_solid_border(piece)

    result = {"method": None, "score": None, "gap_x_bg_px": None, "drag_dx": None}
    match = template_match_gap(bg, piece_trim if piece_trim is not None else piece)
    if match:
        gap_x, score, method = match
        result.update({"method": method, "score": round(score, 4), "gap_x_bg_px": gap_x})
        if score < TEMPLATE_MIN_SCORE:
            # Keep the template result but also try the notch fallback; a low
            # template score means the piece was not a reliable texture.
            notch = edge_notch_gap(bg)
            if notch:
                result.update({
                    "method": notch[2], "score": round(notch[1], 4),
                    "gap_x_bg_px": notch[0],
                })
    else:
        notch = edge_notch_gap(bg)
        if notch:
            result.update({
                "method": notch[2], "score": round(notch[1], 4),
                "gap_x_bg_px": notch[0],
            })

    if result["gap_x_bg_px"] is None:
        result["trusted"] = False
        return result

    # Convert gap_x (inside bg crop) to a screenshot x and subtract the piece
    # origin, giving the drag distance in screenshot pixels.
    bg_px = region_pixels(image.shape, bg_rel)
    piece_px = region_pixels(image.shape, piece_rel)
    bg_scale = (bg_px[2] - bg_px[0]) / float(bg.shape[1]) if bg.shape[1] else 1.0
    gap_screen_x = bg_px[0] + result["gap_x_bg_px"] * bg_scale
    drag_dx = gap_screen_x - piece_px[0]
    result["drag_dx"] = int(round(drag_dx))
    result["bg_scale"] = round(bg_scale, 4)
    result["trusted"] = result["score"] is not None and result["score"] >= TEMPLATE_MIN_SCORE
    return result


def trim_solid_border(piece):
    """Crop away a uniform frame around the piece (button chrome/arrow)."""
    if piece is None or piece.size == 0:
        return None
    gray = cv2.cvtColor(piece, cv2.COLOR_BGR2GRAY)
    ys, xs = np.where(gray < 250)
    if xs.size < 50 or ys.size < 50:
        return piece
    x1, x2 = int(xs.min()), int(xs.max()) + 1
    y1, y2 = int(ys.min()), int(ys.max()) + 1
    # Keep at least the centre third so we never collapse the template.
    if x2 - x1 < piece.shape[1] // 3 or y2 - y1 < piece.shape[0] // 3:
        return piece
    return piece[y1:y2, x1:x2]


# --------------------------------------------------------------------------- #
# Human-like drag
# --------------------------------------------------------------------------- #
def build_human_trajectory(start_x, start_y, distance, steps=24):
    """Return [(x, y), ...] with an ease-out curve and small vertical jitter.

    A constant-speed linear swipe is trivial for behavioural filters to flag;
    ease-out with tiny y jitter looks closer to a finger. Used for the
    ``motionevent`` path; the ``swipe`` path only needs distance + duration.
    """
    rng = np.random.default_rng()
    points = []
    for i in range(steps):
        t = i / float(steps - 1)
        eased = 1.0 - (1.0 - t) ** 2.4  # ease-out
        x = start_x + distance * eased
        y = start_y + rng.uniform(-1.5, 1.5)
        points.append((int(round(x)), int(round(y))))
    points[-1] = (int(round(start_x + distance)), start_y)
    return points


def swipe_drag(serial, adb_path, start, end, duration_ms=1100):
    """One-shot ``input swipe`` drag (broadest device compatibility)."""
    adb_exec(serial, adb_path, [
        "shell", "input", "swipe",
        str(start[0]), str(start[1]), str(end[0]), str(end[1]), str(duration_ms),
    ])


def motionevent_drag(serial, adb_path, trajectory, duration_ms=1100):
    """Multi-point drag via ``input motionevent`` (Android 10+, more human).

    Falls back to a plain swipe when the device rejects motionevent.
    """
    step_ms = max(8, duration_ms // len(trajectory))
    try:
        adb_exec(serial, adb_path, [
            "shell", "input", "motionevent", "DOWN",
            str(trajectory[0][0]), str(trajectory[0][1]),
        ], timeout=8)
        for x, y in trajectory[1:-1]:
            adb_exec(serial, adb_path, [
                "shell", "input", "motionevent", "MOVE", str(x), str(y),
            ], timeout=8)
            time.sleep(step_ms / 1000.0)
        x, y = trajectory[-1]
        adb_exec(serial, adb_path, [
            "shell", "input", "motionevent", "MOVE", str(x), str(y),
        ], timeout=8)
        adb_exec(serial, adb_path, ["shell", "input", "motionevent", "UP", str(x), str(y)], timeout=8)
        return "motionevent"
    except RuntimeError:
        swipe_drag(serial, adb_path, trajectory[0], trajectory[-1], duration_ms)
        return "swipe_fallback"


# --------------------------------------------------------------------------- #
# Synthetic puzzle generator (self-test)
# --------------------------------------------------------------------------- #
def synthesize_puzzle(width=720, height=1280, gap_x=270, piece_w=110, piece_h=110,
                      notch_style="dark"):
    """Build a puzzle-like image and return (image, ground_truth).

    ``notch_style`` controls how the cut-out hole looks, which exercises the
    two detector paths:
      - "dark"  : the hole is the same texture darkened (realistic; the movable
                  piece is the bright cut-out, so template matching finds it).
      - "blank" : the hole is flat white (the piece texture no longer exists in
                  the background, so the notch-edge fallback is required).
    """
    rng = np.random.default_rng(7)
    bg = np.empty((height, width, 3), np.uint8)
    # Vertical gradient + noise so template matching has real features.
    for y in range(height):
        bg[y, :, 0] = np.clip(60 + y // 12 + rng.integers(0, 30, width), 0, 255)
        bg[y, :, 1] = np.clip(90 + y // 15 + rng.integers(0, 25, width), 0, 255)
        bg[y, :, 2] = np.clip(120 + y // 18 + rng.integers(0, 20, width), 0, 255)

    bg_rel = DEFAULT_REGIONS["bg"]
    piece_rel = DEFAULT_REGIONS["piece"]
    bg_px = region_pixels(bg.shape, bg_rel)
    piece_px = region_pixels(bg.shape, piece_rel)

    # Carve the notch in the background at (bg_px[0]+gap_x, bg_px[1]).
    gy = bg_px[1] + (bg_px[3] - bg_px[1]) // 2 - piece_h // 2
    gx = bg_px[0] + gap_x
    notch = bg[gy:gy + piece_h, gx:gx + piece_w].copy()  # texture to reuse as piece
    if notch_style == "blank":
        bg[gy:gy + piece_h, gx:gx + piece_w] = (240, 240, 240)  # flat empty hole
    else:
        bg[gy:gy + piece_h, gx:gx + piece_w] = (notch * 0.55).astype(np.uint8)  # darkened hole

    # Place the movable piece (same texture) in the piece region, top-left aligned.
    py = piece_px[1] + (piece_px[3] - piece_px[1]) // 2 - piece_h // 2
    px = piece_px[0]
    bg[py:py + piece_h, px:px + piece_w] = notch

    return bg, {"gap_x_bg_px": gap_x, "piece_left_screen_px": px,
                "expected_drag_dx": (gx - px)}


def selftest():
    failures = 0
    cases = 0
    for notch_style in ("dark", "blank"):
        for gap_x in [120, 270, 400, 55, 480]:
            image, truth = synthesize_puzzle(gap_x=gap_x, notch_style=notch_style)
            result = detect_gap(image)
            ok = (result.get("gap_x_bg_px") is not None
                  and abs(result["gap_x_bg_px"] - truth["gap_x_bg_px"]) <= 6)
            print(json.dumps({
                "case": cases, "notch_style": notch_style, "gap_x": gap_x,
                "detected": result, "ground_truth": truth, "ok": bool(ok),
            }, ensure_ascii=False))
            cases += 1
            if not ok:
                failures += 1
    print(f"selftest {'PASS' if failures == 0 else 'FAIL'}: {failures} failures across {cases} cases")
    return failures == 0


# --------------------------------------------------------------------------- #
# CLI
# --------------------------------------------------------------------------- #
def parse_args():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--selftest", action="store_true", help="synthesize puzzles and verify detection")
    parser.add_argument("--image", help="analyse a saved screenshot file")
    parser.add_argument("--serial", help="adb serial (live capture)")
    parser.add_argument("--adb", default="adb", help="adb binary path")
    parser.add_argument("--drag", action="store_true", help="perform the drag after detection (live)")
    parser.add_argument("--human", action="store_true", help="use motionevent human-like drag")
    parser.add_argument("--regions", help="JSON file overriding DEFAULT_REGIONS")
    return parser.parse_args()


def load_regions(path):
    with open(path, "r", encoding="utf-8") as fh:
        return json.load(fh)


def main():
    args = parse_args()
    if args.selftest:
        raise SystemExit(0 if selftest() else 1)

    regions = load_regions(args.regions) if args.regions else DEFAULT_REGIONS

    if args.image:
        image = cv2.imread(args.image, cv2.IMREAD_COLOR)
        if image is None:
            raise SystemExit(f"cannot read image: {args.image}")
        result = detect_gap(image, regions)
        print(json.dumps(result, ensure_ascii=False))
        return

    if not args.serial:
        raise SystemExit("provide --selftest, --image, or --serial")

    image = screencap(args.serial, args.adb)
    result = detect_gap(image, regions)
    print(json.dumps({"screen": image.shape[:2], "result": result}, ensure_ascii=False))

    if args.drag and result.get("drag_dx") is not None and result["drag_dx"] > 0:
        piece_px = region_pixels(image.shape, regions["piece"])
        track_px = region_pixels(image.shape, regions["track"])
        start = (piece_px[0] + (piece_px[2] - piece_px[0]) // 2,
                 (track_px[1] + track_px[3]) // 2)
        end = (start[0] + result["drag_dx"], start[1])
        if args.human:
            traj = build_human_trajectory(start[0], start[1], result["drag_dx"])
            method = motionevent_drag(args.serial, args.adb, traj)
        else:
            swipe_drag(args.serial, args.adb, start, end)
            method = "swipe"
        print(json.dumps({"drag": method, "start": start, "end": end,
                          "distance": result["drag_dx"]}, ensure_ascii=False))


if __name__ == "__main__":
    main()
