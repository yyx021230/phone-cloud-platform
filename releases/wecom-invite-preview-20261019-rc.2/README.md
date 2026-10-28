# 企微发送前预览 rc.2：实机元素采样与首页入口兼容

分支 `codex/wecom-real-elements-20261019`，起点 `fa327dcda16623ea60f12ead368fd5ba220379fe`，开始工作区干净。继承rc.1的六动作白名单、目标号码核验、租约/前台/二次页面核验及不发送、不保存备注范围；不注册Agent或API、不改共享调度/ADB/媒体。

本轮通过用户新提供的Windows连接先核对5037：固定SDK路径、SYSTEM server；SYSTEM Node运行index及原preload，另一个Administrator Node是fleet.mjs，不作为第二Agent推断。没有复制或恢复密钥、启动/重建ADB或修改任务入口。平台确认67未占用后通过既有实时控制获得独占，所有导航/输入均用平台UI；仅67以现有server的smart socket进行有界UIAutomator XML采样，不执行adb客户端，不安装APK。XML只用于探索和脱敏离线回放，没有新增运行时XML降级。

实机发现：首页+为无text/contentDescription的 `android.widget.TextView`，资源标识 `com.tencent.wework:id/nt3`。rc.1的文字/图片按钮规则无法匹配，脱敏页面回放原样复现entry/ambiguous_or_missing_element。补丁保留旧文字规则，新增仅在消息/工作台/通讯录首页组合、同一已观察资源名、TextView、空文字/描述、右上几何、可见/启用且唯一时接受该菜单；Poco适配器以type+name选择，点击前重读整页与元素几何。没有新增坐标点击、任意资源名、发送或保存入口。

搜索框实测为EditText/lon/提示“手机号”。结果行画面省略，但XML包含完整号码，保留完整号码严格匹配。个人信息的完整号码与添加按钮、最终“发送添加邀请”按钮也已采集。原始XML含客户与消息信息，仅留受限私有诊断目录；仓内夹具只保留业务标签/必要属性，号码替换为虚构夹具，禁止向企业微信提交夹具号码。XML resource-id映射为候选Poco name尚无live Poco证据，不能声称真实Poco已通过。

手动重新查询原文档授权号码1次，资料完整号码核对后点击“添加为联系人”，最后仍停在发送邀请之前。逐键输入曾产生号码变形，回读发现后未搜索错误值，清空后改用平台粘贴，核对正确才进行唯一一次搜索；没有为此修改冻结控制链路。未保存备注/修改邀请文案/发送邀请，最后结束控制。新主机已能接管设备的当前事实不等于本线程完成迁机验收。

验证：7项新增、35项原企微、20项原执行器回归通过；脱敏XML页面六动作回放到ready_before_send；同一CLI放在Windows临时目录离线运行通过并自动清理，未连接手机。AST、JSON与diff检查通过，自审。Windows离线回放不是真机脚本执行，平台租约接入、live Poco属性/selector/RPC、其他机型仍未验。

本地命令：

```sh
python3 -B windows-agent/scripts/test_wecom_real_elements.py
python3 -B windows-agent/scripts/test_wecom_invite_preview.py
python3 -B windows-agent/scripts/automation_runners_test.py
python3 -B windows-agent/scripts/wecom_invite_preview.py --simulate releases/wecom-invite-preview-20261019-rc.2/redacted-real-flow.json
```

仅修改独立企微脚本与测试/文档/夹具，线上运行文件不变，无推送或发布。回退停止引用rc.2、使用不可变rc.1；不回滚生产数据库、不重启Agent/ADB。后续仍须复用真实设备锁取得live Poco证据后再验收脚本，不能用固定true模拟租约或绕过控屏互斥。
