"""Scoped update of the current API-Key docs. Do not use the old HMAC generator."""
import copy,hashlib,json,zipfile
from pathlib import Path
root=Path(__file__).resolve().parents[1]; pub=root/'public';dl=pub/'downloads'
version='lookup-round-stop-20261016-rc.1';prefix='/api/v1/open/name-lookups'; prep_id='00000000-0000-4000-8000-000000000001'
def read(p):return json.loads(p.read_text())
def write(p,v):p.write_text(json.dumps(v,ensure_ascii=False,indent=2)+'\n')
r=read(pub/'api-reference.json');s=read(pub/'openapi.json')
python='''import requests

api_key = "填入平台给你的Key"
preparation_id = "填入启动prepare返回的preparationId"
r = requests.post(
    "http://47.98.127.132/api/v1/open/name-lookups/stop",
    headers={"X-API-Key": api_key, "Idempotency-Key": "stop-" + preparation_id},
    json={"preparationId": preparation_id}, timeout=30, allow_redirects=False)
print(r.status_code, r.json())
# stopping：每5秒用同一个请求继续读取；stopped：这一轮已结束。
# 网络超时也复用这个 preparationId 和 Idempotency-Key，不创建新轮次。'''
node='''const preparationId = '填入prepare返回的preparationId';
const response = await fetch('http://47.98.127.132/api/v1/open/name-lookups/stop', {
  method: 'POST', redirect: 'error', signal: AbortSignal.timeout(30000),
  headers: {'X-API-Key': process.env.API_KEY, 'Content-Type': 'application/json',
    'Idempotency-Key': 'stop-' + preparationId},
  body: JSON.stringify({preparationId})
});
console.log(response.status, await response.json());
// stopping时每5秒重复原请求，直到stopped；超时也不要换ID或请求键。'''
desc='结束同一API Key所属客户的本轮准备和查询。停止探测与分配、取消排队，运行中的手机等停止确认；已完成结果保留。只在stopped:true后使用新准备键开始下一轮。'
errors={'invalid_idempotency_key':400,'stop_body_requires_preparation_id':400,'invalid_preparation_id':400,'invalid_lookup_api_key':401,'managed_lookup_not_authorized':403,'lookup_preparation_not_found':404,'idempotency_conflict':409,'lookup_stop_key_limit':429,'lookup_storage_unavailable':503}
e=copy.deepcopy(next(e for e in r['endpoints'] if e.get('async')=='prepare'))
e.update(id='post-api-v1-open-name-lookups-stop',path=prefix+'/stop',title='结束本轮任务',description=desc,**{'async':'stop'},parameters=[{'name':'preparationId','location':'body','type':'string','required':True,'description':'启动prepare响应中的编号；用于限定要结束的轮次，旧请求不会误停新一轮。'}],example={'preparationId':prep_id},response='ok、preparationId、status、stopped',responseExample={'ok':True,'preparationId':prep_id,'status':'stopped','stopped':True},responseFields=[{'name':'ok','type':'boolean','description':'请求受理成功'},{'name':'preparationId','type':'string','description':'本次结束的准备轮次编号'},{'name':'status','type':'string','description':'stopping等待停止确认；stopped本轮已结束'},{'name':'stopped','type':'boolean','description':'只有true才代表停止确认完成'}],errors=list(errors),errorStatuses={k:[v] for k,v in errors.items()},httpExamples={'Python':python,'Node.js':node})
r['endpoints']=[x for x in r['endpoints'] if x['path']!=prefix+'/stop'];r['endpoints'].append(e)
p=next(x for x in r['endpoints'] if x.get('async')=='prepare');p['errorStatuses']['lookup_round_stopping']=[409]
if 'lookup_round_stopping' not in p['errors']:p['errors'].append('lookup_round_stopping')
for f in p['responseFields']:
 if f['name']=='status':f['description']='preparing、ready、expired、stopping、stopped；主动结束后不会自动重启。'
