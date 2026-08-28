# 云手机短信 APK

`com.ztqc.smsrelay` 同时承担两类职责：

1. 作为 Android 默认短信应用，可靠接收、保存和展示文字短信；
2. 将短信和设备状态异步上报 Phone Cloud 私有中台，并保留失败重试队列。

文字短信的手机端可见性不依赖网络，也不把 OEM 的 `content://sms` 当作唯一真值。收到短信后，APK 先在同一个 SQLite 事务中写入永久消息表和上传 outbox，再分别镜像到系统 `content://sms`、异步上传中台。任一分支失败都不会丢掉源短信。

## 当前用户功能

- 会话列表、内容/号码搜索、未读计数；
- 会话详情、标记已读、验证码一键复制、正文复制、单条删除和整会话删除；
- 新建短信和会话内回复；
- 双卡选择；
- 系统新短信通知；
- 一键申请 Android 默认短信角色；
- 云端配置、设备心跳、短信库全量同步、APK 更新和扫码无障碍设置。

当前版本完整支持文字短信。默认短信角色要求 APK 声明彩信接收组件，因此收到彩信时会显示提示，但尚不下载或展示彩信正文；在彩信下载链路完成前不得把这一能力描述为已支持。

## 可靠性设计

- `SmsReceiver` 同时兼容默认短信应用的 `SMS_DELIVER` 和普通 `SMS_RECEIVED`；同一短信用事件指纹去重。
- 默认短信应用收到 `SMS_DELIVER` 时，先在一个 SQLite 事务内写入永久 `local_messages` 和待上传 `pending_sms`；成功后才返回到 Provider、通知和网络分支。
- `local_messages` 是手机端源数据，服务器 ACK 只删除 outbox，不删除本地消息。系统 Provider 写入失败时，本机界面仍从永久库展示该短信。
- `SmsProviderMirror` 独立修复尚未写入 `content://sms` 的本地消息；写入前按发件人、正文和接收时间检查精确重复，覆盖“Provider 已成功、状态回写前进程退出”的窗口。
- APK 持有默认短信角色时关闭旧短信应用通知兜底，并始终排除自身通知，避免自己发布的通知再次入队。
- 中台只有在 `/api/v1/sms-events` 返回持久化后的 `event.eventId` 时才算 ACK；超时、非 2xx、空响应或无 ACK 都保留 outbox。
- 每条 outbox 记录独立指数退避（约 2 秒起步，最高 5 分钟并带抖动）；一次 drain 最多处理 20 条，单条失败继续处理后续到期记录，防止坏记录阻塞整队列。
- `RelayForegroundService` 使用进程级单航班 drain，禁止多个入口并发上传同一批队列；`SmsUploadJobService` 使用持久化 `JobScheduler`，网络恢复、开机和 APK 更新后继续补传。
- 服务端把实时 `sms-event`、后到的 Provider 行和迁移期通知记录视为三个来源：实时事件优先于通知，Provider 最终补齐稳定 `_id`、卡槽等权威字段，但不更换已存在的平台消息 ID。
- `BootReceiver`、前台服务和 30 秒系统闹钟维持设备命令与短信同步；Windows 后续仍需检查进程与健康时间，不能只看“已安装”。
- 常驻服务使用 `remoteMessaging` 前台服务类型，不再使用 `dataSync`。这是 Android 15/16 的兼容硬边界：target 35 的 `dataSync` 在 24 小时内最多运行 6 小时，并且不能由 `BOOT_COMPLETED` 拉起；短信跨设备转发应使用 `remoteMessaging`。
- RoleManager、系统短信 Provider、SIM 订阅信息均按“标准 API 优先、OEM 受限时有界降级”处理。ColorOS 不完整的 role dump、Provider 不接受 `sub_id`、订阅列表抛运行时权限异常都不能导致进程崩溃；降级不得绕过默认短信角色，也不得丢弃 APK 私有永久库中的源短信。

## 当前机群兼容性基线

2026-08-21 对 Windows `192.168.20.123` 当时 ADB 在线的 **122 台**手机完成了只读预检；预检不安装 APK、不切换默认短信应用、不读取短信正文：

| 维度 | 覆盖结果 |
|---|---|
| Android | 10：15 台；11：10 台；12：9 台；13：6 台；14：76 台；15：5 台；16：1 台 |
| 厂商 | vivo 82；Xiaomi 19；OPPO 12；HUAWEI 6；HONOR 2；Tianyi 1 |
| ABI | `arm64-v8a` 110；`armeabi-v7a` 12；APK 无原生 `.so`，两类均可安装 |
| 机型/系统组合 | 31 种唯一组合 |
| 电话能力 | 122/122 声明 `android.hardware.telephony` |
| 短信角色入口 | 122/122 存在 RoleManager 或可解析的系统默认短信处理器 |
| 存储门禁 | 122/122 的 `/data` 可用空间不低于 32 MiB |
| 结论 | 122/122 通过；112 无提示，10 仅提示已安装旧 SmsRelay，不是兼容失败 |

主要样本包含 vivo V2357A（58）、V2442A（16）、小米 220233L2C Android 11 32 位（10）、OPPO PHJ110（3）、OPPO PKL110 Android 15（2）以及 OPPO PMC110 Android 16（1）。31 种完整组合由 `windows-agent/scripts/smsrelay_fleet_preflight.mjs` 每次从真实在线设备重新生成，不能把本表当作永久不变的资产清单。

