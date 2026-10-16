# 查名字 HTTP 接入：从运行到取结果

**普通 HTTP 接口，不需要 SDK。** 对外只有三步：启动准备 → 提交手机号 → 获取结果。平台负责分配手机和账号；你方不传手机编号。

## 1. 先拿到这两个接口凭据

- `Client ID`：平台分配给你方系统的接口标识。
- `Client Secret`：对应的签名密钥。

这两个值由平台单独提供，不是平台管理员登录账号密码。基础地址：`http://47.98.127.132`，当前使用 HTTP。

## 2. 最快跑通：直接运行 Python 文件

下载本包，解压后进入文件所在目录。安装 Python 3.9 或以上。

**Windows：**

```powershell
py -m pip install requests
py lookup.py
```

**Mac / Linux：**

```bash
python3 -m venv .venv
source .venv/bin/activate
python -m pip install requests
python lookup.py
```

程序依次提示输入：Client ID、Client Secret、手机号、业务编号。Secret 输入不显示，也不会写入状态文件。业务编号是你方的订单号或任务号，例如 `order-001`。

你不需要填手机、账号、查询编号或签名。程序会自动发HTTP请求、保存查询编号，并每5秒获取一次结果。

配置了进程环境变量 `CLIENT_ID`、`CLIENT_SECRET` 的后端，也可以直接执行：

```bash
python lookup.py 实际手机号 order-001
```

可选环境变量：`BASE_URL`（默认上述地址）、`WAIT_SECONDS`（本轮等待默认120秒）、`LOOKUP_STATE_DB`（默认当前目录的 `lookup-state.sqlite3`）。

Node.js 18+ 用户可用包内 `lookup.mjs`，配置同样的凭据环境变量后运行 `node lookup.mjs 实际手机号 order-001`。不需要 SDK 或 npm 安装。Node 状态存 `.lookup-state`；两种语言各自演示持久化，不要在同一笔在途业务上切换脚本/状态库重提。

## 3. 看懂输出

Python示例完成时输出（这是示例程序输出，接口原始响应还含 `ok`）：

```json
{"status":"completed","lookupId":"查询编号","name":"**某"}
```

没名字，包括未实名：

```json
{"status":"completed","lookupId":"查询编号","name":""}
```

你的系统只在 `status == "completed"` 时取 `name`。返回的是页面可获取的姓名，可能有星号。

等待约两分钟还没有最终结果：

```json
{"status":"pending","lookupId":"原查询编号"}
```

`pending` 是示例程序的等待状态，不是服务端任务状态；如果还没拿到查询编号，可能没有 `lookupId`。网络连接/读取超时按每次请求处理，120秒不是硬性业务完成保证。

**再用同一手机号、同一业务编号、同一个状态库运行即可续查。** 不要删除 `lookup-state.sqlite3`，不要为了重试换业务编号。程序已有查询编号就只获取结果；提交响应丢失则用原请求键重试。超时、失败、手机不可用都不能写成“没有名字”。

退出码：0=查询完成；2=本轮等待结束，可续查；1=凭据/参数/执行等错误，保留原请求排查。进度在stderr，结果JSON在stdout。

## 4. 自己发 HTTP 时，照这三个接口写

所有请求都带签名头：`X-Client-Id`、`X-Timestamp`、`X-Nonce`、`X-Signature`。两个POST还要带 `Content-Type: application/json` 和 `Idempotency-Key`。

### 第一步：启动准备

```http
POST http://47.98.127.132/api/v1/open/name-lookups/prepare
Content-Type: application/json
Idempotency-Key: prepare-order-001
X-Client-Id: <平台给的Client ID>
X-Timestamp: <当前Unix毫秒时间戳>
X-Nonce: <本次新的UUID>
X-Signature: <按本次请求计算的HMAC签名>

{}
```

准备中：

```json
{"ok":true,"preparationId":"准备编号","status":"preparing","ready":false,"expiresAt":"到期时间"}
```

每5秒用同一个准备键再调用一次。等到下面这样才能提交新号码：

```json
{"ok":true,"preparationId":"准备编号","status":"ready","ready":true,"expiresAt":"到期时间"}
```

准备轮次有效期30分钟；轮询不会延长。`expired` 或 `lookup_preparation_expired` 时保存一个新准备键再调用。已有查询编号的任务不用重复启动，直接获取原结果。

### 第二步：提交手机号

```http
POST http://47.98.127.132/api/v1/open/name-lookups/tasks
Content-Type: application/json
Idempotency-Key: query-order-001
X-Client-Id: <平台给的Client ID>
X-Timestamp: <本次Unix毫秒时间戳>
X-Nonce: <本次新的UUID>
X-Signature: <本次签名>

{"phoneNumber":"实际手机号"}
```

