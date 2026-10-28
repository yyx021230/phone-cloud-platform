#!/usr/bin/env python3
import argparse
import json
import os
import subprocess
import sys
import threading
import time
import traceback
import xml.etree.ElementTree as ET

CURRENT_ADB_PATH = ""
CURRENT_SERIAL = ""
CURRENT_RUN_STARTED_AT = 0.0
CURRENT_LAST_EMIT_AT = 0.0
CURRENT_RUN_DEADLINE_AT = None
CURRENT_TARGET_RUN_MS = 60000
SCREEN_SIZE_CACHE = {}


class DisabledKeepRunningInstrumentationThread:
    def __init__(self, *args, **kwargs):
        self._stopped = False

    def start(self):
        return None

    def stop(self):
        self._stopped = True

    def join(self, timeout=None):
        return None


def start_poco_instrument_once(poco, port, timeout_seconds=12.0, http=None):
    """Wait for one owned service; the worker then proves its HRPC channel.

    The SDK retries am instrument on every connection refusal without reaping
    the previous process. Slow OEM startup can then restart itself repeatedly.
    The Agent already owns bounded worker retries; do not nest another retry
    loop or kill/uninstall unrelated UiAutomator owners inside the SDK.

    PocoService 1.0.0.68 implements connectionState by dumping the entire
    hierarchy. Polling it with short HTTP deadlines queues expensive page
    traversals: timing out the client does not cancel the Android traversal.
    Use the service's lightweight display-size endpoint for this bootstrap
    phase. This is NOT worker readiness: verify_poco_transport_ready must
    still complete an actual bounded selector RPC before workerReady.
    """
    if http is None:
        import requests
        http = requests.Session()
        http.trust_env = False  # ADB loopback must not use a system HTTP proxy.
    started = time.perf_counter()
    deadline = started + max(0.5, min(float(timeout_seconds), 12.0))
    adb = poco.adb_client
    package = "com.netease.open.pocoservice"
    output = {"stdout": "", "stderr": ""}
    proc = None
    readers = []
    last_error = "instrumentation_not_started"
    last_observation_at = started

    def drain(stream, key):
        try:
            for line in iter(stream.readline, b""):
                if not line:
                    break
                text = line.decode("utf-8", errors="replace") if isinstance(line, bytes) else str(line)
                output[key] = (output[key] + text)[-2400:]
        except Exception:
            pass

    try:
        run_adb(adb.adb_path, adb.serialno, ["shell", "am", "start", "-n", f"{package}/.TestActivity"], timeout=3)
        proc = adb.start_shell([
            "am", "instrument", "-w", "-e", "debug", "false", "-e", "class",
            f"{package}.InstrumentedTestAsLauncher", f"{package}/androidx.test.runner.AndroidJUnitRunner",
        ])
        poco._instrument_proc = proc
        emit([], "poco_instrumentation_launch_started", instrumentationLaunches=1)
        for key in output:
            stream = getattr(proc, key, None)
            if stream is not None:
                reader = threading.Thread(target=drain, args=(stream, key), daemon=True)
                reader.start()
                readers.append(reader)
        last_error = "connection_not_ready"
        while time.perf_counter() < deadline:
            exit_code = proc.poll()
            if exit_code is not None:
                for reader in readers:
                    reader.join(0.1)
                raise RuntimeError(f"instrumentation_exited:code={exit_code}:{output}")
            try:
                response = http.get(
                    f"http://{poco.device_ip}:{port}/screen_size",
                    timeout=max(0.05, min(0.5, deadline - time.perf_counter())),
                )
                size = response.json() if response.status_code == 200 else None
                valid_size = (
                    isinstance(size, list) and len(size) == 2
                    and all(type(value) is int and value > 0 for value in size)
                )
                if valid_size:
                    if proc.poll() is not None:
                        raise RuntimeError("instrumentation_exited_after_connection")
                    emit([], "poco_instrumentation_connected", elapsedMs=int((time.perf_counter() - started) * 1000), instrumentationLaunches=1, probe="screen_size", hierarchyVerified=False)
                    return True
                last_error = f"poco_service_invalid_screen_size:http_status={response.status_code}"
            except Exception as exc:
                last_error = f"{type(exc).__name__}:{exc}"
            if time.perf_counter() - last_observation_at >= 4:
                last_observation_at = time.perf_counter()
                emit([], "poco_instrumentation_waiting", elapsedMs=int((last_observation_at-started)*1000), reason=last_error[-700:], processAlive=proc.poll() is None)
            time.sleep(min(0.2, max(0, deadline - time.perf_counter())))
        raise RuntimeError(f"connection_deadline:{last_error}:{output}")
    except Exception as exc:
        # The Agent may recycle a bootstrap before a task payload exists, so
        # persist the real handshake failure as a streamed event. A generic
        # final retry timeout must not erase the earlier Android/HTTP cause.
        emit([], "poco_instrumentation_handshake_failed", elapsedMs=int((time.perf_counter()-started)*1000), error=str(exc)[-1800:], reason=last_error[-700:], instrumentationOutput=dict(output))
        # Reap the exact host process we created, not other device sessions.
        if proc is not None and proc.poll() is None:
            proc.kill()
            try:
                proc.wait(timeout=1)
            except Exception:
                pass
        raise RuntimeError(f"poco_worker_instrumentation_handshake_failed:{exc}") from exc
    finally:
        if hasattr(http, "close"):
            http.close()


def create_stable_poco(**options):
    import poco.drivers.android.uiautomation as uiautomation

    original = uiautomation.KeepRunningInstrumentationThread
    uiautomation.KeepRunningInstrumentationThread = DisabledKeepRunningInstrumentationThread
    class ManagedAndroidPoco(uiautomation.AndroidUiautomationPoco):
        def _install_service(self):
            # Production QA is not permission to install or update an APK.
            adb = self.adb_client
            existing = run_adb(adb.adb_path, adb.serialno, ["shell", "pm", "path", "com.netease.open.pocoservice"], timeout=4)
            if "package:" not in existing:
                raise RuntimeError("poco_service_not_installed")
            return False

        def _start_instrument(self, port_to_ping, force_restart=False):
            return start_poco_instrument_once(self, port_to_ping)

        def _kill_uiautomator(self):
            raise RuntimeError("poco_worker_instrumentation_handshake_failed:external_instrumentation_owner")

    try:
        poco = ManagedAndroidPoco(**options)
        # HRPC defaults every remote selector evaluation to 15 seconds.  One
        # seemingly small ``exists()`` call can issue several RPCs, so a stale
        # PocoService used to block a task for roughly 150 seconds before the
        # outer worker watchdog could react.  Bound each RPC at the transport
        # client instead; selector loops can then try the next exact element or
        # the existing popup-recovery path within the product's 60-second
        # target instead of consuming the whole task budget in one call.
        timeout_seconds = float(os.environ.get("PHONE_CLOUD_POCO_RPC_TIMEOUT_SECONDS", "2.0"))
        timeout_seconds = max(0.5, min(timeout_seconds, 5.0))
        client = getattr(getattr(poco, "_agent", None), "client", None)
        if client is not None and hasattr(client, "set_timeout"):
            client.set_timeout(timeout_seconds)
            # hrpc's event wait honors ``set_timeout``, but its HTTP transport
            # sends synchronous requests with ``timeout=None`` first.  If the
            # on-device PocoService accepts the connection and then stops
            # responding, requests.post() can therefore block forever before
            # hrpc reaches its bounded event wait.  Substitute the same bound
            # only for those synchronous calls; fire-and-forget calls retain
            # their explicit shorter timeout.
            transport = getattr(client, "transport", None)
            original_send = getattr(transport, "send", None)
            if callable(original_send):
                def bounded_transport_send(request, timeout=None):
                    effective_timeout = timeout_seconds if timeout is None else timeout
                    return original_send(request, timeout=effective_timeout)

                transport.send = bounded_transport_send
        return poco
    finally:
        uiautomation.KeepRunningInstrumentationThread = original


def stop_stable_poco(poco, adb_path, serial, verify=False):
    thread = getattr(poco, "_keep_running_thread", None)
    if thread is not None:
        thread.stop()
        thread.join(0)

    # Airtest's remove_forwards() calls adb without a timeout. A wedged USB
    # transport can therefore keep this worker alive forever and block screen
    # control. Remove only this Poco instance's forwards with a strict bound.
    forwards = list(getattr(poco, "forward_list", None) or [])
    try:
        poco.forward_list = []
    except Exception:
        pass
    for local in forwards:
        try:
            run_adb(adb_path, serial, ["forward", "--remove", local], timeout=1)
        except Exception:
            pass

    instrument = getattr(poco, "_instrument_proc", None)
    if instrument is not None and instrument.poll() is None:
        try:
            instrument.kill()
        except Exception:
            pass
    packages = ("com.netease.open.pocoservice", "com.netease.open.pocoservice.test")
    for package_name in packages:
        try:
            run_adb(adb_path, serial, ["shell", "am", "force-stop", package_name], timeout=5)
        except Exception:
            pass
    # ActivityManager can detach the target process before the instrumentation
    # test package. Verify both owners after one bounded grace period and
    # force-stop only a package that actually survived; never restart ADB,
    # USB, the phone, or the app under test.
    time.sleep(0.25)
    for package_name in packages:
        try:
            remaining = run_adb(
                adb_path, serial, ["shell", "pidof", package_name], timeout=2,
            ).strip()
            if remaining:
                run_adb(
                    adb_path, serial, ["shell", "am", "force-stop", package_name], timeout=3,
                )
        except Exception:
            pass

    if verify:
        for package_name in packages:
            observed = run_adb(adb_path, serial,
                ["shell", f"pidof {package_name} || echo LOOKUP_READER_ABSENT"], timeout=2).strip()
            if observed != "LOOKUP_READER_ABSENT":
                raise RuntimeError("lookup_reader_cleanup_unconfirmed")
        listing = run_adb(adb_path, serial, ["forward", "--list"], timeout=2)
        for line in listing.splitlines():
            columns = line.split()
            if len(columns) == 3 and columns[0] == serial and columns[1] in forwards:
                raise RuntimeError("lookup_reader_forward_cleanup_unconfirmed")


def reset_stale_poco_instrumentation(adb_path, serial):
    """Clear only this phone's orphaned Poco instrumentation before startup."""
    for package_name in ("com.netease.open.pocoservice", "com.netease.open.pocoservice.test"):
        try:
            run_adb(adb_path, serial, ["shell", "am", "force-stop", package_name], timeout=5)
        except Exception:
            pass
    time.sleep(0.3)


def verify_poco_transport_ready(poco):
    """Prove that the device-side HRPC hierarchy channel really responds.

    ``AndroidUiautomationPoco`` returning only proves that instrumentation and
    local port forwarding were created.  A half-started PocoService can still
    accept the HTTP connection and never answer the first selector request.
    Perform one bounded, package-neutral selector round trip before the worker
    advertises readiness to the Agent.  The selector is allowed to be absent;
    a boolean response itself is the health proof.
    """
    started_at = time.perf_counter()
    for attempt in range(2):
        try:
            bool(poco(type="android.widget.FrameLayout").exists())
            return int((time.perf_counter() - started_at) * 1000)
        except Exception as exc:
            # Instrumentation can answer screen_size before its hierarchy is
            # ready after an app launch. Retry only this read, on the same
            # owned service; no task payload or phone input has run yet.
            reason = str(exc).lower()
            transient = isinstance(exc, (TimeoutError, ConnectionError)) or any(
                token in reason for token in ("timed out", "timeout", "connection refused",
                    "connection reset", "connection aborted", "remotedisconnected"))
            emit([], "poco_worker_transport_probe_retry" if transient and attempt == 0
                 else "poco_worker_transport_probe_failed", attempt=attempt + 1,
                 errorType=type(exc).__name__, observationOnly=True, taskStarted=False)
            if not transient or attempt:
                raise RuntimeError(f"poco_worker_transport_probe_failed:{exc}") from exc
            time.sleep(.25)


def verify_worker_adb_transport(adb_path, serial, attempts=2):
    """Tolerate one transient ADB shell failure before abandoning a worker.

    Several fleet phones briefly reject the first shell command while Windows
    finishes exposing the USB interface.  Exiting the whole Poco worker on
    that single probe made a healthy phone fail before any Alipay operation
    ran.  Keep the retry count and each subprocess timeout strictly bounded.
    """
    last_error = None
    for attempt in range(1, max(1, int(attempts)) + 1):
        try:
            return run_adb(adb_path, serial, ["shell", "echo", "ok"], timeout=4)
        except Exception as exc:
            last_error = exc
            if attempt < attempts:
                time.sleep(0.25)
    raise last_error


def emit(log, step, **detail):
    global CURRENT_LAST_EMIT_AT
    now = time.perf_counter()
    timing = {}
    if CURRENT_RUN_STARTED_AT:
        timing["elapsedMs"] = int((now - CURRENT_RUN_STARTED_AT) * 1000)
    if CURRENT_LAST_EMIT_AT:
        timing["sinceLastMs"] = int((now - CURRENT_LAST_EMIT_AT) * 1000)
    CURRENT_LAST_EMIT_AT = now
    item = {"step": step, **timing, **detail}
    log.append(item)
    # Windows agents may inherit a GBK console; escaping snapshot text keeps
    # emoji from interrupting the final machine-readable result.
    print(json.dumps({"event": item}, ensure_ascii=True), flush=True)


