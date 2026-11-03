# 企业微信加客户：系统对接接口

CPS专用接入请见[CPS客户下发、结果回传与全部设备状态](./cps-wecom-integration-api.md)（本地候选，未上线）。以下为既有Bearer接口，鉴权及业务字段与CPS协议不同。

**接口已随2026-11-02版本发布，完整真机API验收尚未完成。** 对接流程：先查询设备，再提交添加任务，最后查询任务结果。手机编号和主应用／分身由调用方选择；搜索、备注保存、发送、锁定及防重都在平台内部执行。原自动化页面和旧接口保持原样。

**发送前测试边界：** 对外提交接口当前只创建真实发送任务，不支持预览模式。不要为“只到发送前”调用本节POST；传入`mode: "preview"`会被拒绝，去掉该字段会变成发送任务。内部预览接口与外部发送接口是两条不同合同，内部预览通过不代表外部发送全流程验收通过。

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

## 可选执行诊断（2026-11-02发布版本）

提交字段不变。已发布云端与配套Agent可在终态GET附带`execution`；旧任务或旧Agent可能没有此字段，不能从旧失败记录补出原始原因。它只用于定位，不是重试或发送许可，也不是实时阶段订阅；字段存在也不代表所有机型已通过验收。

| execution字段 | 含义 |
|---|---|
| version | 当前为1 |
| phase / failurePhase | 最后记录的阶段／捕获错误的阶段；尚无异常事件时failurePhase为空 |
| elapsedMs | 子进程内单调时钟累计毫秒，不是接口耗时 |
| cleanupConfirmed | true仅表示执行器自己的工具进程及转发清理按既有检查完成；false未确认；null没有清理回执。不证明其他应用或整台手机状态 |
| events | 最多24条固定阶段begin/end/error，包含step及elapsedMs；不含号码、备注、页面文本、Token或原始异常 |
| transportFailure（可选，本地候选） | 首次RPC失败的固定reason、errorType、elapsedMs及可选数值errno/winerror。不是原始异常文本；缺失表示没有有效诊断，不能反推没有通信故障 |

### 失败原因与处理建议（2026-11-03本地候选，尚未上线）

任务结果新增可选`errorInfo`，外部GET结果直接返回该对象，内部任务放在`result.errorInfo`。既有`status`、`code`、防重、发送及清理合同不变；正在排队/执行或正常停在发送前时不附加错误。对接方兼容字段缺失，不能据此自动重试。

```json
{"category":"transport","message":"读取通道等待响应超时，操作交付未确认","phase":"recipient_search","phaseLabel":"客户搜索","outcomeUnconfirmed":true,"action":"发送或保存结果尚未确认，请勿重复提交。核对原任务及手机日志；有匹配证据后再处理原因，不自动重放。"}
```

| category | 问题 | 处理 |
|---|---|---|
| login / human | 未登录、需要人工验证或解锁 | 在对应手机处理，先核对原任务 |
| device_connection | 单机连接或执行端未就绪 | 检查对应连接；不重建共享ADB或切身份 |
| device_busy | 占用、独占权丢失、清理等待 | 等待原占用，不强退其他任务 |
| configuration | 编号映射或主号/分身未配置 | 按设备目录核对，不能自动换账户 |
| page_compatibility | 页面结构、目标号码或前台不符合预期 | 根据phase排查适配，不盲点 |
| transport | RPC读超时或断连，操作交付未确认 | 查原任务和单机日志，不自动重放；不能仅凭超时认定ADB故障 |
| timeout | 阶段等待超时、组件未就绪 | 核对phase，不能只扩大等待或重新提交 |
| cleanup | 工具清理未确认 | 保留单机占用，核对原工具归属，不能直接清锁 |
| result_unconfirmed | 备注保存、发送凭据或实际发送待核对 | 查看原任务及手机实际结果，不重复保存/发送 |
| business_stop | already_contact已添加；not_found本次未找到 | 均不是本次发送成功；按具体code处理 |
| test_environment | 隔离测试授权、缓存或通道归属检查失败 | 检查测试环境，不能当成企微页面故障 |
| internal | 暂未分类的中止 | 保留taskId、code和phase交给维护人员 |

`outcomeUnconfirmed`与原因分开：即使原因是登录或页面变化，只要保存/发送状态unknown或任务stalled，仍须先核对原结果。false也不等于允许重试，更不表示邀请已送达。`transportFailure.reason`只区分固定的连接/读取超时、断连和归属核验失败等类型，不包含根因猜测；无现场证据不会自动修改手机设置。

阶段包括`configuration`、`adb_identity`、`device_preflight`、`screen_prepare`、`poco_launch`、`poco_health`、`wecom_launch`、`rpc_setup`、`startup_guards`、`foreground_wait`、`selector_observe`、`selector_click`、`home_navigation`、`recipient_search`、`remark_edit`、`remark_save`、`send_claim`、`invitation_send`、`cleanup`。父进程超时保留已收到的阶段；没有回执时不虚构清理成功。

