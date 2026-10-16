"""Generate HTTP-only lookup guide and downloads; never calls any business API."""
import hashlib
import json
from pathlib import Path
from zipfile import ZipFile, ZipInfo, ZIP_DEFLATED

ROOT = Path(__file__).resolve().parents[3]
RELEASE = Path(__file__).resolve().parents[1]
BASE = ROOT / 'releases/lookup-public-docs-20261016-rc.1'
EXAMPLES = ROOT / 'examples/name-lookup'
PUBLIC = RELEASE / 'public'
D = json.loads((BASE / 'public/api-reference.json').read_text())
PYTHON = (EXAMPLES / 'lookup.py').read_text()
NODE = (EXAMPLES / 'lookup.mjs').read_text()
README = (EXAMPLES / 'HTTP_README.md').read_text()
VERSION = RELEASE.name

def section(title, paragraphs=(), **extra):
    return dict(title=title, paragraphs=list(paragraphs), **extra)

def guide(id, title, intro, sections, **extra):
    return dict(id=id, title=title, intro=intro, paragraphs=[], sections=sections, **extra)

def link(label, href, download=False):
    return dict(label=label, href=href, download=download)

flow = guide('lookup-flow', '从这里开始', '传手机号，拿到姓名', [
    section('01 · 准备接入信息', ['基础地址：http://47.98.127.132（当前为HTTP）。请先向平台取得你方系统专用的Client ID和Client Secret。它们不是平台的登录账号密码。', '不需要填写手机编号，不需要选择支付宝账号。平台负责设备分配、排队、切号及冷却。']),
    section('02 · 先跑通一条查询', ['推荐下载Python文件直接运行：它就是普通requests HTTP代码，没有SDK初始化。程序会提示输入凭据、手机号和你方业务编号。签名、等待就绪、提交和获取结果都已写全。'],
        links=[link('看Python完整运行步骤 →', '#lookup-python'), link('下载 lookup.py', './downloads/lookup.py', True), link('下载全部HTTP示例', './downloads/name-lookup-integration.zip', True)]),
    section('03 · 只在完成时取 name', ['有姓名返回页面可获取的姓名（可能有星号）；没姓名或未实名返回空字符串。处理过程中还没有name；失败不代表没有姓名。'], language='JSON · 服务端完成响应', code='{"ok":true,"lookupId":"原查询编号","status":"completed","name":"**某"}\n\n{"ok":true,"lookupId":"原查询编号","status":"completed","name":""}'),
    section('两分钟没结果，接着查原任务', ['用原lookupId继续获取结果；提交响应丢失时，用原请求键和手机号重试。完整Python示例自动保存进度，重跑同一业务编号即可。不要因为超时就写空姓名或再创建一笔业务。'], links=[link('看超时与重试规则 →', '#lookup-retries')]),
    section('自己接HTTP：只用下面三个接口', table={'headers':['顺序','接口','发送什么 / 拿到什么'],'rows':[
        ['1 启动准备','POST /api/v1/open/name-lookups/prepare','发 {}；等 ready:true'],
        ['2 提交号码','POST /api/v1/open/name-lookups/tasks','发 phoneNumber；保存 lookupId'],
        ['3 获取结果','GET /api/v1/open/name-lookups/tasks/{lookupId}','按原编号获取；completed时取name']]},
        links=[link('查看原始HTTP请求与响应 →', '#lookup-http')]),
], steps=['启动准备', '提交手机号', '获取姓名'])
python_guide = guide('lookup-python', 'Python · 完整代码', '下载一个文件，直接运行', [
    section('1. 下载代码', ['Python 3.9或以上，使用requests发普通HTTP；不需要SDK。不用修改源码，运行时按提示输入即可。'], links=[link('下载 lookup.py', './downloads/lookup.py', True), link('下载完整说明和代码包', './downloads/name-lookup-integration.zip', True)]),
    section('2. Windows 运行', ['解压后进入lookup.py所在目录，在终端执行。若系统只有python命令，把py替换为python。'], language='PowerShell / CMD', code='py -m pip install requests\npy lookup.py'),
    section('2. Mac / Linux 运行', ['在lookup.py所在目录执行；虚拟环境只需创建一次。'], language='Terminal', code='python3 -m venv .venv\nsource .venv/bin/activate\npython -m pip install requests\npython lookup.py'),
    section('3. 按提示填四项', ['Client ID和Client Secret由平台提供。Secret输入时不显示。业务编号由你方定义，例如订单号；同一笔业务重试必须保持原编号。'], language='终端输入示意', code='接口 Client ID：填写平台提供的值\n接口 Client Secret（不显示）：填写平台提供的值\n手机号：填写已授权的号码\n业务编号（例如 order-001；重试保持不变）：order-001'),
    section('4. 看程序输出', ['完成就读取name；空字符串也是已完成。pending只是这份程序本轮没等完，不是接口的任务终态。以下是程序输出，原始接口响应另有ok字段。'], language='JSON · 示例程序输出', code='{"status":"completed","lookupId":"原编号","name":"**某"}\n\n{"status":"completed","lookupId":"原编号","name":""}\n\n{"status":"pending","lookupId":"原编号"}'),
    section('5. 超时后原样再运行', ['默认本轮等约120秒。保留同目录的lookup-state.sqlite3，按相同手机号、业务编号再次运行；程序会取原结果，不重新分配一笔查询。不要删状态库，也不要用更换业务编号处理超时。', '状态库只保存请求键、查询编号及绑定摘要，不保存密钥或完整手机号。正式系统把这些关联放进自己的业务数据库；多个服务器不能各保存一套独立状态。']),
    section('6. 后端自动运行，不手动输入', ['在后端进程配置CLIENT_ID、CLIENT_SECRET环境变量后，可使用下面命令。WAIT_SECONDS控制本轮等待时长；LOOKUP_STATE_DB指定持久化数据库路径。'], language='Terminal', code='python lookup.py 实际手机号 order-001'),
    section('完整 Python 源码', ['文件内http_request()就是requests.request()调用及签名，query_name()依次执行三个HTTP接口。下方是下载文件的完整内容。'], language='Python · requests · 完整文件', code=PYTHON, collapsed=True),
])
http_guide = guide('lookup-http', 'HTTP · 三步调用', '按这个顺序发 HTTP', [
    section('每次请求都带这四个头', table={'headers':['请求头','填写方法'],'rows':[
        ['X-Client-Id','平台给你方的Client ID'],['X-Timestamp','当前Unix毫秒时间戳'],['X-Nonce','每次HTTP请求新的UUID'],['X-Signature','按本次方法、路径、正文计算的签名']]}, links=[link('签名规则和代码 →','#lookup-auth')]),
    section('1. POST 启动准备', ['请求体只有{}。准备期间每5秒重复此请求，Idempotency-Key保持不变，但每次重新生成时间戳、nonce和签名。'], language='HTTP', code='POST /api/v1/open/name-lookups/prepare HTTP/1.1\nHost: 47.98.127.132\nContent-Type: application/json\nIdempotency-Key: prepare-order-001\nX-Client-Id: <CLIENT_ID>\nX-Timestamp: <本次毫秒时间戳>\nX-Nonce: <本次UUID>\nX-Signature: <本次签名>\n\n{}', links=[link('启动准备：参数与完整单次HTTP代码 →','#post-api-v1-open-name-lookups-prepare')]),
    section('等到 ready:true', ['preparing继续等；ready且ready:true才提交。准备轮次30分钟有效，轮询不延长；expired或lookup_preparation_expired时保存新准备键重来。'], language='JSON', code='{"ok":true,"preparationId":"准备编号","status":"preparing","ready":false,"expiresAt":"到期时间"}\n\n{"ok":true,"preparationId":"准备编号","status":"ready","ready":true,"expiresAt":"到期时间"}'),
    section('2. POST 提交手机号', ['使用另一份业务请求键；同一业务重试保持这个键。正文只有phoneNumber。HTTP200或202受理后，立即保存lookupId。'], language='HTTP', code='POST /api/v1/open/name-lookups/tasks HTTP/1.1\nHost: 47.98.127.132\nContent-Type: application/json\nIdempotency-Key: query-order-001\nX-Client-Id: <CLIENT_ID>\nX-Timestamp: <本次毫秒时间戳>\nX-Nonce: <本次UUID>\nX-Signature: <本次签名>\n\n{"phoneNumber":"实际手机号"}', links=[link('提交手机号：参数与完整单次HTTP代码 →','#post-api-v1-open-name-lookups-tasks')]),
    section('保存这个 lookupId', ['这里还不返回姓名。reused:true只是复用了原任务，继续按它返回的编号取结果。'], language='JSON', code='{"ok":true,"lookupId":"查询编号","status":"queued","reused":false}'),
    section('3. GET 获取单条结果', ['不发送请求体，不带Idempotency-Key；GET签名中的正文为空字节。每5秒读取原编号，直到completed。'], language='HTTP', code='GET /api/v1/open/name-lookups/tasks/查询编号 HTTP/1.1\nHost: 47.98.127.132\nX-Client-Id: <CLIENT_ID>\nX-Timestamp: <本次毫秒时间戳>\nX-Nonce: <本次UUID>\nX-Signature: <本次签名>', links=[link('获取结果：参数与完整单次HTTP代码 →','#get-api-v1-open-name-lookups-tasks-lookupId')]),
    section('每条查询自己完成，不等整批', table={'headers':['status','含义','怎么做'],'rows':[['queued','排队','继续GET原编号'],['processing','查询中','继续GET原编号'],['completed','已完成','取name；姓名或空字符串'],['failed','执行失败','保留lookupId和code排查，不能当作没名字']]}, language='JSON · 成功和执行失败都可能是HTTP200', code='{"ok":true,"lookupId":"原编号","status":"completed","name":"**某"}\n\n{"ok":false,"lookupId":"原编号","status":"failed","code":"错误原因"}')
])
retries = guide('lookup-retries', '超时、排队与报错', '超时继续原请求', [
    section('两分钟超时不会取消服务器任务', ['有lookupId就继续GET原编号；没收到提交响应，用原Idempotency-Key、原手机号再POST。不要超时后写空姓名或生成新业务。']),
    section('同一个号码会不会重复查', ['同一客户同手机号仍在处理中，即使误换请求键也会合并原lookupId。不过调用方仍应持久化原键和编号。已完成的原键始终读取原业务；新键可能复用近10分钟内同号码结果，不保证强制重新查询。']),
    section('一次提交10个、20个', ['每个手机号提交一次，客户默认最多20条未完成任务，平台内部最多5台执行，其他任务排队；额度以实际客户配置为准。每条结果独立获取。429时等待后用原键重试，不新增同一业务。']),
    section('出现这些情况怎么处理', table={'headers':['情况','操作'],'rows':[
        ['429 / lookup_inflight_limit','按Retry-After等待；没此头等5秒，原键重试'],
        ['503 / lookup_not_ready','重新读取准备状态；已提交的任务继续GET原ID'],
        ['expired / lookup_preparation_expired','只更换准备键，保留业务提交键和lookupId'],
        ['401 / invalid_open_api_signature','核对Client ID、Secret和JSON原始字节'],
        ['open_api_timestamp_expired','同步服务器时间，签名使用毫秒时间戳'],
        ['open_api_nonce_replayed','每个HTTP请求使用新的nonce；业务请求键保持'],
        ['409 / idempotency_conflict','同一个业务键不可用于不同手机号，先核对原业务'],
        ['404 / lookup_task_not_found','检查原lookupId和客户凭据，不写空姓名'],
        ['lookup_pool_disabled / lookup_probe_not_configured','联系平台检查启用和探测配置'],
        ['failed / 其他错误','保留lookupId和code排查，不能算作没有姓名']]}),
    section('接入系统要落库的字段', ['你方业务编号、提交幂等键、lookupId、当前状态、最终name。发请求前保存键，收到lookupId立即保存；准备键另存。同一客户可统一维护准备轮次，外部不用关心手机数量。'])
])
auth = guide('lookup-auth','HTTP 签名规则','签名写在同一份 HTTP 代码里',[
    section('凭据在哪里填',['Client ID、Client Secret由平台单独提供，仅供你方后端使用；不是平台管理员密码。Python完整示例运行后直接输入，或配置CLIENT_ID、CLIENT_SECRET环境变量。']),
    section('签名原文与请求头',['METHOD大写；path只有/api/...，不带域名和查询串；timestamp为Unix毫秒；nonce每次HTTP请求新UUID；末尾没有换行。POST签名后的JSON原始字节原样发送；GET用空字节。'],language='签名规则',code='bodyHash = SHA256(rawBody).hexdigest()\ntext = METHOD + "\\n" + path + "\\n" + timestamp + "\\n" + nonce + "\\n" + bodyHash\nX-Signature = HMAC-SHA256(Client Secret, text).hexdigest()'),
    section('请求键和签名不是一回事',['两个POST需要Idempotency-Key：8–160位字母、数字、点、下划线、冒号、短横线。准备键与提交键分开保存。重试保持业务键，每次刷新时间戳、nonce和签名。']),
    section('直接看代码',['无需安装或初始化SDK。Python代码中的http_request()包含签名和requests请求；每个接口页也有可运行的单次HTTP示例。'],links=[link('完整Python源码 →','#lookup-python'),link('原始HTTP请求 →','#lookup-http')])
])
node_guide = guide('lookup-node','Node.js · 完整代码','Node.js 直接发 HTTP',[
    section('下载与运行',['Node.js18+，使用原生fetch，不需要npm安装。通过进程环境变量配置CLIENT_ID、CLIENT_SECRET（平台提供的接口凭据），在文件目录运行；默认服务器为http://47.98.127.132。'],links=[link('下载 lookup.mjs','./downloads/lookup.mjs',True)],code='node lookup.mjs 实际手机号 order-001',language='Terminal'),
    section('重试保持原业务编号',['保留.lookup-state目录，超时后执行相同命令继续原任务。不要和Python状态库交叉使用同一笔业务；正式系统用自己的共享业务数据库。']),
    section('完整源码',code=NODE,language='Node.js · fetch',collapsed=True)
])
new = {g['id']:g for g in [flow,python_guide,http_guide,retries,auth,node_guide]}
D['guides']=[new.pop(g['id'],g) for g in D['guides']]+list(new.values())
for g in D['guides']:
    if g['id']=='handover':
        g.update(intro='代码与说明一起下载',paragraphs=['下载包内直接提供lookup.py、lookup.mjs、完整HTTP接入说明与三接口OpenAPI。没有SDK初始化步骤。','先跑一条查询，再验证空姓名、两分钟续查、断线重提、排队和错误处理；不要把超时写成没名字。'],headings=['下载内容','接入自查'],sections=[])

