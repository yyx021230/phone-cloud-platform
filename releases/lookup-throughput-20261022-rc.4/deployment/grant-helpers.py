import pathlib,json,subprocess,os,time
os.umask(0o077);stage=pathlib.Path(__file__).resolve().parent;rows=json.loads((stage/'HELPER_GRANTS.json').read_text())['users']
def node(s):return json.loads(subprocess.check_output(['docker','exec','-i','phone-cloud-platform','node','--input-type=module'],input=s,text=True))
common="const api=async(p,options={})=>{const r=await fetch('http://127.0.0.1:8787'+p,{...options,headers:{Authorization:'Bearer '+process.env.ADMIN_API_TOKEN,'Content-Type':'application/json'}});if(!r.ok)throw Error(p+':'+r.status);return r.json()};"
users=node(common+"console.log(JSON.stringify((await api('/api/v1/users')).users));")
selected=[]
for row in rows:
 found=[u for u in users if u['userId']==row['userId']];assert len(found)==1;u=found[0]
 assert u['username']==row['username'] and u['displayName']==row['displayName'] and u['role']==row['expectedRole'] and u['enabled']==row['expectedEnabled']
 selected.append({k:u.get(k) for k in ['userId','username','displayName','role','enabled','lookupHumanControl']})
backup=stage/'rollback/helper-capabilities.before.json';assert not backup.exists();backup.write_text(json.dumps(selected,ensure_ascii=False,indent=2)+'\n')
result=node(common+'const rows='+json.dumps(selected)+';const applied=[];for(const u of rows){if(u.lookupHumanControl!==true)await api("/api/v1/users/"+u.userId,{method:"PUT",body:JSON.stringify({lookupHumanControl:true})});applied.push(u.userId);}const users=(await api("/api/v1/users")).users;for(const u of rows){const v=users.find(x=>x.userId===u.userId);if(!v||v.lookupHumanControl!==true||v.role!==u.role||v.enabled!==u.enabled||v.username!==u.username)throw Error("helper verify")}console.log(JSON.stringify({userIds:applied,count:applied.length,lookupHumanControl:true,rolesUnchanged:true}));')
result['atUtc']=time.strftime('%Y-%m-%dT%H:%M:%SZ',time.gmtime());result['backup']=str(backup);(stage/'HELPER_GRANTED.json').write_text(json.dumps(result,indent=2)+'\n');print(json.dumps({'helperGranted':result['count'],'rolesUnchanged':True}))
