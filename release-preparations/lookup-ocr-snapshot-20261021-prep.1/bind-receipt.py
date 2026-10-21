# Run remotely with RECEIPT_COMMIT and RECEIPT_TAG supplied after committing receipts.
from pathlib import Path
import json,hashlib,subprocess,datetime,fcntl
r=Path('/opt/phone-cloud-platform')
with (r/'.deployment.lock').open('a') as lock:
 fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
 p=r/'ACTIVE_PLATFORM_RELEASE.json';raw=p.read_bytes();a=json.loads(raw)
 sha=lambda b:hashlib.sha256(b).hexdigest()
 assert sha(raw)=='69f036b19704f091230669a86f3589b7e457ca0e4620f32c2994f147680f21cf'
 assert a['version']=='lookup-ocr-snapshot-20261021-deployed.1'
 image='sha256:0db4c7eddb1a6ddb4c629882c220e5ee2287640c6520fa26bebf1c890bdf2225'
 c=json.loads(subprocess.check_output(['docker','inspect','phone-cloud-platform'],text=True))[0]
 assert c['Image']==a['imageId']==a['restartImageId']==image
 assert c['State']['Health']['Status']=='healthy'
 assert a['runtimeCandidateCommit']=='1ec44cf2bbf15583821f941efe2b711b0ecb455d'
 assert a['snapshotStorage']['type']=='json'
 receipt=Path(a['receiptDirectory']);assert not (receipt/'SOURCE_BINDING.json').exists()
 (receipt/'ACTIVE.before-source-binding.json').write_bytes(raw)
 a.update(receiptCommit=RECEIPT_COMMIT,receiptTag=RECEIPT_TAG,status='deployed-readonly-verified-awaiting-business-observation',productionAcceptanceComplete=False,
  rollbackImageId='sha256:6e55d42ab1589f99af42878651bf13570775d276e02b2b5004c50a37daaf3c81',rollbackImageTag='phone-cloud-platform:lookup-snapshot-recovery-20261021-rc.1',windowsRollbackDirectory=a['agentOverlay']['backup'])
 a['runtimeSources']={'composition':'1ec44cf2bbf15583821f941efe2b711b0ecb455d','lookup':'0d94fff31ed68e441ae364088a13f6c0c18f774f','snapshotRecovery':'3c890de89623cfd29d5367fcb0773b79288cf74f'}
 if a.get('lastFailedDeployment'):a['lastFailedDeployment']['resolvedBy']='lookup-snapshot-recovery-20261021-deployed.1'
 a['rollbackRequiresJsonSnapshotCompatibility']=True
 assert p.read_bytes()==raw
 tmp=p.with_suffix('.binding.tmp');tmp.write_text(json.dumps(a,ensure_ascii=False,indent=2)+'\n');tmp.replace(p)
 out={'atUtc':datetime.datetime.now(datetime.timezone.utc).isoformat(),'version':a['version'],'runtimeCommit':a['runtimeCandidateCommit'],'receiptCommit':RECEIPT_COMMIT,'receiptTag':RECEIPT_TAG,'activeBeforeSha256':sha(raw),'activeAfterSha256':sha(p.read_bytes()),'image':image,'rollbackImage':a['rollbackImageId'],'windowsRollbackDirectory':a['windowsRollbackDirectory'],'metadataOnly':True,'serviceRestarted':False}
 (receipt/'SOURCE_BINDING.json').write_text(json.dumps(out,indent=2)+'\n');print(json.dumps(out))
