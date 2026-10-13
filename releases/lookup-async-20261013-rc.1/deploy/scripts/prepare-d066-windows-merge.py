#!/usr/bin/env python3
"""Merge D-066 into an already deployed Windows Agent production baseline.

This release helper deliberately patches only the two D-066 regions.  It is
used when the running Windows baseline contains later production hardening that
must not be replaced by a stale whole-file candidate.
"""

from __future__ import annotations

import argparse
import pathlib
import re


def replace_once(text: str, old: str, new: str, label: str) -> str:
    count = text.count(old)
    if count != 1:
        raise RuntimeError(f"{label}: expected one match, found {count}")
    return text.replace(old, new, 1)


def method_span(text: str, name: str) -> tuple[int, int]:
    match = re.search(rf"(?m)^    def {re.escape(name)}\(", text)
    if not match:
        raise RuntimeError(f"method not found: {name}")
    next_match = re.search(r"(?m)^    (?:def |@staticmethod\s*$)", text[match.end():])
    end = len(text) if not next_match else match.end() + next_match.start()
    return match.start(), end


def patch_method(text: str, name: str, transform) -> str:
    start, end = method_span(text, name)
    original = text[start:end]
    updated = transform(original)
    if updated == original:
        raise RuntimeError(f"method unchanged: {name}")
    return text[:start] + updated + text[end:]


FOCUSED_LENGTH_METHOD = '''    def focused_search_input_length(self):
        """Return the focused EditText cursor length without Accessibility hint text."""
        focus = "\\n".join(self.focus())
        if ALIPAY_PACKAGE not in focus or "MainSearchActivity" not in focus:
            return None
        state = str(self.adb(
            ["shell", "dumpsys", "input_method"], timeout=8, check=False,
        ))
        if not re.search(
            r"mServedView=.*com\\.alipay\\.mobile\\.antui:id/search_input_box",
            state,
        ):
            return None
        if not re.search(
            r"mCurrent(?:EditorInfo|TextBoxAttribute):[\\s\\S]{0,800}?"
            r"packageName=com\\.eg\\.android\\.AlipayGphone",
            state,
        ):
            return None
        cursors = re.findall(
            r"mCursorSelStart=(\\d+)\\s+mCursorSelEnd=(\\d+)", state,
        )
        if not cursors:
            return None
        start, end = map(int, cursors[-1])
        return max(start, end)

'''