def run_adb(adb_path, serial, args, timeout=15):
    proc = subprocess.run(
        [adb_path, "-s", serial, *args],
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="ignore",
        timeout=timeout,
    )
    if proc.returncode != 0:
        raise RuntimeError((proc.stderr or proc.stdout or f"adb exited {proc.returncode}").strip())
    return (proc.stdout or "").strip()


def screen_size(adb_path, serial):
    key = (adb_path, serial)
    if key in SCREEN_SIZE_CACHE:
        return SCREEN_SIZE_CACHE[key]
    out = run_adb(adb_path, serial, ["shell", "wm", "size"], timeout=5)
    size = (1080, 2400)
    for token in out.replace("\r", "\n").split():
        if "x" not in token:
            continue
        left, right = token.split("x", 1)
        if left.isdigit() and right.isdigit():
            size = (int(left), int(right))
            break
    SCREEN_SIZE_CACHE[key] = size
    return size


def tap_node(node, post_wait=0.5):
    if CURRENT_ADB_PATH and CURRENT_SERIAL:
        # The element has already been resolved by Poco. Execute the tap over
        # bounded ADB only; falling back to ``node.click()`` after a transient
        # ADB error re-enters an unbounded HRPC call and can hold the entire
        # task until the outer 180-second watchdog fires.
        x, y = node.get_position()
        try:
            width, height = screen_size(CURRENT_ADB_PATH, CURRENT_SERIAL)
        except Exception:
            width, height = (1080, 2400)
        px = max(1, min(width - 1, int(round(x * width))))
        py = max(1, min(height - 1, int(round(y * height))))
        run_adb(CURRENT_ADB_PATH, CURRENT_SERIAL, ["shell", "input", "tap", str(px), str(py)], timeout=5)
        time.sleep(post_wait)
        return
    node.click()
    time.sleep(post_wait)


def focus(adb_path, serial):
    try:
        out = run_adb(adb_path, serial, ["shell", "dumpsys", "window"], timeout=8)
        return [
            line.strip()
            for line in out.splitlines()
            if "mCurrentFocus" in line or "mFocusedApp" in line
        ]
    except Exception as exc:
        return [f"focus_error={exc}"]


def maybe_focus(adb_path, serial, enabled=False):
    return focus(adb_path, serial) if enabled else []


def package_from_focus(lines):
    text = "\n".join(lines)
    # Clone-app choosers use different framework activities across vendors:
    # vivo exposes DoubleAppResolverActivity while Xiaomi/Redmi uses the
    # platform ResolverActivity. Both are valid intermediate surfaces before
    # entering the requested XHS slot.
    if (
        "com.android.intentresolver" in text
        or "DoubleAppResolverActivity" in text
        or "android/com.android.internal.app.ResolverActivity" in text
    ):
        return "com.android.intentresolver"
    if "com.xingin.xhs" in text:
        return "com.xingin.xhs"
    if "com.android.packageinstaller" in text:
        return "com.android.packageinstaller"
    return ""


def is_keyguard_showing(adb_path, serial):
    try:
        out = run_adb(adb_path, serial, ["shell", "dumpsys", "window", "policy"], timeout=8)
        normalized = out.replace(" ", "").lower()
        return "showing=true" in normalized or "isstatusbarkeyguard=true" in normalized
    except Exception:
        return False


def wake_and_unlock(adb_path, serial, log):
    try:
        was_locked = is_keyguard_showing(adb_path, serial)
        state = run_adb(adb_path, serial, ["shell", "dumpsys", "power"], timeout=8)
        if "mWakefulness=Asleep" in state:
            emit(log, "wake_device")
        # KEYCODE_WAKEUP does not toggle an already-awake screen, unlike the
        # power key.  Xiaomi can keep a non-secure keyguard above a launched
        # app, so always attempt dismissal before the XHS navigation begins.
        run_adb(adb_path, serial, ["shell", "input", "keyevent", "224"], timeout=8)
        time.sleep(0.5)
        run_adb(adb_path, serial, ["shell", "wm", "dismiss-keyguard"], timeout=8)
        if was_locked:
            run_adb(adb_path, serial, ["shell", "input", "swipe", "500", "1600", "500", "500", "300"], timeout=8)
        time.sleep(0.8)
        if is_keyguard_showing(adb_path, serial):
            # Vivo can show a USB system dialog immediately after wake.  Its
            # window policy still reports the keyguard as showing, even though
            # the device is already unlocked.  Dismiss that transient dialog
            # instead of classifying the phone as requiring manual unlock.
            current_focus = "\n".join(focus(adb_path, serial))
            if "VivoUsbDialog" in current_focus:
                run_adb(adb_path, serial, ["shell", "input", "keyevent", "4"], timeout=8)
                time.sleep(0.6)
                emit(log, "dismiss_vivo_usb_dialog")
            if is_keyguard_showing(adb_path, serial) and "VivoUsbDialog" not in current_focus:
                raise RuntimeError("设备仍处于锁屏状态，请人工解锁后重试")
        emit(log, "device_unlocked")
    except Exception as exc:
        emit(log, "wake_device_error", error=repr(exc))
        raise


def collapse_system_panels(adb_path, serial, log, label="collapse_system_panels"):
    try:
        run_adb(adb_path, serial, ["shell", "cmd", "statusbar", "collapse"], timeout=8)
        emit(log, label)
        time.sleep(0.4)
    except Exception as exc:
        emit(log, f"{label}_error", error=repr(exc))


def reset_launch_surface(adb_path, serial, log):
    # A dismissed keyguard can leave MIUI's USB-choice sheet on top.  Only
    # remove that known system overlay.  The caller cold-starts XHS next, so
    # unconditional Back/Home/collapse cycles here only add latency and can
    # disturb an otherwise clean foreground state.
    current = "\n".join(focus(adb_path, serial))
    if "com.android.settings" in current:
        # MIUI's USB-use picker belongs to Settings and can survive Back/Home.
        # Stopping only Settings dismisses this transient system chooser without
        # touching the user's XHS session or the system UI process.
        run_adb(adb_path, serial, ["shell", "am", "force-stop", "com.android.settings"], timeout=8)
        emit(log, "dismiss_usb_settings_overlay")
        time.sleep(0.3)


def require_default_internet_route(adb_path, serial, log):
    """Fail fast when Android has no usable default route at all.

    The QR scanner otherwise waits for its own network timeout after an image
    is picked, which consumes the whole task budget and mislabels a device
    connectivity outage as a scanner/UI failure.  This deliberately checks
    only routing (not ICMP reachability) so a network that blocks ping is not
    rejected before the app gets a chance to use HTTPS.
    """
    destination = "223.5.5.5"
    try:
        route = run_adb(adb_path, serial, ["shell", "ip", "route", "get", destination], timeout=6)
    except Exception as exc:
        emit(log, "network_route_unavailable", destination=destination, error=repr(exc))
        raise RuntimeError("device_network_unavailable: no default internet route")
    normalized = route.lower()
    if not route or "unreachable" in normalized or "prohibit" in normalized:
        emit(log, "network_route_unavailable", destination=destination, route=route)
        raise RuntimeError("device_network_unavailable: no default internet route")
    dns = run_adb(adb_path, serial, ["shell", "getprop", "net.dns1"], timeout=6)
    emit(log, "network_route_ready", destination=destination, route=route, dns=dns)


def xhs_or_resolver_foreground(adb_path, serial):
    return package_from_focus(focus(adb_path, serial)) in ["com.xingin.xhs", "com.android.intentresolver"]


def grant_xhs_media_access(adb_path, serial, package_name, log):
    # Android 13+ asks for image access only after the QR image is selected.
    # Grant it before navigation so that system permission UI cannot consume the
    # confirmation budget or hide the resulting login-confirmation page.
    granted = []
    for permission in ["android.permission.READ_MEDIA_IMAGES", "android.permission.READ_MEDIA_VISUAL_USER_SELECTED"]:
        try:
            out = run_adb(adb_path, serial, ["shell", "pm", "grant", package_name, permission], timeout=8)
            granted.append({"permission": permission, "out": out.strip()})
        except Exception as exc:
            granted.append({"permission": permission, "error": repr(exc)})
    emit(log, "grant_xhs_media_access", results=granted)


def resolve_activity(adb_path, serial, package_name):
    out = run_adb(adb_path, serial, ["shell", "cmd", "package", "resolve-activity", "--brief", package_name], timeout=8)
    for line in reversed([x.strip() for x in out.splitlines() if x.strip()]):
        if "/" in line and " " not in line:
            return line
    return f"{package_name}/.index.v2.IndexActivityV2"


def click_selector(poco, selector, label, log, timeout=8, post_wait=0.7, interval=0.2):
    deadline = time.time() + timeout
    while time.time() <= deadline:
        try:
            if selector.exists():
                info = {}
                for key in ("name", "text", "type"):
                    try:
                        value = selector.attr(key)
                        if value is not None:
                            info[key] = value
                    except Exception:
                        pass
                emit(log, label, hit=True, info=info)
                tap_node(selector, post_wait=post_wait)
                return True
        except Exception:
            pass
        time.sleep(interval)
    emit(log, label, hit=False)
    return False


def click_selector_once(poco, selector, label, log, post_wait=0.5):
    try:
        if not selector.exists():
            return False
        info = {}
        for key in ("name", "text", "type"):
            try:
                value = selector.attr(key)
                if value is not None:
                    info[key] = value
            except Exception:
                pass
        emit(log, label, hit=True, info=info)
        tap_node(selector, post_wait=post_wait)
        return True
    except Exception:
        return False


def click_labeled_element_in_region(poco, label_text, log, label, y_min=0.0, y_max=1.0, post_wait=0.6):
    """Tap a real accessibility element only when it is in the expected region.

    Text/description values can be reused by XHS elsewhere on the screen.  The
    profile tab is valid only in the bottom navigation bar, so do not accept a
    similarly named element in feed, search, or publishing pages.
    """
    try:
        frozen = poco.freeze()
    except Exception:
        emit(log, label, hit=False)
        return False
    for selector in (frozen(desc=label_text), frozen(text=label_text)):
        try:
            nodes = list(selector)
        except Exception:
            nodes = []
        for node in nodes:
            try:
                x, y = node.get_position()
                if not (y_min <= y <= y_max):
                    continue
                info = {"x": round(x, 3), "y": round(y, 3)}
                for key in ("name", "text", "type"):
                    try:
                        value = node.attr(key)
                        if value is not None:
                            info[key] = value
                    except Exception:
                        pass
                emit(log, label, hit=True, info=info)
                tap_node(node, post_wait=post_wait)
                return True
            except Exception:
                continue
    emit(log, label, hit=False)
    return False


def dismiss_notification_prompt_safely(adb_path, serial, log):
    """Close XHS's notification onboarding without changing permission state."""
    current_focus = "\n".join(focus(adb_path, serial))
    exact_vivo_notification_overlay = (
        "com.vivo.pushservice" in current_focus and "type=2038" in current_focus
    )
    if "NotificationAuthorizationTranslucentActivity" not in current_focus and not exact_vivo_notification_overlay:
        return False
    try:
        # Back dismisses the app-level prompt; do not choose either notification
        # permission branch because notifications are outside this QR task.
        run_adb(adb_path, serial, ["shell", "input", "keyevent", "4"], timeout=5)
        time.sleep(0.6)
        emit(log, "dismiss_notification_prompt_back")
        return True
    except Exception as exc:
        emit(log, "dismiss_notification_prompt_back_error", error=repr(exc))
        return False


def click_top_icon_by_region(poco, log, label, x_min, x_max, y_max, timeout=4, post_wait=1.2):
    deadline = time.time() + timeout
    while time.time() <= deadline:
        candidates = []
        try:
            frozen = poco.freeze()
        except Exception:
            time.sleep(0.35)
            continue
        for node_type in ("android.view.ViewGroup", "android.widget.ImageView"):
            try:
                nodes = list(frozen(type=node_type))
            except Exception:
                nodes = []
            for node in nodes:
                try:
                    if not node.attr("clickable"):
                        continue
                except Exception:
                    pass
                try:
                    x, y = node.get_position()
                    w, h = node.get_size()
                except Exception:
                    continue
                if x_min <= x <= x_max and y <= y_max and 0.03 <= w <= 0.22 and 0.02 <= h <= 0.16:
                    candidates.append((x, y, w, h, node_type, node))
        candidates.sort(key=lambda item: (abs(item[0] - ((x_min + x_max) / 2)), item[1]))
        if candidates:
            x, y, w, h, node_type, node = candidates[0]
            emit(log, label, hit=True, nodeType=node_type, position=[round(x, 3), round(y, 3)], size=[round(w, 3), round(h, 3)])
            tap_node(node, post_wait=post_wait)
            return True
        time.sleep(0.35)
    emit(log, label, hit=False)
    return False


