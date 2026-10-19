"""Offline archive verification only. Never starts Agent, ADB, or restores keys."""
import argparse
import hashlib
import json
from pathlib import Path, PurePosixPath
import stat
import zipfile


def digest(stream):
    h = hashlib.sha256()
    for block in iter(lambda: stream.read(1024 * 1024), b""):
        h.update(block)
    return h.hexdigest()


def safe_member(name):
    p = PurePosixPath(name)
    if not name or name.startswith("/") or "\\" in name or ":" in name:
        raise ValueError("unsafe_archive_path")
    if any(part in ("", ".", "..") for part in name.split("/")):
        raise ValueError("unsafe_archive_path")
    return p


def verify_archive(path, entries=None):
    expected = {e["path"]: e for e in entries} if entries is not None else None
    if entries is not None and len(expected) != len(entries):
        raise ValueError("duplicate_manifest_entry")
    seen = set()
    with zipfile.ZipFile(path) as archive:
        for info in archive.infolist():
            safe_member(info.filename)
            folded = info.filename.casefold()
            if folded in seen or stat.S_ISLNK(info.external_attr >> 16):
                raise ValueError("duplicate_or_symlink_entry")
            seen.add(folded)
            if expected is not None:
                e = expected.get(info.filename)
                if e is None or info.file_size != e["bytes"]:
                    raise ValueError("entry_missing_or_size_mismatch")
            with archive.open(info) as source:
                actual = digest(source)  # Reading to EOF also checks ZIP CRC.
            if expected is not None and actual != e["sha256"]:
                raise ValueError("entry_hash_mismatch")
        if expected is not None and len(seen) != len(expected):
            raise ValueError("archive_entries_missing")
    return len(seen)


def verify_bundle(bundle):
    bundle = Path(bundle)
    manifest = json.loads((bundle / "PACKAGE_MANIFEST.json").read_text())
    for name, expected in manifest["files"].items():
        safe_member(name)
        path = bundle / name
        if path.is_symlink() or not path.is_file() or path.stat().st_size != expected["bytes"]:
            raise ValueError("package_file_missing_or_size_mismatch")
        with path.open("rb") as source:
            if digest(source) != expected["sha256"]:
                raise ValueError("package_file_hash_mismatch")
    source_manifest = json.loads((bundle / "MANIFEST.private.json").read_text())
    result = {}
    for name in ("windows-runtime-and-data.zip", "windows-logs.zip"):
        entries = [e for e in source_manifest["entries"] if e["archive"] == name]
        if not entries:
            raise ValueError("empty_archive_manifest")
        result[name] = verify_archive(bundle / name, entries)
    result["usb-driver-packages-reference.zip"] = verify_archive(
        bundle / "usb-driver-packages-reference.zip")
    return {"verifiedEntries": result, "restorePerformed": False,
            "status": "backup_verified_not_cutover_ready"}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("bundle", type=Path)
    args = parser.parse_args()
    try:
        print(json.dumps(verify_bundle(args.bundle), indent=2))
    except Exception as exc:
        raise SystemExit("Verification failed: " + type(exc).__name__ + ": " + str(exc))
