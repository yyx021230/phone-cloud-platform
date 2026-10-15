# coding: utf-8
"""Build platform reference, OpenAPI and deterministic prepared lookup SDK ZIP."""
from pathlib import Path
import json, copy, hashlib, zipfile
root=Path(__file__).resolve().parent.parent
public=root/'public'; downloads=public/'downloads'; sdk=root/'sdk/open_name_lookup'
version='lookup-readiness-20261015-rc.12'; router=(root/'server/index.mjs').read_text()
prepare='/api/v1/open/name-lookups/prepare'; post='/api/v1/open/name-lookups/tasks'; get=post+'/{lookupId}'
assert prepare in router and post in router and 'getAsyncResult' in router
def write(p,x): p.write_text(json.dumps(x,ensure_ascii=False,indent=2)+'\n')
d=json.loads((public/'api-reference.json').read_text())
d.update(version=version,updatedAt='2026-10-15',status='本地候选，尚未上线；上线与真机验收以同版本回执为准',routerSha256=hashlib.sha256(router.encode()).hexdigest())
d['endpoints']=[e for e in d['endpoints'] if e.get('async') not in ('prepare','submit','result')]
auth=next(e for e in d['endpoints'] if e['auth']=='hmac')['errorStatuses']
http_errors={'invalid_lookup_phone':400,'prepare_body_must_be_empty':400,'idempotency_key_required':400,'invalid_idempotency_key':400,'managed_lookup_not_authorized':403,'managed_lookup_not_enabled':404,'lookup_task_not_found':404,'idempotency_conflict':409,'lookup_preparation_expired':409,'lookup_queue_full':429,'lookup_inflight_limit':429,'lookup_duplicate_limit':429,'lookup_preparation_key_limit':429,'lookup_pool_disabled':503,'lookup_storage_unavailable':503,'lookup_outcome_unknown':503,'lookup_not_ready':503,'lookup_probe_not_configured':503,'lookup_preparation_capacity':503}
http_errors.update({k:v[0] for k,v in auth.items() if k.startswith(('invalid_open','open_api'))})
base={'group':'lookup-user','auth':'hmac','managed':True,'scope':'同clientId及显式设备池授权；所有操作均须HMAC','errors':list(http_errors),'errorStatuses':{k:[v] for k,v in http_errors.items()},'line':router[:router.index('const asyncLookupResultMatch')].count('\n')+1}
p={**base,'id':'post-api-v1-open-name-lookups-prepare','method':'POST','path':prepare,'title':'启动查名准备 / 读取准备状态','description':'body为{}；同准备键轮询复用原轮次。仅ready:true且status:ready代表可提交手机号；不返回设备数量。固定30分钟租期；重复读取不续期。新轮次使用新准备键。','async':'prepare','idempotency':'required','parameters':[],'successCodes':[200],'response':'ok,preparationId,status,ready,expiresAt','example':{},'responseExample':{'ok':True,'preparationId':'00000000-0000-4000-8000-000000000001','status':'ready','ready':True,'expiresAt':'2026-10-15T10:30:00.000Z'}}
p.update(errors=[e for e in p['errors'] if e!='lookup_inflight_limit'],errorStatuses={k:v for k,v in p['errorStatuses'].items() if k!='lookup_inflight_limit'})
a={**base,'id':'post-api-v1-open-name-lookups-tasks','method':'POST','path':post,'title':'提交支付宝查名','description':'准备就绪后只传phoneNumber，保存返回lookupId；同客户同号码在途换键仍复用原任务。同一clientId最多5条未完成业务；超出返回429 lookup_inflight_limit且不建任务。重复请求先防重，不额外占位。未准备就绪时拒绝新受理，原任务读取/防重继续。','async':'submit','idempotency':'required','parameters':[{'name':'phoneNumber','location':'body','type':'string','required':True,'description':'11位手机号；不传设备/账号'}],'successCodes':[200,202],'response':'ok,lookupId,status,reused','example':{'phoneNumber':'13800000000'},'responseExample':{'ok':True,'lookupId':'00000000-0000-4000-8000-000000000002','status':'queued','reused':False}}
b={**base,'id':'get-api-v1-open-name-lookups-tasks-lookupId','method':'GET','path':get,'title':'获取支付宝查名结果','description':'逐号码独立完成。启动模式completed返回name，姓名或空字符串（包含未实名）。queued/processing没有name，执行失败为failed/code没有name，不写成空姓名。未调用prepare的老客户端保留原五态契约。','async':'result','idempotency':'none','parameters':[{'name':'lookupId','location':'path','type':'string','required':True,'description':'提交返回的原lookupId'}],'successCodes':[200],'response':'completed:ok,lookupId,status,name；处理中无name；failed:ok=false,lookupId,status,code','example':{},'responseExample':{'ok':True,'lookupId':'00000000-0000-4000-8000-000000000002','status':'completed','name':'**某'}}
result_errors={k:v for k,v in http_errors.items() if k in ['managed_lookup_not_authorized','managed_lookup_not_enabled','lookup_task_not_found','lookup_storage_unavailable'] or k.startswith(('invalid_open','open_api'))}
b.update(errors=list(result_errors),errorStatuses={k:[v] for k,v in result_errors.items()})
i=next(i for i,e in enumerate(d['endpoints']) if e['auth']=='hmac');d['endpoints'][i:i]=[p,a,b]
g=next(g for g in d['guides'] if g['id']=='lookup-flow')
g.update(title='支付宝查名接入流程',intro='启动准备 → 提交手机号 → 按原lookupId获取姓名',headings=['启动准备','提交和读取','超时防重','内部调度','验收边界'],paragraphs=[
 '调用POST /api/v1/open/name-lookups/prepare，body为{}，保存准备键并每5秒用同键读取；ready:true即可提交手机号，设备数量及调度由平台内部管理。每轮固定30分钟；过期后保存新准备键重新准备。探测号码由平台配置，不由调用方传入。',
 '每个clientId可同时提交5个单号码请求，运行与排队合计最多5条未完成业务；第6个新号码返回429 lookup_inflight_limit，不创建任务，等已有任务完成后用原业务键重试。重复号码/请求键先复用原任务、不额外占位。POST /api/v1/open/name-lookups/tasks只传phoneNumber并保存lookupId；另一独立任务GET /tasks/{lookupId}。每个号码完成就返回，只有status=completed才将name写入业务系统；name可以是姓名或空字符串，未实名归空。queued/processing不写空值；failed及HTTP错误是服务异常，不是假无姓名。',
 '首次提交前持久保存Idempotency-Key；网络重试复用原键，每次Nonce/签名更新。对方等2分钟换键重提同客户同手机号仍返回原lookupId。成功有/无姓名固定10分钟复用；GET和重提不延长期限。每任务最多50个新别名，队列30分钟，总预算60分钟，人工等待30分钟，冷却8小时；离线执行未知时继续对账，不盲目重派。',
 '只分配已探测且凭据有效的手机。确认触限先持久冷却、结束旧执行，再把原号码转到另一台已就绪手机，lookupId不变；原手机后台切号探测，通过后重入池。无可用手机则排队；执行是否完成不明时保留原任务对账，避免重复。业务与探测合计最多5路，单机异常不阻断其他正常手机。',
 '当前是本地候选；本地HTTP/PostgreSQL与模拟设备验证不能替代真机验收。平台上线后配置已授权已知有姓名的探测号，完成真机灰度后再交接。云端与Agent须配套更新；旧客户端未调用prepare时保持旧契约。'],sections=[{'title':'Node.js','language':'Node.js','code':'const ready = await client.prepareLookup({idempotencyKey: savedPreparationKey});\n// 同准备键每5秒重试，ready.ready为true后提交\nconst accepted = await client.submitLookup("13800000000", {idempotencyKey: savedBusinessKey});\nconst result = await client.getLookupResult(accepted.lookupId);\nif (result.status === "completed") saveName(result.name);'},{'title':'Python','language':'Python','code':'ready = client.prepare_lookup(idempotency_key=saved_preparation_key)\n# ready["ready"]为True后提交；持久保存两个键和lookupId\naccepted = client.submit_lookup("13800000000", idempotency_key=saved_business_key)\nresult = client.get_lookup_result(accepted["lookupId"])\nif result["status"] == "completed":\n    save_name(result["name"])'}])