def close_xhs_celebration_popup(poco, log):
    """Close the profile celebration sheet by its own rendered X element.

    This sheet says “恭喜你…赞和收藏” with a “去发布” CTA, but its close
    ImageView has no accessibility text and reports non-clickable.  It is safe
    to use the node's bounds only after those sheet texts were detected.
    """
    candidates = []
    try:
        nodes = list(poco.freeze()(type="android.widget.ImageView"))
    except Exception:
        nodes = []
    for node in nodes:
        try:
            x, y = node.get_position()
            w, h = node.get_size()
        except Exception:
            continue
        if 0.90 <= x <= 0.99 and 0.42 <= y <= 0.60 and 0.04 <= w <= 0.16 and 0.02 <= h <= 0.12:
            candidates.append((abs(x - 0.953) + abs(y - 0.509), x, y, w, h, node))
    if not candidates:
        emit(log, "close_xhs_celebration_popup", hit=False)
        return False
    _, x, y, w, h, node = min(candidates, key=lambda item: item[0])
    emit(log, "close_xhs_celebration_popup", hit=True, position=[round(x, 3), round(y, 3)], size=[round(w, 3), round(h, 3)])
    tap_node(node, post_wait=0.5)
    return True


def close_xhs_celebration_popup_if_present(poco, log):
    """Fast path used only after a required scanner element is absent."""
    try:
        if not poco(text="去发布").exists():
            return False
    except Exception:
        return False
    if not close_xhs_celebration_popup(poco, log):
        return False
    emit(log, "popup_handled", marker="去发布", fastPath=True)
    return True


def dismiss_xhs_draft_restore_popup_if_present(poco, log):
    """Dismiss only the evidenced unfinished-draft prompt with Android Back.

    The sheet offers destructive/continuation actions (``存草稿``/``去编辑``),
    so neither button is suitable for an unattended login flow.  Inspect it
    only after a required navigation element is absent, require the distinctive
    question plus one of its action labels, then use Back to close the sheet.
    """
    try:
        question_present = any(
            poco(text=text).exists()
            for text in ("继续编辑图文笔记吗", "继续编辑图文笔记吗?", "继续编辑图文笔记吗？")
        )
        action_present = poco(text="存草稿").exists() or poco(text="去编辑").exists()
    except Exception:
        return False
    if not question_present or not action_present:
        return False
    if not (CURRENT_ADB_PATH and CURRENT_SERIAL):
        return False
    run_adb(CURRENT_ADB_PATH, CURRENT_SERIAL, ["shell", "input", "keyevent", "4"], timeout=5)
    emit(log, "dismiss_xhs_draft_restore_popup_back", marker="继续编辑图文笔记吗")
    time.sleep(0.5)
    return True


def dismiss_vivo_proximity_overlay_if_present(poco, log):
    """Dismiss vivo's infrared/proximity warning without touching XHS UI.

    Some vivo devices raise this system overlay immediately after the wake
    gesture.  The window belongs to ``com.vivo.daemonService`` and covers the
    entire XHS bottom navigation, so the normal element-only ``我`` lookup
    cannot succeed.  Gate the action on its distinctive warning text before
    tapping the otherwise too-generic close button.
    """
    try:
        if not poco(text="请移除遮挡物").exists():
            return False
    except Exception:
        return False
    for text in ("关闭", "不再提示"):
        if click_selector_once(poco, poco(text=text), f"dismiss_vivo_proximity_{text}", log, post_wait=0.5):
            emit(log, "vivo_proximity_overlay_dismissed", choice=text)
            return True
    emit(log, "vivo_proximity_overlay_dismiss_failed")
    return False


def handle_common_popups(poco, log, allow_back=False):
    handled = False
    started = time.perf_counter()
    popup_markers = [
        "恭喜你", "去发布", "你可能感兴趣的人", "发现新版本", "升级版本", "免流量升级", "新版本",
        "青少年模式", "开启通知", "发送通知", "通讯录好友", "访问照片", "访问相册",
        "照片和视频", "选择照片", "媒体", "权限", "隐私政策",
    ]
    marker_hit = ""
    for marker in popup_markers:
        try:
            if poco(text=marker).exists():
                marker_hit = marker
                break
        except Exception:
            pass
    if not marker_hit:
        texts = list_texts(poco, limit=80)
        for marker in popup_markers:
            if any(marker in text for text in texts):
                marker_hit = marker
                break
    text_snapshot = list_texts(poco, limit=80)
    joined_texts = "\n".join(text_snapshot)
    permission_prompt = any(marker in joined_texts for marker in ["访问照片", "访问相册", "照片和视频", "选择照片", "媒体", "权限"])
    notification_prompt = any(marker in joined_texts for marker in ["开启通知", "发送通知", "通知权限", "互动消息"])
    privacy_prompt = any(marker in joined_texts for marker in ["隐私政策", "用户协议"])
    # Never tap a generic "确认" here: a login confirmation is a business action,
    # not a disposable popup. System media permissions are the only prompts for
    # which accepting is required to continue the QR album flow.
    if permission_prompt:
        choices = ["允许全部", "允许访问所有照片", "允许访问照片和视频", "选择照片和视频", "仅在使用期间允许", "允许"]
    elif notification_prompt:
        choices = ["暂不开启", "以后再说", "下次再说", "暂不", "取消", "关闭"]
    elif privacy_prompt:
        choices = ["同意", "我知道了", "知道了"]
    else:
        choices = ["我知道了", "知道了", "稍后再说", "暂不", "以后再说", "拒绝", "取消", "关闭", "跳过", "暂不开启", "下次再说"]
    for text in choices:
        if click_selector_once(poco, poco(text=text), f"close_popup_text_{text}", log, post_wait=0.4):
            handled = True
            break
    if marker_hit in ["恭喜你", "去发布"] and not handled:
        handled = close_xhs_celebration_popup(poco, log)
    if marker_hit and not handled:
        if click_top_icon_by_region(poco, log, "close_profile_popup", 0.82, 0.99, 0.72, timeout=0.8, post_wait=0.4):
            handled = True
    if marker_hit and not handled and allow_back:
        try:
            run_adb(CURRENT_ADB_PATH, CURRENT_SERIAL, ["shell", "input", "keyevent", "4"], timeout=5)
            emit(log, "close_profile_popup_back", marker=marker_hit)
            time.sleep(0.4)
            handled = True
        except Exception:
            pass
    if handled:
        emit(log, "popup_handled", marker=marker_hit, checkMs=int((time.perf_counter() - started) * 1000))
    else:
        elapsed = int((time.perf_counter() - started) * 1000)
        if elapsed > 500:
            emit(log, "popup_check_slow", checkMs=elapsed)
    return handled


def dismiss_vivo_usb_connected_dialog_if_present(poco, log):
    """Close Vivo's USB-mode notice only when it obscures the clone resolver."""
    try:
        if not poco(text="USB 已连接").exists():
            return False
    except Exception:
        return False
    if click_selector_once(
        poco,
        poco(name="android:id/button2"),
        "dismiss_vivo_usb_connected_dialog",
        log,
        post_wait=0.35,
    ):
        return True
    emit(log, "dismiss_vivo_usb_connected_dialog_failed")
    return False


def dismiss_known_resolver_system_overlay(adb_path, serial, log, lines):
    """Dismiss only a proven system window above the clone-app resolver.

    Vivo/OPPO may leave a USB notice or a system updater window above the clone
    resolver. Poco is attached to the resolver hierarchy, so it cannot inspect
    or click that separate system window. A single Back is safe only after both
    the underlying resolver and an exact overlay window have been observed;
    never send it for an ordinary XHS surface.
    """
    joined = "\n".join(lines)
    if package_from_focus(lines) != "com.android.intentresolver":
        return False
    overlay = ""
    overlay_package = ""
    if "com.bbk.updater" in joined:
        overlay = "vivo_system_update"
        overlay_package = "com.bbk.updater"
    elif "com.oplus.ota" in joined:
        overlay = "oppo_system_update"
        overlay_package = "com.oplus.ota"
    elif "VivoUsbDialog" in joined:
        overlay = "vivo_usb_dialog"
    if not overlay:
        return False
    try:
        method = "back"
        run_adb(adb_path, serial, ["shell", "input", "keyevent", "4"], timeout=5)
        time.sleep(0.6)
        after = focus(adb_path, serial)
        after_text = "\n".join(after)
        overlay_marker = overlay_package or "VivoUsbDialog"
        dismissed = overlay_marker not in after_text
        # Some vendor updater windows consume KEYCODE_BACK without closing.
        # Only after the underlying resolver and the exact updater package have
        # both been proven may we stop that one package on this phone.
        if not dismissed and overlay_package:
            method = "force_stop_exact_package"
            run_adb(adb_path, serial, ["shell", "am", "force-stop", overlay_package], timeout=5)
            time.sleep(0.6)
            after = focus(adb_path, serial)
            after_text = "\n".join(after)
            dismissed = overlay_package not in after_text
        emit(log, "dismiss_resolver_system_overlay", overlay=overlay, method=method, dismissed=dismissed, focus=after)
        return dismissed
    except Exception as exc:
        emit(log, "dismiss_resolver_system_overlay_error", overlay=overlay, error=repr(exc))
        return False


def choose_xhs_slot(poco, adb_path, serial, slot, log):
    started = time.perf_counter()
    labels = ["Ⅱ·小红书", "II·小红书", "II ·小红书", "Ⅱ ·小红书"] if slot == "app2" else ["小红书"]
    emit(log, "choose_slot_begin", slot=slot, labels=labels)
    lines = focus(adb_path, serial)
    resolver_active = package_from_focus(lines) == "com.android.intentresolver"
    emit(log, "choose_slot_focus", resolverActive=resolver_active, focus=lines)
    has_known_overlay = resolver_active and any(
        marker in line for marker in ("com.bbk.updater", "com.oplus.ota", "VivoUsbDialog") for line in lines
    )
    if has_known_overlay:
        if not dismiss_known_resolver_system_overlay(adb_path, serial, log, lines):
            # Do not spend the whole task budget issuing Poco RPCs against a
            # resolver that is still covered by a separate system window.
            emit(log, "choose_slot_system_overlay_still_present")
            return False
        lines = focus(adb_path, serial)
        resolver_active = package_from_focus(lines) == "com.android.intentresolver"
        emit(log, "choose_slot_focus_after_system_overlay", resolverActive=resolver_active, focus=lines)
    # Some Vivo devices show a system USB-mode notice directly above the
    # double-app resolver after reconnect. It has an exact title and a single
    # cancel button; handle only that overlay before querying clone choices.
    if resolver_active and any("VivoUsbDialog" in line for line in lines) and dismiss_vivo_usb_connected_dialog_if_present(poco, log):
        lines = focus(adb_path, serial)
        resolver_active = package_from_focus(lines) == "com.android.intentresolver"
        emit(log, "choose_slot_focus_after_usb_dialog", resolverActive=resolver_active, focus=lines)
    if not resolver_active:
        emit(log, "choose_slot_skip_not_resolver", elapsedMs=int((time.perf_counter() - started) * 1000))
        return True

    # Vivo's DoubleAppResolverActivity is a separate system-UI hierarchy. On
    # affected OriginOS builds a Poco selector call can block far beyond its
    # nominal selector timeout, so a later fallback is never reached. Return
    # promptly and let the caller release Poco before the bounded XML element
    # picker runs. This is still element-based; it is not a coordinate guess.
    vendor_xml_resolvers = (
        "com.android.intentresolver.DoubleAppResolverActivity",
        "com.android.intentresolver/.DoubleAppResolverActivity",
        "com.android.intentresolver.ChooserActivityLauncher",
        "com.android.intentresolver/.ChooserActivityLauncher",
    )
    if any(resolver in line for resolver in vendor_xml_resolvers for line in lines):
        emit(log, "choose_slot_vendor_resolver_defer_to_xml", elapsedMs=int((time.perf_counter() - started) * 1000))
        return False

    # Xiaomi/Redmi renders the two clone choices with identical text
    # ("小红书") under android:id/text1. Select the requested slot by the
    # element index rather than relying on text or coordinates.
    is_xiaomi_resolver = any("android/com.android.internal.app.ResolverActivity" in line for line in lines)
    if is_xiaomi_resolver:
        try:
            candidates = list(poco(name="android:id/text1"))
        except Exception as exc:
            emit(log, "choose_slot_xiaomi_candidates_error", error=repr(exc))
            candidates = []
        emit(log, "choose_slot_xiaomi_candidates", count=len(candidates))
        if candidates:
            index = 1 if slot == "app2" and len(candidates) > 1 else 0
            emit(log, "choose_slot_xiaomi_by_index", index=index, count=len(candidates))
            tap_node(candidates[index], post_wait=0.5)
            return True

    for label in labels:
        probe_started = time.perf_counter()
        emit(log, "choose_slot_text_probe_begin", label=label)
        chosen = click_selector(poco, poco(text=label), f"choose_slot_text_{label}", log, timeout=2, post_wait=0.9)
        emit(log, "choose_slot_text_probe_end", label=label, chosen=chosen, elapsedMs=int((time.perf_counter() - probe_started) * 1000))
        if chosen:
            return True
    try:
        candidates = list(poco(name="com.android.intentresolver:id/text1"))
    except Exception as exc:
        emit(log, "choose_slot_intentresolver_candidates_error", error=repr(exc))
        candidates = []
    emit(log, "choose_slot_intentresolver_candidates", count=len(candidates))
    if candidates:
        index = 1 if slot == "app2" and len(candidates) > 1 else 0
        emit(log, "choose_slot_by_index", index=index, count=len(candidates))
        tap_node(candidates[index], post_wait=0.5)
        return True
    try:
        candidates = list(poco(name="com.android.intentresolver:id/content"))
    except Exception as exc:
        emit(log, "choose_slot_card_candidates_error", error=repr(exc))
        candidates = []
    emit(log, "choose_slot_card_candidates", count=len(candidates))
    if candidates:
        index = 1 if slot == "app2" and len(candidates) > 1 else 0
        emit(log, "choose_slot_card_by_index", index=index, count=len(candidates))
        tap_node(candidates[index], post_wait=0.5)
        return True
    emit(log, "choose_slot_not_found", elapsedMs=int((time.perf_counter() - started) * 1000))
    return False