预检命令只允许读取设备能力：

```powershell
D:\PhoneCloud\tools\node\node.exe `
  D:\PhoneCloud\agent\scripts\smsrelay_fleet_preflight.mjs `
  --adb D:\PhoneCloud\tools\android-sdk\platform-tools\adb.exe `
  --concurrency 8
```

兼容结论分三层，报告时不得混淆：

1. **全机只读能力通过**：当前 122 台已完成；只能证明系统、ABI、角色入口、电话能力和空间满足安装前提。
2. **产物兼容通过**：v109 的正式/隔离变体均完成 clean build；Android Lint 的 API、前台服务、JobScheduler、权限、导出组件和短信广播专项为 0 问题；合并清单为 minSdk 23、targetSdk 35、`remoteMessaging`，且没有原生库。
3. **实装业务通过**：v108 已在指定 Honor Android 15 测试机完成真实短信、断网永久入库、恢复补传和去重验收。v109 未在生产手机安装；在用户明确允许统一安装前，不得把前两层表述成“122 台都已实装收短信成功”。

`compatProbe` 构建类型使用隔离包名 `com.ztqc.smsrelay.compatprobe`，仅用于以后明确指定的测试机验证安装、前台服务和健康 Provider。它不请求默认短信角色、不访问生产中台；未经明确许可，禁止把正式包或探针批量安装到线上手机。

## Windows 健康与恢复接口

只允许 ADB shell（持有系统 `DUMP` 权限）调用，普通三方应用不能读取：

```powershell
adb -s <serial> shell content query --uri content://com.ztqc.smsrelay.health/status
adb -s <serial> shell am start --user 0 -n com.ztqc.smsrelay/.RecoveryActivity --activity-no-animation --activity-no-history
```

健康 JSON 包含默认短信角色、短信权限、服务最近存活时间、最近接收/同步时间、永久消息数、待上传数、Provider 写入失败数、最老积压时长和下次重试时间。**APK 安装成功就是 Windows 数据采集的切换边界**：该设备从此只走 `health_only`，Windows 不再查询 `content://sms`、不再读取短信通知；用户主动刷新只发送包级命令让 APK 自身同步并返回健康状态。即使默认短信角色尚未确认，也只能显示配置异常，不能回退到旧采集。Windows Agent 每分钟以最多 10 台并发查询空闲设备，只在“APK 已安装、仍是默认短信应用、RECEIVE_SMS 已授权但服务不存活”时启动受 `android.permission.DUMP` 保护、无界面且立即退出的 `RecoveryActivity`；不得为恢复 APK 重启全局 ADB、Hub 或其他手机，也不得读取或记录短信正文。

Android 的 force-stop 会把包置于 stopped 状态并停止向其投递普通广播。Honor Android 15 实测即使显式广播带 `--include-stopped-packages` 也不会创建进程，因此 Windows 恢复必须启动受保护的 `RecoveryActivity`，由它拉起前台服务、上传任务和 Provider 镜像后立即退出；若 OEM 仍拒绝恢复，管理端应显示该设备健康异常并要求人工打开一次 APK，不能用全局 ADB/USB 重建扩大影响面。

## 本地构建

```bash
JAVA_HOME=/Applications/PyCharm.app/Contents/jbr/Contents/Home \
ANDROID_HOME=/opt/homebrew/share/android-commandlinetools \
./gradlew clean assembleDebug assembleCompatProbe --offline
```

产物：

- 正式候选：`app/build/outputs/apk/debug/app-debug.apk`；
- 隔离探针：`app/build/outputs/apk/compatProbe/app-compatProbe.apk`。

当前机群已安装旧包及 v109 候选使用同一签名：证书 SHA-256 为 `6624f72a94bb26d7a81f4945460e8a04cc342a2ebef64a5ca01a7e2f04e5e32d`，Android `dumpsys package` 短摘要为 `673fe1b3`。已检查的 10 台旧包摘要全部一致。统一安装前必须再次核对候选证书；证书变化会让覆盖升级失败并迫使逐台卸载，签名私钥必须作为生产资产安全备份，不能提交仓库或只依赖可丢失的临时构建环境。

## 实机验收门禁

只允许在指定测试手机执行，不能批量切换生产手机默认短信应用：

1. 升级安装后原有系统短信仍可见；
2. 申请默认短信角色成功，`dumpsys role` holder 唯一；
3. 单卡、双卡各接收一条真实短信，手机入库和系统通知正常；
4. 新建、回复、长短信、复制、删除、搜索和未读状态正常；
5. 断网收短信后手机可见，恢复网络后待上传队列清零且中台仅一条；
6. 杀进程、锁屏、重启和 APK 覆盖升级后仍能接收/补传；
7. Windows 健康查询与精确 `RecoveryActivity` 只影响目标手机；
8. 验证完恢复原默认短信应用并确认短信未丢失。

统一安装还必须满足：候选 `versionCode >= 109`、签名与上文基线一致、全机只读预检 `fail=0`、指定测试机完成 v109 实装业务门禁，并获得明确的生产安装许可。只读预检通过本身不授权安装。
