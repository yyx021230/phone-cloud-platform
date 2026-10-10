#!/usr/bin/env python3
"""Repair the D-067 production-baseline variable mismatch."""

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
    old = "const automaticAccountSwitchReason = queryOperation"
    new = 'const automaticAccountSwitchReason = ["query", "query_resume"].includes(operation)'
    if source.count(old) != 1:
        raise RuntimeError(f"expected one broken D-067 expression, found {source.count(old)}")
    updated = source.replace(old, new, 1)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    with output_path.open("w", encoding="utf-8", newline="\n") as output_file:
        output_file.write(updated)
    print(f"prepared {output_path} bytes={output_path.stat().st_size}")


if __name__ == "__main__":
    main()
