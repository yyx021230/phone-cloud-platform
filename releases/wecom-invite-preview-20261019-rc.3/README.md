# 企微发送前预览 rc.3：67号真实脚本验收

起点 `cc142c6868786eceec172289e02a33524bf6031b`，独立分支 `codex/wecom-live-preview-20261019`，开始工作区干净。延续13.10和rc.2的六动作、号码三处核验、前台/真实租约及禁发边界。

67号（V2357A/Android14）使用之前尾号6041的授权号码，Windows Python3.9.13实际运行 `run_preview(PocoPreviewDriver(...))`：首页菜单→添加客户→手机号搜索→输入→网络查找→添加为联系人，六动作均由脚本执行，50.48秒返回 `ready_before_send/stopped_before_send`。最终画面仍显示“发送添加邀请”；没有点击发送、修改邀请文案或保存备注。人工仅在脚本开始前退出旧预览至首页，执行时没有人工补点。

真机暴露rc.2缺陷：空类型的原生Poco proxy迭代抛 `PocoNoSuchNodeException`，原合成列表不抛。补丁先用Poco支持的 `len(proxy)` 判断零匹配再遍历，不吞掉RPC/其他错误；新增两个回归。9项元素测试、35项原企微、20项原执行器（共64项）、六动作离线回放、diff检查通过。仅自审；首次诊断通道解析失败及空proxy失败均保留在验收JSON，不写成首轮全部通过。

测试宿主仅在隔离staging运行，复用67已有Poco服务和真实平台独占锁；回调实时核对session、设备/序列号、owner、有效期及active screen_control lock。浏览器仅观察，执行时不输入。所有手机命令经已存在的SYSTEM共享server smart socket，无adb客户端自动启动。没有安装APK、重建ADB、切身份/密钥、改共享Agent/媒体。Poco RPC设2秒，业务运行预算100秒，不使用默认安装/重启构造器。临时宿主实现与原截图留受限诊断备份，不提供通用线上执行入口。

结束核对：ADB PID8988与Agent PID14508仍为SYSTEM且未变；67目标Poco转发余0，结束本次组件及平台控制。未修改线上运行版本，未注册Agent/API，未推送/部署。其他设备/版本及无人值守接入仍未验；本候选仅验收67发送前路径。

实际结果、失败、宿主/源码hash见 `LIVE_VERIFICATION.json`，全部交付文件hash见 `MANIFEST.json`。回退只停止引用rc.3并恢复不可变rc.2；rc.2保留已知空proxy缺陷，不能把它作为已通过真机版本。无数据库回滚、共享服务或ADB重启步骤。
