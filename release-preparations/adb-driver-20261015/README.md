# 162 ADB 驱动冲突：维护准备，未执行替换

2026-10-15，延续查名 rc.8 收尾和用户要求的 ADB 稳定性排查。当前不是已修复状态；云端三次失败隔离也尚未加载。证据见 [现场记录](../../docs/evidence/ADB_DRIVER_COLLISION_20261015.json)。

## 原因与边界

Windows 的 `oem38.inf`（hn_goadb）和 `oem44.inf`（vivo）都往 System32 复制同名、不同内容的 WinUSB/WDF co-installer DLL。SetupAPI 明确记录另一驱动包需要重新配置，随后查询移除其他在用设备，出现 `PNP_VetoOutstandingOpen`、Error482 和持续安装排队。130、162 的安装都参与了这条冲突链。该证据解释“安装器繁忙”，不证明最早 13:43 的 USB 物理消失以及所有掉线都由此造成。

162 已从 USB 不可见转为 USB 可见、ADB 接口停止；单端口 cycle 唯一一次尝试被 Windows 拒绝（433），前后116台、0新增掉线，不能把后续重新枚举归功于这个失败操作。未重启 Agent/ADB/Hub/Windows/媒体，未终止安装器。

## 已完成的准备

- 只读 `pnputil /enum-devices ... /drivers` 和原生 SetupAPI 均确认162兼容 `C:\Windows\INF\winusb.inf` 的 **ADB** 节，含既有 ADB 接口 GUID。不要误选只有通用 WinUSB 的节。
- `inspect_device.py` 仅构建/读取兼容驱动列表，不调用安装、重启、删除 API。3项本地选择保护测试通过；Windows原生只读预览通过。WinUSB.sys Authenticode为Valid/Microsoft Windows。未执行驱动替换，不能以预览代替真机验证。
- 两个OEM驱动包及162两种USB模式的设备注册表已导出到宿主机 `D:\PhoneCloud\agent\backups\adb-driver-162-20261015-prep1`，10文件hash见证据。原始注册表只保留宿主机，未入Git。此备份不授权全局导入注册表或删除驱动包。
- 云端rc.8已提交、构建和隔离验证，备份/回退见 [prep.8](../lookup-readiness-20261015-prep.8/README.md)。不能用查名不可用池代替Windows恢复隔离；rc.8不改变USB安装策略。

## 待批准的维护步骤

建议预留10分钟；实际恢复时间未验证。4路控屏为14:35快照，执行前重新确认任务和控屏，窗口不自动继承。

1. 新窗口须明确允许：暂停共享Agent、短暂重建ADB释放驱动占用，以及满足排空门禁后的云端业务重载。所有手机可能短暂离线、控屏中断。**不包含Windows/Hub/媒体重启、批量换驱动或删OEM包**。
2. 重新核对ACTIVE、Agent/ADB进程和3个Python overlay、D-075宿主机live、安装队列、162父子关系、当前USB模式及占用。暂停新任务，等待现有小红书/自动化结束；不强制清162原请求或未知执行锁。
3. 按既有服务启动/停止入口暂停Agent，释放共享ADB占用，观察Windows安装队列自然结束。不得直接杀全部DrvInst或进行全局PnP扫描。若队列未能在窗口内安全结束，恢复原运行服务并记录阻塞；要求Windows重启时停止并另行申请。
4. 仅对**当时存在、父设备精确匹配162序列号**的ADB接口，重新生成兼容列表、核对inbox INF hash；选择Microsoft的ADB节。使用设备管理器精确实例，或实现/审查后使用 `DiInstallDevice` 的单设备句柄和显式选中驱动，不用匹配硬件ID后更新全部设备的API。不可传NULL让系统再次选旧OEM高排名驱动，不卸载USB复合根节点。
5. 驱动安装应显式获取NeedReboot；不得自动重启。若不需要重启且设备状态正常，恢复原Agent/ADB并核对单实例，162 `get-state`、Poco探活和平台新鲜扫描；检查其他设备、控屏恢复及SetupAPI是否新增同名DLL覆盖。至少10分钟观察。只验证162当前模式；另一USB模式及其他手机仍属于待验证范围。
6. 162原请求已过执行期限，14:35通道unknown。连接恢复后先对账/按原取消与stop ACK完成释放；禁止延长期限、改成空姓名、强制删锁或换ID重放。原请求未安全结束时，不执行云端切换。
7. 只有池disabled、0查名通道、无执行中自动化、备份新鲜、D-075通过，才按prep.8加载云镜像e92e3a93。保留Windows3文件overlay，绑定新部署回执，再做有界灰度；任一门禁未满足则保留旧云镜像，不借窗口强行完成。

## 回退与停止条件

- 162驱动绑定失败/新错误/NeedReboot：保持该机不派单，记录状态，恢复原共享服务。需要回绑时仍只选该实例的旧OEM驱动，先核对备份和现场；回绑本身可能再次触发共享DLL冲突，不能无窗口自动执行。不要直接覆盖System32 DLL或整库注册表。
- 未相关设备新增掉线、共享进程异常、D-075变化、实际实例与162映射不符：停止扩大，保存证据；不重复驱动安装或端口cycle。
- 162单机成功也不意味着全机驱动冲突已根治。后续若其他OEM驱动继续交替覆盖，另做逐台迁移计划，先单机/两机验证，再明确授权扩大；不在本窗口偷偷批量修改。

微软依据：[共享驱动文件与重启影响](https://learn.microsoft.com/en-us/windows-hardware/drivers/install/avoiding-system-restarts-during-device-installations)、[WinUSB安装](https://learn.microsoft.com/en-us/windows-hardware/drivers/usbcon/winusb-installation)、[指定单设备安装API](https://learn.microsoft.com/en-us/windows/win32/api/newdev/nf-newdev-diinstalldevice)。
