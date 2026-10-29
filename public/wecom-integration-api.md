# 企业微信加客户：系统对接接口

**本地候选，尚未上线。** 对接流程：先查询设备，再提交添加任务，最后查询任务结果。手机编号和主应用／分身由调用方选择；搜索、备注保存、发送、锁定及防重都在平台内部执行。原自动化页面和旧接口保持原样。

## 0. 查询设备：在线、占用及可选账户

`GET /api/v1/wecom/devices`

沿用下文管理员Bearer鉴权。默认返回平台全部设备，包含离线和未配置企微的手机；只看在线使用 `GET /api/v1/wecom/devices?onlineOnly=true`。不启动ADB扫描、恢复或手机操作，读取平台已有心跳和任务状态。

```json
{
  "devices": [{
    "deviceNumber": "59",
    "deviceName": "59",
    "online": true,
    "adbOnline": true,
    "agentOnline": true,
    "listed": true,
    "busy": false,
    "busyReason": "",
    "occupancy": null,
    "wecomAllowed": true,
    "appSlots": [{"appSlot": "main", "label": "主应用"}],
    "available": true,
    "unavailableReason": "",
    "model": "<机型>",
    "brand": "<品牌>",
    "androidVersion": "<系统版本>",
    "batteryLevel": 85,
    "lastSeenAt": null,
    "adbLastSeenAt": "<最近ADB状态上报时间>"
  }],
  "total": 1,
  "updatedAt": "<本次列表生成时间>",
  "capacity": {"limit": 2, "active": 0, "remaining": 2}
}
```

| 字段 | 如何使用 |
|---|---|
| deviceNumber | 后续提交用的手机编号；非编号名称的设备可能为null，以deviceName展示 |
| online | 平台判断在线：ADB或手机Agent心跳有效；不等于可执行企微 |
| adbOnline / agentOnline | ADB通道／Windows Agent心跳是否有效；企微执行都需要 |
| busy / busyReason | 是否有平台占用及中文原因，如实时控制、企微加客户、等待短信、其他任务执行中 |
| occupancy | 占用类型type及中文label；无占用为null，不返回占用人的身份或客户信息 |
| wecomAllowed | 是否有唯一、匹配的本轮企微映射；未配置、映射冲突时false |
| appSlots | 可以选择的主应用／分身，不需要对方猜测；未知映射为空数组 |
| available | 当前符合本轮企微单机提交条件；应只选择true的手机 |
| unavailableReason | 不能选择的原因，如device_busy、adb_offline、agent_offline、device_not_listed、wecom_not_configured或device_number_conflict |
| capacity.remaining | 当前还可受理多少条企微任务；为0时等待，不抢其他任务 |

对接方可每5秒刷新设备列表，优先 `available=true`，从返回的appSlots选择账户。列表不会主动释放或回收锁，尚未释放的占用会保守标为busy。列表中所有在线手机不代表都允许运行企微；未加入本轮配置的设备也能查看在线/占用，但available=false。单机available和全局capacity都是瞬时参考，不预留设备；提交时仍会复核占用/容量，竞态可返回409/429。

`updatedAt`是响应生成时间，设备新鲜度看lastSeenAt/adbLastSeenAt；available不证明企微已登录或不会出现验证。接口不暴露SIM号码、ADB序列号、任务所有人或其他客户资料。

平台原有 `GET /api/v1/user/devices`（上架设备，含online/busy/occupancy）和管理员 `GET /api/v1/devices`（全部设备的完整管理视图）继续保留。新企微对接推荐统一使用本节接口，避免自行拼接旧列表和应用配置。

## 1. 提交任务

`POST /api/v1/wecom/customer-invitations`

请求头：`Authorization: Bearer <平台管理员令牌>`、`Content-Type: application/json`。沿用现有管理员身份及权限；普通用户令牌、查名API Key不能调用。此版本没有另行开通独立的企微第三方API Key，不能当作匿名公共接口。

```json
{
  "deviceNumber": "59",
  "appSlot": "main",
  "phoneNumber": "<好友手机号>",
  "remarkName": "yyx（坦克）"
}
```

| 字段 | 含义 |
|---|---|
| deviceNumber | 平台手机编号，支持数字或数字字符串，如59或"59"；不用传ADB设备ID |
| appSlot | main主应用／clone分身；只有一个已配置应用时可省略，双开手机必须明确选择 |
| phoneNumber | 好友11位大陆手机号字符串 |
| remarkName | 备注名，最多20个Unicode码点；选填，空白默认“测试客户” |

无需传requestId、执行模式、Android用户、描述、重试次数或租约。这个接口就是单次真实添加任务：备注名按填写内容更新，空白默认值也会更新已有名称；其他信息沿用既有保护规则。

首次受理HTTP202：

```json
{
  "taskId": "<任务号>",
  "deviceNumber": "59",
  "appSlot": "main",
  "status": "queued",
  "code": "",
  "message": "任务已受理，等待执行",
  "reused": false
}
```

**保存taskId**。同一账户、同一好友进行中，或先前发送／保存状态仍待核对时，重复POST同参数返回HTTP200、`reused:true`及原taskId，不再创建任务。修改备注等参数返回409及原taskId，不改写正在执行的任务。手机编号多重映射、未配置分身、离线、占用、无权限或容量不足会直接拒绝，不换手机／账户替代。

目前开放23、25、43、59、93、145、155、157；155支持main／clone，其他7台仅支持main。外部不需要了解Android用户数值。同一手机两套应用不能同时执行，最多2个未终态任务；不自动抢占其他任务或控屏。

