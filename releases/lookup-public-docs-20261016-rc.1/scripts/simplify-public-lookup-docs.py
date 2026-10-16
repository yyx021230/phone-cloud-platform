"""Presentation-only partner contract. No runtime route changes."""
import copy
PUBLIC_PATHS={'/api/v1/open/name-lookups/prepare','/api/v1/open/name-lookups/tasks','/api/v1/open/name-lookups/tasks/{lookupId}'}
def simplify(d):
 d['endpoints']=[e for e in d['endpoints'] if e['group']!='lookup-user' or e['path'] in PUBLIC_PATHS]
 titles={'prepare':'启动准备','submit':'提交手机号','result':'获取查询结果'}
 fields={
 'prepare':[('ok','boolean','本次接口是否调用成功。'),('preparationId','string','准备轮次ID。'),('status','string','preparing：准备中；ready：已就绪；expired：轮次已过期。'),('ready','boolean','true 时可以提交手机号。'),('expiresAt','string','本轮准备过期时间。')],
 'submit':[('ok','boolean','是否成功受理。'),('lookupId','string','保存此ID，随后用它获取结果。'),('status','string','queued：排队；processing：处理中；completed：结果已完成，请获取结果。'),('reused','boolean','true 表示复用原任务，没有新增一次查询。')],
 'result':[('ok','boolean','正常读取为true；执行失败为false。'),('lookupId','string','原查询ID。'),('status','string','queued / processing / completed / failed。'),('name','string','仅completed返回；页面显示的姓名（可能带掩码）或空字符串，未实名也是空字符串。'),('code','string','仅failed返回错误原因；失败不是没名字。')]}
 for e in d['endpoints']:
  if e['group']!='lookup-user':continue
  e['title']=titles[e['async']];e['scope']='第三方系统后端调用';e['responseFields']=[dict(name=n,type=t,description=v) for n,t,v in fields[e['async']]]
  e['response']=','.join(f'{n}:{t}' for n,t,_ in fields[e['async']])
  if e['async']=='prepare':e['description']='请求体为{}。用同一个准备键每5秒读取一次，ready:true后即可提交手机号。过期后使用新准备键。'
  elif e['async']=='submit':e['description']='业务参数只传phoneNumber。立即返回lookupId，保存后通过结果接口查询。默认最多20条未完成请求，平台自动排队分配。'
  else:e['description']='按lookupId获取单个号码的结果。completed时name是姓名或空字符串；未实名也是空字符串。其他状态继续等待或按code处理异常。'
 guides={g['id']:g for g in d['guides']}
 flow=guides['lookup-flow'];flow.update(title='查名字 · 快速接入',intro='只传手机号，获取姓名',headings=['先准备，再提交','每条结果独立返回','超时和重复请求'],paragraphs=[
  '首次调用“启动准备”，请求体为{}；每5秒用同一个准备键读取，直到ready:true。之后调用“提交手机号”，只传phoneNumber，保存返回的lookupId。设备选择、账号切换和人工验证由平台处理。',
  '用lookupId每5秒获取结果。status为completed时保存name：有姓名返回页面姓名（可能带掩码），没姓名或未实名返回空字符串。queued/processing表示还在处理，不能先写空；failed是执行异常，按code处理。每条完成就返回，不等整批。',
  '等待2分钟超时不代表任务失败，继续读取原lookupId。没收到提交响应时用原Idempotency-Key重试；同客户同手机号仍在处理中，即使换键也复用原lookupId。默认可有20条未完成请求；429时暂停新增、稍后用原业务键重试。准备过期后换新准备键；503 lookup_not_ready时重新读取准备状态，已有任务继续按原ID取结果。'],sections=[
  {'title':'三个接口','table':{'headers':['顺序','方法与路径','需要传什么'], 'rows':[['1. 启动准备','POST /api/v1/open/name-lookups/prepare','{}'],['2. 提交手机号','POST /api/v1/open/name-lookups/tasks','{"phoneNumber":"13800000000"}'],['3. 获取结果','GET /api/v1/open/name-lookups/tasks/{lookupId}','提交返回的lookupId']]}},
  {'title':'完成响应','code':'{"ok":true,"lookupId":"00000000-0000-4000-8000-000000000002","status":"completed","name":"**某"}\n\n// 没名字或未实名\n{"ok":true,"lookupId":"00000000-0000-4000-8000-000000000003","status":"completed","name":""}','language':'JSON 示例'},
  {'title':'最小调用示例','language':'Node.js','code':'import { OpenNameLookupClient } from "./node_client.mjs";\nconst client = new OpenNameLookupClient({\n  baseUrl: "http://47.98.127.132",\n  clientId: process.env.CLIENT_ID,\n  secret: process.env.CLIENT_SECRET\n});\n// 两个键须在首次发送前持久保存；以下每段由独立定时任务执行。\nconst preparation = await client.prepareLookup({idempotencyKey: savedPreparationKey});\nif (preparation.ready) {\n  const accepted = await client.submitLookup("13800000000", {idempotencyKey: savedBusinessKey});\n  // 持久保存accepted.lookupId，后续只按该ID读取。\n}\nconst result = await client.getLookupResult(savedLookupId);\nif (result.status === "completed") saveName(result.name);'}])
 guides['states'].update(title='结果状态与重试',intro='完成时才保存姓名',headings=['准备状态','查询状态','网络异常'],paragraphs=['preparing：等待；ready且ready:true：可以提交；expired：保存新准备键重新准备。','queued：排队；processing：处理中；completed：保存name（可为空字符串）；failed：执行异常，保留原lookupId并处理code。','HTTP超时或GET失败不代表没姓名。继续按原lookupId读取；提交响应丢失时复用原业务键重试。'],sections=[])
 guides['handover'].update(title='下载与接入检查',intro='给开发的接入资料',headings=['接入信息','联调检查'],paragraphs=['基础地址为http://47.98.127.132。clientId、secret由平台单独提供，仅保存在调用方后端；SDK自动生成签名。下载包包含三个接口说明、Node.js/Python客户端和OpenAPI。','确认能从准备中进入ready、提交并保存lookupId、逐条获得姓名或空字符串、超时继续获取原结果、换请求号仍复用在途任务。'],sections=[])
 guides['overview']['paragraphs'][0]='各平台功能独立查阅。支付宝查名字对外只需启动准备、提交手机号、获取结果三个接口。'
 guides['overview']['paragraphs'][1]='设备和账号由平台内部管理；外部调用方只传手机号，按查询ID获取结果。'
 guides['overview']['paragraphs'][2]='点击支付宝查名字进入独立接入页。其余平台功能沿用各自文档。'
 auth={'id':'lookup-auth','title':'认证与请求键','intro':'使用SDK完成签名','paragraphs':['平台单独提供clientId和secret，放在服务端环境变量中。推荐使用接入包的Node.js或Python客户端，签名由SDK处理。','每次请求需要X-Client-Id、X-Timestamp（Unix毫秒）、X-Nonce和X-Signature。签名为HMAC-SHA256(method、pathname、timestamp、nonce、SHA256(rawBody)按换行连接)，末尾没有换行；GET签空请求体。','两个POST还需要Idempotency-Key（8–160位字母、数字、点、下划线、冒号或短横线）。准备键与手机号业务键分别保存；重试复用原键，每次HTTP请求使用新Nonce与签名。'], 'headings':['接入凭据','手工签名时','避免重复查询'],'sections':[]}
 d['guides']=[g for g in d['guides'] if g['id'] not in {'lookup-legacy','lookup-auth'}]+[auth]
 # Shared authentication remains for other platform APIs, but no obsolete lookup route is recommended.
 g=guides['authentication'];g['paragraphs']=[p.replace('POST prepare/tasks/query','POST prepare/tasks') for p in g['paragraphs']]
 # Remove old lookup-only model reference from the public index; other platform models stay intact.
 d['models']={k:v for k,v in d['models'].items() if not k.startswith('OpenLookup')}
 return d

def public_openapi(o):
 o['paths']={p:v for p,v in o['paths'].items() if not (p.startswith('/api/v1/open/name-lookups/') or p.startswith('/api/v1/user/automation/alipay-name-')) or p in PUBLIC_PATHS}
 for path in PUBLIC_PATHS:
  for op in o['paths'][path].values():
   op.pop('x-release-evidence-required',None)
   if path.endswith('/{lookupId}'):
    schema=op['responses']['200']['content']['application/json']['schema'];schema['oneOf']=schema['oneOf'][:3]
   if path.endswith('/tasks'):
    for code in ['200','202']:op['responses'][code]['content']['application/json']['schema']['properties']['status']['enum']=['queued','processing','completed','failed']
 return o
