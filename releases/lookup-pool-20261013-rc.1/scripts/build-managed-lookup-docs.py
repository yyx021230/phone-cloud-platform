"""Update only this candidate's static reference and reproducible integration ZIP."""
from pathlib import Path
import json,copy,hashlib,zipfile
root=Path(__file__).resolve().parent.parent
public=root/'public';downloads=public/'downloads';sdk=root/'sdk/open_name_lookup'
version='lookup-pool-20261013-rc.1'
path='/api/v1/open/name-lookups/query'
router=(root/'server/index.mjs').read_text()
assert path in router and 'managedLookup.wait' in router

def write_json(file,value): file.write_text(json.dumps(value,ensure_ascii=False,indent=2)+'\n')
d=json.loads((public/'api-reference.json').read_text())
d.update(version=version,updatedAt='2026-10-13',status='本地候选，统一设备池接口未上线；旧接口保留',routerSha256=hashlib.sha256(router.encode()).hexdigest())
next(g for g in d['guides'] if g['id']=='overview')['paragraphs'][1]='新增统一设备池同步查名是本地候选，尚未上线；原平台接口来自历史已部署快照。仅更新候选文档，不扩展生产权限。示例使用合成号码及占位符。'
errors={'invalid_idempotency_key':400,'invalid_lookup_phone':400,'idempotency_key_required':400,'managed_lookup_not_authorized':403,'managed_lookup_not_enabled':404,'idempotency_conflict':409,'lookup_queue_full':429,'lookup_waiter_limit':429,'lookup_pool_disabled':503,'lookup_manual_action_pending':503,'lookup_recovery_required':503,'lookup_outcome_unknown':503,'lookup_accounts_cooling':503,'lookup_prepare_failed':503,'lookup_execution_failed':503,'lookup_cancelled':503,'lookup_storage_unavailable':503,'lookup_manual_wait_expired':503,'permission_revoked':403,'lookup_queue_timeout':504,'lookup_timeout':504}
auth_errors=next(e for e in d['endpoints'] if e['auth']=='hmac')['errorStatuses']
errors.update({k:v[0] for k,v in auth_errors.items() if k!='open_name_lookup_api_not_enabled'})
e={'method':'POST','path':path,'id':'post-api-v1-open-name-lookups-query','group':'lookup-user','title':'传号码直接查名字（设备池）','description':'本地候选：只传号码，平台从49台登记手机中统一分配，自动执行最多5台。本次HTTP直接等待并返回页面显示姓名；无需deviceId/sessionId/queryId。','auth':'hmac','managed':True,'parameters':[{'name':'phoneNumber','location':'body','type':'string','required':True,'description':'中国大陆11位手机号；示例为合成号码'}],'errors':list(errors),'errorStatuses':{k:[v] for k,v in errors.items()},'successCodes':[200],'scope':'管理员显式设备池授权','idempotency':'required','response':'ok:boolean,name:string','example':{'phoneNumber':'13800000000'},'responseExample':{'ok':True,'name':'**某'},'line':router[:router.index(path)].count('\n')+1}
d['endpoints']=[x for x in d['endpoints'] if x['path']!=path]
i=next(i for i,x in enumerate(d['endpoints']) if x['auth']=='hmac');d['endpoints'].insert(i,e)
if not any(g['id']=='lookup-legacy' for g in d['guides']):
 old=copy.deepcopy(next(g for g in d['guides'] if g['id']=='lookup-flow'));old.update(id='lookup-legacy',title='旧会话模式（兼容）');old['paragraphs'].insert(0,'以下是原有7接口的单设备会话模式，仅供既有接入兼容。新接入请使用设备池同步入口。');old.pop('headings',None);d['guides'].append(old)