def click_scan_entry(poco, log):
    # The normal profile page exposes this element immediately. Keep each
    # missing-selector probe short so an overlay can be handled promptly.
    if click_selector(poco, poco(desc="扫一扫"), "click_scan_by_desc", log, timeout=1.4):
        return True
    if click_selector(poco, poco(text="扫一扫"), "click_scan_by_text", log, timeout=0.6):
        return True
    # Do not guess from an icon's screen region.  The UI can be a feed, search,
    # or publishing page after an interrupted run; in those states the same
    # region performs unrelated, potentially destructive actions.
    emit(log, "click_scan_by_element", hit=False)
    return False


def dismiss_profile_search_overlay_if_present(poco, log):
    """Close XHS's profile-search surface only after the scan target is absent."""
    markers = ["搜索我的笔记/收藏/赞过", "搜索我的笔记、收藏或赞过"]
    marker_hit = ""
    for marker in markers:
        try:
            if poco(text=marker).exists():
                marker_hit = marker
                break
        except Exception:
            pass
    if not marker_hit:
        return False
    if click_selector_once(poco, poco(text="取消"), "dismiss_profile_search_cancel", log, post_wait=0.6):
        emit(log, "profile_search_overlay_dismissed", marker=marker_hit)
        return True
    emit(log, "profile_search_overlay_dismiss_failed", marker=marker_hit)
    return False


def ensure_xhs_session_available(poco, log):
    # The task contract assumes XHS is already logged in.  Do not scan for
    # logout UI on the normal path: that adds a full UI RPC before the first
    # target element and can stall vivo immediately after its clone picker.
    return None


def clear_popups_rounds(poco, log, rounds=1, allow_back=False):
    handled_any = False
    for index in range(rounds):
        handled = handle_common_popups(poco, log, allow_back=allow_back)
        handled_any = handled_any or handled
        if not handled:
            break
        time.sleep(0.4)
    return handled_any


def wait_until(label, log, timeout, action, interval=0.6, popup_poco=None, popup_every=2):
    deadline = time.time() + timeout
    if CURRENT_RUN_DEADLINE_AT is not None:
        deadline = min(deadline, CURRENT_RUN_DEADLINE_AT)
    attempts = 0
    last_popup_at = 0.0
    while time.time() <= deadline:
        attempts += 1
        try:
            if action():
                emit(log, f"{label}_ready", attempts=attempts)
                return True
        except Exception as exc:
            emit(log, f"{label}_attempt_error", attempts=attempts, error=repr(exc))
        now = time.time()
        if popup_poco is not None and (attempts == 1 or now - last_popup_at >= popup_every):
            clear_popups_rounds(popup_poco, log, rounds=2)
            last_popup_at = now
        time.sleep(interval)
    if CURRENT_RUN_DEADLINE_AT is not None and time.time() >= CURRENT_RUN_DEADLINE_AT:
        emit(log, "run_deadline_reached", label=label, attempts=attempts)
        raise RuntimeError("扫码任务手机执行超过60秒预算")
    emit(log, f"{label}_timeout", timeout=timeout, attempts=attempts)
    return False


def click_me_entry(poco, log, timeout=12):
    def attempt():
        # The profile tab must be resolved as a bottom-navigation element; raw
        # coordinates can hit feed/search/publish controls on a restored page.
        # Query the required target first. A repeated ``dumpsys window`` before
        # this lookup consumed most of the 60-second target on slower devices.
        if click_labeled_element_in_region(
            poco, "我", log, "click_me_bottom_navigation_element", y_min=0.84, post_wait=0.7
        ):
            return True
        if CURRENT_ADB_PATH and CURRENT_SERIAL:
            # On Vivo, a window-focus query can take several seconds while the
            # notification translucent activity is present. Check it first so
            # we do not query focus twice before pressing Back.
            if dismiss_notification_prompt_safely(CURRENT_ADB_PATH, CURRENT_SERIAL, log):
                return False
            try:
                # A cold launch may restore XHS to the previously opened note
                # detail page. That page has no bottom tab bar, so tapping the
                # profile-tab coordinate silently hits note-detail controls.
                # Return once to the main surface before using the fast tap.
                current_focus = "\n".join(focus(CURRENT_ADB_PATH, CURRENT_SERIAL))
                if "DeviceOfflineRemindActivity" in current_focus:
                    raise RuntimeError("手机小红书账号已下线，不在任务自动恢复范围内")
                if "NoteDetailActivity" in current_focus:
                    run_adb(CURRENT_ADB_PATH, CURRENT_SERIAL, ["shell", "input", "keyevent", "4"], timeout=5)
                    time.sleep(0.5)
                    emit(log, "back_from_note_detail_before_me")
                elif "GlobalSearchActivity" in current_focus:
                    run_adb(CURRENT_ADB_PATH, CURRENT_SERIAL, ["shell", "input", "keyevent", "4"], timeout=5)
                    time.sleep(0.5)
                    emit(log, "back_from_search_before_me")
                elif "XhsAlbumActivity" in current_focus:
                    run_adb(CURRENT_ADB_PATH, CURRENT_SERIAL, ["shell", "input", "keyevent", "4"], timeout=5)
                    time.sleep(0.5)
                    emit(log, "back_from_stale_album_before_me")
            except Exception as exc:
                emit(log, "prepare_me_element_error", error=repr(exc))
        # Some XHS versions show a second, in-app notification sheet after
        # the translucent prompt closes. Handle only these exact dismissals
        # before attempting the profile navigation.
        for text in ("以后再说", "暂不开启", "下次再说"):
            if click_selector_once(poco, poco(text=text), f"dismiss_xhs_notification_{text}", log, post_wait=0.5):
                return False
        if dismiss_xhs_draft_restore_popup_if_present(poco, log):
            return False
        # Keep the normal path to a single target lookup.  Only inspect the
        # vivo system dialog after that lookup actually missed.
        dismiss_vivo_proximity_overlay_if_present(poco, log)
        return False
    # Do not run the generic full-hierarchy popup sweep at this step. On some
    # Vivo phones it blocks Poco for 10+ seconds and blows the 60s budget.
    return wait_until("wait_me_entry", log, timeout, attempt, interval=0.4)


def click_scan_entry_wait(poco, log, timeout=15):
    def attempt():
        return click_scan_entry(poco, log)
    # Happy path: query only the target element.  A hierarchy-wide popup sweep
    # is expensive on busy phones, so perform it once only after the scanner
    # entry is actually missing.
    direct_timeout = min(4, timeout)
    if wait_until("wait_scan_entry", log, direct_timeout, attempt, interval=0.5):
        return True
    emit(log, "scan_entry_missing_recover_popups")
    if dismiss_profile_search_overlay_if_present(poco, log):
        return wait_until(
            "wait_scan_entry_after_profile_search",
            log,
            max(1, timeout - direct_timeout),
            attempt,
            interval=0.5,
        )
    if close_xhs_celebration_popup_if_present(poco, log):
        return wait_until("wait_scan_entry_after_popup_recovery", log, max(1, timeout - direct_timeout), attempt, interval=0.5)
    # The unfinished-draft sheet may be restored only after XHS opens the
    # profile surface.  It is therefore not sufficient to handle it solely
    # while looking for the bottom "我" tab.  Keep the recovery gated behind a
    # missing scanner target and close the evidenced sheet with Android Back;
    # never choose either business action ("存草稿" / "去编辑").
    if dismiss_xhs_draft_restore_popup_if_present(poco, log):
        return wait_until(
            "wait_scan_entry_after_draft_restore",
            log,
            max(1, timeout - direct_timeout),
            attempt,
            interval=0.5,
        )
    popup_closed = clear_popups_rounds(poco, log, rounds=1)
    # An upgrade/notification dialog can restore the previous XHS surface
    # instead of the profile page. Re-open the profile immediately after a
    # confirmed dismissal; otherwise the old path waits up to 11 seconds for
    # a scan affordance that cannot exist on that surface.
    if popup_closed:
        emit(log, "scan_entry_popup_reenter_profile")
        if click_me_entry(poco, log, timeout=3):
            return wait_until(
                "wait_scan_entry_after_popup_reenter_profile",
                log,
                max(1, timeout - direct_timeout),
                attempt,
                interval=0.5,
            )
    return wait_until("wait_scan_entry_after_popup_recovery", log, max(1, timeout - direct_timeout), attempt, interval=0.5)


def click_album_entry(poco, log, timeout=12):
    def attempt():
        if click_selector(poco, poco(text="相册"), "click_album_by_text", log, timeout=1.2, post_wait=0.9):
            return True
        if click_selector(poco, poco(desc="相册"), "click_album_by_desc", log, timeout=1.2, post_wait=0.9):
            return True

        # Some XHS builds expose the scanner's two lower actions as unlabeled
        # ImageView nodes, so a text/description selector cannot see "相册".
        # Keep this element based: only use the right-hand scanner action node
        # after confirming the scanner activity, rather than issuing a raw tap.
        if not (CURRENT_ADB_PATH and CURRENT_SERIAL):
            return False
        current_focus = "\n".join(focus(CURRENT_ADB_PATH, CURRENT_SERIAL))
        if "QrCodeScannerActivity" not in current_focus:
            return False
        candidates = []
        try:
            # All XHS album thumbnails share this node name on the Vivo fleet.
            # Querying it directly avoids a full ImageView hierarchy traversal,
            # which was taking 10–15 seconds on busy devices.
            nodes = list(poco(name="com.xingin.xhs:id/0_resource_name_obfuscated"))
        except Exception:
            nodes = []
        for node in nodes:
            try:
                name = node.attr("name") or ""
                x, y = node.get_position()
                w, h = node.get_size()
                if name == "android.widget.ImageView" and 0.62 <= x <= 0.92 and 0.80 <= y <= 0.93 and 0.06 <= w <= 0.28 and 0.04 <= h <= 0.16:
                    candidates.append((abs(x - 0.778) + abs(y - 0.845), x, y, w, h, node))
            except Exception:
                continue
        if not candidates:
            emit(log, "click_album_by_scanner_image_element", hit=False)
            return False
        _, x, y, w, h, node = min(candidates, key=lambda item: item[0])
        emit(log, "click_album_by_scanner_image_element", hit=True, info={
            "name": "android.widget.ImageView", "x": round(x, 3), "y": round(y, 3),
            "w": round(w, 3), "h": round(h, 3),
        })
        tap_node(node, post_wait=0.9)
        return True
    # As with the scanner entry, keep popup traversal off the normal path.
    direct_timeout = min(4, timeout)
    if wait_until("wait_album_entry", log, direct_timeout, attempt, interval=0.5):
        return True
    emit(log, "album_entry_missing_recover_popups")
    # A restored draft sheet can also race with the transition into the
    # scanner.  Apply the same exact-text, Back-only policy here before the
    # generic popup sweep so its action buttons can never be selected.
    if dismiss_xhs_draft_restore_popup_if_present(poco, log):
        return wait_until(
            "wait_album_entry_after_draft_restore",
            log,
            max(1, timeout - direct_timeout),
            attempt,
            interval=0.5,
        )
    clear_popups_rounds(poco, log, rounds=1)
    return wait_until("wait_album_entry_after_popup_recovery", log, max(1, timeout - direct_timeout), attempt, interval=0.5)


def list_texts(poco, keywords=None, limit=80):
    values = []
    try:
        nodes = poco.freeze()(type="android.widget.TextView")
    except Exception:
        return values
    try:
        iterable = list(nodes)
    except Exception:
        return values
    for node in iterable[:300]:
        try:
            text = node.attr("text") or ""
        except Exception:
            text = ""
        if not text:
            continue
        if keywords and not any(k in text for k in keywords):
            continue
        values.append(text)
        if len(values) >= limit:
            break
    return values