for guide in d['guides']:
 if guide['id']=='lookup-legacy': guide['paragraphs'][0]='旧7个会话接口及同步query仅兼容。新合作系统使用启动准备、提交和获取；未调用prepare的老客户端保留原响应，不能混用两种结果解析。'
 if guide['id']=='overview': guide['paragraphs'][1]='本地候选新增启动准备：ready:true后可接单，设备数量及调度由平台内部管理，手机号自动分配；候选尚未发布。其他平台功能按原分类列出。'
 if guide['id']=='authentication': guide['paragraphs'][4]='POST prepare/tasks/query须Idempotency-Key；GET tasks/{lookupId}也须HMAC。准备键与业务键分开持久保存；每次请求更新Nonce和签名。'
 if guide['id']=='states': guide.update(intro='启动模式与旧兼容模式分别处理');guide['paragraphs'][0]='启动模式queued/processing不包含name，completed只返回姓名或空字符串，failed返回ok:false及code、不含name；任务结果读取HTTP200，HTTP认证/网络错误另行处理。未调用prepare的老客户端保持queued/processing/succeeded/not_found/failed。'
 if guide['id']=='handover': guide.update(intro='接入包与交付检查',paragraphs=['11个HMAC操作：启动准备+提交+结果、原同步及7个会话兼容操作。下载含OpenAPI、Node/Python SDK、签名、partner_example.py及校验清单。','管理员另行交付HTTP BASE_URL/clientId/secret及用途授权；不在文档保存真实凭据、探测号码。','不新增数据库迁移；保留请求别名、结果与冷却。准备证明遇服务/Agent重启或账号变化失效，重新探测，读取原结果不受影响。','本地候选尚未上线；依据同版本回执判断实际验证范围，不宣称五台真机或永不出错。'],sections=[])
