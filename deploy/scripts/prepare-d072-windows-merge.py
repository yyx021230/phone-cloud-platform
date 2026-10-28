#!/usr/bin/env python3
"""Humanize phone editing and remove redundant automatic account verification."""

from __future__ import annotations

import argparse
import pathlib


def replace_once(source: str, old: str, new: str, label: str) -> str:
    count = source.count(old)
    if count != 1:
        raise RuntimeError(f"{label}: expected one match, found {count}")
    return source.replace(old, new, 1)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--agent-root", required=True)
    parser.add_argument("--output-root", required=True)
    args = parser.parse_args()
    source_path = pathlib.Path(args.agent_root) / "scripts" / "alipay_name_lookup.py"
    output_path = pathlib.Path(args.output_root) / "scripts" / "alipay_name_lookup.py"
    source = source_path.read_text(encoding="utf-8-sig")

    source = replace_once(
        source,
        '''    def clear_focused_search_input(self, method="focused_input_resource"):
        # Android's input command accepts multiple key codes.  Keep the same
        # bounded clear behavior without paying one ADB round trip per delete.
        self.adb(
            ["shell", "input", "keyevent", "--delay", "0", "123", *(["67"] * 24)],
            timeout=8,
        )
        self.emit(
            "clear_previous_query", selector="exact_search_input",
            method=method, keyCount=25,
        )

''',
        '''    def clear_focused_search_input(self, method="focused_input_resource"):
        # Keep one bounded ADB round trip, but space the visible delete keys so
        # the edit resembles an operator clearing the exact focused field.
        key_delay_ms = random.randint(55, 95)
        self.adb(
            ["shell", "input", "keyevent", "--delay", str(key_delay_ms), "123", *(["67"] * 24)],
            timeout=8,
        )
        self.emit(
            "clear_previous_query", selector="exact_search_input",
            method=method, keyCount=25, keyDelayMs=key_delay_ms,
        )

    def input_phone_humanized(self, phone, method, timeout=8, driver="xml_uiautomator"):
        key_delay_ms = random.randint(85, 145)
        keycodes = [str(7 + int(digit)) for digit in phone]
        self.adb(
            ["shell", "input", "keyevent", "--delay", str(key_delay_ms), *keycodes],
            timeout=timeout,
        )
        self.emit(
            "input_phone", method=method, keyCount=len(keycodes),
            keyDelayMs=key_delay_ms, driver=driver,
        )

''',
        "focused clear and phone input helper",
    )

    source = replace_once(
        source,
        '''                    self.adb(
                        ["shell", "input", "text", phone],
                        timeout=min(5.0, remaining),
                    )
                    self.emit(
                        "input_phone",
                        method="adb_text_after_poco_confirmed_empty",
                        driver="poco",
                    )
''',
        '''                    self.input_phone_humanized(
                        phone, "adb_keyevents_after_poco_confirmed_empty",
                        timeout=min(5.0, remaining), driver="poco",
                    )
''',
        "Poco empty-resume input",
    )
    source = replace_once(
        source,
        '''                self.adb(
                    ["shell", "input", "text", phone],
                    timeout=min(5.0, remaining),
                )
                self.emit(
                    "input_phone", method="adb_text_after_poco_exact_input",
                    driver="poco",
                )
''',
        '''                self.input_phone_humanized(
                    phone, "adb_keyevents_after_poco_exact_input",
                    timeout=min(5.0, remaining), driver="poco",
                )
''',
        "Poco exact input",
    )
    source = replace_once(
        source,
        '''        self.adb(["shell", "input", "text", phone], timeout=8)
        self.emit("input_phone", method="reuse_search_EditText")
''',
        '''        self.input_phone_humanized(
            phone, "reuse_search_EditText", timeout=8,
        )
''',
        "XML exact input",
    )
    source = replace_once(
        source,
        '''        current_account = self.switch_account(
            reason=reason,
            excluded_accounts=self.restricted_accounts if reason in ACCOUNT_SWITCH_REASONS else None,
        )
''',
        '''        current_account = self.switch_account(
            reason=reason,
            excluded_accounts=self.restricted_accounts if reason in ACCOUNT_SWITCH_REASONS else None,
            verify_current_marker=False,
        )
''',
        "automatic account-switch confirmation",
    )

    if '["shell", "input", "text", phone]' in source:
        raise RuntimeError("an unconverted direct phone input remains")
    output_path.parent.mkdir(parents=True, exist_ok=True)
    with output_path.open("w", encoding="utf-8", newline="\n") as output_file:
        output_file.write(source)
    print(f"prepared {output_path} bytes={output_path.stat().st_size}")


if __name__ == "__main__":
    main()
