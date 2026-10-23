import pathlib,subprocess,json,fcntl,sys
s=pathlib.Path(__file__).resolve().parent
lock=open('/opt/phone-cloud-platform/.deployment.lock','a');fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
run=lambda a:subprocess.check_output(a,text=True).strip()
a=json.load(open('/opt/phone-cloud-platform/ACTIVE_PLATFORM_RELEASE.json'));b='sha256:35cba1db05e126adf48acaa63241772854b7069559fd054459d74699a49a74ff'
assert a['version']=='lookup-ai-vision-20261022-deployed.1' and a['imageId']==a['restartImageId']==b
assert run(['docker','inspect','phone-cloud-platform','--format','{{.Image}}'])==b
assert run(['docker','image','inspect','phone-cloud-platform:lookup-ai-vision-20261022-rc.1','--format','{{.Id}}'])==b
assert (s/'rollback/database.dump').stat().st_size>0
with open(s/'build-retry.log','w') as log:subprocess.run(['nice','-n','10','docker','build','--pull=false','-t','phone-cloud-platform:lookup-recovery-20261023-rc.6',str(s)],stdout=log,stderr=subprocess.STDOUT,check=True)
subprocess.run([sys.executable,str(s/'complete-preparation.py')],check=True)
