# 支付宝查名接入包

版本：lookup-pool-20261013-rc.1。**本地候选，新增设备池接口尚未上线。**

对外一次调用只传phoneNumber，HTTP直接返回`{ok:true,name:"**某"}`。手机号示例全部为合成号码。name保持页面实际显示的掩码形态；未查到返回`{ok:true,name:"",code:"not_found"}`，错误用非2xx和code，不能把空字符串都当成查名成功。

管理员单独交付BASE_URL、clientId和独立secret，在平台授权该客户端使用设备池。平台内部处理49台登记设备的选择、最多5台自动并发、账户准备/切换/冷却/人工接续。调用方不传设备ID，不轮询，不结束手机。用途引用由管理员登记一次。

## Node.js 18+

```js
import { OpenNameLookupClient } from "./node_client.mjs";
const client = new OpenNameLookupClient({baseUrl: process.env.PHONE_CLOUD_BASE_URL,
  clientId: process.env.PHONE_CLOUD_CLIENT_ID, secret: process.env.PHONE_CLOUD_SECRET});
const result = await client.lookupName("13800000000", {idempotencyKey: savedBusinessKey});
console.log(result.name);
```

## Python 3.9+

```python
import os
from python_client import OpenNameLookupClient
client = OpenNameLookupClient(base_url=os.environ["PHONE_CLOUD_BASE_URL"],
    client_id=os.environ["PHONE_CLOUD_CLIENT_ID"], secret=os.environ["PHONE_CLOUD_SECRET"])
result = client.lookup_name("13800000000", idempotency_key=saved_business_key)
print(result["name"])
```

SDK代签名；新同步方法默认HTTP等待190秒，服务端默认120秒、可配置最多180秒，代理读超时建议210秒。一次方法调用最多重试1次网络异常，保持原键并更新Nonce；不会自动重试业务503/504。实际业务先保存幂等键后调用，同业务断网/超时重试传原键。省略键会生成随机键，下一次单独调用不能保证与上次合并。SDK不替业务持久化键。

| HTTP/code | 处理 |
|---|---|
| 200/name | 保存页面姓名 |
| 200/not_found | 保存本次无姓名结果，不推断未实名 |
| 400/401/403/409 | 修输入、签名、授权或业务键冲突 |
| 429 | 按Retry-After退避，保留原业务键 |
| 503/manual/recovery/unknown | 平台接续/对账，后续同键重试；不要换键重查 |
| 504 | 本次等待到期，可能仍在执行；后续同键重试 |

原7个单设备会话接口及SDK方法保持兼容，详见OPEN_NAME_LOOKUP_API.md的旧模式章节；其设备白名单不自动授权新设备池。新接口没有202/任务ID/结果Webhook。临时PG与fake Agent测试不是49台/五台真机验收；发布和灰度另行安排。
