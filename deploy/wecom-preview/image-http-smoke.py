"""Run the preview HTTP contract in disposable, isolated candidate containers.

No published ports, no production database/credentials, no phone/Agent connection.
PostgreSQL and the test process share only the fixture's isolated loopback.
"""
import json
import os
from pathlib import Path
import subprocess
import time

os.umask(0o077)
STAGE = Path(__file__).resolve().parent


def command(args, check=True, timeout=45):
    return subprocess.run(["docker", *args], capture_output=True, text=True, check=check, timeout=timeout)


def main():
    prep = json.loads((STAGE / "PREPARED.json").read_text())
    image = prep["imageId"]
    assert command(["image", "inspect", prep["imageTag"], "--format", "{{.Id}} "]).stdout.strip() == image
    suffix = "wecom-preview-20261028-rc2"
    name = "pc-fixture-pg-" + suffix
    assert command(["inspect", name], check=False).returncode != 0, "existing fixture must be reconciled"
    pg_id = None
    results = {}
    try:
        common = ["--rm", "--read-only", "--memory", "512m", "--cpus", "0.75",
                  "--tmpfs", "/tmp:rw,mode=1777,size=64m", "--mount",
                  "type=bind,src=" + str(STAGE / "tests/wecom-preview.http.test.mjs") + ",dst=/app/server/wecom-preview.http.test.mjs,readonly",
                  "--entrypoint", "node"]
        json_test = command(["run", *common, "--network", "none", image,
                             "--test", "server/wecom-preview.http.test.mjs"], check=False, timeout=60)
        (STAGE / "image-json.log").write_text(json_test.stdout + json_test.stderr)
        assert json_test.returncode == 0, "isolated JSON HTTP contract failed; see image-json.log"
        results["jsonHttp"] = {"exitCode": 0, "fakeAgentOnly": True, "phoneConnections": 0}
        print("Candidate image: isolated JSON HTTP contract passed", flush=True)
        pg_id = command(["run", "-d", "--pull", "never", "--name", name, "--network", "none",
                         "--memory", "256m", "--cpus", "0.5", "--tmpfs", "/var/lib/postgresql/data:rw,mode=1777,size=128m",
                         "-e", "POSTGRES_USER=fixture", "-e", "POSTGRES_DB=wecom_preview_fixture",
                         "-e", "POSTGRES_HOST_AUTH_METHOD=trust", "postgres:16-alpine"]).stdout.strip()
        for _ in range(60):
            if command(["exec", pg_id, "pg_isready", "-h", "127.0.0.1", "-U", "fixture", "-d", "wecom_preview_fixture"], check=False).returncode == 0:
                break
            time.sleep(.25)
        else:
            raise RuntimeError("isolated PostgreSQL not ready")
        pg_test = command(["run", *common, "--network", "container:" + pg_id,
                           "-e", "WECOM_PREVIEW_TEST_DATABASE_URL=postgresql://fixture@127.0.0.1:5432/wecom_preview_fixture",
                           image, "--test", "server/wecom-preview.http.test.mjs"], check=False, timeout=60)
        (STAGE / "image-pg.log").write_text(pg_test.stdout + pg_test.stderr)
        assert pg_test.returncode == 0, "isolated PostgreSQL HTTP contract failed; see image-pg.log"
        results["postgresHttp"] = {"exitCode": 0, "postgres": 16, "fakeAgentOnly": True,
                                   "restartAndOriginalIdReused": True, "phoneConnections": 0}
        print("Candidate image: isolated PostgreSQL HTTP persistence/restart contract passed", flush=True)
    finally:
        if pg_id:
            command(["rm", "--force", pg_id])
    receipt = {"imageId": image, "sourceCommit": prep["sourceCommit"], "passed": True,
               "network": "fixture loopback only; no published ports", "productionDataUsed": False,
               "checks": results, "fixturesRemoved": True, "productionAcceptanceComplete": False}
    (STAGE / "IMAGE_HTTP_SMOKE.json").write_text(json.dumps(receipt, indent=2) + "\n")
    print(json.dumps(receipt), flush=True)


if __name__ == "__main__":
    main()
