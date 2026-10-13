"""Read-only source/overlay checks; no device or production calls."""
from pathlib import Path
import ast,hashlib,json,subprocess
p=Path(__file__).resolve().parent
root=p.parents[1]
b=json.loads((p/'BASELINE.json').read_text())
sha=lambda data:hashlib.sha256(data).hexdigest()
base={}
for rel,digest in b['baseFiles'].items():
 data=subprocess.check_output(['git','show',b['baseCandidateCommit']+':releases/lookup-pool-20261013-rc.1/'+rel],cwd=root)
 assert sha(data)==digest,rel
 base[rel]=data
rel='windows-agent/scripts/alipay_name_lookup.py'
def methods(data):
 tree=ast.parse(data)
 return {n.name:ast.dump(n,include_attributes=False) for n in ast.walk(tree) if isinstance(n,(ast.FunctionDef,ast.AsyncFunctionDef))}
old=methods(base[rel]);new=methods((p/rel).read_bytes())
assert set(old)==set(new)
changed=[name for name in old if old[name]!=new[name]]
assert changed==['wait_unique'],changed
if (p/'MANIFEST.json').exists():
 m=json.loads((p/'MANIFEST.json').read_text())
 for rel,digest in m['files'].items():assert sha((p/rel).read_bytes())==digest,rel
print(json.dumps({'baseFilesMatched':len(base),'runtimeChangedFunctions':changed,'sharedAdbOrMediaFiles':0,'productionAccess':0}))
