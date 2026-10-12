import base64, datetime, fcntl, hashlib, json, os, pathlib, shutil, subprocess, urllib.request
ROOT=pathlib.Path('/opt/phone-cloud-platform')
STAGE=ROOT/'staging/platform-api-integration-20261012-rc.3'
CONTAINER='phone-cloud-platform'
VERSION='platform-api-integration-20261012-rc.3'
DEPLOYED='platform-api-integration-20261012-deployed.1'
ACTIVE=ROOT/'ACTIVE_PLATFORM_RELEASE.json'

def digest(b):return hashlib.sha256(b).hexdigest()
def run(args,**kwargs):
    r=subprocess.run(args,capture_output=True,**kwargs)
    assert r.returncode==0,'command failed: '+args[0]+' (no secret output recorded)'
    return r.stdout

def inspect():
    x=json.loads(run(['docker','inspect',CONTAINER]))[0]
    return {'id':x['Id'],'image':x['Image'],'pid':x['State']['Pid'],'restartCount':x['RestartCount'],'startedAt':x['State']['StartedAt'],'health':x['State'].get('Health',{}).get('Status'),'envHash':digest(json.dumps(x['Config']['Env'],sort_keys=True).encode()),'mountsHash':digest(json.dumps(sorted(x['Mounts'],key=lambda m:m['Destination']),sort_keys=True).encode())}

def media():
    t=STAGE/'tools'
    return json.loads(run([str(t/'lib/ld-musl-x86_64.so.1'),'--library-path',str(t/'lib'),str(t/'node'),str(ROOT/'deploy/mediamtx-pacing/verify.mjs'),'--live'],text=True,timeout=20))

def hashes(paths,image=None):
    js="const fs=require('node:fs'),crypto=require('node:crypto');let o={};for(const p of "+json.dumps(paths)+"){try{o[p]=crypto.createHash('sha256').update(fs.readFileSync('/app/'+p)).digest('hex')}catch(e){if(e.code==='ENOENT')o[p]=null;else throw e}}console.log(JSON.stringify(o))"
    cmd=['docker','exec',CONTAINER,'node','-e',js] if image is None else ['docker','run','--rm','--network','none','--entrypoint','node',image,'-e',js]
    return json.loads(run(cmd,text=True,timeout=25))

def observe():
    js="""const get=async p=>{let r=await fetch('http://127.0.0.1:8787'+p,{headers:{Authorization:'Bearer '+process.env.ADMIN_API_TOKEN},signal:AbortSignal.timeout(10000)});if(!r.ok)throw Error('read failed');return r.json()};
const [d,a,l]=await Promise.all([get('/api/v1/devices'),get('/api/v1/windows-agents'),get('/api/v1/device-locks')]);let ms=Number(process.env.WINDOWS_AGENT_ONLINE_SECONDS||90)*1000;console.log(JSON.stringify({total:d.devices.length,listed:d.devices.filter(x=>x.listed).length,online:d.devices.filter(x=>x.adb?.state==='device'&&Date.now()-Date.parse(x.adb.lastSeenAt||x.adb.updatedAt)<ms).length,agents:a.agents.map(x=>({enabled:x.enabled,lastSeenAt:x.lastSeenAt,online:Date.now()-Date.parse(x.lastSeenAt)<ms,reportedDevices:x.devices?.length||0})),activeLocks:l.locks.filter(x=>x.status==='active').length}))"""
    out=json.loads(run(['docker','exec',CONTAINER,'node','--input-type=module','-e',js],text=True,timeout=20))
    out['healthReady']={}
    for p in ['/healthz','/readyz']:
        r=urllib.request.urlopen('http://127.0.0.1:8787'+p,timeout=10);out['healthReady'][p]=r.status
    return out

def others():
    ids=run(['docker','ps','-q'],text=True).split()
    return {i['Name']:{'id':i['Id'],'image':i['Image'],'pid':i['State']['Pid'],'startedAt':i['State']['StartedAt']} for i in json.loads(run(['docker','inspect',*ids],text=True)) if i['Name']!='/'+CONTAINER}

def atomic_json(p,obj):
    tmp=p.with_name(p.name+'.tmp');tmp.write_text(json.dumps(obj,ensure_ascii=False,indent=2)+'\n');tmp.chmod(0o600);tmp.replace(p)