g=next(g for g in d['guides'] if g['id']=='lookup-flow')
g.update(title='查名接入流程',intro='传号码，一次调用返回名字',headings=['接口与返回','认证由SDK处理','超时与同键重试','异常由平台接续','候选验证边界'],paragraphs=[
 '本地候选新增POST /api/v1/open/name-lookups/query，请求体只有phoneNumber。查到返回HTTP200 {ok:true,name:"**某"}；明确未查到返回HTTP200 {ok:true,name:"",code:"not_found"}。name保持支付宝页面实际显示的脱敏形态，不承诺完整实名。内部ID、选手机、会话、切号和冷却均不交给调用方管理。',
 '使用独立HMAC凭据及管理员显式设备池授权。SDK自动签名并生成幂等键；实际业务先持久保存业务键，再调用lookupName/lookup_name。用途引用由管理员在平台为客户端登记，不要求每个调用额外填写。旧deviceIds白名单只作用于原7接口，不自动授权设备池。',
 '默认服务端等待120秒，可配置上限180秒；新SDK单次HTTP等待190秒，代理读超时建议210秒。一次逻辑调用最多自动重试1次网络错误，沿用原键、每次更新Nonce/签名。504、断网或503不等于没执行；后续用原键和原号码重试，不能换键重查。首次新调用生成新键，SDK不会替业务保存键。',
 '平台统一排队、同客户端会话短时复用，自动执行（含准备/切号/恢复/停止/未知）最高5台。拼图由平台通知人工并接回原任务；普通恢复、取消和未知任务对账由内部管理员处理。已开始或执行事实未知的查询不自动换手机重查；仅准备阶段确定失败允许换另一台1次。所有账户冷却时不派新号码。',
 '仅完成隔离HTTP/fake Agent、临时PostgreSQL和本地页面验证，没有连接生产或操作真机。49个编号是纳管清单，需逐台唯一绑定稳定deviceId并检查Agent配套能力；不是49台已验收在线。发布前还需单机、两机、五机、真实代理超时与OEM验收。'],sections=[{'title':'Node.js最小调用','language':'Node.js','code':'const result = await client.lookupName("13800000000", {idempotencyKey: savedBusinessKey});\nconsole.log(result.name); // 示例号码为合成；同业务重试保留savedBusinessKey'},{'title':'Python最小调用','language':'Python','code':'result = client.lookup_name("13800000000", idempotency_key=saved_business_key)\nprint(result["name"])'},{'title':'兼容接口','paragraphs':['原7个会话接口和SDK方法保持，供既有系统继续使用；新设备池接口不返回202，不要求轮询或主动结束手机。']}])