for g in r['guides']:
 for sec in g.get('sections',[]):
  sec['title']=sec['title'].replace('下面三个接口','下面四个接口')
  sec['paragraphs']=[x.replace('两个POST的','三个POST的').replace('Key只支持准备、提交、获取结果三个接口','Key只支持准备、提交、获取结果、结束本轮四个接口') for x in sec.get('paragraphs',[])]
  if g['id']=='lookup-flow' and 'table' in sec and '自己接HTTP' in sec['title']:
   rows=sec['table']['rows'];rows[:]=[x for x in rows if not x[0].startswith('4 ')];rows.append(['4 结束本轮（按需）','POST '+prefix+'/stop','发preparationId；等stopped:true；下次启动换准备键'])
  if g['id']=='lookup-auth' and '请求编号' in sec['title']:
   sec['paragraphs']=['三个POST分别使用准备键、提交键、停止键。停止键建议为stop-加preparationId；同一轮重复停止始终使用同一个键。GET不用请求键。']
  if g['id']=='lookup-http' and sec['title']=='等到 ready:true':
   sec['paragraphs']=['保存prepare返回的preparationId，结束本轮时会用到。preparing继续等；ready且ready:true才提交。轮次30分钟有效，轮询不延长；自然expired时换准备键。stopping/stopped代表主动结束，不要自动重新启动。']
  if g['id'] in ('lookup-python','lookup-node') and sec.get('code') and ('def query_name' in sec['code'] or 'async function' in sec['code']):
   sec['code']=(dl/('lookup.py' if g['id']=='lookup-python' else 'lookup.mjs')).read_text()
 if g['id']=='lookup-http':
  g['title']='HTTP · 完整调用流程';g['sections']=[x for x in g['sections'] if not x['title'].startswith('4. 结束本轮')]
  g['sections'].append({'title':'4. 结束本轮（按需调用）','paragraphs':[desc,'stopping时每5秒重复相同停止请求；手机离线尚未确认停止时会保持stopping，不冒充已完成。此时新启动返回409 lookup_round_stopping。','收到stopped后使用新的prepare幂等键启动，再等ready:true。老停止请求重试只返回老轮次状态，不会结束新一轮。','取消的查询GET返回failed和code:lookup_round_stopped，不能当作没有姓名。停止与结果同时到达时，已收到的完整结果保留。'], 'language':'Python · 普通HTTP','code':python,'links':[{'label':'结束接口参数与响应 →','href':'#post-api-v1-open-name-lookups-stop','download':False},{'label':'下载自动等待停止的stop_lookup.py','href':'./downloads/stop_lookup.py','download':True}]})
 if g['id']=='lookup-retries':
  sec=next(x for x in g['sections'] if x['title']=='出现这些情况怎么处理');rows=sec['table']['rows'];rows[:]=[x for x in rows if 'lookup_round_stop' not in x[0]]
  rows.extend([['409 / lookup_round_stopping','继续用原preparationId和停止键等stopped，不创建新轮次'],['failed / lookup_round_stopped','本轮主动结束导致取消，不是没有姓名；保留已完成结果']])
  for sec in g['sections']:
   if sec['title']=='接入系统要落库的字段':sec['paragraphs']=['保存准备键及preparationId；每个业务保存业务编号、提交键、lookupId、状态和name；停止键建议stop-加preparationId。一个客户统一维护轮次，同一个Key调用结束会停止该客户本轮所有查询，不按单个业务编号结束。']
prep=s['paths'][prefix+'/prepare']['post'];prep['responses']['200']['content']['application/json']['schema']['properties']['status']['enum']=['preparing','ready','expired','stopping','stopped'];prep['x-route-errors']['lookup_round_stopping']=409
op=copy.deepcopy(prep);op.update(operationId=e['id'],summary=e['title'],description=desc)
op['requestBody']={'required':True,'content':{'application/json':{'schema':{'type':'object','required':['preparationId'],'properties':{'preparationId':{'type':'string','minLength':1,'maxLength':80,'pattern':'^[A-Za-z0-9-]+$','description':e['parameters'][0]['description']}},'additionalProperties':False},'example':e['example']}}}
op['x-route-errors']=errors
for code,status,done in [('200','stopped',True),('202','stopping',False)]:
 op['responses'][code]={'description':'停止已确认' if done else '已停止新探测和分配，正在等待运行任务安全停止','content':{'application/json':{'schema':{'type':'object','required':['ok','preparationId','status','stopped'],'properties':{'ok':{'type':'boolean','enum':[True]},'preparationId':{'type':'string'},'status':{'type':'string','enum':[status]},'stopped':{'type':'boolean','enum':[done]}},'additionalProperties':False},'example':{'ok':True,'preparationId':prep_id,'status':status,'stopped':done}}}}