| code示例 | 含义与处理 |
|---|---|
| screen_prepare_timeout / screen_wake_not_confirmed | 屏幕准备超时／未确认唤醒；核对手机，不自动重发 |
| device_unlock_requires_user | 系统锁屏需要本人处理；不输入密码或修改设置 |
| poco_not_ready | 已有读取组件未就绪，不代表未操作；核对原任务及备注状态 |
| adb_io_timeout | 本任务对原有ADB的单次I/O超时；不重启、切身份或重发 |
| wecom_launch_not_ready | 指定账户应用未在前台等待预算内确认；结合selector阶段核对，不重复点账户 |
| home_navigation_timeout | 回首页超出阶段预算；不在未知页面继续操作 |
| already_contact | 已核对目标号码且该账户已添加该客户；不会再填写备注或发送邀请，按已存在处理，无需重试本次任务 |
| wecom_preview_worker_timeout_no_replay | 父进程最终看门狗超时；保持unknown保护，查看最后阶段，不重放 |
| preview_cleanup_unconfirmed | 本执行器清理未确认；核对工具与占用，不能当发送成功或安全重试 |

此版本保留父进程230秒看门狗与15秒取消清理宽限，不增加点击重试。阶段预算约束原始ADB逐块读取、RPC和请求的超时参数及调用前后检查；第三方同步调用／操作系统查询仍可能晚返回，父看门狗继续兜底，不能承诺每阶段严格硬实时。

`already_contact`保留现有结果合同：外部GET正常返回200，任务`status`为`failed`、`code`为`already_contact`。内部任务另外记录`sendStatus=not_attempted`和`invitationSent=false`，这两个内部字段不属于本节外部响应。该结果表示目标已存在的业务停止，不是“发送成功”，也不需要重新添加。2026-11-02发布源码包含已观测“客户详情”页面的同号码识别，仍须按实际机型验收，不从源码存在推断真机已通过。

## 超时、防重和重试

2026-11-02发布版本包含409 `wecom_cleanup_pending`：原任务结束后手机可能仍显示“企微清理待确认”，所有账户槽位暂停接新任务。以设备列表的available为准；原任务仍可查询，其他可用手机继续使用。清理确认不会改写原发送／保存结果，也不解除未知结果的防重限制。当日只读快照仍有未决清理义务；本地v2时钟合同/模型未上线，不能据此清锁或推断清理完成。

- POST超时或断线：若已有taskId，用GET查询；若任务号也没收到，保持原四个参数再POST，进行中或未知任务会返回原ID。不能换账户或改备注来“确认是否发送”。
- 云端重启后，已保存任务及发送凭据继续有效；Agent本地凭据仍按手机／槽位／好友保留，不因换请求而重发。
- 明确在发送及备注保存前结束、没有任何不确定副作用的失败任务，后续重新POST可能创建新任务，用于故障处理后的重试；因此不承诺所有失败永远复用原ID。未知发送／保存不会自动重跑。
- 防重受云端历史及本地发送凭据的保留范围约束；不能删除记录、换机或恢复旧备份来重发。本地发送凭据随Agent data备份保留。
- 400为参数不合法；401为缺少有效管理员身份；403为手机不在允许范围；409为目标／占用／参数冲突；429为当前容量已满；503为受理保存尚未确认。503不代表未操作，按原参数／原任务核对。

2026-10-29本地已用真实HTTP及模拟Agent测试四字段提交、整数手机编号、单双开、并发重复提交、防重、丢失任务号后复查、权限与服务重启；该次模拟没有连接生产或发送真实邀请，不能替代当前生产真机完整对接验收。

## 当前只读验收范围（2026-11-02）

当日实际外部HTTP已核：鉴权后设备全量/在线目录200、非法在线过滤400、不存在的任务404；内部旧preview任务经外部发送结果接口查询为404，没有冒充发送任务。读取平台缓存确认8台配置手机、9个槽位，覆盖4种机型/系统组合。目录的available是平台即时参考，不解除查名池占用排除或单机清理保护。当前账号返回的历史页没有send任务，尚未覆盖有效send任务结果200或新原生发送链路。

这次没有创建手机任务、修改备注或发送邀请，也没有完成发送前外部全流程；外部预览能力尚缺。版本以实际发布材料为准，不能将本地合同/时钟模型当成已上线补丁。


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

以上是2026-10-29的本地模拟记录，当时新增调用示例、隔离模拟与文档，没有改平台业务源码、界面或Agent。接口后续已随2026-11-02版本发布；模拟结果不核销完整生产真机、真实发送和自动送达识别的未验项。首次离线夹具未登记导致的测试准备失败已按“先登记、再模拟离线”修正，没有改平台同步规则。
