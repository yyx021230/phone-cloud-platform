#!/usr/bin/env python3
"""Merge D-067 into the deployed D-066 Windows Agent baseline."""

from __future__ import annotations

import argparse
import pathlib


def replace_once(text: str, old: str, new: str, label: str) -> str:
    count = text.count(old)
    if count != 1:
        raise RuntimeError(f"{label}: expected one match, found {count}")
    return text.replace(old, new, 1)


def patch_index(source: str) -> str:
    source = replace_once(
        source,
        '      const automaticAccountSwitchReason = operation === "query"\n',
        '      const automaticAccountSwitchReason = queryOperation\n',
        "query-resume account restriction routing",
    )
    source = replace_once(
        source,
        '          retryCurrentPhone: true,\n'
        '          fallbackDriver: "xml_uiautomator_account_rotation"',
        '          retryCurrentPhone: true,\n'
        '          resumedAfterHumanVerification: operation === "query_resume",\n'
        '          fallbackDriver: "xml_uiautomator_account_rotation"',
        "resume rotation event",
    )
    source = replace_once(
        source,
        '        await stopAirtestWorker(task.adbSerial, "automatic_account_rotation").catch(() => {});\n',
        '        await stopAirtestWorker(task.adbSerial, "automatic_account_rotation").catch(() => {});\n'
        '        // A post-jigsaw result can itself be an exact account restriction.\n'
        '        // The independent XML runner owns account rotation and intentionally\n'
        '        // replays this same phone only after switching to another saved account.\n'
        '        payload.operation = "query";\n',
        "converted resume query operation",
    )
    return replace_once(
        source,
        '        timeoutMs: operation === "query" ? 480_000 : 120_000,',
        '        timeoutMs: payload.operation === "query" ? 480_000 : 120_000,',
        "converted query timeout",
    )


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--agent-root", required=True)
    parser.add_argument("--output-root", required=True)
    args = parser.parse_args()
    source_path = pathlib.Path(args.agent_root) / "src" / "index.mjs"
    output_path = pathlib.Path(args.output_root) / "src" / "index.mjs"
    source = source_path.read_text(encoding="utf-8-sig")
    updated = patch_index(source)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    with output_path.open("w", encoding="utf-8", newline="\n") as output_file:
        output_file.write(updated)
    print(f"prepared {output_path} bytes={output_path.stat().st_size}")


if __name__ == "__main__":
    main()