def poco_ui_snapshot(poco, limit=180):
    lines = []
    node_types = [
        "android.widget.TextView",
        "android.widget.Button",
        "android.widget.ImageView",
        "android.view.View",
        "android.view.ViewGroup",
    ]
    seen = set()
    try:
        frozen = poco.freeze()
    except Exception as exc:
        return f"poco_snapshot_error={repr(exc)}"
    for node_type in node_types:
        try:
            nodes = list(frozen(type=node_type))
        except Exception:
            nodes = []
        for node in nodes[:260]:
            try:
                text = node.attr("text") or ""
            except Exception:
                text = ""
            try:
                name = node.attr("name") or ""
            except Exception:
                name = ""
            try:
                clickable = bool(node.attr("clickable"))
            except Exception:
                clickable = False
            if not text and not name and not clickable:
                continue
            try:
                x, y = node.get_position()
                w, h = node.get_size()
                bounds = f"{x:.3f},{y:.3f},{w:.3f},{h:.3f}"
            except Exception:
                bounds = ""
            key = (node_type, text, name, bounds)
            if key in seen:
                continue
            seen.add(key)
            lines.append(json.dumps({
                "type": node_type,
                "text": text,
                "name": name,
                "clickable": clickable,
                "bounds": bounds,
            }, ensure_ascii=False))
            if len(lines) >= limit:
                return "\n".join(lines)
    return "\n".join(lines)


def normalize_text_list(value, fallback):
    merged = []
    if isinstance(value, list):
        merged.extend(str(item).strip() for item in value if str(item).strip())
    merged.extend(str(item).strip() for item in fallback if str(item).strip())
    result = []
    for item in merged:
        if item not in result:
            result.append(item)
    return result


def click_first_album_image(poco, log, timeout=5):
    """Choose the imported QR through a real gallery thumbnail node only."""
    # Prefer a real gallery thumbnail over any generic coordinate fallback.
    deadline = time.time() + timeout
    while time.time() <= deadline:
        # Vivo can leave the notification shade visually over the XHS album
        # while the foreground activity remains XhsAlbumActivity. Dismiss it
        # before reading/tapping a thumbnail so the touch reaches the node.
        if CURRENT_ADB_PATH and CURRENT_SERIAL:
            collapse_system_panels(CURRENT_ADB_PATH, CURRENT_SERIAL, log, "collapse_before_album_thumbnail")
        candidates = []
        try:
            # One bounded hierarchy dump, then all candidate geometry and
            # attributes are evaluated locally.  Querying each thumbnail over
            # HRPC multiplied one transient timeout by every ImageView.
            nodes = list(poco.freeze()(type="android.widget.ImageView"))
        except Exception as exc:
            emit(log, "album_candidates_failed", error=repr(exc))
            nodes = []
        for node in nodes:
            try:
                name = node.attr("name") or ""
                x, y = node.get_position()
                w, h = node.get_size()
                # The scanner's own ImageViews cover most of the screen. A
                # gallery thumbnail is a bounded grid item, not a scanner or
                # system icon, and is selected by node rather than by pixels.
                if (
                    "redscanner" not in name
                    and "systemui" not in name
                    and 0.05 < x < 0.95
                    and 0.08 < y < 0.78
                    and 0.08 <= w <= 0.5
                    and 0.08 <= h <= 0.5
                ):
                    candidates.append((y, x, w, h, name, node))
            except Exception:
                continue
        candidates.sort(key=lambda item: (item[0], item[1]))
        if candidates:
            y, x, w, h, name, node = candidates[0]
            emit(log, "click_album_first_thumbnail_element", info={
                "name": name, "x": round(x, 3), "y": round(y, 3),
                "w": round(w, 3), "h": round(h, 3),
                "candidateCount": len(candidates),
            })
            tap_node(node, post_wait=0.8)
            if CURRENT_ADB_PATH and CURRENT_SERIAL:
                collapse_system_panels(CURRENT_ADB_PATH, CURRENT_SERIAL, log, "collapse_after_album_thumbnail")
            return True
        time.sleep(0.35)
    emit(log, "album_thumbnail_element_not_found")
    return False


def accept_xhs_photo_permission(poco, log):
    # Android may keep a previous "selected photos only" choice even after a
    # shell grant.  Handle the post-selection permission sheet explicitly.
    for label in ["允许访问全部", "允许", "Allow all"]:
        # Permissions are proactively granted before launch. These are only a
        # fast fallback for ROMs that still surface a post-selection sheet.
        if click_selector(poco, poco(text=label), "allow_xhs_photo_access", log, timeout=0.25, post_wait=0.8):
            return True
    return False


def start_xhs_activity(adb_path, serial, activity, package_name, log):
    try:
        # Force-stop alone does not guarantee a clean entry on XHS: Android can
        # restore its last note/search activity from the saved task state.  A
        # fresh task with the old task cleared is required before navigating to
        # the profile and scanner.
        out = run_adb(
            adb_path,
            serial,
            [
                "shell", "am", "start", "-W",
                # Some vendor Android builds reject am's long activity flags.
                # FLAG_ACTIVITY_NEW_TASK | FLAG_ACTIVITY_CLEAR_TASK is
                # universally accepted through the numeric intent flag.
                "-f", "0x10008000",
                "-n", activity,
            ],
            timeout=20,
        )
        emit(log, "start_xhs", activity=activity, out=out)
        return out
    except subprocess.TimeoutExpired as exc:
        # On slower phones `am start -W` can outlive the activity transition.
        # Treat this as a soft timeout when XHS (or the clone picker) is already
        # foregrounded, rather than aborting before the popup handler can run.
        current_focus = focus(adb_path, serial)
        package = package_from_focus(current_focus)
        emit(log, "start_xhs_wait_timeout", activity=activity, focus=current_focus)
        if package in ["com.xingin.xhs", "com.android.intentresolver"]:
            return "am_start_wait_timeout_but_foreground_ready"
        try:
            out = run_adb(adb_path, serial, ["shell", "am", "start", "-n", activity], timeout=10)
            emit(log, "start_xhs_without_wait", activity=activity, out=out)
            time.sleep(1.0)
            return out
        except Exception:
            raise exc


def classify_confirm_texts(texts):
    joined = "\n".join(texts)
    strong_platform_markers = ["请确认是你本人操作", "登录平台", "千帆", "专业号", "商家", "已阅读并同意"]
    weak_platform_markers = ["登录设备", "登录地点"]
    ordinary_markers = ["登录确认", "即将登录小红书电脑端"]
    ordinary_button_markers = ["确认登录", "确定登录"]
    if any(marker in joined for marker in ordinary_markers) or any(marker in joined for marker in ordinary_button_markers):
        if not any(marker in joined for marker in strong_platform_markers):
            return "ordinary"
    if any(marker in joined for marker in strong_platform_markers):
        return "platform"
    if any(marker in joined for marker in weak_platform_markers):
        return "platform"
    return ""


def xml_bounds_center(bounds):
    values = bounds.replace("[", "").replace("]", ",").split(",")
    x1, y1, x2, y2 = [int(value) for value in values[:4]]
    return (x1 + x2) // 2, (y1 + y2) // 2


def xml_bounds_values(bounds):
    values = bounds.replace("[", "").replace("]", ",").split(",")
    return tuple(int(value) for value in values[:4])


def dump_confirm_xml(adb_path, serial, token):
    """Read one bounded UIAutomator hierarchy after QR image selection.

    Poco's hierarchy freeze can remain blocked after XHS switches from the
    album Activity to its login-confirmation surface.  Subprocess timeouts are
    enforceable, so this post-selection reader cannot hold the resident worker
    beyond the task budget.
    """
    # ``dump <sdcard-file>`` is not portable across the Android builds in the
    # fleet: some devices print success but never create the requested file.
    # ``/dev/tty`` did return the hierarchy on those same devices.  Its stdout
    # also contains a trailing "UI hierarchy dumped to" status line, so parse
    # only the hierarchy element instead of feeding all stdout to ElementTree.
    completed = subprocess.run(
        [adb_path, "-s", serial, "exec-out", "uiautomator", "dump", "/dev/tty"],
        capture_output=True,
        timeout=8,
        check=False,
    )
    raw = completed.stdout
    if not raw.strip():
        detail = completed.stderr.decode("utf-8", errors="replace").replace("\r", " ").replace("\n", " ")[:160]
        raise RuntimeError(f"post_selection_uiautomator_xml_empty:rc={completed.returncode}:{detail}")
    decoded = raw.decode("utf-8", errors="replace").replace("\r", "").strip()
    xml_start = decoded.find("<hierarchy")
    xml_end = decoded.rfind("</hierarchy>")
    if xml_start < 0 or xml_end < xml_start:
        detail = decoded.replace("\n", " ")[:160]
        raise RuntimeError(f"post_selection_uiautomator_xml_missing_hierarchy:{detail}")
    root = ET.fromstring(decoded[xml_start:xml_end + len("</hierarchy>")])
    parent = {child: node for node in root.iter() for child in node}
    values = []
    for node in root.iter("node"):
        for key in ("text", "content-desc"):
            value = (node.get(key) or "").strip()
            if value and value not in values:
                values.append(value)
    return root, parent, values, "/dev/tty"


def release_poco_for_confirm_xml(adb_path, serial, log):
    """End Poco's UiAutomation instrumentation before XML confirmation.

    Android permits only one active UiAutomation owner on affected fleet
    builds.  Starting the command-line ``uiautomator dump`` while PocoService
    still owns that channel produces only ``Killed``.  Poco is no longer
    needed after the QR thumbnail has been selected; every remaining read and
    tap is XML/ADB based, so explicitly hand the channel over here.
    """
    for package_name in ("com.netease.open.pocoservice", "com.netease.open.pocoservice.test"):
        try:
            run_adb(adb_path, serial, ["shell", "am", "force-stop", package_name], timeout=5)
        except Exception as exc:
            emit(log, "release_poco_package_error", packageName=package_name, error=repr(exc))
    time.sleep(0.4)
    emit(log, "poco_released_for_confirm_xml")


def click_first_album_image_xml(adb_path, serial, log, token, timeout=8):
    """Select the first real gallery thumbnail from a bounded XML snapshot."""
    deadline = time.time() + timeout
    attempts = 0
    while time.time() <= deadline:
        attempts += 1
        collapse_system_panels(adb_path, serial, log, "collapse_before_album_thumbnail_xml")
        try:
            root, _, _, _ = dump_confirm_xml(adb_path, serial, token)
        except Exception as exc:
            emit(log, "album_thumbnail_xml_error", attempts=attempts, error=repr(exc))
            time.sleep(0.35)
            continue

        bounded = []
        max_x = 0
        max_y = 0
        for node in root.iter("node"):
            bounds = node.get("bounds") or ""
            if not bounds:
                continue
            try:
                x1, y1, x2, y2 = xml_bounds_values(bounds)
            except Exception:
                continue
            max_x = max(max_x, x2)
            max_y = max(max_y, y2)
            bounded.append((node, x1, y1, x2, y2))
        if max_x <= 0 or max_y <= 0:
            time.sleep(0.35)
            continue

        candidates = []
        for node, x1, y1, x2, y2 in bounded:
            node_class = node.get("class") or ""
            resource_id = node.get("resource-id") or ""
            if node_class != "android.widget.ImageView":
                continue
            center_x = ((x1 + x2) / 2) / max_x
            center_y = ((y1 + y2) / 2) / max_y
            width = (x2 - x1) / max_x
            height = (y2 - y1) / max_y
            if (
                "redscanner" not in resource_id
                and "systemui" not in resource_id
                and 0.05 < center_x < 0.95
                and 0.08 < center_y < 0.78
                and 0.08 <= width <= 0.5
                and 0.08 <= height <= 0.5
            ):
                candidates.append((center_y, center_x, width, height, resource_id, node))
        candidates.sort(key=lambda item: (item[0], item[1]))
        if candidates:
            center_y, center_x, width, height, resource_id, node = candidates[0]
            x, y = xml_bounds_center(node.get("bounds"))
            run_adb(adb_path, serial, ["shell", "input", "tap", str(x), str(y)], timeout=5)
            emit(log, "click_album_first_thumbnail_xml", attempts=attempts, info={
                "resourceId": resource_id,
                "x": round(center_x, 3), "y": round(center_y, 3),
                "w": round(width, 3), "h": round(height, 3),
                "candidateCount": len(candidates),
            })
            time.sleep(0.8)
            collapse_system_panels(adb_path, serial, log, "collapse_after_album_thumbnail_xml")
            return True
        time.sleep(0.35)
    emit(log, "album_thumbnail_xml_not_found", attempts=attempts)
    return False


def accept_xhs_photo_permission_xml(adb_path, serial, log, token):
    try:
        root, parent, _, _ = dump_confirm_xml(adb_path, serial, token)
    except Exception as exc:
        emit(log, "allow_xhs_photo_access_xml_error", error=repr(exc))
        return False
    # Vivo/OriginOS uses the Android 12 foreground-only camera button while
    # opening XHS Scanner. Prefer the stable permission-controller resource
    # ids; the localized text remains a fallback for other Android variants.
    preferred_ids = (
        # Android 14 / OriginOS photo picker. This is distinct from the
        # generic permission_allow_button and is the full-library choice; the
        # sibling permission_allow_selected_button would expose only a user
        # selected subset and can hide the QR that was just pushed by ADB.
        "permission_allow_all_button",
        "permission_allow_foreground_only_button",
        "permission_allow_button",
        "permission_allow_one_time_button",
    )
    for suffix in preferred_ids:
        for node in root.iter("node"):
            resource_id = (node.get("resource-id") or "").strip()
            if not resource_id.endswith(suffix):
                continue
            candidate = nearest_xml_tappable(node, parent)
            if candidate is None or not candidate.get("bounds"):
                continue
            x, y = xml_bounds_center(candidate.get("bounds"))
            run_adb(adb_path, serial, ["shell", "input", "tap", str(x), str(y)], timeout=5)
            emit(log, "allow_xhs_photo_access_xml", hit=True, method="resource_id", resourceId=resource_id)
            time.sleep(0.8)
            return True
    return tap_xml_label(
        adb_path, serial, root, parent,
        [
            "使用应用时允许", "仅在使用中允许", "本次使用时允许",
            "允许访问全部", "允许全部", "允许访问所有照片", "允许",
            "While using the app", "Only this time", "Allow all",
        ],
        log, "allow_xhs_photo_access_xml",
    )


