# 企业微信客户预览

此版本只完成搜索、备注核对和进入邀请确认页，**不会发送添加邀请**。管理员从平台顶部“企微客户预览”进入。生产启用状态以部署回执为准。

固定范围：23、25、43、59、93、145、157主应用，以及155分身（Android用户999）。编号与固定物理序列号同时校验；其他手机、应用槽位和发送选项均不接受。最多2个未终态预览；手机忙碌、离线或已有其他Poco会话时保护性停止，不抢占、不停止其他会话。

使用现有平台管理员登录返回的Bearer Token，接口前缀`/api/v1/user/automation`。普通用户、第三方查名API Key不具备本轮预览权限。

| 方法与路径 | 用途 |
|---|---|
| GET `/wecom-preview-devices` | 返回8台中的库存映射、Android用户与当前锁/在线可用状态 |
| POST `/wecom-preview-tasks` | 提交一个客户的发送前预览 |
| GET `/wecom-preview-tasks` | 本管理员最近100条预览 |
| GET `/wecom-preview-tasks/{jobId}` | 原任务状态与结果 |

提交只有三个字段，不接受`send`、`mode`、`androidUser`或重试次数：

```json
{
  "deviceId": "adb:<设备列表返回的实际序列号>",
  "phoneNumber": "<已授权测试手机号>",
  "requestId": "wecom-preview-demo-0001"
}
```

首次成功受理HTTP201，返回`{reused:false,task:{jobId,...}}`。同管理员、同requestId和同设备/号码，返回HTTP200及原job，**不重新操作手机**；同键换参数409。防重有效期受平台既有任务记录保留策略约束，不保证永久保存。达到2个未终态任务返回429，设备忙碌/离线409，白名单外403，鉴权失败401。

POST超时或5xx不能视为未提交。先GET列表按requestId找原任务，再查询原jobId；如需重试提交，必须保持同requestId和原参数。界面不会自动重新POST。不确定的备注保存、读取/输入/点击异常不自动重查或重复保存。Agent离线后原任务不自动重新排队执行；保留原任务等待状态/超时核对。

正常完成示例（task外层还含deviceId、deviceNumber、androidUser、requestId及时间）：

```json
{
  "task": {
    "jobId": "<原任务ID>",
    "status": "succeeded",
    "result": {
      "status": "ready_before_send",
      "code": "preview_ready",
      "invitationSent": false,
      "remarkSaveStatus": "not_needed"
    }
  }
}
```

`task.status`可能为queued/running/stalled/succeeded/failed/expired。只有`result.status=ready_before_send`说明已到发送前；failed/expired/stalled都不是添加成功。`result.code`给出停止原因，`remarkSaveStatus`为not_attempted/unknown/confirmed/not_needed；unknown须核对原任务和手机，不能自动创建另一请求来重放保存。

空白备注名补“测试客户”、空白描述补“接口联调测试”，其他字段和已有非空值保留。保存最多尝试一次，回读证明后才继续。真实拼图、登录失效、限制和陌生页面保护性停止，本轮不新增企微自动登录、切号或人工提醒发送功能。

Agent专用租约接口`GET /api/v1/windows-agents/{agentId}/wecom-preview-tasks/{taskId}/lease`只接受现有Windows Agent身份及tasks:read权限，复核原任务、job、锁、owner、物理设备、Android用户和有效期。它不是对外接口，不接收管理员Token或客户手机号。
