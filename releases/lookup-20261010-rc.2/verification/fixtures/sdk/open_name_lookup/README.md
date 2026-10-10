# 支付宝查名字 Open API 客户端

这里提供两个无第三方依赖的客户端：

- Node.js 18+：`node_client.mjs`
- Python 3.9+：`python_client.py`

它们统一封装 HMAC、时间戳、Nonce、JSON 原文签名、幂等键、批量顺序入队、状态轮询、人工拼图暂停和结束会话。完整字段和错误语义以 [`docs/OPEN_NAME_LOOKUP_API.md`](../../docs/OPEN_NAME_LOOKUP_API.md) 为准。

## Node.js

```js
import { OpenNameLookupClient } from "./sdk/open_name_lookup/node_client.mjs";

const client = new OpenNameLookupClient({
  baseUrl: process.env.PHONE_CLOUD_BASE_URL,
  clientId: process.env.PHONE_CLOUD_CLIENT_ID,
  secret: process.env.PHONE_CLOUD_CLIENT_SECRET
});

const { session } = await client.createSession("adb:SERIAL-ONE");
const accepted = await client.enqueueMany(session.sessionId, [{
  phoneNumber: "13800000000",
  clientReference: "order-000001",
  consentReference: "consent-000001"
}]);
const queryIds = accepted.map((item) => item.queryId);

while (true) {
  const outcome = await client.waitForQueries(session.sessionId, queryIds);
  if (outcome.state === "human_action_required") {
    // 通知管理员进入网页控屏。管理员完成拼图并结束控屏后，再继续。
    await waitForYourOperator(outcome.session.humanAction);
    if (outcome.session.humanAction.resumeAllowed) {
      await client.resume(session.sessionId, outcome.session.humanAction.queryId);
    }
    continue;
  }
  console.log(outcome);
  break;
}

await client.endSession(session.sessionId);
```

## Python

```python
import os
from sdk.open_name_lookup.python_client import OpenNameLookupClient

client = OpenNameLookupClient(
    base_url=os.environ["PHONE_CLOUD_BASE_URL"],
    client_id=os.environ["PHONE_CLOUD_CLIENT_ID"],
    secret=os.environ["PHONE_CLOUD_CLIENT_SECRET"],
)
devices = client.list_devices()["devices"]
session = client.create_session(devices[0]["deviceId"])["session"]
accepted = client.enqueue_many(session["sessionId"], [{
    "phoneNumber": "13800000000",
    "clientReference": "order-000001",
    "consentReference": "consent-000001",
}])
outcome = client.wait_for_queries(
    session["sessionId"], [item["queryId"] for item in accepted]
)
```

`enqueueMany/enqueue_many` 为保证调用数组与服务端队列顺序一致，会逐条提交；接口本身仍允许多个调用进程并发入队。幂等键可以由客户端自动生成，也可以在每个待入队对象中传入稳定的 `idempotencyKey`，供业务请求重试时复用。

`waitForQueries/wait_for_queries` 返回四种状态：

- `completed`：传入的查询都进入终态。
- `human_action_required`：队列因拼图暂停；按 `humanAction` 通知管理员处理。
- `queue_paused`：本机保存账号全部受限，应结束会话并换设备。
- `timeout`：只代表本次等待超时，可继续使用同一 `sessionId/queryId` 轮询。

密钥只应保存在服务端环境变量或密钥管理器中，不能把客户端直接打包到浏览器前端。