for code in ['400','401','403','404','409','429','503']:
 op['responses'][code]['content']['application/json']['example']={'ok':False,'code':next(k for k,v in errors.items() if v==int(code))}
s['paths'][prefix+'/stop']={'post':op}
r['version']=version;r['updatedAt']='2026-10-16';r['routerSha256']=hashlib.sha256((root/'server/index.mjs').read_bytes()).hexdigest();s['info']['version']=version
write(pub/'api-reference.json',r);write(pub/'openapi.json',s)
mini=copy.deepcopy(s);mini['paths']={k:v for k,v in s['paths'].items() if k in [prefix+'/prepare',prefix+'/tasks',prefix+'/tasks/{lookupId}',prefix+'/stop']};write(dl/'name-lookup-openapi.json',mini)
p=pub/'api-docs.js';p.write_text(p.read_text().replace('三个HTTP接口','四个HTTP接口'))
p=dl/'name-lookup-http-guide.md';text=p.read_text().split('\n## 结束本轮任务')[0].replace('三个普通 HTTP 接口','四个普通 HTTP 接口').replace('上述三个接口','上述查名接口')
text+='''
## 结束本轮任务

保存启动接口响应中的 `preparationId`。同一个 API Key 调用下面接口：

```http
POST /api/v1/open/name-lookups/stop
X-API-Key: <API_KEY>
Idempotency-Key: stop-<preparationId>
Content-Type: application/json

{"preparationId":"启动返回的preparationId"}
```

```json
{"ok":true,"preparationId":"原准备编号","status":"stopping","stopped":false}
```

HTTP 202 表示已经停止探测和新分配、排队已取消，正在等待手机停止确认。每5秒重复同一个请求；不要换轮次或停止键。网络超时也复用原请求。

```json
{"ok":true,"preparationId":"原准备编号","status":"stopped","stopped":true}
```

HTTP 200 且 `stopped:true` 才确认本轮结束。若手机离线、尚未确认停止，仍返回 stopping；新 prepare 键此时返回409 `lookup_round_stopping`。已完成结果继续按原 lookupId 获取；取消的查询返回 failed / lookup_round_stopped，不代表没有姓名。停止与结果同时到达时，已收到的结果保留。

下一轮：确认 stopped 后生成新的准备键，再调用 prepare 等到 ready:true。重试旧停止请求不会停掉新一轮。一个客户统一维护轮次；结束影响该客户本轮全部查询，不影响其他客户和非查名手机。

运行 `python stop_lookup.py`，输入同一个 API Key 和 preparationId。代码只用 requests，最多等待120秒；超时后再次运行并输入同一 preparationId，继续确认停止。**不要自动把停止当成过期并重启。**

```python
'''+python+'\n```\n'
p.write_text(text)
files={'README.md':p,'lookup.py':dl/'lookup.py','lookup.mjs':dl/'lookup.mjs','stop_lookup.py':dl/'stop_lookup.py','openapi.json':dl/'name-lookup-openapi.json'}
zpath=dl/'name-lookup-integration.zip'
with zipfile.ZipFile(zpath,'w',zipfile.ZIP_DEFLATED) as z:
 for name,path in files.items():
  info=zipfile.ZipInfo(name,(2026,10,16,0,0,0));info.external_attr=0o100644<<16;info.compress_type=zipfile.ZIP_DEFLATED;z.writestr(info,path.read_bytes())
write(dl/'name-lookup-sha256.json',{'version':version,'files':{name:hashlib.sha256(p.read_bytes()).hexdigest() for name,p in files.items()},'zipSha256':hashlib.sha256(zpath.read_bytes()).hexdigest()})
print(json.dumps({'endpoints':len(r['endpoints']),'lookupEndpoints':len(mini['paths']),'bundleFiles':list(files)}))
