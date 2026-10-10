#!/usr/bin/env python3
"""Give the randomized-input Poco query enough budget to observe/recover."""

from __future__ import annotations

import argparse
import pathlib


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--agent-root", required=True)
    parser.add_argument("--output-root", required=True)
    args = parser.parse_args()
    source_path = pathlib.Path(args.agent_root) / "src" / "index.mjs"
    output_path = pathlib.Path(args.output_root) / "src" / "index.mjs"
    source = source_path.read_text(encoding="utf-8-sig")
    old = 'const queryDeadlineAt = task.type === "alipay_name_query" ? startedAt + 17_500 : 0;'
    new = 'const queryDeadlineAt = task.type === "alipay_name_query" ? startedAt + 40_000 : 0;'
    if source.count(old) != 1:
        raise RuntimeError(f"query deadline: expected one match, found {source.count(old)}")
    updated = source.replace(old, new, 1)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    with output_path.open("w", encoding="utf-8", newline="\n") as output_file:
        output_file.write(updated)
    print(f"prepared {output_path} bytes={output_path.stat().st_size}")


if __name__ == "__main__":
    main()