def prepare(data):
    assert data['version']==VERSION
    assert digest(ACTIVE.read_bytes())==data['activeSha256'],'ACTIVE drift'
    a=json.loads(ACTIVE.read_text());before=inspect()
    assert before['pid']==2684217 and before['restartCount']==0 and before['image']==data['runningImage'],'runtime drift'
    for f in a['activeCompose']:assert digest(pathlib.Path(f['path']).read_bytes())==f['sha256'],'Compose drift'
    expected=dict(data['expectedHashes'])
    for f in a['hotPatchedRuntimeFiles']:expected[f['path']]=f['afterSha256']
    got=hashes(list(expected));assert got==expected,'source drift'
    med=media();backup=STAGE/'backups';backup.mkdir(exist_ok=True)
    if (backup/'ACTIVE_PLATFORM_RELEASE.json').exists():
        assert digest((backup/'ACTIVE_PLATFORM_RELEASE.json').read_bytes())==data['activeSha256'],'backup drift'
    else:shutil.copy2(ACTIVE,backup/'ACTIVE_PLATFORM_RELEASE.json')
    for i,f in enumerate(a['activeCompose']):shutil.copy2(f['path'],backup/('compose-'+str(i)+'.json'))
    build=STAGE/'build';build.mkdir(exist_ok=True);assets=[]
    before_assets=hashes([f['target'] for f in data['files']])
    for f in data['files']:
        path=f['target'];assert path.startswith('public/') and '..' not in path
        raw=base64.b64decode(f['bytes']);assert digest(raw)==f['sha256']
        target=build/path;target.parent.mkdir(parents=True,exist_ok=True);target.write_bytes(raw);target.chmod(0o644)
        old=before_assets[path]
        if old is not None:
            saved=backup/path;saved.parent.mkdir(parents=True,exist_ok=True)
            run(['docker','cp',CONTAINER+':/app/'+path,str(saved)],timeout=15)
            assert digest(saved.read_bytes())==old
        assets.append({'path':path,'beforeSha256':old,'afterSha256':f['sha256']})
    cached=json.loads(run(['docker','image','inspect',a['restartImageTag']],text=True))[0]['Id']
    assert cached==a['restartImageId'],'cached base tag drift'
    (build/'Dockerfile').write_text('FROM '+a['restartImageTag']+'\nCOPY public/ /app/public/\n')
    if (STAGE/'build.log').exists() and not (STAGE/'build-first-failure.log').exists():shutil.copy2(STAGE/'build.log',STAGE/'build-first-failure.log')
    tag='phone-cloud-platform:'+VERSION
    build_result=subprocess.run(['docker','build','--pull=false','--network=none','--label','org.opencontainers.image.revision='+data['commit'],'-t',tag,str(build)],text=True,capture_output=True,timeout=180,env={**os.environ,'DOCKER_BUILDKIT':'0'})
    (STAGE/'build.log').write_text(build_result.stdout+build_result.stderr)
    assert build_result.returncode==0,'isolated successor build failed'
    image=json.loads(run(['docker','image','inspect',tag],text=True))[0]['Id']
    future_expected={**expected,**{f['path']:f['afterSha256'] for f in assets}}
    assert hashes(list(future_expected),image)==future_expected,'next-start image hash mismatch'
    # No-network transient HTTP server validates packaged static bytes only;
    # it does not run the production business app or contact PG/Redis/Agent.
    script="""import fs from 'node:fs';import http from 'node:http';import crypto from 'node:crypto';const expected=EXPECTED;const s=http.createServer((q,r)=>{try{r.end(fs.readFileSync('/app/public'+new URL(q.url,'http://localhost').pathname))}catch{r.statusCode=404;r.end()}});await new Promise(ok=>s.listen(0,'127.0.0.1',ok));let checked=[];try{for(const [p,h] of Object.entries(expected)){const r=await fetch('http://127.0.0.1:'+s.address().port+'/'+p.slice(7));const b=Buffer.from(await r.arrayBuffer());if(r.status!==200||crypto.createHash('sha256').update(b).digest('hex')!==h)throw Error('static mismatch');checked.push(p)}console.log(JSON.stringify({network:'none',staticHttpResources:checked.length,passed:true,businessAppStarted:false}))}finally{s.close()}""".replace('EXPECTED',json.dumps({f['path']:f['afterSha256'] for f in assets}))
    isolated=json.loads(run(['docker','run','--rm','--network','none','--entrypoint','node',image,'--input-type=module','-e',script],text=True,timeout=30))
    run(['docker','save','-o',str(STAGE/'restart-image.tar'),image],timeout=120)
    overlay=json.loads(pathlib.Path(a['activeCompose'][1]['path']).read_text());assert set(overlay['services'])=={'phone-cloud'}
    overlay['services']['phone-cloud']['image']=tag
    newcompose=STAGE/'compose.candidate.json';atomic_json(newcompose,overlay)
    receipt={'atUtc':datetime.datetime.now(datetime.timezone.utc).isoformat(),'version':VERSION,'commit':data['commit'],'beforeActiveSha256':data['activeSha256'],'beforeActiveVersion':a['version'],'beforeContainer':before,'beforeEnvFileSha256':digest((ROOT/'.env').read_bytes()),'previousRestartImageId':a['restartImageId'],'previousRestartImageTag':a['restartImageTag'],'imageId':image,'imageTag':tag,'imageArchiveSha256':digest((STAGE/'restart-image.tar').read_bytes()),'assets':assets,'expectedNonDocHashes':{p:h for p,h in expected.items() if p not in before_assets},'mediaBefore':med,'beforeOtherContainers':others(),'beforeObservation':observe(),'oldCompose':a['activeCompose'],'newCompose':[a['activeCompose'][0],{'path':str(newcompose),'sha256':digest(newcompose.read_bytes())}],'isolatedStaticHttp':isolated,'dependenciesInstalled':False,'productionAssetWrites':0,'restarts':0}
    atomic_json(STAGE/'BUILD_BACKUP.json',receipt)
    assert digest(ACTIVE.read_bytes())==data['activeSha256'] and inspect()==before,'drift during prepare'
    return receipt

