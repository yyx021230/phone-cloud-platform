# 支付宝查名字接入包

版本：platform-api-integration-20261012-rc.3。业务基线platform-api-entry-20261012-deployed.1。

先读OPEN_NAME_LOOKUP_API.md，再导入openapi.json。sign.mjs供门户Node.js请求示例导入；SDK无需这个辅助文件。node_client.mjs和python_client.py来自已审阅业务源码7f695507761b07504a94b7372de0c340befbf33f的SDK，本轮代码未修改。

管理员单独交付BASE_URL（当前`http://47.98.127.132`）、clientId、至少32字符独立secret、精确deviceId白名单和人工操作账号。包内不包含真实凭据或手机号。

## Node.js 18+

```js
import { OpenNameLookupClient } from "./node_client.mjs";
const client = new OpenNameLookupClient({
  baseUrl: process.env.PHONE_CLOUD_BASE_URL,
  clientId: process.env.PHONE_CLOUD_CLIENT_ID,
  secret: process.env.PHONE_CLOUD_SECRET
});
const { devices } = await client.listDevices();
// 从自身持久化业务记录读取键，先保存再调用；以下仅演示单个请求。
const { session } = await client.createSession(devices.find(d => d.available).deviceId,
  { idempotencyKey: "demo-session-0001" });
const { queryId } = await client.enqueueQuery(session.sessionId, {
  phoneNumber: "13800000000", clientReference: "demo-order-0001",
  consentReference: "demo-consent-0001"
}, { idempotencyKey: "demo-query-0001" });
const outcome = await client.waitForQueries(session.sessionId, [queryId], { timeoutMs: 60000 });
// 按下表处理outcome，再继续轮询原ID；决定完成/放弃时endSession并轮询终态。
```

## Python 3.9+

```python
import os
from python_client import OpenNameLookupClient
client = OpenNameLookupClient(base_url=os.environ["PHONE_CLOUD_BASE_URL"],
    client_id=os.environ["PHONE_CLOUD_CLIENT_ID"], secret=os.environ["PHONE_CLOUD_SECRET"])
devices = client.list_devices()["devices"]
device = next(d for d in devices if d["available"])
session = client.create_session(device["deviceId"], idempotency_key="demo-session-0001")["session"]
accepted = client.enqueue_query(session["sessionId"], {
    "phoneNumber": "13800000000", "clientReference": "demo-order-0001",
    "consentReference": "demo-consent-0001"
}, idempotency_key="demo-query-0001")
outcome = client.wait_for_queries(session["sessionId"], [accepted["queryId"]], timeout=60)
# 按下表处理后继续原ID；决定完成/放弃时end_session并轮询终态。
```

| SDK state | 动作 |
|---|---|
| completed | 查询都进入终态，仍需区分succeeded/not_found和失败/取消，再保存结果 |
| human_action_required | 人工完成后平台自动接续优先，继续轮询原ID，不立即resume或新建查询 |
| queue_paused | 看session.queueState.action；retry_current_query才恢复原queryId，end_session_and_select_another_device才结束并换设备 |
| timeout | 仅本次轮询超时，可继续同sessionId/queryId，不创建第二条业务 |

SDK默认可生成随机幂等键；实际业务必须显式传入已持久化的键。同次网络重试沿用原键。SDK不自动重试网络异常、不会自动持久化关联或在异常时结束会话，调用方需实现自己的生命周期。enqueueMany/enqueue_many按数组顺序逐条受理，跨进程仍以服务端到达顺序为准。

当前第三方接口返回掩码姓名和姓名末字，不保证完整实名；没有结果Webhook，按2–5秒轮询。现有客户端在177/161已完成有界HMAC真机闭环；新合作方独立签名/隔离、自然8小时到期等仍待验收，详见独立说明。
