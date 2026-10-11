#!/usr/bin/env python3
"""Build a minimal, offline source delivery from an immutable reviewed tag.

No SSH, application startup, dependency installation or deployment is performed.
The archive verifier reads archives in memory and never extracts them.
"""
from pathlib import Path, PurePosixPath
import argparse
import gzip
import hashlib
import io
import json
import subprocess
import tarfile

ROOT = Path(__file__).resolve().parents[1]
SOURCE_TAG = "platform-api-docs-20261010-rc.5"
SOURCE_PATH = "releases/platform-api-docs-20261010-rc.1"
RELEASE = "platform-update-20261011-rc.1"


def git(*args):
    return subprocess.check_output(["git", "-C", str(ROOT), *args])


def sha(data):
    return hashlib.sha256(data).hexdigest()


def source(relative):
    return git("show", SOURCE_TAG + ":" + SOURCE_PATH + "/" + relative)


def safe_path(name):
    path = PurePosixPath(name)
    if path.is_absolute() or ".." in path.parts or str(path) != name:
        raise ValueError("Unsafe package path: " + name)
    if name not in ("Dockerfile", "runtime-manifest.json") and not name.startswith(
            ("server/", "public/", "windows-agent/", "src/", "scripts/", "cloud/")):
        raise ValueError("Outside runtime allowlist: " + name)


def source_manifest():
    if git("cat-file", "-t", SOURCE_TAG).strip() != b"tag":
        raise ValueError("Source must be an annotated tag")
    original = json.loads(source("verification/MANIFEST.json"))
    rows = {row["path"]: {
        "path": row["path"], "beforeSha256": row["productionSha256"],
        "afterSha256": row["mergedSha256"]
    } for row in original["runtimeChanges"]}
    for row in original["apiDocsChanges"]:
        name = row["path"]
        if name in rows:
            if rows[name]["afterSha256"] != row["afterSha256"]:
                raise ValueError("Overlapping candidate hash disagrees: " + name)
        else:
            if row["beforeSha256"] is not None:
                raise ValueError("Unexpected additional existing file: " + name)
            rows[name] = dict(row)
    frozen = original["frozenProductionFilesUnchanged"]
    if set(rows) & {row["path"] for row in frozen}:
        raise ValueError("Patch touches frozen files")
    for row in list(rows.values()) + frozen:
        safe_path(row["path"])
        expected = row.get("afterSha256", row.get("sha256"))
        if sha(source(row["path"])) != expected:
            raise ValueError("Reviewed source hash disagrees: " + row["path"])
    return {
        "schemaVersion": 1, "release": RELEASE,
        "status": "local_candidate_not_deployed",
        "sourceTag": SOURCE_TAG,
        "sourceCommit": git("rev-parse", SOURCE_TAG + "^{commit}").decode().strip(),
        "sourceTagObject": git("rev-parse", SOURCE_TAG).decode().strip(),
        "sourcePath": SOURCE_PATH,
        "productionImportCommit": "e72d66bcb3afde53623710fb3366844c944df33c",
        "expectedProductionImageId": "sha256:" + original["productionImageSha256"],
        "files": sorted(rows.values(), key=lambda row: row["path"]),
        "frozenFiles": frozen,
        "rollbackNewFiles": sorted(name for name, row in rows.items() if row["beforeSha256"] is None),
        "rollbackScope": "Code originals only. Fresh image, config, data and Agent backups are required at the release window.",
        "databaseSchemaMigration": False,
    }