def reconcile_prepare(data):
    import time,itertools
    b=json.loads((STAGE/'BUILD_BACKUP.json').read_text());assert b['commit']==data['commit']
    original_mounts_hash=b['beforeContainer']['mountsHash']
    mounts=json.loads(run(['docker','inspect',CONTAINER]))[0]['Mounts']
    canonical=digest(json.dumps(sorted(mounts,key=lambda m:m['Destination']),sort_keys=True).encode())
    assert len(mounts)<=6
    if original_mounts_hash!=canonical:
        assert any(digest(json.dumps(list(order),sort_keys=True).encode())==original_mounts_hash for order in itertools.permutations(mounts)),'actual mounts changed'
        b['beforeContainer']['mountsHash']=canonical
        b['mountFingerprintCorrection']={'reason':'Docker inspect Mounts array order varies; entry contents proven equivalent by original permutation fingerprint','originalUnsortedHash':original_mounts_hash,'canonicalHash':canonical,'mountCount':len(mounts),'configurationChanged':False}
    assert digest(ACTIVE.read_bytes())==b['beforeActiveSha256']
    for index in range(2):
        assert inspect()==b['beforeContainer'],'current runtime differs from original'
        if index==0:time.sleep(1)
    assert digest((ROOT/'.env').read_bytes())==b['beforeEnvFileSha256']
    expected={f['path']:f['beforeSha256'] for f in b['assets']};expected.update(b['expectedNonDocHashes'])
    assert hashes(list(expected))==expected
    future={f['path']:f['afterSha256'] for f in b['assets']};future.update(b['expectedNonDocHashes'])
    assert hashes(list(future),b['imageId'])==future
    assert digest((STAGE/'restart-image.tar').read_bytes())==b['imageArchiveSha256']
    for f in b['newCompose']:assert digest(pathlib.Path(f['path']).read_bytes())==f['sha256']
    assert media()==b['mediaBefore']
    b['reconciliation']={'twoFreshIdentityHealthSnapshotsPassed':True,'allRuntimeAndImageHashesPassed':True,'activeAndEnvUnchanged':True,'previousFinalPrepareAssertionFailed':True,'prepareGuardFalsePositive':'unsorted Mounts array fingerprint; exact entries matched baseline permutation and now sorted canonically','noRebuildOrAssetMutation':True}
    atomic_json(STAGE/'BUILD_BACKUP.json',b)
    return b

def replace_asset(path,source):
    temp='/app/'+path+'.docs-publish.tmp'
    js="const fs=require('node:fs'),path=require('node:path');const p="+json.dumps('/app/'+path)+";fs.mkdirSync(path.dirname(p),{recursive:true});if(fs.existsSync(p)&&fs.lstatSync(p).isSymbolicLink())throw Error('symlink');"
    run(['docker','exec','--user','0',CONTAINER,'node','-e',js],text=True,timeout=10)
    run(['docker','cp',str(source),CONTAINER+':'+temp],timeout=15)
    js="const fs=require('node:fs');fs.chmodSync("+json.dumps(temp)+",0o644);fs.renameSync("+json.dumps(temp)+","+json.dumps('/app/'+path)+")"
    run(['docker','exec','--user','0',CONTAINER,'node','-e',js],text=True,timeout=10)

