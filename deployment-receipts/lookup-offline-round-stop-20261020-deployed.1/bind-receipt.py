from pathlib import Path
import sys,json,hashlib,subprocess,fcntl,copy,datetime
commit=sys.argv[1];assert len(commit)==40 and all(c in '0123456789abcdef' for c in commit)
r=Path('/opt/phone-cloud-platform');lock=(r/'.deployment.lock').open('a');fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB);p=r/'ACTIVE_PLATFORM_RELEASE.json';raw=p.read_bytes();a=json.loads(raw);dest=r/'deployment-receipts/lookup-offline-round-stop-20261020-deployed.1';d=json.loads((dest/'DEPLOYED.json').read_text());v=json.loads((dest/'VERIFIED.json').read_text())
sha=lambda b:hashlib.sha256(b).hexdigest();assert sha(raw)==d['activeSha256'];assert a['version']=='lookup-offline-round-stop-20261020-deployed.1';assert a['runtimeCandidateCommit']=='59ce44eb871754fb34924836a5c0538919b8cc72';assert v['container']['healthy']=='healthy'
c=json.loads(subprocess.check_output(['docker','inspect','phone-cloud-platform'],text=True))[0];assert c['Id']==d['containerId'] and c['Image']==d['image']
# Recovery UI was retained in the new card UI. Preserve original provenance,
# but do not let its historical hashes override the new image's file map.
overlay=a.get('recoveryFeedbackOverlay')
if overlay and overlay.get('files'):
 overlay.setdefault('originalFiles',copy.deepcopy(overlay['files']))
 overlay['files']={f:a['cloudRuntimeFiles'].get(f,h) for f,h in overlay['files'].items()}
 overlay['carriedByCommit']=a['runtimeCandidateCommit'];overlay['includedInImage']=True
 overlay['hashNote']='Current file hashes include retained recovery UI and the committed lookup-card additions; originalFiles preserves original overlay hashes.'
a.update(receiptCommit=commit,receiptTag=a['version'],status='deployed-postflight-verified',productionAcceptanceComplete=False)
a['postflight']={'externalOldRoundStatus':v['externalOldPreparation']['status'],'pending':v['pool']['pending'],'stoppingRounds':v['pool']['stoppingRounds'],'newBusinessSubmitted':0,'newPreparationSubmitted':0,'productionDisconnectionInduced':False}
check="const f=require('fs'),c=require('crypto');for(const[p,h]of Object.entries(JSON.parse(f.readFileSync(0,'utf8'))))if(c.createHash('sha256').update(f.readFileSync('/app/'+p)).digest('hex')!==h)throw Error('hash:'+p)"
subprocess.run(['docker','exec','-i','phone-cloud-platform','node','-e',check],input=json.dumps({**a['cloudRuntimeFiles'],**a.get('recoveryFeedbackOverlay',{}).get('files',{})}),text=True,check=True,capture_output=True)
assert p.read_bytes()==raw;temp=p.with_suffix('.binding.tmp');temp.write_text(json.dumps(a,ensure_ascii=False,indent=2)+'\n');temp.replace(p)
out={'atUtc':datetime.datetime.now(datetime.timezone.utc).isoformat(),'version':a['version'],'candidateCommit':a['runtimeCandidateCommit'],'receiptCommit':commit,'receiptTag':a['version'],'activeBeforeSha256':sha(raw),'activeAfterSha256':sha(p.read_bytes()),'runtimeHashMapVerified':True,'recoveryUiProvenancePreserved':True,'runtimeChanged':False}
(dest/'BINDING.json').write_text(json.dumps(out,indent=2)+'\n');print(json.dumps(out))
