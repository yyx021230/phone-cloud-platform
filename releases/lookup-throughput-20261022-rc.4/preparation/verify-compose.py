import json,pathlib,subprocess,hashlib
stage=pathlib.Path(__file__).resolve().parent;root=pathlib.Path('/opt/phone-cloud-platform');a=json.loads((root/'ACTIVE_PLATFORM_RELEASE.json').read_text())
for row in a['activeCompose']: assert hashlib.sha256(pathlib.Path(row['path']).read_bytes()).hexdigest()==row['sha256']
pending=stage/'compose.pending.json';pending.write_text(json.dumps({'services':{'phone-cloud':{'image':'phone-cloud-platform:lookup-throughput-20261022-rc.4'}}},indent=2)+'\n')
args=['docker','compose']
for row in a['activeCompose']:args+=['-f',row['path']]
old=json.loads(subprocess.check_output(args+['config','--format','json'],cwd=root,text=True))
new=json.loads(subprocess.check_output(args+['-f',str(pending),'config','--format','json'],cwd=root,text=True))
old['services']['phone-cloud']['image']='phone-cloud-platform:lookup-throughput-20261022-rc.4';assert old==new,'configuration changed beyond image'
r={'onlyImageChanges':True,'service':'phone-cloud','candidateImage':old['services']['phone-cloud']['image'],'baseComposeCount':len(a['activeCompose']),'candidateComposeSha256':hashlib.sha256(pending.read_bytes()).hexdigest(),'activated':False}
(stage/'COMPOSE_PREVIEW.json').write_text(json.dumps(r,indent=2)+'\n');print(json.dumps(r))