def activate(data):
    b=json.loads((STAGE/'BUILD_BACKUP.json').read_text());assert b['commit']==data['commit']
    assert digest(ACTIVE.read_bytes())==b['beforeActiveSha256'],'ACTIVE drift'
    assert inspect()==b['beforeContainer'],'container drift'
    a=json.loads(ACTIVE.read_text());med=media();assert med==b['mediaBefore'],'media drift'
    paths=[f['path'] for f in b['assets']];expected={f['path']:f['beforeSha256'] for f in b['assets']}
    assert hashes(paths)==expected and hashes(list(b['expectedNonDocHashes']))==b['expectedNonDocHashes'],'file drift'
    order=sorted(b['assets'],key=lambda f:(2 if f['path'].endswith('api-docs.html') else 0 if '/downloads/' in f['path'] else 1,f['path']))
    touched=[]
    try:
        for f in order:
            replace_asset(f['path'],STAGE/'build'/f['path']);touched.append(f)
        assert hashes(paths)=={f['path']:f['afterSha256'] for f in b['assets']},'runtime asset mismatch'
        checks=[]
        for f in b['assets']:
            r=urllib.request.urlopen('http://47.98.127.132/'+f['path'][7:],timeout=10);blob=r.read()
            assert r.status==200 and digest(blob)==f['afterSha256'],'public HTTP mismatch'
            checks.append({'path':'/'+f['path'][7:],'status':r.status,'sha256':digest(blob)})
        observation=observe();after=inspect();assert after==b['beforeContainer'],'production restarted or config changed'
        assert digest((ROOT/'.env').read_bytes())==b['beforeEnvFileSha256'],'env drift'
        assert hashes(list(b['expectedNonDocHashes']))==b['expectedNonDocHashes'],'non-doc drift'
        assert others()==b['beforeOtherContainers'],'other container drift'
        aftermedia=media();assert aftermedia==b['mediaBefore'],'media drift after'
    except Exception:
        for f in touched:
            if f['beforeSha256'] is not None:replace_asset(f['path'],STAGE/'backups'/f['path'])
            else:run(['docker','exec','--user','0',CONTAINER,'node','-e',"require('node:fs').unlinkSync("+json.dumps('/app/'+f['path'])+")"],text=True,timeout=10)
        assert hashes(paths)==expected,'static rollback incomplete'
        raise
    # Preserve all prior components and history. Document scope is distinct
    # from businessSourceCommit and the unchanged running base image.
    a['previousRelease']=a['version'];a['version']=DEPLOYED;a['status']='docs published; production business acceptance remains bounded';a['atUtc']=datetime.datetime.now(datetime.timezone.utc).isoformat();a['documentVersion']=VERSION;a['documentCommit']=b['commit'];a['documentCandidateTag']=VERSION;a['deployedRuntimeCommit']=b['commit'];a['restartImageId']=b['imageId'];a['restartImageTag']=b['imageTag'];a['activeCompose']=b['newCompose'];a['noProductionServiceRestart']=True;a['productionAcceptanceComplete']=False
    existing={f['path']:f for f in a['hotPatchedRuntimeFiles']};existing.update({f['path']:f for f in b['assets']});a['hotPatchedRuntimeFiles']=list(existing.values());a['documentReceiptDirectory']=str(STAGE);a['documentUserAuthorization']='2026-10-12 user explicitly requested syncing latest API docs and integration package; no runtime, whitelist, Agent or service restart'
    atomic_json(ACTIVE,a)
    receipt={'atUtc':a['atUtc'],'version':DEPLOYED,'candidateVersion':VERSION,'commit':b['commit'],'activeRecordSha256':digest(ACTIVE.read_bytes()),'beforeActiveSha256':b['beforeActiveSha256'],'runningContainer':after,'restartImageId':b['imageId'],'restartImageTag':b['imageTag'],'activeCompose':b['newCompose'],'previousRestartImageId':b['previousRestartImageId'],'staticResources':checks,'nonDocHashesUnchanged':len(b['expectedNonDocHashes']),'mediaBefore':b['mediaBefore'],'mediaAfter':aftermedia,'observation':observation,'environmentUnchanged':True,'otherContainersUnchanged':True,'productionServiceRestarts':0,'newRealTasksOrQueries':0,'newHumanNotifications':0,'businessSourceCommit':a['businessSourceCommit'],'runtimeHotPatchCount':len(a['hotPatchedRuntimeFiles']),'rollbackDirectory':str(STAGE/'backups'),'productionFullAcceptanceComplete':False}
    atomic_json(STAGE/'ACTIVATE.json',receipt)
    return receipt

def main(data):
    STAGE.mkdir(exist_ok=True)
    with open(ROOT/'api-docs-publish.lock','a') as lock:
        fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
        phases={'prepare':prepare,'reconcile_prepare':reconcile_prepare,'activate':activate}
        assert data['phase'] in phases
        result=phases[data['phase']](data)
    print(json.dumps(result,ensure_ascii=False,indent=2))
