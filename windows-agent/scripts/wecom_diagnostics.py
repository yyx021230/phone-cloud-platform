"""Small, fixed-vocabulary progress records; never UI or request data."""
from contextlib import contextmanager
import json
import time

PREFIX = "WECOM_DIAGNOSTIC "
PHASES = (
    "configuration", "adb_identity", "device_preflight", "screen_prepare",
    "poco_launch", "poco_health", "wecom_launch", "rpc_setup",
    "startup_guards", "foreground_wait", "selector_observe", "selector_click", "home_navigation",
    "recipient_search", "remark_edit", "remark_save", "send_claim",
    "invitation_send", "cleanup", "complete",
)


class ExecutionTrace:
    def __init__(self, stream=None, clock=time.monotonic):
        self.stream, self.clock = stream, clock
        self.started = clock()
        self.frames = []
        self.stack = []
        self.step = 0
        self.failure_phase = ""
        self.cleanup_confirmed = None

    def emit(self, phase, state, cleanup=None):
        if phase not in PHASES or state not in ("begin", "end", "error"):
            raise ValueError("invalid_wecom_diagnostic")
        self.step += 1
        frame = dict(version=1, step=self.step, phase=phase, state=state,
                     elapsedMs=max(0, min(900000, int((self.clock()-self.started)*1000))))
        if cleanup is not None:
            frame["cleanupConfirmed"] = cleanup is True
        self.frames = (self.frames + [frame])[-24:]
        if self.stream is not None:
            try:
                self.stream.write(PREFIX + json.dumps(frame, separators=(",", ":")) + "\n")
                self.stream.flush()
            except (OSError, ValueError):
                pass  # Logging failure never grants a retry or another action.

    @contextmanager
    def phase(self, name, seconds=None, timeout_code="preview_phase_timeout"):
        if name not in PHASES:
            raise ValueError("invalid_wecom_phase")
        limit = None if seconds is None else self.clock()+seconds
        self.stack.append((name, limit, timeout_code))
        self.emit(name, "begin")
        try:
            yield
        except Exception:
            if not self.failure_phase and name != "cleanup":
                self.failure_phase = name
            self.emit(name, "error")
            raise
        else:
            self.emit(name, "end")
        finally:
            self.stack.pop()

    def limit(self, overall):
        deadlines = [(overall, "preview_job_budget_exhausted")]
        deadlines += [(limit, code) for _, limit, code in self.stack if limit is not None]
        return min(deadlines, key=lambda item: item[0])

    def cleanup(self, confirmed):
        self.cleanup_confirmed = confirmed is True
        self.emit("cleanup", "end", self.cleanup_confirmed)

    def summary(self):
        last = self.frames[-1] if self.frames else None
        return {"version": 1, "phase": last["phase"] if last else "configuration",
                "failurePhase": self.failure_phase, "elapsedMs": last["elapsedMs"] if last else 0,
                "cleanupConfirmed": self.cleanup_confirmed, "events": list(self.frames)}
