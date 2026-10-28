"""Archival final state capture. Requires the source Agent already stopped by its operator.

Does not stop services, run ADB, copy keys, restore data, or register tasks.
Run only in the separately authorized cutover window, after cloud work is drained.
"""
import argparse
import datetime
import hashlib
import json
import os
from pathlib import Path
import platform
import zipfile

from verify_bundle import digest


MUTABLE_FILES = {"agent/config.json"}
RUNTIME_PREFIXES = ("agent/src/", "agent/scripts/", "agent/vendor/",
                    "agent/runtime/", "agent/runtime-manifests/", "agent/node_modules/", "tools/")


def is_runtime(relative):
    if "/__pycache__/" in relative or relative.endswith((".pyc", ".log")):
        return False
    return relative.startswith(RUNTIME_PREFIXES) or relative in (
        "agent/adb-auth-env.cjs", "agent/start-agent.cmd", "agent/start-agent.ps1",
        "agent/package.json", "agent/package-lock.json")


def assert_runtime_unchanged(root, manifest):
    expected = {}
    for entry in manifest["entries"]:
        if entry["path"].startswith("D/PhoneCloud/"):
            relative = entry["path"][13:]
            if is_runtime(relative):
                expected[relative] = entry
    if not expected:
        raise ValueError("runtime_baseline_missing")
    for relative, entry in expected.items():
        p = root / relative
        if p.is_symlink() or not p.is_file():
            raise ValueError("runtime_file_missing_or_link")
        with p.open("rb") as stream:
            if digest(stream) != entry["sha256"]:
                raise ValueError("runtime_changed_regenerate_full_backup")
    # New source/dependency files can change behavior too, including those absent from baseline.
    for prefix in RUNTIME_PREFIXES:
        for p in (root / prefix).rglob("*"):
            relative = p.relative_to(root).as_posix()
            if p.is_symlink():
                raise ValueError("runtime_symlink")
            if p.is_file() and is_runtime(relative) and relative not in expected:
                raise ValueError("runtime_added_regenerate_full_backup")


def stable_bytes(path):
    if path.is_symlink():
        raise ValueError("state_symlink")
    if path.stat().st_size > 128 * 1024 * 1024:
        raise ValueError("state_too_large_manual_review")
    first = path.read_bytes()
    if path.read_bytes() != first:
        raise ValueError("state_changed_capture_not_quiescent")
    return first


def capture(root, destination, runtime_verified=False):
    files = [root / "agent/config.json"]
    files += [p for p in (root / "agent/data").rglob("*") if p.is_file()]
    destination.mkdir(parents=True, exist_ok=False)
    rows = []
    archive = destination / "final-state.private.zip"
    with zipfile.ZipFile(archive, "x", zipfile.ZIP_DEFLATED) as out:
        for path in files:
            if path.name.startswith("agent-instance.lock"):
                continue
            content = stable_bytes(path)
            name = path.relative_to(root).as_posix()
            out.writestr(name, content)
            rows.append({"path": name, "bytes": len(content), "sha256": hashlib.sha256(content).hexdigest()})
    with archive.open("rb") as stream:
        checksum = digest(stream)
    with zipfile.ZipFile(archive) as check:
        for row in rows:
            if hashlib.sha256(check.read(row["path"])).hexdigest() != row["sha256"]:
                raise ValueError("capture_verification_failed")
    receipt = {"status": "archived_not_restored", "utc": datetime.datetime.now(datetime.timezone.utc).isoformat(),
               "sha256": checksum, "entries": rows, "runtimeVerifiedUnchanged": runtime_verified,
               "cloudQueueDrained": "operator_confirmation_required", "topologyRequiresReview": True,
               "keysCopied": False, "logsIncluded": False}
    (destination / "FINAL_STATE_RECEIPT.private.json").write_text(json.dumps(receipt, indent=2) + "\n")
    return receipt


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--bundle", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--operator-confirmed-drained", action="store_true")
    args = parser.parse_args()
    if os.name != "nt" or not args.operator_confirmed_drained:
        raise ValueError("requires_windows_and_confirmed_maintenance_window")
    baseline = json.loads((args.bundle / "RELOCATION_BASELINE.json").read_text())
    if platform.node().lower() != baseline["sourceComputer"].lower():
        raise ValueError("not_source_host")
    import psutil
    if not __import__("ctypes").windll.shell32.IsUserAnAdmin():
        raise ValueError("administrator_required")
    for proc in psutil.process_iter(["name", "exe"]):
        if (proc.info["name"] or "").lower() == "node.exe" and "phonecloud" in (proc.info["exe"] or "").lower():
            raise ValueError("agent_still_running_do_not_capture")
    root = Path(r"D:\PhoneCloud")
    allowed = root / "migration-backups"
    args.output.resolve().relative_to(allowed.resolve())
    # A new directory only; existing production data and previous archives remain untouched.
    args.output.mkdir(parents=True, exist_ok=False)
    import subprocess
    subprocess.run(["icacls", str(args.output), "/inheritance:r", "/grant:r",
                    "*S-1-5-18:(OI)(CI)F", "*S-1-5-32-544:(OI)(CI)F"], check=True, capture_output=True)
    manifest = json.loads((args.bundle / "MANIFEST.private.json").read_text())
    key_entries = [e for e in manifest['entries'] if e['path'].startswith('C/') and e['path'].endswith(('/adbkey', '/adbkey.pub'))]
    if len(key_entries) != 4:
        raise ValueError('frozen_key_baseline_missing')
    for entry in key_entries:
        with Path('C:/' + entry['path'][2:]).open('rb') as stream:
            if digest(stream) != entry['sha256']:
                raise ValueError('frozen_key_changed_stop_for_review')
    assert_runtime_unchanged(root, manifest)
    result = capture(root, args.output / "state", runtime_verified=True)
    print(json.dumps({"status": result["status"], "files": len(result["entries"]), "keysCopied": False}))


if __name__ == "__main__":
    main()
