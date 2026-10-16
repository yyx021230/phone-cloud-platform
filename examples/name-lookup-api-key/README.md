# 查名字：一个 API Key，三个普通 HTTP 接口

本地候选 `lookup-api-key-20261016-rc.1`，尚未上线。须平台启用本版并交付 API Key 后使用。旧版签名调用继续兼容。

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

每5秒使用同一个准备键读取，直到：

```json
{"ok":true,"preparationId":"准备编号","status":"ready","ready":true,"expiresAt":"到期时间"}
```

`preparing` 继续等待。准备轮次30分钟有效，重复轮询不延长。`expired` 或 `lookup_preparation_expired` 时只换准备键；保留业务提交键和 lookupId。

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
- `503 lookup_not_ready`：重新等待准备；已有查询继续GET原ID。
- `401 invalid_lookup_api_key`：检查 Key，不能使用旧 Client Secret 代替。
- `401 mixed_lookup_auth`：只留 X-API-Key，删除旧签名头。
- `403 managed_lookup_not_authorized`：联系平台核对客户权限。
- `404 lookup_task_not_found`：核对原编号和 Key，不写空姓名。
- `409 idempotency_conflict`：同一业务键被用于不同内容，核对业务记录。

原 HMAC 调用仍能使用，同一客户的任务、防重和限额共享。新调用只用 API Key，无需同时发送两套认证头。API Key 只用于上述三个接口，不适用于管理、短信、投屏或旧会话接口。