a=next(g for g in d['guides'] if g['id']=='authentication');a['paragraphs'][4]='同步设备池POST query必须带Idempotency-Key，同客户端同键同号码重放原结果，不同号码409。旧创建/提交/恢复仍分别沿用原幂等作用域。所有网络重试保留键和号码，更新时间戳/Nonce/签名。'
s=next(g for g in d['guides'] if g['id']=='states');s['intro']='设备池同步响应与旧会话状态分别处理';s['paragraphs']=[v for v in s['paragraphs'] if not v.startswith('设备池成功直接返回')];s['paragraphs'].insert(0,'设备池成功直接返回ok/name；未查到为code=not_found。400修输入，401修签名，403核对授权，409键冲突，429按Retry-After退避，503表示人工/恢复/未知等原因，504本次等待到期。503/504后沿用原业务键，内部任务继续对账。下方session/query状态和10–30秒HTTP建议仅针对旧会话模式。');s.pop('headings',None)
h=next(g for g in d['guides'] if g['id']=='handover');h.update(intro='本地候选接入包与灰度验收',paragraphs=['交付物含1个设备池同步接口、原7个兼容接口的OpenAPI、Node/Python SDK、签名示例、说明和校验清单。新接口尚未上线，生产地址目前不能据此认定已开放。','管理员单独交付BASE_URL、clientId和独立secret，登记设备池用途授权与稳定映射。生产凭据及真实号码不会写入文档或包。','本轮只运行本地隔离测试、临时PG事务/重启测试和模拟设备页面，不调用生产、真实手机或飞书。历史单机接口验收不能代替本轮49台设备池验收。','发布前需单机→两机→五机验收、代理长请求、账户自然触限切号/8小时到期、OEM和原投屏影响。新云端与支持managed_lookup_v1的Agent须配套部署；默认开关关闭，迁移仅新增两张表，回退先排空在途任务。'],sections=[])
d['commonErrors'] += [[v,k,'设备池响应字段code；重试保留原业务键，人工/未知由平台处理。'] for k,v in errors.items() if not any(k in row[1].split(' / ') for row in d['commonErrors'])]
write_json(public/'api-reference.json',d)
o=json.loads((public/'openapi.json').read_text());o['info']['version']=version;o['info']['description']='本地候选；新增设备池同步查名未上线，原接口保留。'
headers=copy.deepcopy(o['paths']['/api/v1/open/name-lookups/devices']['get']['parameters'])
headers.append({'name':'Idempotency-Key','in':'header','required':True,'schema':{'type':'string','minLength':8,'maxLength':160,'pattern':'^[A-Za-z0-9._:-]+$'},'description':'同业务重试保留原键；SDK代签名，不代持久化业务键'})
schema={'type':'object','required':['ok','name'],'properties':{'ok':{'type':'boolean'},'name':{'type':'string','description':'页面实际显示的掩码姓名，未查到或错误为空'},'code':{'type':'string','description':'not_found或明确错误原因'}},'additionalProperties':False}
def response(description,example):return {'description':description,'content':{'application/json':{'schema':schema,'example':example}}}
responses={'200':response('本次查询完成或同键原结果重放；not_found表示本次无姓名',{'ok':True,'name':'**某'})}
for status in sorted(set(errors.values())):responses[str(status)]=response('设备池错误；参见x-route-errors，不能按空名字当成功',{'ok':False,'name':'','code':next(k for k,v in errors.items() if v==status)})
o['paths'][path]={'post':{'operationId':e['id'],'summary':e['title'],'description':e['description'],'tags':['lookup-user'],'security':[{'HmacSignature':[]}],'parameters':headers,'requestBody':{'required':True,'content':{'application/json':{'schema':{'type':'object','required':['phoneNumber'],'properties':{'phoneNumber':{'type':'string','pattern':'^1[3-9][0-9]{9}$'}},'additionalProperties':True},'example':e['example']}}},'responses':responses,'x-route-errors':errors,'x-local-candidate':True,'x-default-server-wait-seconds':120,'x-max-server-wait-seconds':180,'x-sdk-timeout-seconds':190}}
write_json(public/'openapi.json',o)
small=copy.deepcopy(o);small['paths']={k:v for k,v in o['paths'].items() if k.startswith('/api/v1/open/name-lookups/')};assert sum(len(v) for v in small['paths'].values())==8
write_json(downloads/'name-lookup-openapi.json',small)
files={'README.md':(sdk/'README.md').read_bytes(),'OPEN_NAME_LOOKUP_API.md':(root/'OPEN_NAME_LOOKUP_API.md').read_bytes(),'node_client.mjs':(sdk/'node_client.mjs').read_bytes(),'python_client.py':(sdk/'python_client.py').read_bytes(),'sign.mjs':(downloads/'sign.mjs').read_bytes(),'openapi.json':(downloads/'name-lookup-openapi.json').read_bytes()}
checks={k:hashlib.sha256(v).hexdigest() for k,v in files.items()};files['SHA256.json']=(json.dumps(checks,indent=2)+'\n').encode()
with zipfile.ZipFile(downloads/'name-lookup-integration.zip','w',compression=zipfile.ZIP_DEFLATED) as z:
 for name,content in sorted(files.items()):
  info=zipfile.ZipInfo(name,(2026,10,13,0,0,0));info.compress_type=zipfile.ZIP_DEFLATED;info.external_attr=0o100644<<16;z.writestr(info,content)
write_json(downloads/'name-lookup-sha256.json',{'version':version,'status':'local-candidate-not-deployed','files':checks,'zipSha256':hashlib.sha256((downloads/'name-lookup-integration.zip').read_bytes()).hexdigest()})
print('Updated40 operations; 8 HMAC operations and reproducible SDK bundle; production untouched')