def system_media_permission_prompt_present(adb_path, serial):
    current_focus = focus(adb_path, serial)
    joined = "\n".join(current_focus)
    return (
        "GrantPermissionsActivity" in joined
        or "permissioncontroller" in joined.lower()
    )


def click_album_entry_xml(adb_path, serial, log, token, timeout=8):
    """Click the scanner album element after a system permission transition.

    Poco cannot inspect Android's permission-controller hierarchy. Once that
    exact foreground activity is observed we hand UiAutomation to the bounded
    XML reader and keep the rest of the transition element based.
    """
    deadline = time.time() + timeout
    attempts = 0
    while time.time() <= deadline:
        attempts += 1
        try:
            root, parent, _, _ = dump_confirm_xml(adb_path, serial, token)
        except Exception as exc:
            emit(log, "album_entry_xml_error", attempts=attempts, error=repr(exc))
            time.sleep(0.35)
            continue
        for node in root.iter("node"):
            text = (node.get("text") or "").strip()
            desc = (node.get("content-desc") or "").strip()
            resource_id = (node.get("resource-id") or "").strip()
            if text != "相册" and desc != "相册" and not resource_id.endswith(":id/llMyPhoto"):
                continue
            candidate = nearest_xml_tappable(node, parent)
            if candidate is None or not candidate.get("bounds"):
                continue
            x, y = xml_bounds_center(candidate.get("bounds"))
            run_adb(adb_path, serial, ["shell", "input", "tap", str(x), str(y)], timeout=5)
            emit(log, "click_album_entry_xml", hit=True, attempts=attempts, element={
                "text": text,
                "desc": desc,
                "resourceId": resource_id,
                "bounds": candidate.get("bounds"),
            })
            time.sleep(0.8)
            return True
        time.sleep(0.35)
    emit(log, "click_album_entry_xml", hit=False, attempts=attempts, focus=focus(adb_path, serial))
    return False


def nearest_xml_tappable(node, parent):
    current = node
    while current is not None:
        if current.get("bounds") and current.get("enabled", "true") != "false":
            if current.get("clickable") == "true" or current.get("checkable") == "true":
                return current
        current = parent.get(current)
    return node if node.get("bounds") else None


def tap_xml_label(adb_path, serial, root, parent, labels, log, step):
    wanted = set(labels)
    for node in root.iter("node"):
        text = (node.get("text") or "").strip()
        desc = (node.get("content-desc") or "").strip()
        if text not in wanted and desc not in wanted:
            continue
        candidate = nearest_xml_tappable(node, parent)
        if candidate is None or not candidate.get("bounds"):
            continue
        x, y = xml_bounds_center(candidate.get("bounds"))
        run_adb(adb_path, serial, ["shell", "input", "tap", str(x), str(y)], timeout=5)
        emit(log, step, hit=True, element={"text": text, "desc": desc, "bounds": candidate.get("bounds")})
        time.sleep(0.8)
        return True
    emit(log, step, hit=False, labels=list(labels))
    return False


def click_scan_entry_xml(adb_path, serial, log, token, timeout=8):
    """Open XHS scanner through a bounded XML element lookup.

    OPPO's clone resolver can leave PocoService responsive for the first few
    selectors and then wedge on a later missing selector.  Once that exact
    resolver transition has already required XML, keep the profile-to-scanner
    transition on the same bounded UiAutomation reader instead of spending the
    whole task watchdog on another Poco RPC.  The tap still requires the exact
    ``扫一扫`` element; no screen coordinate is guessed.
    """
    deadline = time.time() + timeout
    attempts = 0
    search_markers = {"搜索我的笔记/收藏/赞过", "搜索我的笔记、收藏或赞过"}
    while time.time() <= deadline:
        attempts += 1
        try:
            root, parent, texts, _ = dump_confirm_xml(adb_path, serial, token)
        except Exception as exc:
            emit(log, "scan_entry_xml_error", attempts=attempts, error=repr(exc))
            time.sleep(0.35)
            continue

        for node in root.iter("node"):
            text = (node.get("text") or "").strip()
            desc = (node.get("content-desc") or "").strip()
            if text != "扫一扫" and desc != "扫一扫":
                continue
            candidate = nearest_xml_tappable(node, parent)
            if candidate is None or not candidate.get("bounds"):
                continue
            x, y = xml_bounds_center(candidate.get("bounds"))
            run_adb(adb_path, serial, ["shell", "input", "tap", str(x), str(y)], timeout=5)
            emit(log, "click_scan_entry_xml", hit=True, attempts=attempts, element={
                "text": text,
                "desc": desc,
                "resourceId": (node.get("resource-id") or "").strip(),
                "bounds": candidate.get("bounds"),
            })
            time.sleep(0.8)
            return True

        # Preserve the evidenced profile-search recovery without issuing
        # another Poco query: close only the exact search overlay by its
        # localized Cancel element, then inspect the profile again.
        if any(marker in texts for marker in search_markers):
            if tap_xml_label(adb_path, serial, root, parent, ["取消"], log, "dismiss_profile_search_cancel_xml"):
                emit(log, "profile_search_overlay_dismissed_xml")
                continue
        joined = "\n".join(texts)
        celebration = "去发布" in joined and ("恭喜你" in joined or "赞和收藏" in joined)
        draft_restore = "继续编辑图文笔记吗" in joined and any(label in joined for label in ("存草稿", "去编辑"))
        if celebration or draft_restore:
            marker = "去发布" if celebration else "继续编辑图文笔记吗"
            run_adb(adb_path, serial, ["shell", "input", "keyevent", "4"], timeout=5)
            emit(log, "dismiss_xhs_business_popup_back_xml", marker=marker, attempts=attempts)
            time.sleep(0.5)
            continue
        time.sleep(0.35)
    emit(log, "click_scan_entry_xml", hit=False, attempts=attempts, focus=focus(adb_path, serial))
    return False


def click_xhs_slot_xml(adb_path, serial, slot, log, token, timeout=8):
    """Select one clone-app card from the system resolver by XML element.

    This path is used only after the normal Poco resolver lookup has failed.
    Poco owns a different UiAutomation hierarchy on affected vendor builds, so
    the caller releases it before invoking this bounded system-UI fallback.
    """
    initial_focus = focus(adb_path, serial)
    if package_from_focus(initial_focus) == "com.android.intentresolver" and any(
        marker in line for marker in ("com.bbk.updater", "com.oplus.ota", "VivoUsbDialog") for line in initial_focus
    ):
        if not dismiss_known_resolver_system_overlay(adb_path, serial, log, initial_focus):
            emit(log, "choose_slot_xml_system_overlay_still_present")
            return False
    labels = ["Ⅱ·小红书", "II·小红书", "II ·小红书", "Ⅱ ·小红书"] if slot == "app2" else ["小红书"]
    deadline = time.time() + timeout
    attempts = 0
    while time.time() <= deadline:
        attempts += 1
        try:
            root, parent, _, _ = dump_confirm_xml(adb_path, serial, token)
        except Exception as exc:
            emit(log, "choose_slot_xml_error", attempts=attempts, error=repr(exc))
            time.sleep(0.35)
            continue
        exact = []
        text1 = []
        content = []
        seen = set()
        for node in root.iter("node"):
            text = (node.get("text") or "").strip()
            desc = (node.get("content-desc") or "").strip()
            resource_id = (node.get("resource-id") or "").strip()
            target = nearest_xml_tappable(node, parent)
            bounds = target.get("bounds") if target is not None else ""
            if not bounds:
                continue
            key = (bounds, text, desc, resource_id)
            if key in seen:
                continue
            seen.add(key)
            item = (xml_bounds_center(bounds), target, text, desc, resource_id)
            if text in labels or desc in labels:
                exact.append(item)
            if resource_id.endswith(":id/text1") or resource_id == "android:id/text1":
                text1.append(item)
            elif resource_id.endswith(":id/content"):
                content.append(item)
        candidates = exact or text1 or content
        candidates.sort(key=lambda item: (item[0][1], item[0][0]))
        if candidates:
            index = 1 if slot == "app2" and len(candidates) > 1 and not exact else 0
            (x, y), _, text, desc, resource_id = candidates[min(index, len(candidates) - 1)]
            run_adb(adb_path, serial, ["shell", "input", "tap", str(x), str(y)], timeout=5)
            emit(log, "choose_slot_xml", hit=True, slot=slot, attempts=attempts, index=index, count=len(candidates), element={
                "text": text, "desc": desc, "resourceId": resource_id, "x": x, "y": y,
            })
            time.sleep(0.9)
            return True
        time.sleep(0.35)
    emit(log, "choose_slot_xml", hit=False, slot=slot, attempts=attempts, focus=focus(adb_path, serial))
    return False


def wait_confirm(poco, adb_path, serial, log, keywords, timeout=15, token="confirm"):
    deadline = time.time() + timeout
    if CURRENT_RUN_DEADLINE_AT is not None:
        deadline = min(deadline, CURRENT_RUN_DEADLINE_AT)
    last_texts = []
    last_error = ""
    attempts = 0
    while time.time() <= deadline:
        attempts += 1
        try:
            _, _, texts, _ = dump_confirm_xml(adb_path, serial, token)
        except Exception as exc:
            last_error = repr(exc)
            if attempts == 1:
                emit(log, "confirm_xml_attempt_error", error=last_error, attempts=attempts)
            time.sleep(0.35)
            continue
        last_texts = texts
        found = [text for text in texts if any(keyword in text for keyword in keywords)][:20]
        confirm_type = classify_confirm_texts(texts)
        if confirm_type:
            emit(log, "confirm_visible", found=found, confirmType=confirm_type, reader="uiautomator_xml")
            return confirm_type
        time.sleep(0.5)
    if CURRENT_RUN_DEADLINE_AT is not None and time.time() >= CURRENT_RUN_DEADLINE_AT:
        emit(log, "run_deadline_reached", label="wait_confirm")
        return ""
    emit(
        log, "confirm_not_found", texts=last_texts[:30], focus=focus(adb_path, serial),
        reader="uiautomator_xml", attempts=attempts, lastError=last_error,
    )
    return ""


def click_confirm_button(poco, log, confirm_type, buttons):
    for text in buttons:
        if click_selector(poco, poco(desc=text), f"click_confirm_desc_{text}", log, timeout=1.5, post_wait=1.0):
            return True
    for text in buttons:
        if click_selector(poco, poco(text=text), f"click_confirm_{text}", log, timeout=1.5, post_wait=1.0):
            return True
    return False


def click_confirm_text(poco, log, text, label, timeout=4, post_wait=1.0):
    if click_selector(poco, poco(text=text), f"{label}_{text}", log, timeout=min(timeout, 1.0), post_wait=post_wait):
        return True
    return click_selector(poco, poco(desc=text), f"{label}_desc_{text}", log, timeout=min(timeout, 0.6), post_wait=post_wait)


def wait_confirm_branch_ready(poco, log, confirm_type, wait_ms, ordinary_buttons, platform_buttons, adb_path, serial, token):
    if wait_ms <= 0:
        emit(log, "confirm_wait_skipped", waitMs=wait_ms, confirmType=confirm_type)
        return confirm_type
    deadline = time.time() + (wait_ms / 1000.0)
    last_texts = []
    while time.time() <= deadline:
        try:
            _, _, texts, _ = dump_confirm_xml(adb_path, serial, token)
        except Exception as exc:
            emit(log, "confirm_wait_xml_error", error=repr(exc))
            time.sleep(0.25)
            continue
        last_texts = texts
        detected = classify_confirm_texts(texts) or confirm_type
        if detected == "platform":
            if any(button in texts for button in platform_buttons) or any(marker in "\n".join(texts) for marker in ["请确认是你本人操作", "登录设备", "登录平台", "千帆", "专业号", "商家"]):
                emit(log, "confirm_wait_ready", waitMs=wait_ms, confirmType="platform", texts=texts[:20])
                return "platform"
        if detected == "ordinary":
            if any(button in texts for button in ordinary_buttons) or any(marker in "\n".join(texts) for marker in ["登录确认", "即将登录小红书电脑端", "确认登录"]):
                emit(log, "confirm_wait_ready", waitMs=wait_ms, confirmType="ordinary", texts=texts[:20])
                return "ordinary"
        time.sleep(0.25)
    emit(log, "confirm_wait_timeout", waitMs=wait_ms, confirmType=confirm_type, texts=last_texts[:20])
    return confirm_type


