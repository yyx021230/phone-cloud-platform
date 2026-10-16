"""Build the one-key guide from the last deployed static documents. Offline only."""
import json,hashlib,shutil
from pathlib import Path
from zipfile import ZipFile,ZipInfo,ZIP_DEFLATED
R=Path(__file__).resolve().parents[1];ROOT=R.parents[1];P=R/'public'
BASE=ROOT/'releases/lookup-http-guide-20261016-rc.1/public'
E=ROOT/'examples/name-lookup-api-key'
for name in ['api-docs.html','api-docs.css','api-docs.js']:shutil.copyfile(BASE/name,P/name)
s=(P/'api-docs.js').read_text().replace('const authNames = {','const authNames = { "api-key": "API Key · 第三方查名",',1)
s=s.replace('第三方接入 · HMAC','第三方接入 · API Key').replace('e.auth === "hmac")],','["hmac","api-key"].includes(e.auth))],').replace('e.auth !== "hmac")]', '!["hmac","api-key"].includes(e.auth))]')
s=s.replace('${e.auth === "hmac" ? "X-Client-Id:', '${e.auth === "api-key" ? "X-API-Key: <API_KEY>\\n" : e.auth === "hmac" ? "X-Client-Id:')
s=s.replace('以下代码独立发送一次HTTP请求，包含签名','以下代码独立发送一次HTTP请求').replace('401：检查签名。','401：检查API Key。').replace('认证方式：Bearer / HMAC','认证方式：Bearer / API Key').replace('查看认证与签名','查看认证方式')
(P/'api-docs.js').write_text(s)
d=json.loads((BASE/'api-reference.json').read_text())
def section(title,*text,**extra):return dict(title=title,paragraphs=list(text),**extra)
def link(label,href,download=False):return dict(label=label,href=href,download=download)
g={x['id']:x for x in d['guides']}
g['authentication'].update(title='认证方式',intro='查名只填一个 API Key，其他平台功能使用登录令牌',paragraphs=[
 '查名三个接口每次带X-API-Key；不需要Client ID、Secret和签名计算。平台单独交付固定Key。',
 '其他平台功能仍通过POST /api/v1/auth/login获取session.token，携带Authorization: Bearer <TOKEN>。',
 '两个查名POST需要Idempotency-Key。这是调用方自己生成的业务编号，不是另一份密钥；重试保持原值。GET只需要API Key和原lookupId。',
 '原HMAC调用继续兼容，同一客户的权限、防重和限额共享；不要同时带两套认证头。Key只用于查名三个接口。'],headings=['查名接口','其他平台功能','请求编号与重试','旧调用兼容'],code='const headers = {"X-API-Key": process.env.API_KEY};')
d['commonErrors'].extend([[401,'invalid_lookup_api_key','核对平台给你的API Key，不能使用旧Client Secret代替'],[401,'mixed_lookup_auth','只保留X-API-Key，删除旧签名头'],[401,'lookup_api_key_scope_denied','API Key只用于查名三个接口']])
g['lookup-flow']['sections'][0]=section('01 · 只需要一个 API Key','平台给你一个固定API Key，每次放进X-API-Key请求头。不需要Client ID、Secret或签名。','基础地址：http://47.98.127.132。无需设备编号，平台负责排队、分配、切号及冷却。')
g['lookup-flow']['sections'][1]['paragraphs']=['下载Python代码直接运行，按提示输入API Key、手机号和业务编号。它是普通requests HTTP代码，自动准备、提交和取结果。']
g['lookup-python']['sections'][3]=section('3. 按提示填三项','平台只给你一个API Key；输入时不显示。业务编号由你方定义，同一业务重试保持不变。',language='终端输入示意',code='API Key（不显示）：平台提供的Key\n手机号：已授权的号码\n业务编号：order-001')
g['lookup-python']['sections'][5]['paragraphs']=['默认等约120秒。保留lookup-api-key-state.sqlite3，使用相同手机号和业务编号再次运行；已有lookupId时只获取原结果。','状态文件不保存密钥或完整手机号。正式系统用共享业务数据库。更换API Key后需保留并迁移原任务关联，不能删状态盲目重提。']
g['lookup-python']['sections'][6]['paragraphs']=['后端进程只配置API_KEY环境变量。WAIT_SECONDS控制本轮等待；LOOKUP_STATE_DB指定状态数据库路径。']
g['lookup-python']['sections'][-1].update(paragraphs=['http_request()直接发送X-API-Key请求头，没有签名。query_name()执行三个HTTP接口。'],code=(E/'lookup.py').read_text())
g['lookup-http']['sections'][0]=section('每次只带一个认证头',table={'headers':['请求头','填写方法'],'rows':[['X-API-Key','平台给你的固定API Key']]},links=[link('API Key 使用说明 →','#lookup-auth')])
for sec in g['lookup-http']['sections']:
 if 'code' in sec and sec.get('language')=='HTTP':
  lines=sec['code'].splitlines();out=[]
  for line in lines:
   if line.startswith('X-Client-Id:'):out.append('X-API-Key: <API_KEY>')
   elif not line.startswith(('X-Timestamp:','X-Nonce:','X-Signature:')):out.append(line)
  sec['code']='\n'.join(out)
 for i,t in enumerate(sec.get('paragraphs',[])):
  sec['paragraphs'][i]=t.replace('但每次重新生成时间戳、nonce和签名','API Key也保持不变').replace('；GET签名中的正文为空字节','')
