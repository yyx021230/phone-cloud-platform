"""Bounded external-HTTP verification; credentials/results stay outside Git."""
import argparse, collections, datetime, json, os, re, time, urllib.request, urllib.error
from pathlib import Path

BASE='http://47.98.127.132/api/v1/open/name-lookups'

def main():
    p=argparse.ArgumentParser()
    p.add_argument('--state',required=True);p.add_argument('--credential-document',required=True)
    p.add_argument('--limit',type=int,default=2);p.add_argument('--prepare',action='store_true')
    a=p.parse_args();assert 0<=a.limit<=50
    os.umask(0o077);path=Path(a.state);s=json.loads(path.read_text())
    blocks=re.findall(r'```[^\n]*\n(.*?)```',Path(a.credential_document).read_text(),re.S)
    keys=[b.strip() for b in blocks if re.fullmatch(r'[A-Za-z0-9_.-]{32,200}',b.strip())]
    assert len(keys)==1,'Expected exactly one credential block'
    key=keys[0]
    def save():
        temp=path.with_suffix('.tmp')
        with temp.open('w') as f:
            json.dump(s,f,ensure_ascii=False,indent=2);f.flush();os.fsync(f.fileno())
        temp.replace(path)
    def call(method,route,body=None,idem=None):
        headers={'X-API-Key':key,'Content-Type':'application/json'}
        if idem:headers['Idempotency-Key']=idem
        req=urllib.request.Request(BASE+route,data=json.dumps(body).encode() if body is not None else None,headers=headers,method=method)
        class NoRedirect(urllib.request.HTTPRedirectHandler):
            def redirect_request(self,*args):return None
        opener=urllib.request.build_opener(NoRedirect)
        try:r=opener.open(req,timeout=25)
        except urllib.error.HTTPError as e:r=e
        with r:
            data=r.read(100000);value=json.loads(data)
            assert isinstance(value,dict)
            return r.code,value
    if a.prepare:
        code,value=call('POST','/prepare',{},s['prepareKey'])
        s['prepareResponse']=value;s['prepareHttp']=code;s['prepareObservedAt']=time.time();save()
        print(json.dumps({'http':code,'status':value.get('status'),'ready':value.get('ready'),'accepting':value.get('acceptingRequests'),'code':value.get('code'),'preparationId':value.get('preparationId')}));return
    errors=[]
    for row in s['rows']:
        if row.get('lookupId') and row.get('status') not in ['completed','failed']:
            code,v=call('GET','/tasks/'+row['lookupId']);row['lastHttp']=code
            if code==200 and v.get('lookupId')==row['lookupId']:
                row['status']=v.get('status');row['response']=v;row['observedAt']=time.time()
                if row['status']=='completed':
                    assert v.get('ok') is True and isinstance(v.get('name'),str)
                    row['name']=v['name'];row['matchesPrevious']=v['name']==row['previousName']
            else:errors.append({'index':row['index'],'http':code,'code':v.get('code')})
            save()
    active=sum(bool(r.get('lookupId')) and r.get('status') not in ['completed','failed'] for r in s['rows'])
    for row in s['rows'][:a.limit]:
        if row.get('lookupId'):continue
        if active>=20:break
        if time.time()<s.get('pauseUntil',0):break
        row['submitAttemptAt']=time.time();save()
        code,v=call('POST','/tasks',{'phoneNumber':row['phone']},row['key']);row['lastHttp']=code
        if code in (200,202) and v.get('lookupId'):
            row.update(lookupId=v['lookupId'],status=v.get('status'),response=v,submittedAt=time.time(),reusedPrevious=v['lookupId']==row['previousId'])
            if v.get('status')=='completed':row['name']=v.get('name','');row['matchesPrevious']=row['name']==row['previousName']
            else:active+=1
        else:
            errors.append({'index':row['index'],'http':code,'code':v.get('code')})
            s['pauseUntil']=time.time()+max(10,int(v.get('retryAfterSeconds') or 10))
            save();break
        save()
    done=[r for r in s['rows'] if r.get('status')=='completed']
    summary={'at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'submitted':sum(bool(r.get('lookupId')) for r in s['rows']),'statuses':dict(collections.Counter(r.get('status','not_submitted') for r in s['rows'])),'names':sum(bool(r.get('name')) for r in done),'empty':sum(not r.get('name') for r in done),'mismatches':[r['index'] for r in done if not r.get('matchesPrevious')],'reusedPrevious':sum(r.get('reusedPrevious',False) for r in s['rows']),'errors':errors}
    s['summary']=summary;save();print(json.dumps(summary))

if __name__=='__main__':
    try:main()
    except Exception as e:
        print(json.dumps({'errorType':type(e).__name__,'action':'Keep original state and keys; investigate before retry'}));raise SystemExit(1)