def patch_python(source: str) -> str:
    source = replace_once(
        source,
        '            r"mCurrentEditorInfo:[\\s\\S]{0,800}?packageName=com\\.eg\\.android\\.AlipayGphone",',
        '            r"mCurrent(?:EditorInfo|TextBoxAttribute):[\\s\\S]{0,800}?"\n'
        '            r"packageName=com\\.eg\\.android\\.AlipayGphone",',
        "input editor compatibility",
    )
    _, focused_end = method_span(source, "focused_search_input_ready")
    source = source[:focused_end] + FOCUSED_LENGTH_METHOD + source[focused_end:]

    def search_ready(method: str) -> str:
        method = replace_once(
            method,
            "    def poco_search_ready(self, poco):",
            "    def poco_search_ready(self, poco, live=True):",
            "poco_search_ready signature",
        )
        two_second_return = "return self.poco_unique(poco, timeout=2.0, name=SEARCH_INPUT_ID)"
        if method.count(two_second_return) != 2:
            raise RuntimeError(
                "two-second frozen Poco inputs: expected two matches, "
                f"found {method.count(two_second_return)}"
            )
        method = method.replace(
            two_second_return,
            "return self.poco_unique(poco, timeout=2.0, live=live, name=SEARCH_INPUT_ID)",
        )
        method = replace_once(
            method,
            "return self.poco_unique(poco, timeout=5.0, name=SEARCH_INPUT_ID)",
            "return self.poco_unique(poco, timeout=5.0, live=live, name=SEARCH_INPUT_ID)",
            "slider recovery frozen Poco input",
        )
        return method

    source = patch_method(source, "poco_search_ready", search_ready)

    old_resume = '''            resume_inputs = self.poco_nodes(resume_snapshot, name=SEARCH_INPUT_ID)
            resume_actual = self.poco_text(resume_inputs[0]) if len(resume_inputs) == 1 else ""
            resume_actual_digits = re.sub(r"\\D", "", resume_actual)
            if resume_actual_digits != phone:
                transitioned = self.poco_observe_result_transition(poco, phone, query_deadline)
                if transitioned:
                    return transitioned
                raise RuntimeError(
                    f"poco_query_resume_state_mismatch:length={len(resume_actual_digits)}"
                )
'''
    new_resume = '''            resume_inputs = self.poco_nodes(resume_snapshot, name=SEARCH_INPUT_ID)
            resume_actual = self.poco_text(resume_inputs[0]) if len(resume_inputs) == 1 else ""
            resume_actual_digits = re.sub(r"\\D", "", resume_actual)
            if resume_actual_digits != phone:
                resume_editable_length = None
                if allow_empty_reinput and len(resume_inputs) == 1:
                    if not resume_actual_digits:
                        self.poco_tap(resume_inputs[0])
                        resume_editable_length = 0
                    else:
                        self.poco_tap(resume_inputs[0])
                        self.adb(["shell", "input", "keyevent", "123"], timeout=5)
                        resume_editable_length = self.focused_search_input_length()
                if (
                    allow_empty_reinput
                    and len(resume_inputs) == 1
                    and resume_editable_length == 0
                ):
                    self.emit(
                        "resume_empty_input_confirmed",
                        selector="exact_search_input", resubmitsInput=True,
                        driver="poco",
                    )
                    if query_deadline - time.perf_counter() < 3.0:
                        raise RuntimeError("alipay_query_deadline_exceeded_before_input")
                    self.wait_before_phone_input("poco_resume_empty_adb")
                    no_name_deadline = time.time() + POCO_NO_NAME_RESULT_SECONDS
                    remaining = max(1.0, query_deadline - time.perf_counter())
                    self.adb(
                        ["shell", "input", "text", phone],
                        timeout=min(5.0, remaining),
                    )
                    self.emit(
                        "input_phone",
                        method="adb_text_after_poco_confirmed_empty",
                        driver="poco",
                    )
                    resume_after_input = False
                else:
                    transitioned = self.poco_observe_result_transition(
                        poco, phone, query_deadline,
                    )
                    if transitioned:
                        return transitioned
                    raise RuntimeError(
                        "poco_query_resume_state_mismatch:"
                        f"length={len(resume_actual_digits)};"
                        f"emptyReinputAllowed={str(bool(allow_empty_reinput)).lower()}"
                    )
'''

    old_primary = '''            input_node = self.poco_search_ready(poco)
            if query_deadline - time.perf_counter() < 3.0:
                raise RuntimeError("alipay_query_deadline_exceeded_before_input")
            self._query_usb_warning_dismissed = False
            try:
                input_node.set_text("")
                self.emit("clear_previous_query", selector="exact_search_input", driver="poco")
                self.wait_before_phone_input("poco")
                no_name_deadline = time.time() + POCO_NO_NAME_RESULT_SECONDS
                self.emit("query_input_started", driver="poco", phoneQueryStarted=True, resubmitsInput=False)
                input_node.set_text(phone)
                self.emit("input_phone", method="poco_set_text", driver="poco")
            except Exception as exc:
                # A timed-out set_text may already have reached the device.
                # Treat the state as post-input/ambiguous so the Agent rebuilds
                # Poco and inspects the existing page with query_resume.  That
                # path never types or submits the number again and fails
                # closed when the field does not contain the expected number.
                raise RuntimeError(
                    f"poco_query_result_channel_timeout_after_input:"
                    f"poco_input_failed:{type(exc).__name__}:{exc}"
                ) from exc
'''
    new_primary = '''            input_node = self.poco_search_ready(poco, live=False)
            if query_deadline - time.perf_counter() < 3.0:
                raise RuntimeError("alipay_query_deadline_exceeded_before_input")
            self._query_usb_warning_dismissed = False
            try:
                self.poco_tap(input_node)
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
                self.emit(
                    "poco_input_clear_confirmed",
                    selector="exact_search_input", editableLength=0,
                    driver="poco_input_connection",
                )
                self.wait_before_phone_input("poco")
                no_name_deadline = time.time() + POCO_NO_NAME_RESULT_SECONDS
                self.poco_tap(cleared_inputs[0])
                remaining = max(1.0, query_deadline - time.perf_counter())
                self.adb(
                    ["shell", "input", "text", phone],
                    timeout=min(5.0, remaining),
                )
                self.emit(
                    "input_phone", method="adb_text_after_poco_exact_input",
                    driver="poco",
                )
            except Exception as exc:
                raise RuntimeError(
                    f"poco_query_result_channel_timeout_after_input:"
                    f"poco_bounded_input_failed:{type(exc).__name__}:{exc}"
                ) from exc
'''

    def query_once(method: str) -> str:
        method = replace_once(
            method,
            "        resume_after_input=False,\n    ):",
            "        resume_after_input=False, allow_empty_reinput=True,\n    ):",
            "query signature",
        )
        method = replace_once(method, old_resume, new_resume, "query resume")
        method = replace_once(method, old_primary, new_primary, "query primary input")
        method = method.replace(
            "query_deadline, resume_after_input=True,\n                )",
            "query_deadline, resume_after_input=True,\n"
            "                    allow_empty_reinput=allow_empty_reinput,\n                )",
        )
        return method

    source = patch_method(source, "query_once_poco", query_once)

    def run_poco(method: str) -> str:
        method = replace_once(
            method,
            '''            input_node = self.poco_search_ready(poco)
            input_node.set_text("")
            self.emit("clear_previous_query", selector="exact_search_input", driver="poco")
''',
            '''            input_node = self.poco_search_ready(poco, live=False)
            self.poco_tap(input_node)
            self.clear_focused_search_input(
                method="poco_exact_input_adb_keyevents",
            )
''',
            "stop clear",
        )
        method = replace_once(
            method,
            '''            poco, phone, query_deadline=self.started + query_budget,
            resume_after_input=(operation == "query_resume"),
''',
            '''            poco, phone, query_deadline=self.started + query_budget,
            resume_after_input=(operation == "query_resume"),
            allow_empty_reinput=bool(
                self.payload.get("allowEmptyInputRecovery", True)
            ),
''',
            "resume recovery flag",
        )
        return method

    return patch_method(source, "run_poco", run_poco)


