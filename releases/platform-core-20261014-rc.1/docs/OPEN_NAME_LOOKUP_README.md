# 支付宝查名SDK（lookup-async-20261014-rc.8，本地候选未上线）

调用方只提交手机号、记录lookupId，再由独立定时任务获取结果。签名与业务键在请求头，由SDK封装。先持久保存业务键再发送：SDK不替业务数据库保存；同次调用最多重试1次网络错误并复用键/更新Nonce，503不自动变成新查询。即使取结果等2分钟后换键重提，同客户同号码在途也合并到原任务；近期succeeded/not_found固定完成后10分钟复用。

```js
const accepted = await client.submitLookup("13800000000", {idempotencyKey: savedBusinessKey});
// 保存accepted.lookupId；下轮定时任务读取
const result = await client.getLookupResult(accepted.lookupId);
if (result.status === "succeeded") console.log(result.name);
```

```python
accepted = client.submit_lookup("13800000000", idempotency_key=saved_business_key)
# 保存lookupId；下轮定时任务读取
result = client.get_lookup_result(accepted["lookupId"])
if result["status"] == "succeeded":
    print(result["name"])
```

示例号码为合成。SDK两个新方法默认30秒HTTP，结果接口即时返回queued/processing/succeeded/not_found/failed。HTTP200/ok:true只说明成功读取，只有succeeded有姓名。每个号码查到即可读取，不等整批完成。GET重试无手机副作用，建议5秒间隔、429遵循Retry-After；网络/认证/服务错误不等于业务无姓名或失败。保存的lookupId/业务键跨定时任务复用，回填失败只重读原结果，不再提交号码。

Node/Python SDK rc.8：构造器超时配置对异步提交和读取生效（默认30秒，可单次覆盖）。默认HTTP实现的每次尝试覆盖连接、响应头和完整正文；一次提交最多2次尝试，各有独立预算，整个方法可能用到约60秒。Python自定义opener需自行遵守传入timeout，SDK不能强制中断任意外部代码。成功状态正文断开/超时为`network_error`，提交原键重试一次；GET由下轮按原ID重读。已知HTTP错误即使正文断开仍保留状态，不自动重提。429的退避秒数为Node `error.retryAfterSeconds` / Python `error.retry_after_seconds`（无有效头为null/None）。非JSON/非对象的成功正文为`invalid_response`，不当作查名成功、不自动重提；保留原业务键/ID等待重读。HTTP超时不取消服务端任务。

可运行的两个独立任务及调用方进程重启范例见 [PARTNER_HANDOFF.md](PARTNER_HANDOFF.md) 和 `partner_example.py`；提交前持久保存业务键、逐个获取结果后单独落库。SQLite仅用于演示，迁移到对方业务库时必须保留事务/唯一键语义。

平台执行预算默认首次受理起60分钟、未开始排队30分钟，人工等待30分钟；过预算先停止/对账，未知执行保留预约，不承诺离线设备硬停止。已收到的原查询成功/明确无姓名结果优先保存，后续停止处理不覆盖；未确认停止仍保留设备预约及原任务绑定。原结果/别名持续保留（至少7天，无自动删除），与固定10分钟近期复用分开；每任务50别名上限。同clientId范围内合并，不跨客户泄露或永久按号码缓存。

原lookupName/lookup_name同步方法与7个会话SDK方法兼容，签名规范不变。新增服务端/别名迁移须配套、生产未更新；模拟Agent/本地PG测试不是五台真机或生产验收。完整协议见OPEN_NAME_LOOKUP_API.md、OpenAPI与SHA256清单。
