"""Read-only identity, scope, SDK bundle and unchanged-base verification."""
from pathlib import Path
import hashlib
import json
import zipfile

root = Path(__file__).resolve().parent.parent
base = root.parent / "lookup-async-20261013-rc.1"
sha = lambda data: hashlib.sha256(data).hexdigest()
version = json.loads((root / "VERSION.json").read_text())
assert sha((base / "MANIFEST.json").read_bytes()) == version["baseManifestSha256"]
base_manifest = json.loads((base / "MANIFEST.json").read_text())
for name, digest in base_manifest["files"].items():
    assert sha((base / name).read_bytes()) == digest, name
manifest = json.loads((root / "MANIFEST.json").read_text())
for name, digest in manifest["files"].items():
    assert sha((root / name).read_bytes()) == digest, name
actual = {str(p.relative_to(root)) for p in root.rglob("*") if p.is_file()}
assert actual == set(manifest["files"]) | {"MANIFEST.json"}
for name in version["overlayFiles"]:
    assert name in manifest["files"] and (base / name).is_file(), name
assert not any(name.startswith(("server/", "windows-agent/", "screen-client/", "deploy/")) for name in actual)
assert (root / "sdk/open_name_lookup/node_client.test.mjs").read_bytes() == (base / "sdk/open_name_lookup/node_client.test.mjs").read_bytes()
checks = json.loads((root / "public/downloads/name-lookup-sha256.json").read_text())
bundle = root / "public/downloads/name-lookup-integration.zip"
assert sha(bundle.read_bytes()) == checks["zipSha256"]
with zipfile.ZipFile(bundle) as new, zipfile.ZipFile(base / "public/downloads/name-lookup-integration.zip") as old:
    assert set(new.namelist()) == set(old.namelist())
    assert json.loads(new.read("SHA256.json")) == checks["files"]
    for name, digest in checks["files"].items():
        assert sha(new.read(name)) == digest, name
    changed = sorted(name for name in new.namelist() if new.read(name) != old.read(name))
    assert changed == ["README.md", "SHA256.json", "node_client.mjs"], changed
    for name in ("node_client.mjs", "README.md"):
        assert new.read(name) == (root / "sdk/open_name_lookup" / name).read_bytes()
print(json.dumps({"baseManifestFiles": len(base_manifest["files"]), "overlayManifestFiles": len(manifest["files"]), "changedZipEntries": changed, "serverAgentMediaUnchanged": True, "productionConnections": 0}))