g['lookup-auth'].update(title='API Key 使用说明',intro='只填一个固定 Key',sections=[
 section('请求头写法','平台单独交付API Key。它不是旧Client Secret；不需要额外的Client ID或签名。只用于后端，不放网址参数、前端或日志。',language='HTTP',code='X-API-Key: <API_KEY>'),
 section('Python 普通请求',language='Python',code='import requests\n\nheaders = {"X-API-Key": "填入平台给你的Key"}\nr = requests.get("http://47.98.127.132/api/v1/open/name-lookups/tasks/原lookupId",\n                 headers=headers, timeout=30, allow_redirects=False)\nprint(r.json())'),
 section('请求编号是业务编号，不是密钥','两个POST的Idempotency-Key由你方生成并保存。同一笔业务重试保持不变。准备键与提交键分开，GET不需要。'),
 section('旧系统兼容与适用范围','原HMAC方式继续兼容；同一客户的任务、防重及限额共享。不要同时发送API Key和旧签名头。','Key只支持准备、提交、获取结果三个接口，不开放管理或其他业务。当前地址是HTTP，传输不加密。')])
for sec in g['lookup-retries']['sections']:
 if 'table' in sec:
  sec['table']['rows']=[row for row in sec['table']['rows'] if not any(x in row[0] for x in ['signature','timestamp','nonce'])]
  sec['table']['rows'].insert(0,['401 / invalid_lookup_api_key','核对API Key，不使用旧Client Secret代替'])
  sec['table']['rows'].insert(1,['401 / mixed_lookup_auth','只保留X-API-Key，删除旧签名头'])