def payloads(manifest):
    cloud, windows, rollback = {}, {}, {}
    for row in manifest["files"]:
        name = row["path"]
        data = source(name)
        if name.startswith("windows-agent/"):
            windows[name.removeprefix("windows-agent/")] = data
        else:
            cloud[name] = data
        if row["beforeSha256"] is not None:
            before = source("verification/production-before/" + name)
            if sha(before) != row["beforeSha256"]:
                raise ValueError("Rollback original hash disagrees: " + name)
            rollback[name] = before
    # Requires the exact current production base image; no npm install, pull or
    # media/Agent changes are part of this application-only overlay context.
    dockerfile = '''ARG BASE_IMAGE
FROM ${BASE_IMAGE}
WORKDIR /app
COPY cloud/ /app/
COPY runtime-manifest.json /opt/phone-cloud-release/runtime-manifest.json
RUN node -e 'const fs=require("fs"),c=require("crypto"),m=JSON.parse(fs.readFileSync("/opt/phone-cloud-release/runtime-manifest.json")); for(const r of [...m.files,...m.frozenFiles].filter(r=>!r.path.startsWith("windows-agent/"))){const got=c.createHash("sha256").update(fs.readFileSync(r.path)).digest("hex"); if(got!==(r.afterSha256||r.sha256))throw Error("Runtime hash mismatch: "+r.path)}'
LABEL org.opencontainers.image.revision="SOURCE_COMMIT" org.opencontainers.image.version="RELEASE_ID"
'''.replace("SOURCE_COMMIT", manifest["sourceCommit"]).replace("RELEASE_ID", RELEASE)
    context = {"cloud/" + name: data for name, data in cloud.items()}
    context["Dockerfile"] = dockerfile.encode()
    context["runtime-manifest.json"] = (json.dumps(manifest, ensure_ascii=False, indent=2) + "\n").encode()
    return {"cloud-update.tar.gz": cloud, "windows-update.tar.gz": windows,
            "rollback-code-originals.tar.gz": rollback,
            "cloud-build-context.tar.gz": context}


def archive_bytes(files):
    out = io.BytesIO()
    with gzip.GzipFile(fileobj=out, mode="wb", filename="", mtime=0) as compressed:
        with tarfile.open(fileobj=compressed, mode="w", format=tarfile.PAX_FORMAT) as archive:
            for name, data in sorted(files.items()):
                safe_path(name)
                info = tarfile.TarInfo(name)
                info.size, info.mode, info.mtime = len(data), 0o644, 0
                archive.addfile(info, io.BytesIO(data))
    return out.getvalue()


def verify(folder):
    recorded = json.loads((folder / "MANIFEST.json").read_text())
    expected = source_manifest()
    for key, value in expected.items():
        if recorded.get(key) != value:
            raise ValueError("Manifest differs from reviewed tag: " + key)
    archives = payloads(expected)
    if set(recorded["archives"]) != set(archives):
        raise ValueError("Archive allowlist differs")
    for filename, wanted in archives.items():
        data = (folder / filename).read_bytes()
        row = recorded["archives"][filename]
        if sha(data) != row["sha256"] or len(data) != row["bytes"] or len(wanted) != row["entries"]:
            raise ValueError("Archive identity mismatch: " + filename)
        seen = set()
        with tarfile.open(fileobj=io.BytesIO(data), mode="r:gz") as archive:
            for member in archive.getmembers():
                safe_path(member.name)
                if not member.isfile() or member.name in seen or member.name not in wanted:
                    raise ValueError("Unexpected or unsafe archive entry")
                seen.add(member.name)
                if archive.extractfile(member).read() != wanted[member.name]:
                    raise ValueError("Archive bytes differ from source tag")
        if seen != set(wanted):
            raise ValueError("Incomplete archive")
    print(json.dumps({"verified": True, "sourceCommit": expected["sourceCommit"],
                      "runtimeFiles": len(expected["files"]),
                      "frozenFiles": len(expected["frozenFiles"]),
                      "archives": {name: len(files) for name, files in archives.items()}}))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--verify", type=Path, help="Verify a prepared package without extracting it")
    parser.add_argument("--output", type=Path, default=ROOT / "releases" / RELEASE)
    args = parser.parse_args()
    if args.verify:
        verify(args.verify.resolve())
        return
    manifest = source_manifest()
    archives = payloads(manifest)
    args.output.mkdir(parents=True, exist_ok=False)
    manifest["archives"] = {}
    for name, files in archives.items():
        data = archive_bytes(files)
        (args.output / name).write_bytes(data)
        manifest["archives"][name] = {"sha256": sha(data), "bytes": len(data), "entries": len(files)}
    (args.output / "MANIFEST.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n")
    verify(args.output)


if __name__ == "__main__":
    main()