for k,v in http_errors.items():
 if not any(k in row[1].split(' / ') for row in d['commonErrors']):d['commonErrors'].append([v,k,'原业务身份保留；准备/读取失败不代表无姓名。'])
write(public/'api-reference.json',d)
o=json.loads((public/'openapi.json').read_text());o['info'].update(version=version,description='本地候选未部署：prepare返回ready表示就绪，tasks提交手机号，GET按单号返回姓名或空字符串；旧接口兼容。')
headers=copy.deepcopy(o['paths']['/api/v1/open/name-lookups/devices']['get']['parameters'])
idem={'name':'Idempotency-Key','in':'header','required':True,'schema':{'type':'string','minLength':8,'maxLength':160,'pattern':'^[A-Za-z0-9._:-]+$'},'description':'首次发送前持久保存；准备键与业务键分开，重试复用原键'}
identifier={'type':'string','format':'uuid'}
def obj(props):return {'type':'object','required':list(props),'properties':props,'additionalProperties':False}
def enum(*values):return {'type':'string','enum':list(values)}
preparedSchema=obj({'ok':{'type':'boolean','enum':[True]},'preparationId':identifier,'status':enum('preparing','ready','expired'),'ready':{'type':'boolean'},'expiresAt':{'type':'string','format':'date-time'}})
postSchema=obj({'ok':{'type':'boolean','enum':[True]},'lookupId':identifier,'status':enum('queued','processing','completed','succeeded','not_found','failed'),'reused':{'type':'boolean'}})
common={'ok':{'type':'boolean','enum':[True]},'lookupId':identifier}
getSchema={'oneOf':[obj({**common,'status':enum('queued','processing')}),obj({**common,'status':enum('completed'),'name':{'type':'string','description':'页面姓名或空字符串；未实名属于空字符串'}}),obj({'ok':{'type':'boolean','enum':[False]},'lookupId':identifier,'status':enum('failed'),'code':{'type':'string'}}),obj({**common,'status':enum('queued','processing','succeeded','not_found','failed'),'name':{'type':'string'},'code':{'type':'string'}})]}
errorSchema=obj({'ok':{'type':'boolean','enum':[False]},'code':{'type':'string'}})
def response(description,schema,example):return {'description':description,'content':{'application/json':{'schema':schema,'example':example}}}
for endpoint,schema in [(p,preparedSchema),(a,postSchema),(b,getSchema)]:
 responses={str(code):response('成功读取准备/受理/结果，按status处理',schema,endpoint['responseExample']) for code in endpoint['successCodes']}
 route_errors={k:statuses[0] for k,statuses in endpoint['errorStatuses'].items()}
 for code in sorted(set(route_errors.values())):responses[str(code)]=response('HTTP请求失败，保留原任务身份',errorSchema,{'ok':False,'code':next(k for k,v in route_errors.items() if v==code)})
 operation={'operationId':endpoint['id'],'summary':endpoint['title'],'description':endpoint['description'],'tags':['lookup-user'],'security':[{'HmacSignature':[]}],'parameters':headers+([idem] if endpoint is not b else [{'name':'lookupId','in':'path','required':True,'schema':identifier}]),'responses':responses,'x-local-candidate':True,'x-route-errors':route_errors}
 if endpoint is not b:operation['requestBody']={'required':True,'content':{'application/json':{'schema':obj({}) if endpoint is p else obj({'phoneNumber':{'type':'string','pattern':'^1[3-9][0-9]{9}$'}}),'example':endpoint['example']}}}
 o['paths'][endpoint['path']]={endpoint['method'].lower():operation}
write(public/'openapi.json',o);small=copy.deepcopy(o);small['paths']={k:v for k,v in o['paths'].items() if k.startswith('/api/v1/open/name-lookups/')}
assert sum(len(v) for v in small['paths'].values())==11
write(downloads/'name-lookup-openapi.json',small)
files={name:(sdk/name).read_bytes() for name in ['PARTNER_HANDOFF.md','partner_example.py','README.md','node_client.mjs','python_client.py']}
files.update({'OPEN_NAME_LOOKUP_API.md':(root/'OPEN_NAME_LOOKUP_API.md').read_bytes(),'sign.mjs':(downloads/'sign.mjs').read_bytes(),'openapi.json':(downloads/'name-lookup-openapi.json').read_bytes()})
checks={k:hashlib.sha256(v).hexdigest() for k,v in files.items()};files['SHA256.json']=(json.dumps(checks,indent=2)+'\n').encode()
with zipfile.ZipFile(downloads/'name-lookup-integration.zip','w',compression=zipfile.ZIP_DEFLATED) as z:
 for name,content in sorted(files.items()):
  info=zipfile.ZipInfo(name,(2026,10,15,0,0,0));info.compress_type=zipfile.ZIP_DEFLATED;info.external_attr=0o100644<<16;z.writestr(info,content)
write(downloads/'name-lookup-sha256.json',{'version':version,'status':'local-candidate-not-deployed','files':checks,'zipSha256':hashlib.sha256((downloads/'name-lookup-integration.zip').read_bytes()).hexdigest()})
print(f'{len(d["endpoints"])} platform operations / 11 HMAC; deterministic prepared SDK bundle')
