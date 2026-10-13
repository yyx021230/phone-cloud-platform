"""Build only the SDK ZIP overlay from the verified immutable async rc.1 kit."""
from pathlib import Path
import hashlib
import json
import zipfile

root = Path(__file__).resolve().parent.parent
base = root.parent / "lookup-async-20261013-rc.1"
sha = lambda data: hashlib.sha256(data).hexdigest()
checks = json.loads((base / "public/downloads/name-lookup-sha256.json").read_text())
old_zip = base / "public/downloads/name-lookup-integration.zip"
assert sha(old_zip.read_bytes()) == checks["zipSha256"]
with zipfile.ZipFile(old_zip) as z:
    files = {name: z.read(name) for name in z.namelist()}
assert json.loads(files["SHA256.json"]) == checks["files"]
for name, digest in checks["files"].items():
    assert sha(files[name]) == digest, name
for name in ("node_client.mjs", "README.md"):
    files[name] = (root / "sdk/open_name_lookup" / name).read_bytes()
digests = {name: sha(data) for name, data in files.items() if name != "SHA256.json"}
files["SHA256.json"] = (json.dumps(digests, indent=2) + "\n").encode()
downloads = root / "public/downloads"
downloads.mkdir(parents=True, exist_ok=True)
out = downloads / "name-lookup-integration.zip"
with zipfile.ZipFile(out, "w", compression=zipfile.ZIP_DEFLATED) as z:
    for name, data in sorted(files.items()):
        info = zipfile.ZipInfo(name, (2026, 10, 13, 0, 0, 0))
        info.compress_type = zipfile.ZIP_DEFLATED
        info.external_attr = 0o100644 << 16
        z.writestr(info, data)
(downloads / "name-lookup-sha256.json").write_text(json.dumps({
    "version": "lookup-async-20261013-rc.2",
    "baseVersion": "lookup-async-20261013-rc.1",
    "status": "local-sdk-overlay-not-deployed",
    "files": digests,
    "zipSha256": sha(out.read_bytes())
}, indent=2) + "\n")
print(json.dumps({"zipFiles": len(files), "changedEntries": ["README.md", "node_client.mjs", "SHA256.json"]}))