HTTP 200或202，得到：

```json
{"ok":true,"lookupId":"查询编号","status":"queued","reused":false}
```

**立即保存 `lookupId`。** 这个接口受理号码，姓名去第三步拿。`reused:true` 表示复用原任务；继续获取这个编号的结果即可。

### 第三步：获取结果

```http
GET http://47.98.127.132/api/v1/open/name-lookups/tasks/查询编号
X-Client-Id: <平台给的Client ID>
X-Timestamp: <本次Unix毫秒时间戳>
X-Nonce: <本次新的UUID>
X-Signature: <本次签名，GET按空正文计算>
```

每5秒GET一次，不发请求体，不用 `Idempotency-Key`。

| status | 意思 | 你方处理 |
|---|---|---|
| queued | 已受理，排队中 | 继续GET原编号 |
| processing | 正在查 | 继续GET原编号 |
| completed | 已完成 | 保存name，可为姓名或空字符串 |
| failed | 执行失败 | 保留lookupId和code排查，不写空姓名 |

HTTP 200的业务失败也可能是 `{"ok":false,"lookupId":"原编号","status":"failed","code":"错误原因"}`，不能仅用HTTP200判断成功。

## 5. 签名怎么写

`lookup.py` 的 `http_request()` 已包含全部签名和 `requests.request()` 调用，可直接复制。算法：

```text
bodyHash = SHA256(实际发送的UTF-8正文).hexdigest()
签名原文 = METHOD + "\n" + path + "\n" + timestamp + "\n" + nonce + "\n" + bodyHash
X-Signature = HMAC-SHA256(Client Secret, 签名原文).hexdigest()
```

METHOD为大写；path只取 `/api/...`，不带域名和查询串；timestamp为Unix毫秒；nonce每次HTTP请求使用新UUID；最后一行后没有换行。GET正文为空字节。POST签名用的JSON字节要原样发送，不能签名后重新改变空格或字段顺序。

`Idempotency-Key` 为8–160位字母、数字、点、下划线、冒号或短横线。准备键、提交键分别保存；同一业务重试用原提交键，但每次HTTP请求重新生成timestamp、nonce、签名。

## 6. 超时、排队和错误

| 情况 | 正确处理 |
|---|---|
| GET两分钟没结果 | 继续GET原lookupId，不能重新创建一笔业务 |
| POST响应断了，不知道是否受理 | 用原Idempotency-Key和原手机号重试 |
| 同号码还在处理中，误换了请求键 | 平台在同一客户范围合并到原lookupId；仍应保存原键和ID |
| 新号码收到429 | 当前额度已满，按Retry-After等待；无此头等5秒，用原键重试 |
| 503 lookup_not_ready | 先按原准备键读准备状态；过期则新准备键；原查询仍GET原ID |
| 401 invalid_open_api_signature | 核对Client ID/Secret、签名原文与实际JSON字节 |
| open_api_timestamp_expired | 同步调用方服务器时钟，使用毫秒时间戳 |
| open_api_nonce_replayed | 每次HTTP重试都生成新的nonce；不要复用整套请求头 |
| 409 idempotency_conflict | 同一业务键被用于不同手机号；先核对原业务，不盲目换键 |
| 404 lookup_task_not_found | 核对原lookupId和Client ID，不据此写空姓名 |
| lookup_pool_disabled / lookup_probe_not_configured / managed_lookup_not_authorized | 联系平台检查启用和授权配置；不能靠换请求号解决 |
| failed / 其他无法确认的错误 | 保存lookupId与错误码联系平台；不当成没有姓名 |

每个手机号各提交一次，可同时提交10或20笔业务；默认客户未完成额度20条，平台内部最多5台执行，其余排队。额度以实际客户配置为准，429时等待。每条完成各自拿结果，不等整批。

已完成业务用原键重试仍是原结果。同一客户同号码的新业务键可能复用近期10分钟内结果；不要通过换键要求强制重查。

## 7. 接到你们系统里时要保存什么

你方业务编号、提交幂等键、lookupId、任务状态和最终name。发请求前保存幂等键；收到lookupId立即保存。准备键单独保存；一个客户正常准备轮次可以由后台统一维护，不需要你方为每台手机准备。

Python例子用本地SQLite演示持久化，不保存密钥、完整手机号或姓名。正式系统用自己可靠的业务数据库；多实例须共享业务状态，不能各生成一套键。示例进程使用同一SQLite文件可共用已保存的键，不支持跨主机分别存一份数据库。业务编号不可随超时重建。

页面只展示文档，不会替你发出查名请求。Python/Node示例运行后会真实调用你配置的地址。只使用获授权号码。
