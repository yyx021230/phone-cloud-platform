#!/usr/bin/env python3
"""Read-only before/after runtime hash check; never starts services or devices."""
from pathlib import Path
import argparse
import hashlib
import json
import sys

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--component", required=True, choices=["cloud", "windows"])
parser.add_argument("--state", required=True, choices=["before", "after"])
parser.add_argument("--root", required=True, type=Path)
args = parser.parse_args()
manifest = json.loads((Path(__file__).resolve().parent / "MANIFEST.json").read_text())
rows = [{"path": row["path"], "sha256": row[args.state + "Sha256"]}
        for row in manifest["files"]] + manifest["frozenFiles"]
checked, differences = 0, []
for row in rows:
    is_windows = row["path"].startswith("windows-agent/")
    if is_windows != (args.component == "windows"):
        continue
    name = row["path"].removeprefix("windows-agent/") if is_windows else row["path"]
    target = args.root / name
    if target.is_symlink() or (target.exists() and not target.is_file()):
        differences.append({"path": row["path"], "reason": "unexpected_file_type"})
    else:
        got = hashlib.sha256(target.read_bytes()).hexdigest() if target.is_file() else None
        if got != row["sha256"]:
            differences.append({"path": row["path"], "reason": "hash_or_presence_mismatch"})
    checked += 1
print(json.dumps({"component": args.component, "state": args.state,
                  "checked": checked, "passed": not differences,
                  "differences": differences}))
sys.exit(1 if differences else 0)
