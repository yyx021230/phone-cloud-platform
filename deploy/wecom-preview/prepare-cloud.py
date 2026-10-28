"""Prepare an inactive, exact production-image overlay. Never stop/reload services.

Run only from a reviewed staging directory containing manifest.json and payload/.
Existing ADB, Windows, media and production configuration are never mutated.
"""
import copy
import fcntl
import hashlib
import json
import os
from pathlib import Path
import subprocess
import time

os.umask(0o077)
ROOT = Path("/opt/phone-cloud-platform")
STAGE = Path(__file__).resolve().parent


def run(args, **options):
    options.setdefault("timeout", 45)
    return subprocess.check_output(args, text=True, **options).strip()


def sha(path):
    value = hashlib.sha256()
    with Path(path).open("rb") as file:
        for block in iter(lambda: file.read(1048576), b""):
            value.update(block)
    return value.hexdigest()


def main():
    lock = (ROOT / ".deployment.lock").open("a")
    fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    manifest = json.loads((STAGE / "manifest.json").read_text())
    assert manifest["mode"] == "preview_only"
    assert not (STAGE / "PREPARED.json").exists(), "already prepared: reconcile existing receipt"
    active_raw = (ROOT / "ACTIVE_PLATFORM_RELEASE.json").read_bytes()
    active = json.loads(active_raw)
    baseline = manifest["baselineImage"]
    assert hashlib.sha256(active_raw).hexdigest() == manifest["baselineActiveSha256"], "ACTIVE baseline drift"
    compose_rows = manifest["baselineCompose"]
    assert active["activeCompose"] == [row["path"] for row in compose_rows], "compose chain drift"
    assert active["version"] == manifest["baselineVersion"]
    assert active["imageId"] == active["restartImageId"] == baseline
    assert run(["docker", "inspect", "phone-cloud-platform", "--format", "{{.Image}} "]) == baseline
    assert run(["docker", "image", "inspect", manifest["baselineTag"], "--format", "{{.Id}} "]) == baseline
    for name, item in manifest["cloudFiles"].items():
        assert name.startswith(("server/", "public/")) and ".." not in Path(name).parts
        assert sha(STAGE / "payload" / name) == item["after"]
    check = "const fs=require('fs'),c=require('crypto');for(const[f,h]of Object.entries(" + json.dumps(manifest["cloudFiles"]) + ")){const p='/app/'+f,a=fs.existsSync(p)?c.createHash('sha256').update(fs.readFileSync(p)).digest('hex'):null;if(a!==h.before)throw Error('baseline drift: '+f)}"
    run(["docker", "exec", "phone-cloud-platform", "node", "-e", check])
    # Actual host namespace; use the existing container's Node/loader, no installs.
    pid = run(["docker", "inspect", "phone-cloud-platform", "--format", "{{.State.Pid}} "])
    runtime = Path("/proc") / pid / "root"
    media_command = [str(runtime / "lib/ld-musl-x86_64.so.1"), "--library-path",
                     str(runtime / "lib") + ":" + str(runtime / "usr/lib"),
                     str(runtime / "usr/local/bin/node"), str(ROOT / "deploy/mediamtx-pacing/verify.mjs"), "--live"]
    media = json.loads(run(media_command, timeout=25))
    assert media["verified"] == "live" and media["bitsPerSecond"] == 8000000 and media["packetsPerGroup"] == 2
    args = ["docker", "compose", "-p", "phone-cloud-platform"]
    for row in compose_rows:
        assert sha(row["path"]) == row["sha256"], "compose baseline drift"
        args += ["-f", row["path"]]
    override = STAGE / "compose.pending.json"
    override.write_text(json.dumps({"services": {"phone-cloud": {"image": manifest["imageTag"]}}}, indent=2) + "\n")
    old = json.loads(run(args + ["config", "--format", "json"]))
    new = json.loads(run(args + ["-f", str(override), "config", "--format", "json"]))
    expected = copy.deepcopy(old)
    expected["services"]["phone-cloud"]["image"] = manifest["imageTag"]
    assert new == expected, "out-of-scope compose change"
    # Do not write resolved configuration or environment secret values to evidence.
    del old, new, expected
    backup = STAGE / "rollback"
    backup.mkdir(mode=0o700, exist_ok=False)
    (backup / "ACTIVE_PLATFORM_RELEASE.json").write_bytes(active_raw)
    (backup / "compose-baseline.json").write_text(json.dumps(compose_rows, indent=2) + "\n")
    for row in compose_rows:
        target = backup / "compose" / Path(row["path"]).relative_to("/")
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(Path(row["path"]).read_bytes())
    for name, item in manifest["cloudFiles"].items():
        if item["before"] is None:
            continue
        target = backup / "runtime" / name
        target.parent.mkdir(parents=True, exist_ok=True)
        subprocess.run(["docker", "cp", "phone-cloud-platform:/app/" + name, str(target)], check=True, stdout=subprocess.DEVNULL)
        assert sha(target) == item["before"]
    free = os.statvfs(STAGE)
    # Measured prior custom dump 2.917GB; immutable image 87.7MB.
    # Reserve 50% growth plus the uncompressed image and 2GiB free space.
    measured_dump = 2916715949
    image_bytes = int(run(["docker", "image", "inspect", baseline, "--format", "{{.Size}} "]))
    assert free.f_bavail * free.f_frsize > measured_dump * 1.5 + image_bytes + 2 * 1024**3, "insufficient safe backup headroom"
    print("Exact runtime/Compose/media baseline checked; creating bounded streaming backups", flush=True)
    database = backup / "database.dump"
    # Credentials remain inside the already-running PostgreSQL container.
    with database.open("wb") as file:
        dump = subprocess.Popen(["docker", "exec", "phone-cloud-postgres", "sh", "-c",
                                 'exec pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc -Z1'], stdout=file)
        until = time.monotonic() + 600
        try:
            while dump.poll() is None:
                remaining = os.statvfs(STAGE)
                assert remaining.f_bavail * remaining.f_frsize > 2 * 1024**3, "backup stopped: retain 2GiB reserve"
                assert time.monotonic() < until, "backup budget exceeded"
                time.sleep(1)
            assert dump.returncode == 0, "database export failed"
        finally:
            if dump.poll() is None:
                dump.terminate()
                try: dump.wait(timeout=10)
                except subprocess.TimeoutExpired: dump.kill(); dump.wait()
    for command in (["pg_restore", "--list"], ["pg_restore", "--file=/dev/null"]):
        with database.open("rb") as file:
            subprocess.run(["docker", "exec", "-i", "phone-cloud-postgres", *command],
                           stdin=file, stdout=subprocess.DEVNULL, check=True, timeout=600)
    image_backup = backup / "previous-image.tar.gz"
    with image_backup.open("wb") as file:
        export = subprocess.Popen(["docker", "image", "save", baseline], stdout=subprocess.PIPE)
        compress = subprocess.Popen(["nice", "-n", "10", "gzip", "-1"], stdin=export.stdout, stdout=file)
        export.stdout.close()
        try:
            assert compress.wait(timeout=300) == 0 and export.wait(timeout=30) == 0, "image export failed"
        finally:
            if compress.poll() is None: compress.kill(); compress.wait()
            if export.poll() is None: export.kill(); export.wait()
    subprocess.run(["gzip", "-t", str(image_backup)], check=True, timeout=180)
    print("Backup decode and previous image export complete; building inactive candidate", flush=True)
    dockerfile = STAGE / "Dockerfile"
    dockerfile.write_text("FROM " + manifest["baselineTag"] + "\nCOPY payload/ /app/\n")
    (STAGE / ".dockerignore").write_text("*\n!Dockerfile\n!payload/\n!payload/**\n")
    with (STAGE / "build.log").open("w") as log:
        subprocess.run(["nice", "-n", "10", "docker", "build", "--pull=false", "-t", manifest["imageTag"], str(STAGE)],
                       stdout=log, stderr=subprocess.STDOUT, check=True, timeout=600)
    image = run(["docker", "image", "inspect", manifest["imageTag"], "--format", "{{.Id}} "])
    assert (ROOT / "ACTIVE_PLATFORM_RELEASE.json").read_bytes() == active_raw, "active changed during preparation"
    assert run(["docker", "inspect", "phone-cloud-platform", "--format", "{{.Image}} "]) == baseline
    receipt = {"status": "prepared_not_activated", "sourceCommit": manifest["sourceCommit"],
               "imageTag": manifest["imageTag"], "imageId": image, "previousImage": baseline,
               "atUtc": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "media": media,
               "cloudFiles": manifest["cloudFiles"], "composeOnlyImageChanged": True,
               "databaseBytes": database.stat().st_size, "databaseSha256": sha(database),
               "databaseFullDecode": True, "fullDatabaseRestoreRehearsed": False,
               "previousImageArchiveBytes": image_backup.stat().st_size, "previousImageArchiveSha256": sha(image_backup),
               "activeBeforeSha256": hashlib.sha256(active_raw).hexdigest(), "serviceReloaded": False,
               "agentReloaded": False, "adbChanged": False}
    for file in backup.rglob("*"):
        if file.is_file():
            file.chmod(0o600)
    (STAGE / "PREPARED.json").write_text(json.dumps(receipt, indent=2) + "\n")
    print(json.dumps({k: receipt[k] for k in ("status", "imageId", "sourceCommit", "databaseBytes", "databaseFullDecode")}), flush=True)


if __name__ == "__main__":
    main()
