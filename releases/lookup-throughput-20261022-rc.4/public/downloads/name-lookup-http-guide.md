# 查名字：一个 API Key，四个普通 HTTP 接口

单 API Key 接入版。平台交付一个 API Key 后即可使用，旧版签名调用继续兼容。

平台给你一个固定的 API Key。每次请求加 `X-API-Key`，不需要 Client ID、Secret、时间戳、nonce 或签名计算。Key 只放后端，不放网址参数或前端。

基础地址：`http://47.98.127.132`。当前 HTTP 不加密传输；API Key 随请求头发送。

## 先运行 Python 完整代码

把 `lookup.py` 下载到电脑，使用 Python 3.9+：

```bash
python -m pip install requests
python lookup.py
```

Mac/Linux 可以先创建虚拟环境：

```bash
python3 -m venv .venv
source .venv/bin/activate
python -m pip install requests
python lookup.py
```

按提示输入 API Key、已授权的手机号、业务编号，例如 `order-001`。API Key 输入时不显示字符。它使用普通 `requests`，自动准备、提交和取结果。

后端自动运行可在进程环境配置 `API_KEY`，再执行 `python lookup.py 实际手机号 order-001`。不用 SDK。Node.js 18+ 的 `lookup.mjs` 同样使用 `API_KEY`，以 `node lookup.mjs 实际手机号 order-001` 运行。

成功输出 `{"status":"completed","lookupId":"原编号","name":"**某"}`；无姓名（包括未实名）输出 `name:""`。等待中的任务和执行失败都不能写成空姓名。

默认一次等约120秒。如果输出 `pending`，再次运行相同手机号、业务编号，保留 `lookup-api-key-state.sqlite3`；已有 lookupId 时只读取原结果。Node 版保留 `.lookup-api-key-state`。不要把两种示例的状态文件交叉使用。

状态文件不保存密钥、完整手机号或姓名。正式系统应把业务编号、幂等键、lookupId、状态和结果保存在自己的共享数据库中；示例本地存储不能代替多服务器共享数据库。API Key 更换后状态绑定会报错，须迁移原业务关联并继续原 lookupId，不能删除状态重新提交。

## 自己写 HTTP：按三步调用

所有请求都带 `X-API-Key: <平台给你的API_KEY>`。两个 POST 还需要 `Content-Type: application/json` 和 `Idempotency-Key`；它是你方业务请求编号，不是另一份密钥。

### 1. 启动准备

```http
POST /api/v1/open/name-lookups/prepare
X-API-Key: <API_KEY>
Content-Type: application/json
Idempotency-Key: prepare-order-001

{}
```

使用同一个准备键读取；acceptingRequests:false时暂停传号，每30秒检查，直到：

```json
{"ok":true,"preparationId":"准备编号","status":"ready","ready":true,"acceptingRequests":true,"expiresAt":"到期时间"}
```

首次启动必须至少两台手机探测通过；本轮首次准备成功后，ready表示本轮已开放接单，不代表当前空闲手机数量。之后有一台有效可查手机即可接单，健康忙碌手机允许排队；零台有效可查时暂停新增，已受理原单继续等待恢复。停止或空闲结束后，新一轮重新要求首次两台通过。

`preparing` 继续等待。本轮没有未完成业务查询，并连续15分钟没有新受理查询时自动结束。排队、执行、人工等待、恢复和未知执行仍属未完成业务，不会因空闲计时中断；最后一条业务结束后重新计15分钟。只启动未提交业务时，从启动开始计时；后台探测不续期。GET、prepare轮询（含换准备键）、同键重试和命中已有任务/缓存的重提均不续期。

当前空闲截止时间（UTC ISO 8601）；有未完成业务时为null，表示空闲计时暂停。以status和ready判断状态，不把null当已过期。

空闲到期走安全停止：可能短暂expired，随后stopping。在线手机等待停止确认；本轮已请求结束时，持续掉线30秒的手机在旧任务撤销并持久化后单独隔离，不再阻塞整轮结束。隔离不代表手机已经停止，恢复连接后仍须确认旧会话清理，才可重新接单。确认stopped后，由调用方用新的准备键显式启动。已完成结果继续保留。保留原业务键和lookupId，继续读结果。

### 2. 提交手机号

```http
POST /api/v1/open/name-lookups/tasks
X-API-Key: <API_KEY>
Content-Type: application/json
Idempotency-Key: query-order-001

{"phoneNumber":"13800000000"}
```

以上为合成示例号码，正式使用获授权的号码。HTTP200/202返回：

```json
{"ok":true,"lookupId":"查询编号","status":"queued","reused":false}
```

马上保存 lookupId。受理不等于完成，姓名从下一步获取。相同请求键不能用于其他手机号。准备键与提交键分开保存，长度8–160位，仅字母、数字、点、下划线、冒号、短横线。

### 3. 获取这条结果

```http
GET /api/v1/open/name-lookups/tasks/查询编号
X-API-Key: <API_KEY>
```

每5秒读取原编号；GET不发送正文、不需要幂等键。`queued/processing` 继续等；`completed` 才读取 name：

```json
{"ok":true,"lookupId":"原编号","status":"completed","name":"**某"}
```

没姓名或未实名返回 `name:""`。`failed` 带错误 code，表示执行失败，不表示没姓名。

## 超时、排队与错误