def click_platform_confirm_flow(poco, log):
    emit(log, "confirm_branch_platform", flow=["登录", "同意并登录"])
    if not click_confirm_text(poco, log, "登录", "click_platform_login", timeout=2, post_wait=1.2):
        return False
    deadline = time.time() + 12
    attempts = 0
    while time.time() <= deadline:
        attempts += 1
        if click_confirm_text(poco, log, "同意并登录", "click_platform_agree_login", timeout=1.2, post_wait=1.0):
            emit(log, "platform_agree_login_ready", attempts=attempts)
            return True
        time.sleep(0.4)
    emit(log, "platform_agree_login_timeout", attempts=attempts)
    return False


def click_confirm(poco, log, wait_ms, confirm_type, ordinary_buttons, platform_buttons, adb_path, serial, token):
    confirm_type = wait_confirm_branch_ready(
        poco, log, confirm_type, wait_ms, ordinary_buttons, platform_buttons,
        adb_path, serial, token,
    )
    root, parent, _, _ = dump_confirm_xml(adb_path, serial, token)
    if confirm_type == "ordinary":
        emit(log, "confirm_branch_ordinary", buttons=ordinary_buttons)
        return tap_xml_label(adb_path, serial, root, parent, ordinary_buttons, log, "click_confirm_xml")
    if confirm_type == "platform":
        emit(log, "confirm_branch_platform", flow=["登录", "同意并登录"], reader="uiautomator_xml")
        if not tap_xml_label(adb_path, serial, root, parent, ["登录"], log, "click_platform_login_xml"):
            return False
        deadline = time.time() + 12
        while time.time() <= deadline:
            root, parent, texts, _ = dump_confirm_xml(adb_path, serial, token)
            if "同意并登录" in texts:
                return tap_xml_label(adb_path, serial, root, parent, ["同意并登录"], log, "click_platform_agree_login_xml")
            time.sleep(0.4)
        emit(log, "platform_agree_login_not_present_after_login", reader="uiautomator_xml")
        return True
    return False


def run_preflight(payload):
    log = []
    serial = payload["serial"]
    adb_path = payload.get("adbPath") or "adb"
    try:
        from airtest.core.settings import Settings as ST
        ST.ADB = adb_path
        from airtest.core.api import connect_device

        run_adb(adb_path, serial, ["shell", "echo", "ok"], timeout=8)
        reset_stale_poco_instrumentation(adb_path, serial)
        connect_device(f"Android://127.0.0.1:5037/{serial}?cap_method=JAVACAP&touch_method=ADBTOUCH")
        # We just stopped the old PocoService above. Tell Poco not to spend
        # its built-in ten-second HTTP probe checking whether that deliberately
        # stopped instrumentation is still alive.
        create_stable_poco(
            use_airtest_input=True, screenshot_each_action=False, force_restart=True,
        )
        packages = run_adb(adb_path, serial, ["shell", "pm", "list", "packages"], timeout=20)
        helpers = {
            "pocoService": "package:com.netease.open.pocoservice" in packages,
            "yosemite": "package:com.netease.nie.yosemite" in packages,
        }
        emit(log, "preflight_ready", helpers=helpers, focus=focus(adb_path, serial))
        return {"ok": True, "log": log, "helpers": helpers}
    except Exception as exc:
        emit(log, "preflight_error", error=repr(exc), trace=traceback.format_exc())
        return {"ok": False, "log": log, "error": str(exc)}


def run_xhs(payload, poco=None, connected=False):
    log = []
    global CURRENT_ADB_PATH, CURRENT_SERIAL, CURRENT_RUN_STARTED_AT, CURRENT_LAST_EMIT_AT, CURRENT_RUN_DEADLINE_AT, CURRENT_TARGET_RUN_MS
    CURRENT_RUN_STARTED_AT = time.perf_counter()
    CURRENT_LAST_EMIT_AT = 0.0
    # 60 seconds is the product target, not a destructive cutoff. Keep a
    # bounded safety ceiling so we can capture why a slow phone missed target.
    CURRENT_TARGET_RUN_MS = max(1000, int(payload.get("targetRunMs") or 60000))
    safety_run_ms = max(CURRENT_TARGET_RUN_MS + 30000, int(payload.get("maxRunMs") or 90000))
    CURRENT_RUN_DEADLINE_AT = time.time() + safety_run_ms / 1000
    serial = payload["serial"]
    adb_path = payload.get("adbPath") or "adb"
    CURRENT_ADB_PATH = adb_path
    CURRENT_SERIAL = serial
    package_name = payload.get("xhsPackageName") or "com.xingin.xhs"
    slot = "app2" if payload.get("xhsAppSlot") == "app2" else "app1"
    wait_ms = int(payload.get("confirmWaitMs") or 10000)
    confirm_keywords = normalize_text_list(
        payload.get("loginConfirmKeywords"),
        ["登录确认", "确认登录", "即将登录小红书电脑端", "请确认是你本人操作", "登录设备", "登录地点", "登录平台", "已阅读并同意", "千帆", "专业号", "商家"],
    )
    ordinary_buttons = normalize_text_list(
        payload.get("ordinaryConfirmButtons"),
        ["确认登录", "确定登录", "同意并登录", "授权登录"],
    )
    platform_buttons = normalize_text_list(
        payload.get("platformConfirmButtons"),
        ["登录", "确认登录", "确定登录", "同意并登录", "授权登录"],
    )
    verbose_focus = bool(payload.get("verboseFocus"))
    confirm_xml_token = str(payload.get("taskId") or int(time.time() * 1000))
    owns_poco = False
    try:
        run_adb(adb_path, serial, ["shell", "echo", "ok"], timeout=8)
        require_default_internet_route(adb_path, serial, log)
        if poco is None:
            # On vivo devices with App Clone, creating UiAutomation before
            # launching XHS can leave that session blocked once Android moves
            # to DoubleAppResolverActivity. Start the app first and attach
            # Poco only after the foreground surface has settled.
            emit(log, "poco_deferred_until_launch_surface", focus=maybe_focus(adb_path, serial, verbose_focus))
        else:
            emit(log, "poco_reused", focus=maybe_focus(adb_path, serial, verbose_focus))

        wake_and_unlock(adb_path, serial, log)
        reset_launch_surface(adb_path, serial, log)
        grant_xhs_media_access(adb_path, serial, package_name, log)
        run_adb(adb_path, serial, ["shell", "am", "force-stop", package_name], timeout=10)
        time.sleep(0.4)
        activity = payload.get("launchActivity") or resolve_activity(adb_path, serial, package_name)
        start_out = start_xhs_activity(adb_path, serial, activity, package_name, log)
        time.sleep(0.8)
        emit(log, "post_start_foreground_check_begin", attempt=1)
        first_foreground_ok = xhs_or_resolver_foreground(adb_path, serial)
        emit(log, "post_start_foreground_check_end", attempt=1, ok=first_foreground_ok, focus=focus(adb_path, serial))
        if not first_foreground_ok:
            emit(log, "start_xhs_foreground_retry", activity=activity, focus=focus(adb_path, serial))
            reset_launch_surface(adb_path, serial, log)
            start_out = start_xhs_activity(adb_path, serial, activity, package_name, log)
            time.sleep(1.0)
        emit(log, "post_start_foreground_check_begin", attempt=2)
        second_foreground_ok = xhs_or_resolver_foreground(adb_path, serial)
        emit(log, "post_start_foreground_check_end", attempt=2, ok=second_foreground_ok, focus=focus(adb_path, serial))
        if not second_foreground_ok:
            raise RuntimeError("小红书启动后仍被系统界面覆盖")
        emit(log, "after_start_xhs", activity=activity, focus=maybe_focus(adb_path, serial, verbose_focus))
        emit(log, "collapse_after_start_begin")
        collapse_system_panels(adb_path, serial, log, "collapse_after_start")

        need_choose_slot = (
            "DoubleAppResolverActivity" in start_out
            or "com.android.intentresolver" in start_out
            or "android/com.android.internal.app.ResolverActivity" in start_out
        )
        emit(log, "choose_slot_decision_begin", fromStartOutput=need_choose_slot)
        if not need_choose_slot:
            decision_focus = focus(adb_path, serial)
            need_choose_slot = package_from_focus(decision_focus) == "com.android.intentresolver"
            emit(log, "choose_slot_decision_focus", needChooseSlot=need_choose_slot, focus=decision_focus)
        else:
            emit(log, "choose_slot_decision_start_output", needChooseSlot=True)
        if poco is None:
            from airtest.core.settings import Settings as ST
            ST.ADB = adb_path
            from airtest.core.api import connect_device

            connect_device(f"Android://127.0.0.1:5037/{serial}?cap_method=JAVACAP&touch_method=ADBTOUCH")
            poco = create_stable_poco(use_airtest_input=True, screenshot_each_action=False)
            owns_poco = True
            emit(log, "poco_ready_after_launch_surface", focus=maybe_focus(adb_path, serial, verbose_focus))
        slot_selected_via_xml = False
        if need_choose_slot:
            emit(log, "choose_slot_call_begin", slot=slot)
            if not choose_xhs_slot(poco, adb_path, serial, slot, log):
                # The clone picker is system UI. On some Vivo/OPPO builds Poco
                # remains attached to the app-side hierarchy and cannot see
                # resolver cards even though the resolver is foregrounded.
                # Release only this phone's Poco channel, use bounded XML for
                # the exact resolver elements, then attach a fresh Poco to XHS.
                release_poco_for_confirm_xml(adb_path, serial, log)
                poco = None
                if not click_xhs_slot_xml(adb_path, serial, slot, log, f"{confirm_xml_token}-resolver", timeout=8):
                    raise RuntimeError("未找到系统双开应用入口")
                from airtest.core.settings import Settings as ST
                ST.ADB = adb_path
                from airtest.core.api import connect_device

                connect_device(f"Android://127.0.0.1:5037/{serial}?cap_method=JAVACAP&touch_method=ADBTOUCH")
                poco = create_stable_poco(use_airtest_input=True, screenshot_each_action=False)
                owns_poco = True
                slot_selected_via_xml = True
                emit(log, "poco_recreated_after_clone_slot_xml", focus=maybe_focus(adb_path, serial, verbose_focus))
            emit(log, "choose_slot_call_end", slot=slot)
            # The resolver and XHS are distinct Android UI surfaces on vivo.
            # A Poco session attached while the resolver is foregrounded can
            # stop responding immediately after the selected clone opens.
            # Reattach only for this confirmed resolver transition; all later
            # controls remain element-based Poco operations.
            if owns_poco and poco is not None and not slot_selected_via_xml:
                stop_stable_poco(poco, adb_path, serial)
                poco = None
                from airtest.core.settings import Settings as ST
                ST.ADB = adb_path
                from airtest.core.api import connect_device

                connect_device(f"Android://127.0.0.1:5037/{serial}?cap_method=JAVACAP&touch_method=ADBTOUCH")
                poco = create_stable_poco(use_airtest_input=True, screenshot_each_action=False)
                emit(log, "poco_recreated_after_clone_slot", focus=maybe_focus(adb_path, serial, verbose_focus))

            # A few Vivo devices use a very short screen timeout. The resolver
            # transition plus Poco reattach can consume that whole interval,
            # leaving XHS underneath a new keyguard just before profile
            # navigation. Re-unlock only when keyguard state proves it, then
            # recreate this phone's Poco session on the visible XHS surface.
            if is_keyguard_showing(adb_path, serial):
                emit(log, "post_slot_keyguard_detected", focus=focus(adb_path, serial))
                wake_and_unlock(adb_path, serial, log)
                if poco is not None:
                    stop_stable_poco(poco, adb_path, serial)
                    poco = None
                from airtest.core.settings import Settings as ST
                ST.ADB = adb_path
                from airtest.core.api import connect_device

                connect_device(f"Android://127.0.0.1:5037/{serial}?cap_method=JAVACAP&touch_method=ADBTOUCH")
                poco = create_stable_poco(use_airtest_input=True, screenshot_each_action=False)
                owns_poco = True
                emit(log, "poco_recreated_after_post_slot_unlock", focus=maybe_focus(adb_path, serial, verbose_focus))
        emit(log, "after_choose_slot", focus=maybe_focus(adb_path, serial, verbose_focus))
        ensure_xhs_session_available(poco, log)

        if not click_me_entry(poco, log, timeout=12):
            raise RuntimeError("未找到底部“我”入口")
        emit(log, "after_me", focus=maybe_focus(adb_path, serial, verbose_focus))

        scan_entry_via_xml = False
        if slot_selected_via_xml:
            # The exact vendor clone resolver already proved that Poco and the
            # foreground hierarchy diverge on this phone. Profile navigation
            # succeeded, so hand UiAutomation to the bounded XML reader before
            # another missing Poco selector can wedge the resident worker.
            if poco is not None:
                release_poco_for_confirm_xml(adb_path, serial, log)
                poco = None
            if not click_scan_entry_xml(adb_path, serial, log, f"{confirm_xml_token}-scanner", timeout=8):
                raise RuntimeError("未找到右上角“扫一扫”入口")
            scan_entry_via_xml = True
        elif not click_scan_entry_wait(poco, log, timeout=15):
            emit(log, "scan_entry_retry_reenter_profile")
            if not click_me_entry(poco, log, timeout=8) or not click_scan_entry_wait(poco, log, timeout=8):
                raise RuntimeError("未找到右上角“扫一扫”入口")
        emit(log, "after_scan", focus=maybe_focus(adb_path, serial, verbose_focus))

        permission_transition = system_media_permission_prompt_present(adb_path, serial)
        if scan_entry_via_xml:
            if permission_transition:
                emit(log, "album_permission_prompt_detected", focus=focus(adb_path, serial))
                if not accept_xhs_photo_permission_xml(adb_path, serial, log, confirm_xml_token):
                    raise RuntimeError("检测到相册权限提示，但未找到允许按钮")
                emit(log, "album_permission_prompt_recovered", focus=focus(adb_path, serial))
            if not click_album_entry_xml(adb_path, serial, log, confirm_xml_token, timeout=8):
                raise RuntimeError("未找到扫码页“相册”入口")
        elif permission_transition:
            emit(log, "album_permission_prompt_detected", focus=focus(adb_path, serial))
            if owns_poco and poco is not None:
                stop_stable_poco(poco, adb_path, serial)
                poco = None
            release_poco_for_confirm_xml(adb_path, serial, log)
            if not accept_xhs_photo_permission_xml(adb_path, serial, log, confirm_xml_token):
                raise RuntimeError("检测到相册权限提示，但未找到允许按钮")
            emit(log, "album_permission_prompt_recovered", focus=focus(adb_path, serial))
            if not click_album_entry_xml(adb_path, serial, log, confirm_xml_token, timeout=8):
                raise RuntimeError("授予照片权限后仍未找到扫码页“相册”入口")
        elif not click_album_entry(poco, log, timeout=12):
            raise RuntimeError("未找到扫码页“相册”入口")
        emit(log, "after_album", focus=maybe_focus(adb_path, serial, verbose_focus))

        # QA mode exercises the complete in-app navigation path without
        # selecting a QR image or changing the phone's login state.
        if payload.get("dryRun"):
            emit(log, "dry_run_album_ready", focus=maybe_focus(adb_path, serial, verbose_focus))
            elapsed_ms = int((time.perf_counter() - CURRENT_RUN_STARTED_AT) * 1000)
            return {"ok": True, "dryRun": True, "elapsedMs": elapsed_ms, "targetRunMs": CURRENT_TARGET_RUN_MS, "withinTarget": elapsed_ms <= CURRENT_TARGET_RUN_MS, "log": log}

        # Poco's hierarchy snapshot can occasionally wedge after XHS opens its
        # album, and standalone UIAutomator is killed while Poco owns the same
        # UiAutomation channel.  The remaining flow is XML/ADB-only: release
        # Poco first, select the thumbnail by its XML element, then inspect and
        # confirm the result page through the same bounded reader.
        if poco is not None:
            release_poco_for_confirm_xml(adb_path, serial, log)
        image_selected = click_first_album_image_xml(adb_path, serial, log, confirm_xml_token)
        permission_after_album = system_media_permission_prompt_present(adb_path, serial)
        if permission_after_album:
            # Android 14 may show the full/selected-photo permission sheet only
            # after the album entry was tapped. In that state there cannot be a
            # gallery thumbnail yet, so a failed first lookup is recoverable.
            emit(log, "album_permission_prompt_detected_after_open", focus=focus(adb_path, serial))
            if not accept_xhs_photo_permission_xml(adb_path, serial, log, confirm_xml_token):
                raise RuntimeError("检测到相册照片权限提示，但未找到允许访问全部按钮")
            emit(log, "album_permission_prompt_recovered_after_open", focus=focus(adb_path, serial))
            # Most ROMs resume directly into the picker. A few return to the
            # scanner, so retry the exact album element once before selecting.
            image_selected = click_first_album_image_xml(adb_path, serial, log, confirm_xml_token)
            if not image_selected and click_album_entry_xml(adb_path, serial, log, confirm_xml_token, timeout=4):
                image_selected = click_first_album_image_xml(adb_path, serial, log, confirm_xml_token)
            if not image_selected:
                raise RuntimeError("授予照片权限后未能重新选择二维码图片")
            emit(log, "after_reselect_image", focus=maybe_focus(adb_path, serial, verbose_focus))
        elif not image_selected:
            raise RuntimeError("相册未找到可点击图片")
        emit(log, "after_select_image", focus=maybe_focus(adb_path, serial, verbose_focus))

        confirm_type = wait_confirm(poco, adb_path, serial, log, confirm_keywords, timeout=18, token=confirm_xml_token)
        if not confirm_type:
            raise RuntimeError("选中二维码后未进入登录确认页")

        if not click_confirm(
            poco, log, wait_ms, confirm_type, ordinary_buttons, platform_buttons,
            adb_path, serial, confirm_xml_token,
        ):
            raise RuntimeError(f"已进入{confirm_type}登录确认页，但未找到对应确认按钮")
        emit(log, "done", focus=maybe_focus(adb_path, serial, verbose_focus))
        elapsed_ms = int((time.perf_counter() - CURRENT_RUN_STARTED_AT) * 1000)
        return {"ok": True, "elapsedMs": elapsed_ms, "targetRunMs": CURRENT_TARGET_RUN_MS, "withinTarget": elapsed_ms <= CURRENT_TARGET_RUN_MS, "log": log}
    except Exception as exc:
        ui_snapshot = ""
        try:
            _, _, snapshot_texts, _ = dump_confirm_xml(adb_path, serial, confirm_xml_token)
            ui_snapshot = "\n".join(snapshot_texts[:180])
        except Exception as snapshot_exc:
            ui_snapshot = f"bounded_xml_snapshot_error={repr(snapshot_exc)}"
        emit(log, "error", error=repr(exc), trace=traceback.format_exc(), focus=focus(adb_path, serial), uiSnapshot=ui_snapshot, uiHierarchy=ui_snapshot)
        elapsed_ms = int((time.perf_counter() - CURRENT_RUN_STARTED_AT) * 1000)
        return {"ok": False, "elapsedMs": elapsed_ms, "targetRunMs": CURRENT_TARGET_RUN_MS, "withinTarget": elapsed_ms <= CURRENT_TARGET_RUN_MS, "log": log, "error": str(exc)}
    finally:
        try:
            safe_token = "".join(ch if ch.isalnum() else "_" for ch in confirm_xml_token)[-80:]
            run_adb(adb_path, serial, ["shell", "rm", "-f", f"/sdcard/PhoneCloud/.uia-poco-confirm-{safe_token}.xml"], timeout=5)
        except Exception:
            pass
        if owns_poco and poco is not None:
            try:
                stop_stable_poco(poco, adb_path, serial)
            except Exception as cleanup_exc:
                emit(log, "poco_cleanup_error", error=repr(cleanup_exc))