## 2. 查询结果

`GET /api/v1/wecom/customer-invitations/{taskId}`

沿用上述Authorization。建议每2秒查询一次，收到终态停止轮询。

```json
{
  "taskId": "<原任务号>",
  "deviceNumber": "59",
  "appSlot": "main",
  "status": "unknown",
  "code": "invitation_click_issued_delivery_unknown",
  "message": "执行结果待核对，请勿重复发送"
}
```

| status | 调用方处理 |
|---|---|
| queued | 已受理，继续查询原taskId |
| running | 正在执行，继续查询原taskId |
| needs_attention | 需要处理登录／验证等；显示message，不自动换账户重试 |
| unknown | 发送／保存或任务执行状态待核对；停止自动重发，保留原任务 |
| failed | 本次未完成，按code核对；不要无条件循环POST |

**本版没有自动对端送达／好友接受确认。** 原生发送调用返回不等于对端收到；未知结果不会伪装成“添加成功”。`reused`只在提交响应出现，与执行成功无关。旧预览任务不能通过这个结果接口冒充添加任务，也不能读取其他管理员的任务。

## 超时、防重和重试

- POST超时或断线：若已有taskId，用GET查询；若任务号也没收到，保持原四个参数再POST，进行中或未知任务会返回原ID。不能换账户或改备注来“确认是否发送”。
- 云端重启后，已保存任务及发送凭据继续有效；Agent本地凭据仍按手机／槽位／好友保留，不因换请求而重发。
- 明确在发送及备注保存前结束、没有任何不确定副作用的失败任务，后续重新POST可能创建新任务，用于故障处理后的重试；因此不承诺所有失败永远复用原ID。未知发送／保存不会自动重跑。
- 防重受云端历史及本地发送凭据的保留范围约束；不能删除记录、换机或恢复旧备份来重发。本地发送凭据随Agent data备份保留。
- 400为参数不合法；401为缺少有效管理员身份；403为手机不在允许范围；409为目标／占用／参数冲突；429为当前容量已满；503为受理保存尚未确认。503不代表未操作，按原参数／原任务核对。

本地已用真实HTTP及模拟Agent测试四字段提交、整数手机编号、单双开、并发重复提交、防重、丢失任务号后复查、权限与服务重启。没有连接生产或发送真实邀请；新版本Windows原生、Postgres和真机完整对接仍未验。


## 对接代码与本轮完整模拟验收

可选Node客户端示例：`examples/wecom-integration/client.mjs`，无额外npm依赖，调用只涉及上述三个接口；其他语言仍按HTTP合同接入。示例不会读取.env、不会自动重试POST，Token只放Authorization头，网络异常只报告“受理/执行结果未知”。

```javascript
import { WecomClient } from './client.mjs';
const api = new WecomClient({ baseUrl, token });
const inventory = await api.devices({ onlineOnly: true });
// 由对接系统选择 available=true 的设备及返回的 appSlots，检查 capacity.remaining。
const task = await api.submit({ deviceNumber, appSlot, phoneNumber, remarkName });
// 先把 task.taskId 持久化到对接系统，再按原ID每2秒查询；不要轮询POST。
const result = await api.result(task.taskId);
```

以下是2026-10-29本地实际HTTP验证，不是真机或生产验收。调用端经过本地HTTP网关，后台假Agent通过原Node子进程包装器，执行真实备注/发送算法，页面采用合成Poco夹具；未执行Windows启动/ADB适配器。

| 场景 | 实际结果 |
|---|---|
| 全量及在线列表 | 10台已登记模拟设备，9台在线；未配置企微的在线手机不可选；155返回main/clone |
| 同时重复提交 | 6次相同POST只得到1个任务号、1个执行任务 |
| 同一手机双开互斥 | main执行期间clone提交被409拒绝，未自动换账户 |
| 不同手机并行 | 155/main停在发送前时，59/main独立完成；155原任务仍running |
| 主应用与分身 | 155/main绑定0、155/clone绑定999，各1次搜索、保存、模拟发送；备注保存并回读确认 |
| POST响应丢失 | 网关保留已受理响应，客户端100ms真实HTTP超时；原四字段再提交取回原任务，分身只模拟发送1次 |
| claim响应丢失 | 模拟执行器丢弃已持久化claim的回应后停止，0次模拟发送，结果unknown |
| 服务重启后再提交 | 取回原任务号和unknown结果，无新增执行任务 |
| 非法/越权请求 | 白名单外、未配置分身、非法号码、额外字段、失效Token、普通用户、跨管理员查结果、重复编号均按合同拒绝 |

共4个模拟执行任务：4次搜索、4次备注保存、3次模拟原生发送点击；另一条claim未知保持0点击。真实手机操作和真实邀请均为0。`unknown`没有伪装成收到邀请或已加好友。Node定向52项、企微Python135项通过，二者覆盖有重叠；没有用这些数量替代Windows原生、真实Postgres或真机灰度。

复现完整外部调用模拟（仓库根目录；只创建本地临时服务/数据/假设备）：

```sh
node --test --test-concurrency=1 server/wecom-integration.e2e.test.mjs examples/wecom-integration/client.test.mjs
```

本轮未改平台业务源码、界面或Agent；新增的是调用示例、隔离模拟与文档。当前仍未推送/上线，新Windows原生、真实Postgres、真实手机发送和自动送达识别仍待后续验收。首次离线夹具未登记导致的测试准备失败已按“先登记、再模拟离线”修正，没有改平台同步规则。
