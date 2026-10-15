#!/usr/bin/env python3
"""State-preserving, element-driven Alipay masked-name lookup task runner.

Each invocation is short lived, while the phone remains on Alipay's global
search page between invocations. A query therefore reuses the visible page;
only an evidenced abnormal state triggers a bounded full-path recovery.
"""
import argparse
from datetime import datetime
import json
import os
import random
import re
import subprocess
import time
import traceback
import xml.etree.ElementTree as ET

ALIPAY_PACKAGE = "com.eg.android.AlipayGphone"
ALIPAY_HOME = "com.eg.android.AlipayGphone/.AlipayLogin"
ALIPAY_LOGIN_ACTIVITY = "com.ali.user.mobile.loginupgrade.activity.LoginActivity"
SEARCH_INPUT_ID = "com.alipay.mobile.antui:id/search_input_box"
SEARCH_BACK_BUTTON_ID = "com.alipay.mobile.antui:id/search_back_button"
ACCOUNT_ID = "com.alipay.mobile.securitybiz:id/tv_am_item_account"
ACCOUNT_CURRENT_ID = "com.alipay.mobile.securitybiz:id/tv_am_item_current"
TAB_DESCRIPTION_ID = "com.alipay.android.tablauncher:id/tab_description"
TAB_SELECTED_FRAME_ID = "com.alipay.android.tablauncher:id/selected_fl"
SETTINGS_ENTRY_ID = "com.alipay.mobile.antui:id/right_text"
VERIFICATION_TITLE = "为保障您的正常访问请进行验证"
VERIFICATION_ACTION = "向右滑动验证"
JIGSAW_VERIFICATION_ACTION = "请拖动滑块完成拼图"
JIGSAW_FEEDBACK_PREFIX = "反馈码:"
ACCESS_DENIED_TITLE = "访问被拒绝"
ACCESS_DENIED_PROXY_HINT = "代理软件"
ACCESS_DENIED_VPN_HINT = "VPN"
DEVICE_RISK_TITLE = "您的设备可能存在风险，请检查或切换设备"
DEVICE_RISK_HINT = "检查或切换设备后，请等待一段时间再试"
FREQUENT_OR_ABNORMAL_ACCESS_TITLE = "操作频繁或访问异常，请稍后再试"
FREQUENT_OR_ABNORMAL_ACCESS_HINT = "请稍后"
COLOROS_SECUREPAY_PACKAGE = "com.coloros.securepay"
COLOROS_USB_TRANSFER_TITLE = "已允许 USB 传输数据，请切换为“仅充电”后再使用支付应用。"
COLOROS_REMOTE_CONTROL_RISK = "存在被远程控制、泄露隐私的风险。"
COLOROS_IGNORE_BUTTON_ID = "android:id/button2"
HONOR_SOFTWARE_UPDATE_PACKAGE = "com.hihonor.ouc"
HONOR_SOFTWARE_UPDATE_TITLE = "软件更新"
HONOR_SOFTWARE_UPDATE_INSTALL_TEXT = "下载并安装"
HONOR_SOFTWARE_UPDATE_DETAILS_TEXT = "详细信息"
HONOR_SOFTWARE_UPDATE_LATER_TEXT = "稍后"
ALIPAY_REAL_NAME_PROMPT_TITLE = "账户尚未实名认证"
ALIPAY_REAL_NAME_PROMPT_TITLE_188 = "请完成实名认证"
ALIPAY_REAL_NAME_PROMPT_ACTION = "立即认证"
ALIPAY_PHONE_CREDIT_PROMO_TITLE = "话费限时福利"
ALIPAY_PHONE_CREDIT_PROMO_ACTION = "立即领取"
ALIPAY_PHONE_CREDIT_PROMO_OFFER = "1分钱充5元话费"
VIVO_SECURITY_CENTER_PACKAGE = "com.vivo.safecenter"
VIVO_WLAN_RISK_TITLE = "WLAN风险提示"
VIVO_WLAN_DISCONNECT_TEXT = "立即断开"
VIVO_WLAN_IGNORE_TEXT = "忽略风险"
SYSTEM_UI_PACKAGE = "com.android.systemui"
ACCOUNT_SWITCH_REASONS = {
    "access_denied", "device_risk",
    "frequent_or_abnormal_access",
}
# Leave room for Agent dispatch and result persistence so the user-visible
# no-name response stays close to five seconds end to end.
POCO_NO_NAME_RESULT_SECONDS = 4.4
POCO_SEARCH_SUBMIT_DELAY_SECONDS = 0.4
QUERY_INPUT_DELAY_MIN_SECONDS = 3.0
QUERY_INPUT_DELAY_MAX_SECONDS = 10.0
ALIPAY_LOCAL_SERVICE_TITLE = "支付宝本地服务"
ALIPAY_LOCAL_SERVICE_HINT = "允许地理位置权限，支付宝能更好的为您提供缴费、商户、乘车等服务"


REAL_NAME_CANVAS_TITLE_PNG = 'iVBORw0KGgoAAAANSUhEUgAAAU4AAAAvCAAAAACp53z+AAAGPklEQVRoBe3BUZKjipYEMOX+F53vALYBFy48ETX3q6X45w/FP38orhVxp8RXivhCEd+o+EKJ/0pcK+JGjfhGEV8o4l6NuFUjPmq8K+Jdxa0YdRIUcaeIjyoeitiU+KSILxRxq0Z8UsRZEW+KWNS1IEadBEU8lLhSxAc1YlPEpogPivhCEXdqxCe1iJMizmoRo64FMeokKGJTIy7UiA+K2BSxKuKTIq7UrXhTF2JXizgq4k0tgroWxKiToIhNEU/1m9jViFURqyI+KeJK3YqzuhIHtYiDIn6oEepaEKOITQmKWNWIp/pNHNSIRRGLIg7qd7GpW3FU1+KoFrEr4qcacVAjdjGK2JSgiEWNeKnfxFERiyJGjTio38WmbsVBfRAnNWJXxIUijorYxSiihBIUMWrErn4TR0UsihhFHNXvYlPER0W81CpOasRZiYMirlScFLGLUUQJJSiCGnFQxJUiTkosihhFnNSvYlPER0U81SpOasTvasRXitjFKKKEEhShFnFQxJUirhXxhSKuFDGKWBSxKWJVD3FSI27UiK8UsYtRRAklKFKrOCriShHXivhCEVeKoFZBEZsiFrUJJV5qxI0a8ZUidjGKKKEERWrEWRFXinioG3GpiCslFrUKRWxKbGoRahGrWsSdGvGbIkYRuxhFlFCCIkq8KeJKEQ91Iy4V8btaRRE/lRi1ilGL2NVTHNSIg3qKVRGjiF2MIkooQREV74q4UsRD3YhLRdypEUX8phahFnFQT3FQIw7qKVZFjCJ2MYoooQRFXCniShEPdSMuFfFRxapEEb+qgziqpzioRezqKVZFjCJ2MYoooQRFXKnfxEMRHxSxqnvxUsRTETfqId7UQxzUIg7qIVZFjHqJEaOIEkrUD/FQv4mHIj4oYlX34qlWsSniRm3iUhG7WsW7IlZFjHqJEaOIEkrUT7Gp38RDER8Usap78VKbWBTxq9rEB0XsahNvilgVMeolRowiSihRP8WmfhMPRYw6iVHEqu7FQa1iFPFZPcUnRexqE2+KWBUx6iVGjCJKKFE/xaaIW0WMOguK+KF28VERiyI+qE/ioIhdbeJNEasiRhG7GEWUUIIiFHFUI24VMeosKOKHkiIlPqtYFHGlfhW7InZFijgrYlXEKGIXo4gSSlAEJY6KuFfEqLOgiHdFihRxq4h3dSt2RbzUSBFnRayKGEXsYhRRQgmKoMRREfeKGEVsiqCIN0UUUcRZ3YpRt2JXxEsRijgpYlXEKGIXo4gSSlAERRwUca+IUcSmCIo4K0IRijipW7GoVYp4V8SuiKcaoYiTIlZFjCJ2MYoooQRFUMRBEfeKGEVsiqCIsyIUoUYc1a1YFEER74rYFfFUIxRxUsSqiFHELkaRIpSgiFHEroh7RYwiNkVQxEkRFEGNOKhbcVTEuyJ2RTwVMYo4KmJVxChiF6NIEUpQxCjipUbcK2IUsSmCIo6KGEWMGvFRjfhFEe+K2BVRMWrEqBEHRVQoYhSxi6cinopYFPFUxBeKGEWsagRF7GoRo4hFjfigNvFREe+K2BUpQY1YFXFQpIQiRhG7eCriqYhFEU9FfKGIUWdBES+1iEURi1rEpXqJD4p4V8SuHkKNWNWIXW1CEaOIXTwUKbEqYlEjHor4QhGjzoIinmoRqyJWtYif6iyuFPGuiF1tQo14KGJXm1DEKGIXD0WKWBRBo4hNjfhCEaPOgiI2tYpNEZtaxZtahdrEhSLeFbGrTdQiHmrES62CIkYRu9gUUSNGEUUUsSriG0V8UMSqVvFQxEOt4qA2sapN/FCfxEutQi3ipUY81SJGEaOIXaxqhBpBPUWNGDXiG0V8UMSiVvFUxFOt4qke4qk28aY+iZdahFrErhaxqUXUJyFGLWLUCPUUagRFfKWIazViVcSuiF0Rq3qJo9rESX0SLzVCLeKoRmxqhPokBLWIRY2ohxg1Qo34ShEXahObioMiDipW9RJvahVH9UnsKkaNOCvioQT1SYhRI1YlqEVsSlDEd4q4UJu4VMSV2sSFWsRRjTirEbvGqsSbEk+NRX0SYpR4qqCIl8aixHeKuFCruFbEpRrxQYmTIt4VcaHxQ+P/JP6fFPGfapw1/mPxzx+Kf/5Q/POH4p8/FP/8ofjnD/0PEHCeTjYmTnwAAAAASUVORK5CYII='
REAL_NAME_CANVAS_ACTION_PNG = 'iVBORw0KGgoAAAANSUhEUgAAAJsAAAAoCAAAAADMVNeLAAAC1UlEQVRYCc3BQXKYMAAEMO3/H721TQBTkiYzvUSK3yt+r/i94qWI/9B4KvGXxnfipYhP1C6oTRxKPJR4KjHVWyzxVsRb7YLaxKGIXYmHGmKot1jirYi32gW1iQ9FbEo81RDUWyzxVsRbiUMJSkxFnIq4lfhbEZsSu1jqX2IpcShBiamISxGXEi9F3ErsYql/iqnEoQQlpiJuFbcSbxWbErtY6p9iKnEoQYmpiC8U8a0Su/i52gUlpiK+UMS3Suzi52oXlJiK+EIR3yqxi5+rXVBiKuILRXypxFBiF7ciNkVcShxKUGIqYqhD3Iq41SGWEkOJXdyK2BRxKXEoQYmpiKEOcashLnWIpcRQYhebEpsStxKHEpSYihjqELca4lKHWEoMJXaxKeJSxK3EoQQlpiJOJW41xFOJpcRQp1hiU8SliFsRSwlKTEWcSlxqiqcSS4mhTrHEpohLEbfaBSWmIk4lLrXEQ4mlxFCnWGJX4lJiU7ugxFTEqcSllngosZQYSuxiV8SHIjZF7EpMRZxKXEqU2JVYSgwldrEr4kMRmxIPJaYiTiVORZTYlVhKDCV28VDiQ4ldiYcSUxGnEqciSuxKLCWGErt4KGIpYlfi0JhKTEWcSpxKUGJTYikxlNjFQxFLEbsSUxFDiamIU4kPRVBiU2IpMZTYxUMRS4mHEkuJocRUxKmExlBiKnEroaHEUGIXD0VMRTyUWIqgxFTEqUQFRUwlbiUqlBhK7OKpxFTEQ4lDCUrUEpeSEoo4lLjUEkoMJXbxVGIq8VRiqCWUqCUutYQiDkWcagklhhK7+FwRTyXqFEqoIW41hSJOJU41BSWGEruY6htB3aJEiZcagiIuRXyoIYYSQ4ldTPWNoE5BiRIvRVBD3Io4FKE+E1NM9Y2gljhUlHiroIbYFHGoGOozMcWPFfFQ4q0xlXioeKrPxBT/o8TXGn9p/Fz8XvF7xe8Vv9cfokw0ODWxsJAAAAAASUVORK5CYII='
REAL_NAME_CANVAS_CLOSE_PNG = 'iVBORw0KGgoAAAANSUhEUgAAAEYAAABFCAAAAADS0c/2AAAB4klEQVRYCa3BB3KDQAAEMO3/H70JhwvliMmMpfiK+Ir4iviK+KSID+Ja7cWluFBDrGqIuZiqX3FQxExMlJgrcRZnJa6UOImjEn8pcRAHJf5WYi/2Kj6r2ImdijsqtmKr4p6KjdiouKviLd4q7qt4ibeK+0o8xUvFf1Q8xVPF/1Q8xFPFPzUe4qHirXFDxSoeKl5KTJTYaKxiVfFWxFmJjYohVhVbJQ6K2KoYYlWxVcROEXuNIYaKgxIbRRw0hhgqDop4KeKoYhFDxUmJhyLOGosYGmdFrEpMNBYxNGZK/CpiprGIoTFTBCWmGosYGnMlRcw1FrGomKshLjQWsai4UsSVxiKGxpUirjQWMTTmaogLjUUMjakiRcw1FjE0ZoqgxFRjEUPFWRG/ipioWMRQcVLEqsRZxSKGipMSD0WcVCxiVbFXxFuJo8YQq4q9EhtF7FUMsarYKmKvxE7FEA8VGyWOSmw1VvFQ8VLEWYm3ilU8VTyVmGlsNB7iqeKl8VnFQ7xU/EfFU7xV3FfxEm8V91W8xEbFXRVvsVVxT8VG7FTcUbEVexWfVezEQYkPKvbiqMRfShzEWYlLFScxUWKuxFlM1a84KGImLtQQqxpiLq7VXlyKT4r4IL4iviK+Ir4ivuIHQu+mRu4j7oUAAAAASUVORK5CYII='

def real_name_canvas_evidence(raw):
    """Match only the observed optional prompt and its separate circle X.

    Templates contain the title, authentication-action label and close icon
    only. The rest of the phone screenshot is never retained or logged.
    Coordinates come from unique current-image matches, not a blind tap.
    """
    import base64
    import cv2
    import numpy as np
    image = cv2.imdecode(np.frombuffer(raw, dtype=np.uint8), cv2.IMREAD_COLOR)
    if image is None:
        raise RuntimeError("alipay_canvas_prompt_screenshot_invalid")
    height, width = image.shape[:2]
    if not 1.9 <= height / max(width, 1) <= 2.5:
        return {"visible": False, "close": None, "unsupported": True}
    normalized = cv2.resize(image, (720, round(height * 720 / width)))
    gray = cv2.cvtColor(normalized, cv2.COLOR_BGR2GRAY)
    h, w = gray.shape

    def matches(encoded, light, cutoff, top, bottom):
        template = cv2.imdecode(np.frombuffer(base64.b64decode(encoded), dtype=np.uint8), cv2.IMREAD_GRAYSCALE)
        mask = ((gray > cutoff) if light else (gray < cutoff)).astype(np.uint8) * 255
        if light:
            kernel = np.ones((3, 3), np.uint8)
            mask = cv2.dilate(mask, kernel)
            template = cv2.dilate(template, kernel)
        y0, y1 = round(h * top), round(h * bottom)
        x0, x1 = round(w * .10), round(w * .90)
        region = mask[y0:y1, x0:x1]
        if region.shape[0] < template.shape[0] or region.shape[1] < template.shape[1]:
            return []
        scores = cv2.matchTemplate(region, template, cv2.TM_CCOEFF_NORMED)
        count, labels = cv2.connectedComponents((scores >= .93).astype(np.uint8))
        points = []
        for label in range(1, count):
            ys, xs = np.where(labels == label)
            best = int(np.argmax(scores[ys, xs]))
            points.append((x0 + int(xs[best]) + template.shape[1] / 2,
                           y0 + int(ys[best]) + template.shape[0] / 2))
        return points

    titles = matches(REAL_NAME_CANVAS_TITLE_PNG, False, 170, .30, .60)
    actions = matches(REAL_NAME_CANVAS_ACTION_PNG, True, 200, .55, .76)
    closes = matches(REAL_NAME_CANVAS_CLOSE_PNG, True, 180, .68, .88)
    evidence = {"visible": bool(titles or actions), "close": None,
                "titleCount": len(titles), "actionCount": len(actions), "closeCount": len(closes)}
    if not (len(titles) == len(actions) == len(closes) == 1):
        return evidence
    title, action, close = titles[0], actions[0], closes[0]
    if (any(abs(point[0] - w / 2) > w * .045 for point in (title, action, close))
            or not h * .12 <= action[1] - title[1] <= h * .31
            or not h * .08 <= close[1] - action[1] <= h * .20):
        return evidence
    # The exact blue action is evidence only; never a tap target.
    x, y = map(round, action)
    button = normalized[y-15:y+15, x-60:x+60]
    if not button.size or np.mean((button[:, :, 0] > 180) & (button[:, :, 2] < 100)) < .35:
        return evidence
    evidence["close"] = [round(close[0] * width / 720), round(close[1] * width / 720)]
    return evidence

def focused_window_name(lines):
    """Use the one actual window, never the activity left underneath it."""
    current = [line.strip() for line in lines if "mCurrentFocus" in line
               and not re.fullmatch(r"\s*mCurrentFocus\s*=\s*null\s*", line)]
    if len(current) != 1:
        return None
    window = re.fullmatch(
        r"mCurrentFocus\s*=\s*Window\{[^\s{}]+(?:\s+u\d+)?\s+"
        r"([^\s{}]+)(?:\s+type=\d+)?\s*\}", current[0])
    if window:
        return window.group(1)
    # Preserve exact component-only focus fixtures / older OEM output, but
    # do not accept package substrings or an unstructured background activity.
    component = re.fullmatch(r"mCurrentFocus\s*=\s*([^\s{}/]+/[^\s{}]+)", current[0])
    return component.group(1) if component else None


