# 2026-10-22 待兼容手机实时元素记录

## 范围与基线

用户明确要求直接读取待兼容手机页面元素。分支 `codex/lookup-page-compat-20261022`，调查起点 `755f993c2bf7fbb21c29c574100aa51adee810ec`，Git工作区开始干净。沿用7.15.38核实的生产deployed.1/95725513基线，本轮不发布。本地临时目录中的兼容草稿尚未形成可交付候选，不能当作线上修复。

共同流程2026-09-30，SHA256 `0a06c335eb36a017fc84bfdd4b067dedee27041e88ad746963f02f1f9a532e2b`。冻结实时控制、ADB/SYSTEM、媒体。仅检查162、112、156、181，未读取其他正在查询/控屏手机的页面。15:47云端这四台均recovery，另有138执行查询。

## 实际结果（北京时间15:47–15:54）

| 手机 | 实时元素读取 | 当前画面/系统核对 | 能确定与不能确定 |
|---|---|---|---|
| 162 | 成功，约609ms、74节点；系统锁屏、解锁提示 | 电源Asleep，窗口NotificationShade，后台支付宝搜索Activity | 当前锁屏；不能倒推最初失败一定由锁屏造成 |
| 181 | 成功，约328ms、143节点；搜索输入框、分类栏存在 | 同期截图有两张含掩码姓名的结果卡；窗口为支付宝搜索Activity | 结果区姓名/号码/按钮没有text或desc；不属于正常空姓名 |
| 156 | 已有RPC通道两次均约4秒ReadTimeout | ADB截图与窗口读取成功，支付宝搜索页可见两张结果卡，Awake | 元素读取异常；不能判成ADB离线，未取得当前树 |
| 112 | 首次TransportDisconnected，复核当前forward列表没有该机10081映射 | ADB截图与窗口读取成功，支付宝搜索页可见单张结果卡，Awake | 复核时现有元素通道不可用；未重建，不声称已读树或确定退出原因 |

181结果区域可见`cube_round_container`、`item_cube_template_content`，其子树终止于无text/desc的`android.view.View`。只读native hierarchy同时见`CKFalconView`、`CKContainerView`、`CKPView`。这是“现有元素接口未暴露结果文字”的直接证据，支持自绘结果区解释；不能保证所有支付宝版本都不可读取，也未验证其他无副作用接口是否能取得文字。

当前分类应分别面对设备锁屏、元素传输异常及结果文字不可访问；不能用同一个“页面待兼容”推导相同修复，也不能把读取失败写成无姓名。元素存在才可以修定位/关联；本轮没有新增OCR、没有承诺仅改选择器能读181。

## 安全与方法

先核对共享5037实际监听进程8988、路径`D:\PhoneCloud\tools\android-sdk\platform-tools\adb.exe`、所有者`NT AUTHORITY\SYSTEM`，随后只读既有forward列表、窗口、电源和截图。普通短暂ADB客户端进程不等同多个server；核验以5037监听者为准。服务不存在/身份不符时必须停读，不允许隐式新起server。

元素使用已有Poco HTTP/HRPC的`dumper.dumpHierarchy()`，单次HTTP限4秒；未实例化会安装/拉起instrumentation/建forward的Poco设备构造器。没有调用uiautomator dump争抢运行中的instrumentation，没有点击/唤醒/解锁/输入、重新提交号码或准备探测，没有停任务、清锁或发通知。没有修改生产文件/配置/数据、重启服务或改变ADB身份。只读失败不自动恢复。

原始页面、树、窗口信息可能含业务手机号/姓名，留在本机私有临时目录，不入Git、不写本文；以下仅留原文件SHA256供同机复核，文件非交付附件。

- `elements-162-private.json`：`b32b89c9b64109feb1c5dbcdb1529b80d28252a09e41d86ffe9edf8317219894`
- `elements-181-private.json`：`da23d162ef88c255f25fb3a65c8914e41592d779938911c00dfdc5eb95032624`
- `elements-156-private.json`：`e99a8b3223d7b65434f39750e3ca8f81158180c4a26572751f30f60b204e3557`
- `elements-112-private.json`：`c82f5f5bf45374c50eebd538c665c18267ef47a721111b0b477aae20bcd88af3`
- `elements-retry-private.jsonl`：`6861ae9d27d7f3083e924354be0be86328412f3b42d314f980a5e9ad2de3b182`
- `elements-state-private.jsonl`：`4a2b67c8a6dd218fc554d7393a4429aca82256119e6d147d6b2acf44ff10832d`
- `activity-181-private.txt`：`0434e68df7e08a203558d9abcdc75c8d16a56cc93e1e98951327ffea487b0a9d`

## 验证界限与接续

本轮完成只读取证、文档核对与差异检查；不运行全量业务回归，不宣称真机兼容已修复。新提的元素兼容草稿需要依据这些真实证据重新审视，尤其不能用合成含姓名节点的测试冒充181现场已可读。112/156通道生命周期及162等待期间锁屏仍待定位；恢复或上线另按既有授权边界。已提交文档不会移动旧版本标签，历史候选与根仓既有改动保留。
