"""Read-only immutable source checks; no device, service or production calls."""
from pathlib import Path
import ast
import hashlib
import json
import subprocess

p = Path(__file__).resolve().parent
root = p.parents[1]
base = json.loads((p / "BASELINE.json").read_text())
sha = lambda data: hashlib.sha256(data).hexdigest()
sources = {}
for rel, expected in base["baseFiles"].items():
    tag = base["precedingPatchTag"] if rel.startswith("windows-agent/") else base["baseFullTag"]
    data = subprocess.check_output(["git", "show", tag + ":releases/" + tag + "/" + rel], cwd=root)
    assert sha(data) == expected, rel
    sources[rel] = data

def methods(data):
    return {n.name: ast.dump(n, include_attributes=False) for n in ast.walk(ast.parse(data))
            if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef))}

rel = "windows-agent/scripts/alipay_name_lookup.py"
old, new = methods(sources[rel]), methods((p / rel).read_bytes())
assert old.keys() == new.keys()
assert [k for k in old if old[k] != new[k]] == ["account_picker_rows"]
rel = "server/managed-lookup.mjs"
expected = sources[rel].decode().replace(
    "tickPromise=store.transact(async(s,tx)=>{",
    "tickPromise=store.transact(async(s,tx)=>{\n"
    "        // A removed reservation stays published until this transaction commits.\n"
    "        // Reacquiring it here would conflict and roll back other phones too.\n"
    "        const releasedDevices=new Set();", 1).replace(
    "s.channels.splice(s.channels.indexOf(c),1);",
    "s.channels.splice(s.channels.indexOf(c),1);releasedDevices.add(c.deviceId);", 1).replace(
    "d.enabled&&!(d.quarantineUntil>now())&&!used.has(d.deviceId)",
    "d.enabled&&!releasedDevices.has(d.deviceId)&&!(d.quarantineUntil>now())&&!used.has(d.deviceId)", 1)
assert (p / rel).read_text() == expected, "unexpected server changes"
for rel, expected in json.loads((p / "MANIFEST.json").read_text())["files"].items():
    assert sha((p / rel).read_bytes()) == expected, rel
print(json.dumps({"baseFilesMatched": 2, "changedPythonFunctions": ["account_picker_rows"],
                  "productionAccess": 0, "sharedAdbOrMediaChanges": 0}))