- 两分钟没结果不会取消服务器任务。有 lookupId 就继续 GET；提交响应丢失，使用原手机号、原提交键重试。
- 同一客户同手机号仍在处理中，即使换请求键也复用原 lookupId；近10分钟完成结果也可能复用。调用方仍应保存原键与编号。
- 默认最多20条未完成任务；每个号码单独POST。平台内部最多5台执行，其他排队，每条结果独立返回。达到上限返回429，等5秒或按更长的 Retry-After 原键重试。
- `503 lookup_not_ready`：本轮尚未首次准备成功，或本轮已到期/结束；先检查准备状态。已开放轮次不会仅因就绪手机不足两台拒绝提交。已有查询继续GET原ID。
- `401 invalid_lookup_api_key`：检查 Key，不能使用旧 Client Secret 代替。
- `401 mixed_lookup_auth`：只留 X-API-Key，删除旧签名头。
- `403 managed_lookup_not_authorized`：联系平台核对客户权限。
- `404 lookup_task_not_found`：核对原编号和 Key，不写空姓名。
- `409 idempotency_conflict`：同一业务键被用于不同内容，核对业务记录。

原 HMAC 调用仍能使用，同一客户的任务、防重和限额共享。新调用只用 API Key，无需同时发送两套认证头。API Key 只用于上述查名接口，不适用于管理、短信、投屏或旧会话接口。

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

HTTP 200 且 `stopped:true` 才确认本轮结束。在线手机仍在停止或离线隔离尚未持久化时返回 stopping，新 prepare 键返回409 `lookup_round_stopping`。本轮已请求结束时，持续掉线30秒的手机完成任务撤销后单独隔离，本轮可以返回 stopped，下一轮使用其他可用手机；隔离手机恢复后先清理旧会话，确认停止后才重新接单。已完成结果继续按原 lookupId 获取；取消的查询返回 failed / lookup_round_stopped，不代表没有姓名。停止与结果同时到达时，已收到的结果保留。

下一轮：确认 stopped 后生成新的准备键，再调用 prepare 等到 ready:true。重试旧停止请求不会停掉新一轮。一个客户统一维护轮次；结束影响该客户本轮全部查询，不影响其他客户和非查名手机。

运行 `python stop_lookup.py`，输入同一个 API Key 和 preparationId。代码只用 requests，最多等待120秒；超时后再次运行并输入同一 preparationId，继续确认停止。**不要自动把停止当成过期并重启。**

```python
import requests

api_key = "填入平台给你的Key"
preparation_id = "填入启动prepare返回的preparationId"
r = requests.post(
    "http://47.98.127.132/api/v1/open/name-lookups/stop",
    headers={"X-API-Key": api_key, "Idempotency-Key": "stop-" + preparation_id},
    json={"preparationId": preparation_id}, timeout=30, allow_redirects=False)
print(r.status_code, r.json())
# stopping：每5秒用同一个请求继续读取；stopped：这一轮已结束。
# 网络超时也复用这个 preparationId 和 Idempotency-Key，不创建新轮次。
```


手机连续空闲满5分钟后暂停接收业务，优先保留原健康会话重新探测，通过后再接单；原手机异常、账户掉线、冷却、被控屏占用或需人工处理时，使用其他可用候补。后台重新探测不延长整轮15分钟空闲期限；有排队、执行或异常接续中的业务时不按空闲关闭。

## 手机掉线与结束本轮的区别

查询执行中手机持续离线30秒：平台隔离旧手机执行，保留原lookupId和手机号，自动转交其他已探测就绪的在线手机；没有可用手机时继续排队，原任务总时限不延长，调用方继续读取原lookupId，无需重新提交。只有显式调用结束接口，或没有未完成业务且连续空闲15分钟时，才结束本轮并取消未完成工作。离线手机不会无限阻塞stopping，重连后先清理旧执行并重新探测。


## 暂无可用手机：暂停新增提交

当前是否可提交新号码请看 acceptingRequests。首次仍需两台探测成功；本轮已开放后恢复一台即可接单。零台有效可查（含全部离线、账号不可用、人工或重探）时暂停新增，POST tasks 返回503 lookup_no_available_device、accepted:false和Retry-After:30，不创建查询；健康手机只是在执行任务则仍可排队。保留已受理的lookupId，同键/同号码在途重试继续复用。每30秒用原准备键轮询prepare，acceptingRequests:true后再提交；不是30秒必然恢复。ready表示本轮已首次开放，不等于当前容量。

提交新号码被拒绝（HTTP 503，响应头 `Retry-After: 30`）：

```json
{"ok":false,"code":"lookup_no_available_device","accepted":false,"retryAfterSeconds":30}
```

这次没有生成lookupId。对接方应暂停整个发送队列，每30秒用原准备键调用prepare；等待`acceptingRequests:true`后用原业务键提交。不要不停生成新请求号重试，不要仅看ready，也不要把拒绝记为空姓名。

已经受理的原查询仍HTTP 200返回`queued`，可附带`code:lookup_no_available_device`、`acceptingRequests:false`和`retryAfterSeconds:30`；保留原lookupId，按建议间隔GET。正在执行的查询继续processing，已完成的姓名或空字符串仍可读取。没有新接口、没有对外设备数量；初次准备未完成仍可能返回lookup_not_ready。

Python和Node完整示例已处理这两个状态，503后先回prepare而非反复传手机号。多线程/多服务调用方应在客户级共享暂停状态；示例本地状态不是跨进程发送队列。
