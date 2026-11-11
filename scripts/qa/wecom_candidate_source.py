"""Read reviewed one-shot source only; never bundles the shared Agent entry."""
import hashlib
import json
from pathlib import Path
import re
import subprocess
ROOT=Path(__file__).resolve().parents[2]
FUNCTIONS=('normalizeEvidenceForTransport','compactEventDetail','compactTaskResultForEvent',
    'compactTaskResultForStatus','taskFailureResult','taskEvent','taskStatus','runTask')


def candidate_files(ref=None):
    def read(name):
        return subprocess.check_output(['git','show',ref+':'+name],cwd=ROOT) if ref else (ROOT/name).read_bytes()
    names=['windows-agent/src/wecom-preview-task.mjs','windows-agent/src/wecom-diagnostics.mjs',
        'scripts/qa/wecom_candidate_host.mjs','scripts/qa/wecom_qa_trace.mjs','scripts/qa/wecom_staging_process.py']
    if ref:
        src_tree=subprocess.check_output(['git','ls-tree','-r','--name-only',ref,'windows-agent/src'],cwd=ROOT,text=True).splitlines()
        names.extend(n for n in src_tree if Path(n).name.startswith('wecom-')and n.endswith('.mjs')and not n.endswith('.test.mjs')and n not in names)
    else:
        names.extend('windows-agent/src/'+p.name for p in sorted((ROOT/'windows-agent/src').glob('wecom-*.mjs'))if not p.name.endswith('.test.mjs')and 'windows-agent/src/'+p.name not in names)
    if ref:
        tree=subprocess.check_output(['git','ls-tree','-r','--name-only',ref,'windows-agent/scripts'],cwd=ROOT,text=True).splitlines()
        names.extend(name for name in tree if Path(name).name.startswith('wecom_')and Path(name).suffix in('.py','.json'))
    else:
        names.extend('windows-agent/scripts/'+p.name for p in sorted((ROOT/'windows-agent/scripts').glob('wecom_*'))if p.suffix in ('.py','.json'))
    files={name:read(name)for name in names}
    source=read('windows-agent/src/index.mjs').decode();functions={}
    for name in FUNCTIONS:
        m=re.search(r'^(?:async )?function '+name+r'\([\s\S]*?^\}',source,re.M)
        if not m:raise ValueError('qa_agent_function_missing')
        functions[name]=m.group()
    files['agent-functions.json']=json.dumps(functions,ensure_ascii=True).encode()
    return files


def write_stage(stage,files):
    if '/staging/wecom-qa-' not in str(stage).replace('\\','/') or stage.exists():raise ValueError('qa_stage_invalid')
    stage.mkdir(parents=True,mode=0o700)
    for name,data in files.items():
        p=stage/name;p.parent.mkdir(parents=True,exist_ok=True);p.write_bytes(data)
    return {name:hashlib.sha256(data).hexdigest()for name,data in files.items()}