g['lookup-node']['sections'][0]['paragraphs']=['Node.js18+，原生fetch，无需npm安装。只需在后端进程配置API_KEY，然后执行下方命令。']
g['lookup-node']['sections'][1]['paragraphs']=['保留.lookup-api-key-state目录，使用相同业务编号续查。正式系统使用共享数据库，不和Python状态库混用同一笔业务。']
g['lookup-node']['sections'][-1]['code']=(E/'lookup.mjs').read_text()
for e in d['endpoints']:
 if e['group']!='lookup-user':continue
 e['auth']='api-key'
 for name in ['invalid_lookup_api_key','mixed_lookup_auth','lookup_api_key_scope_denied']:
  e['errors'].append(name);e['errorStatuses'][name]=[401]
 e['errors']=[x for x in e['errors'] if not x.startswith(('open_api_','invalid_open_api_'))]
 e['errorStatuses']={k:v for k,v in e['errorStatuses'].items() if k in e['errors']}
 kind=e['async'];is_post=e['method']=='POST'
 path=repr(e['path']) if kind!='result' else '"/api/v1/open/name-lookups/tasks/" + quote(input("原lookupId：").strip(), safe="")'
 body='{}' if kind=='prepare' else '{"phoneNumber": input("手机号：").strip()}' if kind=='submit' else 'None'
 key='headers["Idempotency-Key"] = input("请求编号（先保存，重试相同）：").strip()' if is_post else '# GET 不需要请求编号'
 e['httpExamples']['Python']=f'''# 单次HTTP；自动准备、等待和持久化请使用完整lookup.py。
import os, getpass
from urllib.parse import quote
import requests
api_key = os.environ.get("API_KEY") or getpass.getpass("API Key：")
path = {path}
headers = {{"X-API-Key": api_key}}
{key}
r = requests.request({e['method']!r}, "http://47.98.127.132" + path,
                     headers=headers, json={body}, timeout=30, allow_redirects=False)
print(r.status_code, r.text)
# 提交后保存lookupId；GET仅在completed时读取name。
'''
 np=json.dumps(e['path']) if kind!='result' else "'/api/v1/open/name-lookups/tasks/' + encodeURIComponent(process.env.LOOKUP_ID || '')"
 nb='{}' if kind=='prepare' else '{phoneNumber:process.env.PHONE_NUMBER}'
 nk="headers['Idempotency-Key']=process.env.REQUEST_KEY; headers['Content-Type']='application/json';" if is_post else ''
 e['httpExamples']['Node.js']=f'''const apiKey=process.env.API_KEY;
if(!apiKey) throw new Error('请配置API_KEY');
const headers={{'X-API-Key':apiKey}};
{nk}
const r=await fetch('http://47.98.127.132'+{np},{{method:{json.dumps(e['method'])},headers,
 {('body:JSON.stringify('+nb+'),') if is_post else ''}
 signal:AbortSignal.timeout(30000),redirect:'error'}});
console.log(r.status,await r.text());
'''
d['version']=R.name;d['status']='API Key 简化接入 · 本地候选，尚未上线'
(P/'api-reference.json').write_text(json.dumps(d,ensure_ascii=False,indent=2)+'\n')
# Both OpenAPI downloads must describe the same one-key contract.
def update_openapi(doc):
 doc['info']['version']=R.name
 doc['components']['securitySchemes']['LookupApiKey']={'type':'apiKey','in':'header','name':'X-API-Key','description':'平台单独分配的固定API Key；只用于查名三个接口。旧HMAC兼容，不可混用。'}
 for path,ops in doc['paths'].items():
  if path not in ['/api/v1/open/name-lookups/prepare','/api/v1/open/name-lookups/tasks','/api/v1/open/name-lookups/tasks/{lookupId}']:continue
  for op in ops.values():
   if not isinstance(op,dict):continue
   op['security']=[{'LookupApiKey':[]}]
   op['parameters']=[x for x in op.get('parameters',[]) if x.get('name','').lower() not in ['x-client-id','x-timestamp','x-nonce','x-signature']]
 return doc
for source,target in [(ROOT/'releases/lookup-public-docs-20261016-rc.1/public/downloads/name-lookup-openapi.json',P/'downloads/name-lookup-openapi.json'),(ROOT/'releases/lookup-public-docs-20261016-rc.1/public/openapi.json',P/'openapi.json')]:
 target.write_text(json.dumps(update_openapi(json.loads(source.read_text())),ensure_ascii=False,indent=2)+'\n')
files={'README.md':(E/'README.md').read_bytes(),'lookup.py':(E/'lookup.py').read_bytes(),'lookup.mjs':(E/'lookup.mjs').read_bytes(),'openapi.json':(P/'downloads/name-lookup-openapi.json').read_bytes()}
for name,data in files.items():
 if name!='openapi.json':(P/'downloads'/('name-lookup-http-guide.md' if name=='README.md' else name)).write_bytes(data)
z=P/'downloads/name-lookup-integration.zip'
with ZipFile(z,'w',compression=ZIP_DEFLATED) as archive:
 for name,content in files.items():
  info=ZipInfo(name,(2026,10,16,0,0,0));info.compress_type=ZIP_DEFLATED;info.external_attr=0o100644<<16;archive.writestr(info,content)
(P/'downloads/name-lookup-sha256.json').write_text(json.dumps({'version':R.name,'files':{k:hashlib.sha256(v).hexdigest() for k,v in files.items()},'zipSha256':hashlib.sha256(z.read_bytes()).hexdigest()},indent=2)+'\n')
print('Built one-key docs: 33 endpoints, 3 lookup interfaces, Python and Node examples')