# Each endpoint example is independently runnable. No undefined client/saved* variables.
for e in D['endpoints']:
    if e.get('group')!='lookup-user': continue
    kind=e['async']; pathname=e['path']
    path_line='path = '+repr(pathname) if kind!='result' else 'path = "/api/v1/open/name-lookups/tasks/" + quote(input("原lookupId：").strip(), safe="")'
    body_line='body = {}' if kind=='prepare' else 'body = {"phoneNumber": input("手机号：").strip()}' if kind=='submit' else 'body = None'
    key_line='headers["Idempotency-Key"] = input("已保存的'+('准备' if kind=='prepare' else '业务')+'请求键（首次自定8至160位，重试相同）：").strip()' if kind!='result' else '# GET不需要Idempotency-Key'
    code='''# 单次普通HTTP示例；自动等待/持久化/重试请用完整lookup.py。
# 安装依赖：python -m pip install requests
import os, json, time, uuid, hashlib, hmac, getpass
from urllib.parse import quote
import requests

base = "http://47.98.127.132"
client_id = os.environ.get("CLIENT_ID") or input("Client ID：").strip()
secret = os.environ.get("CLIENT_SECRET") or getpass.getpass("Client Secret：")
METHOD_LINE
PATH_LINE
BODY_LINE
raw = b"" if body is None else json.dumps(body, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
timestamp, nonce = str(int(time.time() * 1000)), str(uuid.uuid4())
text = "\\n".join([method, path, timestamp, nonce, hashlib.sha256(raw).hexdigest()])
headers = {
    "X-Client-Id": client_id, "X-Timestamp": timestamp, "X-Nonce": nonce,
    "X-Signature": hmac.new(secret.encode(), text.encode(), hashlib.sha256).hexdigest()
}
if body is not None:
    headers["Content-Type"] = "application/json"
KEY_LINE
response = requests.request(method, base + path, headers=headers,
                            data=raw if body is not None else None,
                            timeout=30, allow_redirects=False)
print("HTTP", response.status_code)
print(response.text)
# POST提交后保存lookupId；GET时仅completed才读取name。
'''.replace('METHOD_LINE','method = '+repr(e['method'])).replace('PATH_LINE',path_line).replace('BODY_LINE',body_line).replace('KEY_LINE',key_line)
    node='''// 单次普通HTTP示例；完整自动流程见下载的lookup.mjs。
import crypto from 'node:crypto';
const base = 'http://47.98.127.132';
const { CLIENT_ID, CLIENT_SECRET } = process.env;
if (!CLIENT_ID || !CLIENT_SECRET) throw new Error('先配置接口凭据环境变量');
const method = METHOD;
const path = PATH;
const raw = RAW;
const timestamp = String(Date.now()), nonce = crypto.randomUUID();
const bodyHash = crypto.createHash('sha256').update(raw).digest('hex');
const text = [method, path, timestamp, nonce, bodyHash].join('\\n');
const headers = {
  'X-Client-Id': CLIENT_ID, 'X-Timestamp': timestamp, 'X-Nonce': nonce,
  'X-Signature': crypto.createHmac('sha256', CLIENT_SECRET).update(text).digest('hex')
};
KEY
const response = await fetch(base + path, {method, headers, body: method === 'GET' ? undefined : raw,
  signal: AbortSignal.timeout(30000), redirect: 'error'});
console.log(response.status, await response.text());
'''.replace('METHOD',json.dumps(e['method'])).replace('PATH',json.dumps(pathname) if kind!='result' else "'/api/v1/open/name-lookups/tasks/' + encodeURIComponent(process.env.LOOKUP_ID || '')").replace('RAW',"JSON.stringify({})" if kind=='prepare' else "JSON.stringify({phoneNumber: process.env.PHONE_NUMBER})" if kind=='submit' else "''").replace('KEY',"headers['Content-Type'] = 'application/json';\nheaders['Idempotency-Key'] = process.env.REQUEST_KEY; // 先保存，重试复用原键" if kind!='result' else '// GET不需要请求键')
    e['httpExamples']={'Python':code,'Node.js':node}
