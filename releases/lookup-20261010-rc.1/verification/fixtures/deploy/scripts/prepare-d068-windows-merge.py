#!/usr/bin/env python3
"""Raise the production account-navigation Back budget from two to four."""

from __future__ import annotations

import argparse
import pathlib


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--agent-root", required=True)
    parser.add_argument("--output-root", required=True)
    args = parser.parse_args()
    source_path = pathlib.Path(args.agent_root) / "scripts" / "alipay_name_lookup.py"
    output_path = pathlib.Path(args.output_root) / "scripts" / "alipay_name_lookup.py"
    source = source_path.read_text(encoding="utf-8-sig")
    old = '''        current_focus, focused_app = self.exit_search_activity_for_account_navigation(
            reason, max_attempts=2,
        )'''
    new = '''        current_focus, focused_app = self.exit_search_activity_for_account_navigation(
            reason, max_attempts=4,
        )'''
    if source.count(old) != 1:
        raise RuntimeError(f"account navigation budget: expected one match, found {source.count(old)}")
    updated = source.replace(old, new, 1)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    with output_path.open("w", encoding="utf-8", newline="\n") as output_file:
        output_file.write(updated)
    print(f"prepared {output_path} bytes={output_path.stat().st_size}")


if __name__ == "__main__":
    main()
