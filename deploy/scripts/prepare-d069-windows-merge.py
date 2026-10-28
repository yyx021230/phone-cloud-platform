#!/usr/bin/env python3
"""Make semantic Alipay outcomes outrank the query timeout wrapper."""

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

    timeout_marker = '''  if (context.operation === "query"
      && /Airtest\\/Poco.*(?:超时|时限|探活)|alipay_query_deadline|poco_query_resume_failed|poco_query_result_channel_timeout_after_input/.test(raw)) {'''
    human_block = '''  if (raw.includes("alipay_human_verification_required")) {
    return {
      ...diagnostic,
      code: "alipay_human_verification_required",
      requiresHumanAction: true,
      message: "支付宝要求人工完成滑动验证；完成后可在当前会话重试同一号码"
    };
  }
'''
    if source.count(timeout_marker) != 1:
        raise RuntimeError(f"query timeout marker: expected one match, found {source.count(timeout_marker)}")
    if source.count(human_block) != 1:
        raise RuntimeError(f"human verification block: expected one match, found {source.count(human_block)}")

    source_without_human = source.replace(human_block, "", 1)
    updated = source_without_human.replace(timeout_marker, human_block + timeout_marker, 1)
    if updated.index(human_block) > updated.index(timeout_marker):
        raise RuntimeError("human verification precedence was not established")

    output_path.parent.mkdir(parents=True, exist_ok=True)
    with output_path.open("w", encoding="utf-8", newline="\n") as output_file:
        output_file.write(updated)
    print(f"prepared {output_path} bytes={output_path.stat().st_size}")


if __name__ == "__main__":
    main()