def patch_index(source: str) -> str:
    pattern = re.compile(
        r'''      if \(operation === "query"\n'''
        r'''        && !parsed\.ok\n'''
        r'''        && String\(parsed\.error \|\| ""\)\.includes\("poco_query_result_channel_timeout_after_input"\)\) \{\n'''
        r'''[\s\S]*?        parsed = resumed;\n      \}\n'''
    )
    replacement = '''      if (operation === "query"
        && !parsed.ok
        && String(parsed.error || "").includes("poco_query_result_channel_timeout_after_input")) {
        const initialResumeError = String(parsed.error || "");
        const maxQueryResumeAttempts = 2;
        for (let resumeAttempt = 1; resumeAttempt <= maxQueryResumeAttempts; resumeAttempt += 1) {
          const allowEmptyInputRecovery = resumeAttempt === 1
            && (initialResumeError.includes("poco_bounded_input_failed")
              || initialResumeError.includes("poco_input_failed"));
          await taskEvent(task, "alipay_name", "warn", "Poco 查询结果通道超时，正在重建 Poco 恢复结果页面", {
            operation,
            retryOperation: "query_resume",
            resumeAttempt,
            maxResumeAttempts: maxQueryResumeAttempts,
            resubmitsInput: allowEmptyInputRecovery ? "only_after_confirmed_empty" : false,
            fallbackSkipped: "xml_uiautomator",
            driver: "poco"
          });
          await stopAirtestWorker(task.adbSerial, "poco_query_result_channel_timeout").catch(() => {});
          let resumed;
          try {
            const resumeBudgetRemainingMs = alipayPocoQueryRecoveryBudgetMs(queryDeadlineAt, "query_resume");
            resumed = await runXhsAirtestPocoWorker({
              ...payload,
              operation: "query_resume",
              allowEmptyInputRecovery
            }, {
              readyTimeoutMs: Math.min(8_000, resumeBudgetRemainingMs),
              timeoutMs: resumeBudgetRemainingMs,
              deadlineAt: queryDeadlineAt,
              maxIdleMs: 15 * 60_000,
              onEvent: onLookupEvent
            });
          } catch (resumeError) {
            throw new Error(`poco_query_resume_failed:${String(resumeError?.message || resumeError)}`);
          }
          const resumeReplayCount = Number(resumed.streamedReplayCount || 0);
          if (!resumeReplayCount) await replayAirtestEvents(task, resumed.log || []);
          if (resumed.ok) {
            parsed = resumed;
            break;
          }
          failedRunner = resumed;
          const resumeError = String(resumed.error || "unknown");
          const remainsPostInputTransportFailure = resumeError.includes(
            "poco_query_result_channel_timeout_after_input"
          );
          if (!remainsPostInputTransportFailure || resumeAttempt >= maxQueryResumeAttempts) {
            throw new Error(`poco_query_resume_failed:${resumeError}`);
          }
        }
      }
'''
    updated, count = pattern.subn(replacement, source, count=1)
    if count != 1:
        raise RuntimeError(f"index query resume block: expected one match, found {count}")
    return updated


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--agent-root", required=True)
    parser.add_argument("--output-root", required=True)
    args = parser.parse_args()
    agent_root = pathlib.Path(args.agent_root)
    output_root = pathlib.Path(args.output_root)
    targets = [
        (agent_root / "src" / "index.mjs", output_root / "src" / "index.mjs", patch_index),
        (
            agent_root / "scripts" / "alipay_name_lookup.py",
            output_root / "scripts" / "alipay_name_lookup.py",
            patch_python,
        ),
    ]
    for source_path, output_path, transform in targets:
        source = source_path.read_text(encoding="utf-8-sig")
        updated = transform(source)
        output_path.parent.mkdir(parents=True, exist_ok=True)
        with output_path.open("w", encoding="utf-8", newline="\n") as output_file:
            output_file.write(updated)
        print(f"prepared {output_path} bytes={output_path.stat().st_size}")


if __name__ == "__main__":
    main()
