#!/usr/bin/env python3
"""Focus an unchanged post-jigsaw phone input so Alipay reveals Search."""

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
    old = """            resume_actual_digits = re.sub(r"\\D", "", resume_actual)
            if resume_actual_digits != phone:
"""
    new = """            resume_actual_digits = re.sub(r"\\D", "", resume_actual)
            resume_should_resubmit = resume_actual_digits == phone and allow_empty_reinput
            if resume_should_resubmit:
                # A completed external jigsaw returns to MainSearchActivity
                # with the original phone preserved but the input unfocused.
                # Focus that exact unchanged input so Alipay exposes Search;
                # do not type the phone a second time.
                self.poco_tap(resume_inputs[0])
                self.emit(
                    \"resume_existing_input_focused\",
                    selector=\"exact_search_input\",
                    resubmitsInput=False,
                    resubmitsSearch=True,
                    driver=\"poco\",
                )
                resume_after_input = False
            elif resume_actual_digits != phone:
"""
    if source.count(old) != 1:
        raise RuntimeError(f"post-jigsaw focus site: expected one match, found {source.count(old)}")
    updated = source.replace(old, new, 1)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    with output_path.open("w", encoding="utf-8", newline="\n") as output_file:
        output_file.write(updated)
    print(f"prepared {output_path} bytes={output_path.stat().st_size}")


if __name__ == "__main__":
    main()
