# 企业微信添加客户：发送前预览 rc.1

状态：**本地候选，未接入生产任务，未上线，新脚本未运行真机。**

- 分支：`codex/wecom-invite-preview-20261019`
- 基线：`650ecf8458cf94d5800e5e09614504600400a1b8`（已提交的集成代码，不代表本轮已核验生产版本）
- 不可变 annotated tag：`wecom-invite-preview-20261019-rc.1`；提交由 `git rev-parse wecom-invite-preview-20261019-rc.1^{commit}` 解析。
- 工作区开始干净；原 b684、查名、ADB 和小红书工作区均未改动。只合入本候选列出的新脚本/测试/文档，禁止整仓覆盖生产。
- 共同流程修订：2026-09-30，SHA256 `0a06c335eb36a017fc84bfdd4b067dedee27041e88ad746963f02f1f9a532e2b`。

## 已实现

入口位于 `windows-agent/scripts/wecom_invite_preview.py`。路径：消息首页右上角菜单 → 添加客户 → 搜索手机号添加 → 输入并读回核验 → 网络查找 → 个人信息及号码核验 → 添加为联系人 → 连续两次观察到“发送添加邀请”，返回 `ready_before_send` 并停止。

路径依据：[用户指定的企微添加流程](https://ncisb4cgbz.feishu.cn/wiki/WztHwTDKbihR7xkl896cDJ9knud) 与2026-10-19的67号手动界面探索。探索已确认“添加为联系人”后还有“发送添加邀请”确认页；本候选只适用于这个待验证的界面版本，不能据此推广其他版本或全设备。没有将文档中的操作指示当作真实发送授权。

本阶段不修改、保存备注/标签/邀请文案；文档中“手机号+车型”的备注保存有持久副作用，暂不实现。请求只接受 `phoneNumber` 与可选 `mode: "preview"`，额外字段和发送模式均拒绝。不会返回“添加成功”。

防误操作：

- 动作封闭为六项，包含一次号码输入；无发送邀请、发消息、保存备注、通用坐标点击或任意命令入口。
- 精确识别应用包、页面组合、唯一元素、输入值、搜索行完整号码、个人资料完整号码；遮挡/不可识别/歧义时停止或有界等待，不猜坐标、不重复输入或导航。
- 旧邀请页面不能冒充本次目标；冷启动只接受消息首页、添加菜单或添加客户页。旧资料页和旧搜索页要求人工回到起点。
- Poco动作前重读页面、验证设备独占租约、前台包、节点内容/位置/可见/可用以及取消/期限。页面变化后直接停止，不继续点旧位置。
- 登录失效、明确验证/频繁/上限提示、无此用户、已是联系人分类停止；不自动登录、不解验证、不换号、不绕过限制。
- 默认45秒/90轮观察预算；单动作异常视为执行未知，禁止自动重放；事件只包含步骤名，不含手机号、姓名、原始树或第三方异常。

## 本地复现（完全离线）

在仓根执行：

```bash
python3 -B windows-agent/scripts/test_wecom_invite_preview.py
python3 -B windows-agent/scripts/wecom_invite_preview.py --simulate releases/wecom-invite-preview-20261019-rc.1/synthetic-flow.json
python3 -B windows-agent/scripts/automation_runners_test.py
```

`synthetic-flow.json` 是人工构造的离线界面，号码为虚构夹具，**禁止提交给企业微信**。它不是真机元素树。CLI仅支持 `--simulate`，没有 `--live` 或 `--send` 参数，导入模块也不会连接手机或启动进程。

正常返回：

```json
{"status":"ready_before_send","code":"stopped_before_send","readyToSend":true,"invitationSent":false,"remarkSaved":false,"stage":"preview"}
```

`readyToSend` 只表示本次流程已到预览页，并非发送授权，也不能触发后续发送。`invitationSent:false` 表示本脚本没有执行发送动作，不是对外部人工/其他控制器的结果审计。

异常统一 `status: stopped`，`readyToSend:false`，例如 `phone_readback_mismatch`、`profile_phone_mismatch`、`preview_target_unverified`、`human_required`、`login_required`、`not_found`、`already_contact`、`device_lease_lost`、`page_changed_before_action`、`timeout`、`executor_error_no_replay`。不得对后两类自动重跑；先核对页面，不根据错误重发申请。

## 接入边界与未验项

脚本提供 `run_preview(driver, request)` 和 `PocoPreviewDriver(existing_poco, foreground_callback, lease_valid_callback)`，复用宿主已经建立的有界Poco连接。宿主负责真实设备映射、任务独占锁、正常打开已登录企业微信、RPC时限/外层进程看门狗及退出后资源释放。回调必须读实际租约和前台包，不能用固定true冒充锁。只有在租约覆盖整次运行、排除其他控制器时才可使用。

**本候选没有将此入口注册到Agent、平台界面或公开API**，也不新增独立ADB/安装器/恢复脚本。先交付发送前脚本及本地验证；接入调度是后续阶段，不能直接在生产运行测试命令来代替集成。没有改依赖、既有worker、全局调度、SYSTEM/ADB身份、keys、启动方式或冻结媒体控制文件。

本轮实际：Python3.9.6；35项新测试、20项原执行器回归、离线CLI完整路径、AST解析与diff检查。中途慢加载夹具不断交替空白导致无法连续两帧就绪，首轮30过1失败；修正为每阶段一次延迟后通过，并补齐输入后加载等待、过期搜索行以及禁用发送按钮的防误操作测试。只做自审，未冒充独立审查。

未验：真实67号Poco的菜单contentDescription/输入框/搜索行/预览树，Windows原生执行，租约集成及其他企微版本。缺少精确无障碍标签时预期会停止，不会用截图坐标兜底。之前的67号人工探索不等于新脚本验收。没有新生产访问、真机任务、邀请发送、推送或部署；不宣称全部机型可用。

## 后续与回退

后续获准时先在67号空闲状态采集脱敏元素证据，验证此脚本全过程仍停在发送前；若元素不同只新增有证据的定位规则，保持发送禁区。接入任务必须复用平台设备锁，安排单机灰度，不能绕过当前控屏占用。任何真实发送功能均需另立需求与授权，本候选不能通过一个参数打开。

本地回退只撤销本次候选提交或停止引用新模块；未改生产，所以无需停止服务、回滚数据库或重建ADB。未来发布前仍须重新核对ACTIVE和实际文件hash、准备回滚、遵守D-075及当次发布授权。文件SHA256和测试证据见同目录 `MANIFEST.json`、`VERIFICATION.json`。
