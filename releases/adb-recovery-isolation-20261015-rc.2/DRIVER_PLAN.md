# 驱动安装冲突处理方案（未执行）

## 已知证据与目标

15:14–15:31现场：`android_winusb`/`hn_goadb`反复覆盖System32同名co-installer，要求另一包重配置；Windows记录Error482和当前ADB进程的移除否决。59、143、91参与重配置，116等待，130/158后续排队。证据见主文档7.15.8和 `docs/evidence/ADB_STABILITY_AUDIT_20261015.json`。

162先前仅一个接口切到inbox驱动，其他手机及USB模式仍使用OEM包。因此单台成功不能当成全机冲突已根治；首次USB消失是否包含供电/线缆问题仍待独立定位。

目标是取消已确认目标对冲突co-installer的依赖，不通过反复重装、杀安装器或重启ADB让队列暂时消失。

## 分阶段处理

1. **先上线本候选的隔离能力，再进行任何目标驱动维护。** 对确认反复参与冲突的目标暂停自动恢复，看到新鲜ACK后才进入下一步；已启动安装自然收尾。其他手机继续在线检测与业务。当前本候选未上线，不能把它当现场现有能力。
2. **独立Windows验证**：只接一台获准空闲目标，确认设备编号→序列号→当前present接口→父级/端口一一对应。采集旧INF/section/版本/签名/设备接口GUID与硬件兼容ID，导出原驱动包及单设备注册表备份，生成hash和操作预览；不读取/复制授权密钥内容。
3. 枚举该精确接口的原生兼容驱动列表。只有原生列表包含已签名Microsoft `winusb.inf` 的 **ADB section** 且接口确为ADB协议时，才列入绑定候选。必须实际验证ADB可发现的接口GUID；普通“WinUSB USB设备”不自动视作兼容ADB，禁止对Composite、Hub、MTP接口套用ADB驱动。162的既有兼容结果不能套给130/143或所有品牌。
4. 独立环境完成绑定、只读ADB识别/连接、自然重枚举、Agent暂停/解除以及两台不同品牌共存验证；记录是否要求重启、是否仍覆盖共享DLL、是否出现批外重配置。不同USB模式仅在另获授权的测试范围内验证，不让自动脚本改变手机模式。
5. **生产先申请具体单机窗口**：逐次重新核对该手机空闲、映射、兼容列表、备份和安装队列。一次只处理一个精确实例，不批量删除/升级OEM包，不按VID全选。若Windows需要释放共享ADB占用，当前操作停止，另报全体连接影响并请求共享维护；不得自行杀ADB、DrvInst、改身份或端口来绕过。
6. 绑定后核对目标INF/section/签名与present状态，使用已确认存在的原SYSTEM SDK server只读检查；同时比较其他设备集合、现有控屏、安装队列、SetupAPI共享DLL写入/482及当前PID事件225。目标连续稳定观察至少30分钟且其他手机无新增持续异常，再决定第二台；24小时无复发才讨论扩大。观察时长是验收要求，不是本轮已取得结果。

## 停止与回滚

出现目标映射不唯一、兼容驱动缺失、安装器忙/状态未知、ADB owner/path/listener异常、签名异常、要求Windows重启、批外设备掉线或控屏受影响时立即停止；不强行推进下一台。

回滚依赖该目标的旧驱动包及原绑定清单。恢复旧OEM绑定本身可能再次触发共享文件冲突，必须保留暂停并在获准窗口执行；不能因“回滚”直接全局重装包或恢复System32 DLL。若安全回退条件未满足，保持目标隔离及当前服务，不扩大操作。未知首次USB掉线继续只读采集端口/供电/USB日志，硬件排查仅对确认目标另行安排。

## 身份及发布不变量

生产共享ADB和Agent始终SYSTEM，SDK路径与5037固定。两份既有授权、ADB_VENDOR_KEYS、`adb-auth-env.cjs`、计划任务动作全部保持原样。Administrator SSH仅用于只读管理入口，不能启动另一个ADB。维护授权不包含身份切换。本轮没有执行驱动变更或生产连接。

## 官方依据与适用限制

微软建议驱动文件保留在Driver Store；不同版本co-installer若必须部署到外部路径，应使用不同文件名以避免在用文件冲突。本项目不直接修改已签名OEM包，先验证系统已有兼容ADB绑定。[避免设备安装重启](https://learn.microsoft.com/en-us/windows-hardware/drivers/install/avoiding-system-restarts-during-device-installations)

Windows提供WinUSB安装方式和不含co-installer的现代INF示例，但设备接口GUID仍决定应用能否发现设备；“WinUSB可装”不等于本机ADB必然兼容。[WinUSB安装文档](https://learn.microsoft.com/en-us/windows-hardware/drivers/usbcon/winusb-installation)

精确设备安装接口仍需检查返回值和重启需求，不以函数成功代替目标ADB与批外设备验收。[DiInstallDevice](https://learn.microsoft.com/en-us/windows/win32/api/newdev/nf-newdev-diinstalldevice)