def reader_bootstrap_stage(stage, action):
    """Preserve a bounded machine-readable cause before traceback truncation."""
    try:
        return action()
    except Exception as exc:
        text = str(exc).lower()
        if isinstance(exc, subprocess.TimeoutExpired) or "timed out" in text:
            cause = "timeout"
        elif any(token in text for token in ("offline", "not found", "unauthorized")):
            cause = "device_unavailable"
        elif isinstance(exc, subprocess.CalledProcessError):
            cause = "command_failed"
        elif "connection" in text:
            cause = "connection_failed"
        else:
            cause = "unknown"
        # No command argv, phone, account, OCR text or filesystem path.
        print(json.dumps({"workerDiagnostic": {"stage": stage, "cause": cause}}),
              file=sys.stderr, flush=True)
        raise RuntimeError(f"poco_worker_bootstrap_failed:{stage}:{cause}") from None


def run_worker(serial, adb_path):
    # Third-party instrumentation startup prints to stdout before workerReady.
    # A pipe is otherwise block-buffered, losing the actual Android error when
    # the Agent terminates a timed-out bootstrap. Preserve each complete line.
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(line_buffering=True)
    from airtest.core.settings import Settings as ST
    ST.ADB = adb_path
    from airtest.core.api import connect_device

    bootstrap_started_at = time.perf_counter()
    reader_bootstrap_stage("adb_probe", lambda: verify_worker_adb_transport(adb_path, serial, attempts=2))
    adb_probe_ms = int((time.perf_counter() - bootstrap_started_at) * 1000)
    reset_started_at = time.perf_counter()
    reader_bootstrap_stage("stale_reset", lambda: reset_stale_poco_instrumentation(adb_path, serial))
    stale_reset_ms = int((time.perf_counter() - reset_started_at) * 1000)
    reader_bootstrap_stage("connect_device", lambda: connect_device(f"Android://127.0.0.1:5037/{serial}?cap_method=JAVACAP&touch_method=ADBTOUCH"))
    # `reset_stale_poco_instrumentation` makes Poco's default ten-second
    # connection-state probe both redundant and predictably slow. Skip only
    # that stale-service probe; instrumentation startup remains bounded and
    # all later RPC health checks are unchanged.
    poco = None
    try:
        instrumentation_started_at = time.perf_counter()
        try:
            poco = create_stable_poco(
                use_airtest_input=True, screenshot_each_action=False, force_restart=True,
            )
        except Exception as exc:
            instrumentation_ms = int((time.perf_counter() - instrumentation_started_at) * 1000)
            raise RuntimeError(
                f"poco_worker_instrumentation_handshake_failed:elapsedMs={instrumentation_ms}:{exc}"
            ) from exc
        instrumentation_ms = int((time.perf_counter() - instrumentation_started_at) * 1000)
        try:
            transport_probe_ms = verify_poco_transport_ready(poco)
        except Exception as exc:
            raise RuntimeError(
                f"poco_worker_transport_probe_failed:instrumentationMs={instrumentation_ms}:{exc}"
            ) from exc
    except Exception:
        if poco is not None:
            try:
                stop_stable_poco(poco, adb_path, serial)
            except Exception:
                pass
        raise
    print(json.dumps({
        "workerReady": True,
        "serial": serial,
        "transportVerified": True,
        "transportProbeMs": transport_probe_ms,
        "bootstrapTimings": {
            "adbProbeMs": adb_probe_ms,
            "staleResetMs": stale_reset_ms,
            "instrumentationMs": instrumentation_ms,
            "transportProbeMs": transport_probe_ms,
            "totalMs": int((time.perf_counter() - bootstrap_started_at) * 1000),
        },
    }, ensure_ascii=False), flush=True)
    verify_lookup_stop = False
    try:
        for line in sys.stdin:
            line = line.strip()
            if not line:
                continue
            if line in ("__exit__", "__exit_lookup__"):
                verify_lookup_stop = line == "__exit_lookup__"
                break
            try:
                payload = json.loads(line)
                payload["serial"] = payload.get("serial") or serial
                payload["adbPath"] = payload.get("adbPath") or adb_path
                request_id = payload.get("requestId") or ""
                # A long-lived AndroidUiautomationPoco session can become
                # unresponsive after sitting idle.  Keep this probe deliberately
                # small: the caller only needs proof that the UI RPC round-trip
                # returns, not that a particular screen is currently visible.
                if payload.get("operation") == "poco_probe":
                    probe_started_at = time.perf_counter()
                    probe_exists = bool(poco(type="android.widget.FrameLayout").exists())
                    result = {
                        "ok": True,
                        "operation": "poco_probe",
                        "selectorResponded": True,
                        "selectorExists": probe_exists,
                        "elapsedMs": int((time.perf_counter() - probe_started_at) * 1000),
                    }
                elif payload.get("workflow") == "alipay_name":
                    from alipay_name_lookup import run_poco_operation
                    result = run_poco_operation(payload, poco)
                else:
                    result = run_xhs(payload, poco=poco, connected=True)
                print(json.dumps({"requestId": request_id, "result": result}, ensure_ascii=False), flush=True)
            except Exception as exc:
                print(json.dumps({
                    "requestId": "",
                    "result": {"ok": False, "error": str(exc), "log": [{"step": "worker_error", "error": repr(exc), "trace": traceback.format_exc()}]}
                }, ensure_ascii=False), flush=True)
    finally:
        try:
            if verify_lookup_stop:
                stop_stable_poco(poco, adb_path, serial, verify=True)
                print(json.dumps({"lookupWorkerStopped": True}), flush=True)
            else:
                stop_stable_poco(poco, adb_path, serial)
        except Exception as exc:
            if verify_lookup_stop:
                print(json.dumps({"lookupWorkerStopped": False}), flush=True)
            print(json.dumps({"workerStopWarning": type(exc).__name__}, ensure_ascii=False), file=sys.stderr, flush=True)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--payload")
    parser.add_argument("--serial")
    parser.add_argument("--adb-path", default="adb")
    parser.add_argument("--mode", choices=["run", "preflight", "worker"], default="run")
    args = parser.parse_args()
    if args.mode == "worker":
        if not args.serial:
            raise SystemExit("--serial is required for worker mode")
        run_worker(args.serial, args.adb_path)
        return
    if not args.payload:
        raise SystemExit("--payload is required")
    # Windows PowerShell writes UTF-8 JSON with a BOM by default. Accept both
    # BOM and non-BOM payloads so a test never fails before device automation.
    with open(args.payload, "r", encoding="utf-8-sig") as fh:
        payload = json.load(fh)
    result = run_preflight(payload) if args.mode == "preflight" else run_xhs(payload)
    print(json.dumps({"result": result}, ensure_ascii=False), flush=True)
    sys.exit(0)


if __name__ == "__main__":
    main()
