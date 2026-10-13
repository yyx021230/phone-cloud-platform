from pathlib import Path
import os,sys,subprocess,tempfile,json,shutil
source=Path(__file__).resolve().parent.parent
sandbox=Path(tempfile.mkdtemp(prefix='pc-managed-regression-'));target=sandbox/'candidate'
shutil.copytree(source,target,ignore=shutil.ignore_patterns('node_modules','verification','data','.env','.env.*','__pycache__'))
(target/'node_modules').symlink_to('/Users/yyx/ztqc/phone-cloud-platform/node_modules');(target/'windows-agent/node_modules').symlink_to('/Users/yyx/ztqc/phone-cloud-platform/windows-agent/node_modules')
env={'PATH':os.environ['PATH'],'HOME':str(sandbox/'home'),'TMPDIR':str(sandbox),'NO_PROXY':'127.0.0.1,localhost','PYTHONDONTWRITEBYTECODE':'1','PYTHONPATH':'/Users/yyx/.cache/uv/archive-v0/DWPKEj94GJbYAVvO'};Path(env['HOME']).mkdir()
commands=[('smoke',['npm','run','test:smoke'],target),('syntax',['npm','run','check'],target),('screen',['npm','run','test:screen'],target),('agent',['npm','run','check'],target/'windows-agent'),('python',['/Users/yyx/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/bin/python3','-m','unittest','discover','-s','windows-agent/scripts','-p','automation_runners_test.py'],target),('sdk-node',['node','--test','sdk/open_name_lookup/node_client.test.mjs'],target),('sdk-python',['/Users/yyx/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/bin/python3','-m','unittest','sdk.open_name_lookup.python_client_test'],target)]
results=[]
for label,cmd,cwd in commands:
 log=sandbox/(label+'.log')
 with log.open('w') as f:result=subprocess.run(cmd,cwd=cwd,env=env,stdout=f,stderr=subprocess.STDOUT)
 results.append({'check':label,'exitCode':result.returncode,'privateLog':str(log)});print(label, 'PASS' if not result.returncode else 'FAIL',flush=True)
(sandbox/'results.json').write_text(json.dumps(results,indent=2));print('Private evidence:',sandbox,flush=True);sys.exit(any(r['exitCode'] for r in results))