class Runner:
    def __init__(self, payload):
        self.payload = payload
        self.serial = str(payload["serial"])
        self.adb_path = str(payload.get("adbPath") or "adb")
        self.task_id = re.sub(r"[^0-9A-Za-z_.-]", "_", str(payload.get("taskId") or int(time.time() * 1000)))
        self.log = []
        self.started = time.perf_counter()
        self.human_verification_passes = 0
        self.account_switched = False
        self.current_account_after_switch = ""
        self.account_identity_verified = False
        self.saved_accounts = []
        if payload.get("accountCooldownProtocol") == 1:
            self.current_account_after_switch = str(payload.get("knownAccount") or "")
            self.account_identity_verified = payload.get("accountIdentityVerified") is True
            self.saved_accounts = list(payload.get("savedAccounts") or [])
        self.account_switch_reason = ""
        self.account_switch_history = []
        self.restricted_accounts = set()
        self.saved_account_count = 0
        self.search_ready_after_switch = True
        self._display_size = None

    def emit(self, step, **detail):
        item = {"step": step, "elapsedMs": int((time.perf_counter() - self.started) * 1000), **detail}
        self.log.append(item)
        print(json.dumps({"event": item}, ensure_ascii=True), flush=True)

    def wait_before_phone_input(self, driver):
        delay_seconds = random.uniform(
            QUERY_INPUT_DELAY_MIN_SECONDS, QUERY_INPUT_DELAY_MAX_SECONDS,
        )
        self.emit(
            "query_input_throttle_wait", driver=driver,
            minSeconds=QUERY_INPUT_DELAY_MIN_SECONDS,
            maxSeconds=QUERY_INPUT_DELAY_MAX_SECONDS,
            delayMs=int(round(delay_seconds * 1000)),
        )
        time.sleep(delay_seconds)
        return delay_seconds

    def adb(self, args, timeout=20, check=True, binary=False):
        # Only these observations are safe to repeat. Never retry an input,
        # tap, account action, app launch or XML instrumentation here.
        read_only = (args == ["exec-out", "screencap", "-p"]
                     or args == ["shell", "dumpsys", "window"]
                     or args == ["shell", "dumpsys", "-t", "2", "window"])
        deadline = time.perf_counter() + timeout
        for attempt in range(2 if read_only else 1):
            remaining = max(.05, deadline - time.perf_counter())
            proc = subprocess.run(
                [self.adb_path, "-s", self.serial, *args], capture_output=True,
                text=not binary, encoding=None if binary else "utf-8",
                errors=None if binary else "ignore", timeout=min(timeout, remaining),
            )
            stderr = proc.stderr.decode("utf-8", "ignore") if binary else proc.stderr
            transient = bool(re.search(r"device .*not found|device offline|no devices|error: closed", stderr or "", re.I))
            empty = not proc.stdout
            if (not read_only or attempt or not (empty or transient)
                    or deadline - time.perf_counter() < .3):
                break
            self.emit("lookup_read_transport_retry", observation="screenshot" if binary else "focus",
                      attempt=1, maxRetries=1, queryReplayed=False, deviceRestarted=False)
            time.sleep(.25)
        if read_only and (proc.returncode or not proc.stdout):
            reason = "adb_read_unavailable" if proc.returncode else "adb_read_empty"
            raise RuntimeError("local_lookup_result_unconfirmed:" + reason)
        if check and proc.returncode:
            detail = proc.stderr if binary else (proc.stderr or proc.stdout)
            if isinstance(detail, bytes):
                detail = detail.decode("utf-8", "ignore")
            raise RuntimeError((detail or f"adb exited {proc.returncode}").strip())
        return proc.stdout

    def focus(self, timeout=10, recover=True):
        try:
            output = self.adb(["shell", "dumpsys", "window"], timeout=timeout, check=False)
        except subprocess.TimeoutExpired as exc:
            if not recover:
                raise RuntimeError("poco_android_window_service_timeout") from exc
            # One read-only, device-side bounded recovery for transient WMS
            # stalls. Do not enter the launch fallback and repeat a 10s dump.
            self.emit("android_window_service_read_timeout", driver="poco_focus_adb",
                      deviceRestarted=False, queryReplayed=False)
            try:
                output = self.adb(["shell", "dumpsys", "-t", "2", "window"], timeout=3, check=False)
            except Exception as retry_exc:
                raise RuntimeError("poco_android_window_service_timeout") from retry_exc
            if "mCurrentFocus" not in str(output) or "DUMP TIMEOUT" in str(output):
                raise RuntimeError("poco_android_window_service_timeout") from exc
            self.emit("android_window_service_read_recovered", driver="poco_focus_adb",
                      deviceRestarted=False, queryReplayed=False)
        return [line.strip() for line in str(output).splitlines() if "mCurrentFocus" in line or "mFocusedApp" in line]

    @staticmethod
    def focus_components(lines):
        """Keep the actual foreground separate from the underlying task.

        OEM dialogs and Android's keyguard commonly own ``mCurrentFocus``
        while ``mFocusedApp`` still names Alipay.  Joining both fields made a
        covered Alipay activity look foreground and sent Poco into a blocked
        hierarchy channel.
        """
        values = [str(line or "") for line in (lines or [])]

        def usable(field):
            candidates = [line for line in values if field in line]
            # Multi-display vivo/Honor builds can emit a placeholder such as
            # ``mCurrentFocus=null`` for one display before the concrete
            # foreground window for the active display.  Treating that first
            # placeholder as authoritative caused start to force-stop a
            # perfectly healthy foreground Alipay task and then invalidate
            # Poco's hierarchy channel.  Prefer a concrete component-bearing
            # line, while retaining the placeholder only as diagnostics when
            # WindowManager supplied nothing better.
            concrete = [
                line for line in candidates
                if not re.search(rf"{re.escape(field)}\s*=\s*null(?:\s|$)", line, re.I)
                and ("/" in line or "Window{" in line or "ActivityRecord{" in line)
            ]
            return concrete[-1] if concrete else (candidates[-1] if candidates else "")

        current = usable("mCurrentFocus")
        focused_app = usable("mFocusedApp")
        return current, focused_app

    def focus_state(self):
        lines = self.focus()
        current, focused_app = self.focus_components(lines)
        return lines, current, focused_app

    @staticmethod
    def exact_search_activity_visible(current_focus, focused_app):
        """Recognize the exact Alipay Search activity without trusting overlays.

        A few multi-display Android builds briefly report ``mCurrentFocus=null``
        even though ``mFocusedApp`` already names the concrete foreground task.
        Accept that narrow state, but never accept ``mFocusedApp`` while another
        concrete window (SecurePay, SystemUI, an OEM dialog, etc.) owns focus.
        """
        current = str(current_focus or "")
        focused = str(focused_app or "")
        exact_current = ALIPAY_PACKAGE in current and "MainSearchActivity" in current
        current_is_null = bool(re.search(r"mCurrentFocus\s*=\s*null(?:\s|$)", current, re.I))
        exact_focused = ALIPAY_PACKAGE in focused and "MainSearchActivity" in focused
        return exact_current or (current_is_null and exact_focused)

    @staticmethod
    def system_ui_focus_visible(current_focus):
        """Recognize both package-qualified and bare SystemUI focus windows.

        Some OPPO/ColorOS builds report an expanded notification shade as the
        bare window name ``NotificationShade`` without the
        ``com.android.systemui`` package.  Keep the bare match deliberately
        narrow: it must be the concrete component inside ``mCurrentFocus`` so
        unrelated diagnostic text cannot trigger a screen action.
        """
        current = str(current_focus or "")
        if SYSTEM_UI_PACKAGE in current:
            return True
        return bool(re.search(
            r"mCurrentFocus\s*=\s*Window\{[^}\r\n]*\bu\d+\s+NotificationShade(?:\s|\})",
            current,
        ))

    def keep_awake_usb_best_effort(self):
        """Keep the screen awake without making a transient shell stall fatal.

        Device state and package availability are hard preconditions checked by
        the caller.  `svc power stayon usb` is only a convenience and some OEM
        shells have been observed to time out once while the next shell command
        succeeds normally, so retain evidence and continue.
        """
        try:
            self.adb(["shell", "svc", "power", "stayon", "usb"], timeout=2, check=False)
            return True
        except Exception as exc:
            self.emit(
                "keep_awake_usb_skipped",
                reason="noncritical_adb_shell_unavailable",
                errorType=type(exc).__name__,
            )
            return False

    def display_size(self, timeout=5):
        if self._display_size:
            return self._display_size
        output = str(self.adb(["shell", "wm", "size"], timeout=timeout, check=False))
        matches = re.findall(r"(\d+)x(\d+)", output)
        self._display_size = tuple(map(int, matches[-1])) if matches else (1080, 2400)
        return self._display_size

    def poco_tap(self, node, deadline=None):
        """Use Poco for element location, but keep the actual tap bounded by ADB."""
        x, y = node.get_position()
        def budget():
            if deadline is None:
                return 5
            remaining = deadline - time.perf_counter()
            if remaining < 0.25:
                raise RuntimeError("poco_query_result_channel_timeout_after_input:tap_budget_exhausted")
            return min(2, remaining)

        width, height = self.display_size(timeout=budget())
        px = max(1, min(width - 1, int(round(x * width))))
        py = max(1, min(height - 1, int(round(y * height))))
        self.adb(["shell", "input", "tap", str(px), str(py)], timeout=budget())

    @staticmethod
    def bounds_center(bounds):
        values = [int(value) for value in re.findall(r"\d+", bounds or "")]
        if len(values) != 4:
            raise RuntimeError(f"invalid bounds: {bounds!r}")
        return (values[0] + values[2]) // 2, (values[1] + values[3]) // 2

    @staticmethod
    def bounds_values(bounds):
        values = [int(value) for value in re.findall(r"\d+", bounds or "")]
        if len(values) != 4:
            raise RuntimeError(f"invalid bounds: {bounds!r}")
        return values

    def dump(self, token, command_timeout=15, read_timeout=12, allow_tty_fallback=True):
        remote = f"/sdcard/PhoneCloud/.alipay-name-{self.task_id}-{token}.xml"
        self.adb(["shell", "mkdir", "-p", "/sdcard/PhoneCloud"], timeout=8)
        self.adb(["shell", "uiautomator", "dump", remote], timeout=command_timeout, check=False)
        raw = self.adb(["exec-out", "cat", remote], timeout=read_timeout, binary=True)
        if b"<hierarchy" not in raw and allow_tty_fallback:
            raw = self.adb(
                ["exec-out", "uiautomator", "dump", "/dev/tty"],
                timeout=command_timeout,
                check=False,
                binary=True,
            )
        decoded = raw.decode("utf-8", "replace")
        start, end = decoded.find("<hierarchy"), decoded.rfind("</hierarchy>")
        if start < 0 or end < start:
            raise RuntimeError("uiautomator_hierarchy_missing")
        root = ET.fromstring(decoded[start:end + len("</hierarchy>")])
        parent = {child: node for node in root.iter() for child in node}
        return root, parent

    @staticmethod
    def find(root, text=None, desc=None, resource_id=None, package=None):
        result = []
        for node in root.iter("node"):
            if package is not None and (node.get("package") or "").strip() != package:
                continue
            if text is not None and (node.get("text") or "").strip() != text:
                continue
            if desc is not None and (node.get("content-desc") or "").strip() != desc:
                continue
            if resource_id is not None and (node.get("resource-id") or "").strip() != resource_id:
                continue
            result.append(node)
        return result

    @staticmethod
    def texts(root, limit=100):
        values = []
        for node in root.iter("node"):
            for key in ("text", "content-desc"):
                value = (node.get(key) or "").strip()
                if value and value not in values:
                    values.append(value)
                    if len(values) >= limit:
                        return values
        return values

    def verification_evidence(self, root):
        texts = set(self.texts(root, 120))
        protected = VERIFICATION_TITLE
        action = JIGSAW_VERIFICATION_ACTION if JIGSAW_VERIFICATION_ACTION in texts else VERIFICATION_ACTION
        feedback = next((value for value in texts if value.startswith(JIGSAW_FEEDBACK_PREFIX)), "")
        # Feedback codes are also shown on account restriction pages. Only
        # the verification title/action proves a verification surface.
        if protected in texts or action in texts:
            return {
                "title": protected if protected in texts else "",
                "action": action if action in texts else "",
                "feedback": feedback,
                "manual": action == JIGSAW_VERIFICATION_ACTION or bool(feedback),
            }
        return None

    @staticmethod
    def access_denied_evidence_from_texts(values):
        normalized = [re.sub(r"\s+", "", str(value or "")) for value in values]
        title = next((value for value in normalized if value == ACCESS_DENIED_TITLE), "")
        hint = next((
            value for value in normalized
            if ACCESS_DENIED_PROXY_HINT in value and ACCESS_DENIED_VPN_HINT in value.upper()
        ), "")
        if not title or not hint:
            return None
        return {"title": title, "hint": hint}

    def access_denied_evidence(self, root):
        return self.access_denied_evidence_from_texts(self.texts(root, 120))

    @classmethod
    def account_restriction_evidence_from_texts(cls, values):
        normalized = [re.sub(r"\s+", "", str(value or "")) for value in values]
        if ({"您请求次数过于频繁", "待会来试试", "刷新"}.issubset(normalized)
                and not any(marker in text for text in normalized for marker in (
                    VERIFICATION_TITLE, VERIFICATION_ACTION, JIGSAW_VERIFICATION_ACTION,
                    "请输入验证码", "短信验证码登录"))):
            return {"reason": "frequent_or_abnormal_access",
                    "title": "您请求次数过于频繁", "hint": "待会来试试"}
        access_denied = cls.access_denied_evidence_from_texts(normalized)
        if access_denied:
            return {"reason": "access_denied", **access_denied}
        if DEVICE_RISK_TITLE in normalized and DEVICE_RISK_HINT in normalized:
            return {
                "reason": "device_risk",
                "title": DEVICE_RISK_TITLE,
                "hint": DEVICE_RISK_HINT,
            }
        if (
            FREQUENT_OR_ABNORMAL_ACCESS_TITLE in normalized
            and FREQUENT_OR_ABNORMAL_ACCESS_HINT in normalized
        ):
            return {
                "reason": "frequent_or_abnormal_access",
                "title": FREQUENT_OR_ABNORMAL_ACCESS_TITLE,
                "hint": FREQUENT_OR_ABNORMAL_ACCESS_HINT,
            }
        return None

    def account_restriction_evidence(self, root):
        return self.account_restriction_evidence_from_texts(self.texts(root, 160))

    @staticmethod
    def account_switch_reason_from_error(error):
        raw = str(error or "")
        if "alipay_access_denied_account_switch_required" in raw:
            return "access_denied"
        match = re.search(
            r"alipay_account_restriction_(?:switch_required|before_search):([a-z_]+)",
            raw,
        )
        reason = match.group(1) if match else ""
        return reason if reason in ACCOUNT_SWITCH_REASONS else ""

    def raise_account_restriction(self, evidence, phase, driver, phone_query_started=False):
        reason = str(evidence.get("reason") or "")
        event = "alipay_access_denied_detected" if reason == "access_denied" else "alipay_account_restriction_detected"
        self.emit(
            event,
            phase=phase,
            driver=driver,
            reason=reason,
            title=evidence.get("title", ""),
            phoneQueryStarted=bool(phone_query_started),
            accountSwitchRequired=bool(phone_query_started or (
                self.payload.get("accountCooldownProtocol") == 1 and self.account_identity_verified
            )),
            currentAccount=self.current_account_after_switch,
            accountIdentityVerified=self.account_identity_verified,
        )
        if not phone_query_started:
            raise RuntimeError(f"alipay_account_restriction_before_search:{reason}")
        if reason == "access_denied":
            raise RuntimeError("alipay_access_denied_account_switch_required")
        raise RuntimeError(f"alipay_account_restriction_switch_required:{reason}")

    def raise_access_denied(self, evidence, phase, driver):
        self.raise_account_restriction({"reason": "access_denied", **evidence}, phase, driver)

    def return_to_home_for_account_switch(self, evidence, token):
        """Leave an evidenced restriction surface without treating it as healthy.

        A verification WebView and Alipay's global Search activity are two
        separate navigation layers.  The former can consume several Back
        actions before exposing ``MainSearchActivity``.  The old single loop
        spent its entire retry allowance leaving the WebView and then reported
        ``home_recovery_failed`` while the normal Search page was already
        visible.  Keep those phases separate: first dismiss only the evidenced
        restriction surface, then leave the exact Search activity using
        WindowManager evidence, and finally require the unique Home tab before
        any account navigation is allowed.
        """
        root = parent = None
        for attempt in range(1, 5):
            self.adb(["shell", "input", "keyevent", "4"], timeout=5, check=False)
            time.sleep(0.35)
            try:
                root, parent = self.dump(
                    f"{token}-restriction-back-{attempt}",
                    command_timeout=6, read_timeout=4, allow_tty_fallback=False,
                )
            except Exception as exc:
                self.emit(
                    "account_restriction_back_probe_unavailable",
                    reason=evidence.get("reason", ""), attempt=attempt,
                    error=str(exc),
                )
                continue
            if len(self.find(root, text="我的", resource_id=TAB_DESCRIPTION_ID)) == 1:
                self.emit(
                    "account_restriction_dismissed_for_switch",
                    reason=evidence.get("reason", ""), attempt=attempt,
                )
                return root, parent
            if not self.account_restriction_evidence(root):
                self.emit(
                    "account_restriction_surface_cleared",
                    reason=evidence.get("reason", ""), attempt=attempt,
                )
                break

        # Whether the last XML probe saw the restriction disappear or merely
        # timed out, use the exact foreground activity as the authoritative
        # boundary for the second navigation phase.  Extra Back actions are
        # safe here: they are sent only while MainSearchActivity is concrete.
        self.exit_search_activity_for_account_navigation(
            f"{token}-restriction-cleared", max_attempts=4,
        )
        _, current_focus, focused_app = self.focus_state()
        if (
            ALIPAY_PACKAGE not in str(current_focus or "")
            and ALIPAY_PACKAGE not in str(focused_app or "")
        ):
            self.resume_alipay_home(f"{token}-restore-alipay-home")

        last_error = ""
        for attempt in range(1, 4):
            try:
                root, parent = self.dump(
                    f"{token}-home-verify-{attempt}",
                    command_timeout=6, read_timeout=4, allow_tty_fallback=False,
                )
                if len(self.find(root, text="我的", resource_id=TAB_DESCRIPTION_ID)) == 1:
                    self.emit(
                        "account_restriction_dismissed_for_switch",
                        reason=evidence.get("reason", ""),
                        attempt=attempt, navigationPhase="home_verification",
                    )
                    return root, parent
                last_error = f"texts={self.texts(root, 30)!r}"
            except Exception as exc:
                last_error = str(exc)
            time.sleep(0.25)
        raise RuntimeError(
            "alipay_account_restriction_home_recovery_failed:"
            f"{evidence.get('reason', '')}:detail={last_error}"
        )

    def find_slider_anchor(self, root):
        """Locate the current slider hint/knob from exact UI evidence."""
        for node in root.iter("node"):
            bounds = node.get("bounds")
            if not bounds:
                continue
            text = (node.get("text") or "").strip()
            desc = (node.get("content-desc") or "").strip()
            if "滑动" in text or "滑动" in desc or "向右" in text:
                return self.bounds_values(bounds)
        return None

    def find_slider_track(self, root, anchor):
        """Find the widest short horizontal element aligned with the slider."""
        if anchor is None:
            return None
        anchor_y = (anchor[1] + anchor[3]) // 2
        best, best_width = None, -1
        for node in root.iter("node"):
            bounds = node.get("bounds")
            if not bounds:
                continue
            x1, y1, x2, y2 = self.bounds_values(bounds)
            width, height = x2 - x1, y2 - y1
            if height <= 0 or height > 160 or width <= 150:
                continue
            if not (y1 - 40 <= anchor_y <= y2 + 40):
                continue
            if width > best_width:
                best, best_width = (x1, y1, x2, y2), width
        return best

    def slider_area_nodes(self, root, anchor_y):
        nodes = []
        for node in root.iter("node"):
            bounds = node.get("bounds")
            if not bounds:
                continue
            x1, y1, x2, y2 = self.bounds_values(bounds)
            if not (y1 - 60 <= anchor_y <= y2 + 60):
                continue
            text = (node.get("text") or "").strip()
            desc = (node.get("content-desc") or "").strip()
            if text or desc:
                nodes.append({
                    "text": text[:40], "desc": desc[:40],
                    "class": node.get("class") or "", "bounds": [x1, y1, x2, y2],
                })
        return nodes

    def solve_human_verification(self, root, parent, token, max_attempts=3):
        """Auto-drag a basic slider; preserve only a jigsaw for the operator."""
        evidence = self.verification_evidence(root)
        if not evidence:
            return root, parent
        anchor = self.find_slider_anchor(root)
        anchor_y = (anchor[1] + anchor[3]) // 2 if anchor else None
        self.emit(
            "human_verification_detected", evidence=evidence, token=token,
            requiresHuman=bool(evidence.get("manual")), automatedAttempts=0,
            resubmitsInput=False,
            sliderAreaNodes=self.slider_area_nodes(root, anchor_y) if anchor_y is not None else [],
        )
        if evidence.get("manual"):
            raise RuntimeError("alipay_human_verification_required:jigsaw_verification")
        for attempt in range(1, max_attempts + 1):
            anchor = self.find_slider_anchor(root)
            track = self.find_slider_track(root, anchor)
            if anchor is None or track is None:
                self.emit(
                    "human_verification_geometry_missing", attempt=attempt,
                    anchorFound=anchor is not None, trackFound=track is not None,
                    texts=self.texts(root, 60),
                )
                break
            x1, y1, x2, y2 = track
            knob_half = max(8, (y2 - y1) // 2)
            start_x, start_y = x1 + knob_half, (y1 + y2) // 2
            screen_right = max(
                (self.bounds_values(node.get("bounds"))[2]
                 for node in root.iter() if node.get("bounds")),
                default=x2,
            )
            end_x, end_y = max(x2 - knob_half, screen_right - 10), start_y
            duration_ms = 2200 + (attempt - 1) * 300
            self.adb([
                "shell", "input", "swipe", str(start_x), str(start_y),
                str(end_x), str(end_y), str(duration_ms),
            ], timeout=15)
            self.emit(
                "human_verification_slider_drag", attempt=attempt, track=list(track),
                start=[start_x, start_y], end=[end_x, end_y], durationMs=duration_ms,
            )
            time.sleep(1.5)
            root, parent = self.dump(f"{token}-verify-{attempt}")
            if not self.verification_evidence(root):
                self.human_verification_passes += 1
                self.emit("human_verification_passed", attempt=attempt, token=token)
                return root, parent
            self.emit("human_verification_retry", attempt=attempt, texts=self.texts(root, 60))
        self.emit("human_verification_failed", token=token, attempts=max_attempts)
        raise RuntimeError("alipay_basic_slider_verification_failed")

    def solve_verification_from_xml_if_present(self, token):
        """Bridge a Poco-blind Alipay challenge using exact UIAutomator evidence."""
        poco_released = False
        try:
            root, parent = self.dump(
                f"{token}-verification-probe",
                command_timeout=6, read_timeout=4, allow_tty_fallback=False,
            )
        except Exception as exc:
            self.emit(
                "verification_xml_probe_unavailable", token=token,
                error=str(exc), driver="xml_uiautomator_probe",
            )
            if "uiautomator_hierarchy_missing" not in str(exc):
                return False
            try:
                from xhs_airtest_poco import release_poco_for_confirm_xml
                release_poco_for_confirm_xml(self.adb_path, self.serial, self.log)
                poco_released = True
                root, parent = self.dump(
                    f"{token}-verification-after-poco-release",
                    command_timeout=8, read_timeout=5, allow_tty_fallback=True,
                )
            except Exception as release_exc:
                raise RuntimeError(
                    f"poco_rpc_failed:verification_xml_handoff_failed:{release_exc}"
                ) from release_exc
        evidence = self.verification_evidence(root)
        if not evidence:
            if poco_released:
                raise RuntimeError(
                    "poco_rpc_failed:verification_xml_handoff_no_challenge:"
                    "worker_reattach_required"
                )
            return False
        self.emit(
            "verification_recovered_from_xml", token=token, evidence=evidence,
            driver="xml_uiautomator_probe", resubmitsInput=False,
        )
        self.solve_human_verification(root, parent, token)
        if poco_released:
            raise RuntimeError(
                "poco_rpc_failed:basic_slider_solved_worker_reattach_required"
            )
        return True

    @staticmethod
    def tappable(node, parent):
        current = node
        while current is not None:
            if current.get("bounds") and current.get("enabled", "true") != "false" and current.get("clickable") == "true":
                return current
            current = parent.get(current)
        return node if node.get("bounds") else None

    def tap_unique(self, root, parent, label, **selector):
        matches = self.find(root, **selector)
        if len(matches) != 1:
            raise RuntimeError(f"{label}: expected one exact element, got {len(matches)}")
        target = self.tappable(matches[0], parent)
        x, y = self.bounds_center(target.get("bounds"))
        self.adb(["shell", "input", "tap", str(x), str(y)], timeout=8)
        self.emit(label, selector=selector, tap={"x": x, "y": y})
        return matches[0]

    @staticmethod
    def coloros_securepay_usb_evidence(root):
        """Return exact evidence for ColorOS's USB/remote-control warning.

        The dialog also exposes a "仅充电" action which can tear down the
        phone's data/ADB path.  Requiring the vendor package, both exact message
        elements, and the exact secondary action id keeps recovery fail-closed.
        """
        nodes = list(root.iter("node"))

        def exact(text, resource_id):
            return [
                node for node in nodes
                if (node.get("package") or "").strip() == COLOROS_SECUREPAY_PACKAGE
                and (node.get("text") or "").strip() == text
                and (node.get("resource-id") or "").strip() == resource_id
            ]

        titles = exact(COLOROS_USB_TRANSFER_TITLE, "com.coloros.securepay:id/alertTitle")
        messages = exact(COLOROS_REMOTE_CONTROL_RISK, "com.coloros.securepay:id/tv_message")
        ignores = exact("忽略", COLOROS_IGNORE_BUTTON_ID)
        if len(titles) != 1 or len(messages) != 1 or len(ignores) != 1:
            return None
        return {"title": titles[0], "message": messages[0], "ignore": ignores[0]}

    def dismiss_coloros_securepay_usb_dialog(self, root=None, parent=None, driver="xml_uiautomator"):
        """Dismiss the evidenced ColorOS warning without changing USB mode."""
        if root is None:
            # Avoid starting UIAutomator on a normal/slow Alipay page.  The
            # hierarchy probe is allowed only after Poco missed its target and
            # WindowManager proves that ColorOS SecurePay owns the foreground.
            focus = "\n".join(self.focus())
            if COLOROS_SECUREPAY_PACKAGE not in focus:
                return False
            try:
                root, parent = self.dump(
                    "coloros-securepay-usb-warning",
                    command_timeout=4,
                    read_timeout=4,
                    allow_tty_fallback=False,
                )
            except Exception as exc:
                # Some older ColorOS builds do not let a second UiAutomation
                # client coexist with the resident Poco instrumentation.  Ask
                # the Agent to stop Poco and enter its clean XML fallback now,
                # instead of consuming the normal two-stage dump budget.
                self.emit(
                    "coloros_securepay_probe_deferred_to_clean_xml",
                    errorType=type(exc).__name__,
                    driver=driver,
                )
                raise RuntimeError("coloros_securepay_requires_clean_xml_fallback") from exc
        evidence = self.coloros_securepay_usb_evidence(root)
        if not evidence:
            return False
        parent = parent or {child: node for node in root.iter() for child in node}
        target = self.tappable(evidence["ignore"], parent)
        if target is None:
            raise RuntimeError("coloros_securepay_ignore_not_tappable")
        x, y = self.bounds_center(target.get("bounds"))
        self.adb(["shell", "input", "tap", str(x), str(y)], timeout=8)
        self.emit(
            "dismiss_coloros_securepay_usb_warning",
            driver=driver,
            selector={"package": COLOROS_SECUREPAY_PACKAGE, "resourceId": COLOROS_IGNORE_BUTTON_ID, "text": "忽略"},
            usbModeChanged=False,
            tap={"x": x, "y": y},
        )
        deadline = time.time() + 3.0
        while time.time() < deadline:
            if COLOROS_SECUREPAY_PACKAGE not in "\n".join(self.focus()):
                time.sleep(0.2)
                return True
            time.sleep(0.15)
        raise RuntimeError("coloros_securepay_usb_warning_dismiss_timeout")

    def dismiss_known_overlay(self, root=None, parent=None):
        if self.dismiss_honor_software_update_overlay("xml_uiautomator_focus_adb_back"):
            return True
        if self.dismiss_vivo_wlan_risk_overlay("xml_uiautomator_focus_adb_back"):
            return True
        if "com.hihonor.hndockbar.DockTipDialogActivity" in "\n".join(self.focus()):
            self.adb(["shell", "input", "keyevent", "4"], timeout=5, check=False)
            self.emit("dismiss_honor_dock_tip")
            time.sleep(0.5)
            return True
        if root is None:
            # The optional identity modal can block uiautomator.dump itself.
            # Reuse its exact, two-frame visual proof before the XML read.
            if self.dismiss_canvas_real_name_prompt(None, "before-overlay-dump"):
                return True
            root, parent = self.dump("overlay")
        if self.dismiss_phone_credit_promo_xml(root):
            return True
        if self.dismiss_real_name_prompt_xml(root):
            return True
        ads, closes = self.find(root, desc="全屏广告"), self.find(root, desc="关闭")
        if len(ads) == 1 and len(closes) == 1:
            target = self.tappable(closes[0], parent)
            x, y = self.bounds_center(target.get("bounds"))
            self.adb(["shell", "input", "tap", str(x), str(y)], timeout=8)
            self.emit("dismiss_alipay_fullscreen_ad", tap={"x": x, "y": y})
            time.sleep(0.5)
            return True
        return False

    def dismiss_real_name_prompt_xml(self, root):
        """Close the exact real-name prompt without starting authentication."""
        texts = set(self.texts(root, 160))
        if not {
            ALIPAY_REAL_NAME_PROMPT_TITLE,
            ALIPAY_REAL_NAME_PROMPT_ACTION,
        }.issubset(texts):
            return False
        screen_width, screen_height = self.display_size()
        candidates = []
        for node in root.iter("node"):
            bounds = node.get("bounds") or ""
            match = re.fullmatch(r"\[(\d+),(\d+)\]\[(\d+),(\d+)\]", bounds)
            if not match:
                continue
            left, top, right, bottom = map(int, match.groups())
            width, height = right - left, bottom - top
            center_x, center_y = (left + right) / 2, (top + bottom) / 2
            label = ((node.get("text") or "") + (node.get("content-desc") or "")).strip()
            image_like = (node.get("class") or "") in {
                "android.widget.Image", "android.widget.ImageView", "android.view.View",
            }
            if (
                (label in {"关闭", "×", "✕", "X"} or image_like)
                and screen_width * .38 <= center_x <= screen_width * .62
                and screen_height * .70 <= center_y <= screen_height * .84
                and screen_width * .04 <= width <= screen_width * .18
                and screen_height * .02 <= height <= screen_height * .10
            ):
                candidates.append((int(center_x), int(center_y)))
        if len(candidates) != 1:
            return False
        x, y = candidates[0]
        self.adb(["shell", "input", "tap", str(x), str(y)], timeout=8)
        self.emit(
            "dismiss_alipay_real_name_prompt",
            driver="xml_uiautomator_account_switch",
            evidence="exact_title_action_and_center_close",
            tap={"x": x, "y": y},
            authenticationStarted=False,
        )
        time.sleep(0.4)
        return True

    def dismiss_canvas_modal_after_blocked_my_tab(self, root, token):
        """Dismiss one inaccessible Alipay modal after an evidenced blocked tap.

        Device 107 renders the real-name prompt in a Canvas layer which is
        visible in the screenshot but absent from UIAutomator.  The background
        hierarchy still proves that Home remained selected for six seconds
        after the exact My-tab tap.  In that narrow state a single Back is the
        safe modal-dismiss action; it never chooses authentication or an
        account row.  If Back instead backgrounds Alipay, restore only its
        existing launcher task before the next bounded attempt.
        """
        selected_home = self.find(
            root, desc="首页", resource_id=TAB_SELECTED_FRAME_ID,
        )
        if len(selected_home) != 1:
            return False
        _, current_focus, focused_app = self.focus_state()
        if (
            ALIPAY_PACKAGE not in current_focus
            or "AlipayLogin" not in current_focus
            or "MainSearchActivity" in current_focus
        ):
            return False
        self.adb(["shell", "input", "keyevent", "4"], timeout=5, check=False)
        self.emit(
            "dismiss_alipay_canvas_modal_after_blocked_my_tab",
            token=token,
            evidence="exact_my_tap_then_home_selected_for_six_seconds",
            authenticationStarted=False,
            accountSelected=False,
        )
        time.sleep(0.4)
        _, current_focus, focused_app = self.focus_state()
        if ALIPAY_PACKAGE not in current_focus and ALIPAY_PACKAGE not in focused_app:
            self.resume_alipay_home(f"{token}-after-blocked-my-tab-modal")
        return True

    def dismiss_phone_credit_promo_xml(self, root):
        """Dismiss device 67's exact phone-credit promotion by its X only.

        The X has no stable resource id on the observed Alipay build.  Permit
        a geometry fallback only after three independent promotion texts are
        present and only when exactly one small square/image-like node exists
        in the observed bottom-center close region.  The large claim button is
        excluded by both its text and its width.
        """
        texts = {
            (node.get("text") or node.get("content-desc") or "").strip()
            for node in root.iter("node")
        }
        compact_text = "".join(value.replace(" ", "") for value in texts if value)
        if not (
            ALIPAY_PHONE_CREDIT_PROMO_TITLE in texts
            and ALIPAY_PHONE_CREDIT_PROMO_ACTION in texts
            and ALIPAY_PHONE_CREDIT_PROMO_OFFER in compact_text
        ):
            return False
        screen_width, screen_height = self.display_size()
        candidates = []
        for node in root.iter("node"):
            bounds = node.get("bounds") or ""
            match = re.fullmatch(r"\[(\d+),(\d+)\]\[(\d+),(\d+)\]", bounds)
            if not match:
                continue
            left, top, right, bottom = map(int, match.groups())
            width, height = right - left, bottom - top
            center_x, center_y = (left + right) / 2, (top + bottom) / 2
            label = ((node.get("text") or "") + (node.get("content-desc") or "")).strip()
            image_like = (node.get("class") or "") in {
                "android.widget.Image", "android.widget.ImageView", "android.view.View",
            }
            exact_close = label in {"关闭", "×", "✕", "X"}
            if (
                (image_like or exact_close)
                and screen_width * .35 <= center_x <= screen_width * .65
                and screen_height * .72 <= center_y <= screen_height * .86
                and screen_width * .04 <= width <= screen_width * .18
                and screen_height * .02 <= height <= screen_height * .10
            ):
                candidates.append((node, int(center_x), int(center_y)))
        if len(candidates) != 1:
            self.emit(
                "alipay_phone_credit_promo_close_ambiguous",
                driver="xml_uiautomator_account_switch",
                candidateCount=len(candidates),
                promotedActionTapped=False,
                screenMutationPerformed=False,
            )
            return False
        _, x, y = candidates[0]
        self.adb(["shell", "input", "tap", str(x), str(y)], timeout=8)
        self.emit(
            "dismiss_alipay_phone_credit_promo",
            driver="xml_uiautomator_account_switch",
            evidence=[
                ALIPAY_PHONE_CREDIT_PROMO_TITLE,
                ALIPAY_PHONE_CREDIT_PROMO_OFFER,
                ALIPAY_PHONE_CREDIT_PROMO_ACTION,
            ],
            tap={"x": x, "y": y},
            promotedActionTapped=False,
        )
        time.sleep(0.4)
        return True

    def dismiss_honor_software_update_overlay(self, driver="poco_focus_adb_back"):
        """Close only the exact Honor updater foreground, without choosing Install."""
        _, current_focus, focused_app = self.focus_state()
        if (HONOR_SOFTWARE_UPDATE_PACKAGE not in current_focus
                or ALIPAY_PACKAGE not in focused_app):
            return False
        self.adb(["shell", "input", "keyevent", "4"], timeout=5, check=False)
        self.emit(
            "dismiss_honor_software_update_overlay",
            driver=driver,
            selector={"package": HONOR_SOFTWARE_UPDATE_PACKAGE},
            method="back",
            installStarted=False,
        )
        for _ in range(8):
            _, current_focus, _ = self.focus_state()
            if HONOR_SOFTWARE_UPDATE_PACKAGE not in current_focus:
                time.sleep(0.2)
                return True
            time.sleep(0.2)
        return self.resume_alipay_under_exact_overlay(
            HONOR_SOFTWARE_UPDATE_PACKAGE,
            "resume_alipay_over_honor_software_update_overlay",
            driver,
            installStarted=False,
        )

    @staticmethod
    def vivo_usb_mode_dialog_visible(current_focus):
        return bool(re.search(
            r"mCurrentFocus\s*=\s*Window\{[^}\r\n]*\bu\d+\s+VivoUsbDialog(?:\s|\})",
            str(current_focus or ""),
        ))

    def dismiss_vivo_usb_mode_dialog(self):
        """Cancel the exact USB chooser without selecting a connection mode.

        Device 82's evidenced VivoUsbDialog has a Cancel action below USB mode
        radio buttons. One BACK dismisses the modal; never tap those buttons,
        change a USB property, or relaunch the covered Alipay login activity.
        """
        _, current, focused = self.focus_state()
        if not self.vivo_usb_mode_dialog_visible(current) or ALIPAY_PACKAGE not in focused:
            return False
        try:
            before = str(self.adb(["shell", "getprop", "sys.usb.config"], timeout=3)).strip()
            if not before:
                raise RuntimeError("usb_mode_unavailable")
            _, current, focused = self.focus_state()
            if not self.vivo_usb_mode_dialog_visible(current) or ALIPAY_PACKAGE not in focused:
                raise RuntimeError("foreground_changed")
            self.emit("vivo_usb_mode_dialog_detected", driver="poco_focus_adb_back",
                      method="back", modeSelectionTapped=False, phoneQueryStarted=False)
            self.adb(["shell", "input", "keyevent", "4"], timeout=5)
            for _ in range(4):
                _, current, _ = self.focus_state()
                if current and not re.search(r"mCurrentFocus\s*=\s*null", current) and not self.vivo_usb_mode_dialog_visible(current):
                    after = str(self.adb(["shell", "getprop", "sys.usb.config"], timeout=3)).strip()
                    if after != before:
                        raise RuntimeError("usb_mode_changed_after_cancel")
                    self.emit("dismiss_vivo_usb_mode_dialog", driver="poco_focus_adb_back",
                              method="back", usbModeChanged=False, modeSelectionTapped=False,
                              phoneQueryStarted=False)
                    return True
                time.sleep(0.2)
            raise RuntimeError("cancel_not_confirmed")
        except Exception as exc:
            raise RuntimeError(f"poco_vivo_usb_mode_dialog:{exc}") from exc

    def dismiss_vivo_wlan_risk_overlay(self, driver="poco_focus_adb_back"):
        """Dismiss only the vivo security warning covering an Alipay task.

        Back is deliberately used instead of either dialog action so the
        runner cannot disconnect WLAN or modify a security/network setting.
        """
        _, current_focus, focused_app = self.focus_state()
        if (VIVO_SECURITY_CENTER_PACKAGE not in current_focus
                or ALIPAY_PACKAGE not in focused_app):
            return False
        self.adb(["shell", "input", "keyevent", "4"], timeout=5, check=False)
        self.emit(
            "dismiss_vivo_wlan_risk_overlay",
            driver=driver,
            selector={"package": VIVO_SECURITY_CENTER_PACKAGE},
            method="back",
            networkChanged=False,
        )
        for _ in range(8):
            _, current_focus, _ = self.focus_state()
            if VIVO_SECURITY_CENTER_PACKAGE not in current_focus:
                time.sleep(0.2)
                return True
            time.sleep(0.2)
        return self.resume_alipay_under_exact_overlay(
            VIVO_SECURITY_CENTER_PACKAGE,
            "resume_alipay_over_vivo_wlan_risk_overlay",
            driver,
            networkChanged=False,
        )

    def resume_alipay_under_exact_overlay(self, overlay_package, event, driver, **safety):
        """Bring the already-focused Alipay task above a stubborn OEM overlay.

        This is allowed only while the exact OEM package owns the foreground
        and WindowManager still identifies Alipay as the underlying focused
        task.  It never force-stops either package and never clicks an updater,
        security, login, or network-setting action.
        """
        _, current_focus, focused_app = self.focus_state()
        if overlay_package not in current_focus or ALIPAY_PACKAGE not in focused_app:
            raise RuntimeError(f"{overlay_package}_dismiss_timeout")
        output = self.adb([
            "shell", "am", "start", "-W", "-f", "0x10200000",
            "-a", "android.intent.action.MAIN", "-c", "android.intent.category.LAUNCHER",
            "-n", ALIPAY_HOME,
        ], timeout=12, check=False)
        self.emit(
            event,
            driver=driver,
            selector={"package": overlay_package},
            method="resume_existing_alipay_task",
            detail=str(output)[-300:],
            forceStopped=False,
            **safety,
        )
        for _ in range(6):
            _, current_focus, _ = self.focus_state()
            if ALIPAY_PACKAGE in current_focus:
                time.sleep(0.2)
                return True
            time.sleep(0.2)

        # Some OEM security overlays consume a direct launcher intent and
        # immediately remain top-most.  HOME safely detaches that overlay;
        # launching the already-running Alipay task afterwards reveals the
        # existing task without clicking the warning, changing WLAN state, or
        # force-stopping either package.
        self.adb(["shell", "input", "keyevent", "3"], timeout=5, check=False)
        output = self.adb([
            "shell", "am", "start", "-W", "-f", "0x10200000",
            "-a", "android.intent.action.MAIN", "-c", "android.intent.category.LAUNCHER",
            "-n", ALIPAY_HOME,
        ], timeout=12, check=False)
        self.emit(
            f"{event}_after_home",
            driver=driver,
            selector={"package": overlay_package},
            method="home_then_resume_existing_alipay_task",
            detail=str(output)[-300:],
            forceStopped=False,
            **safety,
        )
        for _ in range(10):
            _, current_focus, _ = self.focus_state()
            if ALIPAY_PACKAGE in current_focus:
                time.sleep(0.2)
                return True
            time.sleep(0.2)
        raise RuntimeError(f"{overlay_package}_resume_alipay_timeout")

    def restart_alipay_for_fresh_poco_after_honor_update(self):
        """Recreate Alipay's device-side Poco bridge after an Honor updater.

        The exact Honor update window can leave the instrumentation bridge in
        the covered Alipay process permanently unresponsive even after the
        safe ``稍后`` action succeeds.  Merely replacing the host worker then
        reconnects to the same dead bridge.  Restart the target app once and
        deliberately return a Poco transport error so the Agent attaches a
        fresh worker to the new process.  This start-only recovery never
        enters a phone number or touches any updater action.
        """
        self.adb(["shell", "am", "force-stop", ALIPAY_PACKAGE], timeout=8)
        output = self.adb([
            "shell", "am", "start", "-W", "-f", "0x10008000",
            "-a", "android.intent.action.MAIN", "-c", "android.intent.category.LAUNCHER",
            "-n", ALIPAY_HOME,
        ], timeout=20, check=False)
        self.emit(
            "restart_alipay_after_honor_update_for_fresh_poco",
            driver="poco_focus_adb",
            detail=str(output)[-300:],
            updateInstallStarted=False,
            phoneQueryStarted=False,
            workerReattachRequired=True,
        )
        raise RuntimeError(
            "poco_rpc_failed:honor_update_dismissed_alipay_restarted_worker_reattach_required"
        )

    def restore_alipay_from_systemui(self, driver="poco_focus_adb"):
        """Reveal Alipay from a non-credential SystemUI/keyguard surface.

        The recovery wakes the panel, asks Android to dismiss the keyguard and
        performs one upward gesture when the OEM still shows “swipe to open”.
        It never enters a credential, taps a notification, or retries beyond
        that single reversible gesture.
        """
        _, current_focus, focused_app = self.focus_state()
        if not self.system_ui_focus_visible(current_focus) or ALIPAY_PACKAGE not in focused_app:
            return False
        self.emit(
            "systemui_covering_alipay_detected",
            driver=driver,
            currentFocus=current_focus[-240:],
            unlockCredentialEntered=False,
        )
        self.adb(["shell", "input", "keyevent", "224"], timeout=5, check=False)
        self.adb(["shell", "wm", "dismiss-keyguard"], timeout=5, check=False)
        # A bare OPPO ``NotificationShade`` is an expanded status panel rather
        # than a credential surface.  Ask SystemUI to collapse it first; if an
        # OEM ignores the command, retain the existing one-gesture fallback.
        self.adb(["shell", "cmd", "statusbar", "collapse"], timeout=5, check=False)
        for _ in range(4):
            _, current_focus, _ = self.focus_state()
            if not self.system_ui_focus_visible(current_focus):
                self.emit(
                    "alipay_revealed_from_systemui",
                    driver=driver, method="dismiss_keyguard",
                    unlockCredentialEntered=False,
                )
                return True
            time.sleep(0.2)
        width, height = self.display_size()
        self.adb([
            "shell", "input", "swipe", str(width // 2), str(int(height * .84)),
            str(width // 2), str(int(height * .32)), "320",
        ], timeout=5, check=False)
        for _ in range(6):
            _, current_focus, _ = self.focus_state()
            if not self.system_ui_focus_visible(current_focus):
                self.emit(
                    "alipay_revealed_from_systemui",
                    driver=driver, method="dismiss_keyguard_then_single_swipe",
                    unlockCredentialEntered=False,
                )
                return True
            time.sleep(0.2)
        raise RuntimeError("alipay_keyguard_blocking_poco")

    def launch(self, reason):
        self.adb(["shell", "input", "keyevent", "224"], timeout=8, check=False)
        self.adb(["shell", "wm", "dismiss-keyguard"], timeout=8, check=False)
        self.adb(["shell", "am", "force-stop", ALIPAY_PACKAGE], timeout=8)
        output = self.adb([
            "shell", "am", "start", "-W", "-f", "0x10008000",
            "-a", "android.intent.action.MAIN", "-c", "android.intent.category.LAUNCHER", "-n", ALIPAY_HOME,
        ], timeout=25, check=False)
        self.emit("launch_alipay", reason=reason, detail=str(output)[-600:])
        time.sleep(1.0)
        self.dismiss_known_overlay()

    def exit_search_activity_for_account_navigation(self, reason, max_attempts=2):
        """Leave only the exact global Search activity with bounded Back.

        This helper never taps coordinates and never acts while an OEM overlay
        or a different app owns concrete focus.  It is deliberately reusable
        after a restriction WebView has been dismissed, where more than the
        two historical Back attempts can be required.
        """
        current_focus = focused_app = ""
        for attempt in range(1, max_attempts + 1):
            _, current_focus, focused_app = self.focus_state()
            if not self.exact_search_activity_visible(current_focus, focused_app):
                return current_focus, focused_app
            self.adb(["shell", "input", "keyevent", "4"], timeout=5, check=False)
            self.emit(
                "exit_search_for_account_navigation",
                reason=reason,
                attempt=attempt,
                previousActivity="MainSearchActivity",
                accountSelected=False,
            )
            deadline = time.time() + 2.0
            while time.time() < deadline:
                _, current_focus, focused_app = self.focus_state()
                if not self.exact_search_activity_visible(current_focus, focused_app):
                    return current_focus, focused_app
                time.sleep(0.15)

            # Some ROM/Alipay combinations keep MainSearchActivity in place
            # after a hardware Back even though the page exposes its own
            # unique, accessible Back control.  Device 158 supplied exact
            # production evidence for this state.  Account navigation is the
            # designed XML flow, so use only that package-owned element as a
            # bounded fallback, then re-check WindowManager before continuing.
            try:
                root, parent = self.dump(
                    f"{self.task_id}-account-search-back-{attempt}",
                    # Android DumpCommand waits up to 10s for accessibility
                    # idle before reading the tree. The old 6s shell deadline
                    # killed healthy reads on device 54 before Back could be
                    # located. Keep a bounded allowance including attach/I/O.
                    command_timeout=15,
                    read_timeout=4,
                    allow_tty_fallback=False,
                )
                # A popup/task change can occur during that bounded read.
                # Never apply an old Search coordinate to the new foreground.
                _, current_focus, focused_app = self.focus_state()
                if not self.exact_search_activity_visible(current_focus, focused_app):
                    return current_focus, focused_app
                self.tap_unique(
                    root,
                    parent,
                    "exit_search_via_exact_back_button",
                    desc="返回",
                    resource_id=SEARCH_BACK_BUTTON_ID,
                )
            except Exception as exc:
                self.emit(
                    "exact_search_back_button_unavailable",
                    reason=reason,
                    attempt=attempt,
                    error=str(exc),
                    accountSelected=False,
                )
                continue

            deadline = time.time() + 2.0
            while time.time() < deadline:
                _, current_focus, focused_app = self.focus_state()
                if not self.exact_search_activity_visible(current_focus, focused_app):
                    return current_focus, focused_app
                time.sleep(0.15)
        _, current_focus, focused_app = self.focus_state()
        if self.exact_search_activity_visible(current_focus, focused_app):
            raise RuntimeError("alipay_account_home_navigation_failed:search_activity_persisted")
        return current_focus, focused_app

    def resume_alipay_home(self, reason):
        """Bring an existing Alipay task home without a destructive cold start."""
        self.adb(["shell", "input", "keyevent", "224"], timeout=8, check=False)
        self.adb(["shell", "wm", "dismiss-keyguard"], timeout=8, check=False)
        output = self.adb([
            "shell", "am", "start", "-W", "-f", "0x10200000",
            "-a", "android.intent.action.MAIN", "-c", "android.intent.category.LAUNCHER", "-n", ALIPAY_HOME,
        ], timeout=20, check=False)
        self.emit("resume_alipay_home", reason=reason, detail=str(output)[-600:])
        time.sleep(0.5)
        self.dismiss_known_overlay()
        # Android's launcher intent can merely bring the existing task to the
        # foreground while keeping MainSearchActivity at the top.  Account
        # navigation must not search that result hierarchy for the Home-only
        # "我的" tab.  Leave only the exact Search activity with bounded Back
        # actions, verifying WindowManager after each action and never tapping
        # a guessed coordinate or an account row.
        current_focus, focused_app = self.exit_search_activity_for_account_navigation(
            reason, max_attempts=4,
        )
        focus_evidence = f"{current_focus}\n{focused_app}".strip()
        if (
            focus_evidence
            and ALIPAY_PACKAGE not in current_focus
            and ALIPAY_PACKAGE not in focused_app
        ):
            raise RuntimeError(
                f"alipay_account_home_navigation_failed:not_alipay_foreground:{current_focus}"
            )
        self.dismiss_known_overlay()

    def wait_unique(self, token, timeout=12, **selector):
        deadline = time.time() + timeout
        root = parent = None
        securepay_recoveries = 0
        transient_reads = 0
        while time.time() < deadline:
            if token == "account-switch-returned-home":
                # A saved account can require login after its exact row was
                # selected. Observe only: retain the selection/cooldown and
                # never treat that login surface as a missing Home element.
                _, current_focus, _ = self.focus_state()
                self.poco_raise_if_login_focus(current_focus, token)
            try:
                root, parent = self.dump(token)
            except (RuntimeError, subprocess.TimeoutExpired) as exc:
                if not isinstance(exc, subprocess.TimeoutExpired) and "uiautomator_hierarchy_missing" not in str(exc):
                    raise
                transient_reads += 1
                self.emit("account_navigation_hierarchy_wait", token=token,
                          attempt=transient_reads, errorType=type(exc).__name__,
                          accountSelected=self.account_switched)
                if transient_reads >= 3 or time.time() >= deadline:
                    raise
                # A page transition may briefly have no idle accessibility
                # root. Retry observation only; never tap the account again.
                time.sleep(0.3)
                continue
            restriction = self.account_restriction_evidence(root)
            if restriction:
                self.raise_account_restriction(restriction, token, "xml_uiautomator")
            verification = self.verification_evidence(root)
            if verification:
                root, parent = self.solve_human_verification(root, parent, token)
            matches = self.find(root, **selector)
            if len(matches) == 1:
                return root, parent, matches[0]
            if len(matches) > 1:
                raise RuntimeError(f"selector_not_unique:{selector!r}")
            if securepay_recoveries < 1 and self.dismiss_coloros_securepay_usb_dialog(
                root, parent, driver="xml_uiautomator",
            ):
                securepay_recoveries += 1
                self.emit("retry_target_after_coloros_securepay_warning", selector=selector, driver="xml_uiautomator")
                continue
            time.sleep(0.35)
        raise RuntimeError(f"selector_missing:{selector!r}; texts={self.texts(root, 50)!r}; focus={self.focus()!r}")

    def open_search(self, reason):
        # Other apps expose the same accessibility description. Never apply
        # their coordinates, or a stale Alipay tree after a foreground change.
        selector = {"desc": "搜索框", "package": ALIPAY_PACKAGE}
        root, parent, _ = self.wait_unique(f"home-{reason}", **selector)
        if self.dismiss_known_overlay(root, parent):
            root, parent, _ = self.wait_unique(f"home-{reason}-after-overlay", **selector)
        _, current, focused = self.focus_state()
        concrete_current = "/" in str(current or "")
        foreground = current if concrete_current else focused
        if not re.search(r"\b" + re.escape(ALIPAY_PACKAGE) + r"/", str(foreground or "")):
            raise RuntimeError("alipay_search_entry_foreground_changed")
        self.tap_unique(root, parent, "open_search", **selector)
        time.sleep(0.7)
        self.wait_unique(f"search-{reason}", resource_id=SEARCH_INPUT_ID, package=ALIPAY_PACKAGE)
        _, current, focused = self.focus_state()
        if not self.exact_search_activity_visible(current, focused):
            raise RuntimeError("alipay_search_entry_foreground_changed")

    def prepare_full_path(self, reason):
        self.launch(reason)
        self.open_search(reason)

    def try_reuse_search_page(self):
        focus = "\n".join(self.focus())
        if "com.eg.android.AlipayGphone" in focus and "MainSearchActivity" in focus:
            self.search_ready()
            self.emit("reuse_existing_search_page", method="already_foreground")
            return True
        activities = self.adb(["shell", "dumpsys", "activity", "activities"], timeout=12, check=False)
        if "com.alipay.android.phone.businesscommon.globalsearch.ui.MainSearchActivity" not in str(activities):
            return False
        self.adb([
            "shell", "am", "start", "-W", "-f", "0x10200000",
            "-a", "android.intent.action.MAIN", "-c", "android.intent.category.LAUNCHER", "-n", ALIPAY_HOME,
        ], timeout=20, check=False)
        time.sleep(0.7)
        self.dismiss_known_overlay()
        self.search_ready()
        self.emit("reuse_existing_search_page", method="resume_existing_task")
        return True

    def search_ready(self):
        focus = "\n".join(self.focus())
        if "com.eg.android.AlipayGphone" not in focus or "MainSearchActivity" not in focus:
            try:
                root, _ = self.dump("search-ready-focus")
                restriction = self.account_restriction_evidence(root)
                if restriction:
                    self.raise_account_restriction(restriction, "search-ready-focus", "xml_uiautomator")
            except Exception as exc:
                if self.account_switch_reason_from_error(exc):
                    raise
                self.emit("account_restriction_probe_unavailable", phase="search-ready-focus", driver="xml_uiautomator", error=str(exc))
            raise RuntimeError(f"alipay_search_not_foreground:{focus}")
        root, parent, input_node = self.wait_unique("search-ready", timeout=5, resource_id=SEARCH_INPUT_ID)
        verification = self.verification_evidence(root)
        if verification:
            root, parent = self.solve_human_verification(root, parent, "search-ready")
            matches = self.find(root, resource_id=SEARCH_INPUT_ID)
            if len(matches) != 1:
                raise RuntimeError("search_input_missing_after_human_verification")
            input_node = matches[0]
        return root, parent, input_node

    def focused_search_input_ready(self):
        """Prove that the reusable Alipay search EditText still owns input focus.

        This is an element-identity fast path, not a coordinate shortcut.  If
        either the foreground Activity or the served resource id differs, the
        caller falls back to the full UIAutomator hierarchy check.
        """
        focus = "\n".join(self.focus())
        if "com.eg.android.AlipayGphone" not in focus or "MainSearchActivity" not in focus:
            return False
        state = str(self.adb(["shell", "dumpsys", "input_method"], timeout=8, check=False))
        served = re.search(
            r"mServedView=.*com\.alipay\.mobile\.antui:id/search_input_box",
            state,
        )
        current_editor = re.search(
            r"mCurrent(?:EditorInfo|TextBoxAttribute):[\s\S]{0,800}?"
            r"packageName=com\.eg\.android\.AlipayGphone",
            state,
        )
        return bool(served and current_editor)

    def focused_search_input_length(self):
        """Return the real focused EditText cursor length, excluding its hint.

        Alipay exposes rotating search hints through Accessibility/Poco's
        ``text`` attribute even while the EditText is actually empty. Some
        hints contain digits (for example an amount), so digit-counting that
        attribute can incorrectly look like a partially entered phone. The
        active input connection's cursor is based on editable content and does
        not include the hint.
        """
        focus = "\n".join(self.focus())
        if "com.eg.android.AlipayGphone" not in focus or "MainSearchActivity" not in focus:
            return None
        state = str(self.adb(
            ["shell", "dumpsys", "input_method"], timeout=8, check=False,
        ))
        if not re.search(
            r"mServedView=.*com\.alipay\.mobile\.antui:id/search_input_box",
            state,
        ):
            return None
        if not re.search(
            r"mCurrent(?:EditorInfo|TextBoxAttribute):[\s\S]{0,800}?"
            r"packageName=com\.eg\.android\.AlipayGphone",
            state,
        ):
            return None
        cursors = re.findall(
            r"mCursorSelStart=(\d+)\s+mCursorSelEnd=(\d+)", state,
        )
        if not cursors:
            return None
        start, end = map(int, cursors[-1])
        return max(start, end)

    @staticmethod
    def descendant_texts(node):
        values = []
        for child in node.iter("node"):
            for key in ("text", "content-desc"):
                value = (child.get(key) or "").strip()
                if value and value not in values:
                    values.append(value)
        return values

    @staticmethod
    def not_real_named_display_matches(display, phone):
        compact = re.sub(r"\s+", "", str(display or ""))
        match = re.fullmatch(r"(\d{3})\*+(\d{2})[\(（]未实名[\)）]", compact)
        return bool(
            match
            and str(phone).startswith(match.group(1))
            and str(phone).endswith(match.group(2))
        )

    @staticmethod
    def not_real_named_result(display, phone, match_method):
        return {
            "alipayDisplayName": str(display or ""),
            "realNameTailCharacter": "",
            "matchedPhone": phone,
            "matchMethod": match_method,
            "notFound": True,
            "message": "account_not_real_named",
        }

    def emit_query_result(self, result, driver=""):
        detail = {"matchMethod": result.get("matchMethod", "")}
        if driver:
            detail["driver"] = driver
        if result.get("notFound"):
            self.emit(
                "lookup_no_name_result",
                reason=result.get("message", "no_name_result"),
                **detail,
            )
            return
        self.emit(
            "masked_real_name_tail_extracted",
            character=result["realNameTailCharacter"],
            **detail,
        )

    def parse_result(self, root, parent, phone):
        parent = parent or {child: node for node in root.iter() for child in node}
        patterns = [
            re.compile(r"[\(（]\*+(?:·\*+)*([^\(\)（）\s])[\)）]\s*$"),
            re.compile(r"^\*+([\u4e00-\u9fff])$"),
            re.compile(r"^.{1,12}\*+([\u4e00-\u9fff])$"),
        ]
        candidates = []
        not_real_named_candidates = []
        for node in root.iter("node"):
            display = (node.get("text") or "").strip()
            if self.not_real_named_display_matches(display, phone):
                not_real_named_candidates.append((node, display))
            match = next((pattern.search(display) for pattern in patterns if pattern.search(display)), None)
            if match:
                candidates.append((node, display, next(group for group in match.groups() if group)))

        for node, display in not_real_named_candidates:
            current = node
            for _ in range(10):
                if current is None:
                    break
                values = self.descendant_texts(current)
                if phone in values and ("转账" in values or "加好友" in values):
                    return self.not_real_named_result(
                        display, phone, "same_accessibility_unverified_account_container",
                    )
                current = parent.get(current)

        for node, display, tail in candidates:
            current = node
            for _ in range(10):
                if current is None:
                    break
                values = self.descendant_texts(current)
                if phone in values and ("转账" in values or "加好友" in values):
                    return {
                        "alipayDisplayName": display, "realNameTailCharacter": tail,
                        "matchedPhone": phone, "matchMethod": "same_accessibility_result_container",
                    }
                current = parent.get(current)

        actions = {
            (node.get("text") or "").strip()
            for node in root.iter("node")
            if (node.get("text") or "").strip() in {"转账", "加好友"}
        }
        phone_nodes = [
            node for node in root.iter("node")
            if (node.get("text") or "").strip() == phone and node.get("bounds")
        ]
        if {"转账", "加好友"}.issubset(actions):
            for node, display in not_real_named_candidates:
                if not node.get("bounds"):
                    continue
                _, name_y = self.bounds_center(node.get("bounds"))
                for phone_node in phone_nodes:
                    _, phone_y = self.bounds_center(phone_node.get("bounds"))
                    if 0 < phone_y - name_y < 140:
                        return self.not_real_named_result(
                            display, phone, "element_geometry_unverified_account",
                        )
            for node, display, tail in candidates:
                if not node.get("bounds"):
                    continue
                _, name_y = self.bounds_center(node.get("bounds"))
                for phone_node in phone_nodes:
                    _, phone_y = self.bounds_center(phone_node.get("bounds"))
                    if 0 < phone_y - name_y < 140:
                        return {
                            "alipayDisplayName": display, "realNameTailCharacter": tail,
                            "matchedPhone": phone,
                            "matchMethod": "element_geometry_plus_exact_account_actions",
                        }
        return None

    @staticmethod
    def poco_text(node):
        for key in ("text", "desc"):
            try:
                value = (node.attr(key) or "").strip()
            except Exception:
                value = ""
            if value:
                return value
        return ""

    @staticmethod
    def poco_nodes(snapshot, **selector):
        try:
            proxy = snapshot(**selector)
            if isinstance(proxy, (list, tuple)):
                return list(proxy)
            if not proxy.exists():
                return []
            return list(proxy)
        except Exception as exc:
            # Poco may expose a normal absent optional node as an exception
            # while materializing the proxy (observed on vivo). Normalize only
            # this exact no-node semantic; transport and RPC errors still fail.
            if "Cannot find any visible node by query" in str(exc):
                return []
            raise

    def poco_snapshot_texts(self, snapshot, limit=120):
        values = []
        for node_type in ("android.widget.TextView", "android.view.View", "android.widget.Button"):
            for node in self.poco_nodes(snapshot, type=node_type):
                value = self.poco_text(node)
                if value and value not in values:
                    values.append(value)
                    if len(values) >= limit:
                        return values
        return values

    def poco_verification_evidence(self, snapshot):
        texts = set(self.poco_snapshot_texts(snapshot, 160))
        action = JIGSAW_VERIFICATION_ACTION if JIGSAW_VERIFICATION_ACTION in texts else VERIFICATION_ACTION
        feedback = next((value for value in texts if value.startswith(JIGSAW_FEEDBACK_PREFIX)), "")
        if VERIFICATION_TITLE in texts and (action in texts or feedback):
            return {
                "title": VERIFICATION_TITLE,
                "action": action if action in texts else "",
                "feedback": feedback,
                "manual": action == JIGSAW_VERIFICATION_ACTION or bool(feedback),
            }
        return None

    def poco_access_denied_evidence(self, snapshot):
        return self.access_denied_evidence_from_texts(self.poco_snapshot_texts(snapshot, 160))

    def poco_account_restriction_evidence(self, snapshot):
        return self.account_restriction_evidence_from_texts(self.poco_snapshot_texts(snapshot, 200))

    def poco_raise_if_account_restricted(self, snapshot, phase, phone_query_started=False):
        evidence = self.poco_account_restriction_evidence(snapshot)
        if evidence:
            self.raise_account_restriction(
                evidence, phase, "poco", phone_query_started=phone_query_started,
            )

    def poco_raise_if_login_required(self, snapshot, phase):
        texts = set(self.poco_snapshot_texts(snapshot, 120))
        sms_required = {"短信验证码登录", "其他验证方式"}
        sms_corroborating = {"换号", "注册账号", "遇到问题"}
        carrier_required = {"本机号码一键登录", "同意支付宝向运营商获取完整本机号码"}
        sms_login = sms_required.issubset(texts) and texts.intersection(sms_corroborating)
        carrier_login = carrier_required.issubset(texts) and "换号" in texts
        if sms_login or carrier_login:
            self.emit(
                "alipay_login_required_detected",
                phase=phase,
                driver="poco",
                phoneQueryStarted=False,
                loginSurface="sms_code" if sms_login else "carrier_one_tap",
            )
            raise RuntimeError("poco_alipay_login_required")

    def poco_raise_if_login_focus(self, focus, phase):
        """Fail closed on the exact Alipay login activity seen by WindowManager.

        `.AlipayLogin` is Alipay's normal launcher/home activity and must not be
        confused with the actual account-login activity below.
        """
        normalized = str(focus or "")
        if ALIPAY_LOGIN_ACTIVITY not in normalized:
            return
        self.emit(
            "alipay_login_required_detected",
            phase=phase,
            driver="poco_window_focus",
            phoneQueryStarted=False,
            loginSurface="login_activity",
            activity=ALIPAY_LOGIN_ACTIVITY,
        )
        raise RuntimeError("poco_alipay_login_required")

    def poco_raise_if_access_denied(self, snapshot, phase):
        # Backward-compatible alias for tests and older worker callers.
        self.poco_raise_if_account_restricted(snapshot, phase)

    def poco_wait_for_post_query_restriction(self, poco, phase, timeout=6.0):
        deadline = time.time() + timeout
        last_texts = []
        while time.time() < deadline:
            try:
                snapshot = poco.freeze()
                last_texts = self.poco_snapshot_texts(snapshot, 200)
                verification = self.poco_verification_evidence(snapshot)
                if verification and verification.get("manual"):
                    self.emit(
                        "human_verification_detected", evidence=verification,
                        token=phase, driver="poco",
                    )
                    raise RuntimeError(
                        "poco_alipay_human_verification_required:jigsaw_verification"
                    )
                evidence = self.account_restriction_evidence_from_texts(last_texts)
                if evidence:
                    self.raise_account_restriction(
                        evidence, phase, "poco", phone_query_started=True,
                    )
            except Exception as exc:
                if "human_verification_required" in str(exc):
                    raise
                if self.account_switch_reason_from_error(exc):
                    raise
                self.emit(
                    "post_query_restriction_probe_retry", phase=phase,
                    driver="poco", error=str(exc),
                )
            time.sleep(0.2)
        self.emit(
            "post_query_restriction_not_observed", phase=phase,
            driver="poco", texts=last_texts[:30],
        )

    def poco_slider_geometry(self, snapshot):
        entries = []
        node_types = (
            "android.widget.FrameLayout", "android.widget.LinearLayout",
            "android.widget.RelativeLayout", "android.widget.TextView", "android.view.View",
        )
        for node_type in node_types:
            for node in self.poco_nodes(snapshot, type=node_type):
                try:
                    x, y = node.get_position()
                    width, height = node.get_size()
                except Exception:
                    continue
                entries.append((node, self.poco_text(node), x, y, width, height, node_type))
        anchors = [entry for entry in entries if VERIFICATION_ACTION in entry[1]]
        if len(anchors) != 1:
            return None
        anchor_y = anchors[0][3]
        tracks = [
            entry for entry in entries
            if entry[4] >= 0.45 and 0.015 <= entry[5] <= 0.12 and abs(entry[3] - anchor_y) <= 0.055
        ]
        if not tracks:
            return None
        track = max(tracks, key=lambda entry: entry[4])
        _, _, center_x, center_y, width, height, node_type = track
        left, right = center_x - width / 2, center_x + width / 2
        return {
            "track": (left, center_y - height / 2, right, center_y + height / 2),
            "nodeType": node_type,
        }

    def poco_solve_human_verification(self, poco, token, max_attempts=3):
        query_after_input = str(token).startswith(("input-readback-", "result-"))

        def freeze_verification(stage):
            try:
                return poco.freeze()
            except Exception as exc:
                # The phone number has already been submitted when query-side
                # verification is handled. A Poco HTTP timeout while checking
                # the slider must therefore enter the Agent's query_resume
                # rail: rebuild the transport and inspect the existing page,
                # but never type or submit the number again.
                if query_after_input:
                    self.emit(
                        "human_verification_result_channel_timeout",
                        stage=stage, token=token, driver="poco",
                        resubmitsInput=False,
                    )
                    raise RuntimeError(
                        "poco_query_result_channel_timeout_after_input:"
                        f"slider_{stage}:{type(exc).__name__}:{exc}"
                    ) from exc
                raise

        snapshot = freeze_verification("initial_snapshot")
        evidence = self.poco_verification_evidence(snapshot)
        if not evidence:
            return False
        self.emit(
            "human_verification_detected", evidence=evidence, token=token, driver="poco",
            requiresHuman=bool(evidence.get("manual")), automatedAttempts=0,
            resubmitsInput=False,
        )
        if evidence.get("manual"):
            raise RuntimeError("poco_alipay_human_verification_required:jigsaw_verification")
        width, height = self.display_size()
        for attempt in range(1, max_attempts + 1):
            geometry = self.poco_slider_geometry(snapshot)
            if not geometry:
                self.emit("human_verification_geometry_missing", attempt=attempt, driver="poco")
                raise RuntimeError("poco_basic_slider_geometry_missing")
            left, top, right, bottom = geometry["track"]
            knob_half = max(8, int(round((bottom - top) * height / 2)))
            start_x = max(1, min(width - 1, int(round(left * width)) + knob_half))
            start_y = max(1, min(height - 1, int(round(((top + bottom) / 2) * height))))
            end_x = max(1, width - 10)
            duration_ms = 2200 + (attempt - 1) * 300
            self.adb([
                "shell", "input", "swipe", str(start_x), str(start_y),
                str(end_x), str(start_y), str(duration_ms),
            ], timeout=15)
            self.emit(
                "human_verification_slider_drag", attempt=attempt,
                start=[start_x, start_y], end=[end_x, start_y], durationMs=duration_ms,
                track=[round(value, 4) for value in geometry["track"]],
                trackNodeType=geometry["nodeType"], driver="poco",
            )
            time.sleep(1.5)
            snapshot = freeze_verification(f"attempt_{attempt}")
            if not self.poco_verification_evidence(snapshot):
                self.human_verification_passes += 1
                self.emit("human_verification_passed", attempt=attempt, token=token, driver="poco")
                return True
            self.emit("human_verification_retry", attempt=attempt, driver="poco")
        self.emit("human_verification_failed", token=token, attempts=max_attempts, driver="poco")
        raise RuntimeError("poco_alipay_basic_slider_verification_failed")

    def parse_poco_result(self, snapshot, phone):
        """Extract the same evidenced result from one frozen Poco snapshot."""
        patterns = [
            re.compile(r"[\(（]\*+(?:·\*+)*([^\(\)（）\s])[\)）]\s*$"),
            re.compile(r"^\*+([\u4e00-\u9fff])$"),
            re.compile(r"^.{1,12}\*+([\u4e00-\u9fff])$"),
        ]
        nodes = []
        for node_type in ("android.widget.TextView", "android.view.View", "android.widget.Button"):
            nodes.extend(self.poco_nodes(snapshot, type=node_type))
        entries = []
        for node in nodes:
            text = self.poco_text(node)
            if not text:
                continue
            try:
                position = node.get_position()
            except Exception:
                position = None
            entries.append((node, text, position))

        actions = {text for _, text, _ in entries if text in {"转账", "加好友"}}
        if not {"转账", "加好友"}.issubset(actions):
            return None
        phones = [entry for entry in entries if entry[1] == phone and entry[2] is not None]
        not_real_named_candidates = [
            entry for entry in entries
            if entry[2] is not None and self.not_real_named_display_matches(entry[1], phone)
        ]
        for _, display, (_, name_y) in not_real_named_candidates:
            for _, _, (_, phone_y) in phones:
                if 0 < phone_y - name_y < 0.12:
                    return self.not_real_named_result(
                        display, phone, "poco_geometry_unverified_account",
                    )
        candidates = []
        for node, display, position in entries:
            match = next((pattern.search(display) for pattern in patterns if pattern.search(display)), None)
            if match and position is not None:
                candidates.append((node, display, next(group for group in match.groups() if group), position))
        for _, display, tail, (_, name_y) in candidates:
            for _, _, (_, phone_y) in phones:
                # Poco positions are normalized. The XML path accepts a name
                # up to 140 px above the exact phone row; 0.12 safely covers
                # that distance across the supported fleet resolutions.
                if 0 < phone_y - name_y < 0.12:
                    return {
                        "alipayDisplayName": display,
                        "realNameTailCharacter": tail,
                        "matchedPhone": phone,
                        "matchMethod": "poco_geometry_plus_exact_account_actions",
                    }
        return None

    def poco_unique(self, poco, timeout=3.0, live=True, **selector):
        deadline = time.time() + timeout
        last_count = 0
        while time.time() < deadline:
            try:
                # Materialize one hierarchy first and evaluate the selector on
                # that frozen snapshot.  Some vivo builds let a live proxy's
                # exists()/list() block for the Agent's full task timeout when
                # the element is absent, ignoring the intended 3-second loop.
                # A frozen Poco hierarchy keeps the UI source and selectors in
                # Poco while making the missing-element decision local.  The
                # snapshot node is read-only, so return a fresh live proxy only
                # after the frozen hierarchy has proved the selector unique.
                freeze = getattr(poco, "freeze", None)
                scope = freeze() if callable(freeze) else poco
                nodes = self.poco_nodes(scope, **selector)
            except Exception as exc:
                raise RuntimeError(f"poco_rpc_failed:{exc}") from exc
            last_count = len(nodes)
            if last_count == 1:
                # Taps need only stable coordinates and must use the frozen
                # node that proved uniqueness. Returning a second live proxy
                # can race an OEM overlay between the snapshot and
                # get_position(). Inputs still request a live node because
                # set_text is an RPC operation.
                return poco(**selector) if live else nodes[0]
            if last_count > 1:
                raise RuntimeError(f"poco_selector_not_unique:{selector!r}")
            time.sleep(0.15)
        raise RuntimeError(f"poco_selector_missing:{selector!r}; count={last_count}")

    def poco_search_ready(self, poco, live=True):
        _, current_focus, focused_app = self.focus_state()
        foreground = focused_window_name([current_focus]) or ""
        if foreground.startswith(ALIPAY_PACKAGE) and not foreground.startswith(ALIPAY_PACKAGE + "/"):
            raise RuntimeError(f"poco_alipay_search_not_foreground:{current_focus}")
        if self.vivo_usb_mode_dialog_visible(current_focus):
            if not self.dismiss_vivo_usb_mode_dialog():
                raise RuntimeError("poco_vivo_usb_mode_dialog:underlying_task_unverified")
            _, current_focus, focused_app = self.focus_state()
        if self.system_ui_focus_visible(current_focus) and ALIPAY_PACKAGE in focused_app:
            self.restore_alipay_from_systemui()
            self.emit("retry_search_ready_after_systemui", driver="poco")
            _, current_focus, focused_app = self.focus_state()
        if HONOR_SOFTWARE_UPDATE_PACKAGE in current_focus:
            if not self.poco_dismiss_honor_software_update_dialog(poco):
                self.dismiss_honor_software_update_overlay()
            self.emit("retry_search_ready_after_honor_software_update", driver="poco")
            _, current_focus, focused_app = self.focus_state()
        if VIVO_SECURITY_CENTER_PACKAGE in current_focus:
            if not self.poco_dismiss_vivo_wlan_risk_dialog(poco):
                self.dismiss_vivo_wlan_risk_overlay()
            self.emit("retry_search_ready_after_vivo_wlan_risk", driver="poco")
            _, current_focus, focused_app = self.focus_state()
        self.poco_raise_if_login_focus(current_focus, "search-ready-focus")
        self.emit(
            "poco_search_ready_focus",
            searchForeground=(ALIPAY_PACKAGE in current_focus and "MainSearchActivity" in current_focus),
            underlyingAlipayTask=(ALIPAY_PACKAGE in focused_app),
            driver="poco",
        )
        if COLOROS_SECUREPAY_PACKAGE in current_focus:
            if self.poco_dismiss_coloros_securepay_usb_dialog(poco):
                self.emit(
                    "retry_search_ready_after_coloros_securepay_warning",
                    selector={"name": SEARCH_INPUT_ID}, driver="poco",
                )
                _, current_focus, focused_app = self.focus_state()
        if ALIPAY_PACKAGE not in current_focus or "MainSearchActivity" not in current_focus:
            # Only ask Poco for an Alipay hierarchy when Alipay truly owns the
            # current focus. An unrelated system surface blocks that channel.
            if ALIPAY_PACKAGE in current_focus:
                try:
                    self.emit("poco_search_ready_restriction_probe_begin", driver="poco")
                    snapshot = poco.freeze()
                    self.emit("poco_search_ready_restriction_probe_done", driver="poco")
                    self.poco_raise_if_login_required(snapshot, "search-ready-focus")
                    self.poco_raise_if_account_restricted(snapshot, "search-ready-focus")
                except Exception as exc:
                    if self.account_switch_reason_from_error(exc) or "poco_alipay_login_required" in str(exc):
                        raise
                    self.emit("account_restriction_probe_unavailable", phase="search-ready-focus", driver="poco", error=str(exc))
            raise RuntimeError(f"poco_alipay_search_not_foreground:{current_focus}")
        self.poco_dismiss_local_service_prompt(poco)
        try:
            self.emit("poco_search_input_probe_begin", driver="poco")
            return self.poco_unique(poco, timeout=2.0, live=live, name=SEARCH_INPUT_ID)
        except Exception as exc:
            if "poco_selector_missing:" in str(exc) and self.poco_dismiss_local_service_prompt(poco):
                return self.poco_unique(poco, timeout=2.0, live=live, name=SEARCH_INPUT_ID)
            if (
                "poco_selector_missing:" in str(exc)
                and self.solve_verification_from_xml_if_present("poco-search-ready")
            ):
                return self.poco_unique(poco, timeout=5.0, live=live, name=SEARCH_INPUT_ID)
            try:
                snapshot = poco.freeze()
                self.poco_raise_if_account_restricted(snapshot, "search-ready-selector")
            except Exception as probe_exc:
                if self.account_switch_reason_from_error(probe_exc):
                    raise
            raise exc

    def poco_dismiss_local_service_prompt(self, poco):
        """Close the optional location introduction evidenced on device 57.

        This is Alipay's own introduction, not Android's permission dialog.
        Require exact resource IDs, title, explanation and Next button, then
        tap only the unique enabled Cancel/Close element. Never grant location
        permission or navigate using the promotional Next action.
        """
        prefix = "com.alipay.mobile.antui:id/"
        try:
            titles = self.poco_nodes(poco, name=prefix + "title_txt_1", text=ALIPAY_LOCAL_SERVICE_TITLE)
            if not titles:
                return False
            hints = self.poco_nodes(poco, name=prefix + "title_txt_2", text=ALIPAY_LOCAL_SERVICE_HINT)
            actions = self.poco_nodes(poco, name=prefix + "buttomButtonView", text="下一步")
            closes = self.poco_nodes(poco, name=prefix + "btn_close", desc="取消")
        except Exception as exc:
            raise RuntimeError(f"poco_rpc_failed:{exc}") from exc
        self.emit("alipay_local_service_prompt_detected", titleCount=len(titles), hintCount=len(hints),
                  actionCount=len(actions), closeCount=len(closes), driver="poco", permissionRequested=False)
        if any(len(nodes) != 1 for nodes in (titles, hints, actions, closes)):
            raise RuntimeError("poco_alipay_local_service_close_unverified")
        close = closes[0]
        if (close.attr("package") != ALIPAY_PACKAGE or close.attr("enabled") is not True
                or close.attr("touchable") is not True):
            raise RuntimeError("poco_alipay_local_service_close_unverified")
        _, current_focus, _ = self.focus_state()
        if ALIPAY_PACKAGE not in current_focus:
            raise RuntimeError("poco_alipay_local_service_foreground_changed")
        self.poco_tap(close)
        self.emit("dismiss_alipay_local_service_prompt", driver="poco", action="cancel",
                  permissionRequested=False, nextButtonTapped=False, phoneQueryStarted=False)
        for _ in range(3):
            time.sleep(0.2)
            if not self.poco_nodes(poco, name=prefix + "title_txt_1", text=ALIPAY_LOCAL_SERVICE_TITLE):
                return True
        raise RuntimeError("poco_alipay_local_service_not_dismissed")

    def poco_dismiss_known_overlay(self, poco):
        if self.poco_dismiss_honor_software_update_dialog(poco):
            return True
        if self.dismiss_honor_software_update_overlay():
            return True
        if self.poco_dismiss_vivo_wlan_risk_dialog(poco):
            return True
        if self.dismiss_vivo_wlan_risk_overlay():
            return True
        if "com.hihonor.hndockbar.DockTipDialogActivity" in "\n".join(self.focus()):
            self.adb(["shell", "input", "keyevent", "4"], timeout=5, check=False)
            self.emit("dismiss_honor_dock_tip")
            time.sleep(0.4)
            return True
        try:
            snapshot = poco.freeze()
            return self.poco_dismiss_alipay_home_overlay_snapshot(snapshot)
        except Exception as exc:
            raise RuntimeError(f"poco_rpc_failed:{exc}") from exc

    def poco_dismiss_alipay_home_overlay_snapshot(self, snapshot):
        """Close only exact, evidenced Alipay home overlays.

        Alipay leaves the home Search node in the hierarchy while a modal or
        full-screen promotion intercepts its tap.  Inspect one frozen
        hierarchy and close the safe action before the background Search node
        can be selected.  Promotional/identity-verification actions are never
        tapped.
        """
        if self.poco_dismiss_phone_credit_promo_snapshot(snapshot):
            return True
        ads = self.poco_nodes(snapshot, desc="全屏广告")
        closes = self.poco_nodes(snapshot, desc="关闭")
        modal_closes = []
        for node in closes:
            try:
                x, y = node.get_position()
            except Exception:
                continue
            if 0.35 <= x <= 0.65 and 0.62 <= y <= 0.90:
                modal_closes.append(node)
        if len(ads) == 1 and len(modal_closes) == 1:
            self.poco_tap(modal_closes[0])
            self.emit(
                "dismiss_alipay_fullscreen_ad",
                driver="poco",
                evidence="exact_fullscreen_ad_and_close",
                promotedActionTapped=False,
            )
            time.sleep(0.4)
            return True

        real_name_titles = self.poco_nodes(
            snapshot, text=ALIPAY_REAL_NAME_PROMPT_TITLE,
        )
        real_name_actions = self.poco_nodes(
            snapshot, text=ALIPAY_REAL_NAME_PROMPT_ACTION,
        )
        if (
            len(real_name_titles) == 1
            and len(real_name_actions) == 1
            and len(modal_closes) == 1
        ):
            self.poco_tap(modal_closes[0])
            self.emit(
                "dismiss_alipay_real_name_prompt",
                driver="poco",
                evidence="exact_title_action_and_close",
                authenticationStarted=False,
            )
            time.sleep(0.4)
            return True
        return False

    def poco_dismiss_phone_credit_promo_snapshot(self, snapshot):
        """Dismiss the exact phone-credit promotion observed on device 67."""
        texts = set(self.poco_snapshot_texts(snapshot, 160))
        compact_text = "".join(value.replace(" ", "") for value in texts)
        if not (
            ALIPAY_PHONE_CREDIT_PROMO_TITLE in texts
            and ALIPAY_PHONE_CREDIT_PROMO_ACTION in texts
            and ALIPAY_PHONE_CREDIT_PROMO_OFFER in compact_text
        ):
            return False
        candidates = []
        seen = set()
        for node_type in (
            "android.widget.Image", "android.widget.ImageView", "android.view.View",
        ):
            for node in self.poco_nodes(snapshot, type=node_type):
                key = id(node)
                if key in seen:
                    continue
                seen.add(key)
                try:
                    x, y = node.get_position()
                    width, height = node.get_size()
                except Exception:
                    continue
                label = self.poco_text(node)
                if (
                    (not label or label in {"关闭", "×", "✕", "X"})
                    and .35 <= x <= .65
                    and .72 <= y <= .86
                    and .04 <= width <= .18
                    and .02 <= height <= .10
                ):
                    candidates.append(node)
        if len(candidates) != 1:
            self.emit(
                "alipay_phone_credit_promo_close_ambiguous",
                driver="poco",
                candidateCount=len(candidates),
                promotedActionTapped=False,
                screenMutationPerformed=False,
            )
            return False
        close = candidates[0]
        self.poco_tap(close)
        self.emit(
            "dismiss_alipay_phone_credit_promo",
            driver="poco",
            evidence=[
                ALIPAY_PHONE_CREDIT_PROMO_TITLE,
                ALIPAY_PHONE_CREDIT_PROMO_OFFER,
                ALIPAY_PHONE_CREDIT_PROMO_ACTION,
            ],
            promotedActionTapped=False,
        )
        time.sleep(0.4)
        return True

    def poco_dismiss_fullscreen_ad_live(self, poco):
        # Image-rendered Home promotions need not expose their painted title
        # as text. Reuse the existing exact fullscreen-ad + modal-Close rule,
        # but query only those nodes instead of serializing the entire Home.
        ads = self.poco_nodes(poco, desc="全屏广告")
        if not ads:
            return False
        closes = []
        for node in self.poco_nodes(poco, desc="关闭"):
            x, y = node.get_position()
            if 0.35 <= x <= 0.65 and 0.62 <= y <= 0.90:
                closes.append(node)
        self.emit("alipay_fullscreen_ad_live_evidence", adCount=len(ads), closeCount=len(closes), fullHierarchyRequested=False, driver="poco")
        if len(ads) != 1 or len(closes) != 1:
            raise RuntimeError("poco_fullscreen_ad_close_unavailable")
        _, current_focus, _ = self.focus_state()
        if ALIPAY_PACKAGE not in current_focus:
            raise RuntimeError("poco_fullscreen_ad_foreground_changed")
        self.poco_tap(closes[0])
        self.emit("dismiss_alipay_fullscreen_ad", evidence="exact_live_fullscreen_ad_and_close", promotedActionTapped=False, authenticationStarted=False, fullHierarchyRequested=False, driver="poco")
        for _ in range(3):
            time.sleep(0.3)
            if not self.poco_nodes(poco, desc="全屏广告"):
                return True
        raise RuntimeError("poco_fullscreen_ad_not_dismissed")

    def poco_dismiss_real_name_prompt_live(self, poco):
        """Close only the evidenced optional Home prompt, without a tree dump.

        Device 188 exposes Search underneath this modal. Full hierarchy
        serialization stalls on that Home, although exact selectors respond.
        Require the exact prompt title, action and one modal Close element;
        never press the authentication action or use screenshot coordinates.
        """
        title = None
        for value in (ALIPAY_REAL_NAME_PROMPT_TITLE_188, ALIPAY_REAL_NAME_PROMPT_TITLE):
            titles = self.poco_nodes(poco, text=value)
            if len(titles) == 1:
                title = value
                break
            if len(titles) > 1:
                raise RuntimeError("poco_real_name_prompt_title_ambiguous")
        if title is None:
            return False
        actions = self.poco_nodes(poco, text=ALIPAY_REAL_NAME_PROMPT_ACTION)
        closes = []
        for node in self.poco_nodes(poco, desc="关闭"):
            x, y = node.get_position()
            if 0.35 <= x <= 0.65 and 0.62 <= y <= 0.90:
                closes.append(node)
        self.emit(
            "alipay_real_name_prompt_live_evidence", title=title,
            actionCount=len(actions), closeCount=len(closes),
            fullHierarchyRequested=False, authenticationStarted=False, driver="poco",
        )
        if len(actions) != 1 or len(closes) != 1:
            raise RuntimeError("poco_real_name_prompt_close_unavailable")
        _, current_focus, _ = self.focus_state()
        if ALIPAY_PACKAGE not in current_focus:
            raise RuntimeError("poco_real_name_prompt_foreground_changed")
        self.poco_tap(closes[0])
        self.emit(
            "dismiss_alipay_real_name_prompt", title=title,
            evidence="exact_live_title_action_and_close", driver="poco",
            authenticationStarted=False, fullHierarchyRequested=False,
        )
        # Observe dismissal only. Do not repeat the close or tap the Search
        # proxy cached while the modal still covered the underlying Home.
        for _ in range(3):
            time.sleep(0.3)
            if not self.poco_nodes(poco, text=title):
                return True
        raise RuntimeError("poco_real_name_prompt_not_dismissed")

    def poco_live_home_search_target(self, poco):
        """Return one live home Search proxy without materializing the full tree.

        A few older Honor builds can answer a narrow selector in under one
        second while serializing Alipay's full home hierarchy takes longer
        than the bounded Poco transport timeout.  Asking the device for the
        unique Search node first keeps that healthy home page off the heavy
        hierarchy path.  Missing Search still falls through to the frozen
        snapshot path so login, restriction and covered-home surfaces retain
        their exact multi-element validation.
        """
        try:
            target = poco(desc="搜索框")
            try:
                count = len(target)
            except TypeError:
                # Simple test doubles and older proxy implementations do not
                # expose the multiple-query length contract.  Preserve the
                # frozen hierarchy implementation for them.
                return None
        except Exception as exc:
            raise RuntimeError(f"poco_rpc_failed:{exc}") from exc
        if count == 1:
            if self.poco_dismiss_fullscreen_ad_live(poco) or self.poco_dismiss_real_name_prompt_live(poco):
                try:
                    target = poco(desc="搜索框")
                    count = len(target)
                except Exception as exc:
                    raise RuntimeError(f"poco_rpc_failed:{exc}") from exc
                if count != 1:
                    raise RuntimeError(f"poco_selector_not_unique_after_prompt:count={count}")
            self.emit(
                "poco_home_search_live_target",
                selector={"desc": "搜索框"},
                unique=True,
                fullHierarchyDeferred=True,
                driver="poco",
            )
            return target
        if count > 1:
            raise RuntimeError("poco_selector_not_unique:{'desc': '搜索框'}")
        return None

    def poco_home_search_target(self, poco, timeout=3.0):
        """Return Search from a narrow live query or uncovered frozen home."""
        live_target = self.poco_live_home_search_target(poco)
        if live_target is not None:
            return live_target
        deadline = time.time() + timeout
        last_count = 0
        while time.time() < deadline:
            try:
                snapshot = poco.freeze()
                if self.poco_dismiss_alipay_home_overlay_snapshot(snapshot):
                    continue
                searches = self.poco_nodes(snapshot, desc="搜索框")
            except Exception as exc:
                raise RuntimeError(f"poco_rpc_failed:{exc}") from exc
            last_count = len(searches)
            if last_count == 1:
                return searches[0]
            if last_count > 1:
                raise RuntimeError("poco_selector_not_unique:{'desc': '搜索框'}")
            time.sleep(0.15)
        raise RuntimeError(
            f"poco_selector_missing:{{'desc': '搜索框'}}; count={last_count}"
        )

    def poco_dismiss_honor_software_update_dialog(self, poco):
        """Defer only the exact Honor system-update prompt covering Alipay.

        The updater ignores Back and task resume on some Honor builds.  The
        non-installing ``稍后`` action is selected only after the foreground
        package, underlying Alipay task, title, update-size message semantics,
        and all three actions match the production surface.  Neither Install
        nor Details is ever selected.
        """
        _, current_focus, focused_app = self.focus_state()
        if (HONOR_SOFTWARE_UPDATE_PACKAGE not in current_focus
                or ALIPAY_PACKAGE not in focused_app):
            return False
        try:
            snapshot = poco.freeze()
            titles = self.poco_nodes(snapshot, text=HONOR_SOFTWARE_UPDATE_TITLE)
            installs = self.poco_nodes(snapshot, text=HONOR_SOFTWARE_UPDATE_INSTALL_TEXT)
            details = self.poco_nodes(snapshot, text=HONOR_SOFTWARE_UPDATE_DETAILS_TEXT)
            laters = self.poco_nodes(snapshot, text=HONOR_SOFTWARE_UPDATE_LATER_TEXT)
            joined_text = "\n".join(self.poco_snapshot_texts(snapshot, 80))
        except Exception as exc:
            self.emit(
                "poco_honor_software_update_probe_failed",
                errorType=type(exc).__name__,
                driver="poco",
            )
            return False
        message_fragments = (
            "包含重要系统优化",
            "建议您立即升级体验",
            "下载该更新需要",
            "流量",
        )
        # Honor renders the exact same system prompt with MB or GB depending
        # on the update size.  Keep the full sentence semantics and require a
        # numeric binary unit, instead of hard-coding only the smaller unit.
        update_size_matches = bool(re.search(
            r"下载该更新需要\s*\d+(?:\.\d+)?\s*(?:MB|GB)\s*流量",
            joined_text,
            re.I,
        ))
        message_matches = (
            all(fragment in joined_text for fragment in message_fragments)
            and update_size_matches
        )
        exact = (
            len(titles) == 1
            and len(installs) == 1
            and len(details) == 1
            and len(laters) == 1
            and message_matches
        )
        if not exact:
            self.emit(
                "poco_honor_software_update_elements_missing",
                titleCount=len(titles),
                installCount=len(installs),
                detailsCount=len(details),
                laterCount=len(laters),
                messageMatches=message_matches,
                driver="poco",
            )
            return False
        self.poco_tap(laters[0])
        self.emit(
            "dismiss_honor_software_update_overlay",
            driver="poco",
            selector={
                "package": HONOR_SOFTWARE_UPDATE_PACKAGE,
                "text": HONOR_SOFTWARE_UPDATE_LATER_TEXT,
                "evidence": "exact_title_message_and_three_actions",
            },
            method="later",
            installStarted=False,
        )
        deadline = time.time() + 3.0
        while time.time() < deadline:
            if HONOR_SOFTWARE_UPDATE_PACKAGE not in "\n".join(self.focus()):
                time.sleep(0.2)
                return True
            time.sleep(0.15)
        raise RuntimeError("poco_honor_software_update_later_timeout")

    def poco_dismiss_vivo_wlan_risk_dialog(self, poco):
        """Choose only the non-mutating action on vivo's exact WLAN warning.

        The warning is a TYPE_APPLICATION_OVERLAY window and ignores Back,
        HOME, and relaunching the covered task.  It is safe to choose Ignore
        only after the foreground package, underlying Alipay task, title,
        message semantics, and both action buttons all match the production
        surface.  The disconnect action is never selected.
        """
        _, current_focus, focused_app = self.focus_state()
        if (VIVO_SECURITY_CENTER_PACKAGE not in current_focus
                or ALIPAY_PACKAGE not in focused_app):
            return False
        try:
            snapshot = poco.freeze()
            titles = self.poco_nodes(
                snapshot,
                name="com.vivo.safecenter:id/alertTitle",
                text=VIVO_WLAN_RISK_TITLE,
            )
            messages = self.poco_nodes(snapshot, name="android:id/message")
            disconnects = self.poco_nodes(snapshot, name="android:id/button1")
            ignores = self.poco_nodes(snapshot, name="android:id/button2")
            message_texts = [self.poco_text(node) for node in messages]
            disconnect_texts = [self.poco_text(node) for node in disconnects]
            ignore_texts = [self.poco_text(node) for node in ignores]
        except Exception as exc:
            self.emit(
                "poco_vivo_wlan_risk_probe_failed",
                errorType=type(exc).__name__,
                driver="poco",
            )
            return False
        message_matches = sum(
            "存在安全风险" in text
            and "可能导致隐私信息泄露" in text
            and "是否断开该网络" in text
            for text in message_texts
        )
        exact = (
            len(titles) == 1
            and message_matches == 1
            and len(disconnects) == 1
            and disconnect_texts == [VIVO_WLAN_DISCONNECT_TEXT]
            and len(ignores) == 1
            and ignore_texts == [VIVO_WLAN_IGNORE_TEXT]
        )
        if not exact:
            self.emit(
                "poco_vivo_wlan_risk_elements_missing",
                titleCount=len(titles),
                messageMatchCount=message_matches,
                disconnectCount=len(disconnects),
                ignoreCount=len(ignores),
                driver="poco",
            )
            return False
        self.poco_tap(ignores[0])
        self.emit(
            "dismiss_vivo_wlan_risk_overlay",
            driver="poco",
            selector={
                "package": VIVO_SECURITY_CENTER_PACKAGE,
                "resourceId": "android:id/button2",
                "text": VIVO_WLAN_IGNORE_TEXT,
                "evidence": "exact_title_message_and_two_actions",
            },
            method="ignore_risk",
            networkChanged=False,
        )
        deadline = time.time() + 3.0
        while time.time() < deadline:
            if VIVO_SECURITY_CENTER_PACKAGE not in "\n".join(self.focus()):
                time.sleep(0.2)
                return True
            time.sleep(0.15)
        raise RuntimeError("poco_vivo_wlan_risk_ignore_timeout")

    @staticmethod
    def data_network_acceleration_overlay_focus(current_focus, focused_app):
        # Device 157 exposes this optional system dialog as `android`, not
        # com.android.systemui. The window type alone is never sufficient.
        return bool(
            re.search(r"\bu\d+\s+android\s+type=2003(?:\s|})", str(current_focus))
            and ALIPAY_PACKAGE in str(focused_app)
        )

    def poco_cancel_data_network_acceleration(self, poco):
        """Cancel only the evidenced optional mobile-data acceleration offer.

        No generic Cancel, Back, fixed-coordinate tap, permission grant or
        network setting is used. A matching system window must cover Alipay,
        with the exact title, both actions and the data-consumption warning.
        """
        _, current_focus, focused_app = self.focus_state()
        if not self.data_network_acceleration_overlay_focus(current_focus, focused_app):
            return False
        try:
            snapshot = poco.freeze()
            titles = self.poco_nodes(snapshot, text="数据网络加速")
            enables = self.poco_nodes(snapshot, text="开启")
            cancels = self.poco_nodes(snapshot, text="取消")
            text = re.sub(r"\s+", "", "\n".join(self.poco_snapshot_texts(snapshot, 100)))
        except Exception as exc:
            raise RuntimeError(f"poco_rpc_failed:data_network_acceleration_probe:{exc}") from exc
        message_matches = all(fragment in text for fragment in (
            "当前WLAN网速较慢", "您可以开启", "数据网络加速",
            "提升上网速度", "加速时将消耗数据网络流量",
        ))
        if not (len(titles) == len(enables) == len(cancels) == 1 and message_matches):
            self.emit("data_network_acceleration_elements_unverified", driver="poco",
                      titleCount=len(titles), enableCount=len(enables), cancelCount=len(cancels),
                      messageMatches=message_matches, phoneQueryStarted=False)
            raise RuntimeError("poco_data_network_acceleration_not_safely_dismissed")
        current_focus, focused_app = self.focus_components(self.focus(timeout=2, recover=False))
        if not self.data_network_acceleration_overlay_focus(current_focus, focused_app):
            raise RuntimeError("poco_data_network_acceleration_focus_changed")
        self.poco_tap(cancels[0])
        self.emit("cancel_data_network_acceleration", driver="poco", method="cancel",
                  selector={"text": "取消", "evidence": "exact_system_title_message_and_two_actions"},
                  networkSettingsAction="none", accelerationEnableTapped=False, phoneQueryStarted=False)
        deadline = time.perf_counter() + 3.0
        while time.perf_counter() < deadline:
            current_focus, _ = self.focus_components(self.focus(
                timeout=min(1, max(0.1, deadline - time.perf_counter())), recover=False))
            if ALIPAY_PACKAGE in current_focus:
                self.emit("data_network_acceleration_cancel_confirmed", driver="poco")
                return True
            time.sleep(min(0.1, max(0, deadline - time.perf_counter())))
        raise RuntimeError("poco_data_network_acceleration_cancel_unconfirmed")

    def poco_dismiss_coloros_securepay_usb_dialog(self, poco):
        """Handle ColorOS SecurePay in the resident Poco session when visible."""
        focus = "\n".join(self.focus())
        if COLOROS_SECUREPAY_PACKAGE not in focus:
            return False
        try:
            snapshot = poco.freeze()
            titles = self.poco_nodes(
                snapshot,
                name="com.coloros.securepay:id/alertTitle",
                text=COLOROS_USB_TRANSFER_TITLE,
            )
            messages = self.poco_nodes(
                snapshot,
                name="com.coloros.securepay:id/tv_message",
                text=COLOROS_REMOTE_CONTROL_RISK,
            )
            ignores = self.poco_nodes(snapshot, name=COLOROS_IGNORE_BUTTON_ID, text="忽略")
            ignore_selector = {
                "package": COLOROS_SECUREPAY_PACKAGE,
                "resourceId": COLOROS_IGNORE_BUTTON_ID,
                "text": "忽略",
            }
            if len(ignores) != 1:
                # ColorOS 15 exposes the exact Ignore label but assigns a
                # vendor-specific button id. The exact foreground package,
                # title and risk message below make one unique Ignore label a
                # safe equivalent selector without involving XML.
                ignores = self.poco_nodes(snapshot, text="忽略")
                ignore_selector = {
                    "package": COLOROS_SECUREPAY_PACKAGE,
                    "text": "忽略",
                    "evidence": "exact_title_and_risk_message",
                }
        except Exception as exc:
            self.emit(
                "poco_coloros_securepay_probe_failed",
                errorType=type(exc).__name__,
                driver="poco",
            )
            # This exact ColorOS system dialog can block Alipay's Poco
            # hierarchy. Cancel it with Back after verifying its foreground
            # package, avoiding both a USB-mode change and UIAutomator/XML.
            self.adb(["shell", "input", "keyevent", "4"], timeout=5, check=False)
            self.emit(
                "dismiss_coloros_securepay_usb_warning",
                driver="poco_focus_adb_back",
                selector={"package": COLOROS_SECUREPAY_PACKAGE},
                method="back",
                usbModeChanged=False,
            )
            deadline = time.time() + 3.0
            while time.time() < deadline:
                if COLOROS_SECUREPAY_PACKAGE not in "\n".join(self.focus()):
                    time.sleep(0.2)
                    return True
                time.sleep(0.15)
            return False
        if len(titles) != 1 or len(messages) != 1 or len(ignores) != 1:
            self.emit(
                "poco_coloros_securepay_elements_missing",
                titleCount=len(titles),
                messageCount=len(messages),
                ignoreCount=len(ignores),
                texts=self.poco_snapshot_texts(snapshot, 20),
                driver="poco",
            )
            return False
        self.poco_tap(ignores[0])
        self.emit(
            "dismiss_coloros_securepay_usb_warning",
            driver="poco",
            selector=ignore_selector,
            usbModeChanged=False,
        )
        deadline = time.time() + 3.0
        while time.time() < deadline:
            if COLOROS_SECUREPAY_PACKAGE not in "\n".join(self.focus()):
                time.sleep(0.2)
                return True
            time.sleep(0.15)
        raise RuntimeError("poco_coloros_securepay_usb_warning_dismiss_timeout")

    def poco_dismiss_post_input_usb_warning(self, poco, snapshot, query_deadline):
        # Use exact evidence from the current snapshot. This is an optional
        # USB-mode warning, never a CAPTCHA, login or permission grant.
        titles = self.poco_nodes(snapshot, name="com.coloros.securepay:id/alertTitle",
                                 text=COLOROS_USB_TRANSFER_TITLE)
        messages = self.poco_nodes(snapshot, name="com.coloros.securepay:id/tv_message",
                                   text=COLOROS_REMOTE_CONTROL_RISK)
        if len(titles) != 1 or len(messages) != 1:
            return False
        if getattr(self, "_query_usb_warning_dismissed", False):
            raise RuntimeError("poco_query_result_channel_timeout_after_input:usb_warning_repeated")
        if query_deadline - time.perf_counter() < 3.0:
            raise RuntimeError("poco_query_result_channel_timeout_after_input:usb_warning_budget_exhausted")
        ignores = self.poco_nodes(snapshot, text="忽略")
        if len(ignores) != 1:
            raise RuntimeError("poco_query_result_channel_timeout_after_input:usb_warning_ignore_not_unique")
        current, focused = self.focus_components(self.focus(timeout=1, recover=False))
        if COLOROS_SECUREPAY_PACKAGE not in current or ALIPAY_PACKAGE not in focused:
            raise RuntimeError("poco_query_result_channel_timeout_after_input:usb_warning_focus_changed")
        self._query_usb_warning_dismissed = True
        # Do not reuse startup recovery here: it has broader timing and Back
        # fallbacks. Post-input recovery only taps the one evidenced Ignore.
        self.poco_tap(ignores[0], deadline=query_deadline - 0.25)
        self.emit("dismiss_coloros_securepay_usb_warning", driver="poco", phase="after_input",
                  selector={"package": COLOROS_SECUREPAY_PACKAGE, "text": "忽略",
                            "evidence": "exact_title_and_risk_message"}, usbModeChanged=False)
        deadline = min(query_deadline - 0.1, time.perf_counter() + 2.0)
        while time.perf_counter() < deadline:
            current, _ = self.focus_components(self.focus(
                timeout=min(1, max(0.1, deadline - time.perf_counter())), recover=False))
            if ALIPAY_PACKAGE in current:
                break
            time.sleep(min(0.1, max(0, deadline - time.perf_counter())))
        else:
            raise RuntimeError("poco_query_result_channel_timeout_after_input:usb_warning_not_dismissed")
        self.emit("query_continue_after_coloros_usb_warning", driver="poco",
                  phoneQueryStarted=True, resubmitsInput=False, usbModeChanged=False)
        return True

    def poco_resume_alipay_home(self, poco, reason):
        """Normalize an existing Alipay task to Home without killing it.

        ``.AlipayLogin`` is Alipay's launcher activity name, not proof that the
        visible surface is either the Home page or a login form.  A saved
        internal route can therefore report the launcher component while it
        has no Home Search control.  Re-send the launcher intent with Android's
        reset-task flag, then handle only exact, evidenced system overlays.
        This path never force-stops Alipay and never uses UIAutomator/XML.
        """
        self.adb(["shell", "input", "keyevent", "224"], timeout=8, check=False)
        self.adb(["shell", "wm", "dismiss-keyguard"], timeout=8, check=False)
        output = self.adb([
            # NEW_TASK | CLEAR_TOP | RESET_TASK_IF_NEEDED.  The previous
            # NEW_TASK | RESET_TASK_IF_NEEDED intent only delivered the
            # launcher intent to AccountManagerV2Activity when a prior
            # list_accounts call intentionally left the saved-account picker
            # open.  CLEAR_TOP returns the existing logged-in Alipay task to
            # its launcher/root activity without killing Alipay, logging in,
            # selecting an account, or touching any query input.
            "shell", "am", "start", "-W", "-f", "0x14200000",
            "-a", "android.intent.action.MAIN", "-c", "android.intent.category.LAUNCHER",
            "-n", ALIPAY_HOME,
        ], timeout=20, check=False)
        self.emit(
            "resume_alipay_home",
            reason=reason,
            detail=str(output)[-600:],
            driver="poco_focus_adb",
            forceStopped=False,
            routeClearedToHome=True,
        )
        time.sleep(0.5)

        _, current_focus, focused_app = self.focus_state()
        if self.system_ui_focus_visible(current_focus) and ALIPAY_PACKAGE in focused_app:
            self.restore_alipay_from_systemui()
            _, current_focus, focused_app = self.focus_state()
        if HONOR_SOFTWARE_UPDATE_PACKAGE in current_focus:
            if not self.poco_dismiss_honor_software_update_dialog(poco):
                raise RuntimeError("poco_honor_software_update_not_safely_dismissed")
            self.restart_alipay_for_fresh_poco_after_honor_update()
        if VIVO_SECURITY_CENTER_PACKAGE in current_focus:
            if not self.poco_dismiss_vivo_wlan_risk_dialog(poco):
                raise RuntimeError("poco_vivo_wlan_risk_not_safely_dismissed")
            _, current_focus, focused_app = self.focus_state()
        if COLOROS_SECUREPAY_PACKAGE in current_focus:
            if not self.poco_dismiss_coloros_securepay_usb_dialog(poco):
                raise RuntimeError("poco_coloros_securepay_usb_warning_not_dismissed")
            _, current_focus, focused_app = self.focus_state()

        if self.data_network_acceleration_overlay_focus(current_focus, focused_app):
            self.poco_cancel_data_network_acceleration(poco)
            _, current_focus, focused_app = self.focus_state()

        self.poco_raise_if_login_focus(current_focus, f"resume-home-{reason}")
        current_is_null = bool(re.search(
            r"mCurrentFocus\s*=\s*null(?:\s|$)", str(current_focus or ""), re.I,
        ))
        if (
            ALIPAY_PACKAGE not in current_focus
            and not (current_is_null and ALIPAY_PACKAGE in focused_app)
        ):
            raise RuntimeError(f"poco_alipay_home_resume_not_foreground:{current_focus}")
        # Alipay's launcher Activity is also the container for every bottom
        # tab.  CLEAR_TOP can therefore report `.AlipayLogin` while the
        # visible surface remains the My tab (observed on device 54 after an
        # account-list task).  Select only the exact Home tab element exposed
        # by Poco; never infer a fixed bottom-left coordinate.
        self.poco_activate_home_tab_if_present(poco, reason)
        return True

    def poco_activate_home_tab_if_present(self, poco, reason):
        try:
            home_tab = poco(name=TAB_DESCRIPTION_ID, text="首页")
            count = len(home_tab)
        except Exception as exc:
            raise RuntimeError(f"poco_rpc_failed:{exc}") from exc
        if count > 1:
            raise RuntimeError(
                "poco_selector_not_unique:{'name': 'tab_description', 'text': '首页'}"
            )
        if count == 0:
            return False
        self.poco_tap(home_tab)
        self.emit(
            "activate_alipay_home_tab",
            reason=reason,
            selector={"name": TAB_DESCRIPTION_ID, "text": "首页"},
            coordinateDerivedFromPoco=True,
            driver="poco",
        )
        time.sleep(0.4)
        return True

    def poco_open_search(
        self, poco, reason, verification_recoveries=0, search_target=None,
        navigation_recoveries=0,
    ):
        self.poco_raise_if_login_focus("\n".join(self.focus()), f"open-search-{reason}")
        try:
            search = search_target or self.poco_home_search_target(poco, timeout=3.0)
        except Exception as exc:
            if "poco_selector_missing" not in str(exc):
                raise
            dismissed = self.poco_dismiss_coloros_securepay_usb_dialog(poco)
            if not dismissed:
                dismissed = self.poco_dismiss_known_overlay(poco)
            if not dismissed:
                dismissed = self.dismiss_coloros_securepay_usb_dialog(driver="poco_target_missing_xml_probe")
            if not dismissed:
                snapshot = poco.freeze()
                self.poco_raise_if_login_required(snapshot, f"open-search-{reason}")
                self.poco_raise_if_account_restricted(snapshot, f"open-search-{reason}")
                if self.poco_verification_evidence(snapshot):
                    if verification_recoveries >= 2:
                        raise RuntimeError("poco_alipay_human_verification_repeatedly_invalidated_start")
                    self.poco_solve_human_verification(poco, f"{reason}-launch")
                    return self.poco_prepare_full_path(poco, reason, verification_recoveries + 1)
            if dismissed:
                self.emit("retry_target_after_coloros_securepay_warning", selector={"desc": "搜索框"}, driver="poco")
            # Preserve the original eight-second target budget for ordinary
            # slow launches while probing XML only for the evidenced vendor
            # foreground above.
            try:
                search = self.poco_home_search_target(poco, timeout=5.0)
            except Exception as retry_exc:
                if "poco_selector_missing" not in str(retry_exc):
                    raise
                # Some restriction WebViews finish rendering only after the
                # initial three-second selector budget.  Re-inspect the live
                # Poco hierarchy at the end of the full eight-second budget
                # before the selector error can reach the XML fallback.
                self.emit(
                    "poco_open_search_final_restriction_probe_begin",
                    phase=f"open-search-{reason}", driver="poco",
                )
                snapshot = poco.freeze()
                self.emit(
                    "poco_open_search_final_restriction_probe_done",
                    phase=f"open-search-{reason}", driver="poco",
                )
                self.poco_raise_if_login_required(snapshot, f"open-search-{reason}")
                self.poco_raise_if_account_restricted(snapshot, f"open-search-{reason}")
                if self.poco_verification_evidence(snapshot):
                    if verification_recoveries >= 2:
                        raise RuntimeError("poco_alipay_human_verification_repeatedly_invalidated_start")
                    self.poco_solve_human_verification(poco, f"{reason}-launch")
                    return self.poco_prepare_full_path(poco, reason, verification_recoveries + 1)
                raise retry_exc
        self.poco_tap(search)
        self.emit("open_search", reason=reason, driver="poco")
        time.sleep(0.35)
        if str(self.payload.get("operation") or "") == "start":
            _, current_focus, focused_app = self.focus_state()
            if self.exact_search_activity_visible(current_focus, focused_app):
                # Start establishes a session but does not enter a phone
                # number.  The exact foreground task is sufficient here and
                # query will revalidate the Poco input before any mutation.
                # This also avoids an unnecessary hierarchy POST precisely
                # while Search's WebView is attaching on slower devices.
                self.emit(
                    "open_search_ready_by_exact_activity",
                    driver="poco_focus_adb",
                    pocoHierarchyDeferred=True,
                )
                return
        try:
            self.poco_unique(poco, timeout=5.0, name=SEARCH_INPUT_ID)
        except Exception as exc:
            if "poco_selector_missing" not in str(exc):
                raise
            if self.poco_dismiss_coloros_securepay_usb_dialog(poco):
                self.emit(
                    "retry_search_input_after_coloros_securepay_warning",
                    selector={"name": SEARCH_INPUT_ID}, driver="poco",
                )
                self.poco_unique(poco, timeout=5.0, name=SEARCH_INPUT_ID)
                return

            # A Search target can go stale while a Home promotion is being
            # replaced or while Alipay restores an internal route.  Before a
            # generic element-changed error, preserve exact login/restriction
            # evidence and give start one bounded, non-destructive Home
            # normalization with a freshly acquired Search node.
            try:
                snapshot = poco.freeze()
            except Exception as probe_exc:
                raise RuntimeError(f"poco_rpc_failed:{probe_exc}") from probe_exc
            self.poco_raise_if_login_required(snapshot, f"search-input-{reason}")
            self.poco_raise_if_account_restricted(snapshot, f"search-input-{reason}")
            # A modal can be created between selecting Home's Search node and
            # the Search activity exposing its input.  The previous pre-tap
            # overlay pass cannot see that race.  Recover once from only the
            # exact, multi-element Alipay overlays that are already approved;
            # never click a generic Close/Cancel node or guessed coordinate.
            if self.poco_dismiss_alipay_home_overlay_snapshot(snapshot):
                self.emit(
                    "retry_search_after_late_known_overlay",
                    reason=reason,
                    previousError=str(exc),
                    driver="poco",
                    genericCloseTapped=False,
                )
                retry_search = self.poco_home_search_target(poco, timeout=2.0)
                self.poco_tap(retry_search)
                self.emit("open_search", reason=f"{reason}-after-late-overlay", driver="poco")
                self.poco_unique(poco, timeout=5.0, name=SEARCH_INPUT_ID)
                return
            try:
                visible_texts = self.poco_snapshot_texts(snapshot, 80)
            except Exception as evidence_exc:
                # Diagnostic extraction must never replace the actionable
                # selector error or trigger a fallback on its own.
                visible_texts = []
                self.emit(
                    "poco_unrecognized_surface_evidence_unavailable",
                    reason=reason,
                    evidenceError=str(evidence_exc),
                    driver="poco",
                )
            self.emit(
                "poco_unrecognized_surface_after_search",
                reason=reason,
                previousError=str(exc),
                focus=self.focus(),
                visibleTexts=visible_texts,
                driver="poco",
                screenMutationPerformed=False,
            )
            if (
                str(self.payload.get("operation") or "") == "start"
                and navigation_recoveries < 1
            ):
                self.emit(
                    "retry_search_after_home_normalization",
                    reason=reason,
                    previousError=str(exc),
                    attempt=navigation_recoveries + 1,
                    driver="poco_focus_adb",
                    forceStopped=False,
                )
                self.poco_resume_alipay_home(poco, f"{reason}-search-input-missing")
                return self.poco_open_search(
                    poco,
                    reason,
                    verification_recoveries,
                    navigation_recoveries=navigation_recoveries + 1,
                )
            raise

    def poco_prepare_full_path(self, poco, reason, verification_recoveries=0):
        # A system/OEM surface can briefly own mCurrentFocus while Alipay is
        # still the underlying focused task.  This is the exact 142 failure:
        # PocoService's bootstrap activity hid the existing SecurePay warning,
        # so reuse returned false and the old full path force-stopped Alipay;
        # ColorOS then displayed the warning again too late in the 60-second
        # budget.  Preserve the existing task, resend the launcher intent and
        # let poco_resume_alipay_home verify and tap the exact Ignore element.
        # That path never selects "仅充电", changes USB mode, uses XML or
        # guesses coordinates.
        _, current_focus, focused_app = self.focus_state()
        if ALIPAY_PACKAGE in focused_app:
            self.emit(
                "reuse_underlying_alipay_task_before_full_launch",
                reason=reason,
                overlayFocus=current_focus,
                driver="poco_focus_adb",
                forceStopped=False,
            )
            self.poco_resume_alipay_home(poco, f"{reason}-underlying-task")
            return self.poco_open_search(
                poco, reason, verification_recoveries,
            )
        self.adb(["shell", "input", "keyevent", "224"], timeout=8, check=False)
        self.adb(["shell", "wm", "dismiss-keyguard"], timeout=8, check=False)
        # Poco's own TestActivity can replace both focus fields while Alipay
        # is still alive (device 188). Missing focus is not proof that Alipay
        # needs to be killed. Bring its existing task to the launcher/root.
        output = self.adb([
            "shell", "am", "start", "-W", "-f", "0x14200000",
            "-a", "android.intent.action.MAIN", "-c", "android.intent.category.LAUNCHER", "-n", ALIPAY_HOME,
        ], timeout=25, check=False)
        self.emit("launch_alipay", reason=reason, detail=str(output)[-600:], driver="poco", forceStopped=False)
        time.sleep(1.0)
        if (self.poco_dismiss_honor_software_update_dialog(poco)
                or self.dismiss_honor_software_update_overlay()):
            self.emit("retry_launch_after_honor_software_update", driver="poco")
        if (self.poco_dismiss_vivo_wlan_risk_dialog(poco)
                or self.dismiss_vivo_wlan_risk_overlay()):
            self.emit("retry_launch_after_vivo_wlan_risk", driver="poco")
        if self.restore_alipay_from_systemui():
            self.emit("retry_launch_after_systemui", driver="poco")
        if self.poco_dismiss_coloros_securepay_usb_dialog(poco):
            self.emit("retry_launch_after_coloros_securepay_warning", driver="poco")
        self.poco_open_search(poco, reason, verification_recoveries)

    def poco_try_reuse_search_page(self, poco):
        _, current_focus, focused_app = self.focus_state()
        if self.data_network_acceleration_overlay_focus(current_focus, focused_app):
            self.poco_cancel_data_network_acceleration(poco)
            _, current_focus, focused_app = self.focus_state()
        if self.vivo_usb_mode_dialog_visible(current_focus):
            if not self.dismiss_vivo_usb_mode_dialog():
                raise RuntimeError("poco_vivo_usb_mode_dialog:underlying_task_unverified")
            _, current_focus, focused_app = self.focus_state()
        if self.system_ui_focus_visible(current_focus) and ALIPAY_PACKAGE in focused_app:
            self.restore_alipay_from_systemui()
            self.emit("retry_reuse_after_systemui", driver="poco")
            _, current_focus, focused_app = self.focus_state()
        if HONOR_SOFTWARE_UPDATE_PACKAGE in current_focus:
            dismissed_exact_update = self.poco_dismiss_honor_software_update_dialog(poco)
            if dismissed_exact_update:
                self.restart_alipay_for_fresh_poco_after_honor_update()
            if not dismissed_exact_update:
                self.dismiss_honor_software_update_overlay()
            self.emit("retry_reuse_after_honor_software_update", driver="poco")
            _, current_focus, focused_app = self.focus_state()
        if VIVO_SECURITY_CENTER_PACKAGE in current_focus:
            if not self.poco_dismiss_vivo_wlan_risk_dialog(poco):
                self.dismiss_vivo_wlan_risk_overlay()
            self.emit("retry_reuse_after_vivo_wlan_risk", driver="poco")
            _, current_focus, focused_app = self.focus_state()
        # ColorOS reports the underlying Alipay activity through mFocusedApp
        # while its SecurePay warning owns mCurrentFocus.  Handle that exact
        # system foreground before treating Alipay as reusable: the warning
        # blocks Alipay's Poco hierarchy, so probing the hierarchy first can
        # only end in a transport timeout.
        if COLOROS_SECUREPAY_PACKAGE in current_focus:
            if not self.poco_dismiss_coloros_securepay_usb_dialog(poco):
                raise RuntimeError("poco_coloros_securepay_usb_warning_not_dismissed")
            self.emit("retry_reuse_after_coloros_securepay_warning", driver="poco")
            _, current_focus, focused_app = self.focus_state()
        self.poco_raise_if_login_focus(current_focus, "reuse-foreground")
        self.emit(
            "poco_reuse_focus_observed",
            searchForeground=self.exact_search_activity_visible(current_focus, focused_app),
            alipayForeground=(ALIPAY_PACKAGE in current_focus),
            underlyingAlipayTask=(ALIPAY_PACKAGE in focused_app),
            driver="poco",
        )
        if ALIPAY_PACKAGE in current_focus:
            if self.poco_dismiss_local_service_prompt(poco):
                self.poco_search_ready(poco)
                self.emit("reuse_existing_search_page", method="after_local_service_cancel")
                return True
        if self.exact_search_activity_visible(current_focus, focused_app):
            # A start request must distinguish a usable Search input from a
            # verification overlay before it advertises the session as ready.
            # Normal queries still revalidate immediately before input.
            if str(self.payload.get("operation") or "") == "start":
                self.poco_search_ready(poco)
                self.emit(
                    "reuse_search_page_validated_on_start",
                    driver="poco", pocoHierarchyDeferred=False,
                )
                self.emit("reuse_existing_search_page", method="exact_activity_validated_start")
                return True
            self.emit(
                "reuse_search_page_by_exact_activity",
                driver="poco_focus_adb",
                pocoHierarchyDeferred=True,
            )
            self.emit("reuse_existing_search_page", method="exact_activity_start")
            return True
        if ALIPAY_PACKAGE in current_focus:
            # Prefer one exact device-side selector over a full hierarchy
            # snapshot on a normal Alipay home.  Some Honor builds serialize
            # this large page slowly enough to hit the transport boundary,
            # after which the still-running hierarchy request blocks every
            # later RPC on that PocoService session.
            live_search = self.poco_live_home_search_target(poco)
            if live_search is not None:
                self.poco_open_search(
                    poco, "reuse-foreground", search_target=live_search,
                )
                self.emit(
                    "reuse_existing_search_page",
                    method="poco_live_search_from_foreground",
                )
                return True
            # A restriction can replace the search activity entirely, so the
            # old task stack no longer contains MainSearchActivity.  Inspect
            # the current Poco hierarchy before deciding that a full Alipay
            # relaunch is necessary; relaunching an already evidenced
            # restriction page only breaks the live hierarchy channel.
            try:
                self.emit("poco_reuse_restriction_probe_begin", driver="poco")
                snapshot = poco.freeze()
                self.emit("poco_reuse_restriction_probe_done", driver="poco")
                self.poco_raise_if_login_required(snapshot, "reuse-foreground")
                self.poco_raise_if_account_restricted(snapshot, "reuse-foreground")
            except Exception as exc:
                if self.account_switch_reason_from_error(exc) or "poco_alipay_login_required" in str(exc):
                    raise
                # Once a hierarchy request fails, sending more RPCs through
                # the same PocoService session only compounds the timeout.
                # Hand control back to the Agent so it can reattach a bounded
                # worker to the unchanged foreground app.
                raise RuntimeError(f"poco_rpc_failed:{exc}") from exc
            # The responsive hierarchy proved that this is neither a login
            # nor a restriction page, but absence of one unique live Search
            # means it is not an evidenced Home surface. Normalize the
            # existing task first; do not tap an arbitrary foreground page and
            # do not cold-start Alipay.
            self.poco_resume_alipay_home(poco, "reuse-foreground-no-home-search")
            self.poco_open_search(poco, "reuse-foreground")
            self.emit(
                "reuse_existing_search_page",
                method="poco_resume_home_then_open_search",
            )
            return True
        activities = self.adb(["shell", "dumpsys", "activity", "activities"], timeout=12, check=False)
        if "com.alipay.android.phone.businesscommon.globalsearch.ui.MainSearchActivity" not in str(activities):
            return False
        self.adb([
            "shell", "am", "start", "-W", "-f", "0x10200000",
            "-a", "android.intent.action.MAIN", "-c", "android.intent.category.LAUNCHER", "-n", ALIPAY_HOME,
        ], timeout=20, check=False)
        time.sleep(0.35)
        self.poco_dismiss_known_overlay(poco)
        _, current_focus, focused_app = self.focus_state()
        if self.exact_search_activity_visible(current_focus, focused_app):
            self.emit(
                "reuse_search_page_by_exact_activity",
                driver="poco_focus_adb",
                pocoHierarchyDeferred=True,
            )
            self.emit("reuse_existing_search_page", method="exact_activity_resume_start")
            return True
        self.poco_search_ready(poco)
        self.emit("reuse_existing_search_page", method="poco_resume_existing_task")
        return True

    def poco_observe_result_transition(self, poco, phone, query_deadline, timeout=3.0):
        """Observe a late WebView result/challenge without any repeat input.

        Input disappearing is not itself a result or a CAPTCHA. Read fresh
        bounded snapshots for exact evidence; unknown states remain failures.
        """
        deadline = min(query_deadline, time.perf_counter() + timeout)
        self.emit("query_result_transition_observe", driver="poco", resubmitsInput=False,
                  phoneQueryStarted=True, timeoutMs=max(0, int((deadline-time.perf_counter())*1000)))
        while time.perf_counter() < deadline:
            try:
                snapshot = poco.freeze()
            except Exception as exc:
                raise RuntimeError(
                    f"poco_query_result_channel_timeout_after_input:transition:{type(exc).__name__}:{exc}"
                ) from exc
            self.poco_raise_if_account_restricted(snapshot, "result-transition", phone_query_started=True)
            if self.poco_verification_evidence(snapshot):
                self.poco_solve_human_verification(poco, "result-transition")
                continue
            result = self.parse_poco_result(snapshot, phone)
            if result:
                self.emit_query_result(result, driver="poco")
                return result
            time.sleep(min(0.2, max(0, deadline - time.perf_counter())))
        self.emit("query_result_transition_unresolved", driver="poco", resubmitsInput=False,
                  phoneQueryStarted=True)
        return None

    def query_once_poco(
        self, poco, phone, verification_recoveries=0, query_deadline=None,
        resume_after_input=False, allow_empty_reinput=True,
        observation_only_resume=False,
    ):
        self._query_usb_warning_dismissed = False
        if query_deadline is None:
            # Input, native result wait and two full-frame OCR reads share one
            # hard budget. Slider recovery passes this deadline through unchanged.
            query_deadline = time.perf_counter() + 60.0
        no_name_deadline = time.time() + POCO_NO_NAME_RESULT_SECONDS
        if resume_after_input:
            # The previous worker already set the phone before its hierarchy
            # response channel stalled. Rebuild Poco only to inspect the page;
            # never submit the number a second time.
            self.emit("resume_query_without_reinput", driver="poco", resubmitsInput=False)
            try:
                resume_snapshot = poco.freeze()
            except Exception as exc:
                raise RuntimeError(
                    f"poco_query_resume_snapshot_failed:{type(exc).__name__}:{exc}"
                ) from exc
            self.poco_raise_if_account_restricted(
                resume_snapshot, "query-resume", phone_query_started=True,
            )
            if self.poco_verification_evidence(resume_snapshot):
                if verification_recoveries >= 2:
                    raise RuntimeError("poco_alipay_basic_slider_repeatedly_invalidated_query")
                self.poco_solve_human_verification(
                    poco, f"query-resume-{verification_recoveries + 1}",
                )
                return self.query_once_poco(
                    poco, phone, verification_recoveries + 1,
                    query_deadline, resume_after_input=True,
                    allow_empty_reinput=allow_empty_reinput,
                )
            resumed_result = self.parse_poco_result(resume_snapshot, phone)
            if resumed_result:
                self.emit_query_result(resumed_result, driver="poco")
                return resumed_result
            if observation_only_resume:
                # A preceding query_resume already focused and submitted the
                # original number before its Poco result channel timed out.
                # After rebuilding Poco, observe only the page that is already
                # rendered: never focus the field, inject text, or click search
                # again. This closes the false-failure window without creating
                # a duplicate lookup.
                self.emit(
                    "resume_result_observation_only",
                    driver="poco", resubmitsInput=False, resubmitsSearch=False,
                )
                observation_deadline = min(
                    time.time() + POCO_NO_NAME_RESULT_SECONDS,
                    time.time() + max(0.0, query_deadline - time.perf_counter()),
                )
                while time.time() < observation_deadline:
                    time.sleep(0.18)
                    try:
                        resume_snapshot = poco.freeze()
                    except Exception as exc:
                        raise RuntimeError(
                            "poco_query_result_channel_timeout_after_input:"
                            f"observation_only:{type(exc).__name__}:{exc}"
                        ) from exc
                    self.poco_raise_if_account_restricted(
                        resume_snapshot, "query-resume-observation",
                        phone_query_started=True,
                    )
                    if self.poco_verification_evidence(resume_snapshot):
                        raise RuntimeError("poco_alipay_human_verification_required")
                    resumed_result = self.parse_poco_result(resume_snapshot, phone)
                    if resumed_result:
                        self.emit_query_result(resumed_result, driver="poco")
                        return resumed_result
                return self.poco_visual_result_readonly(poco, phone, query_deadline)
            resume_inputs = self.poco_nodes(resume_snapshot, name=SEARCH_INPUT_ID)
            resume_actual = self.poco_text(resume_inputs[0]) if len(resume_inputs) == 1 else ""
            resume_actual_digits = re.sub(r"\D", "", resume_actual)
            if resume_actual_digits != phone:
                # The Agent reaches query_resume only after terminating the
                # worker whose set_text RPC timed out.  If the rebuilt Poco
                # hierarchy proves that the one exact search input is still
                # empty, the original input did not land and cannot arrive
                # later.  Keep Poco as the element authority, focus that
                # frozen exact node, and use bounded ADB text injection once.
                # Any non-empty mismatch remains ambiguous and fails closed.
                if (
                    allow_empty_reinput
                    and len(resume_inputs) == 1
                    and not resume_actual_digits
                ):
                    self.emit(
                        "resume_empty_input_confirmed",
                        selector="exact_search_input",
                        resubmitsInput=True,
                        driver="poco",
                    )
                    self.wait_before_phone_input("poco_resume_empty_adb")
                    no_name_deadline = time.time() + POCO_NO_NAME_RESULT_SECONDS
                    self.poco_tap(resume_inputs[0])
                    self.input_phone_humanized(
                        phone, "adb_keyevents_after_poco_confirmed_empty", timeout=5,
                        driver="poco",
                    )
                    # The frozen node already proved the exact input and was
                    # used to focus it. Avoid an immediate redundant live
                    # selector RPC on devices whose set_text channel is the
                    # failure being recovered; the bounded readback below is
                    # the authoritative post-input verification.
                    input_node = resume_inputs[0]
                else:
                    transitioned = self.poco_observe_result_transition(poco, phone, query_deadline)
                    if transitioned:
                        return transitioned
                    raise RuntimeError(
                        "poco_query_resume_state_mismatch:"
                        f"length={len(resume_actual_digits)};"
                        f"emptyReinputAllowed={str(bool(allow_empty_reinput)).lower()}"
                    )
            else:
                input_node = self.poco_search_ready(poco)
                # Completing a jigsaw can return to MainSearchActivity with
                # the original phone still present but the input unfocused.
                # In that state Alipay hides search_confirm, so observation
                # alone eventually reports poco_search_submit_unavailable.
                # Focus the exact, already-matching input without changing its
                # value; this only reveals the normal submit control.
                self.poco_tap(input_node)
                self.emit(
                    "resume_existing_input_focused",
                    selector="exact_search_input",
                    resubmitsInput=False,
                    driver="poco",
                )
        else:
            # Poco's synchronous set_text RPC becomes unreliable during a
            # long sequence of searches on some vivo builds: the operation can
            # reach the phone but its HTTP response stalls, leaving the caller
            # unable to distinguish a completed, partial, or absent write.
            # Keep Poco as the sole element authority, but perform the bounded
            # clear/type actions through ADB after exact frozen-node focus.
            phone_input_started = False
            try:
                input_node = self.poco_search_ready(poco, live=False)
                self.poco_tap(input_node)
                # Move the cursor to the end so the active input connection
                # reports the real editable length. Unlike Poco/Accessibility
                # text, this excludes Alipay's rotating hint text.
                self.adb(["shell", "input", "keyevent", "123"], timeout=5)
                editable_length = self.focused_search_input_length()
                if editable_length is None:
                    raise RuntimeError("poco_exact_input_focus_not_confirmed")
                if editable_length:
                    self.clear_focused_search_input(
                        method="poco_exact_input_adb_keyevents",
                    )
                    editable_length = self.focused_search_input_length()
                if editable_length != 0:
                    raise RuntimeError(
                        "poco_query_input_state_invalid_before_input:"
                        f"editableLength={editable_length}"
                    )
                cleared_snapshot = poco.freeze()
                self.poco_raise_if_account_restricted(
                    cleared_snapshot, "input-clear", phone_query_started=False,
                )
                if self.poco_verification_evidence(cleared_snapshot):
                    raise RuntimeError("poco_alipay_human_verification_required")
                cleared_inputs = self.poco_nodes(
                    cleared_snapshot, name=SEARCH_INPUT_ID,
                )
                if len(cleared_inputs) != 1:
                    raise RuntimeError(
                        "poco_query_input_state_invalid_before_input:"
                        f"count={len(cleared_inputs)}"
                    )
                input_node = cleared_inputs[0]
                self.emit(
                    "poco_input_clear_confirmed",
                    selector="exact_search_input", editableLength=0,
                    driver="poco_input_connection",
                )
                self.wait_before_phone_input("poco")
                no_name_deadline = time.time() + POCO_NO_NAME_RESULT_SECONDS
                # The throttle interval can allow a popup/app transition.
                # Reconfirm the live search page before sending any digits.
                input_node = self.poco_search_ready(poco, live=False)
                self.poco_tap(input_node)
                phone_input_started = True
                self.input_phone_humanized(
                    phone, "adb_keyevents_after_poco_exact_input", timeout=5,
                    driver="poco",
                )
            except Exception as exc:
                if not phone_input_started:
                    raise RuntimeError(
                        f"poco_query_before_input_failed:{type(exc).__name__}:{exc}"
                    ) from exc
                # Once the clear has started, a transport failure leaves the
                # exact input state unknown. Rebuild Poco and inspect it via
                # query_resume; an empty field permits one evidenced input,
                # the full target continues, and every other value fails
                # closed. This also covers a bounded ADB input failure without
                # ever blindly submitting the number twice.
                raise RuntimeError(
                    f"poco_query_result_channel_timeout_after_input:"
                    f"poco_bounded_input_failed:{type(exc).__name__}:{exc}"
                ) from exc

        # Input/throttling time is not result observation time. Slow OEM ADB
        # input must still receive a full readback/result window, bounded by
        # the unchanged overall query deadline.
        no_name_deadline = time.time() + POCO_NO_NAME_RESULT_SECONDS
        readback_deadline = min(
            time.time() + 3.0,
            no_name_deadline,
            time.time() + max(0.0, query_deadline - time.perf_counter()),
        )
        actual_digits = ""
        while time.time() < readback_deadline:
            try:
                snapshot = poco.freeze()
            except Exception as exc:
                raise RuntimeError(
                    f"poco_query_result_channel_timeout_after_input:{type(exc).__name__}:{exc}"
                ) from exc
            if not resume_after_input and self.poco_dismiss_post_input_usb_warning(poco, snapshot, query_deadline):
                continue
            self.poco_raise_if_account_restricted(
                snapshot, "input-readback", phone_query_started=True,
            )
            if self.poco_verification_evidence(snapshot):
                if verification_recoveries >= 2:
                    raise RuntimeError("poco_alipay_human_verification_repeatedly_invalidated_query")
                next_attempt = verification_recoveries + 1
                self.poco_solve_human_verification(poco, f"input-readback-{next_attempt}")
                self.emit(
                    "resume_query_after_human_verification", recoveryAttempt=next_attempt,
                    phase="input-readback", driver="poco", resubmitsInput=False,
                )
                return self.query_once_poco(
                    poco, phone, next_attempt, query_deadline,
                    resume_after_input=True,
                    allow_empty_reinput=allow_empty_reinput,
                )
            result = self.parse_poco_result(snapshot, phone)
            if result:
                self.emit_query_result(result, driver="poco")
                return result
            try:
                inputs = self.poco_nodes(snapshot, name=SEARCH_INPUT_ID)
                actual = self.poco_text(inputs[0]) if len(inputs) == 1 else ""
                actual_digits = re.sub(r"\D", "", actual)
            except Exception as exc:
                raise RuntimeError(
                    f"poco_query_result_channel_timeout_after_input:"
                    f"poco_input_readback_failed:{exc}"
                ) from exc
            if actual_digits == phone:
                break
            time.sleep(0.1)
        else:
            self.poco_wait_for_post_query_restriction(
                poco, "input-readback-transition",
            )
            raise RuntimeError(
                f"poco_query_result_channel_timeout_after_input:"
                f"search_input_readback_mismatch:length={len(actual_digits)}"
            )

        deadline = min(
            no_name_deadline,
            time.time() + max(0.0, query_deadline - time.perf_counter()),
        )
        submit_after = min(deadline, time.time() + POCO_SEARCH_SUBMIT_DELAY_SECONDS)
        submit_count = 0
        last_snapshot = None
        while time.time() < deadline:
            try:
                snapshot = poco.freeze()
                last_snapshot = snapshot
            except Exception as exc:
                raise RuntimeError(
                    f"poco_query_result_channel_timeout_after_input:{type(exc).__name__}:{exc}"
                ) from exc
            if not resume_after_input and self.poco_dismiss_post_input_usb_warning(poco, snapshot, query_deadline):
                continue
            self.poco_raise_if_account_restricted(
                snapshot, "result", phone_query_started=True,
            )
            if self.poco_verification_evidence(snapshot):
                if verification_recoveries >= 2:
                    raise RuntimeError("poco_alipay_human_verification_repeatedly_invalidated_query")
                next_attempt = verification_recoveries + 1
                self.poco_solve_human_verification(poco, f"result-{next_attempt}")
                self.emit(
                    "resume_query_after_human_verification", recoveryAttempt=next_attempt,
                    phase="result", driver="poco", resubmitsInput=False,
                )
                return self.query_once_poco(
                    poco, phone, next_attempt, query_deadline,
                    resume_after_input=True,
                    allow_empty_reinput=allow_empty_reinput,
                )
            result = self.parse_poco_result(snapshot, phone)
            if result:
                self.emit_query_result(result, driver="poco")
                return result
            should_submit = submit_count == 0 and time.time() >= submit_after
            if should_submit:
                confirms = self.poco_nodes(snapshot, name="com.alipay.mobile.antui:id/search_confirm")
                if len(confirms) == 1:
                    self.poco_tap(confirms[0])
                    submit_count += 1
                    deadline = min(
                        time.time() + POCO_NO_NAME_RESULT_SECONDS,
                        time.time() + max(0.0, query_deadline - time.perf_counter()),
                    )
                    self.emit(
                        "submit_search",
                        selector="exact_search_confirm", attempt=submit_count, driver="poco",
                    )
            time.sleep(0.18)
        if submit_count < 1 or last_snapshot is None:
            self.poco_wait_for_post_query_restriction(
                poco, "search-submit-unavailable",
            )
            raise RuntimeError(
                "poco_query_result_channel_timeout_after_input:"
                "poco_search_submit_unavailable"
            )
        try:
            inputs = self.poco_nodes(last_snapshot, name=SEARCH_INPUT_ID)
            actual = self.poco_text(inputs[0]) if len(inputs) == 1 else ""
            actual_digits = re.sub(r"\D", "", actual)
        except Exception as exc:
            raise RuntimeError(
                f"poco_query_result_channel_timeout_after_input:"
                f"poco_result_state_readback_failed:{exc}"
            ) from exc
        if actual_digits != phone:
            transitioned = self.poco_observe_result_transition(poco, phone, query_deadline)
            if transitioned:
                return transitioned
            # A submitted search can transition through an input-less WebView
            # before an account restriction finishes rendering (observed on
            # vivo V2442A). Keep probing that existing page through Poco. If no
            # restriction becomes visible, force Agent's query_resume path;
            # both outcomes are post-input and must never enter XML or submit
            # the number again.
            self.poco_wait_for_post_query_restriction(
                poco, "result-page-state-changed",
            )
            raise RuntimeError(
                f"poco_query_result_channel_timeout_after_input:"
                f"poco_result_page_state_changed:length={len(actual_digits)}"
            )
        # Canvas cards can be visible while Poco exposes only the native input
        # and categories. An unchanged input is not evidence of no person.
        return self.poco_visual_result_readonly(poco, phone, query_deadline)

    def poco_visual_result_readonly(self, poco, phone, query_deadline):
        """Read the existing card twice; never input, submit, launch or switch."""
        try:
            from alipay_visual_result import recognize, parse_rows, parse_empty_rows, protection, search_loading, search_network_busy, search_rate_limit
        except ImportError as exc:
            raise RuntimeError("local_lookup_result_unconfirmed:ocr_dependency_unavailable") from exc
        previous = None
        previous_restriction = None
        sample = 0
        loading_reported = False
        pending_reported = False
        network_busy = False
        def observation_timeout():
            reason = "visual_network_busy" if network_busy else "observation_budget_exhausted"
            return RuntimeError("local_lookup_result_unconfirmed:" + reason)
        self.emit("lookup_visual_result_probe", driver="poco_visual_readonly",
                  remainingMs=max(0, round((query_deadline-time.perf_counter())*1000)),
                  resubmitsInput=False, resubmitsSearch=False)
        while sample < 2:
            remaining = query_deadline - time.perf_counter()
            if remaining < 2.0:
                raise observation_timeout()
            lines = self.focus(timeout=min(3.0, remaining), recover=False)
            current, focused = self.focus_components(lines)
            if not self.exact_search_activity_visible(current, focused):
                raise RuntimeError("local_lookup_result_unconfirmed:foreground_changed")
            snapshot = poco.freeze()
            self.poco_raise_if_account_restricted(snapshot, "visual-result-before", phone_query_started=True)
            if self.poco_verification_evidence(snapshot):
                raise RuntimeError("poco_alipay_human_verification_required")
            inputs = self.poco_nodes(snapshot, name=SEARCH_INPUT_ID)
            if len(inputs) != 1 or self.poco_text(inputs[0]) != phone:
                raise RuntimeError("local_lookup_result_unconfirmed:input_changed")
            try:
                raw = self.adb(["exec-out", "screencap", "-p"],
                               timeout=min(4.0, max(.1, query_deadline-time.perf_counter())), binary=True)
                try:
                    ocr_started = time.perf_counter()
                    rows, size = recognize(raw, timeout=max(.05, query_deadline-ocr_started))
                    self.emit("lookup_visual_frame_read", driver="poco_visual_readonly",
                              elapsedMs=round((time.perf_counter()-ocr_started)*1000),
                              remainingMs=max(0, round((query_deadline-time.perf_counter())*1000)),
                              resubmitsInput=False, resubmitsSearch=False)
                except Exception as exc:
                    # OCR reads an already-submitted query. Its private runtime
                    # failing is not permission to restart Alipay and retype.
                    reason = ("ocr_reader_timeout" if "lookup_ocr_worker_timeout" in str(exc)
                              else "ocr_reader_unavailable")
                    raise RuntimeError("local_lookup_result_unconfirmed:" + reason) from exc
                protected = protection(rows, size)
                if protected == "human":
                    raise RuntimeError("poco_alipay_human_verification_required")
                restriction = search_rate_limit(rows, phone, size)
                if protected and not restriction:
                    raise RuntimeError("local_lookup_result_unconfirmed:protected_visual_page")
                loading = search_loading(rows, phone, size)
                network_busy = search_network_busy(rows, phone, size)
                candidate = None if restriction or loading or network_busy else parse_rows(rows, phone, size)
                if candidate is None and not restriction and not loading and not network_busy and self.payload.get("preparedEmptyResult") is True:
                    candidate = parse_empty_rows(rows, phone, size)
            except RuntimeError:
                raise
            except Exception as exc:
                raise RuntimeError("local_lookup_result_unconfirmed:visual_reader_unavailable") from exc
            remaining = query_deadline - time.perf_counter()
            if remaining <= 0:
                raise observation_timeout()
            lines = self.focus(timeout=min(3.0, remaining), recover=False)
            current, focused = self.focus_components(lines)
            if not self.exact_search_activity_visible(current, focused):
                raise RuntimeError("local_lookup_result_unconfirmed:foreground_changed")
            fresh = poco.freeze()
            self.poco_raise_if_account_restricted(fresh, "visual-result-after", phone_query_started=True)
            if self.poco_verification_evidence(fresh):
                raise RuntimeError("poco_alipay_human_verification_required")
            inputs = self.poco_nodes(fresh, name=SEARCH_INPUT_ID)
            if len(inputs) != 1 or self.poco_text(inputs[0]) != phone:
                raise RuntimeError("local_lookup_result_unconfirmed:input_changed")
            remaining = query_deadline - time.perf_counter()
            if remaining <= 0:
                raise observation_timeout()
            if restriction:
                if previous_restriction == restriction:
                    self.raise_account_restriction(
                        restriction, "visual-result", "poco_visual_readonly",
                        phone_query_started=True,
                    )
                previous_restriction = restriction
                previous = None
                sample = 0
                time.sleep(min(.25, remaining))
                continue
            previous_restriction = None
            if candidate is None:
                # The first screenshot may miss the loading animation and land
                # on a transition/network frame. Native foreground and exact
                # input were checked on both sides of this read. Wait within
                # the original deadline; never refresh or join separated cards.
                if previous is None:
                    if loading and not loading_reported:
                        self.emit("lookup_visual_loading_wait", driver="poco_visual_readonly",
                                  resubmitsInput=False, resubmitsSearch=False)
                        loading_reported = True
                    if not pending_reported:
                        self.emit("lookup_visual_pending_wait", driver="poco_visual_readonly",
                                  networkBusy=network_busy, resubmitsInput=False, resubmitsSearch=False)
                        pending_reported = True
                    time.sleep(min(.5, remaining))
                    continue
                raise RuntimeError("local_lookup_result_unconfirmed:visual_card_not_proven")
            if previous is not None and candidate != previous:
                raise RuntimeError("local_lookup_result_unconfirmed:visual_card_changed")
            previous = candidate
            if sample == 0:
                time.sleep(.25)
            sample += 1
        self.emit_query_result(previous, driver="poco_visual_readonly")
        return previous

    def run_poco(self, poco):
        operation = str(self.payload.get("operation") or "")
        if operation == "human_probe":
            # Positive search-page evidence is required; missing hierarchy or
            # another foreground app is unknown, never "verification passed".
            # No tap, drag, input, launch, fallback or worker repair is permitted.
            try:
                before = self.focus()
                snapshot = poco.freeze()
                texts = self.poco_snapshot_texts(snapshot, 200)
                markers = (VERIFICATION_TITLE, VERIFICATION_ACTION,
                           JIGSAW_VERIFICATION_ACTION)
                state = "unknown"
                if any(marker in text for text in texts for marker in markers):
                    state = "present"
                else:
                    inputs = self.poco_nodes(snapshot, name=SEARCH_INPUT_ID)
                    webviews = self.poco_nodes(snapshot, type="android.webkit.WebView")
                    after = self.focus()
                    def foreground(lines):
                        # Inactive virtual displays may have an exact null
                        # record. Keep every other record fail-closed and
                        # require one exact Alipay Window component.
                        current = [line for line in lines if "mCurrentFocus" in line
                                   and not re.fullmatch(r"\s*mCurrentFocus\s*=\s*null\s*", line)]
                        if len(current) != 1:
                            return False
                        window = re.fullmatch(
                            r"\s*mCurrentFocus\s*=\s*Window\{[^\s{}]+(?:\s+u\d+)?\s+"
                            r"([^\s{}/]+)/[^\s{}]+(?:\s+type=\d+)?\s*\}\s*", current[0])
                        return bool(window and window.group(1) == ALIPAY_PACKAGE)
                    if (foreground(before) and foreground(after) and len(inputs) == 1 and not webviews
                            and not any(marker in text for text in texts for marker in (
                                ACCESS_DENIED_TITLE, DEVICE_RISK_TITLE,
                                FREQUENT_OR_ABNORMAL_ACCESS_TITLE,
                                JIGSAW_FEEDBACK_PREFIX, "短信验证码登录"))
                            and inputs[0].attr("enabled") is True
                            and inputs[0].attr("visible") is not False):
                        state = "search_ready"
                return {"ok": True, "operation": operation, "verificationState": state}
            except Exception:
                return {"ok": True, "operation": operation, "verificationState": "unknown"}
        self.emit("poco_request_received", operation=operation, workflow="alipay_name")
        if self.adb(["get-state"], timeout=8).strip() != "device":
            raise RuntimeError("device_not_online")
        if operation != "stop" and not self.adb(["shell", "pm", "path", ALIPAY_PACKAGE], timeout=10).strip():
            raise RuntimeError("alipay_not_installed")
        self.emit("poco_reused", workflow="alipay_name")
        if operation == "start":
            start_attach_attempt = max(
                1, int(self.payload.get("startAttachAttempt") or 1)
            )
            if start_attach_attempt == 1:
                self.keep_awake_usb_best_effort()
            else:
                # The wake-on-USB command is only a non-critical convenience.
                # Repeating its two-second shell timeout after every Poco
                # transport rebuild steals the final attach's inspection
                # budget without changing the already-awake foreground page.
                self.emit(
                    "skip_repeat_keep_awake",
                    startAttachAttempt=start_attach_attempt,
                    reason="already_attempted_for_lookup_start",
                )
            reuse_selector_retry = 0
            while True:
                try:
                    reused = self.poco_try_reuse_search_page(poco)
                    break
                except Exception as exc:
                    raw_error = str(exc)
                    if "poco_alipay_login_required" in raw_error:
                        raise
                    if "human_verification_required:jigsaw_verification" in raw_error:
                        self.emit(
                            "lookup_session_ready_on_human_verification_page",
                            restrictionReason="jigsaw_verification",
                            phoneQueryStarted=False,
                            driver="poco",
                        )
                        return {
                            "ok": True,
                            "message": "search_session_human_verification_required",
                            "restrictionReason": "jigsaw_verification",
                            "requiresHumanAction": True,
                            "currentAccount": "",
                            "log": self.log,
                        }
                    restriction_reason = self.account_switch_reason_from_error(exc)
                    if (
                        "alipay_account_restriction_before_search:" in raw_error
                        and restriction_reason
                    ):
                        # The restriction page is already a stable, evidenced
                        # Alipay state.  Keep it in place and let the session open
                        # without relaunching Alipay, which would only invalidate
                        # Poco's hierarchy channel and can never make the search
                        # input available while this page remains foreground.
                        self.emit(
                            "lookup_session_ready_on_restriction_page",
                            restrictionReason=restriction_reason,
                            phoneQueryStarted=False,
                            driver="poco",
                        )
                        return {
                            "ok": True,
                            "message": "search_session_restricted",
                            "restrictionReason": restriction_reason,
                            "currentAccount": "",
                            "log": self.log,
                        }
                    if ("poco_alipay_local_service_" in raw_error or "poco_vivo_usb_mode_dialog:" in raw_error
                            or "poco_android_window_service_timeout" in raw_error
                            or "poco_data_network_acceleration_" in raw_error):
                        # An evidenced but uncloseable prompt must not trigger
                        # another launch, permission grant or arbitrary click.
                        raise
                    if "poco_rpc_failed:" in raw_error:
                        # A broken hierarchy transport cannot be healed by
                        # force-stopping and relaunching Alipay.  Return control
                        # to the Agent immediately so it can rebuild only the
                        # Poco worker and attach to the already-foreground app.
                        self.emit(
                            "reuse_search_transport_failed",
                            error=str(exc),
                            errorType=type(exc).__name__,
                            driver="poco",
                        )
                        raise
                    if (
                        (VIVO_SECURITY_CENTER_PACKAGE in raw_error
                         or HONOR_SOFTWARE_UPDATE_PACKAGE in raw_error)
                        and ("_resume_alipay_timeout" in raw_error
                             or "_dismiss_timeout" in raw_error)
                    ):
                        # An exact OEM overlay was identified but could not be
                        # detached safely.  Relaunching/force-stopping Alipay does
                        # not resolve the overlay and only destroys the warm task,
                        # so fail closed and let the Agent retain evidence.
                        self.emit(
                            "reuse_search_overlay_recovery_failed",
                            error=str(exc),
                            errorType=type(exc).__name__,
                            driver="poco_focus_adb",
                        )
                        raise
                    if (reuse_selector_retry == 0 and "poco_selector_missing:" in raw_error
                            and (focused_window_name(self.focus()) or "").startswith(ALIPAY_PACKAGE + "/")):
                        reuse_selector_retry += 1
                        self.emit("reuse_search_selector_missing_retry", retryAttempt=1,
                                  maxRetries=1, relaunchesAlipay=False, driver="poco")
                        time.sleep(0.15)
                        continue
                    self.emit("reuse_search_page_failed", error=str(exc), driver="poco")
                    reused = False
                    break
            if not reused:
                self.poco_prepare_full_path(poco, "session-start")
            return {"ok": True, "message": "search_session_ready", "currentAccount": "", "log": self.log}
        if operation == "stop":
            # A query restriction is already an evidenced terminal page.  A
            # stop request only needs to release the platform session; it must
            # not rebuild the search page with XML just to clear an input that
            # is no longer visible.  Keep the exact restriction page in place
            # for diagnosis/account switching and finish entirely in Poco.
            try:
                self.poco_dismiss_coloros_securepay_usb_dialog(poco)
                stop_snapshot = poco.freeze()
                stop_restriction = self.poco_account_restriction_evidence(stop_snapshot)
            except Exception as exc:
                self.emit(
                    "stop_restriction_probe_unavailable",
                    driver="poco", errorType=type(exc).__name__,
                )
                stop_restriction = None
            if stop_restriction:
                self.emit(
                    "lookup_session_stopped",
                    searchPageKeptWarm=False,
                    restrictionPageKeptForDiagnosis=True,
                    restrictionReason=stop_restriction.get("reason", ""),
                    driver="poco",
                )
                return {"ok": True, "message": "session_stopped", "log": self.log}
            input_node = self.poco_search_ready(poco, live=False)
            self.poco_tap(input_node)
            self.clear_focused_search_input(
                method="poco_exact_input_adb_keyevents",
            )
            self.emit("lookup_session_stopped", searchPageKeptWarm=True, driver="poco")
            return {"ok": True, "message": "session_stopped", "log": self.log}
        if operation not in ("query", "query_resume"):
            raise RuntimeError("unsupported_operation")
        phone = re.sub(r"\D", "", str(self.payload.get("phoneNumber") or ""))
        if not re.fullmatch(r"1\d{10}", phone):
            raise RuntimeError("invalid_phone_number")
        if self.payload.get("recoverUnexpectedPage") is True:
            if operation != "query":
                raise RuntimeError("page_recovery_operation_invalid")
            recovery_stage = self.payload.get("pageRecoveryStage")
            if recovery_stage not in ("restart_app", "continue_query"):
                raise RuntimeError("page_recovery_stage_invalid")
            # Never dismiss a visible verification/login/limit by restarting.
            # An unavailable hierarchy fails closed instead of guessing.
            self.dismiss_notification_shade_if_present()
            snapshot = poco.freeze()
            self.poco_raise_if_login_focus("\n".join(self.focus()), "page-recovery")
            self.poco_raise_if_login_required(snapshot, "page-recovery")
            self.poco_raise_if_account_restricted(
                snapshot, "page-recovery", phone_query_started=False,
            )
            if self.poco_verification_evidence(snapshot):
                raise RuntimeError("poco_alipay_human_verification_required")
            if recovery_stage == "restart_app":
                self.emit("query_page_recovery_begin", recoveryAttempt=1, sameTask=True, driver="poco")
                self.adb(["shell", "am", "force-stop", ALIPAY_PACKAGE], timeout=8)
                output = self.adb([
                    "shell", "am", "start", "-W", "-f", "0x10008000",
                    "-a", "android.intent.action.MAIN", "-c", "android.intent.category.LAUNCHER", "-n", ALIPAY_HOME,
                ], timeout=25)
                if "Error:" in str(output):
                    raise RuntimeError("alipay_restart_launch_failed")
                self.emit("launch_alipay", reason="query-page-recovery", driver="poco")
                # Do not read this now-invalid hierarchy or submit any digits.
                return {"ok": True, "appRecoveryStage": "app_restarted", "log": self.log}
            try:
                if not self.poco_try_reuse_search_page(poco):
                    raise RuntimeError("poco_recovery_alipay_not_foreground")
                self.poco_search_ready(poco, live=False)
            except Exception as exc:
                # No input has been entered in this worker. A transport error
                # while opening Search may be retried by one fresh attachment,
                # never by another app restart or by replaying a query result.
                if "poco_rpc_failed:" in str(exc):
                    raise RuntimeError(
                        f"poco_query_page_recovery_prepare_failed:{exc}"
                    ) from exc
                raise
            self.emit("query_page_recovery_ready", recoveryAttempt=1, driver="poco")
        self.assert_known_account()
        # A verified account switch may leave Alipay on Home if the independent
        # XML navigation could not reopen Search. Re-establish the search page
        # with Poco before any phone input occurs.
        if operation == "query" and not self.payload.get("recoverUnexpectedPage") and not self.poco_try_reuse_search_page(poco):
            raise RuntimeError("poco_query_search_page_unavailable_before_input")
        result = self.query_once_poco(
            poco, phone,
            resume_after_input=(operation == "query_resume"),
            allow_empty_reinput=bool(
                self.payload.get("allowEmptyInputRecovery", True)
            ),
            observation_only_resume=bool(self.payload.get("observationOnlyResume", False)),
        )
        return {
            "ok": True, **result, "currentAccount": "", **self.account_metadata(), "accountSwitched": False,
            "recoveryAttempts": 0,
            "elapsedMs": int((time.perf_counter() - self.started) * 1000), "log": self.log,
        }

    def dismiss_notification_shade_if_present(self):
        if focused_window_name(self.focus()) != "NotificationShade":
            return False
        # This only closes the evidenced system drawer; it never presses a
        # permission button, dismisses a verification, or changes a setting.
        self.adb(["shell", "cmd", "statusbar", "collapse"], timeout=5)
        deadline = time.monotonic() + 2.0
        while time.monotonic() < deadline:
            current = focused_window_name(self.focus())
            if current and current != "NotificationShade":
                self.emit("notification_shade_collapsed", driver="adb_exact_window")
                return True
            time.sleep(0.1)
        raise RuntimeError("notification_shade_collapse_unconfirmed")

    def wake_and_unlock_for_lookup_start(self):
        """Wake the display before reading the foreground Poco hierarchy.

        KEYCODE_WAKEUP is normally idempotent, but vivo V2442A on Android 14
        has been observed to leave ``mWakefulness=Asleep`` after accepting it.
        Only when a read-only power-state check proves that the screen is still
        asleep do we send KEYCODE_POWER, avoiding the risk of toggling an
        already-awake display off.
        """
        self.adb(["shell", "input", "keyevent", "224"], timeout=5, check=False)
        self.adb(["shell", "wm", "dismiss-keyguard"], timeout=5, check=False)
        power_state = str(self.adb(
            ["shell", "dumpsys", "power"], timeout=5, check=False,
        ))
        if re.search(r"mWakefulness\s*=\s*Asleep\b", power_state, re.IGNORECASE):
            self.adb(["shell", "input", "keyevent", "26"], timeout=5, check=False)
            self.adb(["shell", "wm", "dismiss-keyguard"], timeout=5, check=False)
            self.emit(
                "wake_display_power_fallback",
                reason="keycode_wakeup_left_device_asleep",
                driver="adb_power_state_guard",
            )
        else:
            self.emit("wake_display_ready", driver="adb_keycode_wakeup")

    def dismiss_unverified_account_modal_visual(self):
        """Dismiss Alipay's Canvas-only "account not verified" home modal.

        Some Alipay builds render this modal completely outside the
        accessibility hierarchy.  The underlying Home/My nodes are still
        exposed, so repeated element taps are silently consumed by the modal.
        Require the modal's responsive geometry (large bright centre card,
        blue CTA, dim surround, and a centred lower close ring) before tapping
        its detected close control.  This keeps the fallback fail-closed and
        avoids a blind coordinate or Back action on a normal home page.
        """
        try:
            import cv2
            import numpy as np

            raw = self.adb(["exec-out", "screencap", "-p"], timeout=15, binary=True)
            image = cv2.imdecode(np.frombuffer(raw, dtype=np.uint8), cv2.IMREAD_COLOR)
            if image is None:
                return False
            height, width = image.shape[:2]
            if width < 300 or height < 600:
                return False
            gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
            card = gray[int(height * .30):int(height * .69), int(width * .14):int(width * .86)]
            surround = gray[int(height * .34):int(height * .66), int(width * .02):int(width * .11)]
            cta = image[int(height * .60):int(height * .69), int(width * .22):int(width * .78)]
            if not card.size or not surround.size or not cta.size:
                return False
            bright_card_ratio = float((card >= 225).mean())
            dim_surround_ratio = float((surround <= 175).mean())
            blue_cta_ratio = float((
                (cta[:, :, 0] >= 150)
                & (cta[:, :, 0] >= cta[:, :, 1] * .95)
                & (cta[:, :, 2] <= 120)
            ).mean())
            if bright_card_ratio < .48 or dim_surround_ratio < .60 or blue_cta_ratio < .12:
                return False

            lower = gray[int(height * .71):int(height * .84), :]
            binary = (lower >= 205).astype(np.uint8)
            count, _, stats, centers = cv2.connectedComponentsWithStats(binary)
            candidates = []
            for index in range(1, count):
                x, y, component_width, component_height, area = stats[index]
                center_x, center_y = centers[index]
                absolute_y = float(center_y + int(height * .71))
                if not (width * .42 <= center_x <= width * .58):
                    continue
                if not (height * .735 <= absolute_y <= height * .82):
                    continue
                if not (width * .055 <= component_width <= width * .13):
                    continue
                if not (width * .055 <= component_height <= width * .13):
                    continue
                aspect = component_width / max(1.0, float(component_height))
                if not (.72 <= aspect <= 1.38):
                    continue
                if area < width * height * .00022:
                    continue
                candidates.append((int(round(center_x)), int(round(absolute_y)), int(area)))
            if len(candidates) != 1:
                return False
            tap_x, tap_y, area = candidates[0]
            self.adb(["shell", "input", "tap", str(tap_x), str(tap_y)], timeout=8)
            self.emit(
                "dismiss_alipay_unverified_account_modal",
                method="responsive_modal_close_detection",
                evidence={
                    "brightCardRatio": round(bright_card_ratio, 3),
                    "dimSurroundRatio": round(dim_surround_ratio, 3),
                    "blueCtaRatio": round(blue_cta_ratio, 3),
                    "closeComponentArea": area,
                },
                tap={"x": tap_x, "y": tap_y},
            )
            time.sleep(0.5)
            return True
        except Exception as exc:
            self.emit(
                "unverified_account_modal_visual_probe_failed",
                errorType=type(exc).__name__,
            )
            return False

    def cooling_accounts(self):
        cooling = set()
        for row in self.payload.get("accountCooldowns") or []:
            try:
                until = datetime.fromisoformat(str(row["cooldownUntil"]).replace("Z", "+00:00"))
                if until.tzinfo is None:
                    raise ValueError("missing timezone")
                if until.timestamp() > time.time():
                    cooling.add(str(row["account"]))
            except (KeyError, TypeError, ValueError, OverflowError):
                raise RuntimeError("alipay_account_cooldown_data_invalid")
        return cooling

    def account_metadata(self):
        if self.payload.get("accountCooldownProtocol") != 1:
            return {}
        return {
            "currentAccount": self.current_account(),
            "accountIdentityVerified": self.account_identity_verified,
            "savedAccounts": self.saved_accounts,
            "savedAccountCount": len(self.saved_accounts) or self.saved_account_count,
        }

    def assert_known_account(self):
        if self.payload.get("accountCooldownProtocol") != 1:
            return
        rows = self.saved_accounts
        accounts = [str(row.get("account") or "") for row in rows]
        current = [row for row in rows if row.get("current") is True]
        if (not self.account_identity_verified or not accounts or any(not value for value in accounts)
                or len(accounts) > 12 or len(set(accounts)) != len(accounts) or len(current) != 1
                or current[0]["account"] != self.current_account_after_switch):
            raise RuntimeError("alipay_account_identity_unverified")
        if self.current_account_after_switch in self.cooling_accounts():
            raise RuntimeError("alipay_account_preflight_required")

    def identify_cold_search_restriction_account(self, evidence):
        if (self.payload.get("accountCooldownProtocol") != 1
                or evidence.get("reason") != "frequent_or_abnormal_access"
                or evidence.get("title") != "您请求次数过于频繁"
                or evidence.get("hint") != "待会来试试"):
            raise RuntimeError("alipay_account_identity_unverified")
        _, current, _ = self.focus_state()
        search = ALIPAY_PACKAGE + "/com.alipay.android.phone.businesscommon.globalsearch.ui.MainSearchActivity"
        if focused_window_name([current]) != search:
            raise RuntimeError("alipay_account_identity_unverified")
        current, _ = self.exit_search_activity_for_account_navigation(
            "restricted-startup-identity", max_attempts=2)
        homes = {ALIPAY_HOME, ALIPAY_PACKAGE + "/" + ALIPAY_PACKAGE + ".AlipayLogin"}
        if focused_window_name([current]) not in homes:
            raise RuntimeError("alipay_account_identity_unverified")
        root, _ = self.dump("restricted-startup-home-proof")
        if self.verification_evidence(root):
            raise RuntimeError("alipay_human_verification_required:jigsaw_verification")
        if not self.canvas_real_name_home_evidence(root):
            raise RuntimeError("alipay_account_identity_unverified")
        rows = self.open_account_picker("restricted-startup-identity")
        accounts = self.saved_account_choices(rows)
        current_account = next(row[0] for row in rows if row[1])
        if self.current_account_after_switch and self.current_account_after_switch != current_account:
            raise RuntimeError("alipay_account_identity_unverified")
        self.saved_accounts = accounts
        self.saved_account_count = len(rows)
        self.current_account_after_switch = current_account
        self.account_identity_verified = True
        self.emit("lookup_restricted_startup_account_identified",
                  accountIdentityVerified=True, accountSelected=False, phoneQueryStarted=False)

    def prepare_available_account(self):
        # Never navigate away from a visible verification merely to select
        # another account. Startup/preflight does not submit a probe number.
        self.dismiss_canvas_real_name_prompt(None, "account-preflight-before-dump")
        try:
            root, parent = self.dump("account-preflight-visible-state")
        except RuntimeError as exc:
            # vivo's animated clock can prevent UIAutomator from becoming
            # idle. Only the evidenced clock foreground permits a single
            # non-destructive bring-to-front, then repeat all Alipay guards.
            if str(exc) != "uiautomator_hierarchy_missing":
                raise
            _, current, focused = self.focus_state()
            window = focused_window_name([current]) or ""
            if (not window.startswith("com.android.BBKClock/")
                    or "com.android.BBKClock/" not in focused
                    or ALIPAY_PACKAGE in focused):
                raise
            self.adb(["shell", "am", "start", "-W", "-f", "0x10200000",
                      "-a", "android.intent.action.MAIN", "-c", "android.intent.category.LAUNCHER",
                      "-n", ALIPAY_HOME], timeout=20)
            self.emit("account_preflight_clock_foreground_recovery", forceStopped=False,
                      phoneQueryStarted=False, accountSelected=False)
            time.sleep(.5)
            _, resumed, _ = self.focus_state()
            if not (focused_window_name([resumed]) or "").startswith(ALIPAY_PACKAGE + "/"):
                raise RuntimeError("alipay_account_preflight_foreground_unconfirmed")
            self.dismiss_canvas_real_name_prompt(None, "account-preflight-clock-resumed")
            root, parent = self.dump("account-preflight-clock-resumed")
        verification = self.verification_evidence(root)
        if verification:
            if verification.get("manual", True):
                raise RuntimeError("alipay_human_verification_required:jigsaw_verification")
            root, parent = self.solve_human_verification(root, parent, "account-preflight-visible-state")
        restriction = self.account_restriction_evidence(root)
        if restriction and self.current_account_after_switch not in self.cooling_accounts():
            # A cold start may inherit the evidenced Search restriction from
            # the preceding session. Read the current picker marker first;
            # never query, rotate or attribute it to a cached account by guess.
            if not self.account_identity_verified:
                self.identify_cold_search_restriction_account(restriction)
            self.assert_known_account()
            self.raise_account_restriction(restriction, "account-preflight-visible-state",
                                           "xml_uiautomator", phone_query_started=False)
        self.launch("account-preflight")
        rows = self.open_account_picker("preflight")
        self.saved_accounts = self.saved_account_choices(rows)
        self.saved_account_count = len(rows)
        self.current_account_after_switch = next(row[0] for row in rows if row[1])
        self.account_identity_verified = True
        cooling = self.cooling_accounts()
        if all(row[0] in cooling for row in rows):
            raise RuntimeError("alipay_no_available_account")
        if self.current_account_after_switch in cooling:
            self.switch_account(reason="cooldown", excluded_accounts=cooling,
                                reuse_open_picker=True, verify_current_marker=True)
            self.open_search("account-preflight-switch-complete")
        else:
            self.launch("account-preflight-complete")
            self.open_search("account-preflight-complete")
        self.emit("lookup_account_ready", **self.account_metadata())
        return self.account_metadata()

    def current_account(self):
        # The picker is not opened during the fast path. Return an empty value
        # unless a switch just produced exact account evidence.
        return self.current_account_after_switch if self.account_identity_verified else ""

    def clear_focused_search_input(self, method="focused_input_resource"):
        # Android's input command accepts multiple key codes.  Keep the same
        # bounded clear behavior without paying one ADB round trip per delete.
        # Do not pass --delay: older/OEM parsers can inject its numeric value
        # as an unrelated key.  Only MOVE_END and DEL belong in this command.
        self.adb(
            ["shell", "input", "keyevent", "123", *(["67"] * 24)],
            timeout=8,
        )
        self.emit(
            "clear_previous_query", selector="exact_search_input",
            method=method, keyCount=25, keyDelayMs=0, keyDelayMode="android_default",
        )

    def input_phone_humanized(self, phone, method, timeout=8, driver="xml_uiautomator"):
        # Retain the helper name for existing callers, but use only the
        # portable numeric-key grammar, with no options or timing tokens.
        if not isinstance(phone, str) or not re.fullmatch(r"1[0-9]{10}", phone):
            raise RuntimeError("invalid_phone_number")
        keycodes = [str(7 + int(digit)) for digit in phone]
        self.adb(
            ["shell", "input", "keyevent", *keycodes],
            timeout=timeout,
        )
        self.emit(
            "input_phone", method=method, keyCount=len(keycodes),
            keyDelayMs=0, keyDelayMode="android_default", driver=driver,
        )

    def clear_search_input(self, root, parent, input_node):
        target = self.tappable(input_node, parent)
        x, y = self.bounds_center(target.get("bounds"))
        self.adb(["shell", "input", "tap", str(x), str(y)], timeout=8)
        self.clear_focused_search_input(method="element_tap_batched_keyevents")

    def tap_visual_settings_gear(self, root):
        """Tap the Canvas-only settings gear after exact My-tab evidence.

        Alipay 10.8 may expose the selected bottom tab to UIAutomator while the
        entire profile body, including Settings, is rendered on Canvas.  The
        visual fallback is allowed only on the uniquely selected My tab and
        chooses the rightmost sizeable dark component in the top action row.
        """
        my_tabs = self.find(root, text="我的", resource_id=TAB_DESCRIPTION_ID)
        if len(my_tabs) != 1 or my_tabs[0].get("selected") != "true":
            raise RuntimeError("visual_settings_requires_selected_my_tab")
        try:
            import cv2
            import numpy as np
            raw = self.adb(["exec-out", "screencap", "-p"], timeout=15, binary=True)
            image = cv2.imdecode(np.frombuffer(raw, dtype=np.uint8), cv2.IMREAD_COLOR)
            if image is None:
                raise RuntimeError("settings_screenshot_decode_failed")
            gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
            height, width = gray.shape[:2]
            mask = (gray < 130).astype(np.uint8)
            mask[:int(height * .045), :] = 0
            mask[int(height * .15):, :] = 0
            mask[:, :int(width * .72)] = 0
            count, _, stats, centers = cv2.connectedComponentsWithStats(mask)
            candidates = []
            minimum_area = max(80, int(width * height * .00025))
            for index in range(1, count):
                x, y, component_width, component_height, area = stats[index]
                center_x, center_y = centers[index]
                if area < minimum_area:
                    continue
                if component_width < width * .035 or component_height < height * .018:
                    continue
                if not (height * .05 <= center_y <= height * .11):
                    continue
                candidates.append((float(center_x), float(center_y), int(area)))
            if not candidates:
                raise RuntimeError("settings_gear_component_missing")
            center_x, center_y, area = max(candidates, key=lambda item: item[0])
            tap_x, tap_y = int(round(center_x)), int(round(center_y))
            self.adb(["shell", "input", "tap", str(tap_x), str(tap_y)], timeout=8)
            self.emit(
                "open_settings", method="selected_my_tab_visual_gear",
                tap={"x": tap_x, "y": tap_y}, componentArea=area,
            )
            return True
        except Exception as exc:
            raise RuntimeError(f"alipay_visual_settings_open_failed:{exc}") from exc

    def canvas_real_name_home_evidence(self, root):
        # This fallback is exclusive to account preparation after a blocked
        # My-tab tap. Protected pages and an already selected My tab cannot
        # become generic screenshot-close targets.
        if root is None or self.verification_evidence(root) or self.account_restriction_evidence(root):
            return False
        homes = self.find(root, resource_id=TAB_SELECTED_FRAME_ID)
        my_tabs = self.find(root, text="我的", resource_id=TAB_DESCRIPTION_ID)
        return (len(homes) == 1 and homes[0].get("selected") == "true"
                and homes[0].get("content-desc") in {"首页", "推荐"}
                and len(my_tabs) == 1 and my_tabs[0].get("selected") == "false")

    def dismiss_canvas_real_name_prompt(self, root, token):
        """One evidenced circle-X tap, followed only by dismissal observation."""
        # root=None is the pre-XML startup path: the exact Home activity plus
        # two unique title/action/circle-X images are required instead. The
        # XML Home/verification checks still run after the modal is gone.
        if root is not None and not self.canvas_real_name_home_evidence(root):
            return False
        home_components = {ALIPAY_HOME, ALIPAY_PACKAGE + "/" + ALIPAY_PACKAGE + ".AlipayLogin"}
        _, current_focus, _ = self.focus_state()
        if focused_window_name([current_focus]) not in home_components:
            return False
        raw = self.adb(["exec-out", "screencap", "-p"], timeout=5, binary=True)
        evidence = real_name_canvas_evidence(raw)
        if evidence["close"] is None:
            return False
        # Re-read both UI and image before mutating; a late captcha or a
        # changed activity must not inherit the previous screenshot's X.
        fresh_root = root
        if root is not None:
            fresh_root, _ = self.dump(f"{token}-canvas-prompt-before-close")
        _, current_focus, _ = self.focus_state()
        if ((root is not None and not self.canvas_real_name_home_evidence(fresh_root))
                or focused_window_name([current_focus]) not in home_components):
            raise RuntimeError("alipay_canvas_prompt_foreground_changed")
        fresh = real_name_canvas_evidence(self.adb(["exec-out", "screencap", "-p"], timeout=5, binary=True))
        if fresh["close"] is None or any(abs(a-b) > 3 for a,b in zip(evidence["close"], fresh["close"])):
            raise RuntimeError("alipay_canvas_prompt_evidence_changed")
        _, current_focus, _ = self.focus_state()
        if focused_window_name([current_focus]) not in home_components:
            raise RuntimeError("alipay_canvas_prompt_foreground_changed")
        x, y = fresh["close"]
        self.adb(["shell", "input", "tap", str(x), str(y)], timeout=8)
        self.emit("dismiss_alipay_real_name_prompt", driver="xml_account_preflight_visual",
                  evidence="unique_visual_title_action_circle_x_and_home_focus",
                  tap={"x": x, "y": y}, authenticationStarted=False)
        for index in range(3):
            time.sleep(.3)
            _, current_focus, _ = self.focus_state()
            if focused_window_name([current_focus]) not in home_components:
                raise RuntimeError("alipay_canvas_prompt_foreground_changed")
            observed = real_name_canvas_evidence(self.adb(["exec-out", "screencap", "-p"], timeout=5, binary=True))
            if observed.get("unsupported"):
                raise RuntimeError("alipay_canvas_prompt_evidence_changed")
            if not observed["visible"]:
                after_root, _ = self.dump(f"{token}-canvas-prompt-after-close")
                if self.verification_evidence(after_root):
                    raise RuntimeError("alipay_human_verification_required:jigsaw_verification")
                if not self.canvas_real_name_home_evidence(after_root):
                    raise RuntimeError("alipay_canvas_prompt_evidence_changed")
                self.emit("alipay_canvas_real_name_prompt_dismissed", observation=index + 1)
                return True
        raise RuntimeError("alipay_canvas_real_name_prompt_not_dismissed")

    def enter_my_settings(self, token, max_attempts=3):
        """Enter My > Settings, tolerating only evidenced late startup ads.

        Alipay may expose the underlying home accessibility tree before its
        startup advertisement appears.  A blind tap on the visible-in-XML
        "My" tab is then consumed by the advertisement.  Treat navigation as
        successful only after the exact Settings element is present.
        """
        canvas_modal_back_recoveries = 0
        canvas_real_name_close_attempted = False
        for attempt in range(1, max_attempts + 1):
            deadline = time.time() + 12
            root = parent = None
            while time.time() < deadline:
                root, parent = self.dump(f"{token}-home-ready-{attempt}")
                restriction = self.account_restriction_evidence(root)
                if restriction:
                    root, parent = self.return_to_home_for_account_switch(restriction, token)
                if self.dismiss_known_overlay(root, parent):
                    self.emit("account_navigation_overlay_dismissed", attempt=attempt, phase="home")
                    time.sleep(0.5)
                    continue
                matches = self.find(root, text="我的", resource_id=TAB_DESCRIPTION_ID)
                if len(matches) == 1:
                    self.tap_unique(
                        root, parent, "open_my_tab", text="我的", resource_id=TAB_DESCRIPTION_ID,
                    )
                    break
                if len(matches) > 1:
                    raise RuntimeError("alipay_my_tab_not_unique")
                time.sleep(0.35)
            else:
                raise RuntimeError(
                    f"alipay_my_tab_missing:texts={self.texts(root, 50)!r}; focus={self.focus()!r}"
                )

            navigation_deadline = time.time() + 6
            while time.time() < navigation_deadline:
                root, parent = self.dump(f"{token}-settings-ready-{attempt}")
                if self.dismiss_known_overlay(root, parent):
                    self.emit("account_navigation_overlay_dismissed", attempt=attempt, phase="after_my_tap")
                    time.sleep(0.5)
                    break
                settings = self.find(root, desc="设置", resource_id=SETTINGS_ENTRY_ID)
                if len(settings) == 1:
                    self.tap_unique(
                        root, parent, "open_settings", desc="设置", resource_id=SETTINGS_ENTRY_ID,
                    )
                    return
                if len(settings) > 1:
                    raise RuntimeError("alipay_settings_entry_not_unique")
                time.sleep(0.35)
            if not canvas_real_name_close_attempted and self.canvas_real_name_home_evidence(root):
                canvas_real_name_close_attempted = True
                if self.dismiss_canvas_real_name_prompt(root, token):
                    continue
            try:
                self.tap_visual_settings_gear(root)
                self.wait_unique(f"{token}-visual-settings-ready-{attempt}", timeout=5, text="设置")
                return
            except Exception as exc:
                self.emit(
                    "visual_settings_fallback_failed", attempt=attempt, error=str(exc),
                )
            if (
                canvas_modal_back_recoveries < 1
                and self.dismiss_canvas_modal_after_blocked_my_tab(root, token)
            ):
                canvas_modal_back_recoveries += 1
                continue
            self.emit("account_navigation_retry", attempt=attempt, reason="settings_not_visible")
        raise RuntimeError("alipay_account_settings_navigation_failed")

    def open_account_picker(self, token):
        self.enter_my_settings(token)
        time.sleep(1.0)
        # Alipay 10.6 draws the "login other account" settings card on Canvas.
        # Instead of a fixed coordinate, derive the upper of the two bottom
        # white cards from the current screenshot.
        try:
            import cv2
            import numpy as np
            raw = self.adb(["exec-out", "screencap", "-p"], timeout=15, binary=True)
            image = cv2.imdecode(np.frombuffer(raw, dtype=np.uint8), cv2.IMREAD_COLOR)
            gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
            height, width = gray.shape[:2]
            ratio = (gray[:, int(width * .025):int(width * .975)] >= 252).mean(axis=1)
            mask = ratio >= .76
            mask[:int(height * .5)] = False
            runs, start = [], None
            for y, value in enumerate(mask):
                if value and start is None:
                    start = y
                if start is not None and (not value or y == height - 1):
                    end = y if not value else y + 1
                    if end - start >= int(height * .035):
                        runs.append((start, end))
                    start = None
            if len(runs) < 2:
                raise RuntimeError(f"account_cards_not_detected:{runs!r}")
            upper = runs[-2]
            self.adb(["shell", "input", "tap", str(width // 2), str((upper[0] + upper[1]) // 2)], timeout=8)
            self.emit("open_saved_account_picker", method="responsive_card_segmentation")
        except Exception as exc:
            raise RuntimeError(f"alipay_account_picker_open_failed:{exc}") from exc
        time.sleep(0.8)
        return self.wait_account_picker(token, timeout=12, allow_intermediate_sheet=True)

    def account_picker_snapshot(self, root, parent):
        """Only complete, visible saved rows on the normal account picker."""
        if (len(self.find(root, text="切换账号")) != 1
                or (self.find(root, text="轻触头像以切换账号")
                    and self.find(root, text="添加其他账号"))):
            return None
        rows = self.account_picker_rows(root, parent)
        try:
            self.saved_account_choices(rows)
        except RuntimeError:
            return None
        signature = []
        for account, current, node in rows:
            match = re.fullmatch(r"\[(\d+),(\d+)\]\[(\d+),(\d+)\]", node.get("bounds") or "")
            if not match:
                return None
            x1, y1, x2, y2 = map(int, match.groups())
            if x2 <= x1 or y2 <= y1:
                return None
            ancestor = node
            while ancestor is not None:
                if (ancestor.get("enabled") == "false"
                        or ancestor.get("visible-to-user") == "false"):
                    return None
                outer = ancestor.get("bounds")
                if outer:
                    try:
                        left, top, right, bottom = self.bounds_values(outer)
                    except RuntimeError:
                        return None
                    if not (left <= x1 < x2 <= right and top <= y1 < y2 <= bottom):
                        return None
                ancestor = parent.get(ancestor)
            signature.append((account, current, (x1, y1, x2, y2)))
        return rows, tuple(signature)

    def wait_account_picker(self, token, timeout=12, allow_intermediate_sheet=False):
        # A title can appear before rows finish loading or moving. A fresh path
        # per snapshot also prevents dump() from reading an older XML file if
        # UIAutomator fails to overwrite a repeated token during a transition.
        deadline = time.monotonic() + timeout
        previous = None
        entry_tapped = False
        picker_seen = False
        while time.monotonic() < deadline:
            self._account_picker_dump_seq = getattr(self, "_account_picker_dump_seq", 0) + 1
            root, parent = self.dump(f"account-picker-{token}-{self._account_picker_dump_seq}")
            picker_seen = picker_seen or bool(self.find(root, text="切换账号")
                or self.find(root, text="轻触头像以切换账号")
                or (self.find(root, text="登录其他账号")
                    and self.find(root, text="退出登录") and self.find(root, text="取消")))
            snapshot = self.account_picker_snapshot(root, parent)
            if snapshot:
                rows, signature = snapshot
                if signature == previous:
                    self.emit("account_picker_stable", savedAccountCount=len(rows), snapshots=2)
                    return rows
                previous = signature
            else:
                previous = None
                # Never use an underlying entry once either picker is visible.
                # A slow intermediate sheet may remain in several dumps after
                # a successful tap; it must never receive a second tap.
                has_picker = (self.find(root, text="切换账号")
                              or self.find(root, text="轻触头像以切换账号"))
                if allow_intermediate_sheet and not entry_tapped and not has_picker:
                    login_other = self.find(root, text="登录其他账号")
                    logout = self.find(root, text="退出登录")
                    cancel = self.find(root, text="取消")
                    if len(login_other) == len(logout) == len(cancel) == 1:
                        entry_tapped = True
                        self.tap_unique(root, parent, "open_login_other_account_sheet", text="登录其他账号")
                        self.emit("account_picker_intermediate_sheet_handled", entryTapCount=1,
                                  evidence=["登录其他账号", "退出登录", "取消"])
            time.sleep(0.25)
        if not allow_intermediate_sheet and not picker_seen:
            raise RuntimeError("alipay_open_account_picker_not_reusable")
        raise RuntimeError("alipay_account_picker_not_stable")

    def account_picker_rows(self, root, parent):
        rows = []
        for node in self.find(root, resource_id=ACCOUNT_ID):
            account = (node.get("text") or "").strip()
            container = parent.get(node)
            # Alipay reuses ACCOUNT_ID for its bottom "login other account"
            # action. It is navigation, never a saved identity or rotation row.
            if (account in {"登录其他账号", "登录其他账户"}
                    or container is not None and container.get("resource-id")
                    == "com.alipay.mobile.securitybiz:id/ll_switch_layout"):
                continue
            current = container is not None and any(
                (child.get("resource-id") or "") == ACCOUNT_CURRENT_ID and (child.get("text") or "").strip() == "当前"
                for child in container.iter("node")
            )
            rows.append((account, current, node))
        return rows

    def reuse_open_account_picker(self, token, timeout=8.0):
        """Read stable saved rows without tapping any navigation entry."""
        rows = self.wait_account_picker(f"reuse-{token}", timeout=timeout)
        self.emit("reuse_open_account_picker", savedAccountCount=len(rows))
        return rows

    @staticmethod
    def rotation_account_rows(rows, excluded_accounts=None):
        current_indexes = [index for index, row in enumerate(rows) if row[1]]
        if len(rows) < 2 or len(current_indexes) != 1:
            raise RuntimeError("alipay_saved_account_candidate_missing")
        current_index = current_indexes[0]
        # Alipay moves the current account to the first row. Choosing the first
        # non-current row therefore bounces between the two most recently used
        # accounts. Select the preceding row with wraparound; when current is
        # first this is the last saved row and rotates through the whole list.
        excluded = set(excluded_accounts or ())
        current = rows[current_index]
        for offset in range(1, len(rows)):
            candidate = rows[(current_index - offset) % len(rows)]
            if candidate[0] not in excluded:
                return current, candidate
        raise RuntimeError("alipay_all_saved_accounts_exhausted")

    @staticmethod
    def saved_account_choices(rows):
        current_rows = [row for row in rows if row[1]]
        accounts = [str(row[0] or "").strip() for row in rows]
        if not rows or len(rows) > 12 or len(current_rows) != 1 or any(not account for account in accounts):
            raise RuntimeError("alipay_saved_account_candidate_missing")
        if len(set(accounts)) != len(accounts):
            raise RuntimeError("alipay_saved_account_labels_not_unique")
        return [
            {"account": account, "current": bool(row[1])}
            for account, row in zip(accounts, rows)
        ]

    def switch_account(
        self, reason="", excluded_accounts=None, target_account="",
        reuse_open_picker=False, verify_current_marker=True,
    ):
        rows = None
        if reuse_open_picker:
            try:
                rows = self.reuse_open_account_picker("before")
            except Exception as exc:
                self.emit("reuse_open_account_picker_failed", error=str(exc))
                if str(exc) != "alipay_open_account_picker_not_reusable":
                    raise
        if rows is None:
            # Reusing the existing Alipay task avoids a destructive cold boot
            # between list_accounts and switch. The exact picker navigation
            # below still revalidates every screen before any account tap.
            self.resume_alipay_home("account-switch")
            rows = self.open_account_picker("before")
        self.saved_account_count = max(self.saved_account_count, len(rows))
        if self.payload.get("accountCooldownProtocol") == 1:
            self.saved_accounts = self.saved_account_choices(rows)
            excluded_accounts = set(excluded_accounts or ()) | self.cooling_accounts()
            if target_account and target_account in excluded_accounts:
                raise RuntimeError("alipay_target_account_cooling")
            if all(row[0] in self.cooling_accounts() for row in rows):
                raise RuntimeError("alipay_no_available_account")
        current_rows = [row for row in rows if row[1]]
        if len(current_rows) != 1:
            raise RuntimeError("alipay_saved_account_candidate_missing")
        current = current_rows[0]
        requested = str(target_account or "").strip()
        if requested:
            targets = [row for row in rows if row[0] == requested]
            if len(targets) != 1:
                raise RuntimeError(
                    f"alipay_target_account_not_unique_or_missing:target={requested}"
                )
            target = targets[0]
            if target[1]:
                raise RuntimeError(
                    f"alipay_target_account_already_current:target={requested}"
                )
        else:
            current, target = self.rotation_account_rows(rows, excluded_accounts)
        if reason in ACCOUNT_SWITCH_REASONS:
            self.restricted_accounts.add(current[0])
        x, y = self.bounds_center(target[2].get("bounds"))
        self.adb(["shell", "input", "tap", str(x), str(y)], timeout=8)
        # The selected account can immediately open another restriction page.
        # Record the actual selection before verifying it so a caller never
        # retries the switch and ping-pongs between two saved accounts.
        self.account_switched = True
        self.account_identity_verified = False
        self.current_account_after_switch = target[0]
        self.emit("account_selected", fromAccount=current[0], toAccount=target[0], selector="exact_account_resource")
        self.account_switch_history.append({
            "fromAccount": current[0], "toAccount": target[0], "reason": reason,
        })
        self.wait_unique("account-switch-returned-home", timeout=20, text="我的")
        self.emit("account_selection_returned_home")
        if verify_current_marker:
            verified_rows = self.open_account_picker("verify")
            verified = next((row for row in verified_rows if row[1]), None)
            if verified is None or verified[0] != target[0]:
                actual = verified[0] if verified else ""
                raise RuntimeError(f"alipay_account_switch_verification_failed:expected={target[0]};actual={actual}")
            current_account = verified[0]
            self.saved_accounts = self.saved_account_choices(verified_rows)
            self.account_identity_verified = True
            verification = "exact_current_marker"
            self.launch("account-switch-complete")
        else:
            # The user selected an exact row from the picker that list_accounts
            # intentionally left open. Returning to the unique Alipay home is
            # sufficient confirmation for this manual flow; reopening the
            # picker would only replay the same navigation a third time.
            current_account = target[0]
            verification = "exact_target_click_and_home_return"
        self.emit(
            "account_switch_verified", fromAccount=current[0],
            currentAccount=current_account, verification=verification,
        )
        # Account selection is complete at the verified Home page. Opening
        # Search belongs to the following Poco query; keeping it out of the
        # XML switch task avoids a second selector wait and guarantees that a
        # failed Search transition can never replay the account click.
        self.search_ready_after_switch = False
        self.emit(
            "account_switch_search_prepare_deferred",
            reason="next_poco_query_prepares_search", accountSwitchCompleted=True,
            retryAccountSwitch=False, driver="xml_uiautomator_account_switch",
        )
        return current_account

    def switch_account_for_reason(self, reason):
        self.emit(
            "account_switch_triggered", reason=reason, retryCurrentPhone=True,
            restrictedAccounts=sorted(self.restricted_accounts),
        )
        self.account_switch_reason = reason
        current_account = self.switch_account(
            reason=reason,
            excluded_accounts=self.restricted_accounts if reason in ACCOUNT_SWITCH_REASONS else None,
            verify_current_marker=False,
        )
        self.account_switched = True
        self.current_account_after_switch = current_account
        return current_account

    def wait_for_post_query_restriction_xml(self, phase, timeout=7.0):
        deadline = time.time() + timeout
        root = None
        while time.time() < deadline:
            try:
                root, _ = self.dump(phase)
                verification = self.verification_evidence(root)
                if verification and verification.get("manual"):
                    self.emit(
                        "human_verification_detected", evidence=verification,
                        token=phase, driver="xml_uiautomator",
                    )
                    raise RuntimeError(
                        "alipay_human_verification_required:jigsaw_verification"
                    )
                evidence = self.account_restriction_evidence(root)
                if evidence:
                    self.raise_account_restriction(
                        evidence, phase, "xml_uiautomator", phone_query_started=True,
                    )
            except Exception as exc:
                if "human_verification_required" in str(exc):
                    raise
                if self.account_switch_reason_from_error(exc):
                    raise
                self.emit(
                    "post_query_restriction_probe_retry", phase=phase,
                    driver="xml_uiautomator", error=str(exc),
                )
            time.sleep(0.3)
        self.emit(
            "post_query_restriction_not_observed", phase=phase,
            driver="xml_uiautomator", texts=self.texts(root, 30) if root is not None else [],
        )

    def query_once(self, phone, verification_recoveries=0, query_deadline=None):
        if query_deadline is None:
            query_deadline = time.perf_counter() + 55.0
        if self.focused_search_input_ready():
            self.clear_focused_search_input()
        else:
            root, parent, input_node = self.search_ready()
            self.clear_search_input(root, parent, input_node)
        self.wait_before_phone_input("xml_uiautomator")
        self.input_phone_humanized(
            phone, "reuse_search_EditText", timeout=8,
        )
        input_deadline = time.time() + 4
        actual_digits = ""
        while time.time() < input_deadline:
            root, parent = self.dump("input-readback")
            restriction = self.account_restriction_evidence(root)
            if restriction:
                self.raise_account_restriction(
                    restriction, "input-readback", "xml_uiautomator", phone_query_started=True,
                )
            verification = self.verification_evidence(root)
            if verification:
                root, parent = self.solve_human_verification(root, parent, "input-readback")
                if verification_recoveries >= 2:
                    raise RuntimeError("alipay_human_verification_repeatedly_invalidated_query")
                next_attempt = verification_recoveries + 1
                self.emit(
                    "replay_query_after_human_verification",
                    recoveryAttempt=next_attempt, phase="input-readback",
                )
                self.prepare_full_path(f"verification-recovery-{next_attempt}")
                return self.query_once(phone, next_attempt, query_deadline)
            inputs = self.find(root, resource_id=SEARCH_INPUT_ID)
            actual = (inputs[0].get("text") or "").strip() if len(inputs) == 1 else ""
            actual_digits = re.sub(r"\D", "", actual)
            if actual_digits == phone:
                # The first post-input hierarchy often already contains the
                # final result.  Parse it here instead of forcing another
                # 2–3 second UIAutomator dump before returning.
                result = self.parse_result(root, parent, phone)
                if result:
                    self.emit_query_result(result)
                    return result
                break
            time.sleep(0.3)
        else:
            self.wait_for_post_query_restriction_xml("input-readback-transition")
            raise RuntimeError(f"search_input_readback_mismatch:length={len(actual_digits)}")
        remaining_budget = max(0.0, query_deadline - time.perf_counter())
        deadline = time.time() + min(10.0, remaining_budget)
        submit_after = time.time() + 1.5
        submitted = False
        while time.time() < deadline:
            root, parent = self.dump("result")
            restriction = self.account_restriction_evidence(root)
            if restriction:
                self.raise_account_restriction(
                    restriction, "result", "xml_uiautomator", phone_query_started=True,
                )
            verification = self.verification_evidence(root)
            if verification:
                root, parent = self.solve_human_verification(root, parent, "result")
                result = self.parse_result(root, parent, phone)
                if result:
                    self.emit_query_result(result)
                    return result
                if verification_recoveries >= 2:
                    raise RuntimeError("alipay_human_verification_repeatedly_invalidated_query")
                next_attempt = verification_recoveries + 1
                self.emit(
                    "replay_query_after_human_verification",
                    recoveryAttempt=next_attempt, phase="result",
                )
                self.prepare_full_path(f"verification-recovery-{next_attempt}")
                return self.query_once(phone, next_attempt, query_deadline)
            result = self.parse_result(root, parent, phone)
            if result:
                self.emit_query_result(result)
                return result
            inputs = self.find(root, resource_id=SEARCH_INPUT_ID)
            actual = (inputs[0].get("text") or "").strip() if len(inputs) == 1 else ""
            result_input_digits = re.sub(r"\D", "", actual)
            if result_input_digits != phone:
                raise RuntimeError(f"search_input_readback_mismatch:length={len(result_input_digits)}")
            if not submitted and time.time() >= submit_after:
                confirms = self.find(root, resource_id="com.alipay.mobile.antui:id/search_confirm")
                if len(confirms) == 1:
                    node = self.tappable(confirms[0], parent)
                    cx, cy = self.bounds_center(node.get("bounds"))
                    self.adb(["shell", "input", "tap", str(cx), str(cy)], timeout=8)
                    self.emit("submit_search", selector="exact_search_confirm")
                    submitted = True
            time.sleep(0.45)
        raise RuntimeError(f"alipay_person_result_not_found:texts={self.texts(root, 60)!r}")

    def raise_after_account_switch(self, restriction_reason, error):
        event = (
            "alipay_access_denied_after_account_switch"
            if restriction_reason == "access_denied"
            else "alipay_account_restricted_after_account_switch"
        )
        self.emit(
            event,
            triggerReason=self.account_switch_reason,
            restrictionReason=restriction_reason,
            currentAccount=self.current_account_after_switch,
        )
        code = (
            "alipay_access_denied_after_account_switch"
            if restriction_reason == "access_denied"
            else f"alipay_account_restricted_after_account_switch:{restriction_reason}"
        )
        raise RuntimeError(code) from error

    def raise_all_accounts_restricted(self, restriction_reason, error):
        if self.current_account_after_switch:
            self.restricted_accounts.add(self.current_account_after_switch)
        self.account_switch_reason = restriction_reason
        self.emit(
            "alipay_all_saved_accounts_restricted",
            restrictionReason=restriction_reason,
            restrictedAccounts=sorted(self.restricted_accounts),
            savedAccountCount=self.saved_account_count,
            accountSwitchHistory=self.account_switch_history,
        )
        raise RuntimeError(
            f"alipay_all_saved_accounts_restricted:{restriction_reason}"
        ) from error

    def switch_once_for_reason(self, reason):
        try:
            return self.switch_account_for_reason(reason)
        except Exception as exc:
            restriction_reason = self.account_switch_reason_from_error(exc)
            if restriction_reason and self.account_switched:
                self.raise_after_account_switch(restriction_reason, exc)
            raise

    def run(self):
        operation = str(self.payload.get("operation") or "")
        if self.adb(["get-state"], timeout=8).strip() != "device":
            raise RuntimeError("device_not_online")
        if operation != "stop" and not self.adb(["shell", "pm", "path", ALIPAY_PACKAGE], timeout=10).strip():
            raise RuntimeError("alipay_not_installed")
        if operation == "start":
            self.keep_awake_usb_best_effort()
            if self.payload.get("accountCooldownProtocol") == 1:
                self.wake_and_unlock_for_lookup_start()
                return {"ok": True, "message": "search_session_ready",
                        **self.prepare_available_account(), "accountSwitched": self.account_switched,
                        "accountSwitchReason": self.account_switch_reason, "log": self.log}
            try:
                reused = self.try_reuse_search_page()
            except Exception as exc:
                self.emit("reuse_search_page_failed", error=str(exc))
                reused = False
            if not reused:
                self.prepare_full_path("session-start")
            return {
                "ok": True,
                "message": "search_session_ready",
                "currentAccount": self.current_account_after_switch or self.current_account(),
                "accountSwitched": self.account_switched,
                "accountSwitchReason": self.account_switch_reason,
                "log": self.log,
            }
        if operation == "list_accounts":
            self.emit("manual_account_list_requested", retryCurrentPhone=False)
            self.resume_alipay_home("account-list")
            rows = self.open_account_picker("list")
            choices = self.saved_account_choices(rows)
            self.saved_account_count = max(self.saved_account_count, len(rows))
            current_account = next(choice["account"] for choice in choices if choice["current"])
            self.current_account_after_switch = current_account
            self.account_identity_verified = True
            self.saved_accounts = choices
            self.emit(
                "saved_account_list_ready", currentAccount=current_account,
                savedAccountCount=len(choices),
            )
            return {
                "ok": True,
                "message": "saved_account_list_ready",
                "currentAccount": current_account,
                "accountIdentityVerified": True,
                "savedAccounts": choices,
                "accountSwitched": False,
                "savedAccountCount": self.saved_account_count,
                "log": self.log,
            }
        if operation == "switch":
            target_account = str(self.payload.get("targetAccount") or "").strip()
            if not target_account:
                raise RuntimeError("alipay_target_account_required")
            self.emit(
                "manual_account_switch_requested", retryCurrentPhone=False,
                targetAccount=target_account,
            )
            current_account = self.switch_account(
                reason="manual", target_account=target_account,
                reuse_open_picker=True, verify_current_marker=self.payload.get("accountCooldownProtocol") == 1,
            )
            return {
                "ok": True,
                "message": "account_switch_completed",
                "currentAccount": current_account,
                **self.account_metadata(),
                "accountSwitched": True,
                "accountSwitchReason": "manual",
                "accountSwitchCount": len(self.account_switch_history),
                "accountSwitchHistory": self.account_switch_history,
                "savedAccountCount": self.saved_account_count,
                "searchReady": self.search_ready_after_switch,
                "log": self.log,
            }
        if operation == "stop":
            warmed = False
            try:
                root, parent, input_node = self.search_ready()
                self.clear_search_input(root, parent, input_node)
                warmed = True
            except Exception as exc:
                self.emit("stop_cleanup_skipped", reason=str(exc))
            self.emit("lookup_session_stopped", searchPageKeptWarm=warmed)
            return {"ok": True, "message": "session_stopped", "log": self.log}
        if operation != "query":
            raise RuntimeError("unsupported_operation")
        self.assert_known_account()
        phone = re.sub(r"\D", "", str(self.payload.get("phoneNumber") or ""))
        if not re.fullmatch(r"1\d{10}", phone):
            raise RuntimeError("invalid_phone_number")
        max_recoveries = min(2, max(0, int(self.payload.get("maxRecoveryAttempts", 2))))

        def query_with_recovery():
            query_started = time.perf_counter()
            query_deadline = query_started + 55.0
            last_error = None
            for attempt in range(max_recoveries + 1):
                try:
                    return self.query_once(phone, query_deadline=query_deadline), attempt
                except Exception as exc:
                    last_error = exc
                    raw_error = str(exc)
                    if self.account_switch_reason_from_error(raw_error):
                        raise
                    if "alipay_human_verification_required" in raw_error:
                        raise
                    query_elapsed = time.perf_counter() - query_started
                    if attempt >= max_recoveries or query_elapsed >= 50:
                        break
                    self.emit("query_full_path_recovery", attempt=attempt + 1, error=raw_error)
                    # App/page recovery preserves the already verified account.
                    self.prepare_full_path(f"query-recovery-{attempt + 1}")
            raise RuntimeError(f"alipay_lookup_failed_after_recovery:{last_error}")

        # Jigsaw verification is a human-control pause and never changes the
        # account. Only the exact, evidenced account-limit reasons above rotate
        # saved accounts. Every rotation retries this same phone before the
        # caller's queue may advance to the next item.
        while True:
            try:
                result, recovery_attempts = query_with_recovery()
                break
            except Exception as exc:
                restriction_reason = self.account_switch_reason_from_error(exc)
                if restriction_reason not in ACCOUNT_SWITCH_REASONS:
                    raise
                if self.payload.get("accountCooldownProtocol") == 1:
                    # The Agent persists and acknowledges cooldown before it
                    # schedules a separate bounded account preflight.
                    raise
                while True:
                    try:
                        self.switch_account_for_reason(restriction_reason)
                        break
                    except Exception as switch_error:
                        next_reason = self.account_switch_reason_from_error(switch_error)
                        if "alipay_all_saved_accounts_exhausted" in str(switch_error):
                            self.raise_all_accounts_restricted(restriction_reason, switch_error)
                        if next_reason in ACCOUNT_SWITCH_REASONS and self.current_account_after_switch:
                            self.restricted_accounts.add(self.current_account_after_switch)
                            restriction_reason = next_reason
                            continue
                        raise
        return {
            "ok": True,
            **result,
            "currentAccount": self.current_account_after_switch,
            **self.account_metadata(),
            "accountSwitched": self.account_switched,
            "accountSwitchReason": self.account_switch_reason,
            "accountSwitchCount": len(self.account_switch_history),
            "accountSwitchHistory": self.account_switch_history,
            "restrictedAccounts": sorted(self.restricted_accounts),
            "recoveryAttempts": recovery_attempts,
            "elapsedMs": int((time.perf_counter() - self.started) * 1000),
            "log": self.log,
        }


def run_poco_operation(payload, poco):
    """Run one Alipay operation inside the Agent's resident Poco worker."""
    runner = Runner(payload)
    try:
        result = runner.run_poco(poco)
        result.setdefault("elapsedMs", int((time.perf_counter() - runner.started) * 1000))
        return result
    except Exception as exc:
        runner.emit("poco_fast_path_failed", error=repr(exc), workflow="alipay_name")
        return {
            "ok": False,
            "error": str(exc),
            "elapsedMs": int((time.perf_counter() - runner.started) * 1000),
            "log": runner.log,
        }


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--payload", required=True)
    args = parser.parse_args()
    with open(args.payload, "r", encoding="utf-8") as handle:
        payload = json.load(handle)
    runner = Runner(payload)
    try:
        result = runner.run()
        result.setdefault("elapsedMs", int((time.perf_counter() - runner.started) * 1000))
    except Exception as exc:
        runner.emit("error", error=repr(exc), trace=traceback.format_exc(), focus=runner.focus())
        result = {
            "ok": False,
            "error": str(exc),
            "accountSwitched": runner.account_switched,
            "currentAccount": runner.current_account_after_switch,
            **runner.account_metadata(),
            "accountSwitchReason": runner.account_switch_reason,
            "accountSwitchCount": len(runner.account_switch_history),
            "accountSwitchHistory": runner.account_switch_history,
            "restrictedAccounts": sorted(runner.restricted_accounts),
            "savedAccountCount": runner.saved_account_count,
            "elapsedMs": int((time.perf_counter() - runner.started) * 1000),
            "log": runner.log,
        }
    print(json.dumps(result, ensure_ascii=True), flush=True)
    return 0 if result.get("ok") else 1


if __name__ == "__main__":
    raise SystemExit(main())