D['version']=VERSION
D['baseline']='lookup-readiness-20261016-deployed.16'
D['updatedAt']='2026-10-16'
D['status']='三接口契约 · 普通HTTP完整示例'
(PUBLIC/'api-reference.json').write_text(json.dumps(D,ensure_ascii=False,indent=2)+'\n')
files={'README.md':README.encode(),'lookup.py':PYTHON.encode(),'lookup.mjs':NODE.encode(),'openapi.json':(BASE/'public/downloads/name-lookup-openapi.json').read_bytes()}
for name,content in [('lookup.py',PYTHON.encode()),('lookup.mjs',NODE.encode()),('name-lookup-http-guide.md',README.encode())]:
    (PUBLIC/'downloads'/name).write_bytes(content)
zip_path=PUBLIC/'downloads/name-lookup-integration.zip'
with ZipFile(zip_path,'w',compression=ZIP_DEFLATED) as archive:
    for name,content in files.items():
        info=ZipInfo(name,date_time=(2026,10,16,0,0,0));info.compress_type=ZIP_DEFLATED;info.external_attr=0o100644<<16
        archive.writestr(info,content)
checks=dict(version=VERSION,status='http-example-bundle',files={name:hashlib.sha256(content).hexdigest() for name,content in files.items()},zipSha256=hashlib.sha256(zip_path.read_bytes()).hexdigest())
(PUBLIC/'downloads/name-lookup-sha256.json').write_text(json.dumps(checks,ensure_ascii=False,indent=2)+'\n')
manifest={str(p.relative_to(RELEASE)):hashlib.sha256(p.read_bytes()).hexdigest() for p in sorted(PUBLIC.rglob('*')) if p.is_file()}
(RELEASE/'MANIFEST.json').write_text(json.dumps(manifest,ensure_ascii=False,indent=2)+'\n')
print('Generated', len(D['endpoints']), 'endpoints and',len(manifest),'static files')
